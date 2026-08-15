import { getPrismaClient } from "@/lib/prisma";
import {
  classifyTarget,
  loadInvoice,
  moveOneInvoiceToTarget,
  resolveMoveContext,
} from "@/lib/invoicePeriodMove";
import { applyCarryOverDbMove } from "@/lib/invoiceCarryOver";

export type CarryOverResult =
  | { ok: true; toLabel: string; invoiceId: string }
  | { ok: false; error: string; status: number };

/**
 * Pasa al período siguiente una boleta que quedó impaga.
 *
 * Recibe el **invoiceId**, no el de la obligación: la acción se dispara desde el
 * bloque "Impagas de meses anteriores", donde la boleta puede no tener obligación
 * visible (su período ya está cerrado).
 *
 * Reusa `moveOneInvoiceToTarget` —que mueve Drive → Sheets → DB, es idempotente y
 * compensa si algo falla— inyectando `applyCarryOverDbMove` por el seam
 * `ctx.applyDb`, para que la obligación de origen quede `CARRIED_OVER`
 * conservando su `invoiceId` en vez de vaciarse.
 */
export async function carryOverInvoice(
  clientId: string,
  invoiceId: string
): Promise<CarryOverResult> {
  const prisma = getPrismaClient();

  const state = await prisma.invoice.findFirst({
    where: { id: invoiceId, clientId },
    select: { id: true, isPaid: true, remainingBalance: true, amount: true },
  });
  if (!state) return { ok: false, error: "Boleta no encontrada", status: 404 };
  if (state.isPaid) return { ok: false, error: "La boleta ya está paga.", status: 409 };

  const invoice = await loadInvoice(prisma, clientId, invoiceId);
  if (!invoice) return { ok: false, error: "Boleta no encontrada", status: 404 };

  // El destino es el mes siguiente al de la boleta, y tiene que estar ACTIVE.
  const target = await classifyTarget(prisma, invoice);
  if ("skip" in target) {
    const motivo =
      target.skip === "destino_inexistente"
        ? "El período siguiente todavía no existe: cerrá el período primero."
        : target.skip === "destino_cerrado"
        ? "El período siguiente está cerrado."
        : target.skip === "sin_periodo"
        ? "La boleta no tiene período asignado."
        : "No se pudo determinar el período destino.";
    return { ok: false, error: motivo, status: 409 };
  }

  const resolved = await resolveMoveContext(clientId);
  if ("error" in resolved) return { ok: false, error: resolved.error, status: resolved.status };

  const ctx = {
    ...resolved.ctx,
    applyDb: (inv: { id: string; periodId: string | null }, periodId: string) =>
      applyCarryOverDbMove(prisma, inv, periodId),
  };

  const result = await moveOneInvoiceToTarget(ctx, clientId, invoice.id, target.periodId);
  if (!result.ok) {
    // El resultado del move distingue "salteada por una razón de negocio" de
    // "falló un paso": `ya_en_destino` no es un error para el usuario.
    if ("skip" in result) {
      if (result.skip === "ya_en_destino") {
        return { ok: true, toLabel: target.toLabel, invoiceId: invoice.id };
      }
      return { ok: false, error: `No se pudo pasar la boleta (${result.skip}).`, status: 409 };
    }
    return { ok: false, error: result.error, status: 502 };
  }

  return { ok: true, toLabel: target.toLabel, invoiceId: invoice.id };
}
