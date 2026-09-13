# Liquidación de retenciones — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el paquete de liquidación de retenciones (planilla + certificados + VEP) produzca una boleta por la retención a nombre de la empresa, sin IA; que el VEP de retención suelto y el certificado suelto no generen boletas; y retirar la plomería `LspService` de retenciones de ayer.

**Architecture:** Parser determinístico `lib/liqRetencion.ts` sobre el texto de pdf-parse; router `LIQ_RETENCION` evaluado antes del VEP; paso `liqRetencionExtractStep` que llena `ctx.extracted` y hace que `aiExtractStep` se saltee; `vepMixtoGate` → `vepReviewGate` cubre también `VEP_RETENCION`; capa 0 del triage vuelve a tener un caso (certificado suelto). Sin migración.

**Tech Stack:** TypeScript, Vitest `.test.ts` (proyecto node).

**Spec:** `docs/superpowers/specs/2026-09-12-liquidacion-retenciones-design.md`

**Restricciones:** sin commits ni push (owner), `master`, sin ramas. Red de caracterización verde antes y después. Sin `&&` en PowerShell.

---

## Archivos

| Archivo | Cambio |
|---|---|
| `src/lib/liqRetencion.ts` (nuevo) | `parseLiqRetencion`, `toExtractedDocument`, `isLiqRetencionText` |
| `src/lib/liqRetencion.test.ts` (nuevo) | fixtures de los 4 paquetes |
| `src/lib/vepExtraction.ts` | `VEP_RETENCION_CODES` + `"216"`; quitar `VEP_RETENCION_KEYWORD` |
| `src/lib/vepExtraction.test.ts` | test del 216 |
| `src/lib/extraction.ts` | `LSPProvider` + `LIQ_RETENCION`; router antes de `isVep`; quitar `LSP_FALLBACK_NAMES.VEP_RETENCION`; `getPromptForProvider` |
| `src/lib/extraction.test.ts` | router: 4 paquetes → `LIQ_RETENCION` |
| `src/lib/documentClassifier.ts` | `NotBoletaKind = "CERTIFICADO RETENCION"`; `detectDecisiveNotBoleta` |
| `src/lib/documentClassifier.test.ts` | certificado suelto |
| `src/jobs/processPendingDocuments.job.ts` | `textExtractStep` (texto completo), `documentTriageGate` (guard), `vepReviewGate`, `liqRetencionExtractStep`, guard en `aiExtractStep`, `consortiumCuitOnly`, retiro de `VEP_RETENCION` en `cleanClientNumberStep` / `resolveAssignment` / mapas |
| `src/jobs/processPendingDocuments.job.test.ts` | reescribir `describe("VEP de retención")` |
| `src/services/directorySync.service.ts` + test | retirar rama `VEP RETENCION` |
| `src/app/admin/obligaciones/lib/availableTargets.ts` + test | retirar etiqueta |
| docs | progreso, decisiones, CHANGELOG, CLAUDE.md, metrics-cuota.sql |

---

### Task 0: Línea de base

- [ ] `npx vitest run` → anotar total (esperado 954 verdes).

---

### Task 1: Parser `lib/liqRetencion.ts`

**Files:** Create `src/lib/liqRetencion.ts`, `src/lib/liqRetencion.test.ts`.

- [ ] **Step 1: tests que fallan.** Fixture = texto pdf-parse real (líneas exactas del extractor):

```ts
import { describe, expect, it } from "vitest";
import { isLiqRetencionText, parseLiqRetencion, toExtractedDocument } from "./liqRetencion";

export const MAYORAL = `CONSORCIO DE PROPIETARIOS BOEDO 414 - C.A.B.A.
C.U.I.T. N* 30-54675623-4
PAGO CORRESPONDIENTE AL MES DE SEPTIEMBRE 2026
NOMBRE DEL PROVEEDOR: MAYORAL SEGURIDAD S.R.L.
C.U.I.T. N* 30-71530019-9
FACTURA B N*: 00001-00001848
FECHA: 31/08/2026
IMPORTE TOTAL: 7.404.713,01
RETENCION:
IVA 642.557,74
s/fra. 0001-00001848
GANANCIAS 121.048,55
s/fra. 0001-00001848
SEGURIDAD SOCIAL 367.175,85
s/fra. 0001-00001848
SUBTOTAL RETENCIONES 1.130.782,14
IMPORTE NETO 6.273.930,87
SE ADJUNTA COMPROBANTES DE RETENCIONES EFECTUADAS.

-- 1 of 5 --

SI.CO.RE. - Sistema de Control
de Retenciones
A. - Datos del Agente de Retención
B. - Datos del Sujeto Retenido
30-54675623-4
30-71530019-9 Nº

-- 5 of 5 --

VEP
Volante Electrónico de Pago
Nro. VEP Consolidado: 1679299135
Organismo Recaudador: ARCA
Tipo de Pago: Vep Consolidado ARCA
CUIT: 30-54675623-4
Generado por el Usuario: 27324998573
Cantidad de SubVeps: 3
Día de Expiración: 2026-10-10
SICORE-IMPTO.A LAS GANANCIAS (217) $121.048,55
SIRE - IVA (216) $642.557,74
RETENCIONES CONTRIB.SEG.SOCIAL (353) $367.175,85
Importe total a pagar $1.130.782,14`;

const DOGO = `CONSORCIO DE PROPIETARIOS Av. PUEYRREDON 2418/22 - C.A.B.A.
C.U.I.T. N* 30-71001560-7
PAGO CORRESPONDIENTE AL MES DE SEPTIEMBRE 2026
NOMBRE DEL PROVEEDOR: COOP.TRAB.SEG y VIGILANCIA DOGO ARG.LTDA.
C.U.I.T. N* 30-66293417-4
FACTURA B N*: 0002-00007196
FECHA: 03/09/2026
IMPORTE TOTAL: 8.197.317,85
RETENCION:
IVA 711.337,50
s/fra. 0002-00007196
SUBTOTAL RETENCIONES 711.337,50
IMPORTE NETO 7.485.980,35
SE ADJUNTA COMPROBANTES DE RETENCIONES EFECTUADAS.
VEP
Volante Electrónico de Pago
Nro. VEP: 1679256980
Tipo de Pago: Retenciones IVA - Pago a cuenta
CUIT: 30-71001560-7
Generado por el Usuario: 27324998573
Día de Expiración: 2026-10-10
SICORE - RETENCIONES Y PERCEPC (767) $711.337,50
Importe total a pagar $711.337,50`;

describe("isLiqRetencionText", () => {
  it("reconoce la planilla por sus tres marcadores", () => {
    expect(isLiqRetencionText(MAYORAL.toUpperCase())).toBe(true);
  });
  it("una factura con la palabra retención en el detalle no es planilla", () => {
    expect(isLiqRetencionText("FACTURA B\nIMPORTE TOTAL 1.000,00\nDETALLE: GASTOS Y RETENCIONES")).toBe(false);
  });
});

describe("parseLiqRetencion", () => {
  it("lee el paquete de 5 páginas (Mayoral)", () => {
    const liq = parseLiqRetencion(MAYORAL)!;
    expect(liq).toMatchObject({
      consortiumCuit: "30546756234",
      providerName: "MAYORAL SEGURIDAD S.R.L.",
      providerCuit: "30715300199",
      invoiceNumber: "00001-00001848",
      invoiceTotal: 7404713.01,
      subtotal: 1130782.14,
      vepNumber: "1679299135",
      expiresOn: "2026-10-10",
    });
    expect(liq.lines).toEqual([
      { label: "IVA", amount: 642557.74 },
      { label: "GANANCIAS", amount: 121048.55 },
      { label: "SEGURIDAD SOCIAL", amount: 367175.85 },
    ]);
  });

  it("lee el paquete de 3 páginas (Dogo, Nro. VEP sin 'Consolidado')", () => {
    const liq = parseLiqRetencion(DOGO)!;
    expect(liq.providerCuit).toBe("30662934174");
    expect(liq.subtotal).toBe(711337.5);
    expect(liq.vepNumber).toBe("1679256980");
    expect(liq.lines).toEqual([{ label: "IVA", amount: 711337.5 }]);
  });

  it("null sin subtotal", () => {
    expect(parseLiqRetencion(MAYORAL.replace("SUBTOTAL RETENCIONES 1.130.782,14\n", ""))).toBeNull();
  });

  it("null si el CUIT de la empresa no pasa checksum", () => {
    expect(parseLiqRetencion(MAYORAL.replace("30-71530019-9", "30-71530019-1"))).toBeNull();
  });
});

describe("toExtractedDocument", () => {
  const doc = toExtractedDocument(parseLiqRetencion(MAYORAL)!);

  it("sólo dos CUIT: consorcio y empresa (nunca la administradora)", () => {
    expect(doc.allTaxIds).toEqual(["30-54675623-4", "30-71530019-9"]);
  });
  it("monto = subtotal de retenciones, no el total de la factura", () => {
    expect(doc.amount).toBe(1130782.14);
  });
  it("nro. de boleta = Nro. VEP, vencimiento = expiración", () => {
    expect(doc.boletaNumber).toBe("1679299135");
    expect(doc.dueDate).toBe("2026-10-10");
  });
  it("sin VEP legible usa RET-<factura>", () => {
    const sinVep = toExtractedDocument(parseLiqRetencion(MAYORAL.replace("Nro. VEP Consolidado: 1679299135\n", ""))!);
    expect(sinVep.boletaNumber).toBe("RET-00001-00001848");
  });
  it("detalle con factura y desglose", () => {
    expect(doc.detail).toBe("Retenciones s/fra. 00001-00001848 · IVA 642.557,74 · GANANCIAS 121.048,55 · SEGURIDAD SOCIAL 367.175,85");
    expect(doc.provider).toBe("MAYORAL SEGURIDAD S.R.L.");
    expect(doc.providerTaxId).toBe("30-71530019-9");
    expect(doc.consortium).toBeNull();
    expect(doc.clientNumber).toBeNull();
    expect(doc.isBoleta).toBe(true);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/lib/liqRetencion.test.ts` → FAIL (módulo no existe).

- [ ] **Step 3: implementación** `src/lib/liqRetencion.ts`:

```ts
/**
 * Liquidación de retenciones (spec 2026-09-12): el paquete que arma la
 * administración cuando el consorcio le retiene a su empresa de seguridad o
 * limpieza — planilla propia + certificados SICORE/F.2004/F.2005 + VEP
 * consolidado. NO es la factura (esa se sube aparte): la boleta que sale de acá
 * es la RETENCIÓN, a nombre de la empresa, y el nro. es el del VEP.
 *
 * Todo por regex: la planilla es un formato fijo y pdf-parse la devuelve una
 * línea por campo con el monto al lado.
 */
import { extractCuitsFromText, formatCuit } from "@/lib/cuit";
import { normalizeBusinessAmount } from "@/lib/businessKey";
import type { ExtractedDocumentData } from "@/types/extractedDocument.types";

const MARKERS = ["SUBTOTAL RETENCIONES", "IMPORTE NETO", "NOMBRE DEL PROVEEDOR"];

/** Recibe el texto ya en mayúsculas (el router trabaja así). */
export function isLiqRetencionText(upper: string): boolean {
  return MARKERS.every((m) => upper.includes(m));
}

export interface LiqRetencion {
  consortiumCuit: string;
  providerName: string | null;
  providerCuit: string;
  invoiceNumber: string | null;
  invoiceTotal: number | null;
  lines: Array<{ label: string; amount: number }>;
  subtotal: number;
  vepNumber: string | null;
  expiresOn: string | null;
}

const AMOUNT = String.raw`\$?\s*([\d.]+,\d{2})`;

function amount(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = normalizeBusinessAmount(raw);
  return n ? Number(n) : null;
}

function first(text: string, re: RegExp): string | undefined {
  return re.exec(text)?.[1]?.trim();
}

export function parseLiqRetencion(text: string): LiqRetencion | null {
  // Los dos CUIT de la planilla, en orden: consorcio, empresa. Se validan con checksum.
  const cuitLines = [...text.matchAll(/C\.U\.I\.T\.\s*N[*°º]?\s*([\d-]{11,13})/gi)].map((m) => m[1]);
  const consortiumCuit = extractCuitsFromText(cuitLines[0] ?? "")[0];
  const providerCuit = extractCuitsFromText(cuitLines[1] ?? "")[0];
  const subtotal = amount(first(text, new RegExp(String.raw`SUBTOTAL RETENCIONES\s*${AMOUNT}`, "i")));
  if (!consortiumCuit || !providerCuit || subtotal === null) return null;

  const lines: LiqRetencion["lines"] = [];
  const block = text.slice(text.search(/RETENCION:/i), text.search(/SUBTOTAL RETENCIONES/i));
  for (const m of block.matchAll(new RegExp(String.raw`^(IVA|GANANCIAS|SEGURIDAD SOCIAL)\s+${AMOUNT}\s*$`, "gim"))) {
    const a = amount(m[2]);
    if (a !== null) lines.push({ label: m[1].toUpperCase(), amount: a });
  }

  return {
    consortiumCuit,
    providerName: first(text, /NOMBRE DEL PROVEEDOR:\s*(.+)$/im) ?? null,
    providerCuit,
    invoiceNumber: first(text, /FACTURA\s+[A-C]?\s*N[*°º]?:\s*([\d-]+)/i) ?? null,
    invoiceTotal: amount(first(text, new RegExp(String.raw`IMPORTE TOTAL:\s*${AMOUNT}`, "i"))),
    lines,
    subtotal,
    vepNumber: first(text, /Nro\.\s*VEP(?:\s+Consolidado)?:\s*(\d+)/i) ?? null,
    expiresOn: first(text, /D[ií]a de Expiraci[oó]n:\s*(\d{4}-\d{2}-\d{2})/i) ?? null,
  };
}

const fmt = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function toExtractedDocument(liq: LiqRetencion): ExtractedDocumentData {
  const desglose = liq.lines.map((l) => `${l.label} ${fmt.format(l.amount)}`).join(" · ");
  return {
    boletaNumber: liq.vepNumber ?? (liq.invoiceNumber ? `RET-${liq.invoiceNumber}` : null),
    provider: liq.providerName,
    consortium: null,
    providerTaxId: formatCuit(liq.providerCuit),
    detail: `Retenciones s/fra. ${liq.invoiceNumber ?? "?"}${desglose ? ` · ${desglose}` : ""}`,
    observation:
      liq.invoiceTotal !== null
        ? `Factura ${liq.invoiceNumber ?? "?"} $${fmt.format(liq.invoiceTotal)} · neto $${fmt.format(liq.invoiceTotal - liq.subtotal)}`
        : null,
    dueDate: liq.expiresOn,
    amount: liq.subtotal,
    alias: null,
    clientNumber: null,
    paymentMethod: null,
    // Sólo estos dos. El CUIT de la administradora está en el VEP y no debe entrar.
    allTaxIds: [formatCuit(liq.consortiumCuit)!, formatCuit(liq.providerCuit)!],
    isBoleta: true,
  };
}
```

Ojo `normalizeBusinessAmount("1.130.782,14")` → `"1130782.14"`; verificar en el test. Si el regex del bloque no encuentra `RETENCION:`, `search` devuelve -1 y `slice(-1, …)` daría basura: proteger con `const start = text.search(/RETENCION:/i); const block = start >= 0 ? text.slice(start, …) : "";`.

- [ ] **Step 4:** Run → PASS.

---

### Task 2: Router, códigos y prompt

**Files:** `src/lib/extraction.ts`, `src/lib/vepExtraction.ts`, tests.

- [ ] **Step 1: tests que fallan.**

`src/lib/vepExtraction.test.ts`, en `describe("classifyVep")`:
```ts
  it("216 (SIRE IVA) también es retención", () => {
    expect(classifyVep("SIRE - IVA (216) $642.557,74")).toBe("RETENCION");
  });
```

`src/lib/extraction.test.ts` (importar `MAYORAL` desde `./liqRetencion.test`):
```ts
describe("identifyLSPProvider — liquidación de retenciones (spec 2026-09-12)", () => {
  it("el paquete completo es LIQ_RETENCION aunque termine en un VEP", () => {
    expect(identifyLSPProvider(MAYORAL)).toBe("LIQ_RETENCION");
  });
  it("una factura con 'retenciones' en el detalle sigue siendo factura común", () => {
    expect(identifyLSPProvider("FACTURA B\nIMPORTE TOTAL 1.000,00\nGASTOS Y RETENCIONES FOJAS")).toBeNull();
  });
  it("el VEP de retención suelto sigue siendo VEP_RETENCION", () => {
    expect(identifyLSPProvider("VEP\nVolante Electrónico de Pago\nNro. VEP: 1\n(216) $1")).toBe("VEP_RETENCION");
  });
});
```

- [ ] **Step 2:** Run ambos → FAIL.

- [ ] **Step 3: implementación.**

`vepExtraction.ts`: `VEP_RETENCION_CODES = new Set(["217", "767", "216", "353"])`; borrar `VEP_RETENCION_KEYWORD`.

`extraction.ts`:
- `LSPProvider`: agregar `| "LIQ_RETENCION"` debajo de `"VEP_MIXTO"`.
- Borrar `VEP_RETENCION: "VEP RETENCION",` de `LSP_FALLBACK_NAMES`.
- Import: `import { isLiqRetencionText } from "@/lib/liqRetencion";`
- Router, **antes** del bloque LSD (que es el primero): 
```ts
  // ── Liquidación de retenciones (spec 2026-09-12) ─────────────────────────
  // Paquete de la administración: planilla + certificados + VEP. Va PRIMERO
  // porque termina en un VEP y contiene certificados; todo lo demás lo confundiría.
  if (isLiqRetencionText(upper)) return "LIQ_RETENCION";
```
  Verificar que `upper` en ese punto sea el texto **completo** en mayúsculas (si el router recorta a 4000 chars, alcanza: los 3 marcadores están en la página 1).
- `getPromptForProvider`: `case "LIQ_RETENCION":` junto a los VEP → `buildVepPrompt` (sólo se llega si el parser falló; el VEP prompt es el menos malo). Quitar `case "VEP_RETENCION"` NO — sigue existiendo el tipo; dejarlo.

- [ ] **Step 4:** Run → PASS. `npm run typecheck` → `VEP_RETENCION_KEYWORD` rompe en `processPendingDocuments.job.ts` y `directorySync.service.ts`; se arregla en Tasks 4 y 5.

---

### Task 3: Certificado suelto → capa 0

**Files:** `src/lib/documentClassifier.ts`, `src/lib/documentClassifier.test.ts`.

- [ ] **Step 1: test que falla** (agregar al test existente):
```ts
describe("detectDecisiveNotBoleta — certificado de retención suelto (2026-09-12)", () => {
  const F2004 = `CERTIFICADO DE RETENCIÓN/PERCEPCIÓN de la SEGURIDAD SOCIAL
F.2004
A - Datos del Agente de Retención/Percepción CONS DE PROP BOEDO 414
CUIT Nº 30546756234
B - Datos del Sujeto Retenido/Percibido MAYORAL SEGURIDAD S.R.L.
Monto de la Retención/Percepción 367175.85`;
  it("un certificado solo no es boleta", () => {
    expect(detectDecisiveNotBoleta(F2004)).toBe("CERTIFICADO RETENCION");
  });
  it("una factura común no dispara", () => {
    expect(detectDecisiveNotBoleta("FACTURA B\nIMPORTE TOTAL 1.000,00")).toBeNull();
  });
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3:**
```ts
export type NotBoletaKind = "CERTIFICADO RETENCION";

export function detectDecisiveNotBoleta(text: string): NotBoletaKind | null {
  const upper = text.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Certificado de retención/percepción (SICORE, F.2004, F.2005) sin la planilla
  // de la administración: no hay nada que pagar. El paquete completo NO pasa por
  // acá: el router lo marca LIQ_RETENCION y el gate lo saltea.
  if (upper.includes("DATOS DEL AGENTE DE RETENCI") && upper.includes("DATOS DEL SUJETO RETENIDO")) {
    return "CERTIFICADO RETENCION";
  }
  return null;
}
```
Actualizar el docstring (ya no está vacía).

- [ ] **Step 4:** Run → PASS.

---

### Task 4: Pipeline

**Files:** `src/jobs/processPendingDocuments.job.ts`, `src/jobs/processPendingDocuments.job.test.ts`.

- [ ] **Step 1: tests.** Reemplazar todo el `describe("VEP de retención", …)` por:

```ts
  describe("VEP de retención suelto (spec 2026-09-12)", () => {
    const VEP_RET_TEXT = `VEP
Volante Electrónico de Pago
Nro. VEP Consolidado: 1651867802
Organismo Recaudador: ARCA
CUIT: 30-70200241-5
Generado por el Usuario: 27324998573
SICORE-IMPTO.A LAS GANANCIAS (217) $272.940,60
RETENCIONES CONTRIB.SEG.SOCIAL (353) $822.851,94
Importe total a pagar $1.095.792,54`;

    it("va a Revisión pidiendo el paquete completo, sin IA", async () => {
      const ctx = makeContext();
      ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(VEP_RET_TEXT);
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(ctx.aiChain.run).not.toHaveBeenCalled();
      expect(ctx.driveService.renameFile).toHaveBeenCalledWith("file-1", expect.stringContaining("VEP RETENCION SUELTO"));
      expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "failed");
      expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
      expect(summary.failed).toBe(1);
      expect(metricsCore().reason).toBe("vep_retencion_suelto");
    });
  });

  describe("liquidación de retenciones (spec 2026-09-12)", () => {
    const MAYORAL = { id: "mayoral", canonicalName: "MAYORAL SEGURIDAD S.R.L", cuit: "30-71530019-9", matchNames: null, paymentAlias: null };
    const ADMIN = { id: "admin", canonicalName: "MORINIGO RAMONA NATALIA", cuit: "27-32499857-3", matchNames: null, paymentAlias: null };

    function liqContext(text = LIQ_MAYORAL, providers = [MAYORAL, ADMIN]) {
      const ctx = makeContext();
      ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(text);
      ctx.consortiumRepository.findAllForMatching.mockResolvedValue([
        { id: "boedo", canonicalName: "BOEDO 414", rawName: "CONSORCIO BOEDO 414", cuit: "30-54675623-4", matchNames: null },
      ]);
      ctx.consortiumRepository.findByCanonicalName.mockResolvedValue({
        id: "boedo", canonicalName: "BOEDO 414", rawName: "CONSORCIO BOEDO 414", cuit: "30-54675623-4", bank: null, statementsFolderId: null,
      });
      ctx.providerRepository.findAllForMatching.mockResolvedValue(providers);
      return ctx;
    }

    it("entra sin IA: consorcio y empresa por CUIT, monto = retención, nro = VEP", async () => {
      const ctx = liqContext();
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(ctx.aiChain.run).not.toHaveBeenCalled();
      const guardada = ctx.invoiceRepository.saveProcessedInvoice.mock.calls[0][0];
      expect(guardada.consortiumId).toBe("boedo");
      expect(guardada.providerId).toBe("mayoral");
      expect(guardada.providerId).not.toBe("admin");
      expect(guardada.extraction.amount).toBe(1130782.14);
      expect(guardada.extraction.boletaNumber).toBe("1679299135");
      expect(guardada.extraction.dueDate).toBe("2026-10-10");
      expect(summary.processed).toBe(1);
      expect(metricsCore().result).toBe("ok");
    });

    it("empresa no registrada → Sin Asignar PROVEEDOR SIN REGISTRAR, sin Vision", async () => {
      const ctx = liqContext(LIQ_MAYORAL, [ADMIN]);

      await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

      expect(ctx.aiChain.run).not.toHaveBeenCalled();
      expect(ctx.driveService.renameFile).toHaveBeenCalledWith("file-1", expect.stringContaining("PROVEEDOR SIN REGISTRAR"));
      expect(ctx.driveService.moveFileToUnassigned).toHaveBeenCalledWith("file-1", "pending", "unassigned");
      expect(metricsCore().reason).toBe("provider_not_registered");
    });

    it("planilla no parseable (sin subtotal) → sigue a la IA como hasta hoy", async () => {
      const ctx = liqContext(LIQ_MAYORAL.replace("SUBTOTAL RETENCIONES 1.130.782,14\n", ""));

      await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

      expect(ctx.aiChain.run).toHaveBeenCalledTimes(1);
    });

    it("certificado suelto → [NO BOLETA - CERTIFICADO RETENCION] sin IA", async () => {
      const ctx = liqContext(`CERTIFICADO DE RETENCIÓN/PERCEPCIÓN de la SEGURIDAD SOCIAL
A - Datos del Agente de Retención/Percepción CONS DE PROP BOEDO 414
B - Datos del Sujeto Retenido/Percibido MAYORAL SEGURIDAD S.R.L.
Monto de la Retención/Percepción 367175.85`);
      const summary = createBaseSummary(1);

      await processDriveFile(makeFile(), asContext(ctx), summary);

      expect(ctx.aiChain.run).not.toHaveBeenCalled();
      expect(ctx.driveService.renameFile).toHaveBeenCalledWith("file-1", expect.stringContaining("NO BOLETA - CERTIFICADO RETENCION"));
      expect(ctx.driveService.moveFileToUnassigned).toHaveBeenCalledWith("file-1", "pending", "unassigned");
      expect(summary.notBoleta).toBe(1);
    });
  });
```

`LIQ_MAYORAL` = la constante `MAYORAL` importada desde `@/lib/liqRetencion.test` (renombrar en el import: `import { MAYORAL as LIQ_MAYORAL } from "@/lib/liqRetencion.test";`). Ojo: en el paquete no parseable, la planilla sin subtotal **sigue teniendo los 3 marcadores**? No: `SUBTOTAL RETENCIONES` es uno de ellos → el router da `null` → factura común → IA. Sirve igual como test del camino "no LIQ".

Además: el test viejo `"con fila LspService…"` y `"sin fila LspService…"` se borran (el camino no existe más).

- [ ] **Step 2:** Run el archivo → FAIL en los nuevos.

- [ ] **Step 3: implementación** en `processPendingDocuments.job.ts`:

a) Import: quitar `VEP_RETENCION_KEYWORD` y `extractVepContribuyenteCuit`, `extractVepConceptCodes` (si quedan sin uso); agregar `import { parseLiqRetencion, toExtractedDocument } from "@/lib/liqRetencion";`.

b) `LSP_ROUTER_TO_CANONICAL`: borrar la entrada `"VEP_RETENCION"`.

c) `textExtractStep`: 
```ts
  // Liquidación de retenciones: el Nro. VEP y el vencimiento están en la última
  // página → texto completo (spec 2026-09-12). ARCA F931: el total está en la pág. 2.
  const lspMaxPages = lspProvider === "ARCA" ? 2 : 1;
  const text =
    lspProvider === "LIQ_RETENCION" ? fullText
    : lspProvider ? await runStep("Re-extracción LSP (página 1+)", () => pdfExtractor.extractTextFromPdf(buffer, lspMaxPages), "textPage1")
    : fullText;
```

d) `documentTriageGate`: antes de la capa 0:
```ts
  // El paquete de retenciones conserva el texto de sus certificados: la capa 0
  // los tomaría por certificados sueltos. El router ya lo identificó.
  if (ctx.lspProvider === "LIQ_RETENCION") return { kind: "continue" };
```

e) `vepMixtoGate` → renombrar `vepReviewGate`:
```ts
async function vepReviewGate(ctx: PipelineContext): Promise<StepResult> {
  const lp = ctx.lspProvider;
  if ((lp !== "VEP_MIXTO" && lp !== "VEP_RETENCION") || ctx.isDuplicate) return { kind: "continue" };
  …
  const kind = classifyVep(ctx.docText ?? "");
  const [tag, reason] =
    lp === "VEP_RETENCION" ? ["VEP RETENCION SUELTO - SUBIR LIQUIDACION COMPLETA", "vep_retencion_suelto"]
    : kind === "MIXTO" ? ["VEP MIXTO", "vep_mixto"]
    : ["VEP SIN CLASIFICAR", "vep_desconocido"];
  m.result = "failed";
  m.reason = reason;
  … (resto igual)
```
Actualizar el docstring: "VEP que no se puede imputar: mixto, desconocido, o de retención suelto (la empresa no está en el papel; hay que subir la liquidación completa)". Reemplazar en el array de `runPipeline`.

f) Paso nuevo, debajo de `vepReviewGate`:
```ts
/**
 * 3.7 Liquidación de retenciones (spec 2026-09-12): la planilla de la
 * administración es un formato fijo, así que la boleta sale por regex, sin IA.
 * Llena `ctx.extracted`; `aiExtractStep` se saltea si ya está lleno.
 */
async function liqRetencionExtractStep(ctx: PipelineContext): Promise<StepResult> {
  if (ctx.lspProvider !== "LIQ_RETENCION" || ctx.existingByHash?.extraction) return { kind: "continue" };
  const cid = ctx.deps.resolvedConfig.clientId;
  const liq = parseLiqRetencion(ctx.docText ?? "");
  if (!liq) {
    pipelineLog.stepStart(cid, "⚠️ LIQ RETENCION no parseable → sigue a la cadena de IA");
    return { kind: "continue" };
  }
  const extracted = toExtractedDocument(liq);
  pipelineLog.stepStart(cid, `📋 Liquidación de retenciones: ${liq.providerName ?? liq.providerCuit} s/fra. ${liq.invoiceNumber ?? "?"} — $${liq.subtotal} (0 requests)`);
  const m = ctx.m;
  m.lsp = "LIQ_RETENCION";
  m.ai = { provider: "deterministic", model: null, ok: true, in: null, out: null, total: null };
  m.extracted = {
    consortium: null, provider: extracted.provider, taxId: extracted.providerTaxId,
    boleta: extracted.boletaNumber, due: extracted.dueDate, amount: extracted.amount, clientNumber: null,
  };
  ctx.extracted = extracted;
  ctx.fileAiUsage = null;
  ctx.extractionWasCached = false;
  return { kind: "continue" };
}
```
Verificar los tipos de `m.ai` / `m.lsp` / `m.extracted` en `pipeline/context.ts` y ajustar.

g) `aiExtractStep`, primera línea del cuerpo:
```ts
  // Ya extraído sin IA (liquidación de retenciones): nada que hacer.
  if (ctx.extracted) return { kind: "continue" };
```

h) `cleanClientNumberStep`: borrar el bloque `if (ctx.lspProvider === "VEP_RETENCION") {…}`.

i) `resolveAssignment`: borrar `providerFromLspRow` y su uso en el `if`; borrar la rama `if (providerFromLspRow) { … vep_retencion_not_registered … }`; `consortiumCuitOnly = isPlainInvoice || lspProvider === "VEP" || lspProvider === "VEP_RETENCION" || lspProvider === "LIQ_RETENCION"`; `isVepInvoice` queda como está (`VEP || VEP_RETENCION`; `VEP_RETENCION` ya no llega, pero es inofensivo — simplificar a `=== "VEP"`).

j) `UNASSIGNED_TAG_BY_CATEGORY`: borrar `vep_retencion_not_registered`.

k) Array de `runPipeline`: `documentTriageGate, vepReviewGate, liqRetencionExtractStep, aiExtractStep, …`.

- [ ] **Step 4:** Run el archivo → verde. Red completa verde.

---

### Task 5: Retirar la plomería del sync y del modal

**Files:** `src/services/directorySync.service.ts` + test, `src/app/admin/obligaciones/lib/availableTargets.ts` + test.

- [ ] **Step 1:** Borrar los 2 tests `fila VEP RETENCION…` y `prismaConEmpresa` de `directorySync.service.test.ts`; borrar el `describe("availableTargets — fila VEP RETENCION…")` de `availableTargets.test.ts`.
- [ ] **Step 2:** `directorySync.service.ts`: quitar el import de `VEP_RETENCION_KEYWORD`; restaurar:
```ts
    const provider = providerByName.get(ls.provider.toUpperCase()) ?? null;

    // El tipo no condiciona el vínculo con la boleta (eso lo resuelve el pipeline
    // por número de cliente), así que esto avisa y sigue: bloquear dejaría
    // servicios sin cargar por un dato de catalogación.
    if (provider && provider.providerType !== "SERVICIO") {
```
y `providerName: ls.provider,` en el push.
- [ ] **Step 3:** `availableTargets.ts`: restaurar `.map((l) => ({ kind: "lsp" as const, id: l.id, label: \`${l.providerName} (${l.clientNumber})\` }))`.
- [ ] **Step 4:** `npx vitest run src/services/directorySync.service.test.ts src/app/admin/obligaciones/lib/availableTargets.test.ts` → verde.

---

### Task 6: Verificación completa

- [ ] `npm run typecheck`
- [ ] `npx vitest run` → verde (esperado ≈ 954 − 7 retirados + 24 nuevos)
- [ ] `npm run lint` → 13 warnings (los preexistentes)
- [ ] `npm run build:jobs`

---

### Task 7: Documentación

- [ ] `docs/progreso.md`: sección nueva "Liquidación de retenciones (2026-09-12)" con: hallazgo (10 boletas fantasma, lista), qué se hizo, qué se retiró de ayer, pendiente del owner (limpieza de las 10; borrar filas `VEP RETENCION` del ALTA si las creó). Ajustar la sección de ayer: marcar §3.5/3.6/4.2/4.3 como retirados.
- [ ] `docs/decisiones.md`: entrada 2026-09-12 (problema con la evidencia de la base; decisión: paquete determinístico, VEP suelto a Revisión, certificado no-boleta; alternativas; impacto).
- [ ] `CHANGELOG.md`: entrada.
- [ ] `CLAUDE.md`: router (`LIQ_RETENCION`), flujo 3b (gate renombrado + certificado en capa 0, que deja de estar "vacía"), quitar la fila `VEP RETENCION` de `_LspServices` y la etiqueta `VEP RETENCION SIN EMPRESA REGISTRADA`; pipeline paso 3c "extracción determinística".
- [ ] `scripts/metrics-cuota.sql`: consulta 6 pasa a contar `vep_retencion_suelto`; 6b pasa a listar boletas con `m.ai.provider = deterministic`… no se persiste; usar `Invoice.detail LIKE 'Retenciones s/fra.%'`.
- [ ] Avisar "listo para commitear".
