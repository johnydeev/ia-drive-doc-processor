import { FixedExpense, PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";
import { validateFixedExpenseTarget } from "@/lib/fixedExpense";

export interface CreateFixedExpenseInput {
  clientId: string;
  consortiumId: string;
  providerId?: string | null;
  lspServiceId?: string | null;
  description?: string | null;
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
    };
    const err = validateFixedExpenseTarget(target);
    if (err) throw new FixedExpenseError(err, 400);

    // Dedupe a nivel app: mismo consorcio + mismo objetivo.
    const existing = await this.prisma.fixedExpense.findFirst({
      where: {
        consortiumId: input.consortiumId,
        providerId: target.providerId,
        lspServiceId: target.lspServiceId,
      },
    });
    if (existing) throw new FixedExpenseError("Ese gasto fijo ya está cargado en el consorcio.", 409);

    return this.prisma.fixedExpense.create({
      data: {
        clientId: input.clientId,
        consortiumId: input.consortiumId,
        providerId: target.providerId,
        lspServiceId: target.lspServiceId,
        description: input.description ?? null,
      },
    });
  }

  async update(
    id: string,
    clientId: string,
    data: { active?: boolean; description?: string | null }
  ): Promise<FixedExpense> {
    const fx = await this.prisma.fixedExpense.findFirst({ where: { id, clientId } });
    if (!fx) throw new FixedExpenseError("Gasto fijo no encontrado", 404);
    return this.prisma.fixedExpense.update({
      where: { id },
      data: {
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
      },
    });
  }

  async delete(id: string, clientId: string): Promise<void> {
    const fx = await this.prisma.fixedExpense.findFirst({ where: { id, clientId } });
    if (!fx) throw new FixedExpenseError("Gasto fijo no encontrado", 404);
    await this.prisma.fixedExpense.delete({ where: { id } });
  }
}
