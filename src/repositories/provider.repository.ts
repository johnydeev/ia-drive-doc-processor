import { Provider } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";

export class ProviderRepository {
  /**
   * Busca un proveedor por CUIT verificando que esté vinculado al consorcio indicado.
   * Solo lectura — nunca crea. Retorna null si no existe o no está asignado.
   */
  async findByCuitInConsortium(
    clientId: string,
    cuit: string,
    consortiumId: string
  ): Promise<Provider | null> {
    const prisma = getPrismaClient();

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

  async linkToConsortium(providerId: string, consortiumId: string): Promise<void> {
    const prisma = getPrismaClient();

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
    const prisma = getPrismaClient();

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
    const prisma = getPrismaClient();

    return prisma.provider.findMany({
      where: { clientId },
      orderBy: {
        canonicalName: "asc",
      },
    });
  }
}
