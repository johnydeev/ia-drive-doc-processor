import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  processDriveFile,
  createBaseSummary,
  DEFAULT_MAPPING,
  type ProcessingContext,
} from "@/jobs/processPendingDocuments.job";
import type { ProcessJobConfig, ProcessDriveFileInput } from "@/jobs/processPendingDocuments.job";
import type { AiAttemptCallback, AiExtractionResult } from "@/services/aiExtraction";
import { pipelineLog } from "@/lib/logger";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

/**
 * Tests de CARACTERIZACIÓN de `processDriveFile` (red de seguridad del refactor
 * H2). Documentan el comportamiento OBSERVABLE actual de los 7 caminos de salida
 * — qué métodos de Drive/Sheets/Repo se llaman y el `summary`/`result` resultante.
 * Deben pasar idénticos ANTES y DESPUÉS de descomponer el pipeline en pasos.
 *
 * Las dependencias se inyectan vía un `ProcessingContext` con todos los métodos
 * como `vi.fn()`. La lógica PURA intermedia (identifyLSPProvider, isMissingAmount,
 * matchConsortium/matchProvider, etc.) corre de verdad — por eso los inputs están
 * elegidos para enrutar a cada camino.
 */

function emptyExtraction(overrides: Partial<ExtractedDocumentData> = {}): ExtractedDocumentData {
  return {
    boletaNumber: null,
    provider: null,
    consortium: null,
    providerTaxId: null,
    detail: null,
    observation: null,
    dueDate: null,
    amount: null,
    alias: null,
    clientNumber: null,
    paymentMethod: null,
    allTaxIds: [],
    ...overrides,
  };
}

function makeFile(over: Partial<ProcessDriveFileInput> = {}): ProcessDriveFileInput {
  return { id: "file-1", name: "boleta.pdf", mimeType: "application/pdf", webViewLink: null, ...over };
}

/**
 * Datos extraídos por IA que matchean el consorcio/proveedor sembrados en makeContext.
 * Trae los DOS CUITs de la boleta (proveedor + consorcio): desde 2026-07-02 el
 * proveedor se matchea SOLO por CUIT, así que el camino feliz requiere el CUIT del
 * proveedor (30-65511651-2) presente. El del consorcio (30-11111111-1) también va.
 */
function okExtraction(over: Partial<ExtractedDocumentData> = {}): ExtractedDocumentData {
  return emptyExtraction({
    consortium: "THAMES 647",
    provider: "TIGRE ASCENSORES S.A.",
    amount: 118000,
    boletaNumber: "0001",
    dueDate: "2026-05-10",
    providerTaxId: "30-65511651-2",
    allTaxIds: ["30-65511651-2", "30-11111111-1"],
    ...over,
  });
}

/**
 * Arma un ProcessingContext con deps mockeadas. Por defecto enruta al camino OK:
 * sin duplicado, IA devuelve datos válidos, consorcio + proveedor + período activo
 * matchean. Cada test ajusta los mocks puntuales para enrutar a su camino.
 */
function makeContext(configOver: Partial<ProcessJobConfig> = {}) {
  const config: ProcessJobConfig = {
    clientId: "client-1",
    clientName: "Test Client",
    sheetName: "Datos",
    drivePendingFolderId: "pending",
    driveScannedFolderId: "scanned",
    driveUnassignedFolderId: "unassigned",
    driveFailedFolderId: "failed",
    driveProcessingFolderId: null,
    driveDuplicatesFolderId: "duplicates",
    driveStatementsFolderId: "statements",
    ...configOver,
  };

  const driveService = {
    downloadFile: vi.fn().mockResolvedValue(Buffer.from("pdf-bytes")),
    moveFileToFolder: vi.fn().mockResolvedValue(undefined),
    moveFileToUnassigned: vi.fn().mockResolvedValue(undefined),
    moveFileToScanned: vi.fn().mockResolvedValue(undefined),
    moveFileToFailed: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
  };

  const pdfExtractor = {
    // El texto incluye los dos CUITs (proveedor 30-65511651-2 + consorcio
    // 30-11111111-1): el pipeline descarta CUITs que NO aparecen en el texto
    // (anti-alucinación), y desde 2026-07-02 el proveedor se matchea solo por CUIT.
    extractTextFromPdf: vi.fn().mockResolvedValue(
      "documento de prueba importe total a pagar CUIT 30-65511651-2 consorcio 30-11111111-1"
    ),
    getLastTextSource: vi.fn().mockReturnValue("direct"),
    getLastHasEmitterBlock: vi.fn().mockReturnValue(true),
    getLastOcrMs: vi.fn().mockReturnValue(0),
    getLastOcrPng: vi.fn().mockReturnValue(null),
    isLastPdfScanned: vi.fn().mockReturnValue(false),
    extractMembreteImage: vi.fn().mockResolvedValue(null),
  };

  const sheetsService = {
    insertRow: vi.fn().mockResolvedValue(undefined),
  };

  const invoiceRepository = {
    computeDocumentHash: vi.fn().mockReturnValue("hash-abc123"),
    findDuplicateByHash: vi.fn().mockResolvedValue(null),
    findDuplicateByBusinessKey: vi.fn().mockResolvedValue(null),
    buildBusinessKeyFromData: vi.fn().mockReturnValue("bk-1"),
    saveProcessedInvoice: vi.fn().mockResolvedValue(undefined),
    // Fan-out de la Liquidación de Sueldos: cada boleta necesita su propio hash porque
    // `Invoice` tiene unique (clientId, documentHash).
    deriveDocumentHash: vi.fn((hash: string, cuil: string) => `${hash}:${cuil}`),
    findAnyByDriveFileId: vi.fn().mockResolvedValue(null),
  };

  const consortiumRepository = {
    findAllForMatching: vi.fn().mockResolvedValue([
      { id: "c1", canonicalName: "THAMES 647", rawName: "CONSORCIO THAMES 647", cuit: "30-11111111-1", matchNames: null },
    ]),
    findByCanonicalName: vi.fn().mockResolvedValue({
      id: "c1", canonicalName: "THAMES 647", rawName: "CONSORCIO THAMES 647",
      cuit: "30-11111111-1", bank: null, statementsFolderId: null,
    }),
    findActivePeriod: vi.fn().mockResolvedValue({ id: "per1", month: 5, year: 2026 }),
  };

  const providerRepository = {
    findAllForMatching: vi.fn().mockResolvedValue([
      { id: "p1", canonicalName: "TIGRE ASCENSORES S.A.", cuit: "30-65511651-2", matchNames: null, paymentAlias: null },
    ]),
    linkToConsortium: vi.fn().mockResolvedValue(undefined),
  };

  const lspServiceRepository = {
    findByProviderId: vi.fn().mockResolvedValue(null),
    findByProviderName: vi.fn().mockResolvedValue(null),
    setProviderId: vi.fn().mockResolvedValue(undefined),
  };

  const aiChain = {
    run: vi.fn<(text: string, onAttempt?: AiAttemptCallback) => Promise<AiExtractionResult | null>>(
      async (_text, onAttempt) => {
        onAttempt?.("gemini", true);
        return {
          data: okExtraction(),
          usage: { provider: "gemini", model: "flash-lite", inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          provider: "gemini",
        };
      }
    ),
  };

  const resolveStatementsFolders = vi.fn().mockResolvedValue({ periodFolderId: "pf1", consortiumFolderId: "cf1" });
  const buildInvoiceFileName = vi.fn().mockReturnValue("TIGRE - THAMES 647 - 05-2026.pdf");

  return {
    resolvedConfig: config,
    resolvedMapping: DEFAULT_MAPPING,
    driveService,
    pdfExtractor,
    sheetsService,
    invoiceRepository,
    consortiumRepository,
    providerRepository,
    lspServiceRepository,
    geminiModule: null,
    aiChain,
    geminiApiKey: undefined,
    geminiModel: undefined,
    existingDuplicateKeys: new Set<string>(),
    resolveStatementsFolders,
    buildInvoiceFileName,
  };
}

type TestContext = ReturnType<typeof makeContext>;

/** Cast al tipo público (las deps mockeadas implementan solo lo que el pipeline usa). */
function asContext(ctx: TestContext): ProcessingContext {
  return ctx as unknown as ProcessingContext;
}

describe("processDriveFile — caracterización de los 7 caminos de salida", () => {
  let metricsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Silenciar el logging ruidoso del pipeline (console) y capturar [metrics].
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    metricsSpy = vi.spyOn(pipelineLog, "metrics").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Devuelve el `core` de la única línea [metrics] emitida (garantía del finally). */
  function metricsCore(): Record<string, unknown> {
    expect(metricsSpy).toHaveBeenCalledTimes(1);
    return metricsSpy.mock.calls[0][0] as Record<string, unknown>;
  }

  it("ok: inserta en Sheets, guarda Invoice, organiza en Rendiciones", async () => {
    const ctx = makeContext();
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.sheetsService.insertRow).toHaveBeenCalledTimes(1);
    expect(ctx.invoiceRepository.saveProcessedInvoice).toHaveBeenCalledTimes(1);
    // Boleta OK → renombra + mueve a la carpeta de período de Rendiciones.
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "pf1");
    expect(summary.processed).toBe(1);
    expect(summary.unassigned).toBe(0);
    expect(metricsCore().result).toBe("ok");
  });

  it("ok: vincula la boleta a su obligación de gasto fijo tras persistir", async () => {
    const ctx = makeContext();
    // El save ahora devuelve la invoice (para poder vincular la obligación).
    ctx.invoiceRepository.saveProcessedInvoice.mockResolvedValue({
      id: "inv-1", periodId: "per-1", providerId: "prov-1", lspServiceId: null,
    });
    const linkSpy = vi.fn().mockResolvedValue(true);
    (ctx as unknown as { linkInvoiceToObligation: unknown }).linkInvoiceToObligation = linkSpy;
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(linkSpy).toHaveBeenCalledTimes(1);
    expect(linkSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inv-1", periodId: "per-1", providerId: "prov-1" })
    );
  });

  it("duplicate (hash): no escribe en Sheets ni DB, mueve a Duplicados", async () => {
    const ctx = makeContext();
    ctx.invoiceRepository.findDuplicateByHash.mockResolvedValue({ id: "inv-prev" });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "duplicates");
    expect(summary.duplicatesDetected).toBe(1);
    expect(metricsCore().result).toBe("duplicate");
  });

  it("duplicate (business key): no escribe en Sheets ni DB, mueve a Duplicados", async () => {
    const ctx = makeContext();
    ctx.invoiceRepository.findDuplicateByBusinessKey.mockResolvedValue({ id: "inv-prev" });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "duplicates");
    expect(summary.duplicatesDetected).toBe(1);
    expect(metricsCore().result).toBe("duplicate");
  });

  it("unassigned: mueve a Sin Asignar, sin Sheets ni DB", async () => {
    const ctx = makeContext();
    ctx.consortiumRepository.findAllForMatching.mockResolvedValue([]); // nada matchea
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", true);
      return {
        data: emptyExtraction({ consortium: "CONSORCIO INEXISTENTE 9999", provider: "X", amount: 5000 }),
        usage: null,
        provider: "gemini",
      };
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    // Factura común: el matching es sólo por CUIT (2026-08-26). La IA leyó un
    // nombre de consorcio, pero el nombre ya no asigna.
    //
    // El único CUIT válido del texto es el de TIGRE ASCENSORES, que está dado de
    // alta como proveedor → no es candidato a consorcio. El del consorcio del
    // fixture (30-11111111-1) no pasa checksum, así que `extractCuitsFromText` no
    // lo levanta. Conclusión correcta: el papel no trae CUIT de consorcio.
    expect(ctx.driveService.renameFile).toHaveBeenCalledWith("file-1", expect.stringContaining("CUIT DE CONSORCIO INEXISTENTE EN BOLETA"));
    expect(metricsCore().reason).toBe("consortium_cuit_missing");
    expect(ctx.driveService.moveFileToUnassigned).toHaveBeenCalledWith("file-1", "pending", "unassigned");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.unassigned).toBe(1);
    expect(metricsCore().result).toBe("unassigned");
  });

  it("unassigned (proveedor con CUIT no registrado): renombra CUIT DE PROVEEDOR NO REGISTRADO EN DB", async () => {
    const ctx = makeContext();
    ctx.providerRepository.findAllForMatching.mockResolvedValue([]); // consorcio matchea, proveedor no está en DB
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.renameFile).toHaveBeenCalledWith("file-1", expect.stringContaining("CUIT DE PROVEEDOR NO REGISTRADO EN DB"));
    expect(ctx.driveService.moveFileToUnassigned).toHaveBeenCalledWith("file-1", "pending", "unassigned");
    expect(metricsCore().result).toBe("unassigned");
    expect(metricsCore().reason).toBe("provider_cuit_not_registered");
  });

  it("unassigned (sin CUIT de proveedor): renombra CUIT DE PROVEEDOR INEXISTENTE EN BOLETA", async () => {
    const ctx = makeContext();
    ctx.providerRepository.findAllForMatching.mockResolvedValue([]);
    // El texto tampoco trae CUIT de proveedor (cuitSanitizeStep re-agrega los del
    // texto): solo el del consorcio → no hay CUIT de proveedor identificable.
    ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue("documento importe total a pagar consorcio 30-11111111-1");
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", true);
      return { data: okExtraction({ providerTaxId: null, allTaxIds: ["30-11111111-1"] }), usage: null, provider: "gemini" };
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.renameFile).toHaveBeenCalledWith("file-1", expect.stringContaining("CUIT DE PROVEEDOR INEXISTENTE EN BOLETA"));
    expect(metricsCore().reason).toBe("provider_cuit_missing");
  });

  it("unassigned (sin ningún CUIT en el papel): renombra CUIT DE CONSORCIO INEXISTENTE EN BOLETA", async () => {
    const ctx = makeContext();
    // Ni el texto ni la extracción traen CUITs: el proveedor emitió la boleta sin
    // el CUIT del receptor. No hay con qué identificar al edificio.
    ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue("documento importe total a pagar sin ningun identificador fiscal");
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", true);
      return {
        data: emptyExtraction({ consortium: "CONSORCIO DE PROPIETARIOS EVA PERON", provider: "X", amount: 5000, providerTaxId: null, allTaxIds: [] }),
        usage: null,
        provider: "gemini",
      };
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.renameFile).toHaveBeenCalledWith("file-1", expect.stringContaining("CUIT DE CONSORCIO INEXISTENTE EN BOLETA"));
    expect(metricsCore().reason).toBe("consortium_cuit_missing");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
  });

  it("un solo CUIT en el papel y es de un proveedor conocido → falta el del consorcio", async () => {
    // Caso frecuente: el proveedor emitió sin cargar el CUIT del receptor, así que
    // el único CUIT del papel es el suyo. Reportarlo como "CUIT de consorcio no
    // registrado" mandaría a dar de alta un edificio con el CUIT del proveedor.
    const ctx = makeContext();
    ctx.providerRepository.findAllForMatching.mockResolvedValue([
      { id: "p1", canonicalName: "PROVEEDOR CONOCIDO", cuit: "30-70701800-6", matchNames: null, paymentAlias: null },
    ]);
    ctx.consortiumRepository.findAllForMatching.mockResolvedValue([]);
    ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue("factura importe total a pagar 30-70701800-6");
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", true);
      return {
        data: emptyExtraction({
          consortium: "CONSORCIO DE PROPIETARIOS EVA PERON",
          provider: "PROVEEDOR CONOCIDO",
          amount: 5000,
          providerTaxId: null,          // la IA no lo marcó como del emisor
          allTaxIds: ["30707018006"],
        }),
        usage: null,
        provider: "gemini",
      };
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(metricsCore().reason).toBe("consortium_cuit_missing");
    expect(ctx.driveService.renameFile).toHaveBeenCalledWith("file-1", expect.stringContaining("CUIT DE CONSORCIO INEXISTENTE EN BOLETA"));
  });

  it("un CUIT mal leído por la IA no bloquea el rescate por código de barras", async () => {
    // Caso real (`Fact. 51837`, 2026-08-26): membrete en imagen. La IA devolvió
    // 30-70701800-6, un CUIT que NO está en el papel; el código de barras AFIP dice
    // 30-70741550-5. Con la puerta angosta (sólo "no se extrajo ningún CUIT") el
    // rescate determinístico no corría y la boleta quedaba etiquetada con el CUIT
    // equivocado.
    const ctx = makeContext();
    ctx.providerRepository.findAllForMatching.mockResolvedValue([
      { id: "p1", canonicalName: "B PACE E HIJOS S.R.L.", cuit: "30-70741550-5", matchNames: null, paymentAlias: null },
    ]);
    // El consorcio matchea por su CUIT real (el 30-11111111-1 del fixture es un
    // placeholder y `extractCuitsFromText` ya no lo levanta).
    ctx.consortiumRepository.findAllForMatching.mockResolvedValue([
      { id: "c1", canonicalName: "ARAOZ 192", rawName: "CONSORCIO ARAOZ 192", cuit: "30-55007155-6", matchNames: null },
    ]);
    ctx.consortiumRepository.findByCanonicalName.mockResolvedValue({
      id: "c1", canonicalName: "ARAOZ 192", rawName: "CONSORCIO ARAOZ 192",
      cuit: "30-55007155-6", bank: null, statementsFolderId: "stmt-1",
    });
    ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(
      "FACTURA Nro. 0010-00051837 CONSORCIO CUIT: 30-55007155-6 importe total a pagar 3070741550506001086095857203130202603121 Nro. de CAE: 86095857203130"
    );
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", true);
      return {
        data: okExtraction({ providerTaxId: "30-70701800-6", allTaxIds: ["30707018006", "30550071556"] }),
        usage: null,
        provider: "gemini",
      };
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    // El código de barras aporta el CUIT real y el proveedor matchea.
    expect(metricsCore().result).toBe("ok");
    expect(ctx.invoiceRepository.saveProcessedInvoice).toHaveBeenCalled();
  });

  it("no_amount: renombra SIN MONTO y mueve a Revisión", async () => {
    const ctx = makeContext();
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", true);
      return { data: okExtraction({ amount: null }), usage: null, provider: "gemini" };
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.renameFile).toHaveBeenCalledTimes(1);
    expect(ctx.driveService.renameFile.mock.calls[0][1]).toMatch(/SIN MONTO/i);
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "failed");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.unassigned).toBe(1);
    expect(metricsCore().result).toBe("no_amount");
  });

  it("no_period: consorcio matchea pero sin período activo → Revisión", async () => {
    const ctx = makeContext();
    ctx.consortiumRepository.findActivePeriod.mockResolvedValue(null);
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.renameFile).toHaveBeenCalledWith("file-1", expect.stringContaining("SIN PERÍODO"));
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "failed");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.unassigned).toBe(1);
    expect(metricsCore().result).toBe("no_period");
  });

  it("rate_limited: 429 en todos los proveedores → vuelve a Pendientes, no falla", async () => {
    const ctx = makeContext({ driveProcessingFolderId: "processing" });
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", false, "quota exceeded", true);
      return null;
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    // Devuelve el PDF de Procesando → Pendientes para reintento posterior.
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "processing", "pending");
    expect(summary.rateLimited).toBe(1);
    expect(summary.failed).toBe(0);
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(metricsCore().result).toBe("rate_limited");
  });

  it("failed: error genérico → mueve a Revisión y suma a failed", async () => {
    const ctx = makeContext();
    ctx.driveService.downloadFile.mockRejectedValue(new Error("drive boom"));
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.moveFileToFailed).toHaveBeenCalledWith("file-1", "pending", "failed");
    expect(summary.failed).toBe(1);
    expect(summary.processed).toBe(0);
    expect(metricsCore().result).toBe("failed");
  });

  // 2026-08-31: el destino de las no-boletas pasó de Revisión a SIN ASIGNAR. El
  // owner va a armar un flujo propio para VEP/LSD, así que son documentos
  // pendientes de asignar y no descarte; tenerlos en una sola carpeta es lo que
  // hace posible la limpieza manual antes de reprocesar.
  it("not_boleta (heurística): no llama a la IA, renombra [NO BOLETA] y va a Sin Asignar", async () => {
    const ctx = makeContext();
    // Texto que la heurística clasifica como no-boleta (certificado sin monto).
    ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(
      "CERTIFICADO DE FUMIGACION Y CONTROL DE PLAGAS - Edificio Thames 647"
    );
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.aiChain.run).not.toHaveBeenCalled();
    expect(ctx.driveService.renameFile.mock.calls[0][1]).toMatch(/\[NO BOLETA\]/);
    expect(ctx.driveService.moveFileToUnassigned).toHaveBeenCalledWith("file-1", "pending", "unassigned");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.notBoleta).toBe(1);
    expect(metricsCore().result).toBe("not_boleta");
  });

  // ── VEP de ARCA ──────────────────────────────────────────────────────────
  // Hasta el 2026-09-02 el VEP era un no-boleta y se descartaba antes de la IA.
  // Desde el 2026-09-03 se procesa como un gasto del consorcio contribuyente.
  describe("VEP de ARCA", () => {
    /** El CUIT del consorcio sembrado en makeContext + el real de la administradora. */
    const VEP_TEXT = `VEP
Volante Electrónico de Pago
Nro. VEP: 1570130517
Organismo Recaudador: ARCA
Tipo de Pago: Empleadores SICOSS - Saldo DJ
CUIT: 30-11111111-1
Período: 2025-12
Generado por el Usuario: 27324998573
Día de Expiración: 2026-02-08
Importe total a pagar $1.123.728,00`;

    function vepExtraction(over: Partial<ExtractedDocumentData> = {}): ExtractedDocumentData {
      return emptyExtraction({
        boletaNumber: "1570130517",
        provider: "ARCA",
        providerTaxId: null,
        amount: 1123728,
        dueDate: "2026-02-08",
        allTaxIds: ["30-11111111-1"],
        ...over,
      });
    }

    function vepContext(extraction: ExtractedDocumentData = vepExtraction()) {
      const ctx = makeContext();
      ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(VEP_TEXT);
      // ARCA sin CUIT + la administradora, que es un proveedor real CON CUIT.
      ctx.providerRepository.findAllForMatching.mockResolvedValue([
        { id: "arca", canonicalName: "ARCA", cuit: null, matchNames: null, paymentAlias: null },
        { id: "admin", canonicalName: "MORINIGO RAMONA NATALIA", cuit: "27-32499857-3", matchNames: null, paymentAlias: null },
      ]);
      ctx.aiChain.run.mockImplementation(async (_t: string, cb?: AiAttemptCallback) => {
        cb?.("gemini", true);
        return { data: extraction, usage: null, provider: "gemini" as const };
      });
      return ctx;
    }

    it("imputa el gasto al consorcio del CUIT y el proveedor es ARCA", async () => {
      const ctx = vepContext();

      await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

      const guardada = ctx.invoiceRepository.saveProcessedInvoice.mock.calls[0][0];
      expect(guardada.consortiumId).toBe("c1");
      expect(guardada.providerId).toBe("arca");
    });

    it("NO usa a la administradora, cuyo CUIT viaja en TODOS los VEP", async () => {
      // `cuitSanitizeStep` extrae por regex TODOS los CUITs del papel y los suma a
      // `allTaxIds`, así que el de la administradora llega al matching aunque la IA
      // lo omita. Sin el corte de `allTaxIds`, `matchProvider` devuelve `admin` por
      // su Intento 0 (CUIT), que corre ANTES del match por nombre.
      const ctx = vepContext(vepExtraction({ allTaxIds: ["30-11111111-1", "27-32499857-3"] }));

      await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

      const guardada = ctx.invoiceRepository.saveProcessedInvoice.mock.calls[0][0];
      expect(guardada.providerId).toBe("arca");
      expect(guardada.providerId).not.toBe("admin");
    });

    it("guarda el número, el monto y el vencimiento del cupón", async () => {
      const ctx = vepContext();

      await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

      const guardada = ctx.invoiceRepository.saveProcessedInvoice.mock.calls[0][0];
      expect(guardada.extraction.boletaNumber).toBe("1570130517");
      expect(guardada.extraction.amount).toBe(1123728);
      expect(guardada.extraction.dueDate).toBe("2026-02-08");
    });

    it("un consortium mal extraído no arrastra el VEP a otro edificio", async () => {
      // El VEP no imprime la dirección del inmueble: lo que venga en `consortium` no
      // es una pista, es ruido. Acá el CUIT del papel NO está en la base (el edificio
      // no tiene el alta) pero el texto basura SÍ coincide con el nombre de otro
      // edificio. Con el match por nombre vivo, el gasto se iba a "SICOSS 123".
      const ctx = vepContext(vepExtraction({ consortium: "SICOSS 123" }));
      ctx.consortiumRepository.findAllForMatching.mockResolvedValue([
        { id: "c2", canonicalName: "SICOSS 123", rawName: null, cuit: "30-22222222-2", matchNames: null },
      ]);
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
      expect(summary.unassigned).toBe(1);
    });

    it("un clientNumber colado por la IA no rebota el VEP al fast-path de LspService", async () => {
      // El fast-path de LspService es TERMINAL: si hay clientNumber y no aparece el
      // servicio, la boleta sale a Sin Asignar sin apelación. Ningún miembro de
      // `usesConsortiumCuit` usa LspService, así que el campo se limpia antes.
      const ctx = vepContext(vepExtraction({ clientNumber: "1570130517" }));

      await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

      expect(ctx.invoiceRepository.saveProcessedInvoice).toHaveBeenCalled();
      expect(ctx.driveService.moveFileToUnassigned).not.toHaveBeenCalled();
    });

    it("un VEP cuyo CUIT no es de ningún consorcio va a Sin Asignar", async () => {
      // El VEP de un tercero o el de los autónomos de la administradora: su CUIT no
      // es de un edificio. Rebota, y está bien — queda visible en la carpeta.
      const ctx = vepContext();
      ctx.consortiumRepository.findAllForMatching.mockResolvedValue([]);
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
      expect(ctx.driveService.moveFileToUnassigned).toHaveBeenCalled();
      expect(summary.unassigned).toBe(1);
    });
  });

  it("not_boleta (IA): aiChain devuelve isBoleta:false → [NO BOLETA] a Sin Asignar", async () => {
    const ctx = makeContext();
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", true);
      return { data: okExtraction({ isBoleta: false }), usage: null, provider: "gemini" };
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.renameFile.mock.calls[0][1]).toMatch(/\[NO BOLETA\]/);
    expect(ctx.driveService.moveFileToUnassigned).toHaveBeenCalledWith("file-1", "pending", "unassigned");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.notBoleta).toBe(1);
    expect(metricsCore().result).toBe("not_boleta");
  });

  describe("fallback visual Gemini (CUIT del membrete en imagen)", () => {
    /** Instala un geminiModule mock cuyo extractPartiesFromImage devuelve `parties`. */
    function withGeminiVision(ctx: TestContext, parties: {
      providerName?: string | null; providerTaxId?: string | null;
      consortiumName?: string | null; consortiumTaxId?: string | null;
    }) {
      const spy = vi.fn().mockResolvedValue({
        providerName: null, providerTaxId: null, consortiumName: null, consortiumTaxId: null, ...parties,
      });
      (ctx as unknown as { geminiModule: unknown }).geminiModule = {
        GeminiExtractorService: class {
          extractPartiesFromImage = spy;
        },
      };
      (ctx as unknown as { geminiApiKey?: string }).geminiApiKey = "gemini-key";
      return spy;
    }

    it("recupera el CUIT del proveedor del membrete (emisor en imagen) → OK", async () => {
      const ctx = makeContext();
      // Texto SIN el CUIT del proveedor (está en el logo); solo el del consorcio.
      ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(
        "factura importe total a pagar consorcio 30-11111111-1"
      );
      ctx.pdfExtractor.extractMembreteImage = vi.fn().mockResolvedValue(Buffer.from("membrete-png"));
      ctx.aiChain.run.mockImplementation(async (_t, cb) => {
        cb?.("cerebras", true);
        return {
          data: okExtraction({ providerTaxId: null, allTaxIds: ["30-11111111-1"] }),
          usage: null, provider: "cerebras",
        };
      });
      // Gemini Vision lee el CUIT del emisor (que sí está cargado en la DB).
      const spy = withGeminiVision(ctx, { providerName: "TIGRE ASCENSORES S.A.", providerTaxId: "30-65511651-2" });
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(ctx.pdfExtractor.extractMembreteImage).toHaveBeenCalledTimes(1);
      expect(ctx.sheetsService.insertRow).toHaveBeenCalledTimes(1);
      expect(summary.processed).toBe(1);
      expect(metricsCore().result).toBe("ok");
    });

    it("NO se dispara si ya matchearon ambos CUITs (ahorro de tokens)", async () => {
      const ctx = makeContext(); // okExtraction trae los 2 CUITs → asigna sin visión
      ctx.pdfExtractor.extractMembreteImage = vi.fn().mockResolvedValue(Buffer.from("x"));
      const spy = withGeminiVision(ctx, { providerTaxId: "30-65511651-2" });
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(spy).not.toHaveBeenCalled();
      expect(ctx.pdfExtractor.extractMembreteImage).not.toHaveBeenCalled();
      expect(metricsCore().result).toBe("ok");
    });

    it("NO se dispara por no_amount (solo por CUIT faltante)", async () => {
      const ctx = makeContext();
      ctx.aiChain.run.mockImplementation(async (_t, cb) => {
        cb?.("cerebras", true);
        return { data: okExtraction({ amount: null }), usage: null, provider: "cerebras" };
      });
      ctx.pdfExtractor.extractMembreteImage = vi.fn().mockResolvedValue(Buffer.from("x"));
      const spy = withGeminiVision(ctx, { providerTaxId: "30-65511651-2" });
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(spy).not.toHaveBeenCalled();
      expect(ctx.pdfExtractor.extractMembreteImage).not.toHaveBeenCalled();
      expect(metricsCore().result).toBe("no_amount");
    });

    /**
     * Código de barras AFIP (RG 1702) cuyo emisor es TIGRE ASCENSORES (30-65511651-2,
     * el proveedor cargado en la DB de estos tests): CUIT + tipo 06 + pto vta 0010 +
     * CAE + vencimiento + dígito verificador.
     */
    const BARCODE_TIGRE = "3065511651206001086095857203130202603121";

    it("el CUIT del código de barras resuelve la asignación SIN llamar a Vision", async () => {
      const ctx = makeContext();
      // Membrete en imagen: el único CUIT suelto del texto es el del consorcio.
      // El del proveedor viaja dentro del código de barras.
      ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(
        `factura importe total a pagar consorcio 30-11111111-1
Nro. de CAE: 86095857203130
${BARCODE_TIGRE}`
      );
      ctx.pdfExtractor.extractMembreteImage = vi.fn().mockResolvedValue(Buffer.from("membrete-png"));
      ctx.aiChain.run.mockImplementation(async (_t, cb) => {
        cb?.("cerebras", true);
        return {
          data: okExtraction({ providerTaxId: null, allTaxIds: ["30-11111111-1"] }),
          usage: null, provider: "cerebras",
        };
      });
      const spy = withGeminiVision(ctx, { providerTaxId: "30-65511651-2" });
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(spy).not.toHaveBeenCalled();
      expect(ctx.pdfExtractor.extractMembreteImage).not.toHaveBeenCalled();
      expect(ctx.sheetsService.insertRow).toHaveBeenCalledTimes(1);
      expect(summary.processed).toBe(1);
      expect(metricsCore().result).toBe("ok");
    });

    it("código de barras con un CUIT que no está en la DB: sigue con Vision", async () => {
      const ctx = makeContext();
      // Emisor 30-70741550-5: código válido, pero ese proveedor no está cargado.
      ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(
        `factura importe total a pagar consorcio 30-11111111-1
3070741550506001086095857203130202603121`
      );
      ctx.pdfExtractor.extractMembreteImage = vi.fn().mockResolvedValue(Buffer.from("membrete-png"));
      ctx.aiChain.run.mockImplementation(async (_t, cb) => {
        cb?.("cerebras", true);
        return {
          data: okExtraction({ providerTaxId: null, allTaxIds: ["30-11111111-1"] }),
          usage: null, provider: "cerebras",
        };
      });
      const spy = withGeminiVision(ctx, { providerTaxId: "30-65511651-2" });
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(metricsCore().result).toBe("ok");
    });

    it("CUIT del membrete no está en la DB → sigue en Sin Asignar", async () => {
      const ctx = makeContext();
      ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(
        "factura importe total a pagar consorcio 30-11111111-1"
      );
      ctx.pdfExtractor.extractMembreteImage = vi.fn().mockResolvedValue(Buffer.from("membrete-png"));
      ctx.aiChain.run.mockImplementation(async (_t, cb) => {
        cb?.("cerebras", true);
        return {
          data: okExtraction({ providerTaxId: null, allTaxIds: ["30-11111111-1"] }),
          usage: null, provider: "cerebras",
        };
      });
      // Gemini lee un CUIT de proveedor que NO está cargado (tolerancia 0).
      const spy = withGeminiVision(ctx, { providerName: "PROVEEDOR NUEVO", providerTaxId: "30-99999999-9" });
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(ctx.driveService.moveFileToUnassigned).toHaveBeenCalledWith("file-1", "pending", "unassigned");
      expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
      expect(summary.unassigned).toBe(1);
      expect(metricsCore().result).toBe("unassigned");
    });
  });

  describe("colector de diagnóstico (corrida selectiva)", () => {
    it("entrega el diagnóstico completo de la boleta, con el texto que vio la IA", async () => {
      const ctx = makeContext();
      const onDiagnostics = vi.fn();
      (ctx as unknown as { onDiagnostics: unknown }).onDiagnostics = onDiagnostics;
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(onDiagnostics).toHaveBeenCalledTimes(1);
      expect(onDiagnostics.mock.calls[0][0]).toMatchObject({
        fileId: "file-1",
        fileName: "boleta.pdf",
        result: "ok",
        promptText: expect.stringContaining("30-65511651-2"),
      });
    });

    it("se emite también cuando la boleta NO entra (es cuando más sirve)", async () => {
      const ctx = makeContext();
      ctx.providerRepository.findAllForMatching.mockResolvedValue([]);
      const onDiagnostics = vi.fn();
      (ctx as unknown as { onDiagnostics: unknown }).onDiagnostics = onDiagnostics;
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(onDiagnostics.mock.calls[0][0]).toMatchObject({ result: "unassigned" });
    });

    it("sin colector, el pipeline se comporta igual que antes", async () => {
      const ctx = makeContext();
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(summary.processed).toBe(1);
      expect(metricsCore().result).toBe("ok");
    });
  });

  describe("PDF escaneado (páginas imagen) → extracción por Gemini Vision", () => {
    /**
     * Instala un geminiModule cuyo `extractStructuredDataFromImage` devuelve `data`.
     * Es el mismo servicio que usa el flujo de archivos imagen (JPG/PNG).
     */
    function withVisionExtraction(ctx: TestContext, data: ReturnType<typeof okExtraction> | Error) {
      const spy = data instanceof Error
        ? vi.fn().mockRejectedValue(data)
        : vi.fn().mockResolvedValue(data);
      (ctx as unknown as { geminiModule: unknown }).geminiModule = {
        GeminiExtractorService: class {
          extractStructuredDataFromImage = spy;
          getLastUsage = () => null;
        },
      };
      (ctx as unknown as { geminiApiKey?: string }).geminiApiKey = "gemini-key";
      return spy;
    }

    /** Deja el extractor en el estado de un PDF escaneado: sin texto propio, con PNG del OCR. */
    function asScannedPdf(ctx: TestContext, ocrText = "") {
      ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(ocrText);
      ctx.pdfExtractor.isLastPdfScanned.mockReturnValue(true);
      ctx.pdfExtractor.getLastOcrPng.mockReturnValue(Buffer.from("pagina-1-png"));
    }

    it("PDF sin texto propio: extrae por Vision y la boleta entra OK (no cae en SIN MONTO)", async () => {
      const ctx = makeContext();
      asScannedPdf(ctx);
      const spy = withVisionExtraction(ctx, okExtraction());
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(ctx.aiChain.run).not.toHaveBeenCalled();
      expect(ctx.sheetsService.insertRow).toHaveBeenCalledTimes(1);
      expect(summary.processed).toBe(1);
      expect(metricsCore().result).toBe("ok");
    });

    it("el CUIT que leyó Vision NO se descarta aunque no esté en el texto del OCR", async () => {
      const ctx = makeContext();
      // El OCR devolvió algo, pero ilegible: no es testigo válido de los CUITs.
      // Sin la excepción, cuitSanitizeStep descartaría el CUIT → SIN PROVEEDOR.
      asScannedPdf(ctx, "escaneo ilegible sin datos utiles");
      withVisionExtraction(ctx, okExtraction());
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(ctx.sheetsService.insertRow).toHaveBeenCalledTimes(1);
      expect(summary.processed).toBe(1);
      expect(metricsCore().result).toBe("ok");
    });

    it("sin Gemini configurado: mantiene el comportamiento actual (cadena sobre el texto del OCR)", async () => {
      const ctx = makeContext();
      asScannedPdf(ctx, "texto pobre del ocr");
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(ctx.aiChain.run).toHaveBeenCalledTimes(1);
    });

    it("Vision falla (error común): cae a la cadena de texto, no rompe", async () => {
      const ctx = makeContext();
      asScannedPdf(ctx, "texto pobre del ocr");
      const spy = withVisionExtraction(ctx, new Error("vision boom"));
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(ctx.aiChain.run).toHaveBeenCalledTimes(1);
      expect(summary.failed).toBe(0);
    });

    it("Vision sin cuota (429): vuelve a Pendientes, no degrada a Revisión", async () => {
      const ctx = makeContext({ driveProcessingFolderId: "processing" });
      asScannedPdf(ctx);
      withVisionExtraction(ctx, new Error("429 quota exceeded"));
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "processing", "pending");
      expect(summary.rateLimited).toBe(1);
      expect(metricsCore().result).toBe("rate_limited");
    });

    it("PDF con texto propio: NO llama a Vision (ahorro de tokens)", async () => {
      const ctx = makeContext();
      const spy = withVisionExtraction(ctx, okExtraction());
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(spy).not.toHaveBeenCalled();
      expect(ctx.aiChain.run).toHaveBeenCalledTimes(1);
      expect(metricsCore().result).toBe("ok");
    });

    it("PDF escaneado sin PNG del OCR (poppler caído): cae a la cadena", async () => {
      const ctx = makeContext();
      ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue("texto pobre del ocr");
      ctx.pdfExtractor.isLastPdfScanned.mockReturnValue(true);
      ctx.pdfExtractor.getLastOcrPng.mockReturnValue(null);
      const spy = withVisionExtraction(ctx, okExtraction());
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(spy).not.toHaveBeenCalled();
      expect(ctx.aiChain.run).toHaveBeenCalledTimes(1);
    });
  });
});

describe("colector de métricas de consumo (onOutcome)", () => {
  it("emite el outcome con las requests contadas cuando la boleta entra", async () => {
    const ctx = makeContext();
    const onOutcome = vi.fn();
    (ctx as unknown as { onOutcome: unknown }).onOutcome = onOutcome;
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome.mock.calls[0][0]).toMatchObject({
      fileId: "file-1",
      outcome: "ok",
      usedVision: false,
    });
  });

  it("se emite también cuando la boleta queda sin asignar", async () => {
    const ctx = makeContext();
    ctx.providerRepository.findAllForMatching.mockResolvedValue([]);
    const onOutcome = vi.fn();
    (ctx as unknown as { onOutcome: unknown }).onOutcome = onOutcome;
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(onOutcome.mock.calls[0][0]).toMatchObject({ outcome: "unassigned" });
    // La categoría es la que nombra la etiqueta del archivo en Sin Asignar.
    expect(onOutcome.mock.calls[0][0].reasonCategory).toBeTruthy();
  });

  it("sin colector, el pipeline se comporta igual que antes", async () => {
    const ctx = makeContext();
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(summary.processed).toBe(1);
    expect(ctx.sheetsService.insertRow).toHaveBeenCalled();
  });
});

describe("corte temprano por archivo ya procesado", () => {
  it("un archivo con boleta ya cargada corta sin llamar a la IA", async () => {
    const ctx = makeContext();
    ctx.invoiceRepository.findAnyByDriveFileId = vi.fn().mockResolvedValue({
      extraction: okExtraction(),
      sourceFileUrl: "https://drive/x",
      fileId: "file-1",
      businessKey: "bk-1",
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    // El hash derivado de una Liquidación de Sueldos no coincide con el del binario, así
    // que sin este corte un reproceso volvía a pagar la extracción.
    expect(ctx.aiChain.run).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.duplicatesDetected).toBe(1);
  });

  it("un archivo nuevo sigue el flujo normal", async () => {
    const ctx = makeContext();
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.aiChain.run).toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).toHaveBeenCalled();
  });
});

describe("LSD — un libro, N empleados", () => {
  /** Encabezado real de un LSD, con el CUIT del consorcio sembrado en makeContext. */
  const LSD_TEXT = `EMPRESA DOMICILIO FISCAL
PERIODO PROVINCIA
NRO.LIQUIDACIÓN
ACTIVIDAD PPAL
30-11111111-1 - CONSORCIO THAMES 647
202607 CIUDAD AUTONOMA BUENOS AIRES
IDENTIFICADOR ÚNICO DEL LIBRO 000000045900718`;

  function lsdContext(padron: string[]) {
    const ctx = makeContext();
    ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(LSD_TEXT);
    ctx.providerRepository.findAllForMatching.mockResolvedValue([
      { id: "e1", canonicalName: "BRITEZ PAULA", cuit: "27-18116846-9", matchNames: null, paymentAlias: null },
      { id: "e2", canonicalName: "CRUZ RICARDO", cuit: "20-24883768-4", matchNames: null, paymentAlias: null },
    ]);
    ctx.aiChain.run.mockImplementation(async (_t: string, cb?: AiAttemptCallback) => {
      cb?.("gemini", true);
      return {
        // Lo que devuelve Gemini DE VERDAD con el prompt del libro (medido en
        // producción el 2026-09-06): `allTaxIds` y `consortium` vienen NULL — el
        // prompt del LSD no los pide — y el CUIT del edificio viaja SÓLO dentro
        // de `lsd.consortiumTaxId`. El fixture viejo sembraba `allTaxIds` y por
        // eso los tests no vieron que el matching del consorcio quedaba a suerte.
        data: emptyExtraction({
          allTaxIds: [],
          consortium: null,
          lsd: {
            consortiumTaxId: "30-11111111-1",
            libroId: "000000045900718",
            periodo: "202607",
            empleados: [
              { cuil: "27-18116846-9", apellidoNombre: "BRITEZ, PAULA", sueldoNeto: 1000 },
              { cuil: "20-24883768-4", apellidoNombre: "CRUZ, RICARDO", sueldoNeto: 2000 },
            ],
          },
        }),
        usage: null,
        provider: "gemini" as const,
      };
    });
    (ctx as unknown as { findEmployeeFixedExpenses: unknown }).findEmployeeFixedExpenses =
      async () => padron;
    return ctx;
  }

  it("genera una boleta por empleado con una sola llamada a la IA", async () => {
    const ctx = lsdContext(["e1", "e2"]);
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.invoiceRepository.saveProcessedInvoice).toHaveBeenCalledTimes(2);
    expect(ctx.sheetsService.insertRow).toHaveBeenCalledTimes(2);
    expect(ctx.aiChain.run).toHaveBeenCalledTimes(1);
    expect(summary.processed).toBe(2);
    expect(ctx.driveService.moveFileToUnassigned).not.toHaveBeenCalled();
  });

  it("cada boleta lleva el empleado como proveedor y su sueldo neto", async () => {
    const ctx = lsdContext(["e1", "e2"]);
    await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

    const guardadas = ctx.invoiceRepository.saveProcessedInvoice.mock.calls.map((c) => c[0]);
    expect(guardadas.map((g) => g.providerId).sort()).toEqual(["e1", "e2"]);
    expect(guardadas.map((g) => g.extraction.amount).sort((a, b) => a - b)).toEqual([1000, 2000]);
    // Números distintos: la clave de negocio separa las N boletas del mismo libro.
    const numeros = guardadas.map((g) => g.extraction.boletaNumber);
    expect(new Set(numeros).size).toBe(2);
    // Hash derivado por empleado: el unique (clientId, documentHash) lo exige.
    expect(new Set(guardadas.map((g) => g.documentHash)).size).toBe(2);
    // Sin vencimiento: un libro no tiene fecha de pago impresa.
    expect(guardadas.every((g) => g.extraction.dueDate === null)).toBe(true);
  });

  // Regresión del 2026-09-06: ALMIRANTE BROWN rebotó con `consortium_not_found`
  // pese a que la IA había extraído los 2 empleados y el CUIT del edificio
  // PERFECTOS. El CUIT vivía en `lsd.consortiumTaxId` y el matching sólo miraba
  // `allTaxIds`/`consortium`, así que el libro entraba únicamente si el modelo
  // rellenaba `consortium` por su cuenta. En 5 libros lo hizo en 4.
  it("resuelve el edificio con lsd.consortiumTaxId aunque la IA no mande allTaxIds ni consortium", async () => {
    const ctx = lsdContext(["e1", "e2"]);
    const extraccion = await ctx.aiChain.run("");
    // El fixture ya replica la salida real; esto lo deja explícito.
    expect(extraccion!.data.allTaxIds).toEqual([]);
    expect(extraccion!.data.consortium).toBeNull();
    expect(extraccion!.data.lsd?.consortiumTaxId).toBe("30-11111111-1");

    await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

    const guardadas = ctx.invoiceRepository.saveProcessedInvoice.mock.calls.map((c) => c[0]);
    expect(guardadas).toHaveLength(2);
    expect(guardadas.every((g) => g.consortiumId === "c1")).toBe(true);
  });

  it("el archivo se mueve UNA sola vez", async () => {
    const ctx = lsdContext(["e1", "e2"]);
    await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledTimes(1);
  });

  it("si queda un gasto fijo sin cubrir, NO entra ninguna boleta", async () => {
    const ctx = lsdContext(["e1", "e2", "e3"]);
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.driveService.moveFileToUnassigned).toHaveBeenCalled();
    // La etiqueta del archivo dice qué faltó, que es lo que ve el owner en Drive.
    expect(ctx.driveService.renameFile.mock.calls[0][1]).toContain("FALTA UN EMPLEADO EN EL LIBRO");
  });

  it("si un CUIL no está de alta (suplente), NO entra ninguna boleta", async () => {
    const ctx = lsdContext(["e1"]);
    ctx.providerRepository.findAllForMatching.mockResolvedValue([
      { id: "e1", canonicalName: "BRITEZ PAULA", cuit: "27-18116846-9", matchNames: null, paymentAlias: null },
    ]);
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(ctx.driveService.renameFile.mock.calls[0][1]).toContain("EMPLEADO NO REGISTRADO");
  });
});
