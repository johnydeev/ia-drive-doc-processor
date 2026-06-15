# Triage de documentos (boleta vs no-boleta) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar una capa de triage al pipeline que clasifique cada documento como boleta o no-boleta (binario), derivando los no-boleta a Revisión con prefijo `[NO BOLETA]` — sin gastar tokens de IA cuando es evidente — con sesgo conservador (ante la duda, es boleta).

**Architecture:** Híbrido en dos capas sobre el pipeline Pipe & Filter del refactor H2. Capa 1: heurística pura (`classifyDocumentType`) sobre el texto del PDF, en un gate **antes** de la IA (ahorra tokens). Capa 2: campo `isBoleta` que devuelve la IA, en un gate **después** de extraer. `extractStep` se separa en `textExtractStep` (sin tokens) + `aiExtractStep` (IA) para poder insertar el gate de heurística en el medio.

**Tech Stack:** TypeScript, Vitest 4 (`npm test` / `npx vitest run`), Prisma (sin migración aquí), el pipeline en `src/jobs/processPendingDocuments.job.ts` + `src/jobs/pipeline/`.

---

## File Structure

- **Crear** `src/lib/documentClassifier.ts` — función pura `classifyDocumentType(text)`. Una sola responsabilidad: decidir boleta/no-boleta por heurística.
- **Crear** `src/lib/documentClassifier.test.ts` — tests unitarios del clasificador.
- **Modificar** `src/lib/documentValidation.ts` — agregar helper `markNotBoleta(fileName)` (espejo de `appendNoAmountTag`).
- **Modificar** `src/lib/documentValidation.test.ts` — si no existe, crearlo con el test de `markNotBoleta`. *(No existe hoy → crear.)*
- **Modificar** `src/types/process.types.ts` — agregar `notBoleta?: number` a `ProcessJobSummary`.
- **Modificar** `src/types/extractedDocument.types.ts` — agregar `isBoleta?: boolean` (capa 2).
- **Modificar** `src/lib/logger.ts` — `pipelineLog.batchSummary` muestra `notBoleta`.
- **Modificar** `src/lib/extraction.ts` — `buildInvoicePrompt` instruye el campo `isBoleta` (capa 2).
- **Modificar** `src/jobs/processPendingDocuments.job.ts` — split `extractStep` → `textExtractStep` + `aiExtractStep`; nuevos `documentTriageGate`, `isBoletaGate`, helper `divertNotBoleta`; actualizar la lista de pasos del runner.
- **Modificar** `src/jobs/processPendingDocuments.job.test.ts` — 2 tests de caracterización nuevos (not_boleta heurística / IA).

Sin migración de DB. Sin carpetas de Drive nuevas (los no-boleta van a `driveFailedFolderId` = Revisión).

---

## FASE 1 — Capa 1 (heurística): el grueso del ahorro de tokens

### Task 1: Clasificador heurístico puro

**Files:**
- Create: `src/lib/documentClassifier.ts`
- Test: `src/lib/documentClassifier.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// src/lib/documentClassifier.test.ts
import { describe, it, expect } from "vitest";
import { classifyDocumentType } from "@/lib/documentClassifier";

describe("classifyDocumentType", () => {
  it("boleta común (monto + CUIT + FACTURA) → boleta", () => {
    expect(
      classifyDocumentType("FACTURA B N° 0001 CUIT 30-12345678-9 TOTAL A PAGAR $ 12.500,00")
    ).toBe("boleta");
  });

  it("liquidación de servicio público → boleta", () => {
    expect(
      classifyDocumentType("EDESUR S.A. LIQUIDACION DE SERVICIOS PUBLICOS TOTAL $ 8.000 VENCIMIENTO 10/05")
    ).toBe("boleta");
  });

  it("certificado de fumigación SIN monto → not_boleta", () => {
    expect(
      classifyDocumentType("CERTIFICADO DE FUMIGACION Y CONTROL DE PLAGAS - Edificio Thames 647")
    ).toBe("not_boleta");
  });

  it("oblea de rúbrica de libros → not_boleta", () => {
    expect(
      classifyDocumentType("OBLEA DE RUBRICA DE LIBROS - DISPOSICION N 123 - Inspeccion General de Justicia")
    ).toBe("not_boleta");
  });

  it("plano de edificio → not_boleta", () => {
    expect(
      classifyDocumentType("PLANO DE OBRA - PLANTA BAJA - ESCALA 1:100 - Municipalidad")
    ).toBe("not_boleta");
  });

  it("factura de la empresa de fumigación CON monto → boleta (la señal de boleta gana)", () => {
    expect(
      classifyDocumentType("FACTURA C N° 0005 SERVICIO DE FUMIGACION CUIT 20-11111111-2 TOTAL A PAGAR $ 30.000")
    ).toBe("boleta");
  });

  it("texto vacío → boleta (sesgo conservador, no corta)", () => {
    expect(classifyDocumentType("")).toBe("boleta");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/lib/documentClassifier.test.ts`
Expected: FAIL — "Failed to resolve import @/lib/documentClassifier" / `classifyDocumentType is not a function`.

- [ ] **Step 3: Implementar el clasificador**

```ts
// src/lib/documentClassifier.ts
import { extractCuitsFromText } from "@/lib/cuit";

/**
 * Clasificación binaria de un documento por heurística (capa 1 del triage).
 * Función pura, testeable. NO usa IA. Sesgo conservador: solo devuelve
 * "not_boleta" cuando hay una señal negativa fuerte Y ninguna señal de boleta;
 * ante la duda devuelve "boleta" (= seguir el flujo normal de extracción).
 */
export type DocumentClass = "not_boleta" | "boleta";

/** Señales negativas fuertes: tipos de documento que NO son boletas/gastos. */
const NOT_BOLETA_MARKERS = [
  "OBLEA",
  "RUBRICA",
  "RÚBRICA",
  "CERTIFICADO DE DESINFECCION",
  "CERTIFICADO DE DESINSECTACION",
  "CERTIFICADO DE DESRATIZACION",
  "CERTIFICADO DE FUMIGACION",
  "CONTROL DE PLAGAS",
  "PLANO",
  "DISPOSICION",
  "DISPOSICIÓN",
  "HABILITACION",
  "HABILITACIÓN",
  "INFORME TECNICO",
  "INFORME TÉCNICO",
  "ACTA",
];

/** Señales de boleta: si alguna aparece, el documento se trata como boleta. */
const BOLETA_MARKERS = [
  "$",
  "TOTAL A PAGAR",
  "IMPORTE",
  "VENCIMIENTO",
  "FACTURA",
  "RECIBO",
  "COMPROBANTE",
  "CAE",
];

export function classifyDocumentType(text: string): DocumentClass {
  const upper = text.slice(0, 4000).toUpperCase();

  const hasNegative = NOT_BOLETA_MARKERS.some((marker) => upper.includes(marker));
  if (!hasNegative) return "boleta";

  const hasBoletaSignal =
    BOLETA_MARKERS.some((marker) => upper.includes(marker)) ||
    extractCuitsFromText(text).length > 0;

  return hasBoletaSignal ? "boleta" : "not_boleta";
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/lib/documentClassifier.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/documentClassifier.ts src/lib/documentClassifier.test.ts
git commit -m "feat: clasificador heuristico de documentos (boleta vs no-boleta)"
```

---

### Task 2: Helper `markNotBoleta`

**Files:**
- Modify: `src/lib/documentValidation.ts`
- Test: `src/lib/documentValidation.test.ts` (crear)

- [ ] **Step 1: Escribir el test que falla**

```ts
// src/lib/documentValidation.test.ts
import { describe, it, expect } from "vitest";
import { markNotBoleta, appendNoAmountTag, isMissingAmount } from "@/lib/documentValidation";

describe("markNotBoleta", () => {
  it("antepone el prefijo [NO BOLETA] al nombre", () => {
    expect(markNotBoleta("boleta.pdf")).toBe("[NO BOLETA] boleta.pdf");
  });
});

// Tests de regresión mínimos de los helpers existentes (no cambian).
describe("documentValidation existente", () => {
  it("isMissingAmount: null es sin monto; 0 es válido", () => {
    expect(isMissingAmount(null)).toBe(true);
    expect(isMissingAmount(0)).toBe(false);
  });
  it("appendNoAmountTag agrega ' - SIN MONTO' antes de la extensión", () => {
    expect(appendNoAmountTag("x.pdf")).toBe("x - SIN MONTO.pdf");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/lib/documentValidation.test.ts`
Expected: FAIL — `markNotBoleta is not a function`.

- [ ] **Step 3: Agregar el helper**

En `src/lib/documentValidation.ts`, después de `appendNoAmountTag`, agregar:

```ts
/** Antepone el prefijo "[NO BOLETA] " al nombre del archivo (triage de no-boletas). */
export function markNotBoleta(fileName: string): string {
  return `[NO BOLETA] ${fileName}`;
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/lib/documentValidation.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/documentValidation.ts src/lib/documentValidation.test.ts
git commit -m "feat: helper markNotBoleta para el triage de documentos"
```

---

### Task 3: Contador `summary.notBoleta` + log de resumen

**Files:**
- Modify: `src/types/process.types.ts`
- Modify: `src/lib/logger.ts:370` (método `batchSummary`)

- [ ] **Step 1: Agregar el campo al tipo**

En `src/types/process.types.ts`, dentro de `interface ProcessJobSummary`, después de `rateLimited?: number;` (y su bloque de comentario), agregar:

```ts
  /** Documentos clasificados como no-boleta (triage) y derivados a Revisión. */
  notBoleta?: number;
```

- [ ] **Step 2: Mostrarlo en el resumen del lote**

En `src/lib/logger.ts`, en `pipelineLog.batchSummary`, cambiar la firma y agregar una línea. Reemplazar:

```ts
  batchSummary(clientId: string, summary: { totalFound: number; processed: number; unassigned: number; failed: number; duplicatesDetected: number }) {
    miniDivider("job");
    log("info", "job", `📊 RESUMEN DEL LOTE:`, shortId(clientId));
    log("info", "job", `  Encontrados:  ${summary.totalFound}`, shortId(clientId));
    log("info", "job", `  Procesados:   ${summary.processed}`, shortId(clientId));
    log("info", "job", `  Sin asignar:  ${summary.unassigned}`, shortId(clientId));
    log("info", "job", `  Duplicados:   ${summary.duplicatesDetected}`, shortId(clientId));
    log("info", "job", `  Fallidos:     ${summary.failed}`, shortId(clientId));
    miniDivider("job");
  },
```

por:

```ts
  batchSummary(clientId: string, summary: { totalFound: number; processed: number; unassigned: number; failed: number; duplicatesDetected: number; notBoleta?: number }) {
    miniDivider("job");
    log("info", "job", `📊 RESUMEN DEL LOTE:`, shortId(clientId));
    log("info", "job", `  Encontrados:  ${summary.totalFound}`, shortId(clientId));
    log("info", "job", `  Procesados:   ${summary.processed}`, shortId(clientId));
    log("info", "job", `  Sin asignar:  ${summary.unassigned}`, shortId(clientId));
    log("info", "job", `  No boleta:    ${summary.notBoleta ?? 0}`, shortId(clientId));
    log("info", "job", `  Duplicados:   ${summary.duplicatesDetected}`, shortId(clientId));
    log("info", "job", `  Fallidos:     ${summary.failed}`, shortId(clientId));
    miniDivider("job");
  },
```

- [ ] **Step 3: Pasar `notBoleta` en el caller**

En `src/jobs/processPendingDocuments.job.ts`, en `processPendingDocumentsJob`, la llamada a `pipelineLog.batchSummary(...)` arma un objeto con `totalFound/processed/unassigned/failed/duplicatesDetected`. Agregar `notBoleta: summary.notBoleta` a ese objeto:

```ts
  pipelineLog.batchSummary(resolvedConfig.clientId, {
    totalFound: summary.totalFound,
    processed: summary.processed,
    unassigned: summary.unassigned,
    failed: summary.failed,
    duplicatesDetected: summary.duplicatesDetected,
    notBoleta: summary.notBoleta,
  });
```

- [ ] **Step 4: Verificar typecheck + suite**

Run: `npm run typecheck`
Expected: sin errores.
Run: `npx vitest run`
Expected: PASS (todos los tests existentes siguen verdes).

- [ ] **Step 5: Commit**

```bash
git add src/types/process.types.ts src/lib/logger.ts src/jobs/processPendingDocuments.job.ts
git commit -m "feat: contador summary.notBoleta + linea en el resumen del lote"
```

---

### Task 4: Split `extractStep` → `textExtractStep` + `aiExtractStep` (refactor sin cambio de comportamiento)

> Este task NO agrega comportamiento. La red de seguridad son los 8 tests de caracterización existentes: deben seguir verdes. Se separa la extracción de texto (sin tokens) de la llamada IA, para poder insertar el gate de heurística entre ambas en el Task 5.

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.ts` (reemplazar la función `extractStep` por dos funciones; actualizar la lista de pasos)

- [ ] **Step 1: Reemplazar `extractStep` por `textExtractStep` + `aiExtractStep`**

Borrar la función `extractStep` completa y poner en su lugar estas dos funciones:

```ts
/** 3a. Extracción de TEXTO (pdf-parse + detección LSP). Sin tokens de IA. */
async function textExtractStep(ctx: PipelineContext): Promise<StepResult> {
  const { file } = ctx;
  const { resolvedConfig, pdfExtractor } = ctx.deps;
  const m = ctx.m;
  const runStep = ctx.runStep;
  const cid = resolvedConfig.clientId;
  const buffer = ctx.buffer!;

  // Detectar si el archivo es una imagen (JPG/PNG)
  const isImage = (
    file.mimeType?.startsWith("image/") ||
    /\.(jpg|jpeg|png)$/i.test(file.name)
  );
  ctx.isImage = isImage;

  if (isImage) {
    // Las imágenes no tienen texto extraíble → la extracción es vía Vision (aiExtractStep).
    pipelineLog.stepStart(cid, `→ Archivo de imagen detectado (${file.mimeType ?? file.name}) — usando Gemini Vision`);
    m.textSource = "image";
    m.textChars = 0;
    m.emitterBlock = false;
    ctx.docText = "";
    ctx.lspProvider = null;
    return { kind: "continue" };
  }

  if (ctx.existingByHash?.extraction) {
    // Duplicado por hash con extracción previa: solo extraemos texto (para refine + detección).
    const text = await runStep("Extracción de texto (PDF)", () => pdfExtractor.extractTextFromPdf(buffer), "text");
    m.textSource = pdfExtractor.getLastTextSource();
    m.textChars = text.length;
    m.emitterBlock = pdfExtractor.getLastHasEmitterBlock();
    m.ms.ocr = pdfExtractor.getLastOcrMs();
    ctx.docText = text;
    ctx.lspProvider = identifyLSPProvider(text);
    return { kind: "continue" };
  }

  // Flujo normal: texto completo para detección.
  const fullText = await runStep("Extracción de texto (PDF)", () => pdfExtractor.extractTextFromPdf(buffer), "text");
  m.textSource = pdfExtractor.getLastTextSource();
  m.textChars = fullText.length;
  m.emitterBlock = pdfExtractor.getLastHasEmitterBlock();
  m.ms.ocr = pdfExtractor.getLastOcrMs();

  const lspProvider = identifyLSPProvider(fullText);
  if (lspProvider) {
    pipelineLog.lspDetected(cid, lspProvider);
  }

  // Para LSP, re-extraer limitando a página 1 para reducir ruido.
  const text = lspProvider
    ? await runStep("Re-extracción página 1 (LSP)", () => pdfExtractor.extractTextFromPdf(buffer, 1), "textPage1")
    : fullText;
  ctx.docText = text;
  ctx.lspProvider = lspProvider;

  if (resolvedConfig.debugMode) {
    pipelineLog.stepStart(cid, `[DEBUG-OCR] texto (${text.length} chars, sanitizado):\n${safeDebugLog(text)}`);
  }
  return { kind: "continue" };
}

/** 3b. Extracción de DATOS por IA (Vision / cacheado / cadena IA sobre el texto). */
async function aiExtractStep(ctx: PipelineContext): Promise<StepResult> {
  const { file, summary } = ctx;
  const { resolvedConfig, geminiModule, aiChain, geminiApiKey, geminiModel } = ctx.deps;
  const m = ctx.m;
  const runStep = ctx.runStep;
  const cid = resolvedConfig.clientId;
  const buffer = ctx.buffer!;
  const existingByHash = ctx.existingByHash;
  const docText = ctx.docText;
  const lspProvider = ctx.lspProvider;

  let extracted: ExtractedDocumentData | null = null;
  let fileAiUsage: import("@/types/aiUsage.types").AiUsageMetrics | null = null;
  let extractionWasCached = false;

  if (ctx.isImage) {
    // ── Flujo imagen: extracción directa con Gemini Vision ──
    if (existingByHash?.extraction) {
      const { sourceFileUrl: _url, isDuplicate: _dup, ...storedFields } =
        existingByHash.extraction as ExtractedDocumentData;
      extracted = { ...storedFields };
      extractionWasCached = true;
    } else if (geminiModule && geminiApiKey) {
      const imageMimeType: "image/jpeg" | "image/png" =
        file.mimeType?.includes("png") ? "image/png" : "image/jpeg";
      try {
        const extractor = new geminiModule.GeminiExtractorService({ apiKey: geminiApiKey, model: geminiModel });
        extracted = await runStep(
          "Extracción IA (Gemini Vision)",
          () => extractor.extractStructuredDataFromImage(buffer, imageMimeType),
          "ai"
        );
        fileAiUsage = extractor.getLastUsage?.() ?? null;
        accumulateTokenUsage(summary.tokenUsage, fileAiUsage);
        pipelineLog.aiExtraction(cid, "gemini", true);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Gemini Vision error";
        pipelineLog.aiExtraction(cid, "gemini", false, msg);
        if (isRateLimitError(error)) {
          throw new RateLimitError("IA Vision sin cuota (429)");
        }
        extracted = buildOcrOnlyPayload();
      }
    } else {
      pipelineLog.stepStart(cid, "⚠️ Imagen sin Gemini configurado — no se puede procesar");
      extracted = buildOcrOnlyPayload();
    }

    if (resolvedConfig.debugMode && extracted) {
      pipelineLog.stepStart(cid, `[DEBUG-AI] respuesta raw (sanitizada): ${safeDebugLog(JSON.stringify(extracted))}`);
    }
  } else if (existingByHash?.extraction) {
    // ── Flujo PDF: duplicado por hash con extracción previa ──
    const { sourceFileUrl: _url, isDuplicate: _dup, ...storedFields } =
      existingByHash.extraction as ExtractedDocumentData;
    extracted = { ...storedFields };
    extractionWasCached = true;
    extracted = refineExtractionWithRawText(extracted, docText);
  } else {
    // ── Flujo PDF: extracción normal vía cadena IA sobre el texto ya extraído ──
    let aiFailures = 0;
    let aiRateLimited = 0;
    const aiResult = await runStep(
      "Extracción IA",
      () =>
        aiChain.run(docText, (provider, ok, errorMsg, rateLimited) => {
          pipelineLog.aiExtraction(cid, provider, ok, errorMsg);
          if (!ok) {
            aiFailures += 1;
            if (rateLimited) aiRateLimited += 1;
          }
        }),
      "ai"
    );

    if (aiResult) {
      extracted = aiResult.data;
      fileAiUsage = aiResult.usage;
      accumulateTokenUsage(summary.tokenUsage, fileAiUsage);
    } else if (aiFailures > 0 && aiRateLimited === aiFailures) {
      throw new RateLimitError(`IA sin cuota — ${aiFailures} proveedor(es) en 429`);
    } else {
      pipelineLog.aiOcrFallback(cid);
      extracted = buildOcrOnlyPayload();
    }

    if (resolvedConfig.debugMode && extracted) {
      pipelineLog.stepStart(cid, `[DEBUG-AI] respuesta raw (sanitizada): ${safeDebugLog(JSON.stringify(extracted))}`);
    }
  }

  if (extracted === null) throw new Error("extraction produced no result unexpectedly");

  pipelineLog.extractionResult(cid, {
    consortium: extracted.consortium,
    provider: extracted.provider,
    providerTaxId: extracted.providerTaxId,
    amount: extracted.amount,
    dueDate: extracted.dueDate,
    allTaxIds: extracted.allTaxIds,
  });

  m.lsp = lspProvider ?? null;
  m.ai = fileAiUsage
    ? {
        provider: fileAiUsage.provider ?? null,
        model: fileAiUsage.model ?? null,
        ok: true,
        in: fileAiUsage.inputTokens ?? null,
        out: fileAiUsage.outputTokens ?? null,
        total: fileAiUsage.totalTokens ?? null,
      }
    : { provider: extractionWasCached ? "cached" : "ocr_only", model: null, ok: false, in: null, out: null, total: null };
  m.extracted = {
    consortium: extracted.consortium,
    provider: extracted.provider,
    taxId: extracted.providerTaxId,
    boleta: extracted.boletaNumber,
    due: extracted.dueDate,
    amount: extracted.amount,
    clientNumber: extracted.clientNumber,
  };

  ctx.extracted = extracted;
  ctx.fileAiUsage = fileAiUsage;
  ctx.extractionWasCached = extractionWasCached;
  return { kind: "continue" };
}
```

- [ ] **Step 2: Actualizar la lista de pasos del runner**

En `processDriveFile`, en el array que se pasa a `runPipeline`, reemplazar la línea `extractStep,` por:

```ts
      textExtractStep,
      aiExtractStep,
```

(En este task todavía NO se agregan los gates; van en Task 5.)

- [ ] **Step 3: Verificar que la suite sigue verde (red de seguridad)**

Run: `npm run typecheck`
Expected: sin errores.
Run: `npx vitest run`
Expected: PASS — los 8 tests de caracterización + todos los demás siguen verdes (el split preserva el comportamiento).

- [ ] **Step 4: Commit**

```bash
git add src/jobs/processPendingDocuments.job.ts
git commit -m "refactor: separar extractStep en textExtractStep + aiExtractStep"
```

---

### Task 5: `documentTriageGate` (capa 1) + destino `[NO BOLETA]`

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.ts` (import del clasificador y `markNotBoleta`; helper `divertNotBoleta`; nuevo `documentTriageGate`; lista de pasos)
- Test: `src/jobs/processPendingDocuments.job.test.ts`

- [ ] **Step 1: Escribir el test de caracterización que falla**

En `src/jobs/processPendingDocuments.job.test.ts`, dentro del `describe(...)`, agregar:

```ts
  it("not_boleta (heurística): no llama a la IA, renombra [NO BOLETA] y va a Revisión", async () => {
    const ctx = makeContext();
    // Texto que la heurística clasifica como no-boleta (certificado sin monto).
    ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(
      "CERTIFICADO DE FUMIGACION Y CONTROL DE PLAGAS - Edificio Thames 647"
    );
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.aiChain.run).not.toHaveBeenCalled();
    expect(ctx.driveService.renameFile.mock.calls[0][1]).toMatch(/\[NO BOLETA\]/);
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "failed");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.notBoleta).toBe(1);
    expect(metricsCore().result).toBe("not_boleta");
  });
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts -t "not_boleta (heurística)"`
Expected: FAIL — la IA SÍ se llama y no hay renombrado `[NO BOLETA]` (el gate todavía no existe).

- [ ] **Step 3: Agregar import, helper y gate**

En `src/jobs/processPendingDocuments.job.ts`:

(a) Agregar a los imports (junto a los de `@/lib/...`):

```ts
import { classifyDocumentType } from "@/lib/documentClassifier";
```

(b) En la línea del import de `documentValidation`, sumar `markNotBoleta`:

```ts
import { isMissingAmount, cuitAppearsInText, appendNoAmountTag, markNotBoleta } from "@/lib/documentValidation";
```

(c) Antes de `textExtractStep`, agregar el helper compartido + el gate:

```ts
/** Deriva un documento no-boleta a Revisión con prefijo [NO BOLETA] (sin Sheets/DB). */
async function divertNotBoleta(ctx: PipelineContext, layer: "heuristic" | "ai"): Promise<StepResult> {
  const { file } = ctx;
  const { resolvedConfig, driveService } = ctx.deps;
  const m = ctx.m;
  const cid = resolvedConfig.clientId;
  const finalSourceFolderId = ctx.finalSourceFolderId;

  m.result = "not_boleta";
  m.reason = layer;
  pipelineLog.stepStart(cid, `🚫 No es boleta (${layer}) → Revisión [NO BOLETA]: "${file.name}"`);
  if (resolvedConfig.driveFailedFolderId && finalSourceFolderId) {
    await ctx.runStep("Renombrar [NO BOLETA]", () => driveService.renameFile(file.id, markNotBoleta(file.name)), "move");
    await ctx.runStep(
      "Mover a Revisión (no boleta)",
      () => driveService.moveFileToFolder(file.id, finalSourceFolderId, resolvedConfig.driveFailedFolderId!),
      "move"
    );
    pipelineLog.movedToFailed(cid, file.id);
  }
  ctx.summary.notBoleta = (ctx.summary.notBoleta ?? 0) + 1;
  pipelineLog.fileCompleted(cid, file.name, { processed: 0, unassigned: 0, duplicate: false }, "NO BOLETA → Revisión");
  return { kind: "halt", result: m.result, reason: m.reason };
}

/** 3.5 (capa 1) Triage por heurística sobre el texto, ANTES de la IA. */
async function documentTriageGate(ctx: PipelineContext): Promise<StepResult> {
  // Sin texto (imágenes) la heurística no aplica → decide la capa 2 (isBoletaGate).
  if (!ctx.docText) return { kind: "continue" };
  if (classifyDocumentType(ctx.docText) === "not_boleta") {
    return divertNotBoleta(ctx, "heuristic");
  }
  return { kind: "continue" };
}
```

(d) En la lista de pasos del runner, insertar `documentTriageGate` ENTRE `textExtractStep` y `aiExtractStep`:

```ts
      textExtractStep,
      documentTriageGate,
      aiExtractStep,
```

- [ ] **Step 4: Correr el test (y la suite completa)**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: PASS — el test nuevo pasa y los 8 existentes siguen verdes (su texto `"documento de prueba importe total a pagar"` tiene señales de boleta → no se desvía).

- [ ] **Step 5: typecheck + lint**

Run: `npm run typecheck`
Expected: sin errores.
Run: `npm run lint`
Expected: 0 errores (warnings pre-existentes OK).

- [ ] **Step 6: Commit**

```bash
git add src/jobs/processPendingDocuments.job.ts src/jobs/processPendingDocuments.job.test.ts
git commit -m "feat: capa 1 del triage (heuristica) - documentTriageGate + destino [NO BOLETA]"
```

---

## FASE 2 — Capa 2 (IA): red para lo dudoso

### Task 6: Campo `isBoleta` en el tipo + instrucción en el prompt

**Files:**
- Modify: `src/types/extractedDocument.types.ts`
- Modify: `src/lib/extraction.ts` (función `buildInvoicePrompt`)

- [ ] **Step 1: Agregar el campo al tipo**

En `src/types/extractedDocument.types.ts`, dentro de `interface ExtractedDocumentData`, después de `allTaxIds?: string[] | null;`, agregar:

```ts
  /** La IA juzga si el documento es una boleta/factura/recibo (capa 2 del triage). */
  isBoleta?: boolean;
```

- [ ] **Step 2: Instruir el campo en el prompt de facturas**

En `src/lib/extraction.ts`, localizar `buildInvoicePrompt` (es la función de facturas normales). En la sección donde se enumeran los campos a devolver en el JSON, agregar la instrucción del campo `isBoleta`. Buscar el bloque de instrucciones de campos y agregar (texto, dentro del prompt):

```
- "isBoleta": true si el documento es una FACTURA, RECIBO o COMPROBANTE de un gasto/pago
  (tiene importe a pagar, emisor, etc.). Devolvé false SOLO si el documento claramente NO es
  una boleta (por ejemplo: un certificado de desinfección/fumigación, una oblea de rúbrica de
  libros, un plano, una disposición o un informe). Ante la duda, devolvé true.
```

Y asegurarse de que el campo `isBoleta` figure en el ejemplo de salida JSON del prompt (si el prompt incluye un ejemplo de objeto). Si hay un objeto de ejemplo, agregar `"isBoleta": true`.

> Nota: los prompts LSP (servicios públicos) NO se tocan — esas son siempre boletas.

- [ ] **Step 3: Verificar typecheck + suite**

Run: `npm run typecheck`
Expected: sin errores.
Run: `npx vitest run`
Expected: PASS (todo verde; el campo es opcional, nada se rompe).

- [ ] **Step 4: Commit**

```bash
git add src/types/extractedDocument.types.ts src/lib/extraction.ts
git commit -m "feat: campo isBoleta en extraccion + instruccion en buildInvoicePrompt (capa 2)"
```

---

### Task 7: `isBoletaGate` (capa 2)

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.ts` (nuevo `isBoletaGate`; lista de pasos)
- Test: `src/jobs/processPendingDocuments.job.test.ts`

- [ ] **Step 1: Escribir el test de caracterización que falla**

En `src/jobs/processPendingDocuments.job.test.ts`, agregar:

```ts
  it("not_boleta (IA): aiChain devuelve isBoleta:false → [NO BOLETA] a Revisión", async () => {
    const ctx = makeContext();
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", true);
      return { data: okExtraction({ isBoleta: false }), usage: null, provider: "gemini" };
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.renameFile.mock.calls[0][1]).toMatch(/\[NO BOLETA\]/);
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "failed");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.notBoleta).toBe(1);
    expect(metricsCore().result).toBe("not_boleta");
  });
```

> `okExtraction` ya hace spread de overrides, así que `okExtraction({ isBoleta: false })` funciona una vez que `isBoleta` existe en `ExtractedDocumentData` (Task 6). El texto por defecto de `makeContext` tiene señales de boleta → pasa la capa 1; la capa 2 lo desvía.

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts -t "not_boleta (IA)"`
Expected: FAIL — sin `isBoletaGate`, el flujo sigue como boleta (insertRow/save se llaman).

- [ ] **Step 3: Agregar el gate**

En `src/jobs/processPendingDocuments.job.ts`, después de `aiExtractStep` (y antes de `missingAmountGate`), agregar:

```ts
/** 3.6 (capa 2) Triage por IA: si la extracción marcó isBoleta=false, deriva a [NO BOLETA]. */
async function isBoletaGate(ctx: PipelineContext): Promise<StepResult> {
  if (ctx.extracted?.isBoleta === false) {
    return divertNotBoleta(ctx, "ai");
  }
  return { kind: "continue" };
}
```

En la lista de pasos del runner, insertar `isBoletaGate` ENTRE `aiExtractStep` y `missingAmountGate`:

```ts
      aiExtractStep,
      isBoletaGate,
      missingAmountGate,
```

- [ ] **Step 4: Correr el test (y la suite completa)**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: PASS — el test nuevo pasa; los demás (incluido not_boleta heurística) siguen verdes.

- [ ] **Step 5: typecheck + lint**

Run: `npm run typecheck`
Expected: sin errores.
Run: `npm run lint`
Expected: 0 errores.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/processPendingDocuments.job.ts src/jobs/processPendingDocuments.job.test.ts
git commit -m "feat: capa 2 del triage (IA) - isBoletaGate"
```

---

### Task 8: Verificación final + documentación

**Files:**
- Modify: `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`

- [ ] **Step 1: Verificación completa**

Run: `npx vitest run`
Expected: PASS (todos, incl. los del clasificador, documentValidation y los 2 nuevos de caracterización).
Run: `npm run typecheck`
Expected: sin errores.
Run: `npm run lint`
Expected: 0 errores (warnings pre-existentes OK).
Run: `npm run build:jobs`
Expected: compila sin errores.

- [ ] **Step 2: Actualizar documentación (regla obligatoria del CLAUDE.md)**

- `docs/progreso.md`: nueva sección "Triage de documentos (boleta vs no-boleta)" con estado implementado + PENDIENTE push/rebuild worker; actualizar fecha/sesión.
- `docs/decisiones.md`: entrada con Problema/Decisión/Alternativas/Impacto (resumir el spec).
- `CHANGELOG.md`: entrada en `[Unreleased]` → `### Feature` con el triage en dos capas.

- [ ] **Step 3: Commit**

```bash
git add docs/progreso.md docs/decisiones.md CHANGELOG.md
git commit -m "docs: triage de documentos (boleta vs no-boleta)"
```

---

## Verificación final (obligatoria)

1. `npx vitest run` — 100% verde.
2. `npm run typecheck` + `npm run lint` (0 errores) + `npm run build:jobs`.
3. **Comportamiento preservado:** los 8 tests de caracterización del pipeline siguen verdes (el split de `extractStep` y los gates nuevos no alteran los 7 caminos previos).
4. **Docs** actualizadas (CLAUDE.md lo exige).

## Riesgos y mitigaciones

- **Falso positivo de la capa 1** (mandar una boleta genuina a Revisión): mitigado por la doble condición (señal negativa **y** ausencia de señales de boleta) + el test de la factura-de-fumigación-con-monto que fija el límite.
- **Cambio en el camino crítico:** el split de `extractStep` está cubierto por los 8 tests de caracterización; deben quedar idénticos.
- **Imágenes sin texto:** la capa 1 se saltea a propósito; la capa 2 (Vision → `isBoleta`) las cubre.

## Archivos

- Nuevos: `src/lib/documentClassifier.ts`, `src/lib/documentClassifier.test.ts`, `src/lib/documentValidation.test.ts`.
- Modificados: `src/lib/documentValidation.ts`, `src/types/process.types.ts`, `src/types/extractedDocument.types.ts`, `src/lib/logger.ts`, `src/lib/extraction.ts`, `src/jobs/processPendingDocuments.job.ts`, `src/jobs/processPendingDocuments.job.test.ts`.
- Sin migración.
