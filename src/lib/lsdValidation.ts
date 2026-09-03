import { cuitDigits } from "@/lib/cuit";
import type { LsdEmployee } from "@/lib/lsdExtraction";

export type LsdRosterResult =
  | { ok: true; matched: Array<{ employee: LsdEmployee; providerId: string }> }
  | { ok: false; reasonCategory: string; detail: string };

/**
 * El libro entra completo o no entra
 * (spec `2026-09-01-lsd-un-libro-n-empleados-design.md` §3.5).
 *
 * Dos condiciones, ambas obligatorias:
 *
 *  1. **Todos los CUIL del libro están dados de alta** como proveedor `EMPLEADO`.
 *     Cubre el suplente que aparece sin haberse cargado antes.
 *  2. **Los empleados del libro cubren todos los gastos fijos activos** del
 *     consorcio. Sin esto, si la IA se saltea a un empleado el edificio queda con
 *     un sueldo de menos y nada lo marca: el sistema nunca supo que existía.
 *
 * `fixedExpenseProviderIds` es el padrón del edificio y es la **única fuente
 * exacta** de cuántos empleados tiene: el papel no lo declara, y contar los CUIL
 * del texto es ruidoso (el libro está lleno de números largos que pasan el
 * checksum por casualidad).
 *
 * Un edificio sin gastos fijos cargados no tiene padrón contra el cual comparar,
 * así que la segunda condición no aplica y decide sólo la primera.
 */
export function validateLsdRoster(
  empleados: LsdEmployee[],
  directorio: Array<{ id: string; cuit: string | null }>,
  fixedExpenseProviderIds: string[]
): LsdRosterResult {
  if (empleados.length === 0) {
    return {
      ok: false,
      reasonCategory: "lsd_sin_empleados",
      detail: "el libro no trae empleados con CUIL y monto",
    };
  }

  const byCuil = new Map<string, string>();
  for (const provider of directorio) {
    const digits = cuitDigits(provider.cuit ?? "");
    if (digits) byCuil.set(digits, provider.id);
  }

  const matched: Array<{ employee: LsdEmployee; providerId: string }> = [];
  const desconocidos: string[] = [];

  for (const employee of empleados) {
    const providerId = byCuil.get(cuitDigits(employee.cuil));
    if (providerId) matched.push({ employee, providerId });
    else desconocidos.push(employee.cuil);
  }

  if (desconocidos.length > 0) {
    return {
      ok: false,
      reasonCategory: "lsd_empleado_no_registrado",
      detail: `CUIL sin alta: ${desconocidos.join(", ")}`,
    };
  }

  const cubiertos = new Set(matched.map((m) => m.providerId));
  const faltantes = fixedExpenseProviderIds.filter((id) => !cubiertos.has(id));

  if (faltantes.length > 0) {
    return {
      ok: false,
      reasonCategory: "lsd_empleado_faltante",
      detail: `el libro no cubre ${faltantes.length} gasto(s) fijo(s) de empleado del edificio`,
    };
  }

  return { ok: true, matched };
}
