/**
 * Guard del "IVA contenido" (Régimen de Transparencia Fiscal al Consumidor, Ley 27.743)
 * tomado por error como monto total.
 *
 * Problema real (boleta 0003-00161074, RANKO S.R.L. → BARTOLOME MITRE 1225):
 * se guardó $62.601,88 cuando el total de la factura era $360.706,09. El número
 * guardado es exactamente el IVA contenido: 360706.09 × 21/121 = 62601.88.
 *
 * Dos causas se combinan:
 *   1. El importe total NO tiene rótulo de texto — la palabra "TOTAL" es parte del
 *      formulario preimpreso (imagen). En el texto extraído es un número suelto.
 *   2. `pdf-parse` lineariza el PDF en un orden que HUERFANIZA los valores: en el
 *      PDF "IVA Contenido: $" y "62601.88" están en la misma línea física, pero en
 *      el texto quedan a 16 líneas de distancia (rótulo vacío arriba, número abajo).
 *
 * La IA recibe rótulos vacíos y números sueltos, sin forma de atarlos, y elige mal.
 * El bloque de la Ley 27.743 es obligatorio en toda factura a consumidor final desde
 * 2025, así que la trampa se repite.
 *
 * Este guard NO adivina layout: usa una identidad aritmética que es prácticamente una
 * prueba. Solo corrige cuando se cumplen las CUATRO condiciones a la vez (ver abajo).
 * Ante cualquier duda es un no-op y se respeta lo que extrajo la IA.
 *
 * Función pura e idempotente. Ver `docs/superpowers/specs/2026-07-27-guard-iva-contenido-ley-27743-design.md`.
 */

/** Marcadores del Régimen de Transparencia Fiscal al Consumidor (condición 1). */
const LEY_27743_MARKERS = [
  /Ley\s*27\.?\s*743/i,
  /IVA\s+Contenido/i,
  /Otros\s+Impuestos\s+Nacionales\s+Indirectos/i,
];

/**
 * Tasas de IVA contempladas. 27% queda excluido a propósito: aplica a servicios a
 * responsables inscriptos, no al régimen de transparencia a consumidor final, y cada
 * tasa extra amplía la superficie de falso positivo.
 */
const VAT_RATES = [0.21, 0.105] as const;

/** Tolerancia absoluta en pesos para la identidad aritmética (redondeo a centavos). */
const TOLERANCE = 0.05;

/**
 * Importes en el texto. Se exigen SIEMPRE 2 decimales: sin eso, un CAE o un código de
 * barras (secuencias largas de dígitos sin separador decimal) se colaría como importe.
 *   - es-AR con miles:  360.706,09
 *   - es-AR simple:     62601,88
 *   - en-US con miles:  360,706.09
 *   - punto decimal:    360706.09
 */
const AMOUNT_PATTERN = /\d{1,3}(?:\.\d{3})+,\d{2}|\d{1,3}(?:,\d{3})+\.\d{2}|\d+,\d{2}|\d+\.\d{2}/g;

export type VatGuardResult = {
  /** Monto final: el corregido si el guard disparó, el original si no. */
  amount: number | null;
  /** true solo si el guard efectivamente reemplazó el monto. */
  corrected: boolean;
  /** Monto que venía de la IA (solo cuando `corrected`). */
  original?: number;
  /** Tasa de IVA que hizo cerrar la identidad (solo cuando `corrected`). */
  rate?: number;
};

/** Convierte un importe textual (es-AR o en-US) a número. */
function parseAmount(raw: string): number {
  const hasCommaDecimals = /,\d{2}$/.test(raw);
  const normalized = hasCommaDecimals
    ? raw.replace(/\./g, "").replace(",", ".")   // es-AR: 360.706,09 → 360706.09
    : raw.replace(/,/g, "");                      // en-US: 360,706.09 → 360706.09
  return Number(normalized);
}

/** Todos los importes presentes en el texto, como números. */
function collectAmounts(text: string): number[] {
  const matches = text.match(AMOUNT_PATTERN);
  if (!matches) return [];
  return matches.map(parseAmount).filter((n) => Number.isFinite(n));
}

/**
 * Corrige el monto cuando la IA tomó el IVA contenido en vez del total.
 *
 * Corrige SOLO si se cumplen las cuatro condiciones:
 *   1. El texto tiene un marcador del Régimen de Transparencia Fiscal (Ley 27.743).
 *   2. La identidad aritmética cierra: |amount − max × r/(1+r)| ≤ 0,05 para alguna tasa.
 *   3. El candidato es la cifra máxima del documento (y por lo tanto aparece en él).
 *   4. El monto de la IA NO es la cifra máxima del documento.
 *
 * Si alguna falla → no-op.
 */
export function correctVatContainedAmount(amount: number | null, text: string): VatGuardResult {
  const noop: VatGuardResult = { amount, corrected: false };

  if (amount === null || !Number.isFinite(amount) || amount <= 0) return noop;
  if (!text) return noop;

  // Condición 1: marcador del régimen presente.
  if (!LEY_27743_MARKERS.some((re) => re.test(text))) return noop;

  const amounts = collectAmounts(text);
  if (amounts.length === 0) return noop;

  const max = Math.max(...amounts);

  // Condición 4 (y 3 implícita: el candidato es `max`, que sale del propio texto).
  if (amount >= max) return noop;

  // Condición 2: la identidad del IVA contenido cierra para alguna tasa.
  for (const rate of VAT_RATES) {
    const expectedVat = (max * rate) / (1 + rate);
    if (Math.abs(amount - expectedVat) <= TOLERANCE) {
      return { amount: max, corrected: true, original: amount, rate };
    }
  }

  return noop;
}
