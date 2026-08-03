import { Bank, PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";

/**
 * Acceso a datos del catálogo de bancos (nivel Client, como Rubro y Coeficiente).
 * Sólo operaciones de base de datos — la validación vive en las rutas.
 */
export class BankRepository {
  constructor(private readonly injectedPrisma?: PrismaClient) {}
  private get prisma(): PrismaClient {
    return this.injectedPrisma ?? getPrismaClient();
  }

  /** Bancos del cliente, alfabéticos, con la cantidad de consorcios asignados. */
  async listByClient(clientId: string): Promise<Array<Bank & { _count: { consortiums: number } }>> {
    return this.prisma.bank.findMany({
      where: { clientId },
      include: { _count: { select: { consortiums: true } } },
      orderBy: { name: "asc" },
    });
  }

  async findById(clientId: string, id: string): Promise<Bank | null> {
    return this.prisma.bank.findFirst({ where: { id, clientId } });
  }

  async create(clientId: string, name: string, color: string): Promise<Bank> {
    return this.prisma.bank.create({ data: { clientId, name, color } });
  }

  async update(id: string, data: { name?: string; color?: string }): Promise<Bank> {
    return this.prisma.bank.update({ where: { id }, data });
  }

  /** Borra el banco. Los consorcios asignados quedan con `bankId = null` (SetNull). */
  async remove(id: string): Promise<void> {
    await this.prisma.bank.delete({ where: { id } });
  }
}
