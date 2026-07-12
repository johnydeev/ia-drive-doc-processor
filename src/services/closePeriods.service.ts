import { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";
import { planCloseAll, type ActivePeriodLite } from "@/lib/closeAllPlan";

export interface CloseAllResult {
  closed: number;
  created: number;
  skipped: number;
  warnings: string[];
}

/**
 * Cierra el "Periodo General" de un cliente de forma **set-based e idempotente**:
 * cierra en bloque los períodos ACTIVE del mes mayoritario y crea los del mes
 * siguiente en UNA sola transacción (~4 queries), en vez de N transacciones
 * secuenciales (una por consorcio). Con 47 consorcios el modelo viejo superaba
 * los 100s → 524 del proxy → y como cada cierre se commiteaba solo, un reintento
 * empujaba el estado de más (runaway). Acá:
 *  - `updateMany` filtra por `status: ACTIVE` → un reintento matchea 0 (no re-cierra).
 *  - `createMany({ skipDuplicates })` → un reintento no re-crea (unique consortiumId_year_month).
 * Así el reintento es un no-op seguro. Las obligaciones de gastos fijos se ajustan
 * best-effort después (no crítico; no abortan el cierre).
 */
export async function executeCloseAll(
  clientId: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<CloseAllResult> {
  const active = await prisma.period.findMany({
    where: { consortium: { clientId }, status: "ACTIVE" },
    select: { id: true, consortiumId: true, year: true, month: true },
  });

  const plan = planCloseAll(active as ActivePeriodLite[]);
  if (!plan) return { closed: 0, created: 0, skipped: 0, warnings: [] };

  const { nextYear, nextMonth, toCloseIds, toCloseConsortiumIds, skipCount } = plan;
  const warnings: string[] = [];

  // 1. Cerrar + crear los siguientes en una sola transacción atómica e idempotente.
  const { closed, created } = await prisma.$transaction(async (tx) => {
    const closedRes = await tx.period.updateMany({
      where: { id: { in: toCloseIds }, status: "ACTIVE" },
      data: { status: "CLOSED", closedAt: new Date() },
    });

    await tx.period.createMany({
      data: toCloseConsortiumIds.map((consortiumId) => ({
        clientId,
        consortiumId,
        year: nextYear,
        month: nextMonth,
        status: "ACTIVE" as const,
      })),
      skipDuplicates: true,
    });

    // Total de períodos-siguiente que existen ahora para estos consorcios.
    const created = await tx.period.count({
      where: { consortiumId: { in: toCloseConsortiumIds }, year: nextYear, month: nextMonth },
    });

    return { closed: closedRes.count, created };
  });

  // 2. Obligaciones de gastos fijos (best-effort, set-based). No abortan el cierre.
  try {
    await adjustObligations(prisma, {
      clientId,
      toCloseIds,
      toCloseConsortiumIds,
      nextYear,
      nextMonth,
      warnings,
    });
  } catch (err) {
    warnings.push(`Obligaciones: ${err instanceof Error ? err.message : "error"}`);
  }

  return { closed, created, skipped: skipCount, warnings };
}

/**
 * Ajuste set-based de obligaciones al cerrar el período general:
 * - Las PENDING de los períodos que se cierran pasan a NOT_RECEIVED (con aviso por consorcio).
 * - Se generan las obligaciones de los períodos nuevos (una por gasto fijo activo).
 * Todo en queries en bloque (sin loop por consorcio).
 */
async function adjustObligations(
  prisma: PrismaClient,
  params: {
    clientId: string;
    toCloseIds: string[];
    toCloseConsortiumIds: string[];
    nextYear: number;
    nextMonth: number;
    warnings: string[];
  }
): Promise<void> {
  const { clientId, toCloseIds, toCloseConsortiumIds, nextYear, nextMonth, warnings } = params;

  // -- Cerrar obligaciones pendientes de los períodos que se cierran.
  const pending = await prisma.expenseObligation.findMany({
    where: { periodId: { in: toCloseIds }, status: "PENDING" },
    include: {
      period: { select: { consortium: { select: { canonicalName: true } } } },
      fixedExpense: {
        include: {
          provider: { select: { canonicalName: true } },
          lspService: { select: { providerName: true, clientNumber: true } },
        },
      },
    },
  });

  if (pending.length > 0) {
    const byConsortium = new Map<string, string[]>();
    for (const ob of pending) {
      const name = ob.period.consortium.canonicalName;
      const label = ob.fixedExpense.lspService
        ? `${ob.fixedExpense.lspService.providerName} (${ob.fixedExpense.lspService.clientNumber})`
        : ob.fixedExpense.provider?.canonicalName ?? ob.fixedExpense.description ?? "Gasto fijo";
      const arr = byConsortium.get(name) ?? [];
      arr.push(label);
      byConsortium.set(name, arr);
    }
    for (const [name, labels] of byConsortium) {
      warnings.push(`${name}: faltaron ${labels.length} boleta(s) de gastos fijos (${labels.join(", ")}).`);
    }
    await prisma.expenseObligation.updateMany({
      where: { periodId: { in: toCloseIds }, status: "PENDING" },
      data: { status: "NOT_RECEIVED" },
    });
  }

  // -- Generar obligaciones de los períodos nuevos (una por gasto fijo activo del consorcio).
  const [newPeriods, fixedExpenses] = await Promise.all([
    prisma.period.findMany({
      where: { consortiumId: { in: toCloseConsortiumIds }, year: nextYear, month: nextMonth },
      select: { id: true, consortiumId: true },
    }),
    prisma.fixedExpense.findMany({
      where: { consortiumId: { in: toCloseConsortiumIds }, active: true },
      select: { id: true, consortiumId: true },
    }),
  ]);

  if (fixedExpenses.length === 0 || newPeriods.length === 0) return;

  const feByConsortium = new Map<string, string[]>();
  for (const fe of fixedExpenses) {
    const arr = feByConsortium.get(fe.consortiumId) ?? [];
    arr.push(fe.id);
    feByConsortium.set(fe.consortiumId, arr);
  }

  const rows: Array<{ clientId: string; consortiumId: string; periodId: string; fixedExpenseId: string; status: "PENDING" }> = [];
  for (const np of newPeriods) {
    for (const feId of feByConsortium.get(np.consortiumId) ?? []) {
      rows.push({ clientId, consortiumId: np.consortiumId, periodId: np.id, fixedExpenseId: feId, status: "PENDING" });
    }
  }

  if (rows.length > 0) {
    await prisma.expenseObligation.createMany({ data: rows, skipDuplicates: true });
  }
}
