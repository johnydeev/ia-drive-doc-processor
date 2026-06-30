# Banco de pruebas local de LLMs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ REGLA DEL OWNER:** Claude **NUNCA** ejecuta `git commit` ni `git push`. Se trabaja directo en `master`, sin ramas. El paso final de cada tarea es un **checkpoint** (correr la verificación y dejar listo); **el owner commitea**.

**Goal:** Una herramienta de desarrollo local que procesa boletas reales desde una carpeta (`pruebas de LLMs/`) por la lógica del pipeline, comparando modelos y midiendo aciertos contra un ground truth opcional, sin escribir en DB/Sheets.

**Architecture:** Un módulo puro `src/lib/testbench.ts` (`runLogicalPipeline` + `compareToExpected`) que reusa las funciones ya existentes del pipeline (extracción, triage, matching, canonización), y un CLI `scripts/llm-testbench.ts` que lee la carpeta, carga el directorio del cliente desde la DB (read-only), corre cada boleta por cada modelo configurado y escribe reportes JSON + Markdown.

**Tech Stack:** TypeScript, tsx (runner de scripts), Vitest, Prisma (lectura del directorio), funciones puras existentes (`assignmentMatching`, `documentClassifier`, `documentValidation`, `cuit`, `businessKey`, `extraction`).

**Spec:** `docs/superpowers/specs/2026-06-25-banco-pruebas-llms-design.md`

---

## File Structure

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `src/lib/testbench.ts` | Lógica pura: tipos + `runLogicalPipeline` + `compareToExpected` | **Crear** |
| `src/lib/testbench.test.ts` | Tests de la lógica (caminos del resultado + comparación ground truth) | **Crear** |
| `scripts/llm-testbench.ts` | CLI: lee carpeta, carga directorio, corre, escribe reportes | **Crear** |
| `.gitignore` | Ignorar `pruebas de LLMs/` (datos reales del cliente) | Modificar |
| `docs/progreso.md`, `decisiones.md`, `CHANGELOG.md` | Documentación | Modificar |

---

## Task 1: Módulo de lógica — tipos + `runLogicalPipeline`

**Files:**
- Create: `src/lib/testbench.ts`
- Test: `src/lib/testbench.test.ts`

- [ ] **Step 1: Escribir los tests (fallan)**

Crear `src/lib/testbench.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { runLogicalPipeline, compareToExpected, type TestbenchDirectory } from "@/lib/testbench";
import type { AiExtractor } from "@/services/aiExtraction";
import type { ExtractedDocumentData } from "@/types/extractedDocument.types";
import type { AiUsageMetrics } from "@/types/aiUsage.types";

function extracted(overrides: Partial<ExtractedDocumentData> = {}): ExtractedDocumentData {
  return {
    boletaNumber: null, provider: null, consortium: null, providerTaxId: null,
    detail: null, observation: null, dueDate: null, amount: null, alias: null,
    clientNumber: null, paymentMethod: null, allTaxIds: [], isBoleta: true, ...overrides,
  };
}

class FakeExtractor implements AiExtractor {
  readonly provider = "cerebras" as const;
  constructor(private readonly data: ExtractedDocumentData) {}
  async extractStructuredData(): Promise<ExtractedDocumentData> { return this.data; }
  getLastUsage(): AiUsageMetrics | null {
    return { provider: "cerebras", model: "gpt-oss-120b", inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  }
}

// Directorio de prueba: 1 consorcio + 1 proveedor con CUITs conocidos.
const directory: TestbenchDirectory = {
  consortiums: [{ id: "c1", canonicalName: "TEST 100", rawName: "TEST 100", cuit: "30-11111111-2", matchNames: null }],
  providers: [{ id: "p1", canonicalName: "PROV SA", cuit: "30-22222222-0", matchNames: null, paymentAlias: null }],
};

// Texto neutro (sin marcadores no-boleta y sin CUITs con checksum válido) → no dispara la heurística
// ni aporta CUITs del texto; los CUITs los controla el fake vía allTaxIds.
const NEUTRAL_TEXT = "factura de servicios de prueba para el consorcio";

describe("runLogicalPipeline", () => {
  it("result=ok cuando matchea consorcio y proveedor por CUIT", async () => {
    const data = extracted({
      consortium: "TEST 100", provider: "PROV SA", amount: 109400,
      allTaxIds: ["30111111112", "30222222220"],
    });
    const r = await runLogicalPipeline({ text: NEUTRAL_TEXT, extractor: new FakeExtractor(data), directory });
    expect(r.result).toBe("ok");
    expect(r.match.consortium).toBe("TEST 100");
    expect(r.match.provider).toBe("PROV SA");
    expect(r.canonical.amount).toBe(109400);
    expect(r.usage?.model).toBe("gpt-oss-120b");
  });

  it("result=no_amount cuando la IA no trae monto", async () => {
    const data = extracted({ consortium: "TEST 100", amount: null });
    const r = await runLogicalPipeline({ text: NEUTRAL_TEXT, extractor: new FakeExtractor(data), directory });
    expect(r.result).toBe("no_amount");
  });

  it("result=no_boleta cuando la IA marca isBoleta=false", async () => {
    const data = extracted({ amount: 1000, isBoleta: false });
    const r = await runLogicalPipeline({ text: NEUTRAL_TEXT, extractor: new FakeExtractor(data), directory });
    expect(r.result).toBe("no_boleta");
    expect(r.reason).toBe("ai");
  });

  it("result=unassigned cuando el proveedor no está en el directorio", async () => {
    const data = extracted({
      consortium: "TEST 100", provider: "DESCONOCIDO SA", amount: 5000,
      allTaxIds: ["30111111112", "30999999990"], // 2º CUIT no está cargado
    });
    const r = await runLogicalPipeline({ text: NEUTRAL_TEXT, extractor: new FakeExtractor(data), directory });
    expect(r.result).toBe("unassigned");
    expect(r.reason).toBe("provider_not_found");
    expect(r.match.consortium).toBe("TEST 100"); // el consorcio sí matcheó
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run src/lib/testbench.test.ts`
Expected: FAIL — `Cannot find module '@/lib/testbench'`.

- [ ] **Step 3: Implementar `src/lib/testbench.ts`**

```typescript
import { AiExtractor } from "@/services/aiExtraction";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";
import { AiUsageMetrics } from "@/types/aiUsage.types";
import {
  identifyLSPProvider,
  annotateSindicalProvider,
  type LSPProvider,
} from "@/lib/extraction";
import { classifyDocumentType } from "@/lib/documentClassifier";
import { isMissingAmount } from "@/lib/documentValidation";
import { extractCuitsFromText, cuitDigits, cuitsEqual } from "@/lib/cuit";
import { normalizeBusinessAmount } from "@/lib/businessKey";
import {
  matchConsortium,
  matchProvider,
  type ConsortiumMatchRow,
  type ProviderMatchRow,
} from "@/lib/assignmentMatching";

export interface TestbenchDirectory {
  consortiums: ConsortiumMatchRow[];
  providers: ProviderMatchRow[];
}

export type TestbenchOutcome = "ok" | "unassigned" | "no_boleta" | "no_amount";

export interface TestbenchCanonical {
  consortium: string | null;
  provider: string | null;
  providerTaxId: string | null;
  amount: number | null;
  dueDate: string | null;
  boletaNumber: string | null;
}

export interface TestbenchResult {
  lspProvider: LSPProvider | null;
  result: TestbenchOutcome;
  reason: string | null;
  extracted: ExtractedDocumentData | null;
  match: {
    consortium: string | null;
    consortiumMethod: string | null;
    provider: string | null;
    providerMethod: string | null;
  };
  canonical: TestbenchCanonical;
  usage: AiUsageMetrics | null;
  errors: string[];
}

function emptyCanonical(): TestbenchCanonical {
  return { consortium: null, provider: null, providerTaxId: null, amount: null, dueDate: null, boletaNumber: null };
}

export async function runLogicalPipeline(input: {
  text: string;
  extractor: AiExtractor;
  directory: TestbenchDirectory;
}): Promise<TestbenchResult> {
  const { text, extractor, directory } = input;
  const errors: string[] = [];
  const lspProvider = identifyLSPProvider(text);
  const base = {
    lspProvider,
    extracted: null as ExtractedDocumentData | null,
    match: { consortium: null, consortiumMethod: null, provider: null, providerMethod: null },
    canonical: emptyCanonical(),
    usage: null as AiUsageMetrics | null,
    errors,
  };

  // Triage capa 1 (heurística, sin tokens)
  if (classifyDocumentType(text) === "not_boleta") {
    return { ...base, result: "no_boleta", reason: "heuristic" };
  }

  // Extracción IA
  let extracted: ExtractedDocumentData;
  try {
    extracted = await extractor.extractStructuredData(text);
  } catch (e) {
    base.errors.push(e instanceof Error ? e.message : String(e));
    return { ...base, result: "no_boleta", reason: "extraction_error" };
  }
  base.extracted = extracted;
  base.usage = extractor.getLastUsage();

  // Triage capa 2 (IA)
  if (extracted.isBoleta === false) {
    return { ...base, result: "no_boleta", reason: "ai" };
  }

  // Gate sin-monto
  if (isMissingAmount(extracted.amount)) {
    return { ...base, result: "no_amount", reason: null };
  }

  // CUITs del texto (regex+checksum) + los de la IA (solo no-LSP, como el pipeline)
  const textCuits = extractCuitsFromText(text);
  const aiCuits = (extracted.allTaxIds ?? [])
    .map((c) => cuitDigits(c))
    .filter((c) => c.length === 11);
  const allTaxIds = Array.from(new Set([...textCuits, ...aiCuits]));

  // Matching (mismas funciones puras que el pipeline)
  const consortiumHit = matchConsortium(directory.consortiums, extracted.consortium, allTaxIds);
  const consortiumCuitNorm = cuitDigits(consortiumHit?.row.cuit ?? null);
  const providerHit = matchProvider(
    directory.providers,
    extracted.providerTaxId,
    extracted.provider ?? lspProvider,
    allTaxIds,
    consortiumCuitNorm
  );

  base.match = {
    consortium: consortiumHit?.row.canonicalName ?? null,
    consortiumMethod: consortiumHit?.method ?? null,
    provider: providerHit?.row.canonicalName ?? null,
    providerMethod: providerHit?.method ?? null,
  };

  if (!consortiumHit || !providerHit) {
    base.canonical = {
      consortium: consortiumHit?.row.canonicalName ?? extracted.consortium,
      provider: providerHit?.row.canonicalName ?? extracted.provider,
      providerTaxId: extracted.providerTaxId,
      amount: extracted.amount,
      dueDate: extracted.dueDate,
      boletaNumber: extracted.boletaNumber,
    };
    return {
      ...base,
      result: "unassigned",
      reason: !consortiumHit ? "consortium_not_found" : "provider_not_found",
    };
  }

  // Canonización (match completo)
  base.canonical = {
    consortium: consortiumHit.row.canonicalName,
    provider: annotateSindicalProvider(providerHit.row.canonicalName, lspProvider),
    providerTaxId: providerHit.row.cuit ?? extracted.providerTaxId,
    amount: extracted.amount,
    dueDate: extracted.dueDate,
    boletaNumber: extracted.boletaNumber,
  };
  return { ...base, result: "ok", reason: null };
}

// compareToExpected se agrega en la Task 2.
export {};
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run src/lib/testbench.test.ts`
Expected: PASS los 4 tests de `runLogicalPipeline`. (Los tests de `compareToExpected` aún no existen.)

> Si el import de `compareToExpected` en el test rompe la compilación, dejarlo: se implementa en la Task 2. Si bloquea, comentar temporalmente esa importación hasta la Task 2 — pero el orden recomendado es implementar Task 2 a continuación.

- [ ] **Step 5: Checkpoint**

Run: `npx tsc --noEmit`
Avisar: Task 1 lista (queda pendiente `compareToExpected`, Task 2). No ejecutar `git commit`.

---

## Task 2: `compareToExpected` (ground truth)

**Files:**
- Modify: `src/lib/testbench.ts`
- Test: `src/lib/testbench.test.ts`

- [ ] **Step 1: Agregar los tests (fallan)**

En `src/lib/testbench.test.ts`, agregar al final:

```typescript
describe("compareToExpected", () => {
  const okResult = {
    result: "ok" as const, reason: null, lspProvider: null,
    extracted: null, usage: null, errors: [],
    match: { consortium: "TEST 100", consortiumMethod: "CUIT", provider: "PROV SA", providerMethod: "CUIT" },
    canonical: {
      consortium: "TEST 100", provider: "PROV SA", providerTaxId: "30-22222222-0",
      amount: 109400, dueDate: "2026-06-19", boletaNumber: "00002-00003876",
    },
  };

  it("marca todos los campos como ok cuando coinciden (monto por valor, CUIT por dígitos)", () => {
    const cmp = compareToExpected(okResult, {
      consortium: "TEST 100", provider: "PROV SA", providerTaxId: "30222222220",
      amount: 109400, result: "ok",
    });
    expect(cmp.fields.amount).toBe("ok");
    expect(cmp.fields.providerTaxId).toBe("ok"); // compara por dígitos
    expect(cmp.fields.consortium).toBe("ok");
    expect(cmp.fields.result).toBe("ok");
    expect(cmp.hits).toBe(cmp.total);
  });

  it("marca mismatch cuando un campo difiere y absent cuando el esperado no lo trae", () => {
    const cmp = compareToExpected(okResult, { amount: 999999, dueDate: undefined });
    expect(cmp.fields.amount).toBe("mismatch");
    expect(cmp.fields.dueDate).toBe("absent"); // no estaba en el esperado → no se compara
    expect(cmp.hits).toBe(0);
    expect(cmp.total).toBe(1); // solo amount estaba presente en el esperado
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run src/lib/testbench.test.ts -t compareToExpected`
Expected: FAIL — `compareToExpected is not a function`.

- [ ] **Step 3: Implementar `compareToExpected`**

En `src/lib/testbench.ts`, reemplazar la línea final `export {};` por:

```typescript
export interface ExpectedFields {
  consortium?: string;
  provider?: string;
  providerTaxId?: string;
  amount?: number;
  dueDate?: string;
  boletaNumber?: string;
  result?: TestbenchOutcome;
}

export type FieldVerdict = "ok" | "mismatch" | "absent";

export interface FieldComparison {
  fields: Record<keyof ExpectedFields, FieldVerdict>;
  hits: number;
  total: number;
}

function sameText(a: string | null, b: string | undefined): FieldVerdict {
  if (b === undefined) return "absent";
  return (a ?? "").trim().toLowerCase() === b.trim().toLowerCase() ? "ok" : "mismatch";
}

export function compareToExpected(result: TestbenchResult, expected: ExpectedFields): FieldComparison {
  const c = result.canonical;
  const fields: Record<keyof ExpectedFields, FieldVerdict> = {
    consortium: sameText(c.consortium, expected.consortium),
    provider: sameText(c.provider, expected.provider),
    providerTaxId:
      expected.providerTaxId === undefined
        ? "absent"
        : cuitsEqual(c.providerTaxId, expected.providerTaxId) ? "ok" : "mismatch",
    amount:
      expected.amount === undefined
        ? "absent"
        : normalizeBusinessAmount(c.amount) === normalizeBusinessAmount(expected.amount) ? "ok" : "mismatch",
    dueDate: sameText(c.dueDate, expected.dueDate),
    boletaNumber: sameText(c.boletaNumber, expected.boletaNumber),
    result:
      expected.result === undefined ? "absent" : result.result === expected.result ? "ok" : "mismatch",
  };
  const compared = Object.values(fields).filter((v) => v !== "absent");
  return { fields, hits: compared.filter((v) => v === "ok").length, total: compared.length };
}
```

- [ ] **Step 4: Correr toda la suite del módulo**

Run: `npx vitest run src/lib/testbench.test.ts`
Expected: PASS (6 tests: 4 de `runLogicalPipeline` + 2 de `compareToExpected`).

- [ ] **Step 5: Checkpoint**

Run: `npx tsc --noEmit`
Avisar: Task 2 lista.

---

## Task 3: CLI `scripts/llm-testbench.ts`

**Files:**
- Create: `scripts/llm-testbench.ts`

- [ ] **Step 1: Crear el script**

Crear `scripts/llm-testbench.ts`:

```typescript
/**
 * Banco de pruebas local de LLMs.
 *
 * Procesa las boletas de una carpeta por la LÓGICA del pipeline (extracción +
 * triage + matching + canonización), por cada modelo configurado, y escribe
 * reportes. NO escribe en DB/Sheets (el matching solo LEE la DB). Si junto a una
 * boleta hay un `<nombre>.expected.json`, mide aciertos por campo.
 *
 * Uso:
 *   npx tsx scripts/llm-testbench.ts ["./pruebas de LLMs"] [clientId|nombre]
 *
 * Requiere al menos una key en el entorno (CEREBRAS/GROQ/GEMINI/OPENAI) y
 * DATABASE_URL para cargar el directorio del cliente.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { loadEnv } from "@/lib/loadEnv";
import { getPrismaClient, isDatabaseConfigured } from "@/lib/prisma";
import { PdfTextExtractorService } from "@/services/pdfTextExtractor.service";
import { identifyLSPProvider } from "@/lib/extraction";
import type { AiExtractor } from "@/services/aiExtraction";
import {
  runLogicalPipeline,
  compareToExpected,
  type TestbenchDirectory,
  type ExpectedFields,
} from "@/lib/testbench";

loadEnv();

const folder = process.argv[2] || "./pruebas de LLMs";
const clientArg = process.argv[3];

async function buildExtractors(): Promise<AiExtractor[]> {
  const list: AiExtractor[] = [];
  const { OpenAICompatibleExtractorService } = await import("@/services/openAICompatibleExtractor.service");
  if (process.env.CEREBRAS_API_KEY) {
    list.push(new OpenAICompatibleExtractorService({
      provider: "cerebras", apiKey: process.env.CEREBRAS_API_KEY,
      baseURL: "https://api.cerebras.ai/v1", model: process.env.CEREBRAS_MODEL || "gpt-oss-120b",
    }));
  }
  if (process.env.GROQ_API_KEY) {
    list.push(new OpenAICompatibleExtractorService({
      provider: "groq", apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1", model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    }));
  }
  if (process.env.GEMINI_API_KEY) {
    const { GeminiExtractorService } = await import("@/services/geminiExtractor.service");
    list.push(new GeminiExtractorService({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL }));
  }
  if (process.env.OPENAI_API_KEY) {
    const { AiExtractorService } = await import("@/services/aiExtractor.service");
    list.push(new AiExtractorService({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }));
  }
  return list;
}

async function loadDirectory(client: string | undefined): Promise<TestbenchDirectory> {
  if (!isDatabaseConfigured()) {
    console.error("DATABASE_URL no configurada — el matching necesita leer el directorio del cliente.");
    process.exit(1);
  }
  const prisma = getPrismaClient();
  const c = client
    ? await prisma.client.findFirst({ where: { OR: [{ id: client }, { name: { contains: client, mode: "insensitive" } }] }, select: { id: true, name: true } })
    : await prisma.client.findFirst({ where: { isActive: true }, select: { id: true, name: true } });
  if (!c) { console.error(`Cliente no encontrado: "${client ?? "(primer activo)"}"`); process.exit(1); }
  console.log(`Directorio del cliente: "${c.name}"`);
  const [consortiums, providers] = await Promise.all([
    prisma.consortium.findMany({ where: { clientId: c.id }, select: { id: true, canonicalName: true, rawName: true, cuit: true, matchNames: true } }),
    prisma.provider.findMany({ where: { clientId: c.id }, select: { id: true, canonicalName: true, cuit: true, matchNames: true, paymentAlias: true } }),
  ]);
  return { consortiums, providers };
}

function loadExpected(folder: string, pdf: string): ExpectedFields | null {
  const path = join(folder, pdf.replace(/\.pdf$/i, ".expected.json"));
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")) as ExpectedFields; }
  catch (e) { console.warn(`  ⚠️ expected.json inválido: ${e instanceof Error ? e.message : e}`); return null; }
}

async function main() {
  if (!existsSync(folder)) {
    console.error(`No existe la carpeta: "${folder}". Creala y poné PDFs adentro.`);
    process.exit(1);
  }
  const extractors = await buildExtractors();
  if (extractors.length === 0) {
    console.error("No hay extractores configurados (definí CEREBRAS_API_KEY / GROQ_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY).");
    process.exit(1);
  }
  const directory = await loadDirectory(clientArg);
  const pdfs = readdirSync(folder).filter((f) => /\.pdf$/i.test(f));
  if (pdfs.length === 0) { console.error(`No hay PDFs en "${folder}".`); process.exit(1); }

  console.log(`Proveedores: ${extractors.map((e) => e.provider).join(", ")} · Boletas: ${pdfs.length}`);
  const pdfExtractor = new PdfTextExtractorService();
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  const outDir = join(folder, "_resultados", stamp);
  mkdirSync(outDir, { recursive: true });

  const results: unknown[] = [];
  const mdLines: string[] = [`# Reporte banco de pruebas — ${stamp}`, ""];
  // tally[provider] = { hits, total, boletas }
  const tally: Record<string, { hits: number; total: number; boletas: number }> = {};

  for (const pdf of pdfs) {
    const buffer = readFileSync(join(folder, pdf));
    const text = await pdfExtractor.extractTextFromPdf(buffer);
    const expected = loadExpected(folder, pdf);
    console.log(`\n══ ${pdf} ══ (router: ${identifyLSPProvider(text) ?? "factura común"}, ${text.length} chars)`);
    if (!text.trim()) console.log("  ⚠️ sin texto (¿boleta-imagen? el OCR solo corre en Docker) — probar en el pipeline real");
    mdLines.push(`## ${pdf}`, `router: ${identifyLSPProvider(text) ?? "factura común"} · ${text.length} chars`, "");
    mdLines.push("| modelo | resultado | consorcio | proveedor | CUIT | monto | vto | N° | aciertos |", "|---|---|---|---|---|---|---|---|---|");

    const perModel: unknown[] = [];
    for (const ex of extractors) {
      const t0 = Date.now();
      const r = await runLogicalPipeline({ text, extractor: ex, directory });
      const ms = Date.now() - t0;
      const cmp = expected ? compareToExpected(r, expected) : null;
      tally[ex.provider] ??= { hits: 0, total: 0, boletas: 0 };
      tally[ex.provider].boletas += 1;
      if (cmp) { tally[ex.provider].hits += cmp.hits; tally[ex.provider].total += cmp.total; }
      const c = r.canonical;
      const score = cmp ? `${cmp.hits}/${cmp.total}` : "—";
      console.log(`  [${ex.provider}] ${r.result}${r.reason ? `(${r.reason})` : ""} — ${ms}ms · aciertos=${score}`);
      console.log(`     consorcio=${c.consortium ?? "—"} · proveedor=${c.provider ?? "—"} · monto=${c.amount ?? "—"}`);
      mdLines.push(`| ${ex.provider} | ${r.result} | ${c.consortium ?? "—"} | ${c.provider ?? "—"} | ${c.providerTaxId ?? "—"} | ${c.amount ?? "—"} | ${c.dueDate ?? "—"} | ${c.boletaNumber ?? "—"} | ${score} |`);
      perModel.push({ provider: ex.provider, model: r.usage?.model ?? null, ms, result: r.result, reason: r.reason, extracted: r.extracted, canonical: r.canonical, match: r.match, usage: r.usage, comparison: cmp });
    }
    mdLines.push("");
    results.push({ file: pdf, router: identifyLSPProvider(text) ?? "factura común", textChars: text.length, models: perModel });
  }

  mdLines.push("## Resumen por modelo", "", "| modelo | boletas | aciertos |", "|---|---|---|");
  console.log("\n══ RESUMEN ══");
  for (const [provider, t] of Object.entries(tally)) {
    const pct = t.total > 0 ? `${t.hits}/${t.total} (${Math.round((100 * t.hits) / t.total)}%)` : "sin ground truth";
    console.log(`  ${provider}: ${t.boletas} boletas · aciertos ${pct}`);
    mdLines.push(`| ${provider} | ${t.boletas} | ${pct} |`);
  }

  writeFileSync(join(outDir, "resultados.json"), JSON.stringify(results, null, 2), "utf-8");
  writeFileSync(join(outDir, "reporte.md"), mdLines.join("\n"), "utf-8");
  console.log(`\nReportes en: ${outDir}`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verificar typecheck y el mensaje de uso sin carpeta**

Run: `npx tsc --noEmit`
Expected: sin errores.

Run: `npx tsx scripts/llm-testbench.ts "./carpeta-que-no-existe"`
Expected: imprime `No existe la carpeta: ...` y sale con código 1.

- [ ] **Step 3: Prueba funcional real (la corre el owner)**

Crear la carpeta `pruebas de LLMs/`, poner 1-2 PDFs (y opcionalmente un `<nombre>.expected.json`), y correr:
`npx tsx scripts/llm-testbench.ts "./pruebas de LLMs" MorinigoAdm`
Expected: imprime el resultado por boleta × modelo y deja `resultados.json` + `reporte.md` en `pruebas de LLMs/_resultados/<stamp>/`.

- [ ] **Step 4: Checkpoint**

Avisar: Task 3 lista.

---

## Task 4: Ignorar la carpeta de pruebas en git

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Agregar la regla**

En `.gitignore`, después de la línea `!.env.example` (sección de env), agregar:

```
# Banco de pruebas de LLMs: boletas reales del cliente — NO versionar
pruebas de LLMs/
```

- [ ] **Step 2: Verificar**

Run: `git check-ignore "pruebas de LLMs/factura.pdf" && echo "OK: ignorada" || echo "NO ignorada"`
Expected: `OK: ignorada`.

- [ ] **Step 3: Checkpoint**

Avisar: Task 4 lista.

---

## Task 5: Verificación completa + documentación

**Files:**
- Modify: `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`

- [ ] **Step 1: Suite de verificación**

Run: `npm test`
Run: `npm run typecheck`
Run: `npm run lint`
Expected: todo verde (incluye los 6 tests nuevos de `testbench.test.ts`).

- [ ] **Step 2: `docs/progreso.md`**

Agregar una entrada al principio: el banco de pruebas local de LLMs (qué es, cómo se usa, enfoque A, ground truth opcional, estado implementado + verificado, SIN COMMITEAR). Marcar que no escribe en DB/Sheets y que el OCR no corre local.

- [ ] **Step 3: `docs/decisiones.md`**

Agregar `## 2026-06-25 — Banco de pruebas local de LLMs (testbench)` con: problema (iterar prompts/comparar modelos sobre boletas reales sin tocar prod), decisión (enfoque A: reusar funciones puras; archivos locales; matching read-only; ground truth opcional), alternativas descartadas (correr `runPipeline` con mocks; sandbox de DB/Sheets; fine-tuning) e impacto (archivos + tests + sin migración).

- [ ] **Step 4: `CHANGELOG.md`**

Agregar entrada fechada 2026-06-25 en `### Feature` con los highlights: `src/lib/testbench.ts` + `scripts/llm-testbench.ts`, dry-run, ground truth opcional, reportes JSON+MD.

- [ ] **Step 5: Checkpoint final**

Run: `npm test`
Avisar al owner: implementación completa, verificada, lista para commitear.

---

## Self-Review (completado por el autor del plan)

- **Cobertura del spec:** §3.1 `runLogicalPipeline` → Task 1; `compareToExpected` → Task 2; §3.2 CLI → Task 3; §4 carpeta/gitignore → Task 4; §11 verificación + docs → Task 5. Reporte (§6) y ground truth (§5) cubiertos en Task 3 y Task 2. Sin gaps.
- **Placeholders:** ninguno; todo el código está completo, con comandos y output esperado.
- **Consistencia de tipos:** `TestbenchDirectory`, `TestbenchResult`, `TestbenchOutcome`, `ExpectedFields`, `FieldComparison` definidos en Task 1/2 y usados igual en Task 3. `runLogicalPipeline`/`compareToExpected` tienen la misma firma en su definición (Task 1/2) y en el CLI (Task 3). Los tipos de fila (`ConsortiumMatchRow`/`ProviderMatchRow`) y las funciones reusadas (`matchConsortium`, `matchProvider`, `classifyDocumentType`, `isMissingAmount`, `extractCuitsFromText`, `cuitsEqual`, `normalizeBusinessAmount`, `annotateSindicalProvider`, `identifyLSPProvider`) coinciden con sus firmas reales verificadas en el código.
