/**
 * Decide si los encabezados de una hoja del ALTA hay que reescribirlos.
 *
 * El sync lee por POSICIÓN, no por nombre de columna, así que los encabezados
 * son informativos: corregirlos no puede romper la lectura. Se comparan sin
 * distinguir mayúsculas ni espacios, y una columna extra a la derecha (algo que
 * el usuario haya agregado por su cuenta) no se considera diferencia.
 */
export function headersNeedUpdate(actual: string[], expected: string[]): boolean {
  const norm = (v: string | undefined) => (v ?? "").trim().toUpperCase();
  return expected.some((exp, i) => norm(actual[i]) !== norm(exp));
}
