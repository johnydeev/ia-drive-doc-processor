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
 * Requiere al menos una key en el entorno (CEREBRAS/GEMINI/OPENAI) y
 * DATABASE_URL para cargar el directorio del cliente.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
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

function loadExpected(folderPath: string, pdf: string): ExpectedFields | null {
  const path = join(folderPath, pdf.replace(/\.pdf$/i, ".expected.json"));
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
    console.error("No hay extractores configurados (definí CEREBRAS_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY).");
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
  const tally: Record<string, { hits: number; total: number; boletas: number }> = {};

  for (const pdf of pdfs) {
    const buffer = readFileSync(join(folder, pdf));
    const text = await pdfExtractor.extractTextFromPdf(buffer);
    const expected = loadExpected(folder, pdf);
    const router = identifyLSPProvider(text) ?? "factura común";
    console.log(`\n══ ${pdf} ══ (router: ${router}, ${text.length} chars)`);
    if (!text.trim()) console.log("  ⚠️ sin texto (¿boleta-imagen? el OCR solo corre en Docker) — probar en el pipeline real");
    mdLines.push(`## ${pdf}`, `router: ${router} · ${text.length} chars`, "");
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
    results.push({ file: pdf, router, textChars: text.length, models: perModel });
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
