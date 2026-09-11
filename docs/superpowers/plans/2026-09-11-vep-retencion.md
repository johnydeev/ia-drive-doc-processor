# VEP de retención — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un VEP de retención (códigos 217/767/353) entre a nombre de la empresa retenida vía una fila `LspService` de tipo `VEP RETENCION`, y que un VEP mixto o de códigos desconocidos vaya a Revisión sin gastar IA.

**Architecture:** Clasificación determinística por regex en `lib/vepExtraction.ts`; el router (`identifyLSPProvider`) suma `VEP_RETENCION` y `VEP_MIXTO`; el pipeline gana un gate `vepMixtoGate` antes de la IA, fija `clientNumber` = CUIT del contribuyente para `VEP_RETENCION` y deja que el fast-path de `LspService` resuelva consorcio + proveedor por la fila. El sync del ALTA resuelve la empresa desde la columna DESCRIPCIÓN cuando PROVEEDOR es `VEP RETENCION`. Sin migración.

**Tech Stack:** TypeScript, Vitest (`.test.ts`, proyecto node), Prisma (sin cambios de schema).

**Spec:** `docs/superpowers/specs/2026-09-11-vep-retencion-design.md`

**Restricciones del repo:** sin commits ni push (los hace el owner), trabajar en `master`, sin ramas. Red de caracterización `src/jobs/processPendingDocuments.job.test.ts` verde antes y después. PowerShell: comandos separados, sin `&&`.

---

## Archivos

| Archivo | Responsabilidad en este plan |
|---|---|
| `src/lib/vepExtraction.ts` | + `VEP_EMPLEADO_CODES`, `VEP_RETENCION_CODES`, `VepKind`, `extractVepConceptCodes`, `classifyVep`, `extractVepContribuyenteCuit` |
| `src/lib/vepExtraction.test.ts` | tests de las 3 funciones |
| `src/lib/extraction.ts` | `LSPProvider` + `VEP_RETENCION` / `VEP_MIXTO`; router; `LSP_FALLBACK_NAMES`; `getPromptForProvider` |
| `src/lib/extraction.test.ts` | router: 4 fixtures |
| `src/jobs/processPendingDocuments.job.ts` | `LSP_ROUTER_TO_CANONICAL`; `vepMixtoGate`; `cleanClientNumberStep`; `resolveAssignment` (skip CUIT + categoría propia); `isVepInvoice`; `consortiumCuitOnly`; `UNASSIGNED_TAG_BY_CATEGORY` |
| `src/jobs/processPendingDocuments.job.test.ts` | 5 tests nuevos en `describe("VEP de retención")` |
| `src/services/directorySync.service.ts` | fila `VEP RETENCION`: proveedor desde DESCRIPCIÓN |
| `src/services/directorySync.service.test.ts` | 2 tests |
| `src/app/admin/obligaciones/lib/availableTargets.ts` | etiqueta `VEP RETENCION · <empresa>` |
| `src/app/admin/obligaciones/lib/availableTargets.test.ts` | 2 tests |
| `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`, `CLAUDE.md`, `scripts/metrics-cuota.sql` | documentación obligatoria |

---

### Task 0: Línea de base

- [ ] Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts` → anotar total (todos verdes).
- [ ] Run: `npx vitest run` → anotar total.

---

### Task 1: Clasificación del VEP (`lib/vepExtraction.ts`)

**Files:** Modify `src/lib/vepExtraction.ts`, Test `src/lib/vepExtraction.test.ts`

- [ ] **Step 1: tests que fallan** — agregar al final de `vepExtraction.test.ts`:

```ts
import { classifyVep, extractVepConceptCodes, extractVepContribuyenteCuit } from "./vepExtraction";

const VEP_SICOSS = `Tipo de Pago: Empleadores SICOSS - Saldo DJ
CUIT: 30-70200241-5
Generado por el Usuario: 27324998573
CONTRIBUCIONES SEG. SOCIAL (351) $896.406,81
EMPLEADOR-APORTES SEG. SOCIAL (301) $686.724,26
SEG.RIESGO DE TRABAJO L 24557 (312) $241.274,85
SEGURO DE VIDA COLECTIVO (28) $849,24
Importe total a pagar $2.188.815,06`;

const VEP_RETENCION = `Tipo de Pago: Vep Consolidado ARCA
CUIT: 30-70200241-5
SICORE-IMPTO.A LAS GANANCIAS (217) $272.940,60
SICORE - RETENCIONES Y PERCEPC (767) $1.439.990,90
RETENCIONES CONTRIB.SEG.SOCIAL (353) $822.851,94
Importe total a pagar $2.535.783,44`;

describe("extractVepConceptCodes", () => {
  it("lee los códigos entre paréntesis de los renglones", () => {
    expect(extractVepConceptCodes(VEP_SICOSS)).toEqual(["351", "301", "312", "28"]);
  });
  it("ignora paréntesis que no son códigos conocidos", () => {
    expect(extractVepConceptCodes("Detalle (ver anexo) (999) (12)")).toEqual([]);
  });
});

describe("classifyVep", () => {
  it("SICOSS puro → EMPLEADO", () => expect(classifyVep(VEP_SICOSS)).toBe("EMPLEADO"));
  it("217/767/353 → RETENCION", () => expect(classifyVep(VEP_RETENCION)).toBe("RETENCION"));
  it("consolidado con sólo ART (312) → EMPLEADO", () => {
    expect(classifyVep("Tipo de Pago: Vep Consolidado ARCA\nSEG.RIESGO DE TRABAJO L 24557 (312) $609.793,62")).toBe("EMPLEADO");
  });
  it("SICOSS + 353 → MIXTO", () => {
    expect(classifyVep(VEP_SICOSS + "\nRETENCIONES CONTRIB.SEG.SOCIAL (353) $1")).toBe("MIXTO");
  });
  it("códigos fuera de ambas listas → DESCONOCIDO", () => {
    expect(classifyVep("INGRESOS BRUTOS (999) $84.861,28")).toBe("DESCONOCIDO");
  });
  it("sin paréntesis legibles → SIN_CODIGOS", () => {
    expect(classifyVep("Tipo de Pago: Empleadores SICOSS\nImporte total a pagar $1")).toBe("SIN_CODIGOS");
  });
});

describe("extractVepContribuyenteCuit", () => {
  it("devuelve el CUIT rotulado 'CUIT:' en dígitos", () => {
    expect(extractVepContribuyenteCuit(VEP_SICOSS)).toBe("30702002415");
  });
  it("no toma el de 'Generado por el Usuario'", () => {
    expect(extractVepContribuyenteCuit("Generado por el Usuario: 27324998573\nCUIT: 30-71001560-7")).toBe("30710015607");
  });
  it("null si no hay rótulo", () => {
    expect(extractVepContribuyenteCuit("Generado por el Usuario: 27324998573")).toBeNull();
  });
  it("null si el CUIT rotulado no pasa el checksum", () => {
    expect(extractVepContribuyenteCuit("CUIT: 30-70200241-9")).toBeNull();
  });
});
```

Nota: `DESCONOCIDO` exige que el `(999)` cuente como código leído. `extractVepConceptCodes` devuelve sólo códigos **conocidos**; para clasificar, `classifyVep` usa un regex crudo de `(\d{2,3})` para saber si hubo *algún* código. Ver Step 3.

- [ ] **Step 2:** Run `npx vitest run src/lib/vepExtraction.test.ts` → FAIL (`classifyVep is not a function`).

- [ ] **Step 3: implementación** — agregar al final de `src/lib/vepExtraction.ts`:

```ts
import { extractCuitsFromText } from "@/lib/cuit";

/** Códigos de impuesto ARCA del encargado: SICOSS, obra social, ART, seguro de vida. */
export const VEP_EMPLEADO_CODES = new Set(["351", "301", "352", "302", "312", "28"]);
/** Retenciones a terceros: SICORE Ganancias, SICORE/SIRE IVA, contrib. seg. social (seguridad/limpieza). */
export const VEP_RETENCION_CODES = new Set(["217", "767", "353"]);

export type VepKind = "EMPLEADO" | "RETENCION" | "MIXTO" | "DESCONOCIDO" | "SIN_CODIGOS";

const CODE_RE = /\((\d{2,3})\)/g;

function rawCodes(text: string): string[] {
  return [...text.matchAll(CODE_RE)].map((m) => m[1]);
}

/** Códigos de impuesto conocidos, en orden de aparición: `... (351)  $896.406,81`. */
export function extractVepConceptCodes(text: string): string[] {
  return rawCodes(text).filter((c) => VEP_EMPLEADO_CODES.has(c) || VEP_RETENCION_CODES.has(c));
}

/**
 * Qué paga el cupón, leído de los códigos de los renglones (0 tokens). Los campos
 * "Tipo de Pago" / "Descripción Reducida" / "Concepto" NO sirven: un "Vep
 * Consolidado" puede ser retenciones o la ART del encargado con los tres iguales.
 */
export function classifyVep(text: string): VepKind {
  const codes = rawCodes(text);
  if (codes.length === 0) return "SIN_CODIGOS";
  const empleado = codes.some((c) => VEP_EMPLEADO_CODES.has(c));
  const retencion = codes.some((c) => VEP_RETENCION_CODES.has(c));
  if (empleado && retencion) return "MIXTO";
  if (retencion) return "RETENCION";
  if (empleado) return "EMPLEADO";
  return "DESCONOCIDO";
}

/**
 * CUIT del contribuyente: el rotulado `CUIT:`. El de la administradora viaja en
 * "Generado por el Usuario" sin la palabra CUIT, así que no lo pisa. Devuelve
 * dígitos, validado por checksum; null si no está o no valida.
 */
export function extractVepContribuyenteCuit(text: string): string | null {
  const m = /CUIT:\s*(\d{2}-?\d{8}-?\d)/i.exec(text);
  if (!m) return null;
  const [cuit] = extractCuitsFromText(m[1]);
  return cuit ? cuit.replace(/\D/g, "") : null;
}
```

Verificar la firma real de `extractCuitsFromText` en `src/lib/cuit.ts` (devuelve array de CUITs válidos; ajustar si devuelve formateados o dígitos — el test exige dígitos).

- [ ] **Step 4:** Run `npx vitest run src/lib/vepExtraction.test.ts` → PASS.

---

### Task 2: Router y prompt (`lib/extraction.ts`)

**Files:** Modify `src/lib/extraction.ts:106-135` (tipo + fallback), `:222-227` (router), `:435` (prompt). Test `src/lib/extraction.test.ts`.

- [ ] **Step 1: tests que fallan** — agregar en `extraction.test.ts` (importar `identifyLSPProvider` si no está):

```ts
describe("identifyLSPProvider — tipos de VEP", () => {
  const head = "VEP\nVolante Electrónico de Pago\nNro. VEP: 1\nOrganismo Recaudador: ARCA\n";
  it("VEP con códigos SICOSS → VEP", () => {
    expect(identifyLSPProvider(head + "CONTRIBUCIONES SEG. SOCIAL (351) $1")).toBe("VEP");
  });
  it("VEP con 217/767/353 → VEP_RETENCION", () => {
    expect(identifyLSPProvider(head + "SICORE - RETENCIONES Y PERCEPC (767) $1")).toBe("VEP_RETENCION");
  });
  it("VEP con SICOSS y 353 → VEP_MIXTO", () => {
    expect(identifyLSPProvider(head + "(351) $1\n(353) $2")).toBe("VEP_MIXTO");
  });
  it("VEP con códigos desconocidos → VEP_MIXTO", () => {
    expect(identifyLSPProvider(head + "INGRESOS BRUTOS (999) $1")).toBe("VEP_MIXTO");
  });
  it("VEP sin códigos legibles → VEP (comportamiento actual)", () => {
    expect(identifyLSPProvider(head + "Importe total a pagar $1")).toBe("VEP");
  });
});
```

- [ ] **Step 2:** Run `npx vitest run src/lib/extraction.test.ts` → FAIL (2 tests: esperan `VEP_RETENCION` / `VEP_MIXTO`).

- [ ] **Step 3: implementación**

`LSPProvider`: agregar `| "VEP_RETENCION" | "VEP_MIXTO"` debajo de `"VEP"`.

`LSP_FALLBACK_NAMES`: agregar `VEP_RETENCION: "VEP RETENCION",`.

Router (reemplaza `if (isVep(upper)) return "VEP";`):

```ts
  if (isVep(upper)) {
    // Los renglones dicen qué paga el cupón (spec 2026-09-11). Retención → fila
    // LspService por CUIT del consorcio; mixto o desconocido → Revisión sin IA.
    const kind = classifyVep(text);
    if (kind === "RETENCION") return "VEP_RETENCION";
    if (kind === "MIXTO" || kind === "DESCONOCIDO") return "VEP_MIXTO";
    return "VEP"; // EMPLEADO o SIN_CODIGOS: como hasta hoy
  }
```

Import: `import { buildVepPrompt, classifyVep } from "@/lib/vepExtraction";`

`getPromptForProvider`: `case "VEP": case "VEP_RETENCION": case "VEP_MIXTO": return buildVepPrompt(relevantText);`

- [ ] **Step 4:** Run `npx vitest run src/lib/extraction.test.ts` → PASS. Run `npm run typecheck` → si algún `switch`/`Record<LSPProvider,…>` exhaustivo se queja, agregar las dos claves ahí.

---

### Task 3: `vepMixtoGate` → Revisión sin IA

**Files:** Modify `src/jobs/processPendingDocuments.job.ts` (nuevo paso + array de `runPipeline`). Test `processPendingDocuments.job.test.ts`.

- [ ] **Step 1: test que falla** — nuevo `describe("VEP de retención", …)` al lado de `describe("VEP de ARCA")`:

```ts
  describe("VEP de retención", () => {
    const VEP_RET_TEXT = `VEP
Volante Electrónico de Pago
Nro. VEP Consolidado: 1651867802
Organismo Recaudador: ARCA
Tipo de Pago: Vep Consolidado ARCA
CUIT: 30-11111111-1
Generado por el Usuario: 27324998573
Día de Expiración: 2026-08-12
SICORE-IMPTO.A LAS GANANCIAS (217) $272.940,60
SICORE - RETENCIONES Y PERCEPC (767) $1.439.990,90
RETENCIONES CONTRIB.SEG.SOCIAL (353) $822.851,94
Importe total a pagar $2.535.783,44`;

    const LIBRES = { id: "libres", canonicalName: "LIBRES SEGURIDAD S.R.L.", cuit: "30-71144782-9", paymentAlias: null };

    function retContext(text = VEP_RET_TEXT, over: Partial<ExtractedDocumentData> = {}) {
      const ctx = makeContext();
      ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(text);
      ctx.providerRepository.findAllForMatching.mockResolvedValue([
        { id: "arca", canonicalName: "ARCA EMPLEADO", cuit: null, matchNames: "ARCA", paymentAlias: null },
        { id: "admin", canonicalName: "MORINIGO RAMONA NATALIA", cuit: "27-32499857-3", matchNames: null, paymentAlias: null },
        { ...LIBRES, matchNames: null },
      ]);
      ctx.aiChain.run.mockImplementation(async (_t: string, cb?: AiAttemptCallback) => {
        cb?.("gemini", true);
        return {
          data: emptyExtraction({
            boletaNumber: "1651867802", provider: "ARCA", providerTaxId: null, amount: 2535783.44,
            dueDate: "2026-08-12", allTaxIds: ["30-11111111-1", "27-32499857-3"], ...over,
          }),
          usage: null, provider: "gemini" as const,
        };
      });
      return ctx;
    }

    it("VEP mixto (encargado + retención) → Revisión [VEP MIXTO] sin llamar a la IA", async () => {
      const ctx = retContext(VEP_RET_TEXT + "\nCONTRIBUCIONES SEG. SOCIAL (351) $1");
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(ctx.aiChain.run).not.toHaveBeenCalled();
      expect(ctx.driveService.renameFile).toHaveBeenCalledWith("file-1", expect.stringContaining("VEP MIXTO"));
      expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "failed");
      expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
      expect(metricsCore().reason).toBe("vep_mixto");
    });

    it("VEP de códigos desconocidos → Revisión [VEP SIN CLASIFICAR]", async () => {
      const ctx = retContext("VEP\nVolante Electrónico de Pago\nNro. VEP: 9\nCUIT: 30-11111111-1\nINGRESOS BRUTOS (999) $84.861,28");

      await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

      expect(ctx.aiChain.run).not.toHaveBeenCalled();
      expect(ctx.driveService.renameFile).toHaveBeenCalledWith("file-1", expect.stringContaining("VEP SIN CLASIFICAR"));
      expect(metricsCore().reason).toBe("vep_desconocido");
    });
  });
```

Comprobar cómo el test `no_period` lee `reason` (`metricsCore().result` vs `.reason`) y ajustar.

- [ ] **Step 2:** Run `npx vitest run src/jobs/processPendingDocuments.job.test.ts -t "VEP de retención"` → FAIL.

- [ ] **Step 3: implementación** — paso nuevo, debajo de `documentTriageGate`:

```ts
/**
 * 4b. VEP que no se puede imputar a un solo proveedor (spec 2026-09-11): mezcla
 * encargado + retención, o trae códigos que no están en ninguna lista (un VEP de
 * IIBB, por ejemplo). Va a Revisión ANTES de la IA: 0 requests, y lo separa una
 * persona. Mismo patrón que `noPeriodGate`.
 */
async function vepMixtoGate(ctx: PipelineContext): Promise<StepResult> {
  if (ctx.lspProvider !== "VEP_MIXTO" || ctx.isDuplicate) return { kind: "continue" };
  const { file, m } = ctx;
  const { resolvedConfig, driveService } = ctx.deps;
  const cid = resolvedConfig.clientId;
  const kind = classifyVep(ctx.docText ?? "");
  const tag = kind === "MIXTO" ? "VEP MIXTO" : "VEP SIN CLASIFICAR";
  m.result = "failed";
  m.reason = kind === "MIXTO" ? "vep_mixto" : "vep_desconocido";
  pipelineLog.stepStart(cid, `⚠️ ${tag} → Revisión (sin IA)`);
  if (resolvedConfig.driveFailedFolderId && ctx.finalSourceFolderId) {
    await ctx.runStep(`Renombrar (${tag})`, () => driveService.renameFile(file.id, `[${tag}] ${file.name}`), "move");
    await ctx.runStep("Mover a Revisión", () => driveService.moveFileToFolder(file.id, ctx.finalSourceFolderId!, resolvedConfig.driveFailedFolderId!), "move");
    pipelineLog.movedToFailed(cid, file.id);
  }
  ctx.summary.failed += 1;
  pipelineLog.fileCompleted(cid, file.name, { processed: 0, unassigned: 0, duplicate: false }, `${tag} → Revisión`);
  return { kind: "halt", result: m.result, reason: m.reason };
}
```

Verificar contra `noPeriodGate` (líneas ~1580-1604) los nombres exactos: `ctx.finalSourceFolderId`, `ctx.summary.failed` (existe? si no, `unassigned`), la forma del `[NO BOLETA - …]` para reusar `appendTag` o el prefijo `[…]`. Usar la misma convención de prefijo que `not_boleta`.

Insertar `vepMixtoGate,` en el array de `runPipeline` **después de `documentTriageGate`** y antes de `aiExtractStep`. Import `classifyVep` de `@/lib/vepExtraction`.

- [ ] **Step 4:** Run el describe → PASS (los 2 primeros). Run la red completa → verde.

---

### Task 4: `clientNumber` = CUIT del contribuyente + detalle

**Files:** Modify `cleanClientNumberStep` (`processPendingDocuments.job.ts:~1253`).

- [ ] **Step 1: test que falla** (dentro de `describe("VEP de retención")`):

```ts
    it("con fila LspService: consorcio y proveedor salen de la fila, no de la administradora", async () => {
      const ctx = retContext(VEP_RET_TEXT, { clientNumber: "1651867802" }); // la IA coló el Nro. VEP
      ctx.lspServiceRepository.findByProviderName.mockImplementation(async (_c: string, name: string, num: string) =>
        name === "VEP RETENCION" && num === "30111111111"
          ? { id: "lsp-ret", consortiumId: "c1", clientNumber: num, providerId: "libres", providerRef: LIBRES,
              consortium: { id: "c1", canonicalName: "THAMES 647", rawName: "CONSORCIO THAMES 647", bank: null, statementsFolderId: null } }
          : null
      );

      await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

      const guardada = ctx.invoiceRepository.saveProcessedInvoice.mock.calls[0][0];
      expect(guardada.consortiumId).toBe("c1");
      expect(guardada.providerId).toBe("libres");
      expect(guardada.lspServiceId).toBe("lsp-ret");
      expect(guardada.extraction.detail).toContain("217");
      expect(ctx.lspServiceRepository.findByProviderName).toHaveBeenCalledWith("client-1", "VEP RETENCION", "30111111111");
    });
```

Ajustar `"client-1"` al `clientId` real de `makeContext`.

- [ ] **Step 2:** Run → FAIL (`findByProviderName` no llamado con ese número: hoy `clientNumber` es "1651803730" o null).

- [ ] **Step 3: implementación** — en `cleanClientNumberStep`, antes del guard existente:

```ts
  // VEP de retención (spec 2026-09-11): el ÚNICO VEP que usa LspService. La clave
  // es el CUIT rotulado del contribuyente, leído del texto — nunca lo que devolvió
  // el modelo (un Nro. VEP colado rebota el cupón por el fast-path terminal).
  if (ctx.lspProvider === "VEP_RETENCION") {
    extracted.clientNumber = extractVepContribuyenteCuit(ctx.docText ?? "");
    const codes = extractVepConceptCodes(ctx.docText ?? "");
    extracted.detail = codes.length ? `Retención · ${codes.join(" · ")}` : "Retención";
    if (!extracted.clientNumber) pipelineLog.stepStart(cid, "⚠️ VEP de retención sin CUIT rotulado — sigue al matching normal");
  }
```

El guard existente (`usesConsortiumCuit`) no incluye `VEP_RETENCION`, así que no lo pisa. Import `extractVepContribuyenteCuit, extractVepConceptCodes`.

- [ ] **Step 4:** Run → puede seguir FAIL por Task 5 (proveedor = admin). Seguir.

---

### Task 5: `resolveAssignment` — skip CUIT, categoría propia, `isVepInvoice`

**Files:** Modify `processPendingDocuments.job.ts:163-180` (`LSP_ROUTER_TO_CANONICAL`), `:324-345` (skip), `:433-441` (no encontrado), `:460` (`consortiumCuitOnly`), `:568` (`isVepInvoice`), `UNASSIGNED_TAG_BY_CATEGORY`.

- [ ] **Step 1: tests que fallan** (mismo describe):

```ts
    it("sin fila LspService → Sin Asignar VEP RETENCION SIN EMPRESA REGISTRADA", async () => {
      const ctx = retContext();
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(ctx.driveService.renameFile).toHaveBeenCalledWith("file-1", expect.stringContaining("VEP RETENCION SIN EMPRESA REGISTRADA"));
      expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "unassigned");
      expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
      expect(metricsCore().reason).toBe("vep_retencion_not_registered");
    });

    it("sin CUIT rotulado no entra al fast-path y termina SIN CONSORCIO", async () => {
      const ctx = retContext(VEP_RET_TEXT.replace("CUIT: 30-11111111-1", ""), { allTaxIds: [] });

      await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

      expect(ctx.lspServiceRepository.findByProviderName).not.toHaveBeenCalled();
      expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "unassigned");
    });
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: implementación**

`LSP_ROUTER_TO_CANONICAL`: agregar `"VEP_RETENCION": "VEP RETENCION",` con comentario `// Palabra fija de la columna PROVEEDOR del ALTA; la empresa sale de providerRef.`

Skip del proveedor por CUIT (línea ~338):
```ts
  // VEP de retención: el proveedor es la EMPRESA de la fila LspService, nunca el
  // dueño de un CUIT del papel (ahí viaja la administradora — ver 2026-09-03 §3.2).
  const providerFromLspRow = lspProvider === "VEP_RETENCION";
  if (lspProvider && !isSindicalLsp && !providerFromLspRow && allTaxIds.length > 0) {
```

No encontrado (línea ~433), reemplazar el `return` por:
```ts
      if (lspProvider === "VEP_RETENCION") {
        return {
          ...base,
          unassigned: true,
          unassignedReason: `VEP de retención: el consorcio ${normalizedClientNumber} no tiene empresa retenida en _LspServices`,
          reasonCategory: "vep_retencion_not_registered",
        };
      }
      pipelineLog.lspClientNumberNotRegistered(...)  // como estaba
```

`consortiumCuitOnly`: `isPlainInvoice || lspProvider === "VEP" || lspProvider === "VEP_RETENCION"`.

`isVepInvoice`: `lspProvider === "VEP" || lspProvider === "VEP_RETENCION"`.

`UNASSIGNED_TAG_BY_CATEGORY`: `vep_retencion_not_registered: "VEP RETENCION SIN EMPRESA REGISTRADA",`.

- [ ] **Step 4:** Run el describe completo → 5 PASS. Red completa → verde.

---

### Task 6: Sync del ALTA — fila `VEP RETENCION`

**Files:** Modify `src/services/directorySync.service.ts:285-300`. Test `directorySync.service.test.ts`.

- [ ] **Step 1: tests que fallan** — copiar la forma del test "crea lo que falta…" (prisma fake con `consortium.findMany` → `[{id:"c1", canonicalName:"CALLAO 1441"}]`, `provider.findMany` → `[{id:"libres", canonicalName:"LIBRES SEGURIDAD S.R.L.", providerType:"PROVEEDOR"}]`, `lspService.findMany` → `[]`):

```ts
  it("fila VEP RETENCION: la empresa sale de DESCRIPCIÓN", async () => {
    // ...prisma fake...
    await syncDirectory(prisma, "cli1", { ...vacio, lspServices: [
      { consortiumName: "CALLAO 1441", provider: "vep retencion", clientNumber: "30702002415", description: "LIBRES SEGURIDAD S.R.L." },
    ]});
    const data = prisma.lspService.createMany.mock.calls[0][0].data;
    expect(data[0]).toMatchObject({ providerName: "VEP RETENCION", clientNumber: "30702002415", providerId: "libres" });
  });

  it("fila VEP RETENCION con empresa desconocida: se crea sin providerId y avisa", async () => {
    const report = await syncDirectory(prisma, "cli1", { ...vacio, lspServices: [
      { consortiumName: "CALLAO 1441", provider: "VEP RETENCION", clientNumber: "30702002415", description: "NO EXISTE SA" },
    ]});
    expect(prisma.lspService.createMany.mock.calls[0][0].data[0].providerId).toBeNull();
    expect(report.warnings.join("\n")).toMatch(/NO EXISTE SA/);
  });
```

Verificar cómo el reporte expone `warnings` (`report.warnings` o `report.lspServices.warnings`).

- [ ] **Step 2:** Run `npx vitest run src/services/directorySync.service.test.ts` → FAIL.

- [ ] **Step 3: implementación** — reemplazar `const provider = providerByName.get(ls.provider.toUpperCase()) ?? null;` por:

```ts
    // VEP RETENCION (spec 2026-09-11): PROVEEDOR es una palabra fija y la EMPRESA
    // retenida viene en DESCRIPCIÓN (razón social exacta de _Proveedores).
    const isVepRetencion = ls.provider.trim().toUpperCase() === VEP_RETENCION_KEYWORD;
    const providerName = isVepRetencion ? VEP_RETENCION_KEYWORD : ls.provider;
    const provider = isVepRetencion
      ? providerByName.get((ls.description ?? "").trim().toUpperCase()) ?? null
      : providerByName.get(ls.provider.toUpperCase()) ?? null;
    if (isVepRetencion && !provider) {
      warnings.push(
        `VEP RETENCION de "${ls.consortiumName}": la empresa "${ls.description ?? ""}" no está en _Proveedores (columna RAZÓN SOCIAL).`
      );
    }
```

y usar `providerName` en el push (`providerName,`). Constante arriba del archivo: `const VEP_RETENCION_KEYWORD = "VEP RETENCION";` (exportarla desde `lib/vepExtraction.ts` y usarla también en `LSP_ROUTER_TO_CANONICAL` para que haya una sola fuente).

El aviso "no está marcado como SERVICIO" no salta para esta fila: `provider.providerType` de Libres es `PROVEEDOR`, así que hay que excluir `isVepRetencion` de esa condición.

- [ ] **Step 4:** Run → PASS.

---

### Task 7: Etiqueta en "Agregar gastos fijos"

**Files:** Modify `src/app/admin/obligaciones/lib/availableTargets.ts`. Test `availableTargets.test.ts`.

- [ ] **Step 1: tests que fallan:**

```ts
  it("una fila VEP RETENCION se etiqueta con la empresa retenida", () => {
    const c = { ...consortium, lspServices: [
      { id: "l3", providerName: "VEP RETENCION", clientNumber: "30702002415", description: null, providerId: "p3" },
    ]};
    expect(availableTargets(c, providers, "").lsp[0].label).toBe("VEP RETENCION · N.G. FUMIGACION");
  });
  it("una fila VEP RETENCION sin empresa muestra el número", () => {
    const c = { ...consortium, lspServices: [
      { id: "l3", providerName: "VEP RETENCION", clientNumber: "30702002415", description: null, providerId: null },
    ]};
    expect(availableTargets(c, providers, "").lsp[0].label).toBe("VEP RETENCION (30702002415)");
  });
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: implementación** — en el `.map` de `lsp`:

```ts
    .map((l) => {
      const empresa = l.providerName === "VEP RETENCION" && l.providerId
        ? providers.find((p) => p.id === l.providerId)?.canonicalName
        : undefined;
      return { kind: "lsp" as const, id: l.id,
               label: empresa ? `${l.providerName} · ${empresa}` : `${l.providerName} (${l.clientNumber})` };
    })
```

- [ ] **Step 4:** Run → PASS.

---

### Task 8: Verificación completa

- [ ] `npm run typecheck`
- [ ] `npx vitest run` → total = base + 22 (10 Task 1, 5 Task 2, 5 Task 3-5, 2 Task 6, 2 Task 7 — ajustar al conteo real)
- [ ] `npm run lint` → sin warnings nuevos (base: 13)
- [ ] `npm run build:jobs`

---

### Task 9: Documentación

- [ ] `docs/progreso.md`: sección "VEP de retención (2026-09-11)": hecho, pendiente del owner (renombre ARCA→ARCA EMPLEADO con UPDATE + fila del ALTA; 2 filas `_LspServices`; tildar gastos fijos en Callao y Pueyrredón; corregir a la administración que el VEP de retención lleva el CUIT del consorcio).
- [ ] `docs/decisiones.md`: entrada con Problema / Decisión (LspService con CUIT como número de cliente, códigos de renglón como único clasificador, mixto/desconocido a Revisión) / Alternativas / Impacto.
- [ ] `CHANGELOG.md`: highlights del día.
- [ ] `CLAUDE.md`: en el router, `VEP_RETENCION` y `VEP_MIXTO`; en `_LspServices`, la fila `VEP RETENCION` (columna D = razón social); nota de que `usesConsortiumCuit` NO incluye `VEP_RETENCION`.
- [ ] `scripts/metrics-cuota.sql`: consulta 6 — VEP por categoría (`vep_mixto`, `vep_desconocido`, `vep_retencion_not_registered`) y boletas con `lspServiceId` de filas `VEP RETENCION`.
- [ ] Avisar "listo para commitear" y frenar.
