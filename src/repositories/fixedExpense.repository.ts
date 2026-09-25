import { DocKind, FixedExpense, PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";
import { validateFixedExpenseTarget } from "@/lib/fixedExpense";

export interface CreateFixedExpenseInput {
  clientId: string;
  consortiumId: string;
  providerId?: string | null;
  lspServiceId?: string | null;
  description?: string | null;
  /** FACTURA (default) o RETENCION — spec 2026-09-17. */
  kind?: DocKind;
}

export class FixedExpenseError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "FixedExpenseError";
  }
}

export class FixedExpenseRepository {
  constructor(private readonly injectedPrisma?: PrismaClient) {}
  private get prisma(): PrismaClient {
    return this.injectedPrisma ?? getPrismaClient();
  }

  async listByConsortium(consortiumId: string, clientId: string): Promise<FixedExpense[]> {
    return this.prisma.fixedExpense.findMany({
      where: { consortiumId, clientId },
      orderBy: { createdAt: "asc" },
    });
  }

  async create(input: CreateFixedExpenseInput): Promise<FixedExpense> {
    const target = {
      providerId: input.providerId ?? null,
      lspServiceId: input.lspServiceId ?? null,
      kind: input.kind ?? ("FACTURA" as DocKind),
    };
    const err = validateFixedExpenseTarget(target);
    if (err) throw new FixedExpenseError(err, 400);

    // Dedupe a nivel app: mismo consorcio + mismo objetivo + mismo tipo. La factura
    // y la retención del mismo proveedor son dos gastos fijos (spec 2026-09-17).
    const existing = await this.prisma.fixedExpense.findFirst({
      where: {
        consortiumId: input.consortiumId,
        providerId: target.providerId,
        lspServiceId: target.lspServiceId,
        kind: target.kind,
      },
    });
    if (existing) throw new FixedExpenseError("Ese gasto fijo ya está cargado en el consorcio.", 409);

    return this.prisma.fixedExpense.create({
      data: {
        clientId: input.clientId,
        consortiumId: input.consortiumId,
        providerId: target.providerId,
        lspServiceId: target.lspServiceId,
        kind: target.kind,
        description: input.description ?? null,
      },
    });
  }

  async update(
    id: string,
    clientId: string,
    data: {
      active?: boolean;
      description?: string | null;
      /// Etiqueta que heredan las boletas de este gasto fijo (spec 2026-09-24).
      /// Que el rubro/coeficiente pertenezcan al edificio lo valida el endpoint.
      rubroId?: string | null;
      coeficienteId?: string | null;
    }
  ): Promise<FixedExpense> {
    const fx = await this.prisma.fixedExpense.findFirst({ where: { id, clientId } });
    if (!fx) throw new FixedExpenseError("Gasto fijo no encontrado", 404);
    return this.prisma.fixedExpense.update({
      where: { id },
      data: {
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.rubroId !== undefined ? { rubroId: data.rubroId } : {}),
        ...(data.coeficienteId !== undefined ? { coeficienteId: data.coeficienteId } : {}),
      },
    });
  }

  async delete(id: string, clientId: string): Promise<void> {
    const fx = await this.prisma.fixedExpense.findFirst({ where: { id, clientId } });
    if (!fx) throw new FixedExpenseError("Gasto fijo no encontrado", 404);
    await this.prisma.fixedExpense.delete({ where: { id } });
  }
}

/**
 * IDs de proveedor de los gastos fijos de EMPLEADO activos de un consorcio.
 *
 * Es el **padrón del edificio**: la única fuente exacta de cuántos empleados
 * tiene. Contra esto se valida que una Liquidación de Sueldos Digital venga completo —
 * el papel no declara la cantidad de empleados, y contar los CUIL de su texto es
 * ruidoso porque el libro está lleno de números largos que pasan el checksum por
 * casualidad (spec `2026-09-01-lsd-un-libro-n-empleados-design.md` §3.5).
 */
export async function findActiveEmployeeFixedExpenseProviderIds(
  consortiumId: string
): Promise<string[]> {
  const rows = await getPrismaClient().fixedExpense.findMany({
    where: {
      consortiumId,
      active: true,
      providerId: { not: null },
      provider: { providerType: "EMPLEADO" },
    },
    select: { providerId: true },
  });

  return rows.map((row) => row.providerId).filter((id): id is string => Boolean(id));
}
