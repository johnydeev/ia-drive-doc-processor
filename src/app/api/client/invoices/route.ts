import { apiOk, withAuth } from "@/lib/apiHandler";
import { getPrismaClient } from "@/lib/prisma";

/**
 * Parsea "MM/YYYY" → { month, year } (null si inválido). El período se filtra por
 * etiqueta (mes/año), NO por periodId: cada consorcio tiene su propio `Period` con
 * ese mes/año, así que un mismo "06/2026" corresponde a muchos periodId distintos.
 */
function parsePeriodLabel(label: string | null): { month: number; year: number } | null {
  if (!label) return null;
  const m = label.match(/^(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const year = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { month, year };
}

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
  const parsedPeriod = parsePeriodLabel(url.searchParams.get("period")?.trim() || null);

  const prisma = getPrismaClient();
  const where = {
    clientId: session.clientId,
    ...(consortiumId ? { consortiumId } : {}),
    ...(providerId ? { providerId } : {}),
    ...(parsedPeriod ? { periodRef: { is: parsedPeriod } } : {}),
  };
  // Las facetas se calculan sobre TODAS las boletas del cliente (sin el filtro
  // activo) para que los dropdowns no se vacíen al elegir una opción.
  const facetWhere = { clientId: session.clientId };

  const [invoices, total, consortiumFacets, providerFacets, periodFacets] = await Promise.all([
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
    prisma.invoice.findMany({
      where: { ...facetWhere, periodId: { not: null } },
      distinct: ["periodId"],
      select: { periodId: true, periodRef: { select: { month: true, year: true } } },
    }),
  ]);

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "es");

  const consortiums = consortiumFacets
    .map((c) => ({ id: c.consortiumId as string, name: c.consortiumRef?.canonicalName ?? c.consortium ?? "(sin nombre)" }))
    .sort(byName);
  const providers = providerFacets
    .map((p) => ({ id: p.providerId as string, name: p.providerRef?.canonicalName ?? p.provider ?? "(sin nombre)" }))
    .sort(byName);
  // Periodos DEDUPLICADOS por etiqueta MM/YYYY (cada consorcio tiene su propio Period
  // con el mismo mes/año → muchos periodId con el mismo nombre). El filtro usa la
  // etiqueta. `id` = la etiqueta. Ordenados del más reciente al más viejo.
  const periodMap = new Map<string, number>();
  for (const p of periodFacets) {
    if (!p.periodRef) continue;
    const label = `${String(p.periodRef.month).padStart(2, "0")}/${p.periodRef.year}`;
    if (!periodMap.has(label)) periodMap.set(label, p.periodRef.year * 100 + p.periodRef.month);
  }
  const periods = [...periodMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => ({ id: label, name: label }));

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
    facets: { consortiums, providers, periods },
  });
});
