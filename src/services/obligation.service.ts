import { PrismaClient, type DocKind } from "@prisma/client";
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
    select: { id: true, providerId: true, lspServiceId: true, docKind: true },
  });

  let created = 0;
  let linked = 0;

  for (const fx of fixedExpenses) {
    if (existingIds.has(fx.id)) continue;

    const match = invoices.find((inv) =>
      obligationMatchesInvoice(
        { providerId: fx.providerId, lspServiceId: fx.lspServiceId, kind: fx.kind },
        { providerId: inv.providerId, lspServiceId: inv.lspServiceId, docKind: inv.docKind }
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
      await copyLabelsToInvoice(prisma, match.id, fx);
      linked++;
    }
  }

  return { created, linked };
}

/**
 * Copia la etiqueta (rubro y coeficiente) del gasto fijo a la boleta recién
 * vinculada — spec 2026-09-24.
 *
 * Se COPIA, no se lee al vuelo: la liquidación de un mes ya emitido no tiene que
 * moverse si mañana se cambia la regla del gasto fijo. Y no pisa con null: un gasto
 * fijo sin etiquetar no borra el rubro que la boleta pueda tener cargado a mano.
 */
async function copyLabelsToInvoice(
  prisma: PrismaClient,
  invoiceId: string,
  fx: { rubroId: string | null; coeficienteId: string | null }
): Promise<void> {
  if (!fx.rubroId && !fx.coeficienteId) return;
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      ...(fx.rubroId ? { rubroId: fx.rubroId } : {}),
      ...(fx.coeficienteId ? { coeficienteId: fx.coeficienteId } : {}),
    },
  });
}

/**
 * Vincula una boleta recién persistida a su obligación PENDING (si existe) en su período.
 * Se usa en el pipeline. No toca Sheets.
 */
export async function linkInvoiceToObligation(
  invoice: { id: string; periodId: string | null; providerId: string | null; lspServiceId: string | null; docKind?: DocKind },
  prisma: PrismaClient = getPrismaClient()
): Promise<boolean> {
  if (!invoice.periodId) return false;

  const candidates = await prisma.expenseObligation.findMany({
    where: { periodId: invoice.periodId, status: "PENDING" },
    include: {
      fixedExpense: {
        select: { providerId: true, lspServiceId: true, kind: true, rubroId: true, coeficienteId: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const target = candidates.find((ob) =>
    obligationMatchesInvoice(
      { providerId: ob.fixedExpense.providerId, lspServiceId: ob.fixedExpense.lspServiceId, kind: ob.fixedExpense.kind },
      { providerId: invoice.providerId, lspServiceId: invoice.lspServiceId, docKind: invoice.docKind }
    )
  );
  if (!target) return false;

  await prisma.expenseObligation.update({
    where: { id: target.id },
    data: { status: "RECEIVED", invoiceId: invoice.id },
  });
  await copyLabelsToInvoice(prisma, invoice.id, target.fixedExpense);
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
 * `docs/decisiones.md` 2026-07-12). Son ~6 queries en total, sin importar el
 * tamaño de la cartera.
 *
 * Además del alta, hace el vínculo retroactivo de boletas sueltas a obligaciones
 * PENDING en todos los períodos activos (spec 2026-09-18).
 *
 * Idempotente: correrla dos veces seguidas no crea ni vincula nada.
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
    select: {
      id: true, consortiumId: true, providerId: true, lspServiceId: true, kind: true,
      // Etiqueta que hereda la boleta al vincularse retroactivamente (spec 2026-09-24).
      rubroId: true, coeficienteId: true,
    },
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

  if (toCreate.length > 0) {
    await prisma.expenseObligation.createMany({ data: toCreate, skipDuplicates: true });
  }

  // Vínculo retroactivo en TODOS los períodos activos, no sólo donde se creó
  // algo: si la principal se borró, la obligación volvió a PENDING y la
  // siguiente boleta del proveedor (que estaba como adicional) tiene que subir
  // acá, porque el pipeline no la reprocesa (spec 2026-09-18). En régimen
  // normal no hay PENDING con boleta suelta y esto no hace ningún update.
  const fresh = await prisma.expenseObligation.findMany({
    where: { periodId: { in: periodIds }, status: "PENDING", invoiceId: null },
    select: { id: true, periodId: true, fixedExpenseId: true },
  });

  if (fresh.length === 0) return { created: toCreate.length, linked: 0, periods: periods.length };

  const invoices = await prisma.invoice.findMany({
    // Mismo motivo que en `generateObligationsForPeriod`: una boleta arrastrada
    // ya tiene su obligación en el período de origen.
    where: { periodId: { in: periodIds }, carriedFromPeriodId: null },
    select: { id: true, periodId: true, providerId: true, lspServiceId: true, docKind: true },
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
          { providerId: fx.providerId, lspServiceId: fx.lspServiceId, kind: fx.kind },
          { providerId: inv.providerId, lspServiceId: inv.lspServiceId, docKind: inv.docKind }
        )
    );
    if (!match) continue;

    await prisma.expenseObligation.update({
      where: { id: ob.id },
      data: { status: "RECEIVED", invoiceId: match.id },
    });
    await copyLabelsToInvoice(prisma, match.id, fx);
    takenInvoiceIds.add(match.id);
    linked++;
  }

  return { created: toCreate.length, linked, periods: periods.length };
}
