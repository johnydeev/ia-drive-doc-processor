import type { AssignmentResult, ProcessDriveFileInput, ProcessingContext } from "@/jobs/processPendingDocuments.job";
import type { ProcessJobSummary } from "@/types/process.types";
import type { ExtractedDocumentData } from "@/types/extractedDocument.types";
import type { AiUsageMetrics } from "@/types/aiUsage.types";
import type { InvoiceRepository } from "@/repositories/invoice.repository";
import type { identifyLSPProvider } from "@/lib/extraction";
import { pipelineLog } from "@/lib/logger";
import { AiRequestCounter } from "@/lib/aiRequestCounter";

/** Tipo del registro devuelto por la verificación de duplicado por hash. */
type DuplicateByHash = Awaited<ReturnType<InvoiceRepository["findDuplicateByHash"]>>;
/** Tipo del resultado del router LSP (incluye GENERIC_LSP y null). */
type LspProviderResult = ReturnType<typeof identifyLSPProvider>;

/**
 * Pipe & Filter del procesamiento de boletas (refactor H2).
 *
 * El `PipelineContext` es un estado mutable que fluye por una lista ordenada de
 * `PipelineStep`. El `runner` itera los pasos; el primero que devuelve `halt`
 * corta la cadena. Cada paso hace sus side-effects (mover archivo, sumar al
 * `summary`, escribir en `m`) y devuelve `continue` o `halt`.
 *
 * El manejo de errores (RateLimitError / error genérico) y la emisión de la
 * línea `[metrics]` viven en el `runner` (ver runner.ts), no en los pasos.
 */

/** Resultado de un paso: continuar la cadena o cortarla con un `result`/`reason`. */
export type StepResult =
  | { kind: "continue" }
  | { kind: "halt"; result: string; reason: string | null };

/** Un paso del pipeline: opera sobre el contexto mutable y decide si seguir. */
export type PipelineStep = (ctx: PipelineContext) => Promise<StepResult>;

/**
 * Helper de logging + timing por paso. Si se pasa `metricKey`, acumula el
 * elapsed en `m.ms[metricKey]` (acumula porque la IA puede reintentar con varios
 * proveedores).
 */
export type RunStep = <T>(label: string, fn: () => Promise<T>, metricKey?: string) => Promise<T>;

/** Acumulador de métricas para la línea `[metrics]` (una por boleta, ver §3 spec). */
export interface PipelineMetrics {
  ms: Record<string, number>;
  textSource: string | null;
  textChars: number | null;
  emitterBlock: boolean | null;
  lsp: string | null;
  ai: Record<string, unknown> | null;
  match: { consortium: string | null; provider: string | null };
  result: string;
  reason: string | null;
  extracted: Record<string, unknown> | null;
  canonical: Record<string, unknown> | null;
  reasonText: string | null;
}

/**
 * Estado que fluye por la cadena. Agrupa la entrada (`file`, `deps`, `summary`),
 * los helpers (`runStep`) y el estado acumulado (`m`, timing). Los pasos van
 * poblando los campos a medida que la cadena avanza.
 */
export interface PipelineContext {
  /** Archivo de Drive en procesamiento. */
  file: ProcessDriveFileInput;
  /** Dependencias inyectadas (config, servicios, repos, cadena IA, seams). */
  deps: ProcessingContext;
  /** Acumulador del lote (se muta: processed/unassigned/failed/...). */
  summary: ProcessJobSummary;
  /** Métricas de la boleta; el runner emite `[metrics]` con esto en su `finally`. */
  m: PipelineMetrics;
  /** Logging + timing por paso. */
  runStep: RunStep;
  /** Marca de inicio (para `m.ms.total`). */
  startedAt: number;

  // ── Estado acumulado que fluye entre pasos (lo van poblando a medida que avanzan) ──
  /**
   * Requests HTTP a la IA de ESTA boleta, abiertas por `provider:model`. Lo
   * incrementan los extractores, no el pipeline: el barrido de modelos de Gemini
   * son varias requests dentro de un solo intento de la cadena.
   */
  /**
   * Boletas a escribir por este archivo.
   *
   * Vacío = una sola, la de `extracted`: el caso de todos los documentos. Con
   * contenido = **fan-out**, una Liquidación de Sueldos Digital produce una boleta por
   * empleado, todas con el mismo archivo de Drive detrás (spec 2026-09-01).
   */
  invoices: Array<{
    extraction: ExtractedDocumentData;
    providerId: string;
    documentHash: string;
  }>;
  aiRequests: AiRequestCounter;
  /** `true` si se gastó Gemini Vision (imagen, PDF escaneado o membrete). */
  usedVision: boolean;
  /** Binario del PDF/imagen descargado de Drive. */
  buffer: Buffer | null;
  /** URL pública del archivo en Drive. */
  sourceFileUrl: string;
  /** Carpeta origen para los movimientos finales (Procesando o Pendientes). */
  finalSourceFolderId: string | undefined;
  /** SHA256 del binario (dedup por hash + naming en Rendiciones). */
  fileHash: string;
  /** Invoice previa con el mismo hash (si existe). */
  existingByHash: DuplicateByHash | null;
  /** La boleta es un duplicado (por hash o por clave de negocio). */
  isDuplicate: boolean;
  /** El archivo es una imagen (JPG/PNG) → extracción Vision. */
  isImage: boolean;
  /**
   * PNG de la página 1 cuando el PDF es un ESCANEO (páginas imagen, sin capa de
   * texto). Lo rinde el OCR; si está, `aiExtractStep` extrae por Vision en vez de
   * mandar el texto pobre del OCR a la cadena. `null` = PDF con texto propio, o el
   * OCR no pudo renderizar.
   */
  scannedPdfPng: Buffer | null;
  /**
   * La extracción salió de Vision sobre la imagen del documento. El texto del OCR
   * NO es testigo válido de lo que leyó Vision: `cuitSanitizeStep` no descarta sus
   * CUITs por "no aparecen en el texto".
   */
  visionResolved: boolean;
  /** Datos extraídos (IA / cache / OCR_ONLY), luego canonizados. */
  extracted: ExtractedDocumentData | null;
  /** Empresa de servicios detectada por el router (o null si no es LSP). */
  lspProvider: LspProviderResult;
  /** Texto del documento (para verificación CUIT-en-texto); vacío en imágenes. */
  docText: string;
  /** Métricas de tokens de la extracción IA. */
  fileAiUsage: AiUsageMetrics | null;
  /** La extracción se reusó de una invoice previa (mismo hash). */
  extractionWasCached: boolean;
  /** Clave de negocio para deduplicación (o null). */
  duplicateKey: string | null;
  /** Resultado del matching consorcio/proveedor/período. */
  assignment: AssignmentResult | null;
}

/** Métricas en su estado inicial (resultado por defecto: failed/error hasta que un paso lo cambie). */
export function createInitialMetrics(): PipelineMetrics {
  return {
    ms: {}, textSource: null, textChars: null, emitterBlock: null, lsp: null,
    ai: null, match: { consortium: null, provider: null }, result: "failed",
    reason: "error", extracted: null, canonical: null, reasonText: null,
  };
}

/**
 * Arma un `PipelineContext` listo para el runner. `runStep` cierra sobre `m` y
 * `cid` (idéntico al helper local que vivía en `processDriveFile`).
 */
export function createPipelineContext(
  file: ProcessDriveFileInput,
  deps: ProcessingContext,
  summary: ProcessJobSummary
): PipelineContext {
  const m = createInitialMetrics();
  const cid = deps.resolvedConfig.clientId;

  const runStep = async <T>(label: string, fn: () => Promise<T>, metricKey?: string): Promise<T> => {
    pipelineLog.stepStart(cid, label);
    const t0 = Date.now();
    try {
      return await fn();
    } catch (error) {
      throw new Error(`${label} failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      if (metricKey) m.ms[metricKey] = (m.ms[metricKey] ?? 0) + (Date.now() - t0);
    }
  };

  return {
    file, deps, summary, m, runStep, startedAt: Date.now(),
    invoices: [],
    aiRequests: new AiRequestCounter(),
    usedVision: false,
    buffer: null,
    sourceFileUrl: "",
    finalSourceFolderId: undefined,
    fileHash: "",
    existingByHash: null,
    isDuplicate: false,
    isImage: false,
    scannedPdfPng: null,
    visionResolved: false,
    extracted: null,
    lspProvider: null,
    docText: "",
    fileAiUsage: null,
    extractionWasCached: false,
    duplicateKey: null,
    assignment: null,
  };
}
