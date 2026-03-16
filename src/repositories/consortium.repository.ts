import { Prisma, Consortium, Period } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";

export class ConsortiumRepository {
  async findOrCreateByCanonicalName(
    clientId: string,
    canonicalName: string,
    rawName: string
  ): Promise<{ consortium: Consortium & { periods: Period[] }; created: boolean }> {
    const prisma = getPrismaClient();

    const existing = await prisma.consortium.findUnique({
      where: {
        clientId_canonicalName: {
          clientId,
          canonicalName,
        },
      },
      include: { periods: true },
    });

    if (existing) {
      return { consortium: existing, created: false };
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const created = await prisma.$transaction(async (tx) => {
      const consortium = await tx.consortium.create({
        data: {
          clientId,
          canonicalName,
          rawName,
          isAutoCreated: true,
        },
      });

      await tx.period.create({
        data: {
          clientId,
          consortiumId: consortium.id,
          year,
          month,
          status: "ACTIVE",
        },
      });

      return tx.consortium.findUnique({
        where: { id: consortium.id },
        include: { periods: true },
      });
    });

    if (!created) {
      throw new Error("Failed to create consortium");
    }

    return { consortium: created, created: true };
  }

  async findActivePeriod(consortiumId: string): Promise<Period | null> {
    const prisma = getPrismaClient();

    return prisma.period.findFirst({
      where: {
        consortiumId,
        status: "ACTIVE",
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  async closePeriodAndCreateNext(consortiumId: string): Promise<Period> {
    const prisma = getPrismaClient();

    return prisma.$transaction(async (tx) => {
      const current = await tx.period.findFirst({
        where: {
          consortiumId,
          status: "ACTIVE",
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      if (!current) {
        throw new Error("No active period found for consortium");
      }

      await tx.period.update({
        where: { id: current.id },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
        },
      });

      const nextMonth = current.month === 12 ? 1 : current.month + 1;
      const nextYear = current.month === 12 ? current.year + 1 : current.year;

      return tx.period.create({
        data: {
          clientId: current.clientId,
          consortiumId: current.consortiumId,
          year: nextYear,
          month: nextMonth,
          status: "ACTIVE",
        },
      });
    });
  }

  async listByClient(
    clientId: string
  ): Promise<Array<Consortium & { periods: Period[]; _count: { invoices: number } }>> {
    const prisma = getPrismaClient();

    return prisma.consortium.findMany({
      where: { clientId },
      include: {
        periods: true,
        _count: {
          select: { invoices: true },
        },
      },
      orderBy: {
        canonicalName: "asc",
      },
    });
  }

  async createManual(input: {
    clientId: string;
    canonicalName: string;
    rawName?: string;
    cuit?: string;
    cutoffDay?: number;
    driveFolderProcessedId?: string;
  }): Promise<Consortium & { periods: Period[] }> {
    const prisma = getPrismaClient();
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const created = await prisma.$transaction(async (tx) => {
      const consortium = await tx.consortium.create({
        data: {
          clientId: input.clientId,
          canonicalName: input.canonicalName,
          rawName: input.rawName ?? input.canonicalName,
          cuit: input.cuit ?? null,
          cutoffDay: input.cutoffDay ?? 5,
          driveFolderProcessedId: input.driveFolderProcessedId ?? null,
          isAutoCreated: false,
        },
      });

      await tx.period.create({
        data: {
          clientId: input.clientId,
          consortiumId: consortium.id,
          year,
          month,
          status: "ACTIVE",
        },
      });

      return tx.consortium.findUnique({
        where: { id: consortium.id },
        include: { periods: true },
      });
    });

    if (!created) {
      throw new Error("Failed to create consortium");
    }

    return created;
  }
}
