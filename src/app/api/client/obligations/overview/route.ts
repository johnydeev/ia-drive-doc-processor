import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { majorityMonth, parseMonthParam, periodLabel, type YearMonth } from "@/lib/periodMonth";

/**
 * Todo lo que la vista global de obligaciones necesita, para UN mes calendario.
 *
 * La vista es por mes, no por "período activo": se muestran los edificios que
 * tienen período de ese mes, **esté abierto o cerrado** (spec 2026-08-20). Un mes
 * cerrado sigue siendo navegable y operable, porque es al cerrar cuando el owner
 * decide qué pasa al mes siguiente.
 *
 * NO se listan boletas de otros meses. El bloque de "impagas de meses anteriores"
 * se eliminó: traía toda boleta con `isPaid: false` de períodos cerrados, y como
 * los pagos se registran fuera de la app, eso era el histórico entero (1124 de
 * 1125 boletas). Lo único que cruza de un mes a otro es lo que el owner empujó a
 * mano, y llega acá como `carried`.
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

  // Mes pedido, o el mayoritario entre los períodos ACTIVE (el "mes en curso" de
  // la cartera) cuando se entra sin elegir.
  const requested = parseMonthParam(
    request.nextUrl.searchParams.get("month"),
    request.nextUrl.searchParams.get("year")
  );

  const target: YearMonth | null =
    requested ??
    majorityMonth(
      (
        await prisma.period.findMany({
          where: { consortium: { clientId }, status: "ACTIVE" },
          select: { year: true, month: true },
        })
      )
    );

  if (!target) {
    return NextResponse.json({
      ok: true, month: null, year: null, monthLabel: null,
      providers: [], consortiums: [],
    });
  }

  const consortiums = await prisma.consortium.findMany({
    where: { clientId },
    select: {
      id: true,
      canonicalName: true,
      bank: { select: { id: true, name: true, color: true } },
      periods: {
        // El período de ESE mes, sin filtrar por estado.
        where: { year: target.year, month: target.month },
        select: { id: true, year: true, month: true, status: true },
        take: 1,
      },
      fixedExpenses: {
        select: {
          id: true, providerId: true, lspServiceId: true, description: true, kind: true, active: true,
        },
      },
      lspServices: {
        select: { id: true, providerName: true, clientNumber: true, description: true, providerId: true },
      },
    },
    orderBy: { canonicalName: "asc" },
  });

  const periodIds = consortiums
    .map((c) => c.periods[0]?.id)
    .filter((id): id is string => Boolean(id));

  const obligations = periodIds.length
    ? await prisma.expenseObligation.findMany({
        where: { periodId: { in: periodIds } },
        select: {
          id: true,
          periodId: true,
          fixedExpenseId: true,
          status: true,
          invoice: {
            select: { id: true, amount: true, sourceFileUrl: true, carryOverRequestedAt: true, carriedFromPeriodId: true },
          },
        },
      })
    : [];

  const obligationByKey = new Map(obligations.map((o) => [`${o.periodId}:${o.fixedExpenseId}`, o]));

  // Lo que vino empujado del mes anterior: boletas que VIVEN en este período pero
  // nacieron en otro. Es el único cruce de meses que existe.
  const carried = periodIds.length
    ? await prisma.invoice.findMany({
        where: {
          clientId,
          periodId: { in: periodIds },
          carriedFromPeriodId: { not: null },
        },
        select: {
          id: true,
          consortiumId: true,
          provider: true,
          amount: true,
          lateAmount: true,
          sourceFileUrl: true,
          carryOverRequestedAt: true,
          providerRef: { select: { canonicalName: true, paymentAlias: true } },
          lspServiceRef: { select: { clientNumber: true } },
          carriedFrom: { select: { year: true, month: true } },
        },
      })
    : [];

  // Boletas del mes que NO ocupan ninguna obligación: la 2ª del mismo proveedor,
  // o la de un proveedor que no es gasto fijo del edificio. `sheetModel` decide
  // en cuál de los dos casos está cada una. `obligation: null` es la inversa de
  // `ExpenseObligation.invoiceId` (spec 2026-09-18).
  const looseSelect = {
    id: true, consortiumId: true, periodId: true, providerId: true, lspServiceId: true,
    docKind: true, amount: true, sourceFileUrl: true, carryOverRequestedAt: true, createdAt: true,
    provider: true,
    providerRef: { select: { canonicalName: true, paymentAlias: true, matchNames: true } },
    lspServiceRef: { select: { clientNumber: true } },
  } as const;

  const loose = periodIds.length
    ? await prisma.invoice.findMany({
        where: { clientId, periodId: { in: periodIds }, carriedFromPeriodId: null, obligation: null },
        select: looseSelect,
      })
    : [];

  // Las que NACIERON en este mes y el owner empujó al siguiente: el origen las
  // sigue mostrando (rendición ante los inquilinos), sin acciones. `obligation:
  // null` también acá: la principal arrastrada conserva su obligación (queda
  // CARRIED_OVER y ya se muestra en su fila); sin el filtro saldría dos veces.
  const carriedOut = periodIds.length
    ? await prisma.invoice.findMany({
        where: { clientId, carriedFromPeriodId: { in: periodIds }, obligation: null },
        select: { ...looseSelect, carriedFromPeriodId: true, periodRef: { select: { year: true, month: true } } },
      })
    : [];

  const toLoose = (inv: (typeof loose)[number], carriedOutTo: string | null) => ({
    invoiceId: inv.id,
    providerId: inv.providerId,
    lspServiceId: inv.lspServiceId,
    docKind: inv.docKind,
    concepto: inv.providerRef?.canonicalName ?? inv.provider ?? "—",
    matchNames: inv.providerRef?.matchNames ?? null,
    facturas: inv.lspServiceRef?.clientNumber ?? null,
    aliasCbu: inv.providerRef?.paymentAlias ?? null,
    // Decimal de Prisma serializa como string: la UI espera número.
    amount: inv.amount != null ? Number(inv.amount) : null,
    invoiceUrl: inv.sourceFileUrl ?? null,
    carryOverRequested: Boolean(inv.carryOverRequestedAt),
    createdAt: inv.createdAt.toISOString(),
    carriedOutTo,
  });

  const providers = await prisma.provider.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true, paymentAlias: true, matchNames: true, providerType: true },
    orderBy: { canonicalName: "asc" },
  });

  return NextResponse.json({
    ok: true,
    month: target.month,
    year: target.year,
    monthLabel: periodLabel(target.year, target.month),
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
        /** ACTIVE / CLOSED, o null si el edificio no tiene período de este mes. */
        periodStatus: period?.status ?? null,
        lspServices: c.lspServices,
        carried: carried
          .filter((inv) => inv.consortiumId === c.id)
          .map((inv) => ({
            invoiceId: inv.id,
            concepto: inv.providerRef?.canonicalName ?? inv.provider ?? "—",
            facturas: inv.lspServiceRef?.clientNumber ?? null,
            aliasCbu: inv.providerRef?.paymentAlias ?? null,
            originalAmount: inv.amount != null ? Number(inv.amount) : null,
            lateAmount: inv.lateAmount != null ? Number(inv.lateAmount) : null,
            fromLabel: inv.carriedFrom
              ? periodLabel(inv.carriedFrom.year, inv.carriedFrom.month)
              : null,
            /**
             * Una arrastrada también puede volver a pasarse: si llegó en julio,
             * se pasó a agosto y en agosto tampoco se pagó, tiene que poder ir a
             * septiembre. El arrastre encadenado conserva el origen ORIGINAL.
             */
            carryOverRequested: Boolean(inv.carryOverRequestedAt),
            invoiceUrl: inv.sourceFileUrl ?? null,
          })),
        looseInvoices: [
          ...loose.filter((inv) => inv.consortiumId === c.id).map((inv) => toLoose(inv, null)),
          ...carriedOut
            .filter((inv) => inv.consortiumId === c.id && inv.carriedFromPeriodId === period?.id)
            .map((inv) => toLoose(inv, inv.periodRef ? periodLabel(inv.periodRef.year, inv.periodRef.month) : null)),
        ],
        fixedExpenses: c.fixedExpenses.map((fx) => {
          const ob = period ? obligationByKey.get(`${period.id}:${fx.id}`) : undefined;
          return {
            id: fx.id,
            providerId: fx.providerId,
            lspServiceId: fx.lspServiceId,
            description: fx.description,
            kind: fx.kind,
            active: fx.active,
            obligation: ob
              ? {
                  id: ob.id,
                  status: ob.status,
                  // Decimal de Prisma serializa como string: la UI espera número.
                  amount: ob.invoice?.amount != null ? Number(ob.invoice.amount) : null,
                  invoiceId: ob.invoice?.id ?? null,
                  /** Link de Drive del PDF, para la vista previa desde la planilla. */
                  invoiceUrl: ob.invoice?.sourceFileUrl ?? null,
                  /** Marcada para pasar al mes siguiente (se mueve al cerrar). */
                  carryOverRequested: Boolean(ob.invoice?.carryOverRequestedAt),
                  /** Esta boleta vino empujada de un mes anterior. */
                  carriedIn: Boolean(ob.invoice?.carriedFromPeriodId),
                }
              : null,
          };
        }),
      };
    }),
  });
}
