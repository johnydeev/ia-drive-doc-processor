/**
 * Validaciones de documento para el pipeline (funciones puras, testeables).
 * - isMissingAmount: distingue "no hay monto" (null) de un monto $0 válido.
 * - cuitAppearsInText: detecta CUIT inventado (no presente en el texto del doc).
 * - appendNoAmountTag: etiqueta el nombre del archivo sin monto.
 */

/** true si NO hay monto extraíble (nullish). `0` es un monto válido → false. */
export function isMissingAmount(amount: number | null | undefined): boolean {
  return amount === null || amount === undefined;
}

/**
 * ¿Los dígitos del CUIT aparecen en el texto del documento? Normaliza ambos a
 * solo dígitos (tolera guiones/espacios). CUIT real = 11 dígitos; por debajo de
 * 10 no se considera (evita matches triviales).
 */
export function cuitAppearsInText(cuit: string | null | undefined, text: string): boolean {
  const c = (cuit ?? "").replace(/\D/g, "");
  if (c.length < 10) return false;
  const t = (text ?? "").replace(/\D/g, "");
  return t.includes(c);
}

/** Agrega " - SIN MONTO" antes de la extensión del nombre actual del archivo. */
export function appendNoAmountTag(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return `${fileName} - SIN MONTO`;
  return `${fileName.slice(0, dot)} - SIN MONTO${fileName.slice(dot)}`;
}
