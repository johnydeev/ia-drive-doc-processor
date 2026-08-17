/**
 * Alias de pago de un proveedor: hasta 3 valores en un mismo campo, separados
 * por `|` — la misma convención que `matchNames`.
 *
 * Cada valor puede ser un alias o un CBU, indistintamente y sin validar el
 * formato: un CBU se reconoce a simple vista por sus 22 dígitos, así que la
 * columna del papel se titula "ALIAS - CBU" y acepta cualquiera de los dos.
 *
 * No confundir con `Consortium.bankAlias` / `Consortium.cbu`, que identifican la
 * cuenta del EDIFICIO (de dónde sale la plata). Esto es el destino del pago.
 */
export const MAX_PAYMENT_ALIASES = 3;

/** Separador con el que se muestran juntos en una sola celda. */
export const ALIAS_INLINE_SEPARATOR = " · ";

export function parsePaymentAliases(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split("|")
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, MAX_PAYMENT_ALIASES);
}

/** Para la celda de Google Sheets, que es de una sola línea. */
export function formatAliasesInline(raw: string | null | undefined): string {
  return parsePaymentAliases(raw).join(ALIAS_INLINE_SEPARATOR);
}
