import type { PrismaClient } from "@prisma/client";
import { checkAssignable } from "@/lib/rubroAssignment";

/**
 * ¿El rubro / coeficiente se puede poner en un gasto fijo o boleta de este edificio?
 * Devuelve el mensaje de error, o null si vale. Sólo consulta lo que viene definido
 * (`undefined` = no se toca). Lo usan el PATCH del gasto fijo y el de etiquetas.
 */
export async function validateLabels(
  prisma: PrismaClient,
  consortiumId: string,
  labels: { rubroId?: string | null; coeficienteId?: string | null }
): Promise<string | null> {
  if (labels.rubroId !== undefined) {
    const asignados = await prisma.consortiumRubro.findMany({ where: { consortiumId }, select: { rubroId: true } });
    const check = checkAssignable(labels.rubroId, asignados.map((a) => a.rubroId), "rubro");
    if (!check.ok) return check.error;
  }
  if (labels.coeficienteId !== undefined) {
    const asignados = await prisma.consortiumCoeficiente.findMany({ where: { consortiumId }, select: { coeficienteId: true } });
    const check = checkAssignable(labels.coeficienteId, asignados.map((a) => a.coeficienteId), "coeficiente");
    if (!check.ok) return check.error;
  }
  return null;
}
