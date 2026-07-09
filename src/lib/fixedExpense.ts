/** Objetivo de un gasto fijo: exactamente uno de provider / lspService. */
export interface FixedExpenseTarget {
  providerId: string | null;
  lspServiceId: string | null;
}

/**
 * Valida que un gasto fijo apunte a EXACTAMENTE un objetivo.
 * Devuelve un mensaje de error, o null si es válido.
 */
export function validateFixedExpenseTarget(t: FixedExpenseTarget): string | null {
  const hasProvider = Boolean(t.providerId);
  const hasLsp = Boolean(t.lspServiceId);
  if (!hasProvider && !hasLsp) {
    return "El gasto fijo debe apuntar a un proveedor o un servicio (LSP).";
  }
  if (hasProvider && hasLsp) {
    return "El gasto fijo debe apuntar a uno solo: proveedor o servicio, no ambos.";
  }
  return null;
}

/**
 * ¿La boleta cumple la obligación de este gasto fijo?
 * - Gasto LSP  → matchea por lspServiceId.
 * - Gasto por proveedor → matchea por providerId.
 */
export function obligationMatchesInvoice(
  target: FixedExpenseTarget,
  invoice: { providerId: string | null; lspServiceId: string | null }
): boolean {
  if (target.lspServiceId) {
    return Boolean(invoice.lspServiceId) && invoice.lspServiceId === target.lspServiceId;
  }
  if (target.providerId) {
    return Boolean(invoice.providerId) && invoice.providerId === target.providerId;
  }
  return false;
}
