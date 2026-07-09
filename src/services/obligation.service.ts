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
    where: { periodId },
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
