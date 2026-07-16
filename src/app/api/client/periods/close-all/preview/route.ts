import { NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { planCloseAll } from "@/lib/closeAllPlan";

const MONTH_NAMES = [
  "ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO",
  "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE",
];

export async function GET(request: Request) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;

  try {
    const prisma = getPrismaClient();

    const activePeriods = await prisma.period.findMany({
      where: { consortium: { clientId }, status: "ACTIVE" },
      include: { consortium: { select: { id: true, canonicalName: true } } },
    });

    // Mismo planificador que usa la ejecución (evita duplicar el cálculo del mes mayoritario).
    const plan = planCloseAll(
      activePeriods.map((p) => ({ id: p.id, consortiumId: p.consortiumId, year: p.year, month: p.month }))
    );

    if (!plan) {
      return NextResponse.json({
        ok: true,
        majorityMonth: null,
        nextMonth: null,
        toClose: [],
        toSkip: [],
      });
    }

    const majorityMonthLabel = `${MONTH_NAMES[plan.majorityMonth - 1]} ${plan.majorityYear}`;
    const nextMonthLabel = `${MONTH_NAMES[plan.nextMonth - 1]} ${plan.nextYear}`;

    // Contar obligaciones de gastos fijos que quedarían pendientes en los períodos a cerrar.
    const obligationCounts = await prisma.expenseObligation.groupBy({
      by: ["periodId"],
      where: { periodId: { in: plan.toCloseIds }, status: "PENDING" },
      _count: { _all: true },
    });
    const pendingByPeriod = new Map(obligationCounts.map((o) => [o.periodId, o._count._all]));

    const toClose: { id: string; canonicalName: string; currentPeriod: string; pendingObligations: number }[] = [];
    const toSkip: { id: string; canonicalName: string; currentPeriod: string }[] = [];

    for (const p of activePeriods) {
      const periodLabel = `${MONTH_NAMES[p.month - 1]} ${p.year}`;
      const item = { id: p.consortium.id, canonicalName: p.consortium.canonicalName, currentPeriod: periodLabel };

      if (p.year === plan.majorityYear && p.month === plan.majorityMonth) {
        toClose.push({ ...item, pendingObligations: pendingByPeriod.get(p.id) ?? 0 });
      } else {
        toSkip.push(item);
      }
    }

    return NextResponse.json({
      ok: true,
      majorityMonth: majorityMonthLabel,
      nextMonth: nextMonthLabel,
      toClose,
      toSkip,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error al obtener preview" },
      { status: 500 }
    );
  }
}
