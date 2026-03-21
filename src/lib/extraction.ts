import { z } from "zod";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

function normalizeCuit(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, "");
  if (digits.length !== 11) {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

function normalizeAmount(value: number | string | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
  }

  const normalized = value.replace(/[^\d.,-]/g, "").replace(/,/g, ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

export const EXTRACTED_DOCUMENT_SCHEMA = z
  .object({
    boletaNumber: z.string().nullable().default(null),
    provider: z.string().nullable().default(null),
    consortium: z.string().nullable().default(null),
    providerTaxId: z.string().nullable().default(null).transform((value) => normalizeCuit(value)),
    detail: z.string().nullable().default(null),
    observation: z.string().nullable().default(null),
    dueDate: z.string().nullable().default(null),
    amount: z
      .union([z.number(), z.string()])
      .nullable()
      .default(null)
      .transform((value) => normalizeAmount(value)),
    alias: z.string().nullable().default(null),
  })
  .strict();

const OUTPUT_JSON_TEMPLATE = {
  boletaNumber: "string | null",
  provider: "string | null",
  consortium: "string | null",
  providerTaxId: "string | null",
  detail: "string | null",
  observation: "string | null",
  dueDate: "YYYY-MM-DD | null",
  amount: "number | null",
  alias: "string | null",
};

/**
 * Regla de dueDate para facturas normales.
 */
const DUE_DATE_RULE = [
  "- dueDate: fecha límite en que el cliente debe PAGAR este comprobante. YYYY-MM-DD.",
  "",
  "  VÁLIDO — usar la fecha:",
  "    ✓ 'Fecha de Vto. para el pago', 'Fecha límite de pago', 'Vence:', 'Vencimiento:'",
  "      con una fecha de pago.",
  "    ✓ 'Vencimiento: [fecha]' o 'Fecha Vto.: [fecha]' en el encabezado de la factura",
  "      junto al número de comprobante, CUIT e inicio de actividades del emisor.",
  "    ✓ '1° Vencimiento: [fecha]' junto a un monto — siempre válido.",
  "",
  "  INVÁLIDO — devolver null:",
  "    ✗ 'Fecha Vto.' junto a 'CAE N°:' o número largo de dígitos — es vencimiento AFIP.",
  "    ✗ 'C.E.S.P: XXXXX | Fecha Vto: [fecha]' — el Fecha Vto aquí es del código CESP",
  "       (código electrónico de servicio público), NO de pago.",
  "    ✗ 'Inicio de actividades' — antigüedad del proveedor en AFIP.",
  "    ✗ 'Fecha de emisión' / 'Fecha:' sola — es cuando se emitió el comprobante.",
  "    ✗ 'Período facturado desde/hasta' — período del servicio.",
  "",
  "  Si no existe un vencimiento de pago explícito: null.",
  "  No deducir, no calcular, no suponer. Ante cualquier duda: null.",
].join("\n");

/**
 * Extrae las primeras N líneas no vacías del texto del PDF.
 */
function extractRelevantLines(text: string, maxLines = 80): string {
  return text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines)
    .join("\n");
}

/**
 * Detecta si el texto corresponde a una Liquidación de Servicios Públicos (LSP).
 */
function isUtilityBill(text: string): boolean {
  const upper = text.slice(0, 3000).toUpperCase();
  return (
    upper.includes("LIQUIDACIÓN DE SERVICIOS PÚBLICOS") ||
    upper.includes("LIQUIDACION DE SERVICIOS PUBLICOS") ||
    upper.includes("LSP ") ||
    upper.includes("EMPRESA DISTRIBUIDORA") ||
    upper.includes("METROGAS") ||
    upper.includes("AYSA") ||
    upper.includes("AY.S.A") ||
    upper.includes("AGUA Y SANEAMIENTOS") ||
    upper.includes("EDESUR") ||
    upper.includes("EDENOR") ||
    upper.includes("NATURGY") ||
    upper.includes("CAMUZZI") ||
    upper.includes("LITORAL GAS") ||
    upper.includes("ABSA") ||
    (upper.includes("AGUAS") && upper.includes("ARGENTINAS"))
  );
}

export function buildExtractionPrompt(text: string): string {
  const relevantText = extractRelevantLines(text, 80);
  const utility = isUtilityBill(text);

  if (utility) {
    return buildUtilityBillPrompt(relevantText);
  }

  return buildInvoicePrompt(relevantText);
}

/**
 * Prompt para facturas/boletas de proveedores (caso general).
 */
function buildInvoicePrompt(relevantText: string): string {
  return [
    "Extrae datos de una factura/comprobante en PDF (administración de consorcios en Argentina).",
    "Responde SOLO JSON con EXACTAMENTE estas claves y tipos:",
    JSON.stringify(OUTPUT_JSON_TEMPLATE, null, 2),

    "=== REGLAS ===",

    "- boletaNumber: número de comprobante. Formato típico PPPP-NNNNNNNN (ej: '0002-00003019').",

    "- provider: razón social del EMISOR (quien factura). Está en el bloque superior del documento,",
    "  generalmente con su domicilio, teléfono y CUIT. NO es el consorcio.",

    "- providerTaxId: CUIT del EMISOR. Está en el bloque del proveedor junto a su nombre/domicilio.",
    "  ATENCIÓN: en la sección del RECEPTOR puede aparecer 'Tipo y Nº de Doc.: CUIT XXXXXXXXXX'",
    "  o 'DNI: XXXXXXXXXX' que corresponde al consorcio. Ese valor NO es el providerTaxId.",
    "  Solo usar el CUIT del bloque del EMISOR. Si no podés identificarlo con certeza: null.",

    "- consortium: nombre del CONSORCIO receptor. Buscarlo en la sección del receptor:",
    "  'Razón Social:', 'Cliente:', 'Señores:', etc. Incluir el nombre completo con calle y número.",

    "- amount: monto TOTAL a pagar ('Importe Total', 'Total a pagar'). Nunca un subtotal.",
    "  Formato numérico sin símbolos (ej: 34400.01).",

    DUE_DATE_RULE,

    "- detail: descripción breve del producto o servicio facturado (máx 120 caracteres).",

    "- Usa null si un dato falta o es incierto. No inventes datos.",

    "Texto del comprobante:",
    relevantText,
  ].join("\n\n");
}

/**
 * Prompt especializado para Liquidaciones de Servicios Públicos (LSP).
 *
 * Cubre las variantes reales observadas en facturas argentinas:
 *
 * EDESUR / EDENOR:
 *   - CUIT del cliente aparece prominente junto a "CUIT:" en el encabezado del receptor
 *   - Puede tener 1° y 2° vencimiento
 *
 * AySA (Agua y Saneamientos Argentinos):
 *   - Encabezado: "C.E.S.P: XXXXXX | Fecha Vto: DD/MM/YYYY" → Fecha Vto es del CESP, NO de pago
 *   - CUIT de AySA: 30-70956507-5 (está en el encabezado junto a nombre y inicio de actividades)
 *   - CUIT del cliente aparece al FINAL del documento: "IVA RESPONSABLE INSCRIPTO - CUIT No. XX"
 *   - Caso débito automático: no hay "Vencimiento" sino "A debitar el [fecha]"
 *   - Caso pago normal: "Vencimiento [fecha]" en encabezado grande + "Total a pagar hasta [fecha]"
 *   - Consorcio = "Domicilio de Prestación del Servicio" (calle y número del inmueble)
 *   - boletaNumber = número largo tipo "0106A11487223"
 */
function buildUtilityBillPrompt(relevantText: string): string {
  return [
    "Extrae datos de una Liquidación de Servicios Públicos (LSP) argentina.",
    "Responde SOLO JSON con EXACTAMENTE estas claves y tipos:",
    JSON.stringify(OUTPUT_JSON_TEMPLATE, null, 2),

    "=== REGLAS PARA LSP (luz, gas, agua) ===",

    "- provider: nombre de la EMPRESA DE SERVICIOS emisora. Es el logo/encabezado principal.",
    "  Ejemplos: 'EDESUR', 'EDENOR', 'AYSA', 'METROGAS', 'NATURGY', 'CAMUZZI'.",

    "- providerTaxId: CUIT de la EMPRESA DE SERVICIOS. En facturas de AySA y similares:",
    "    • El CUIT de la empresa está en su bloque de datos (junto a nombre, IIBB, inicio de actividades).",
    "      Ej AySA: 'CUIT Nº 30-70956507-5'",
    "    • Al final del documento puede aparecer 'IVA RESPONSABLE INSCRIPTO - CUIT No. XX-XXXXXXXX-X'",
    "      — ese es el CUIT del CLIENTE (consorcio), NO de la empresa. Ignorarlo.",
    "  Si no podés identificar el CUIT de la empresa con certeza: null.",

    "- consortium: dirección del INMUEBLE donde se presta el servicio.",
    "  Buscarlo en 'Domicilio de Prestación del Servicio' o dirección del cliente.",
    "  Extraer solo calle y número principal (sin piso, depto, CP, localidad).",
    "  Ejemplos: 'FRAY JUSTO SANTAMARIA DE ORO 02178 001' → 'FRAY JUSTO SANTAMARIA DE ORO 2178'",
    "            'CASTILLO 00246 C1414AWF CAPITAL FEDERAL' → 'CASTILLO 246'",
    "            'SAN ANTONIO 345 PB A' → 'SAN ANTONIO 345'",

    "- boletaNumber: número de la liquidación.",
    "  En AySA tiene formato alfanumérico: '0106A11487223'. Tomarlo tal cual.",

    "- amount: monto total a pagar en el PRIMER vencimiento.",
    "  Ignorar 2° y 3° vencimiento (tienen recargo).",
    "  En débito automático, usar el monto de 'Total a debitar $XXX' o 'A debitar el [fecha] $XXX'.",
    "  Formato numérico (ej: 798400.87).",

    "- dueDate: fecha de pago. YYYY-MM-DD. Reglas estrictas:",
    "  VÁLIDO:",
    "    ✓ 'Vencimiento [fecha]' o 'Vencimiento [fecha] Total a pagar $XXX' — es la fecha de pago.",
    "    ✓ 'Total a pagar hasta el [fecha]' — explícitamente de pago.",
    "    ✓ 'A debitar el [fecha]' — en débito automático, es la fecha en que se cobra.",
    "  INVÁLIDO — siempre null:",
    "    ✗ 'C.E.S.P: XXXXX | Fecha Vto: [fecha]' — el Fecha Vto es del código CESP,",
    "       NO de pago. Es una fecha interna de AySA/EDESUR para sistemas de cobro electrónico.",
    "    ✗ 'Fecha de emisión' — es cuando se generó el documento.",
    "    ✗ 'Próxima liquidación vence el [fecha]' — es del próximo mes, no de esta factura.",
    "    ✗ Fechas de 2° o 3° vencimiento con recargo.",
    "  Si no existe ningún caso válido: null.",

    "- detail: tipo de servicio (ej: 'Agua y cloacas', 'Energía eléctrica', 'Gas natural').",

    "Texto de la liquidación:",
    relevantText,
  ].join("\n\n");
}

function normalizeModelOutput(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  return trimmed;
}

export function parseExtractionOutput(raw: string): ExtractedDocumentData {
  const normalized = normalizeModelOutput(raw || "{}");
  const parsed = JSON.parse(normalized);
  return EXTRACTED_DOCUMENT_SCHEMA.parse(parsed);
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitNonEmptyLines(text: string): string[] {
  return text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => normalizeLine(line))
    .filter((line) => line.length > 0);
}

function hasLetters(value: string): boolean {
  return /[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(value);
}

function isNumericLikeLine(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  return /^[\d\-./]+$/.test(compact);
}

function isMetadataLine(value: string): boolean {
  return /^(cuit|iva|fecha|cae|comprobante|subtotal|total|domicilio|condici[oó]n|ingresos|inicio|punto de venta|c[oó]digo|regimen|otros impuestos|hys)\b/i.test(
    value
  );
}

function normalizeConsortiumValue(value: string): string {
  const noPrefix = value.replace(/^raz.{0,2}n\s*social\s*:\s*/i, "");
  return normalizeLine(noPrefix);
}

function needsConsortiumEnrichment(consortium: string | null | undefined): boolean {
  if (!consortium) {
    return true;
  }

  const normalized = normalizeLine(consortium)
    .replace(/[.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return /^(cons|consorcio)(\s+de)?\s+prop(ietarios)?$/.test(normalized);
}

function inferConsortiumFromText(text: string): string | null {
  const lines = splitNonEmptyLines(text);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lower = line.toLowerCase();
    const socialIndex = lower.indexOf("social");
    const colonIndex = line.indexOf(":");

    if (socialIndex < 0 || colonIndex < 0 || colonIndex >= line.length - 1) {
      continue;
    }

    const base = normalizeConsortiumValue(line.slice(colonIndex + 1));
    if (!base) {
      continue;
    }

    if (!needsConsortiumEnrichment(base)) {
      return base;
    }

    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const candidate = normalizeLine(lines[j]);
      if (!candidate) {
        continue;
      }

      if (isMetadataLine(candidate) || isNumericLikeLine(candidate) || !hasLetters(candidate)) {
        continue;
      }

      return `${base} ${candidate}`.trim();
    }

    return base;
  }

  return null;
}

export function refineExtractionWithRawText(
  extracted: ExtractedDocumentData,
  rawText: string
): ExtractedDocumentData {
  // Para LSPs no aplicar el refinamiento de consorcio por "Razón Social:"
  // porque esa sección puede pertenecer al cliente, no al consorcio
  if (isUtilityBill(rawText)) {
    return extracted;
  }

  const inferredConsortium = inferConsortiumFromText(rawText);
  if (!inferredConsortium) {
    return extracted;
  }

  const currentConsortium = extracted.consortium ? normalizeLine(extracted.consortium) : null;
  const shouldReplace =
    needsConsortiumEnrichment(currentConsortium) ||
    !currentConsortium ||
    inferredConsortium.length > currentConsortium.length;

  if (!shouldReplace) {
    return extracted;
  }

  return {
    ...extracted,
    consortium: inferredConsortium,
  };
}
