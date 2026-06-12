/**
 * Fuente ÚNICA de verdad para CUIT en todo el sistema.
 *
 * Regla general: los CUITs pueden venir en cualquier formato (con guiones, con
 * espacios, con puntos, crudos) según el origen (boleta, IA, ALTA, Excel, alta
 * manual). Por eso:
 *  - Para COMPARAR: siempre por dígitos (`cuitDigits` / `cuitsEqual`).
 *  - Para GUARDAR/MOSTRAR: siempre el formato canónico `XX-XXXXXXXX-X`
 *    (`formatCuit`), p. ej. "20-94037036-2".
 *  - Para EXTRAER de texto: `extractCuitsFromText` (regex + checksum mod-11,
 *    determinístico — no depende de la IA).
 *
 * Nunca duplicar normalizadores locales: importar de acá.
 */

/** Solo los dígitos del valor ("" si null/undefined). Base de toda comparación. */
export function cuitDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/** Verificación mod-11 del dígito verificador (sobre 11 dígitos exactos). */
function hasValidChecksum(digits: string): boolean {
  if (digits.length !== 11) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(digits[i]), 0);
  const mod = sum % 11;
  const expected = mod === 0 ? 0 : mod === 1 ? 9 : 11 - mod;
  return Number(digits[10]) === expected;
}

/** true si el valor es un CUIT real: 11 dígitos + checksum mod-11 válido. */
export function isValidCuit(value: string | null | undefined): boolean {
  return hasValidChecksum(cuitDigits(value));
}

/**
 * Normaliza al formato canónico `XX-XXXXXXXX-X` (el formato de la DB).
 * Devuelve null si el valor no tiene exactamente 11 dígitos — el caller decide
 * el fallback (p. ej. guardar el crudo). No exige checksum: un CUIT cargado a
 * mano con un error de tipeo igual se formatea (rechazarlo es decisión de UI).
 */
export function formatCuit(value: string | null | undefined): string | null {
  const digits = cuitDigits(value);
  if (digits.length !== 11) return null;
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

/** Igualdad de CUITs ignorando formato. false si alguno queda vacío. */
export function cuitsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = cuitDigits(a);
  const db = cuitDigits(b);
  return da.length > 0 && da === db;
}

/** Prefijos de CUIT válidos en Argentina (personas físicas y jurídicas). */
const CUIT_PREFIX_RE = "(?:2[034567]|3[034])";

/**
 * Candidatos a CUIT en texto libre: prefijo válido + 8 dígitos + verificador,
 * con separadores opcionales (guión, punto o espacio). `\b` evita matchear
 * dentro de números más largos (CAE de 14 dígitos, secuencias de 12, etc.).
 */
const CUIT_CANDIDATE_RE = new RegExp(
  `\\b${CUIT_PREFIX_RE}[-.\\s]?\\d{8}[-.\\s]?\\d\\b`,
  "g"
);

/**
 * Extrae TODOS los CUITs válidos presentes en el texto, normalizados a 11
 * dígitos y deduplicados. Determinístico (regex + checksum mod-11): no depende
 * de la IA y no puede "inventar" un CUIT que no esté en el papel.
 *
 * Motivación (visto en prod): la IA puede omitir CUITs o malformatearlos (listó
 * solo el del consorcio y con un dígito de más → `allTaxIds` quedó vacío tras el
 * saneo → un proveedor correctamente cargado no matcheó). Este extractor
 * complementa a la IA con los CUITs reales del documento.
 */
export function extractCuitsFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const match of text.match(CUIT_CANDIDATE_RE) ?? []) {
    const digits = cuitDigits(match);
    if (hasValidChecksum(digits)) {
      found.add(digits);
    }
  }
  return [...found];
}
