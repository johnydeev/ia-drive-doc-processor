import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { resolveGoogleConfig, resolveFolders } from "@/lib/clientProcessingConfig";

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/**
 * POST /api/client/consortiums/[id]/invoices/[invoiceId]/receipt
 *
 * Sube un PDF de recibo de pago a Drive y guarda el fileId y URL en la Invoice.
 *
 * La carpeta de destino en Drive es:
 *   [receipts folder del cliente] / [Nombre consorcio] / [Mes Año]
 *
 * Si no hay receipts folder configurado, usa la carpeta scanned como raíz.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; invoiceId: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { id: consortiumId, invoiceId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const prisma = getPrismaClient();

    // ── Verificar que la invoice pertenece al consorcio y al cliente ──────
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, clientId, consortiumId },
      include: {
        consortiumRef: { select: { rawName: true } },
        periodRef:     { select: { year: true, month: true } },
      },
    });

    if (!invoice) {
      return NextResponse.json({ ok: false, error: "Boleta no encontrada" }, { status: 404 });
    }

    // ── Leer el archivo del form ──────────────────────────────────────────
    const formData = await request.formData();
    const file = formData.get("receipt") as File | null;

    if (!file) {
      return NextResponse.json({ ok: false, error: "No se envió ningún archivo" }, { status: 400 });
    }

    if (file.type !== "application/pdf") {
      return NextResponse.json({ ok: false, error: "Solo se aceptan archivos PDF" }, { status: 400 });
    }

    // ── Obtener config de Drive del cliente ───────────────────────────────
    const clientRow = await prisma.client.findUnique({
      where: { id: clientId },
      select: { driveFoldersJson: true, googleConfigJson: true, extractionConfigJson: true },
    });

    if (!clientRow) {
      return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
    }

    const processingClient = {
      id: clientId,
      name: "",
      isActive: true,
      batchSize: 10,
      intervalMinutes: 60,
      driveFoldersJson: clientRow.driveFoldersJson as any,
      googleConfigJson: clientRow.googleConfigJson as any,
      extractionConfigJson: clientRow.extractionConfigJson as any,
    };

    const googleConfig = resolveGoogleConfig(processingClient);
    if (!googleConfig) {
      return NextResponse.json({ ok: false, error: "Sin credenciales de Google configuradas" }, { status: 400 });
    }

    const folders = resolveFolders(processingClient);

    // Carpeta raíz de recibos: usa receipts si está configurado, sino scanned
    const rootReceiptsFolderId = folders.receipts ?? folders.scanned;
    if (!rootReceiptsFolderId) {
      return NextResponse.json({ ok: false, error: "Sin carpeta de destino configurada en Drive" }, { status: 400 });
    }

    // ── Construir estructura de carpetas: raíz / Consorcio / Período ──────
    const driveService = new GoogleDriveService(googleConfig);

    const consortiumName = invoice.consortiumRef?.rawName ?? invoice.consortium ?? "Sin Consorcio";
    const periodLabel = invoice.periodRef
      ? `${MONTH_NAMES[invoice.periodRef.month - 1]} ${invoice.periodRef.year}`
      : "Sin Período";

    // Crear/obtener subcarpeta del consorcio
    const consortiumFolderId = await driveService.getOrCreateFolder(
      consortiumName,
      rootReceiptsFolderId
    );

    // Crear/obtener subcarpeta del período dentro del consorcio
    const periodFolderId = await driveService.getOrCreateFolder(
      periodLabel,
      consortiumFolderId
    );

    // ── Subir el PDF a Drive ──────────────────────────────────────────────
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = file.name || `recibo_${invoiceId}.pdf`;

    const uploaded = await driveService.uploadFile(
      buffer,
      fileName,
      "application/pdf",
      periodFolderId
    );

    if (!uploaded.id) {
      return NextResponse.json({ ok: false, error: "Error al subir el archivo a Drive" }, { status: 500 });
    }

    // ── Actualizar la Invoice con el fileId y URL ─────────────────────────
    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        receiptDriveFileId:  uploaded.id,
        receiptDriveFileUrl: uploaded.webViewLink ?? `https://drive.google.com/file/d/${uploaded.id}/view`,
      },
      select: {
        id: true,
        receiptDriveFileId: true,
        receiptDriveFileUrl: true,
      },
    });

    return NextResponse.json({ ok: true, invoice: updated });
  } catch (err) {
    console.error("[receipt-upload]", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error interno" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/client/consortiums/[id]/invoices/[invoiceId]/receipt
 * Elimina la referencia al recibo (no borra el archivo de Drive).
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; invoiceId: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { id: consortiumId, invoiceId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const prisma = getPrismaClient();

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, clientId, consortiumId },
      select: { id: true },
    });

    if (!invoice) {
      return NextResponse.json({ ok: false, error: "Boleta no encontrada" }, { status: 404 });
    }

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { receiptDriveFileId: null, receiptDriveFileUrl: null },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error interno" },
      { status: 500 }
    );
  }
}
