import { NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";

const MONTH_NAMES = [
  "ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO",
  "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE",
];

export async function GET(request: Request) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;

  try {
    const prisma = getPrismaClient();

    const activePeriods = await prisma.period.findMany({
      where: { consortium: { clientId }, status: "ACTIVE" },
      include: { consortium: { select: { id: true, canonicalName: true } } },
    });

    if (activePeriods.length === 0) {
      return NextResponse.json({
        ok: true,
        majorityMonth: null,
        nextMonth: null,
        toClose: [],
        toSkip: [],
      });
    }

    // Calcular mes mayoritario
    const freq = new Map<string, number>();
    for (const p of activePeriods) {
      const key = `${p.year}-${p.month}`;
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }

    let majorityKey = "";
    let majorityCount = 0;
    for (const [key, count] of freq) {
      if (count > majorityCount) {
        majorityKey = key;
        majorityCount = count;
      }
    }

    const [majYear, majMonth] = majorityKey.split("-").map(Number);
    const nextMonth = majMonth === 12 ? 1 : majMonth + 1;
    const nextYear = majMonth === 12 ? majYear + 1 : majYear;

    const majorityMonthLabel = `${MONTH_NAMES[majMonth - 1]} ${majYear}`;
    const nextMonthLabel = `${MONTH_NAMES[nextMonth - 1]} ${nextYear}`;

    const toClose: { id: string; canonicalName: string; currentPeriod: string }[] = [];
    const toSkip: { id: string; canonicalName: string; currentPeriod: string }[] = [];

    for (const p of activePeriods) {
      const periodLabel = `${MONTH_NAMES[p.month - 1]} ${p.year}`;
      const item = { id: p.consortium.id, canonicalName: p.consortium.canonicalName, currentPeriod: periodLabel };

      if (p.year === majYear && p.month === majMonth) {
        toClose.push(item);
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
