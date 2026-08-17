/** Los tres tipos de proveedor del catálogo. Espeja `enum ProviderType` de Prisma. */
export type ProviderTypeValue = "PROVEEDOR" | "EMPLEADO" | "SERVICIO";

/**
 * Traduce la columna "TIPO" (E) de la hoja `_Proveedores` a un valor del enum.
 *
 * Ante una celda vacía o un texto que no reconocemos devuelve `PROVEEDOR`, que es
 * el default de la columna en la base: un dato mal escrito no convierte a un
 * proveedor en empleado ni en empresa de servicios.
 */
export function parseProviderType(raw: string | null | undefined): ProviderTypeValue {
  const value = raw?.trim().toUpperCase();
  if (value === "EMPLEADO") return "EMPLEADO";
  if (value === "SERVICIO") return "SERVICIO";
  return "PROVEEDOR";
}
