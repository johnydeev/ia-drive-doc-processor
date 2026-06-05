import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { InvoiceRepository } from "@/repositories/invoice.repository";
import { GoogleSheetsService, SheetsRowMapping } from "@/services/googleSheets.service";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { resolveGoogleConfig, resolveMapping, resolveSheetName, resolveFolders } from "@/lib/clientProcessingConfig";
import { ClientDriveFolders, ClientGoogleConfig, ProcessingClient } from "@/types/client.types";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";
import { isPdf } from "@/lib/fileSignature";

const DEFAULT_MAPPING: SheetsRowMapping = {
  boletaNumber: "A",
  provider: "B",
  consortium: "C",
  providerTaxId: "D",
  detail: "E",
  observation: "F",
  dueDate: "G",
  amount: "H",
  alias: "I",
  clientNumber: "J",
  sourceFileUrl: "K",
  isDuplicate: "L",
  period: "M",
  paymentStatus: "N",
  bank: "O",
  remainingBalance: "P",
  paidAmount: "Q",
  installmentsCount: "R",
  paymentDate: "S",
  receiptUrl: "T",
  paidWith: "U",
};

const TIPO_GASTO_VALUES = ["ORDINARIO", "EXTRAORDINARIO", "PARTICULAR"] as const;

const createSchema = z.object({
  providerId:       z.string().min(1),
  periodId:         z.string().min(1),
  boletaNumber:     z.string().optional(),
  providerTaxId:    z.string().optional(),
  detail:           z.string().optional(),
  observation:      z.string().optional(),
  issueDate:        z.string().optional(),
  dueDate:          z.string().optional(),
  amount:           z.number().optional(),
  coeficienteId:    z.string().optional(),
  rubroId:          z.string().optional(),
  tipoGasto:        z.enum(TIPO_GASTO_VALUES).default("ORDINARIO"),
  tipoComprobante:  z.string().optional(),
});

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) return auth.error;

  const { id: consortiumId } = await context.params;
  const { searchParams } = new URL(request.url);
  const periodId = searchParams.get("periodId");

  try {
    const prisma = getPrismaClient();

    const consortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
      select: { id: true },
    });
    if (!consortium) {
      return NextResponse.json({ ok: false, error: "Consorcio no encontrado" }, { status: 404 });
    }

    const rawInvoices = await prisma.invoice.findMany({
      where: {
        consortiumId,
        clientId: auth.session.clientId,
        ...(periodId ? { periodId } : {}),
      },
      include: {
        coeficienteRef: { select: { id: true, name: true, value: true } },
        rubroRef:       { select: { id: true, name: true } },
        providerRef:    { select: { providerType: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const invoices = rawInvoices.map((inv) => ({
      ...inv,
      providerType: inv.providerRef?.providerType ?? "PROVEEDOR",
    }));

    return NextResponse.json({ ok: true, invoices });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Error al obtener boletas" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { id: consortiumId } = await context.params;

  try {
    const prisma = getPrismaClient();

    const consortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
      select: { id: true, rawName: true, bank: true },
    });
    if (!consortium) {
      return NextResponse.json({ ok: false, error: "Consorcio no encontrado" }, { status: 404 });
    }

    // El body llega como JSON (sin archivo) o como multipart/form-data cuando
    // la carga asistida adjunta el PDF que se escaneó, para guardarlo en Drive.
    const contentType = request.headers.get("content-type") ?? "";
    let body: z.infer<typeof createSchema>;
    let pdfFile: File | null = null;

    if (contentType.includes("multipart/form-data")) {
      const fd = await request.formData();
      const f = fd.get("pdf");
      if (f && typeof f !== "string") pdfFile = f;
      const field = (k: string): string | undefined => {
        const v = fd.get(k);
        return typeof v === "string" && v.length > 0 ? v : undefined;
      };
      const amountRaw = field("amount");
      body = createSchema.parse({
        providerId:      field("providerId"),
        periodId:        field("periodId"),
        boletaNumber:    field("boletaNumber"),
        providerTaxId:   field("providerTaxId"),
        detail:          field("detail"),
        observation:     field("observation"),
        issueDate:       field("issueDate"),
        dueDate:         field("dueDate"),
        amount:          amountRaw !== undefined ? Number(amountRaw) : undefined,
        coeficienteId:   field("coeficienteId"),
        rubroId:         field("rubroId"),
        tipoGasto:       field("tipoGasto") ?? "ORDINARIO",
        tipoComprobante: field("tipoComprobante"),
      });
    } else {
      body = createSchema.parse(await request.json());
    }

    const period = await prisma.period.findFirst({
      where: { id: body.periodId, consortiumId },
      select: { id: true, month: true, year: true },
    });
    if (!period) {
      return NextResponse.json({ ok: false, error: "Período no encontrado" }, { status: 404 });
    }

    const provider = await prisma.provider.findFirst({
      where: { id: body.providerId, clientId: auth.session.clientId },
      select: { id: true, canonicalName: true, cuit: true },
    });
    if (!provider) {
      return NextResponse.json({ ok: false, error: "Proveedor no encontrado" }, { status: 404 });
    }

    const canonicalTaxId = provider.cuit || body.providerTaxId || null;
    const canonicalTaxIdNorm = (canonicalTaxId ?? "").replace(/\D/g, "");

    // ── Leer y validar el PDF (si vino), antes de cualquier cosa ────────────
    const repo = new InvoiceRepository();
    const MAX_PDF_SIZE = 15 * 1024 * 1024; // 15MB
    let pdfBuffer: Buffer | null = null;
    let driveWarning: string | null = null;
    if (pdfFile) {
      if (pdfFile.size > MAX_PDF_SIZE) {
        driveWarning = "El PDF supera 15MB, no se adjuntó a Drive.";
      } else {
        const buf = Buffer.from(await pdfFile.arrayBuffer());
        if (isPdf(buf)) pdfBuffer = buf;
        else driveWarning = "El archivo adjunto no es un PDF válido, no se guardó en Drive.";
      }
    }

    // ── Deduplicación ANTES de guardar (igual que el pipeline) ──────────────
    // Hash REAL del binario (no un hash con timestamp): así detecta el mismo
    // PDF aunque la IA lea los datos distinto. Sin PDF, hash determinístico de
    // los datos de negocio. Si es duplicado, se corta con error (no se guarda
    // ni se sube a Drive).
    const documentHash = pdfBuffer
      ? repo.computeDocumentHash(pdfBuffer)
      : repo.computeDocumentHash(
          `manual:${auth.session.clientId}:${consortiumId}:${canonicalTaxIdNorm}:` +
          `${(body.boletaNumber ?? "").trim().toUpperCase()}:${body.dueDate ?? ""}:${body.amount ?? ""}`
        );

    const dupByHash = await repo.findDuplicateByHash(auth.session.clientId, documentHash);
    if (dupByHash) {
      return NextResponse.json(
        { ok: false, error: "Esta boleta ya fue cargada (el mismo archivo ya existe)." },
        { status: 409 }
      );
    }

    const dupByKey = await repo.findDuplicateByBusinessKey(auth.session.clientId, {
      boletaNumber: body.boletaNumber ?? null,
      provider: provider.canonicalName,
      consortium: consortium.rawName,
      providerTaxId: canonicalTaxId,
      detail: null,
      observation: null,
      dueDate: body.dueDate ?? null,
      amount: body.amount ?? null,
      alias: null,
      clientNumber: null,
      paymentMethod: null,
      allTaxIds: [],
    } as ExtractedDocumentData);
    if (dupByKey) {
      return NextResponse.json(
        { ok: false, error: "Ya existe una boleta con el mismo N°, CUIT, vencimiento y monto." },
        { status: 409 }
      );
    }

    // Config del cliente (Drive + Sheets), resuelta una sola vez.
    const clientRow = await prisma.client.findUnique({
      where: { id: auth.session.clientId },
      select: { driveFoldersJson: true, googleConfigJson: true, extractionConfigJson: true },
    });
    const processingClient: ProcessingClient | null = clientRow
      ? {
          id: auth.session.clientId,
          name: "",
          isActive: true,
          batchSize: 10,
          intervalMinutes: 60,
          driveFoldersJson: (clientRow.driveFoldersJson as ClientDriveFolders | null) ?? null,
          googleConfigJson: (clientRow.googleConfigJson as ClientGoogleConfig | null) ?? null,
          extractionConfigJson: (clientRow.extractionConfigJson as Record<string, unknown> | null) ?? null,
        }
      : null;
    const googleConfig = processingClient ? resolveGoogleConfig(processingClient) : null;

    // ── Subir el PDF a Drive (ya leído y validado arriba) ──────────────────
    // La boleta se guarda igual aunque Drive falle; el motivo se expone vía
    // `driveWarning` (ya puede traer un aviso si el PDF era inválido).
    let sourceFileUrl: string | null = null;
    let driveFileId: string | null = null;

    if (pdfBuffer) {
      if (!googleConfig) {
        driveWarning = "Sin credenciales de Google, el PDF no se guardó en Drive.";
      } else {
        const folders = processingClient ? resolveFolders(processingClient) : ({} as ReturnType<typeof resolveFolders>);
        const destFolderId = folders.scanned ?? folders.receipts ?? null;
        if (!destFolderId) {
          driveWarning = "Sin carpeta de Drive configurada (Escaneados), el PDF no se guardó.";
        } else {
          try {
            const driveService = new GoogleDriveService(googleConfig);
            const fileName = pdfFile!.name || `boleta_${Date.now()}.pdf`;
            const uploaded = await driveService.uploadFile(pdfBuffer, fileName, "application/pdf", destFolderId);
            driveFileId = uploaded.id || null;
            sourceFileUrl =
              uploaded.webViewLink ??
              (uploaded.id ? `https://drive.google.com/file/d/${uploaded.id}/view` : null);
          } catch (driveError) {
            const detail = driveError instanceof Error ? driveError.message : "Error desconocido";
            console.warn(`[manual-invoice] drive upload failed: ${detail}`);
            driveWarning = `No se pudo subir el PDF a Drive: ${detail}`;
          }
        }
      }
    }

    const invoice = await prisma.invoice.create({
      data: {
        clientId:         auth.session.clientId,
        consortiumId,
        providerId:       body.providerId,
        periodId:         body.periodId,
        documentHash,
        boletaNumber:     body.boletaNumber || null,
        provider:         provider.canonicalName,
        consortium:       consortium.rawName,
        providerTaxId:    canonicalTaxId,
        detail:           body.detail || null,
        observation:      body.observation || null,
        issueDate:        body.issueDate ? new Date(body.issueDate) : null,
        dueDate:          body.dueDate ? new Date(body.dueDate) : null,
        amount:           body.amount ?? null,
        coeficienteId:    body.coeficienteId || null,
        rubroId:          body.rubroId || null,
        tipoGasto:        body.tipoGasto,
        tipoComprobante:  body.tipoComprobante || null,
        isManual:         true,
        isDuplicate:      false,
        driveFileId,
        sourceFileUrl,
        boletaNumberNorm: (body.boletaNumber ?? "").toUpperCase().trim(),
        providerTaxIdNorm: canonicalTaxIdNorm,
        dueDateNorm:      body.dueDate ?? "",
        amountNorm:       body.amount != null ? String(Number(body.amount).toFixed(2)) : "",
      },
    });

    // Insertar en Google Sheets.
    // La boleta YA está en la DB. Si Sheets falla, no abortamos (sería peor
    // dejar la boleta sin guardar), pero exponemos el motivo al usuario vía
    // `sheetsWarning` en la respuesta para que no quede un fallo silencioso.
    let sheetsWarning: string | null = null;
    try {
      if (processingClient) {
        const sheetName = resolveSheetName(processingClient);
        const mapping = resolveMapping(processingClient) ?? DEFAULT_MAPPING;

        if (!googleConfig) {
          sheetsWarning = "El cliente no tiene Google Sheets configurado, la boleta no se escribió en la planilla.";
        } else {
          const sheetsService = new GoogleSheetsService(googleConfig);
          const sheetData: ExtractedDocumentData = {
            boletaNumber:  invoice.boletaNumber,
            provider:      invoice.provider,
            consortium:    consortium.rawName,
            providerTaxId: invoice.providerTaxId,
            detail:        invoice.detail,
            observation:   invoice.observation,
            dueDate:       invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
            amount:        invoice.amount ? Number(invoice.amount) : null,
            alias:         null,
            clientNumber:  null,
            paymentMethod: null,
            period:        period ? `${String(period.month).padStart(2, "0")}/${period.year}` : null,
            sourceFileUrl: invoice.sourceFileUrl,
            isDuplicate:   "NO",
            paymentStatus: "Sin pagar",
            bank: consortium.bank ?? null,
          };
          await sheetsService.insertRow(sheetName, sheetData, mapping);
        }
      }
    } catch (sheetsError) {
      const detail = sheetsError instanceof Error ? sheetsError.message : "Error desconocido";
      console.warn(`[manual-invoice] sheets insert failed invoiceId=${invoice.id}: ${detail}`);
      sheetsWarning = `La boleta se guardó pero no se pudo escribir en Google Sheets: ${detail}`;
    }

    return NextResponse.json({ ok: true, invoice, sheetsWarning, driveWarning });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((i) => i.message).join(", ")
        : error instanceof Error
          ? error.message
          : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
