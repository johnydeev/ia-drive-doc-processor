/**
 * Decisión de si un rubro o coeficiente se puede asignar a un gasto fijo.
 *
 * La cadena de rubros y coeficientes tiene tres capas (spec 2026-09-24):
 * catálogo del cliente → lo que el edificio tiene asignado → lo que lleva el gasto
 * fijo. Cada capa sólo ofrece lo que habilitó la anterior, y este es el guardián de
 * la última.
 *
 * Es puro a propósito: es lo único con lógica de las tres capas, y así se prueba sin
 * base de datos. Los endpoints traen los ids asignados y delegan la decisión acá.
 */
export type AssignmentKind = "rubro" | "coeficiente";

export type AssignmentCheck = { ok: true } | { ok: false; error: string };

export function checkAssignable(
  id: string | null,
  assignedToConsortium: string[],
  kind: AssignmentKind
): AssignmentCheck {
  // Desasignar siempre vale: un gasto fijo sin etiqueta es un estado legítimo —de
  // hecho es el estado inicial de los ~725 del padrón.
  if (id == null) return { ok: true };
  if (assignedToConsortium.includes(id)) return { ok: true };
  return { ok: false, error: `Ese ${kind} no está asignado a este edificio` };
}

/**
 * Filtro "todo lo que NO está en `keepIds`", para borrar las asignaciones que el
 * usuario destildó.
 *
 * Existe por una trampa de Prisma: **`notIn: []` matchea CERO filas, no todas**.
 * Escrito ingenuamente, destildar TODAS las casillas de un edificio no borraba
 * nada. Con la lista vacía hay que omitir la condición entera para que el
 * `deleteMany` alcance a todas las filas del consorcio.
 */
export function excludeAssigned(keepIds: string[]): { notIn: string[] } | undefined {
  return keepIds.length > 0 ? { notIn: keepIds } : undefined;
}

/**
 * Filtro de los gastos fijos que quedan huérfanos: tienen etiqueta y su etiqueta ya
 * no está entre las que el edificio conserva. Misma trampa del `notIn: []`.
 */
export function orphanedBy(keepIds: string[]): { not: null; notIn?: string[] } {
  return keepIds.length > 0 ? { not: null, notIn: keepIds } : { not: null };
}
