import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { recalcRemainingForLateAmount } from "@/lib/invoiceCarryOver";

const schema = z.object({ lateAmount: z.number().positive() });

/**
 * Carga el importe del 2° vencimiento de una boleta ARRASTRADA y recalcula su
 * saldo.
 *
 * Sólo aplica a boletas con `carriedFromPeriodId`: en una boleta del mes el
 * importe correcto es el que extrajo el pipeline (el del 1er vencimiento). El
 * `amount` original NO se toca — de él dependen la deduplicación (`amountNorm`
 * es parte de la llave única) y el guard de IVA.
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
  }

  const prisma = getPrismaClient();
  const invoice = await prisma.invoice.findFirst({
    where: { id, clientId: auth.session.clientId },
    select: {
      id: true, amount: true, lateAmount: true, remainingBalance: true, carriedFromPeriodId: true,
    },
  });
  if (!invoice) return NextResponse.json({ ok: false, error: "Boleta no encontrada" }, { status: 404 });
  if (!invoice.carriedFromPeriodId) {
    return NextResponse.json(
      { ok: false, error: "El monto vencido sólo se carga en una boleta arrastrada de otro período." },
      { status: 409 }
    );
  }

  const { remaining, isPaid } = recalcRemainingForLateAmount({
    amount: Number(invoice.amount ?? 0),
    lateAmount: invoice.lateAmount != null ? Number(invoice.lateAmount) : null,
    remaining: invoice.remainingBalance != null ? Number(invoice.remainingBalance) : null,
    next: parsed.data.lateAmount,
  });

  const updated = await prisma.invoice.update({
    where: { id },
    data: { lateAmount: parsed.data.lateAmount, remainingBalance: remaining, isPaid },
    select: { id: true, lateAmount: true, remainingBalance: true, isPaid: true },
  });

  return NextResponse.json({ ok: true, invoice: updated });
}
