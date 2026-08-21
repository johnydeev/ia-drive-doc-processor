import { getPrismaClient } from "@/lib/prisma";
import { periodLabel } from "@/lib/periodMonth";
import {
  classifyTarget,
  loadInvoice,
  moveOneInvoiceToTarget,
  resolveMoveContext,
} from "@/lib/invoicePeriodMove";
import { applyCarryOverDbMove, applyUndoCarryOverDbMove } from "@/lib/invoiceCarryOver";

export type CarryOverResult =
  | { ok: true; toLabel: string; invoiceId: string }
  | { ok: false; error: string; status: number };

/**
 * Pasa al período siguiente una boleta que quedó impaga.
 *
 * Recibe el **invoiceId**, no el de la obligación: la acción se dispara desde el
 * bloque de arrastradas, donde la boleta puede no tener obligación visible (una
 * boleta que vino de otro mes no se vincula a la obligación del destino).
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

  // NO se chequea `isPaid`: los pagos se registran fuera de la app, así que para
  // el sistema toda boleta figura impaga y ese filtro no significaría nada
  // (spec 2026-08-20). Qué pasa al mes siguiente lo decide el owner.
  const state = await prisma.invoice.findFirst({
    where: { id: invoiceId, clientId },
    select: { id: true },
  });
  if (!state) return { ok: false, error: "Boleta no encontrada", status: 404 };

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

export type CarryOverMarkResult =
  | { ok: true; requested: boolean }
  | { ok: false; error: string; status: number };

/**
 * Marca una boleta para pasar al mes siguiente. **No la mueve**: el traslado real
 * ocurre al CERRAR el período.
 *
 * Se marca y se mueve después porque el período destino puede todavía no existir
 * —se crea justamente al cerrar—, y porque es al cerrar cuando el owner terminó
 * de revisar el mes (spec 2026-08-20).
 */
export async function requestCarryOver(
  clientId: string,
  invoiceId: string
): Promise<CarryOverMarkResult> {
  const prisma = getPrismaClient();

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, clientId },
    select: { id: true, periodId: true },
  });
  if (!invoice) return { ok: false, error: "Boleta no encontrada", status: 404 };
  if (!invoice.periodId) {
    return { ok: false, error: "La boleta no tiene período asignado.", status: 409 };
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { carryOverRequestedAt: new Date() },
  });
  return { ok: true, requested: true };
}

/** Desmarca una boleta que todavía no se trasladó. */
export async function cancelCarryOver(
  clientId: string,
  invoiceId: string
): Promise<CarryOverMarkResult> {
  const prisma = getPrismaClient();

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, clientId },
    select: { id: true },
  });
  if (!invoice) return { ok: false, error: "Boleta no encontrada", status: 404 };

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { carryOverRequestedAt: null },
  });
  return { ok: true, requested: false };
}

/**
 * Deshace un traslado ya ejecutado: devuelve la boleta a su período de origen.
 *
 * No usa `classifyTarget` —que exige que el destino esté ACTIVE— porque el
 * origen casi siempre está cerrado: el traslado ocurre justo al cerrar el mes.
 * Se le pasa el período destino directo a `moveOneInvoiceToTarget`, que igual
 * mueve Drive → Sheets → DB de forma idempotente y con compensación.
 */
export async function undoCarryOver(
  clientId: string,
  invoiceId: string
): Promise<CarryOverResult> {
  const prisma = getPrismaClient();

  const state = await prisma.invoice.findFirst({
    where: { id: invoiceId, clientId },
    select: { id: true, carriedFromPeriodId: true },
  });
  if (!state) return { ok: false, error: "Boleta no encontrada", status: 404 };
  if (!state.carriedFromPeriodId) {
    return { ok: false, error: "Esta boleta no vino de otro período.", status: 409 };
  }

  const origin = await prisma.period.findUnique({
    where: { id: state.carriedFromPeriodId },
    select: { id: true, year: true, month: true },
  });
  if (!origin) return { ok: false, error: "El período de origen ya no existe.", status: 409 };

  const invoice = await loadInvoice(prisma, clientId, invoiceId);
  if (!invoice) return { ok: false, error: "Boleta no encontrada", status: 404 };

  const resolved = await resolveMoveContext(clientId);
  if ("error" in resolved) return { ok: false, error: resolved.error, status: resolved.status };

  const originPeriodId = origin.id;
  const ctx = {
    ...resolved.ctx,
    applyDb: (inv: { id: string; periodId: string | null }) =>
      applyUndoCarryOverDbMove(prisma, inv, originPeriodId),
  };

  const result = await moveOneInvoiceToTarget(ctx, clientId, invoice.id, originPeriodId);
  const toLabel = periodLabel(origin.year, origin.month);

  if (!result.ok) {
    if ("skip" in result) {
      if (result.skip === "ya_en_destino") return { ok: true, toLabel, invoiceId: invoice.id };
      return { ok: false, error: `No se pudo devolver la boleta (${result.skip}).`, status: 409 };
    }
    return { ok: false, error: result.error, status: 502 };
  }

  return { ok: true, toLabel, invoiceId: invoice.id };
}
