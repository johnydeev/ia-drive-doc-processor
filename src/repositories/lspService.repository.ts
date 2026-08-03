import { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";

/**
 * Include compartido para resolver una factura LSP: trae el consorcio (con los
 * campos que el pipeline necesita para canonizar y organizar en Rendiciones) y
 * el proveedor vinculado.
 */
const LSP_MATCH_INCLUDE = {
  consortium: {
    // `bank` es la relación al catálogo: alimenta la columna O (BANCO) de Sheets.
    select: { id: true, canonicalName: true, rawName: true, bank: { select: { name: true } }, statementsFolderId: true },
  },
  providerRef: {
    select: { id: true, canonicalName: true, cuit: true, paymentAlias: true },
  },
} as const;

export class LspServiceRepository {
  constructor(private readonly injectedPrisma?: PrismaClient) {}
  private get prisma(): PrismaClient {
    return this.injectedPrisma ?? getPrismaClient();
  }

  /** Busca un LspService por el proveedor (FK) + número de cliente. */
  async findByProviderId(clientId: string, providerId: string, clientNumber: string) {
    return this.prisma.lspService.findFirst({
      where: { clientId, providerId, clientNumber },
      include: LSP_MATCH_INCLUDE,
    });
  }

  /** Fallback: busca por nombre canónico del proveedor (campo texto) + número de cliente. */
  async findByProviderName(clientId: string, providerName: string, clientNumber: string) {
    return this.prisma.lspService.findFirst({
      where: { clientId, providerName, clientNumber },
      include: LSP_MATCH_INCLUDE,
    });
  }

  /** Asocia el providerId (FK) a un LspService que aún no lo tenía. */
  async setProviderId(id: string, providerId: string): Promise<void> {
    await this.prisma.lspService.update({
      where: { id },
      data: { providerId },
    });
  }
}
