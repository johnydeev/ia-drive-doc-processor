import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { generateObligationsForPeriod } from "@/services/obligation.service";

async function assertPeriodOwned(periodId: string, clientId: string) {
  const prisma = getPrismaClient();
  return prisma.period.findFirst({ where: { id: periodId, clientId } });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: periodId } = await context.params;
  const clientId = auth.session.clientId;

  const period = await assertPeriodOwned(periodId, clientId);
  if (!period) return NextResponse.json({ ok: false, error: "Período no encontrado" }, { status: 404 });

  const prisma = getPrismaClient();
  const obligations = await prisma.expenseObligation.findMany({
    where: { periodId },
    include: {
      fixedExpense: {
        include: {
          provider: { select: { canonicalName: true } },
          lspService: { select: { providerName: true, clientNumber: true } },
        },
      },
      invoice: { select: { id: true, isPaid: true, remainingBalance: true, amount: true, sourceFileUrl: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ ok: true, obligations });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: periodId } = await context.params;
  const clientId = auth.session.clientId;

  const period = await assertPeriodOwned(periodId, clientId);
  if (!period) return NextResponse.json({ ok: false, error: "Período no encontrado" }, { status: 404 });

  const result = await generateObligationsForPeriod(periodId);
  return NextResponse.json({ ok: true, ...result });
}
