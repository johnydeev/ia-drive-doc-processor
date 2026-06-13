import { apiOk, withAuth } from "@/lib/apiHandler";
import { getPrismaClient } from "@/lib/prisma";

/**
 * GET /api/client/invoices?page=1&pageSize=50
 *
 * Lista TODAS las boletas del cliente (sin filtrar por consorcio), en orden de
 * entrada (createdAt desc, las más recientes arriba) — la "vista global de
 * boletas entrantes". Equivalente cliente de /api/admin/invoices, acotado al
 * cliente de la sesión.
 */
export const GET = withAuth(async ({ request, session }) => {
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? 50)));

  const prisma = getPrismaClient();
  const where = { clientId: session.clientId };

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        consortiumRef: { select: { canonicalName: true } },
        providerRef: { select: { canonicalName: true } },
        periodRef: { select: { month: true, year: true } },
      },
    }),
    prisma.invoice.count({ where }),
  ]);

  return apiOk({
    invoices: invoices.map((inv) => ({
      id: inv.id,
      consortiumId: inv.consortiumId,
      consortium: inv.consortiumRef?.canonicalName ?? inv.consortium ?? null,
      provider: inv.providerRef?.canonicalName ?? inv.provider ?? null,
      amount: inv.amount ? Number(inv.amount) : null,
      period: inv.periodRef
        ? `${String(inv.periodRef.month).padStart(2, "0")}/${inv.periodRef.year}`
        : null,
      dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
      isDuplicate: inv.isDuplicate,
      sourceFileUrl: inv.sourceFileUrl,
      createdAt: inv.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  });
});
