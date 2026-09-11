/**
 * VEP (Volante Electrónico de Pago) de ARCA — el cupón con el que un consorcio
 * paga las cargas sociales de su encargado.
 *
 * Prompt propio y no `buildArcaPrompt`: ese está escrito para la declaración
 * jurada F931 de dos páginas, donde el importe vive en la página 2. Un VEP es un
 * cupón simple con todos sus campos rotulados.
 *
 * Ver `docs/superpowers/specs/2026-09-03-vep-arca-como-gasto-design.md`.
 */
import { extractCuitsFromText } from "@/lib/cuit";

export function buildVepPrompt(text: string): string {
  return [
    "Sos un extractor de datos de un VEP (Volante Electrónico de Pago) de ARCA, Argentina.",
    "Devolvé SOLO JSON con esta forma:",
    '{ "boletaNumber": "...", "provider": "ARCA", "providerTaxId": null,',
    '  "consortium": null, "amount": 0, "dueDate": "YYYY-MM-DD|null",',
    '  "detail": "...", "observation": "...", "clientNumber": null,',
    '  "paymentMethod": null, "allTaxIds": ["XX-XXXXXXXX-X"], "isBoleta": true }',
    "",
    "- boletaNumber: el valor de 'Nro. VEP'.",
    '- provider: SIEMPRE la cadena "ARCA". No la deduzcas del papel.',
    "- providerTaxId: SIEMPRE null. ARCA no imprime su CUIT en el VEP.",
    "- consortium: SIEMPRE null. El VEP no imprime la dirección del inmueble; el edificio",
    "  se resuelve por el CUIT del contribuyente.",
    "- amount: el valor de 'Importe total a pagar' (el total, no los conceptos sueltos).",
    "- dueDate: el valor de 'Día de Expiración'.",
    "- detail: 'Descripción Reducida' y 'Período', separados por ' · '.",
    "- observation: el 'Período' de la obligación, tal como figura.",
    "- clientNumber: SIEMPRE null. Un VEP no tiene número de cliente; el 'Nro. VEP' ya va",
    "  en boletaNumber.",
    "- paymentMethod: null.",
    "",
    "- allTaxIds: SOLO el CUIT rotulado 'CUIT:' — es el del CONTRIBUYENTE, o sea el",
    "  consorcio que paga. Es el único CUIT que hay que devolver.",
    "- **NO uses ni devuelvas el número que figura en 'Generado por el Usuario'.** Es el",
    "  CUIT de quien generó el trámite (la administradora), NO el del contribuyente, y",
    "  aparece en todos los VEP. Confundirlos imputa el gasto a la persona equivocada.",
    "",
    "Texto del VEP:",
    text,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Clasificación por códigos de renglón (spec 2026-09-11)
// ═══════════════════════════════════════════════════════════════════════════

/** Palabra fija de la columna PROVEEDOR de `_LspServices` para la fila de retención. */
export const VEP_RETENCION_KEYWORD = "VEP RETENCION";

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
  return extractCuitsFromText(m[1])[0] ?? null;
}
