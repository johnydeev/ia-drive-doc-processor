import { cuitsEqual } from "@/lib/cuit";

/**
 * ¿El CUIT ya lo tiene otro registro del mismo cliente?
 *
 * La comparación es POR DÍGITOS (`cuitsEqual`), no por texto: la base tiene
 * formatos históricos mixtos, y si se comparara el string, `30711111111` y
 * `30-71111111-1` pasarían como distintos — el unique de Postgres tampoco los ve
 * como iguales, así que el duplicado entraría por la puerta de adelante.
 *
 * El CUIT es la identidad real de un proveedor o un edificio: la razón social
 * cambia (casamiento, cambio de denominación), el CUIT no.
 */
export function isDuplicateCuit(
  existing: ReadonlyArray<{ cuit: string | null }>,
  candidate: string | null | undefined
): boolean {
  if (!candidate) return false;
  return existing.some((row) => cuitsEqual(row.cuit, candidate));
}
