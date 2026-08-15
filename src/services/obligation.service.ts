import { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";
import { obligationMatchesInvoice } from "@/lib/fixedExpense";

export interface GenerateResult {
  created: number;
  linked: number;
}

/**
 * Genera (idempotente) las obligaciones PENDING de un período — una por gasto fijo
 * activo del consorcio — y vincula retroactivamente boletas ya presentes que matcheen.
 */
export async function generateObligationsForPeriod(
  periodId: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<GenerateResult> {
  const period = await prisma.period.findUnique({ where: { id: periodId } });
  if (!period) return { created: 0, linked: 0 };

  const fixedExpenses = await prisma.fixedExpense.findMany({
    where: { consortiumId: period.consortiumId, active: true },
  });
  if (fixedExpenses.length === 0) return { created: 0, linked: 0 };

  const existing = await prisma.expenseObligation.findMany({
    where: { periodId },
    select: { fixedExpenseId: true },
  });
  const existingIds = new Set(existing.map((o) => o.fixedExpenseId));

  const invoices = await prisma.invoice.findMany({
    // Las boletas arrastradas de un período anterior NO ocupan la obligación de
    // este período: esa es de la boleta del mes. Además su obligación de origen
    // las conserva y `ExpenseObligation.invoiceId` es unique → vincularlas acá
    // reventaría con P2002.
    where: { periodId, carriedFromPeriodId: null },
    select: { id: true, providerId: true, lspServiceId: true },
  });

  let created = 0;
  let linked = 0;

  for (const fx of fixedExpenses) {
    if (existingIds.has(fx.id)) continue;

    const match = invoices.find((inv) =>
      obligationMatchesInvoice(
        { providerId: fx.providerId, lspServiceId: fx.lspServiceId },
        { providerId: inv.providerId, lspServiceId: inv.lspServiceId }
      )
    );

    const obligation = await prisma.expenseObligation.create({
      data: {
        clientId: period.clientId,
        consortiumId: period.consortiumId,
        periodId,
        fixedExpenseId: fx.id,
        status: "PENDING",
      },
    });
    created++;

    if (match) {
      await prisma.expenseObligation.update({
        where: { id: obligation.id },
        data: { status: "RECEIVED", invoiceId: match.id },
      });
      linked++;
    }
  }

  return { created, linked };
}

/**
 * Vincula una boleta recién persistida a su obligación PENDING (si existe) en su período.
 * Se usa en el pipeline. No toca Sheets.
 */
export async function linkInvoiceToObligation(
  invoice: { id: string; periodId: string | null; providerId: string | null; lspServiceId: string | null },
  prisma: PrismaClient = getPrismaClient()
): Promise<boolean> {
  if (!invoice.periodId) return false;

  const candidates = await prisma.expenseObligation.findMany({
    where: { periodId: invoice.periodId, status: "PENDING" },
    include: { fixedExpense: { select: { providerId: true, lspServiceId: true } } },
    orderBy: { createdAt: "asc" },
  });

  const target = candidates.find((ob) =>
    obligationMatchesInvoice(
      { providerId: ob.fixedExpense.providerId, lspServiceId: ob.fixedExpense.lspServiceId },
      { providerId: invoice.providerId, lspServiceId: invoice.lspServiceId }
    )
  );
  if (!target) return false;

  await prisma.expenseObligation.update({
    where: { id: target.id },
    data: { status: "RECEIVED", invoiceId: invoice.id },
  });
  return true;
}

/**
 * Al cerrar un período: las obligaciones PENDING pasan a NOT_RECEIVED.
 * Devuelve el detalle de faltantes (para el resumen del cierre).
 */
export async function closeObligationsForPeriod(
  periodId: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<{ notReceived: number; labels: string[] }> {
  const pending = await prisma.expenseObligation.findMany({
    where: { periodId, status: "PENDING" },
    include: {
      fixedExpense: {
        include: {
          provider: { select: { canonicalName: true } },
          lspService: { select: { providerName: true, clientNumber: true } },
        },
      },
    },
  });

  const labels = pending.map((ob) => {
    if (ob.fixedExpense.lspService) {
      return `${ob.fixedExpense.lspService.providerName} (${ob.fixedExpense.lspService.clientNumber})`;
    }
    return ob.fixedExpense.provider?.canonicalName ?? ob.fixedExpense.description ?? "Gasto fijo";
  });

  if (pending.length > 0) {
    await prisma.expenseObligation.updateMany({
      where: { periodId, status: "PENDING" },
      data: { status: "NOT_RECEIVED" },
    });
  }

  return { notReceived: pending.length, labels };
}

export interface SyncResult {
  created: number;
  linked: number;
  /** Cuántos períodos activos se consideraron (para el aviso de la UI). */
  periods: number;
}

/**
 * Sincroniza las obligaciones de TODOS los períodos activos de un cliente.
 *
 * Es la versión set-based de `generateObligationsForPeriod`: la vista global la
 * llama al montar con decenas de edificios, así que no puede hacer una query por
 * gasto fijo (ese patrón produjo el 524 del túnel en `close-all`, ver
 * `docs/decisiones.md` 2026-07-12). Son ~5 queries en total, sin importar el
 * tamaño de la cartera.
 *
 * Idempotente: correrla dos veces seguidas no crea nada.
 */
export async function syncObligationsForClient(
  clientId: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<SyncResult> {
  const periods = await prisma.period.findMany({
    where: { clientId, status: "ACTIVE" },
    select: { id: true, consortiumId: true },
  });
  if (periods.length === 0) return { created: 0, linked: 0, periods: 0 };

  const consortiumIds = [...new Set(periods.map((p) => p.consortiumId))];
  const periodIds = periods.map((p) => p.id);

  const fixedExpenses = await prisma.fixedExpense.findMany({
    where: { consortiumId: { in: consortiumIds }, active: true },
    select: { id: true, consortiumId: true, providerId: true, lspServiceId: true },
  });

  const existing = await prisma.expenseObligation.findMany({
    where: { periodId: { in: periodIds } },
    select: { periodId: true, fixedExpenseId: true, invoiceId: true },
  });
  const alreadyThere = new Set(existing.map((o) => `${o.periodId}:${o.fixedExpenseId}`));
  const takenInvoiceIds = new Set(
    existing.map((o) => o.invoiceId).filter((id): id is string => Boolean(id))
  );

  const byConsortium = new Map<string, typeof fixedExpenses>();
  for (const fx of fixedExpenses) {
    const list = byConsortium.get(fx.consortiumId) ?? [];
    list.push(fx);
    byConsortium.set(fx.consortiumId, list);
  }

  const toCreate = periods.flatMap((period) =>
    (byConsortium.get(period.consortiumId) ?? [])
      .filter((fx) => !alreadyThere.has(`${period.id}:${fx.id}`))
      .map((fx) => ({
        clientId,
        consortiumId: period.consortiumId,
        periodId: period.id,
        fixedExpenseId: fx.id,
        status: "PENDING" as const,
      }))
  );

  if (toCreate.length === 0) return { created: 0, linked: 0, periods: periods.length };

  await prisma.expenseObligation.createMany({ data: toCreate, skipDuplicates: true });

  // Vínculo retroactivo, acotado a los períodos donde efectivamente se creó algo:
  // en régimen normal esto no hace ningún update.
  const touchedPeriodIds = [...new Set(toCreate.map((o) => o.periodId))];

  const fresh = await prisma.expenseObligation.findMany({
    where: { periodId: { in: touchedPeriodIds }, status: "PENDING", invoiceId: null },
    select: { id: true, periodId: true, fixedExpenseId: true },
  });

  const invoices = await prisma.invoice.findMany({
    // Mismo motivo que en `generateObligationsForPeriod`: una boleta arrastrada
    // ya tiene su obligación en el período de origen.
    where: { periodId: { in: touchedPeriodIds }, carriedFromPeriodId: null },
    select: { id: true, periodId: true, providerId: true, lspServiceId: true },
  });

  const fxById = new Map(fixedExpenses.map((fx) => [fx.id, fx]));
  let linked = 0;

  for (const ob of fresh) {
    const fx = fxById.get(ob.fixedExpenseId);
    if (!fx) continue;

    const match = invoices.find(
      (inv) =>
        inv.periodId === ob.periodId &&
        !takenInvoiceIds.has(inv.id) &&
        obligationMatchesInvoice(
          { providerId: fx.providerId, lspServiceId: fx.lspServiceId },
          { providerId: inv.providerId, lspServiceId: inv.lspServiceId }
        )
    );
    if (!match) continue;

    await prisma.expenseObligation.update({
      where: { id: ob.id },
      data: { status: "RECEIVED", invoiceId: match.id },
    });
    takenInvoiceIds.add(match.id);
    linked++;
  }

  return { created: toCreate.length, linked, periods: periods.length };
}
