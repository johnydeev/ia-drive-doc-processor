/**
 * Traslado de boletas al mes siguiente, por tandas.
 *
 * El movimiento no ocurre dentro del cierre del período: el cierre es
 * irreversible y tiene que ser rápido y atómico, mientras que mover boletas toca
 * Drive y Sheets (~2 s cada una) y es reintentable. Van separados, y la UI dispara
 * las tandas mostrando el avance (spec 2026-08-20).
 *
 * Lógica pura: acá vive el tope y su validación.
 */

/**
 * Boletas por tanda.
 *
 * A ~2 s cada una, una tanda son ~10 s: bien lejos de los 100 s que corta el
 * túnel. El límite del túnel es POR REQUEST, así que partiendo el trabajo el
 * total deja de tener techo.
 *
 * Tampoco conviene subirlo mucho: la API de Sheets permite 60 escrituras por
 * minuto y el ritmo secuencial de las tandas deja el margen cómodo.
 */
export const CARRY_OVER_BATCH_SIZE = 5;

export type BatchSelection =
  | { ok: true; invoiceIds: string[] }
  | { ok: false; error: string };

/**
 * Valida la tanda que mandó la UI.
 *
 * El tope se verifica en el servidor y no sólo en el cliente: un tope que vive
 * únicamente en el navegador no es un tope.
 */
export function validateCarryOverBatch(raw: unknown): BatchSelection {
  const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  const unique = [...new Set(ids)];

  if (unique.length === 0) return { ok: false, error: "No se recibió ninguna boleta" };
  if (unique.length > CARRY_OVER_BATCH_SIZE) {
    return { ok: false, error: `Máximo ${CARRY_OVER_BATCH_SIZE} boletas por tanda` };
  }
  return { ok: true, invoiceIds: unique };
}

/** Parte una lista de boletas en tandas del tamaño permitido. */
export function splitIntoBatches(invoiceIds: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < invoiceIds.length; i += CARRY_OVER_BATCH_SIZE) {
    batches.push(invoiceIds.slice(i, i + CARRY_OVER_BATCH_SIZE));
  }
  return batches;
}
