import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { resolveGoogleConfig, resolveFolders } from "@/lib/clientProcessingConfig";
import { PaymentRepository, PaymentError } from "@/repositories/payment.repository";
import { isPdf } from "@/lib/fileSignature";

/**
 * POST /api/client/consortiums/[id]/invoices/[invoiceId]/receipt
 *
 * Sube un PDF de recibo de pago a Drive y crea un Payment vinculado a la Invoice.
 * Mantiene compatibilidad con la UI existente que sube recibos desde la tabla de boletas.
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
        consortiumRef: { select: { rawName: true, statementsFolderId: true } },
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

    const MAX_RECEIPT_SIZE = 20 * 1024 * 1024; // 20MB
    if (file.size > MAX_RECEIPT_SIZE) {
      return NextResponse.json(
        { ok: false, error: "El comprobante no puede superar 20MB" },
        { status: 400 }
      );
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

    // El recibo se guarda JUNTO a su boleta, en Rendiciones/[Edificio]/[Período].
    if (!folders.statements) {
      return NextResponse.json({ ok: false, error: "Sin carpeta Rendiciones (statements) configurada en Drive" }, { status: 400 });
    }
    if (!invoice.periodRef) {
      return NextResponse.json({ ok: false, error: "La boleta no tiene período asociado" }, { status: 400 });
    }

    const driveService = new GoogleDriveService(googleConfig);

    // ── Validar el PDF antes de crear carpetas o subir ────────────────────
    const buffer = Buffer.from(await file.arrayBuffer());
    if (!isPdf(buffer)) {
      return NextResponse.json(
        { ok: false, error: "El archivo no es un PDF válido (firma binaria incorrecta)" },
        { status: 400 }
      );
    }

    // ── Resolver Rendiciones/[Edificio]/[Período] (misma carpeta que la boleta) ──
    const { resolveStatementsFolders } = await import("@/services/statementsFolders.service");
    const { buildReceiptFileName } = await import("@/lib/statementsNaming");
    const consortiumName = invoice.consortiumRef?.rawName ?? invoice.consortium ?? "Sin Consorcio";
    const sf = await resolveStatementsFolders({
      drive: driveService,
      statementsRootId: folders.statements,
      consortium: {
        id: invoice.consortiumId!,
        rawName: consortiumName,
        statementsFolderId: invoice.consortiumRef?.statementsFolderId ?? null,
      },
      month: invoice.periodRef.month,
      year: invoice.periodRef.year,
    });

    // ── Subir el PDF (nombre provisional; se renombra tras crear el pago) ──
    const uploaded = await driveService.uploadFile(
      buffer,
      file.name || `recibo_${invoiceId}.pdf`,
      "application/pdf",
      sf.periodFolderId
    );

    if (!uploaded.id) {
      return NextResponse.json({ ok: false, error: "Error al subir el archivo a Drive" }, { status: 500 });
    }

    const driveFileUrl = uploaded.webViewLink ?? `https://drive.google.com/file/d/${uploaded.id}/view`;

    // ── Crear Payment con el monto total de la invoice ───────────────────
    const paymentDate = new Date();
    const paymentRepo = new PaymentRepository();
    const result = await paymentRepo.createPayment({
      clientId,
      invoiceId,
      amount: invoice.amount ? Number(invoice.amount) : 0,
      paymentDate,
      driveFileId: uploaded.id,
      driveFileUrl,
    });

    // ── Renombrar el recibo según el tipo de pago (único / cuota / parcial) ──
    // El nombre depende del resultado del pago (salda total, nº de cuota), por
    // eso se renombra después de createPayment. Si falla, el recibo queda con el
    // nombre provisional (no es bloqueante).
    try {
      const receiptName = buildReceiptFileName({
        provider: invoice.provider,
        consortium: consortiumName,
        month: invoice.periodRef.month,
        year: invoice.periodRef.year,
        boletaNumber: invoice.boletaNumber,
        documentHash: invoice.documentHash,
        paymentDate,
        amount: Number(result.payment.amount),
        installmentNumber: result.payment.installmentNumber,
        totalInstallments: result.payment.totalInstallments,
        saldaTotal: result.invoice.isPaid,
      });
      await driveService.renameFile(uploaded.id, receiptName);
    } catch (renameErr) {
      console.warn(`[receipt-upload] no se pudo renombrar el recibo: ${renameErr instanceof Error ? renameErr.message : "error"}`);
    }

    return NextResponse.json({
      ok: true,
      invoice: {
        id: result.invoice.id,
        isPaid: result.invoice.isPaid,
        remainingBalance: result.invoice.remainingBalance,
      },
      payment: result.payment,
    });
  } catch (err) {
    if (err instanceof PaymentError) {
      return NextResponse.json(
        { ok: false, error: err.message },
        { status: err.statusCode }
      );
    }
    console.error("[receipt-upload]", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error interno" },
      { status: 500 }
    );
  }
}
