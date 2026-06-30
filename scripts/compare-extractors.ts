/**
 * Comparador de extractores IA sobre PDFs reales (gate de calidad).
 *
 * Para cada PDF: extrae el texto con el extractor del pipeline y corre CADA
 * proveedor configurado (Cerebras, Groq, Gemini, OpenAI) sobre el MISMO texto,
 * mostrando los campos clave lado a lado. No escribe en DB ni Sheets.
 *
 * Uso:
 *   npx tsx scripts/compare-extractors.ts <ruta.pdf> [<ruta2.pdf> ...]
 *
 * Requiere al menos una key en el entorno: CEREBRAS_API_KEY / GROQ_API_KEY /
 * GEMINI_API_KEY / OPENAI_API_KEY (con sus *_MODEL opcionales).
 */
import { readFileSync } from "fs";
import { loadEnv } from "@/lib/loadEnv";
import { PdfTextExtractorService } from "@/services/pdfTextExtractor.service";
import { identifyLSPProvider } from "@/lib/extraction";
import type { AiExtractor } from "@/services/aiExtraction";

loadEnv();

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

const pdfPaths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (pdfPaths.length === 0) {
  console.error("Uso: npx tsx scripts/compare-extractors.ts <ruta.pdf> [<ruta2.pdf> ...]");
  process.exit(1);
}

async function main() {
  const extractors = await buildExtractors();
  if (extractors.length === 0) {
    console.error("No hay extractores configurados. Definí al menos una de: CEREBRAS_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY.");
    process.exit(1);
  }
  console.log(`Proveedores: ${extractors.map((e) => e.provider).join(", ")}`);

  const pdfExtractor = new PdfTextExtractorService();
  for (const path of pdfPaths) {
    const buffer = readFileSync(path);
    const text = await pdfExtractor.extractTextFromPdf(buffer);
    console.log(`\n══════ ${path} ══════`);
    console.log(`router: ${identifyLSPProvider(text) ?? "factura común"} · ${text.length} chars · fuente=${pdfExtractor.getLastTextSource()}`);

    for (const ex of extractors) {
      const t0 = Date.now();
      try {
        const d = await ex.extractStructuredData(text);
        const u = ex.getLastUsage();
        console.log(`\n[${ex.provider}] ${u?.model ?? ""} — ${Date.now() - t0}ms · tokens=${u?.totalTokens ?? "?"}`);
        console.log(`  consorcio:   ${d.consortium ?? "—"}`);
        console.log(`  proveedor:   ${d.provider ?? "—"}`);
        console.log(`  CUIT prov:   ${d.providerTaxId ?? "—"}`);
        console.log(`  monto:       ${d.amount ?? "—"}`);
        console.log(`  vencimiento: ${d.dueDate ?? "—"}`);
        console.log(`  N° boleta:   ${d.boletaNumber ?? "—"}`);
      } catch (e) {
        console.log(`\n[${ex.provider}] ERROR: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
