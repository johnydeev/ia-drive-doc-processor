import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk } from "@/lib/apiHandler";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { excludeAssigned, orphanedBy } from "@/lib/rubroAssignment";

/**
 * Capa 2 de rubros y coeficientes (spec 2026-09-24): qué usa este edificio del
 * catálogo del cliente.
 *
 * El PUT recibe el set COMPLETO, no un delta: es lo que devuelve una lista de
 * casillas y hace la operación idempotente — mandar dos veces lo mismo no rompe.
 *
 * No usa los wrappers `withAuth`/`withClientAuth`: no pasan `params`, y esta ruta
 * es dinámica (ver el comentario de `src/lib/apiHandler.ts`).
 */
const putSchema = z.object({
  rubroIds: z.array(z.string()),
  coeficienteIds: z.array(z.string()),
  /**
   * Sacarle un rubro a un edificio DESETIQUETA los gastos fijos que lo usaban, y
   * volver a tildarlo no los recupera. Sin `confirm`, el endpoint no escribe nada:
   * responde 409 con los conteos para que el panel pregunte primero.
   */
  confirm: z.boolean().optional(),
});

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: consortiumId } = await context.params;

  try {
    const prisma = getPrismaClient();
    const consortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
      select: { id: true },
    });
    if (!consortium) return apiError(new Error("Consorcio no encontrado"), 404);

    const [rubros, coeficientes] = await Promise.all([
      prisma.consortiumRubro.findMany({ where: { consortiumId }, select: { rubroId: true } }),
      prisma.consortiumCoeficiente.findMany({ where: { consortiumId }, select: { coeficienteId: true } }),
    ]);

    return apiOk({
      rubroIds: rubros.map((r) => r.rubroId),
      coeficienteIds: coeficientes.map((c) => c.coeficienteId),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: consortiumId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const prisma = getPrismaClient();
    const body = putSchema.parse(await request.json());

    const consortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId },
      select: { id: true },
    });
    if (!consortium) return apiError(new Error("Consorcio no encontrado"), 404);

    // Sólo se acepta lo que está en el catálogo del cliente: la capa 2 no puede
    // habilitar algo que la capa 1 no tiene.
    const [rubrosDelCliente, coefsDelCliente] = await Promise.all([
      prisma.rubro.findMany({
        where: { clientId, id: { in: body.rubroIds } },
        select: { id: true },
      }),
      prisma.coeficiente.findMany({
        where: { clientId, id: { in: body.coeficienteIds } },
        select: { id: true },
      }),
    ]);
    if (rubrosDelCliente.length !== new Set(body.rubroIds).size) {
      return apiError(new Error("Hay rubros que no pertenecen a este cliente"), 400);
    }
    if (coefsDelCliente.length !== new Set(body.coeficienteIds).size) {
      return apiError(new Error("Hay coeficientes que no pertenecen a este cliente"), 400);
    }

    // `notIn: []` matchea CERO filas en Prisma, no todas: los filtros se arman con
    // los helpers para que destildar TODAS las casillas borre de verdad.
    const rubroSobrante = excludeAssigned(body.rubroIds);
    const coefSobrante = excludeAssigned(body.coeficienteIds);

    // Cuántos gastos fijos quedan sin etiqueta por lo que se está sacando. No
    // bloquea: se informa para que el panel lo muestre, como el borrado de un banco.
    const [rubrosHuerfanos, coefsHuerfanos] = await Promise.all([
      prisma.fixedExpense.count({
        where: { consortiumId, rubroId: orphanedBy(body.rubroIds) },
      }),
      prisma.fixedExpense.count({
        where: { consortiumId, coeficienteId: orphanedBy(body.coeficienteIds) },
      }),
    ]);

    // Nada destructivo sin confirmación explícita.
    if (!body.confirm && (rubrosHuerfanos > 0 || coefsHuerfanos > 0)) {
      return apiOk({ needsConfirm: true, rubrosHuerfanos, coefsHuerfanos }, 409);
    }

    await prisma.$transaction(async (tx) => {
      await tx.consortiumRubro.deleteMany({
        where: { consortiumId, ...(rubroSobrante ? { rubroId: rubroSobrante } : {}) },
      });
      await tx.consortiumCoeficiente.deleteMany({
        where: { consortiumId, ...(coefSobrante ? { coeficienteId: coefSobrante } : {}) },
      });
      await tx.consortiumRubro.createMany({
        data: body.rubroIds.map((rubroId) => ({ consortiumId, rubroId })),
        skipDuplicates: true,
      });
      await tx.consortiumCoeficiente.createMany({
        data: body.coeficienteIds.map((coeficienteId) => ({ consortiumId, coeficienteId })),
        skipDuplicates: true,
      });
      // Los gastos fijos que apuntaban a algo que ya no está asignado quedan sin
      // etiqueta: si no, la hoja mostraría un rubro que el edificio no usa.
      if (rubrosHuerfanos > 0) {
        await tx.fixedExpense.updateMany({
          where: { consortiumId, rubroId: orphanedBy(body.rubroIds) },
          data: { rubroId: null },
        });
      }
      if (coefsHuerfanos > 0) {
        await tx.fixedExpense.updateMany({
          where: { consortiumId, coeficienteId: orphanedBy(body.coeficienteIds) },
          data: { coeficienteId: null },
        });
      }
    });

    return apiOk({ rubrosHuerfanos, coefsHuerfanos });
  } catch (error) {
    // `apiError` ya manda 400 con el detalle si es un ZodError; cualquier otra cosa
    // es un error interno y no tiene que filtrar mensajes de Prisma.
    return apiError(error);
  }
}
