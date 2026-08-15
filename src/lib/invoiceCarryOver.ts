import type { PrismaClient } from "@prisma/client";

/**
 * Transacción de DB del ARRASTRE de una boleta impaga al período siguiente.
 *
 * Se inyecta por el seam `InvoiceMoveContext.applyDb` en lugar del `applyDbMove`
 * genérico. La diferencia es deliberada y es el corazón de la feature:
 *
 * - `applyDbMove` (Boletas entrantes) significa "esta boleta entró en el mes
 *   equivocado": vacía la obligación de origen (`invoiceId: null`) y la
 *   re-vincula a una obligación PENDING del destino.
 * - Acá significa "llegó y no se pagó": la obligación de origen **conserva su
 *   `invoiceId`** y pasa a `CARRIED_OVER`, para que el mes de origen siga
 *   mostrando que la boleta existió y quedó impaga — es lo que exige una
 *   rendición de cuentas ante los inquilinos. En el destino la boleta queda
 *   suelta: la obligación de ese mes es de su propia boleta.
 */
export async function applyCarryOverDbMove(
  prisma: PrismaClient,
  invoice: { id: string; periodId: string | null },
  newPeriodId: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.expenseObligation.updateMany({
      where: { invoiceId: invoice.id },
      data: { status: "CARRIED_OVER" },
    });

    const current = await tx.invoice.findUnique({
      where: { id: invoice.id },
      select: { carriedFromPeriodId: true, periodId: true },
    });

    // El origen se escribe UNA sola vez: un arrastre encadenado
    // (agosto → septiembre → octubre) sigue diciendo "agosto", que es la verdad
    // que le importa al inquilino.
    const data: { periodId: string; carriedFromPeriodId?: string } = { periodId: newPeriodId };
    if (!current?.carriedFromPeriodId && current?.periodId) {
      data.carriedFromPeriodId = current.periodId;
    }

    await tx.invoice.update({ where: { id: invoice.id }, data });
  });
}

/**
 * Recalcula el saldo al cargar (o cambiar) el importe del 2° vencimiento.
 *
 * Puro. La base anterior es el `lateAmount` previo si existía, o el `amount`
 * original: así un pago parcial ya registrado se respeta y el saldo sólo se
 * mueve por la diferencia del recargo.
 */
export function recalcRemainingForLateAmount(input: {
  amount: number;
  lateAmount: number | null;
  remaining: number | null;
  next: number;
}): { remaining: number; isPaid: boolean } {
  const base = input.lateAmount ?? input.amount;
  const current = input.remaining ?? base;
  const remaining = Math.max(0, Number((current + (input.next - base)).toFixed(2)));
  return { remaining, isPaid: remaining === 0 };
}
