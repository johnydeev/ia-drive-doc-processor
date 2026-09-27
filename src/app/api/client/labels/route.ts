import { z } from "zod";
import { apiError, apiOk, withClientAuth } from "@/lib/apiHandler";
import { getPrismaClient } from "@/lib/prisma";
import { labelData } from "@/lib/rubroAssignment";
import { validateLabels } from "@/services/labelAssignment.service";

/**
 * Edición de rubro/coeficiente desde la hoja de obligaciones (spec 2026-09-24,
 * "Editar es corregir y también fijar").
 *
 * Con `fixedExpenseId` + `invoiceId` escribe los DOS en una transacción: la boleta
 * del mes queda corregida y el gasto fijo fija la regla para los meses que vienen
 * (las boletas anteriores no se tocan). Con sólo `invoiceId` es una eventual: no
 * hay regla que fijar. Todo se valida contra lo que el EDIFICIO tiene asignado.
 */
const schema = z
  .object({
    fixedExpenseId: z.string().optional(),
    invoiceId: z.string().optional(),
    rubroId: z.string().nullable().optional(),
    coeficienteId: z.string().nullable().optional(),
  })
  .refine((b) => b.fixedExpenseId || b.invoiceId, { message: "Falta el gasto fijo o la boleta" })
  .refine((b) => b.rubroId !== undefined || b.coeficienteId !== undefined, { message: "No hay nada para cambiar" });

export const PATCH = withClientAuth(async ({ request, session }) => {
  // Body inválido (JSON roto) → `{}`, que el refine de arriba rechaza igual:
  // así el `ZodError` lo convierte `apiError` en 400, no en un 500 crudo.
  const body = schema.parse(await request.json().catch(() => ({})));
  const prisma = getPrismaClient();
  const clientId = session.clientId;

  const fx = body.fixedExpenseId
    ? await prisma.fixedExpense.findFirst({
        where: { id: body.fixedExpenseId, clientId },
        select: { id: true, consortiumId: true },
      })
    : null;
  if (body.fixedExpenseId && !fx) return apiError(new Error("Gasto fijo no encontrado"), 404);

  const inv = body.invoiceId
    ? await prisma.invoice.findFirst({
        where: { id: body.invoiceId, clientId },
        select: { id: true, consortiumId: true },
      })
    : null;
  if (body.invoiceId && !inv) return apiError(new Error("Boleta no encontrada"), 404);

  if (fx && inv && inv.consortiumId !== fx.consortiumId) {
    return apiError(new Error("La boleta y el gasto fijo son de edificios distintos"), 400);
  }
  const consortiumId = fx?.consortiumId ?? inv?.consortiumId ?? null;
  if (!consortiumId) return apiError(new Error("La boleta no tiene edificio asignado"), 400);

  const invalid = await validateLabels(prisma, consortiumId, body);
  if (invalid) return apiError(new Error(invalid), 400);

  const data = labelData(body);
  await prisma.$transaction(async (tx) => {
    if (fx) await tx.fixedExpense.update({ where: { id: fx.id }, data });
    if (inv) await tx.invoice.update({ where: { id: inv.id }, data });
  });

  return apiOk({});
});
