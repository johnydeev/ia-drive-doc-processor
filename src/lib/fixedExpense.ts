import type { DocKind } from "@prisma/client";

/** Objetivo de un gasto fijo: exactamente uno de provider / lspService. */
export interface FixedExpenseTarget {
  providerId: string | null;
  lspServiceId: string | null;
  /**
   * FACTURA (default) o RETENCION (spec 2026-09-17): la retención que el consorcio
   * le practica a la empresa es un gasto fijo aparte de su factura. Sólo un
   * proveedor puede tener retención.
   */
  kind?: DocKind;
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
  if (t.kind === "RETENCION" && !hasProvider) {
    return "La retención sólo aplica a un proveedor, no a un servicio (LSP).";
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
  invoice: { providerId: string | null; lspServiceId: string | null; docKind?: DocKind }
): boolean {
  // Una obligación sólo acepta boletas de su tipo: la factura y la retención de un
  // mismo proveedor conviven en el período sin pisarse (spec 2026-09-17). Sin tipo
  // de algún lado (callers viejos) se asume FACTURA.
  if ((target.kind ?? "FACTURA") !== (invoice.docKind ?? "FACTURA")) return false;
  if (target.lspServiceId) {
    return Boolean(invoice.lspServiceId) && invoice.lspServiceId === target.lspServiceId;
  }
  if (target.providerId) {
    return Boolean(invoice.providerId) && invoice.providerId === target.providerId;
  }
  return false;
}
