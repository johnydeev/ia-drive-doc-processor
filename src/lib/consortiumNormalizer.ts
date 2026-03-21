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
  [/\bCORONEL\.?\b/gi,  "CORONEL"],
  [/\bDR\.?\b/gi,       "DOCTOR"],
  [/\bING\.?\b/gi,      "INGENIERO"],
  [/\bPRES\.?\b/gi,     "PRESIDENTE"],
  [/\bSTA\.?\b/gi,      "SANTA"],
  [/\bSTO\.?\b/gi,      "SANTO"],
  [/\bSAN\b/gi,         "SAN"],
  [/\bBV\.?\b/gi,       "BOULEVARD"],
  [/\bHNOS\.?\b/gi,     "HERMANOS"],
  [/\bGOB\.?\b/gi,      "GOBERNADOR"],
  [/\bTTE\.?\b/gi,      "TENIENTE"],
  [/\bCAP\.?\b/gi,      "CAPITAN"],
  [/\bMARTIN\b/gi,      "MARTIN"],
  [/\bSGTO\.?\b/gi,     "SARGENTO"],
  [/\bCTE\.?\b/gi,      "COMANDANTE"],
  [/\bINT\.?\b/gi,      "INTENDENTE"],
  [/\bPROF\.?\b/gi,     "PROFESOR"],
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

/**
 * Quita ceros a la izquierda en números de calle.
 * LSPs como Edesur/AySA suelen formatear "00246" o "02178".
 *
 * Ej: "02178" → "2178", "00246" → "246", "0" → "0"
 */
function stripLeadingZeros(value: string): string {
  return value.replace(/\b0+(\d+)\b/g, "$1");
}

/**
 * Elimina sufijos numéricos extras que las LSPs agregan después del número
 * de calle (como código de suministro, piso codificado, etc.)
 *
 * Ej: "AV ALMIRANTE BROWN 706 018" → "AV ALMIRANTE BROWN 706"
 *     "FRAY JUSTO SANTAMARIA DE ORO 2178 001" → "FRAY JUSTO SANTAMARIA DE ORO 2178"
 *
 * Solo elimina si después del número principal hay otro número de 1-3 dígitos.
 */
function stripTrailingNumericSuffix(value: string): string {
  // Match: [calle] [número principal de 1-5 dígitos] [sufijo numérico de 1-3 dígitos al final]
  return value.replace(/^(.+\s\d{1,5})\s+\d{1,3}$/, "$1");
}

/**
 * Elimina código postal y localidad que pueden venir pegados al final.
 * Ej: "CASTILLO 246 C1414AWF CAPITAL FEDERAL" → "CASTILLO 246"
 */
function stripPostalAndLocality(value: string): string {
  // Código postal argentino: letra + 4 dígitos + 3 letras (C1414AWF) o solo dígitos (1414)
  return value
    .replace(/\s+[A-Z]\d{4}[A-Z]{3}\b.*$/i, "")  // C1414AWF + lo que siga
    .replace(/\s+\d{4}\s+(CAPITAL|BUENOS|CABA|CAPI)\b.*$/i, "")  // 1414 CAPITAL FEDERAL
    .replace(/\s+(CAPITAL\s+FEDERAL|CABA|BUENOS\s+AIRES|BS\.?\s*AS\.?)$/i, "")  // solo localidad
    .trim();
}

/**
 * Elimina piso/depto/unidad al final.
 * Ej: "SAN ANTONIO 345 PB A" → "SAN ANTONIO 345"
 *     "JUNCAL 1234 3 B"     → "JUNCAL 1234"
 */
function stripFloorUnit(value: string): string {
  return value
    .replace(/\s+(?:PB|PA|EP|SS|PISO\s*\d*|P\s*\d+|DPTO\.?\s*\w*|DTO\.?\s*\w*|UF\.?\s*\d*|UNID\.?\s*\w*)(?:\s+[A-Z])?$/i, "")
    .replace(/\s+\d{1,2}\s+[A-Z]$/i, "")  // "3 B" al final
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
 * Incluye expansión de abreviaturas de calles, limpieza de ceros
 * a la izquierda, sufijos numéricos, código postal y piso/depto.
 *
 * Ejemplos:
 *   "CONSORCIO DE PROPIETARIOS AV PUEYRREDON 2418"             → "PUEYRREDON 2418"
 *   "CONSORCIO DE COPROPIETARIOS THAMES NUMEROS 647-649 CAP F" → "THAMES 647"
 *   "BROWN ALMTE AV 708"                                       → "ALMIRANTE BROWN 708"
 *   "CONS. PROPIET. JUFRE 37/39/41"                            → "JUFRE 37"
 *   "AV ALMIRANTE BROWN 00706 018"                             → "ALMIRANTE BROWN 706"
 *   "FRAY JUSTO SANTAMARIA DE ORO 02178 001"                   → "FRAY JUSTO SANTAMARIA DE ORO 2178"
 *   "CASTILLO 00246 C1414AWF CAPITAL FEDERAL"                  → "CASTILLO 246"
 *   "SAN ANTONIO 345 PB A"                                     → "SAN ANTONIO 345"
 */
export function normalizeConsortiumName(rawName: string): string {
  const trimmed = rawName?.trim() ?? "";
  if (!trimmed) return "";

  // 1. Quitar prefijo de consorcio
  const noPrefix = stripConsortiumPrefix(trimmed) || trimmed;

  // 2. Expandir abreviaturas de calles
  const expanded = expandAbbreviations(noPrefix);

  // 3. Quitar ceros a la izquierda en números
  const noLeadingZeros = stripLeadingZeros(expanded);

  // 4. Quitar código postal y localidad
  const noPostal = stripPostalAndLocality(noLeadingZeros);

  // 5. Quitar piso/depto/unidad
  const noFloor = stripFloorUnit(noPostal);

  // 6. Quitar sufijos numéricos extras de LSPs
  const noSuffix = stripTrailingNumericSuffix(noFloor);

  // 7. Extraer calle (sin tipo de vía) + número
  const extracted = extractStreetAndNumber(noSuffix);
  if (extracted) return extracted.toUpperCase();

  const fallback = normalizeSpaces(noSuffix.replace(STREET_TYPE_RE, "").trim() || noSuffix);
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
 * aparecen dentro del raw del OCR (ambos expandidos y limpios).
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
 *
 * Ejemplo 3 — ceros a la izquierda en LSP:
 *   canonicalDB = "ALMIRANTE BROWN 706"
 *   rawOcr      = "ALMIRANTE BROWN 00706 018"
 *   rawCleaned  = "ALMIRANTE BROWN 706 18"
 *   → tokens ["ALMIRANTE","BROWN","706"] presentes → true
 */
export function consortiumFuzzyMatch(rawOcr: string, canonicalDB: string): boolean {
  if (!rawOcr || !canonicalDB) return false;

  // Expandir abreviaturas y limpiar ceros en ambos lados
  const rawExpanded = stripLeadingZeros(expandAbbreviations(rawOcr));
  const dbExpanded  = stripLeadingZeros(expandAbbreviations(canonicalDB));

  const rawTokens = toTokens(rawExpanded);
  const dbTokens  = toTokens(dbExpanded).split(" ").filter(Boolean);

  return dbTokens.every((token) => rawTokens.includes(token));
}

/**
 * Intenta match contra aliases del consorcio.
 * Cada alias se normaliza igual que el nombre canónico.
 *
 * Soporta matching en ambas direcciones:
 *  - rawOcr normalizado === alias normalizado (exacto)
 *  - Fuzzy: todos los tokens del alias aparecen en el OCR
 *  - Fuzzy inverso: todos los tokens del OCR normalizado aparecen en el alias
 */
export function consortiumAliasMatch(rawOcr: string, aliases: string[]): boolean {
  if (!rawOcr || !aliases.length) return false;
  const normOcr = normalizeConsortiumName(rawOcr);
  const rawExpanded = stripLeadingZeros(expandAbbreviations(rawOcr));

  for (const alias of aliases) {
    const aliasTrimmed = alias.trim();
    if (!aliasTrimmed) continue;

    // Match exacto normalizado
    const normAlias = normalizeConsortiumName(aliasTrimmed);
    if (normOcr && normAlias && normOcr === normAlias) return true;

    // Fuzzy: todos los tokens del alias aparecen en el OCR expandido
    const aliasExpanded = stripLeadingZeros(expandAbbreviations(aliasTrimmed));
    const aliasTokens = toTokens(aliasExpanded).split(" ").filter(Boolean);
    const rawTokensStr = toTokens(rawExpanded);

    if (aliasTokens.length > 0 && aliasTokens.every((t) => rawTokensStr.includes(t))) {
      return true;
    }

    // Fuzzy inverso: OCR normalizado matchea contra alias expandido
    // Útil cuando el OCR tiene menos info que el alias registrado
    if (normOcr) {
      const normOcrTokens = toTokens(normOcr).split(" ").filter(Boolean);
      const aliasTokensStr = toTokens(aliasExpanded);
      if (normOcrTokens.length > 0 && normOcrTokens.every((t) => aliasTokensStr.includes(t))) {
        return true;
      }
    }
  }
  return false;
}
