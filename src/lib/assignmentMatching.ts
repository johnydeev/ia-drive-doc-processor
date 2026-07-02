import {
  normalizeConsortiumName,
  consortiumFuzzyMatch,
  consortiumAliasMatch,
} from "@/lib/consortiumNormalizer";
import { cuitDigits } from "@/lib/cuit";

/**
 * Estrategias de matching de consorcio y proveedor, extraídas del pipeline
 * (`resolveAssignment`) a funciones puras y testeables. Operan sobre arrays en
 * memoria (sin DB) y devuelven el match + el método usado, o null.
 *
 * El orden de los intentos replica exactamente el del pipeline original; el
 * logging y los mensajes de "no encontrado" quedan en el caller.
 */

export interface ConsortiumMatchRow {
  id: string;
  canonicalName: string;
  rawName: string;
  cuit: string | null;
  matchNames: string | null;
}

export interface ProviderMatchRow {
  id: string;
  canonicalName: string;
  cuit: string | null;
  matchNames: string | null;
  paymentAlias: string | null;
}

export interface MatchResult<T> {
  row: T;
  method: string;
}

/** CUIT/DNI normalizado: solo dígitos. Alias de cuitDigits (lib/cuit). */
export const normCuit = cuitDigits;

/** Nombre normalizado para comparación: minúsculas, sin sufijos legales ni puntuación. */
export function normName(v: string | null | undefined): string {
  const LEGAL_SUFFIXES =
    /\b(s\.?r\.?l\.?|s\.?a\.?|s\.?a\.?s\.?|s\.?c\.?s?\.?|s\.?h\.?|ltda?\.?|e\.?i\.?r\.?l\.?|s\.?a\.?u\.?)\b/gi;
  return (v ?? "")
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[.,\-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parsea el campo `matchNames` (alias separados por `|`). */
function parseMatchNames(matchNames: string | null): string[] {
  return (matchNames ?? "").split("|").map((n) => n.trim()).filter(Boolean);
}

/**
 * Desambiguación cuando VARIOS proveedores comparten el mismo CUIT (caso real:
 * SUTERH/FATERYH/SERACARH usan el CUIT recaudador de la Federación). Entre los
 * candidatos del CUIT se elige el que coincida por nombre/matchNames con el
 * nombre extraído del documento; si ninguno coincide, se mantiene el primero
 * (comportamiento estable previo).
 */
function pickByName(candidates: ProviderMatchRow[], rawName: string | null): ProviderMatchRow {
  if (candidates.length === 1) return candidates[0];
  const n = normName(rawName);
  if (n.length >= 3) {
    const byName = candidates.find(
      (p) =>
        normName(p.canonicalName) === n ||
        parseMatchNames(p.matchNames).some((m) => normName(m) === n) ||
        normName(p.canonicalName).includes(n) ||
        n.includes(normName(p.canonicalName))
    );
    if (byName) return byName;
  }
  return candidates[0];
}

/**
 * Matchea un consorcio en 4 niveles (en orden de confianza):
 *   0. CUIT (allTaxIds) — incluye CUITs alternativos en matchNames
 *   1. Nombre exacto normalizado
 *   2. Fuzzy (tokens del canonicalName presentes en el OCR)
 *   3. Alias (matchNames)
 */
export function matchConsortium(
  allConsortiums: ConsortiumMatchRow[],
  rawConsortium: string | null,
  allTaxIds: string[]
): MatchResult<ConsortiumMatchRow> | null {
  // Intento 0: match por CUIT (allTaxIds) — incluye CUITs alternativos en matchNames
  if (allTaxIds.length > 0) {
    for (const cuit of allTaxIds) {
      const found = allConsortiums.find((c) => {
        if (c.cuit && normCuit(c.cuit) === cuit) return true;
        return parseMatchNames(c.matchNames).some((alt) => {
          const normAlt = normCuit(alt);
          return normAlt.length >= 10 && normAlt === cuit;
        });
      });
      if (found) return { row: found, method: `CUIT (${cuit})` };
    }
  }

  // Intentos por nombre requieren rawConsortium
  if (rawConsortium) {
    const canonicalName = normalizeConsortiumName(rawConsortium);

    // Intento 1: match exacto por canonicalName
    const exact = allConsortiums.find((c) => c.canonicalName === canonicalName);
    if (exact) return { row: exact, method: "exacto" };

    // Intento 2: fuzzy match
    const fuzzy = allConsortiums.find((c) => consortiumFuzzyMatch(rawConsortium, c.canonicalName));
    if (fuzzy) return { row: fuzzy, method: "fuzzy" };

    // Intento 3: alias match
    const aliased = allConsortiums.find((c) =>
      consortiumAliasMatch(rawConsortium, parseMatchNames(c.matchNames))
    );
    if (aliased) return { row: aliased, method: "alias" };
  }

  return null;
}

/**
 * Matchea un proveedor. Por defecto **SOLO por CUIT** (2 niveles):
 *   0. CUIT (allTaxIds) — excluye el CUIT del consorcio
 *   1. CUIT del providerTaxId (legacy) — excluye el CUIT del consorcio
 * Sin match por CUIT → null (el caller manda la boleta a Sin Asignar).
 *
 * El match por NOMBRE (niveles 2 y 3) está **desactivado por defecto**: era la
 * fuente de asignaciones cruzadas — dos proveedores con prefijo común colisionaban
 * por el substring `slice(0,5)` (caso real: una factura de "ASCENSORES POTENZA" no
 * cargado se asignó a otro "ASCENSORES ..." que sí estaba en la DB). Ver
 * decisiones.md 2026-07-02.
 *
 * `allowNameMatch=true` reactiva los niveles 2 y 3 SOLO para el conjunto cerrado
 * de proveedores "CUIT del papel = consorcio" (sindicales SUTERH/FATERYH/SERACARH
 * y ARCA), que no tienen CUIT propio y por diseño se identifican por nombre. El
 * caller lo activa con `usesConsortiumCuit(lspProvider)`.
 *
 * La desambiguación por nombre DENTRO de un match por CUIT (`pickByName`, cuando
 * varios proveedores comparten CUIT) sigue activa siempre: no asigna por nombre,
 * solo elige entre candidatos que YA matchearon por CUIT.
 */
export function matchProvider(
  allProviders: ProviderMatchRow[],
  rawCuit: string | null,
  rawName: string | null,
  allTaxIds: string[],
  consortiumCuitNorm: string,
  allowNameMatch = false
): MatchResult<ProviderMatchRow> | null {
  const normOcrCuit = normCuit(rawCuit);
  const normOcrName = normName(rawName);

  // Intento 0: CUIT match usando allTaxIds, excluyendo CUIT del consorcio
  if (allTaxIds.length > 0) {
    const providerCuits = allTaxIds.filter((c) => c !== consortiumCuitNorm);
    for (const cuit of providerCuits) {
      const candidates = allProviders.filter((p) => normCuit(p.cuit) === cuit);
      if (candidates.length > 0) {
        return { row: pickByName(candidates, rawName), method: `CUIT allTaxIds (${cuit})` };
      }
    }
  }

  // Intento 1: CUIT normalizado de providerTaxId (legacy), excluyendo CUIT del consorcio
  if (normOcrCuit.length >= 10 && normOcrCuit !== consortiumCuitNorm) {
    const candidates = allProviders.filter((p) => normCuit(p.cuit) === normOcrCuit);
    if (candidates.length > 0) {
      return { row: pickByName(candidates, rawName), method: `CUIT providerTaxId (${normOcrCuit})` };
    }
  }

  // Niveles por NOMBRE: SOLO para sindicales/ARCA (sin CUIT propio). Para facturas
  // normales queda cortado acá → Sin Asignar (ver docstring).
  if (allowNameMatch) {
    // Intento 2: nombre / matchNames exacto
    if (normOcrName.length >= 3) {
      const found = allProviders.find((p) => {
        if (normName(p.canonicalName) === normOcrName) return true;
        return parseMatchNames(p.matchNames).some((n) => normName(n) === normOcrName);
      });
      if (found) return { row: found, method: `nombre exacto ("${normOcrName}")` };
    }

    // Intento 3: nombre parcial
    if (normOcrName.length >= 5) {
      const found = allProviders.find((p) =>
        normName(p.canonicalName).includes(normOcrName) ||
        normOcrName.includes(normName(p.canonicalName).slice(0, 5))
      );
      if (found) return { row: found, method: `nombre parcial ("${normOcrName}")` };
    }
  }

  return null;
}
