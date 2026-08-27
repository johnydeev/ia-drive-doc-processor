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
