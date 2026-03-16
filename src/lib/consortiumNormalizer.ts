const PREFIX_PATTERNS: RegExp[] = [
  /^\s*CONSORCIO\s+DE\s+PROPIETARIOS\b[\s.:,-]*/i,
  /^\s*CONSORCIO\s+PROPIETARIOS\b[\s.:,-]*/i,
  /^\s*CONS\.\s*PROPIET\.?\b[\s.:,-]*/i,
  /^\s*CONS\.\s*PROP\.?\b[\s.:,-]*/i,
  /^\s*CONSORCIO\s+CALLE\b[\s.:,-]*/i,
  /^\s*CONSORCIO\b[\s.:,-]*/i,
];

function stripPrefixes(value: string): string {
  let result = value;
  for (const pattern of PREFIX_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result.trim();
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractStreetAndNumber(value: string): string | null {
  const match = value.match(/^(.*?)(\d+)/);
  if (!match) {
    return null;
  }

  const street = normalizeSpaces(match[1]);
  if (!street) {
    return null;
  }

  const rawNumber = match[2];
  const firstNumber = rawNumber.split("/")[0];
  if (!firstNumber) {
    return null;
  }

  return normalizeSpaces(`${street} ${firstNumber}`);
}

/**
 * Ejemplos:
 * - "CONS. PROP. CORONEL DIAZ 1503" -> "CORONEL DIAZ 1503"
 * - "CONSORCIO PROPIETARIOS AV GARAY 350 56" -> "AV GARAY 350"
 * - "CONS. PROPIET. JUFRE 37/39/41" -> "JUFRE 37"
 * - "CONSORCIO CALLE ARENALES 2154 56" -> "ARENALES 2154"
 * - "CONSORCIO DE PROPIETARIOS AV PUEYRREDON 2418" -> "AV PUEYRREDON 2418"
 */
export function normalizeConsortiumName(rawName: string): string {
  const trimmed = rawName?.trim() ?? "";
  if (!trimmed) {
    return "";
  }

  const withoutPrefixes = stripPrefixes(trimmed);
  const candidate = withoutPrefixes || trimmed;
  const extracted = extractStreetAndNumber(candidate);

  if (!extracted) {
    const fallback = normalizeSpaces(candidate);
    return fallback ? fallback.toUpperCase() : trimmed.toUpperCase();
  }

  return extracted.toUpperCase();
}

/**
 * Compara nombres normalizados ignorando espacios extra.
 */
export function areConsortiumNamesSimilar(a: string, b: string): boolean {
  const normalizedA = normalizeSpaces(normalizeConsortiumName(a));
  const normalizedB = normalizeSpaces(normalizeConsortiumName(b));

  if (!normalizedA || !normalizedB) {
    return false;
  }

  return normalizedA.toUpperCase() === normalizedB.toUpperCase();
}
