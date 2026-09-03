import { createHash } from "crypto";
import { Invoice, Prisma, PrismaClient } from "@prisma/client";
import {
  buildBusinessKeyParts,
  buildBusinessKeyString,
  BusinessKeyParts,
} from "@/lib/businessKey";
import { getPrismaClient } from "@/lib/prisma";
import { cuitDigits } from "@/lib/cuit";
import { repoLog, shortLogId } from "@/lib/logger";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

export interface DuplicateLookupResult {
  extraction: Omit<ExtractedDocumentData, "sourceFileUrl" | "isDuplicate"> | null;
  sourceFileUrl?: string;
  fileId?: string;
  businessKey: string | null;
}

export interface SaveInvoiceInput {
  clientId: string;
  documentHash: string;
  fileId: string;
  sourceFileUrl?: string;
  extraction: Omit<ExtractedDocumentData, "sourceFileUrl" | "isDuplicate">;
  isDuplicate: boolean;
  consortiumId?: string;
  providerId?: string;
  periodId?: string;
  lspServiceId?: string | null;
  paymentMethod?: string | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  tokensTotal?: number | null;
  aiProvider?: string | null;
  aiModel?: string | null;
}

export class InvoiceRepository {
  /**
   * Prisma se inyecta opcionalmente (para tests). En runtime cae al singleton
   * vía getter lazy, preservando el comportamiento previo (la conexión se
   * resuelve al usar el repo, no al construirlo).
   */
  constructor(private readonly injectedPrisma?: PrismaClient) {}
  private get prisma(): PrismaClient {
    return this.injectedPrisma ?? getPrismaClient();
  }

  computeDocumentHash(input: Buffer | string): string {
    return createHash("sha256").update(input).digest("hex");
  }

  /**
   * Hash de documento por empleado, para las N boletas de un mismo Libro de
   * Sueldos Digital.
   *
   * `Invoice` tiene unique `(clientId, documentHash)`, así que N boletas que
   * comparten el PDF lo violarían. Derivar del CUIL las hace únicas **sin
   * migración** y conservando la garantía a nivel base.
   *
   * Se compara por dígitos para que el formato del CUIL no cambie el hash.
   */
  deriveDocumentHash(fileHash: string, cuil: string): string {
    return createHash("sha256").update(`${fileHash}:${cuitDigits(cuil)}`).digest("hex");
  }

  /**
   * ¿Ya hay alguna boleta cargada para este archivo de Drive?
   *
   * Es el corte temprano del reproceso: el hash derivado de un LSD no coincide
   * con el del binario, así que sin esta consulta un libro reprocesado volvería
   * a gastar la extracción de IA antes de que la clave de negocio lo frene.
   */
  async findAnyByDriveFileId(
    clientId: string,
    driveFileId: string
  ): Promise<DuplicateLookupResult | null> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { clientId, driveFileId },
      orderBy: { createdAt: "asc" },
    });

    if (!invoice) return null;

    repoLog.debug("invoice", `duplicate-by-drive-file client=${shortLogId(clientId)} file=${driveFileId}`);
    // Mismo shape que el duplicado por hash: el pipeline reusa la extracción
    // guardada y no vuelve a llamar a la IA.
    return this.mapInvoiceDuplicate(invoice);
  }

  buildBusinessKeyFromData(data: ExtractedDocumentData): string | null {
    return buildBusinessKeyString(buildBusinessKeyParts(data));
  }

  async findDuplicateByHash(clientId: string, documentHash: string): Promise<DuplicateLookupResult | null> {
    const prisma = this.prisma;
    const invoice = await prisma.invoice.findUnique({
      where: {
        clientId_documentHash: {
          clientId,
          documentHash,
        },
      },
    });

    if (!invoice) {
      return null;
    }

    repoLog.debug(
      "invoice",
      `duplicate-by-hash client=${shortLogId(clientId)} hash=${shortHash(documentHash)}`
    );

    return this.mapInvoiceDuplicate(invoice);
  }

  async findDuplicateByBusinessKey(
    clientId: string,
    data: ExtractedDocumentData
  ): Promise<DuplicateLookupResult | null> {
    const parts = buildBusinessKeyParts(data);
    const businessKey = buildBusinessKeyString(parts);
    if (!businessKey) {
      return null;
    }

    // Si hay boletaNumber, es el campo primario — debe coincidir exactamente.
    // Si no hay boletaNumber, buscar por los demás campos presentes.
    // Solo se incluyen en el WHERE los campos no vacíos para evitar matches
    // contra filas con strings vacíos.
    const whereClause: Prisma.InvoiceWhereInput = { clientId };

    if (parts.boletaNumberNorm) {
      whereClause.boletaNumberNorm = parts.boletaNumberNorm;
    }
    if (parts.providerTaxIdNorm) {
      whereClause.providerTaxIdNorm = parts.providerTaxIdNorm;
    }
    if (parts.dueDateNorm) {
      whereClause.dueDateNorm = parts.dueDateNorm;
    }
    if (parts.amountNorm) {
      whereClause.amountNorm = parts.amountNorm;
    }

    // Requerir al menos 2 campos presentes para considerar un posible duplicado
    const conditionCount = [
      parts.boletaNumberNorm,
      parts.providerTaxIdNorm,
      parts.dueDateNorm,
      parts.amountNorm,
    ].filter(Boolean).length;

    if (conditionCount < 2) return null;

    const prisma = this.prisma;
    const invoice = await prisma.invoice.findFirst({ where: whereClause });

    if (!invoice) {
      return null;
    }

    repoLog.debug(
      "invoice",
      `duplicate-by-business-key client=${shortLogId(clientId)} key=${shortKey(businessKey)}`
    );

    return this.mapInvoiceDuplicate(invoice);
  }

  async findByPeriod(periodId: string): Promise<Invoice[]> {
    const prisma = this.prisma;
    return prisma.invoice.findMany({
      where: { periodId },
      orderBy: { createdAt: "desc" },
    });
  }

  async findByConsortium(consortiumId: string, clientId: string): Promise<Invoice[]> {
    const prisma = this.prisma;
    return prisma.invoice.findMany({
      where: { consortiumId, clientId },
      orderBy: { createdAt: "desc" },
    });
  }

  async saveProcessedInvoice(input: SaveInvoiceInput): Promise<Invoice | null> {
    const parts = ensurePersistableBusinessKeyParts(
      buildBusinessKeyParts(input.extraction),
      input.documentHash
    );

    const prisma = this.prisma;

    try {
      const invoice = await prisma.invoice.upsert({
        where: {
          clientId_documentHash: {
            clientId: input.clientId,
            documentHash: input.documentHash,
          },
        },
        create: {
          clientId: input.clientId,
          consortiumId: input.consortiumId ?? null,
          documentHash: input.documentHash,
          driveFileId: input.fileId,
          sourceFileUrl: input.sourceFileUrl,
          isDuplicate: input.isDuplicate,
          boletaNumber: input.extraction.boletaNumber,
          provider: input.extraction.provider,
          consortium: input.extraction.consortium,
          providerId: input.providerId ?? null,
          providerTaxId: input.extraction.providerTaxId,
          detail: input.extraction.detail,
          observation: input.extraction.observation,
          dueDate: parseDueDate(input.extraction.dueDate),
          periodId: input.periodId ?? null,
          amount: input.extraction.amount,
          alias: input.extraction.alias,
          lspServiceId: input.lspServiceId ?? null,
          paymentMethod: input.paymentMethod as any ?? null,
          tokensInput: input.tokensInput ?? null,
          tokensOutput: input.tokensOutput ?? null,
          tokensTotal: input.tokensTotal ?? null,
          aiProvider: input.aiProvider ?? null,
          aiModel: input.aiModel ?? null,
          boletaNumberNorm: parts.boletaNumberNorm,
          providerTaxIdNorm: parts.providerTaxIdNorm,
          dueDateNorm: parts.dueDateNorm,
          amountNorm: parts.amountNorm,
        },
        update: {
          driveFileId: input.fileId,
          sourceFileUrl: input.sourceFileUrl,
          isDuplicate: input.isDuplicate,
          boletaNumber: input.extraction.boletaNumber,
          provider: input.extraction.provider,
          consortium: input.extraction.consortium,
          consortiumId: input.consortiumId ?? null,
          providerId: input.providerId ?? null,
          providerTaxId: input.extraction.providerTaxId,
          detail: input.extraction.detail,
          observation: input.extraction.observation,
          dueDate: parseDueDate(input.extraction.dueDate),
          periodId: input.periodId ?? null,
          amount: input.extraction.amount,
          alias: input.extraction.alias,
          lspServiceId: input.lspServiceId ?? null,
          paymentMethod: input.paymentMethod as any ?? null,
          tokensInput: input.tokensInput ?? null,
          tokensOutput: input.tokensOutput ?? null,
          tokensTotal: input.tokensTotal ?? null,
          aiProvider: input.aiProvider ?? null,
          aiModel: input.aiModel ?? null,
          boletaNumberNorm: parts.boletaNumberNorm,
          providerTaxIdNorm: parts.providerTaxIdNorm,
          dueDateNorm: parts.dueDateNorm,
          amountNorm: parts.amountNorm,
        },
      });

      repoLog.debug(
        "invoice",
        `save client=${shortLogId(input.clientId)} hash=${shortHash(input.documentHash)} duplicate=${input.isDuplicate}`
      );

      return invoice;
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      const isUniqueConflict = message.includes("p2002") || message.includes("unique constraint");

      if (isUniqueConflict) {
        repoLog.warn(
          "invoice",
          `save unique-conflict client=${shortLogId(input.clientId)} hash=${shortHash(input.documentHash)}`
        );
        return null;
      }

      throw error;
    }
  }

  private mapInvoiceDuplicate(invoice: Invoice): DuplicateLookupResult {
    return {
      extraction: {
        boletaNumber: invoice.boletaNumber,
        provider: invoice.provider,
        consortium: invoice.consortium,
        providerTaxId: invoice.providerTaxId,
        detail: invoice.detail,
        observation: invoice.observation,
        dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
        amount: invoice.amount !== null ? Number(invoice.amount) : null,
        alias: invoice.alias,
        clientNumber: null,
        paymentMethod: null,
      },
      sourceFileUrl: invoice.sourceFileUrl ?? undefined,
      fileId: invoice.driveFileId ?? undefined,
      businessKey: buildBusinessKeyString({
        boletaNumberNorm: invoice.boletaNumberNorm,
        providerTaxIdNorm: invoice.providerTaxIdNorm,
        dueDateNorm: invoice.dueDateNorm,
        amountNorm: invoice.amountNorm,
      }),
    };
  }
}

function ensurePersistableBusinessKeyParts(
  parts: BusinessKeyParts,
  documentHash: string
): BusinessKeyParts {
  if (buildBusinessKeyString(parts)) {
    return parts;
  }

  return {
    ...parts,
    boletaNumberNorm: `__hash__${documentHash.toLowerCase()}`,
  };
}

function parseDueDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function shortHash(hash: string): string {
  if (hash.length <= 12) {
    return hash;
  }

  return `${hash.slice(0, 6)}...${hash.slice(-6)}`;
}

function shortKey(key: string): string {
  return key.length > 70 ? `${key.slice(0, 70)}...` : key;
}
