/**
 * Diagnóstico genérico de boleta: "¿por qué este PDF no matcheó?"
 *
 * Replica los pasos determinísticos del pipeline sobre CUALQUIER PDF local:
 *   1. Extrae el texto con el MISMO extractor del pipeline (pdf-parse → OCR).
 *   2. Extrae los CUITs reales del texto (regex + checksum, lib/cuit).
 *   3. Si hay DB configurada y se indica un cliente: corre el matching REAL
 *      (matchConsortium/matchProvider) contra los consorcios y proveedores
 *      cargados de ese cliente, y muestra el veredicto.
 *
 * No consume IA ni escribe nada (solo lectura).
 *
 * Uso:
 *   npx tsx scripts/diag-boleta.ts <ruta.pdf>                    # texto + CUITs
 *   npx tsx scripts/diag-boleta.ts <ruta.pdf> <clientId|nombre>  # + matching vs DB
 *   npx tsx scripts/diag-boleta.ts <ruta.pdf> <cliente> --texto  # además vuelca el texto
 */
import { readFileSync } from "fs";
import { loadEnv } from "@/lib/loadEnv";
import { getPrismaClient, isDatabaseConfigured } from "@/lib/prisma";
import { PdfTextExtractorService } from "@/services/pdfTextExtractor.service";
import { extractCuitsFromText, cuitDigits, formatCuit } from "@/lib/cuit";
import { matchConsortium, matchProvider } from "@/lib/assignmentMatching";
import { identifyLSPProvider, refineExtractionWithRawText, usesConsortiumCuit } from "@/lib/extraction";
import type { ExtractedDocumentData } from "@/types/extractedDocument.types";

/** Extracted vacío para correr solo el refinamiento determinístico del consorcio. */
function emptyExtracted(): ExtractedDocumentData {
  return {
    boletaNumber: null, provider: null, consortium: null, providerTaxId: null,
    detail: null, observation: null, dueDate: null, amount: null, alias: null,
    clientNumber: null, paymentMethod: null, allTaxIds: null,
  };
}

loadEnv();

const [pdfPath, clientArg] = process.argv.slice(2);
const dumpText = process.argv.includes("--texto");

if (!pdfPath) {
  console.error("Uso: npx tsx scripts/diag-boleta.ts <ruta.pdf> [clientId|nombre] [--texto]");
  process.exit(1);
}

async function main() {
  // 1. Texto con el extractor real del pipeline
  const buffer = readFileSync(pdfPath);
  const extractor = new PdfTextExtractorService();
  const text = await extractor.extractTextFromPdf(buffer);
  console.log(`\n=== TEXTO: fuente=${extractor.getLastTextSource()} chars=${text.length} emitterBlock=${extractor.getLastHasEmitterBlock()} ===`);
  console.log(`=== TIPO (router): ${identifyLSPProvider(text) ?? "factura común"} ===`);
  if (dumpText) console.log(`\n${text}\n`);

  // 2. CUITs determinísticos del papel
  const cuits = extractCuitsFromText(text);
  console.log(`\n=== CUITs del documento (regex+checksum): ${cuits.length} ===`);
  for (const c of cuits) console.log(`  ${formatCuit(c) ?? c}`);

  // 3. Matching real contra la DB del cliente (opcional)
  if (!clientArg) {
    console.log("\n(Sin cliente indicado — para simular el matching: agregar <clientId|nombre>)");
    return;
  }
  if (!isDatabaseConfigured()) {
    console.error("DATABASE_URL no configurada — no se puede simular el matching.");
    process.exit(1);
  }

  const prisma = getPrismaClient();
  const client = await prisma.client.findFirst({
    where: { OR: [{ id: clientArg }, { name: { contains: clientArg, mode: "insensitive" } }] },
    select: { id: true, name: true },
  });
  if (!client) {
    console.error(`Cliente no encontrado: "${clientArg}"`);
    process.exit(1);
  }
  console.log(`\n=== MATCHING contra cliente "${client.name}" ===`);

  const [consortiums, providers] = await Promise.all([
    prisma.consortium.findMany({
      where: { clientId: client.id },
      select: { id: true, canonicalName: true, rawName: true, cuit: true, matchNames: true },
    }),
    prisma.provider.findMany({
      where: { clientId: client.id },
      select: { id: true, canonicalName: true, cuit: true, matchNames: true, paymentAlias: true },
    }),
  ]);

  // Consorcio: el nombre se infiere determinísticamente del texto con el MISMO
  // refinamiento del pipeline (marcador "CONSORCIO DE PROPIETARIOS" + dirección),
  // sin IA, y se pasa al matching real junto con los CUITs.
  const inferredConsortium = refineExtractionWithRawText(emptyExtracted(), text).consortium;
  if (inferredConsortium) {
    console.log(`Consorcio inferido del texto (sin IA): "${inferredConsortium}"`);
  }
  const consortiumHit = matchConsortium(consortiums, inferredConsortium, cuits);
  console.log(
    consortiumHit
      ? `Consorcio:  MATCH "${consortiumHit.row.canonicalName}" — ${consortiumHit.method}`
      : "Consorcio:  SIN MATCH (ni por CUIT ni por el nombre inferido del texto)"
  );

  // Para tipos detectados por el router (sindicales SUTERH/FATERYH/SERACARH,
  // LSP), el proveedor se identifica por NOMBRE → se simula con ese nombre.
  const lsp = identifyLSPProvider(text);
  const consortiumCuitNorm = cuitDigits(consortiumHit?.row.cuit);
  const providerHit = matchProvider(providers, null, lsp, cuits, consortiumCuitNorm, usesConsortiumCuit(lsp));
  console.log(
    providerHit
      ? `Proveedor:  MATCH "${providerHit.row.canonicalName}" — ${providerHit.method}`
      : "Proveedor:  SIN MATCH por CUIT → revisar si está cargado y con qué CUIT"
  );

  if (!providerHit && cuits.length > 0) {
    console.log("\nCUITs del papel vs. directorio del cliente:");
    for (const c of cuits) {
      const owner =
        providers.find((p) => cuitDigits(p.cuit) === c)?.canonicalName ??
        consortiums.find((x) => cuitDigits(x.cuit) === c)?.canonicalName ??
        "(no cargado)";
      console.log(`  ${formatCuit(c) ?? c} → ${owner}`);
    }
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
