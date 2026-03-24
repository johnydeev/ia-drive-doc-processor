import { NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";

export async function POST(request: Request) {
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
      return NextResponse.json({ ok: true, closed: 0, created: 0, skipped: 0, warnings: [] });
    }

    // Recalcular mes mayoritario internamente
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

    let closed = 0;
    let created = 0;
    let skipped = 0;
    const warnings: string[] = [];

    for (const p of activePeriods) {
      if (p.year !== majYear || p.month !== majMonth) {
        skipped++;
        continue;
      }

      try {
        await prisma.$transaction(async (tx) => {
          await tx.period.update({
            where: { id: p.id },
            data: { status: "CLOSED", closedAt: new Date() },
          });

          await tx.period.create({
            data: {
              clientId: p.clientId,
              consortiumId: p.consortiumId,
              year: nextYear,
              month: nextMonth,
              status: "ACTIVE",
            },
          });
        });

        closed++;
        created++;
      } catch (err) {
        warnings.push(
          `Error al cerrar período de ${p.consortium.canonicalName}: ${err instanceof Error ? err.message : "Unknown"}`
        );
      }
    }

    return NextResponse.json({ ok: true, closed, created, skipped, warnings });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error al cerrar períodos" },
      { status: 500 }
    );
  }
}
