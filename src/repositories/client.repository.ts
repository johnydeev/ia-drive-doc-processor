import { Client, PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";
import { ClientDriveFolders, ClientGoogleConfig, ProcessingClient } from "@/types/client.types";

export class ClientRepository {
  constructor(private readonly injectedPrisma?: PrismaClient) {}
  private get prisma(): PrismaClient {
    return this.injectedPrisma ?? getPrismaClient();
  }

  async listActiveClients(): Promise<ProcessingClient[]> {
    const prisma = this.prisma;
    const rows = await prisma.client.findMany({
      where: { isActive: true, role: "CLIENT" },
      orderBy: { createdAt: "asc" },
    });

    return rows.map((row) => this.mapClient(row));
  }

  /** Releer un cliente puntual antes de cada ciclo (intervalMinutes/batchSize al día). Null si se desactivó/borró. */
  async findActiveById(id: string): Promise<ProcessingClient | null> {
    const prisma = this.prisma;
    const row = await prisma.client.findFirst({
      where: { id, isActive: true, role: "CLIENT" },
    });
    return row ? this.mapClient(row) : null;
  }

  private mapClient(row: Client): ProcessingClient {
    return {
      id: row.id,
      name: row.name,
      isActive: row.isActive,
      batchSize: row.batchSize,
      intervalMinutes: row.intervalMinutes,
      driveFoldersJson: (row.driveFoldersJson as ClientDriveFolders | null | undefined) ?? null,
      googleConfigJson: (row.googleConfigJson as ClientGoogleConfig | null | undefined) ?? null,
      extractionConfigJson:
        (row.extractionConfigJson as Record<string, unknown> | null | undefined) ?? null,
    };
  }
}
