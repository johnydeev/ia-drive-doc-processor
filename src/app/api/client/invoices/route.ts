import { apiOk, withAuth } from "@/lib/apiHandler";
import { getPrismaClient } from "@/lib/prisma";

/**
 * GET /api/client/invoices?page=1&pageSize=50&consortiumId=...&providerId=...
 *
 * Lista TODAS las boletas del cliente en orden de entrada (createdAt desc) — la
 * "vista global de boletas entrantes". Filtros opcionales server-side por
 * consorcio y/o proveedor (filtran TODO el dataset, no solo la página). Devuelve
 * además `facets`: los consorcios y proveedores que realmente tienen boletas,
 * para poblar los dropdowns de filtro.
 */
export const GET = withAuth(async ({ request, session }) => {
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? 50)));
  const consortiumId = url.searchParams.get("consortiumId")?.trim() || null;
  const providerId = url.searchParams.get("providerId")?.trim() || null;

  const prisma = getPrismaClient();
  const where = {
    clientId: session.clientId,
    ...(consortiumId ? { consortiumId } : {}),
    ...(providerId ? { providerId } : {}),
  };
  // Las facetas se calculan sobre TODAS las boletas del cliente (sin el filtro
  // activo) para que los dropdowns no se vacíen al elegir una opción.
  const facetWhere = { clientId: session.clientId };

  const [invoices, total, consortiumFacets, providerFacets] = await Promise.all([
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
    prisma.invoice.findMany({
      where: { ...facetWhere, consortiumId: { not: null } },
      distinct: ["consortiumId"],
      select: { consortiumId: true, consortium: true, consortiumRef: { select: { canonicalName: true } } },
    }),
    prisma.invoice.findMany({
      where: { ...facetWhere, providerId: { not: null } },
      distinct: ["providerId"],
      select: { providerId: true, provider: true, providerRef: { select: { canonicalName: true } } },
    }),
  ]);

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "es");

  const consortiums = consortiumFacets
    .map((c) => ({ id: c.consortiumId as string, name: c.consortiumRef?.canonicalName ?? c.consortium ?? "(sin nombre)" }))
    .sort(byName);
  const providers = providerFacets
    .map((p) => ({ id: p.providerId as string, name: p.providerRef?.canonicalName ?? p.provider ?? "(sin nombre)" }))
    .sort(byName);

  return apiOk({
    invoices: invoices.map((inv) => ({
      id: inv.id,
      consortiumId: inv.consortiumId,
      consortium: inv.consortiumRef?.canonicalName ?? inv.consortium ?? null,
      provider: inv.providerRef?.canonicalName ?? inv.provider ?? null,
      boletaNumber: inv.boletaNumber ?? null,
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
    facets: { consortiums, providers },
  });
});
