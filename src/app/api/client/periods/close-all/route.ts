import { NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import {
  closeObligationsForPeriod,
  generateObligationsForPeriod,
} from "@/services/obligation.service";

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
        const newPeriod = await prisma.$transaction(async (tx) => {
          await tx.period.update({
            where: { id: p.id },
            data: { status: "CLOSED", closedAt: new Date() },
          });

          return tx.period.create({
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

        // Obligaciones de gastos fijos (best-effort): las pendientes del período que
        // se cierra pasan a "No recibida" (con aviso), y el período nuevo genera las suyas.
        try {
          const obRes = await closeObligationsForPeriod(p.id, prisma);
          if (obRes.notReceived > 0) {
            warnings.push(
              `${p.consortium.canonicalName}: faltaron ${obRes.notReceived} boleta(s) de gastos fijos (${obRes.labels.join(", ")}).`
            );
          }
          await generateObligationsForPeriod(newPeriod.id, prisma);
        } catch (obErr) {
          warnings.push(
            `Obligaciones de ${p.consortium.canonicalName}: ${obErr instanceof Error ? obErr.message : "error"}`
          );
        }
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
