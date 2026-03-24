import { Consortium, Period } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";

export class ConsortiumRepository {
  /**
   * Busca un consorcio por nombre canónico. Solo lectura — nunca crea.
   * Retorna null si no existe.
   */
  async findByCanonicalName(
    clientId: string,
    canonicalName: string
  ): Promise<(Consortium & { periods: Period[] }) | null> {
    const prisma = getPrismaClient();

    return prisma.consortium.findUnique({
      where: {
        clientId_canonicalName: {
          clientId,
          canonicalName,
        },
      },
      include: { periods: true },
    });
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

  /**
   * Calcula el mes/año para el período inicial de un consorcio nuevo.
   * Si hay otros consorcios con períodos activos → usa el mes mayoritario.
   * Si no hay ninguno → usa el mes/año actual del sistema.
   */
  async resolveMajorityMonth(clientId: string): Promise<{ year: number; month: number }> {
    const prisma = getPrismaClient();
    const activePeriods = await prisma.period.findMany({
      where: { consortium: { clientId }, status: "ACTIVE" },
      select: { year: true, month: true },
    });

    if (activePeriods.length === 0) {
      const now = new Date();
      return { year: now.getFullYear(), month: now.getMonth() + 1 };
    }

    const freq = new Map<string, number>();
    for (const p of activePeriods) {
      const key = `${p.year}-${p.month}`;
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }

    let majorityKey = "";
    let majorityCount = 0;
    for (const [key, count] of freq) {
      if (count > majorityCount) {
        majorityKey = key;
        majorityCount = count;
      }
    }

    const [year, month] = majorityKey.split("-").map(Number);
    return { year, month };
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
    const { year, month } = await this.resolveMajorityMonth(input.clientId);

    const created = await prisma.$transaction(async (tx) => {
      const consortium = await tx.consortium.create({
        data: {
          clientId: input.clientId,
          canonicalName: input.canonicalName,
          rawName: input.rawName ?? input.canonicalName,
          cuit: input.cuit ?? null,
          cutoffDay: input.cutoffDay ?? 5,
          driveFolderProcessedId: input.driveFolderProcessedId ?? null,
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
