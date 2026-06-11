import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { PdfTextExtractorService } from "@/services/pdfTextExtractor.service";
import { loadProcessingClient, resolveAiConfig } from "@/lib/clientProcessingConfig";
import { apiLog } from "@/lib/logger";
import {
  normalizeConsortiumName,
  consortiumFuzzyMatch,
  consortiumAliasMatch,
} from "@/lib/consortiumNormalizer";
import { isPdf, isPng, isJpeg } from "@/lib/fileSignature";
import { env } from "@/config/env";

/** CUIT/DNI normalizado: solo dígitos. */
function normCuit(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

type ConsortiumMatchRow = {
  id: string;
  canonicalName: string;
  rawName: string;
  cuit: string | null;
  matchNames: string | null;
};

/**
 * Replica el matching de consorcio del pipeline principal
 * (processPendingDocuments.job.ts) en 4 niveles, en orden de confianza:
 *   0. CUIT (allTaxIds) — incluye CUITs alternativos en matchNames
 *   1. Nombre exacto normalizado
 *   2. Fuzzy (tokens del canonicalName presentes en el OCR)
 *   3. Alias (matchNames)
 *
 * Devuelve el consorcio que matchea (o null si ninguno).
 */
function findMatchingConsortium(
  allTaxIds: string[],
  rawConsortium: string | null,
  consortiums: ConsortiumMatchRow[]
): { row: ConsortiumMatchRow; method: string } | null {
  // Intento 0: CUIT (señal más fuerte)
  for (const cuit of allTaxIds) {
    const found = consortiums.find((c) => {
      if (c.cuit && normCuit(c.cuit) === cuit) return true;
      const altNames = (c.matchNames ?? "").split("|").map((n) => n.trim()).filter(Boolean);
      return altNames.some((alt) => {
        const normAlt = normCuit(alt);
        return normAlt.length >= 10 && normAlt === cuit;
      });
    });
    if (found) return { row: found, method: `CUIT (${cuit})` };
  }

  if (rawConsortium) {
    const canonicalName = normalizeConsortiumName(rawConsortium);

    // Intento 1: exacto
    let row = consortiums.find((c) => c.canonicalName === canonicalName);
    if (row) return { row, method: "exacto" };

    // Intento 2: fuzzy
    row = consortiums.find((c) => consortiumFuzzyMatch(rawConsortium, c.canonicalName));
    if (row) return { row, method: "fuzzy" };

    // Intento 3: alias (matchNames)
    row = consortiums.find((c) => {
      const names = (c.matchNames ?? "").split("|").map((a) => a.trim()).filter(Boolean);
      return consortiumAliasMatch(rawConsortium, names);
    });
    if (row) return { row, method: "alias" };
  }

  return null;
}

/**
 * POST /api/client/consortiums/[id]/invoices/scan
 * Escanea un PDF con IA y devuelve los campos extraídos.
 *
 * Además valida que el consorcio extraído de la boleta coincida
 * con el consorcio seleccionado. Si no coincide devuelve:
 *   { consortiumMismatch: true, foundConsortium: "NOMBRE REAL" }
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { id: consortiumId } = await context.params;

  try {
    const prisma = getPrismaClient();

    // Consorcio seleccionado actualmente
    const selectedConsortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
      select: { id: true, canonicalName: true, rawName: true, cuit: true, matchNames: true },
    });
    if (!selectedConsortium) {
      return NextResponse.json({ ok: false, error: "Consorcio no encontrado" }, { status: 404 });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ ok: false, error: "Formato de request inválido" }, { status: 400 });
    }

    const file = formData.get("pdf");
    if (!file || typeof file === "string") {
      return NextResponse.json({ ok: false, error: "Se requiere un archivo PDF" }, { status: 400 });
    }

    const MAX_PDF_SIZE = 15 * 1024 * 1024; // 15MB
    if (file.size > MAX_PDF_SIZE) {
      return NextResponse.json(
        { ok: false, error: "El PDF no puede superar 15MB" },
        { status: 400 }
      );
    }

    const VALID_PDF_MIMES = ["application/pdf", "image/jpeg", "image/png"];
    if (!VALID_PDF_MIMES.includes(file.type)) {
      return NextResponse.json(
        { ok: false, error: "El archivo debe ser PDF, JPG o PNG" },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Magic bytes: confirmar que el contenido coincide con el MIME declarado.
    const sigOk =
      (file.type === "application/pdf" && isPdf(buffer)) ||
      (file.type === "image/png"       && isPng(buffer)) ||
      (file.type === "image/jpeg"      && isJpeg(buffer));
    if (!sigOk) {
      return NextResponse.json(
        { ok: false, error: "El contenido del archivo no coincide con su tipo declarado" },
        { status: 400 }
      );
    }

    const isImage = file.type === "image/png" || file.type === "image/jpeg";

    // Resolver y descifrar keys de IA
    const processingClient = await loadProcessingClient(auth.session.clientId);
    if (!processingClient) {
      return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
    }

    const aiConfig    = resolveAiConfig(processingClient);
    const geminiKey   = aiConfig?.geminiApiKey  || env.GEMINI_API_KEY?.trim();
    const openaiKey   = aiConfig?.openaiApiKey  || env.OPENAI_API_KEY?.trim();
    const geminiModel = aiConfig?.geminiModel   || env.GEMINI_MODEL;
    const openaiModel = aiConfig?.openaiModel   || env.OPENAI_MODEL;
    const anthropicKey   = aiConfig?.anthropicApiKey  || env.ANTHROPIC_API_KEY?.trim();
    const anthropicModel = aiConfig?.anthropicModel   || env.ANTHROPIC_MODEL;

    let extracted: Record<string, unknown> | null = null;

    if (isImage) {
      // Imagen: solo Gemini Vision puede procesarla. No hay fallback OCR/PDF.
      if (!geminiKey) {
        return NextResponse.json({
          ok: false,
          error: "Para procesar imágenes (JPG/PNG) se requiere una API key de Gemini configurada",
        }, { status: 400 });
      }
      try {
        const { GeminiExtractorService } = await import("@/services/geminiExtractor.service");
        const extractor = new GeminiExtractorService({ apiKey: geminiKey, model: geminiModel });
        const imageMime = file.type as "image/jpeg" | "image/png";
        extracted = await extractor.extractStructuredDataFromImage(buffer, imageMime) as unknown as Record<string, unknown>;
      } catch (err) {
        apiLog.warn("scan", `Gemini Vision falló: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // PDF: extracción de texto + IA (cadena Gemini → OpenAI → Claude).
      const pdfExtractor = new PdfTextExtractorService();
      const text = await pdfExtractor.extractTextFromPdf(buffer);

      const { createAiExtractionChain } = await import("@/services/aiExtraction");
      const chain = await createAiExtractionChain({
        gemini: { apiKey: geminiKey, model: geminiModel },
        openai: { apiKey: openaiKey, model: openaiModel },
        anthropic: { apiKey: anthropicKey, model: anthropicModel },
      });
      const result = await chain.run(text, (provider, ok, errorMsg) => {
        if (!ok) apiLog.warn("scan", `${provider} falló: ${errorMsg ?? "desconocido"}`);
      });
      extracted = result ? (result.data as unknown as Record<string, unknown>) : null;
    }

    if (!extracted) {
      return NextResponse.json({
        ok: true,
        extracted: null,
        warning: "No se pudo extraer información con IA. Completá los campos manualmente.",
      });
    }

    // ── Validación de consorcio ──────────────────────────────────────────────
    // Replica el matching robusto del pipeline (CUIT → exacto → fuzzy → alias)
    // en vez de comparar igualdad exacta de nombre normalizado. Esto evita
    // falsos positivos cuando la IA confunde el proveedor con el consorcio
    // o cuando el nombre tiene abreviaturas/ceros/sufijos de LSP.
    //
    // Filosofía: solo se declara mismatch si hay EVIDENCIA FUERTE de que la
    // boleta es de OTRO consorcio del cliente. Si no se puede determinar
    // (IA confundió campos, OCR pobre), NO se bloquea — el usuario eligió el
    // consorcio a propósito.
    let consortiumMismatch = false;
    let foundConsortium: string | null = null;

    const allTaxIds = ((extracted.allTaxIds as string[] | null | undefined) ?? [])
      .map((c) => normCuit(c))
      .filter((c) => c.length >= 10);
    const rawConsortium = (extracted.consortium as string | null | undefined)?.trim() ?? null;

    // Solo vale la pena evaluar si hay alguna señal (CUIT o nombre extraído)
    if (allTaxIds.length > 0 || rawConsortium) {
      const allConsortiums = await prisma.consortium.findMany({
        where: { clientId: auth.session.clientId },
        select: { id: true, canonicalName: true, rawName: true, cuit: true, matchNames: true },
      });

      const match = findMatchingConsortium(allTaxIds, rawConsortium, allConsortiums);

      // Mismatch SOLO si la boleta matchea claramente con otro consorcio.
      // - match al seleccionado  → pertenece, no se avisa.
      // - match === null         → indeterminado, no se bloquea.
      // - match a otro consorcio → error de carga real, se avisa.
      if (match && match.row.id !== selectedConsortium.id) {
        consortiumMismatch = true;
        foundConsortium = match.row.rawName;
      }
    }

    // Omitir alias — nunca se devuelve desde el scan
    const { alias: _alias, ...extractedWithoutAlias } = extracted;

    return NextResponse.json({
      ok: true,
      extracted: extractedWithoutAlias,
      consortiumMismatch,
      foundConsortium,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Error al procesar el PDF" },
      { status: 500 }
    );
  }
}
