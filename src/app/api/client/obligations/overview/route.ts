import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function periodLabel(year: number, month: number): string {
  return `${MONTHS[month - 1] ?? month} ${year}`;
}

/** ¿`a` es el mes inmediatamente anterior a `b`? (envuelve diciembre → enero) */
function isPreviousMonth(
  a: { year: number; month: number },
  b: { year: number; month: number }
): boolean {
  const next = a.month === 12 ? { year: a.year + 1, month: 1 } : { year: a.year, month: a.month + 1 };
  return next.year === b.year && next.month === b.month;
}

/**
 * Todo lo que la vista global de obligaciones necesita, en 4 queries.
 *
 * Los proveedores son de nivel cliente y viajan UNA vez al tope de la respuesta
 * (no repetidos por consorcio): el filtrado de "lo ya cargado" lo hace el cliente
 * con `availableTargets`.
 */
export async function GET(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const clientId = auth.session.clientId;
  const prisma = getPrismaClient();

  const consortiums = await prisma.consortium.findMany({
    where: { clientId },
    select: {
      id: true,
      canonicalName: true,
      bank: { select: { id: true, name: true, color: true } },
      periods: {
        where: { status: "ACTIVE" },
        select: { id: true, year: true, month: true },
        take: 1,
      },
      fixedExpenses: {
        select: {
          id: true, providerId: true, lspServiceId: true, description: true, active: true,
        },
      },
      lspServices: {
        select: { id: true, providerName: true, clientNumber: true, description: true, providerId: true },
      },
    },
    orderBy: { canonicalName: "asc" },
  });

  const activePeriodIds = consortiums
    .map((c) => c.periods[0]?.id)
    .filter((id): id is string => Boolean(id));

  const obligations = activePeriodIds.length
    ? await prisma.expenseObligation.findMany({
        where: { periodId: { in: activePeriodIds } },
        select: {
          id: true,
          status: true,
          fixedExpenseId: true,
          periodId: true,
          invoice: { select: { amount: true } },
        },
      })
    : [];

  const obligationByKey = new Map(
    obligations.map((o) => [`${o.periodId}:${o.fixedExpenseId}`, o])
  );

  // Impagas de meses anteriores: lo que el administrador todavía debe y que no
  // sale de las obligaciones del mes. Dos casos en una sola consulta:
  //  - boletas de un período anterior con saldo (todavía sin pasar);
  //  - boletas ya pasadas a este período (`carriedFromPeriodId`), que siguen impagas.
  const consortiumIds = consortiums.map((c) => c.id);
  const unpaid = consortiumIds.length
    ? await prisma.invoice.findMany({
        where: {
          clientId,
          consortiumId: { in: consortiumIds },
          isPaid: false,
          periodId: { not: null },
          OR: [
            { periodId: { notIn: activePeriodIds } },
            { carriedFromPeriodId: { not: null } },
          ],
        },
        select: {
          id: true,
          consortiumId: true,
          periodId: true,
          provider: true,
          amount: true,
          lateAmount: true,
          remainingBalance: true,
          carriedFromPeriodId: true,
          providerRef: { select: { canonicalName: true, paymentAlias: true } },
          lspServiceRef: { select: { clientNumber: true } },
          periodRef: { select: { year: true, month: true } },
          carriedFrom: { select: { year: true, month: true } },
        },
      })
    : [];

  const providers = await prisma.provider.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true, paymentAlias: true },
    orderBy: { canonicalName: "asc" },
  });

  // Mes mayoritario entre los períodos activos, para el título del documento.
  const freq = new Map<string, number>();
  for (const c of consortiums) {
    const p = c.periods[0];
    if (!p) continue;
    const key = `${p.year}-${p.month}`;
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  let majorityLabel: string | null = null;
  let best = 0;
  for (const [key, count] of freq) {
    if (count > best) {
      best = count;
      const [y, m] = key.split("-").map(Number);
      majorityLabel = periodLabel(y, m);
    }
  }

  return NextResponse.json({
    ok: true,
    majorityLabel,
    providers,
    consortiums: consortiums.map((c) => {
      const period = c.periods[0] ?? null;
      return {
        consortiumId: c.id,
        consortiumName: c.canonicalName,
        bankId: c.bank?.id ?? null,
        bankName: c.bank?.name ?? null,
        bankColor: c.bank?.color ?? null,
        periodId: period?.id ?? null,
        periodLabel: period ? periodLabel(period.year, period.month) : null,
        lspServices: c.lspServices,
        carried: unpaid
          .filter((inv) => inv.consortiumId === c.id)
          .map((inv) => {
            // El origen que se muestra: si ya se pasó, el período del que vino;
            // si todavía no, el período en el que está.
            const origin = inv.carriedFrom ?? inv.periodRef;
            return {
              invoiceId: inv.id,
              concepto: inv.providerRef?.canonicalName ?? inv.provider ?? "—",
              facturas: inv.lspServiceRef?.clientNumber ?? null,
              aliasCbu: inv.providerRef?.paymentAlias ?? null,
              originalAmount: inv.amount != null ? Number(inv.amount) : null,
              lateAmount: inv.lateAmount != null ? Number(inv.lateAmount) : null,
              remaining:
                inv.remainingBalance != null
                  ? Number(inv.remainingBalance)
                  : Number(inv.lateAmount ?? inv.amount ?? 0),
              fromLabel: origin ? periodLabel(origin.year, origin.month) : null,
              periodSort: origin ? origin.year * 100 + origin.month : 0,
              /** Ya vive en el período activo → se pasó. */
              alreadyCarried: period != null && inv.periodId === period.id,
              /** Sólo se puede pasar si su período es el inmediatamente anterior al activo. */
              canCarry:
                period != null &&
                inv.periodRef != null &&
                inv.periodId !== period.id &&
                isPreviousMonth(inv.periodRef, { year: period.year, month: period.month }),
            };
          }),
        fixedExpenses: c.fixedExpenses.map((fx) => {
          const ob = period ? obligationByKey.get(`${period.id}:${fx.id}`) : undefined;
          return {
            id: fx.id,
            providerId: fx.providerId,
            lspServiceId: fx.lspServiceId,
            description: fx.description,
            active: fx.active,
            obligation: ob
              ? {
                  id: ob.id,
                  status: ob.status,
                  // Decimal de Prisma serializa como string: la UI espera número.
                  amount: ob.invoice?.amount != null ? Number(ob.invoice.amount) : null,
                }
              : null,
          };
        }),
      };
    }),
  });
}
