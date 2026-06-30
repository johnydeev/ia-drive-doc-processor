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

/**
 * Banco de pruebas local de LLMs (lógica pura).
 *
 * `runLogicalPipeline` replica la SECUENCIA del pipeline real (extracción IA →
 * triage → gate sin-monto → matching → canonización) reusando las mismas
 * funciones puras, pero SIN side-effects (no baja de Drive, no escribe en
 * DB/Sheets). El matching opera sobre un `TestbenchDirectory` ya cargado en
 * memoria. `compareToExpected` mide aciertos contra un ground truth opcional.
 */

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
    match: { consortium: null, consortiumMethod: null, provider: null, providerMethod: null } as TestbenchResult["match"],
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
