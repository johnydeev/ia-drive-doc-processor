import { Provider, PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";

export class ProviderRepository {
  constructor(private readonly injectedPrisma?: PrismaClient) {}
  private get prisma(): PrismaClient {
    return this.injectedPrisma ?? getPrismaClient();
  }

  /**
   * Busca un proveedor por CUIT verificando que esté vinculado al consorcio indicado.
   * Solo lectura — nunca crea. Retorna null si no existe o no está asignado.
   */
  async findByCuitInConsortium(
    clientId: string,
    cuit: string,
    consortiumId: string
  ): Promise<Provider | null> {
    const prisma = this.prisma;

    const link = await prisma.consortiumProvider.findFirst({
      where: {
        consortiumId,
        provider: {
          clientId,
          cuit,
        },
      },
      include: { provider: true },
    });

    return link?.provider ?? null;
  }

  /**
   * Trae todos los proveedores del cliente con los campos necesarios para el
   * matching del pipeline (CUIT, alias internos, alias de pago). Sirve tanto al
   * lookup por CUIT de LSP como al matching general de proveedor.
   */
  async findAllForMatching(clientId: string) {
    return this.prisma.provider.findMany({
      where: { clientId },
      select: { id: true, canonicalName: true, cuit: true, matchNames: true, paymentAlias: true },
    });
  }

  async linkToConsortium(providerId: string, consortiumId: string): Promise<void> {
    const prisma = this.prisma;

    await prisma.consortiumProvider.upsert({
      where: {
        consortiumId_providerId: {
          consortiumId,
          providerId,
        },
      },
      create: {
        consortiumId,
        providerId,
      },
      update: {},
    });
  }

  async listByConsortium(consortiumId: string): Promise<Provider[]> {
    const prisma = this.prisma;

    const rows = await prisma.consortiumProvider.findMany({
      where: { consortiumId },
      include: { provider: true },
      orderBy: {
        provider: {
          canonicalName: "asc",
        },
      },
    });

    return rows.map((row) => row.provider);
  }

  async listByClient(clientId: string): Promise<Provider[]> {
    const prisma = this.prisma;

    return prisma.provider.findMany({
      where: { clientId },
      orderBy: {
        canonicalName: "asc",
      },
    });
  }
}
