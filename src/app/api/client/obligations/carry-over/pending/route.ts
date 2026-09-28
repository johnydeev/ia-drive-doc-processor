import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { parseMonthParam, periodLabel, previousMonth } from "@/lib/periodMonth";

/**
 * Boletas marcadas para pasar al mes siguiente que TODAVÍA no se movieron.
 *
 * La UI la usa para dos cosas: arrancar el bucle de tandas después de cerrar, y
 * mostrar el "hay N para pasar" cuando el cliente cerró la pestaña a mitad de camino.
 *
 * Trae las del mes pedido **y las del anterior**, siempre que su período esté
 * CERRADO: sólo esas tienen destino (el siguiente ya existe). Después del cierre
 * la vista abre en el mes nuevo (octubre) y tiene que ofrecer las marcadas en
 * septiembre — antes sólo las veía quien volvía a septiembre (spec 2026-09-28).
 */
export async function GET(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const target = parseMonthParam(
    request.nextUrl.searchParams.get("month"),
    request.nextUrl.searchParams.get("year")
  );
  if (!target) {
    return NextResponse.json({ ok: false, error: "Falta el mes (month/year)" }, { status: 400 });
  }

  const prev = previousMonth(target);
  const prisma = getPrismaClient();
  const pending = await prisma.invoice.findMany({
    where: {
      clientId: auth.session.clientId,
      carryOverRequestedAt: { not: null },
      periodRef: {
        status: "CLOSED",
        OR: [
          { year: target.year, month: target.month },
          { year: prev.year, month: prev.month },
        ],
      },
    },
    select: {
      id: true,
      provider: true,
      amount: true,
      consortiumRef: { select: { canonicalName: true } },
      providerRef: { select: { canonicalName: true } },
    },
    orderBy: { carryOverRequestedAt: "asc" },
  });

  return NextResponse.json({
    ok: true,
    monthLabel: periodLabel(target.year, target.month),
    invoices: pending.map((inv) => ({
      invoiceId: inv.id,
      consortiumName: inv.consortiumRef?.canonicalName ?? "—",
      concepto: inv.providerRef?.canonicalName ?? inv.provider ?? "—",
      amount: inv.amount != null ? Number(inv.amount) : null,
    })),
  });
}
