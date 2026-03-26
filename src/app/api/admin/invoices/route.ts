import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/adminAuth";
import { getPrismaClient } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const auth = requireAdminSession(request);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? 50)));

  const prisma = getPrismaClient();
  const where = clientId ? { clientId } : {};

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        client: { select: { id: true, name: true } },
        consortiumRef: { select: { canonicalName: true } },
        providerRef: { select: { canonicalName: true } },
        periodRef: { select: { month: true, year: true } },
      },
    }),
    prisma.invoice.count({ where }),
  ]);

  return NextResponse.json({
    ok: true,
    invoices: invoices.map((inv) => ({
      id: inv.id,
      clientId: inv.clientId,
      clientName: inv.client.name,
      consortium: inv.consortiumRef?.canonicalName ?? inv.consortium ?? null,
      provider: inv.providerRef?.canonicalName ?? inv.provider ?? null,
      period: inv.periodRef
        ? `${String(inv.periodRef.month).padStart(2, "0")}/${inv.periodRef.year}`
        : null,
      amount: inv.amount ? Number(inv.amount) : null,
      tokensInput: inv.tokensInput,
      tokensOutput: inv.tokensOutput,
      tokensTotal: inv.tokensTotal,
      aiProvider: inv.aiProvider,
      aiModel: inv.aiModel,
      isDuplicate: inv.isDuplicate,
      createdAt: inv.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  });
}
