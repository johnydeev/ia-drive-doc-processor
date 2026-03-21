const CONSORTIUM_PREFIXES: RegExp[] = [
  /^\s*CONSORCIO\s+DE\s+COPROPIETARIOS\b[\s.:,-]*/i,
  /^\s*CONSORCIO\s+DE\s+PROPIETARIOS\b[\s.:,-]*/i,
  /^\s*CONSORCIO\s+COPROPIETARIOS\b[\s.:,-]*/i,
  /^\s*CONSORCIO\s+PROPIETARIOS\b[\s.:,-]*/i,
  /^\s*CONS\.\s*COPROPIET\.?\b[\s.:,-]*/i,
  /^\s*CONS\.\s*PROPIET\.?\b[\s.:,-]*/i,
  /^\s*CONS\.\s*PROP\.?\b[\s.:,-]*/i,
  /^\s*CONSORCIO\s+CALLE\b[\s.:,-]*/i,
  /^\s*CONSORCIO\b[\s.:,-]*/i,
];

/** Tipo de vía al inicio del nombre de calle */
const STREET_TYPE_RE =
  /^\s*(?:AV(?:DA?)?|AVENIDA|CALLE|BLVD|BOULEVARD|DIAGONAL|DIAG|PASAJE|PJE|RUTA|RN|RPC|AUTOPISTA|ACCESO|CAMINO|COSTANERA)\.?\s+/i;

/** Palabras ruido entre el nombre y el número */
const NOISE_WORDS_RE = /\b(?:NUMEROS?|N[RU]OS?\.?|N[º°]\.?|NUM\.?)\s*/gi;

/** Sufijos no significativos después del número */
const NUMBER_SUFFIX_RE =
  /^(\d+)(?:[-/]\d+)*(?:\s+(?:CAPITAL\s+\w+|PISO\s+\d+|PB|PA|[A-Z]{1,2}))?/i;

/**
 * Abreviaturas comunes de nombres de calle en Argentina.
 * Expandirlas antes de comparar mejora el matching entre
 * el nombre registrado y el que aparece en facturas de servicios.
 *
 * Ej: Edesur escribe "BROWN ALMTE AV 708"
 *     DB tiene   "ALMIRANTE BROWN 706"
 *     → expandir ALMTE → ALMIRANTE mejora el fuzzy match de palabras
 */
const STREET_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bALMTE\.?\b/gi,    "ALMIRANTE"],
  [/\bGRAL\.?\b/gi,     "GENERAL"],
  [/\bGRL\.?\b/gi,      "GENERAL"],
  [/\bCNEL\.?\b/gi,     "CORONEL"],
  [/\bCORONEL\.?\b/gi,  "CORONEL"],  // ya está completo, no hace daño
  [/\bDR\.?\b/gi,       "DOCTOR"],
  [/\bING\.?\b/gi,      "INGENIERO"],
  [/\bPRES\.?\b/gi,     "PRESIDENTE"],
  [/\bSTA\.?\b/gi,      "SANTA"],
  [/\bSTO\.?\b/gi,      "SANTO"],
  [/\bSAN\b/gi,         "SAN"],       // no expandir, ya está completo
  [/\bBV\.?\b/gi,       "BOULEVARD"],
  [/\bHNOS\.?\b/gi,     "HERMANOS"],
  [/\bGOB\.?\b/gi,      "GOBERNADOR"],
  [/\bTTE\.?\b/gi,      "TENIENTE"],
  [/\bCAP\.?\b/gi,      "CAPITAN"],
  [/\bMARTIN\b/gi,      "MARTIN"],    // para GRAL SAN MARTIN etc.
];

function expandAbbreviations(value: string): string {
  let result = value;
  for (const [pattern, replacement] of STREET_ABBREVIATIONS) {
    result = result.replace(pattern, replacement);
  }
  return normalizeSpaces(result);
}

function stripConsortiumPrefix(value: string): string {
  let result = value;
  for (const pattern of CONSORTIUM_PREFIXES) {
    result = result.replace(pattern, "");
  }
  return result.trim();
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Simplifica a tokens para comparación fuzzy.
 */
function toTokens(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-ZÁÉÍÓÚÑ0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractStreetAndNumber(value: string): string | null {
  const withoutType  = value.replace(STREET_TYPE_RE, "").trim();
  const withoutNoise = withoutType.replace(NOISE_WORDS_RE, "").trim();
  const match = withoutNoise.match(/^(.*?)(\d[\d\-/]*)/);
  if (!match) return null;
  const street = normalizeSpaces(match[1]);
  if (!street) return null;
  const numMatch = match[2].match(NUMBER_SUFFIX_RE);
  const number = numMatch ? numMatch[1] : match[2].split(/[-/]/)[0];
  if (!number) return null;
  return normalizeSpaces(`${street} ${number}`);
}

/**
 * Normaliza el nombre de un consorcio para comparación en DB.
 * Incluye expansión de abreviaturas de calles.
 *
 * Ejemplos:
 *   "CONSORCIO DE PROPIETARIOS AV PUEYRREDON 2418"             → "PUEYRREDON 2418"
 *   "CONSORCIO DE COPROPIETARIOS THAMES NUMEROS 647-649 CAP F" → "THAMES 647"
 *   "BROWN ALMTE AV 708"                                       → "ALMIRANTE BROWN 708"
 *   "CONS. PROPIET. JUFRE 37/39/41"                            → "JUFRE 37"
 */
export function normalizeConsortiumName(rawName: string): string {
  const trimmed = rawName?.trim() ?? "";
  if (!trimmed) return "";

  // 1. Quitar prefijo de consorcio
  const noPrefix = stripConsortiumPrefix(trimmed) || trimmed;

  // 2. Expandir abreviaturas de calles
  const expanded = expandAbbreviations(noPrefix);

  // 3. Extraer calle (sin tipo de vía) + número
  const extracted = extractStreetAndNumber(expanded);
  if (extracted) return extracted.toUpperCase();

  const fallback = normalizeSpaces(expanded.replace(STREET_TYPE_RE, "").trim() || expanded);
  return fallback.toUpperCase();
}

export function areConsortiumNamesSimilar(a: string, b: string): boolean {
  const na = normalizeConsortiumName(a);
  const nb = normalizeConsortiumName(b);
  if (!na || !nb) return false;
  return na === nb;
}

/**
 * Búsqueda fuzzy con expansión de abreviaturas.
 *
 * Verifica si todos los tokens del nombre canónico de la DB
 * aparecen dentro del raw del OCR (ambos expandidos).
 *
 * Ejemplo 1 — nombre idéntico:
 *   canonicalDB = "THAMES 647"
 *   rawOcr      = "CONSORCIO DE COPROPIETARIOS THAMES NUMEROS 647-649 CAPITAL F"
 *   → tokens ["THAMES","647"] presentes → true
 *
 * Ejemplo 2 — abreviatura en OCR:
 *   canonicalDB = "ALMIRANTE BROWN 706"
 *   rawOcr      = "BROWN ALMTE AV 708"
 *   rawExpanded = "BROWN ALMIRANTE AV 708"
 *   → tokens ["ALMIRANTE","BROWN"] presentes, pero "706" ≠ "708" → false
 *   → en este caso el admin debe registrar un alias en el consorcio
 */
export function consortiumFuzzyMatch(rawOcr: string, canonicalDB: string): boolean {
  if (!rawOcr || !canonicalDB) return false;

  // Expandir abreviaturas en ambos lados antes de tokenizar
  const rawExpanded = expandAbbreviations(rawOcr);
  const dbExpanded  = expandAbbreviations(canonicalDB);

  const rawTokens = toTokens(rawExpanded);
  const dbTokens  = toTokens(dbExpanded).split(" ").filter(Boolean);

  return dbTokens.every((token) => rawTokens.includes(token));
}

/**
 * Intenta match contra aliases del consorcio.
 * Cada alias se normaliza igual que el nombre canónico.
 */
export function consortiumAliasMatch(rawOcr: string, aliases: string[]): boolean {
  if (!rawOcr || !aliases.length) return false;
  const normOcr = normalizeConsortiumName(rawOcr);
  const rawExpanded = expandAbbreviations(rawOcr);

  for (const alias of aliases) {
    // Match exacto normalizado
    if (normOcr === normalizeConsortiumName(alias)) return true;
    // Fuzzy: todos los tokens del alias aparecen en el OCR expandido
    const aliasExpanded = expandAbbreviations(alias);
    const aliasTokens = toTokens(aliasExpanded).split(" ").filter(Boolean);
    if (aliasTokens.length > 0 && aliasTokens.every((t) => toTokens(rawExpanded).includes(t))) {
      return true;
    }
  }
  return false;
}
