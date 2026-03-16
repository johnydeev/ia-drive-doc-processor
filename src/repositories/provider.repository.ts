import { Provider } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";

export class ProviderRepository {
  async findOrCreateByCuit(
    clientId: string,
    cuit: string,
    canonicalName?: string
  ): Promise<{ provider: Provider; created: boolean }> {
    const prisma = getPrismaClient();

    const existing = await prisma.provider.findFirst({
      where: {
        clientId,
        cuit,
      },
    });

    if (existing) {
      return { provider: existing, created: false };
    }

    const created = await prisma.provider.create({
      data: {
        clientId,
        cuit,
        canonicalName: canonicalName?.trim() || cuit,
        isAutoCreated: true,
      },
    });

    return { provider: created, created: true };
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
