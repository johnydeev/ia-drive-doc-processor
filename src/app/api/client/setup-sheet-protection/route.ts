import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { GoogleSheetsService } from "@/services/googleSheets.service";
import {
  DEFAULT_SHEETS_MAPPING,
  loadProcessingClient,
  resolveGoogleConfig,
  resolveMapping,
  resolveSheetName,
} from "@/lib/clientProcessingConfig";
import { syncInvoicePaymentsFromSheets, SyncPaymentsError } from "@/lib/syncInvoicePayments";

const DEFAULT_MAPPING = DEFAULT_SHEETS_MAPPING;

function columnToIndex(column: string): number {
  const letters = column.trim().toUpperCase();
  let index = 0;
  for (let i = 0; i < letters.length; i += 1) {
    const code = letters.charCodeAt(i);
    if (code < 65 || code > 90) throw new Error(`Invalid column letter: ${column}`);
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

async function loadClientGoogleContext(clientId: string) {
  const processingClient = await loadProcessingClient(clientId);
  if (!processingClient) {
    return { error: NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 }) };
  }

  const googleConfig = resolveGoogleConfig(processingClient);
  if (!googleConfig) {
    return { error: NextResponse.json({ ok: false, error: "Credenciales de Google incompletas" }, { status: 400 }) };
  }

  return {
    sheetName: resolveSheetName(processingClient),
    mapping: resolveMapping(processingClient) ?? DEFAULT_MAPPING,
    googleConfig,
  };
}

/**
 * POST /api/client/setup-sheet-protection
 *
 * Protege la hoja de boletas. Antes de aplicar el `addProtectedRange`, ejecuta
 * `syncInvoicePaymentsFromSheets` para volcar a la DB cualquier edición manual
 * que el cliente haya hecho mientras la hoja estaba desbloqueada. Si el sync
 * falla, NO se aplica la protección (devuelve error con detalle).
 */
export async function POST(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;
  console.log(`[setup-sheet-protection] POST (proteger) — clientId=${clientId}`);

  try {
    const ctx = await loadClientGoogleContext(clientId);
    if ("error" in ctx) return ctx.error;
    const { sheetName, mapping, googleConfig } = ctx;

    // 1. Auto-sync de las columnas Q/R/S/T/U antes de bloquear
    let syncResult: Awaited<ReturnType<typeof syncInvoicePaymentsFromSheets>> | null = null;
    try {
      syncResult = await syncInvoicePaymentsFromSheets(clientId);
      console.log(
        `[setup-sheet-protection] auto-sync OK — creados=${syncResult.paymentsCreated} actualizados=${syncResult.paymentsUpdated} skipped=${syncResult.rowsSkipped}`
      );
    } catch (err) {
      if (err instanceof SyncPaymentsError) {
        return NextResponse.json(
          { ok: false, error: `Sync previo falló: ${err.message}. La hoja sigue desprotegida.` },
          { status: err.statusCode }
        );
      }
      const message = err instanceof Error ? err.message : "Error en sync previo";
      return NextResponse.json(
        { ok: false, error: `Sync previo falló: ${message}. La hoja sigue desprotegida.` },
        { status: 500 }
      );
    }

    // 2. Aplicar protección
    const maxColIndex = Object.values(mapping)
      .map(columnToIndex)
      .reduce((max, i) => Math.max(max, i), 0);
    const endColumnIndex = maxColIndex + 1;

    const sheetsService = new GoogleSheetsService(googleConfig);
    const protectedRangeId = await sheetsService.protectInvoiceColumns(
      sheetName,
      endColumnIndex,
      googleConfig.clientEmail
    );

    console.log(
      `[setup-sheet-protection] ✅ Protegida hoja "${sheetName}" A:${maxColIndex + 1} — protectedRangeId=${protectedRangeId}`
    );

    return NextResponse.json({
      ok: true,
      sheetName,
      protectedRangeId,
      columnsProtected: maxColIndex + 1,
      sync: {
        paymentsCreated: syncResult.paymentsCreated,
        paymentsUpdated: syncResult.paymentsUpdated,
        rowsSkipped: syncResult.rowsSkipped,
        invoicesAffected: syncResult.invoicesAffected,
        warnings: syncResult.warnings,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error al proteger la hoja";
    console.error(`[setup-sheet-protection] ❌ ${message}`);

    if (message.includes("403") || message.includes("PERMISSION_DENIED")) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Sin permisos sobre el archivo. La service account debe ser editora del Sheets para crear protecciones.",
        },
        { status: 403 }
      );
    }

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/client/setup-sheet-protection
 *
 * Quita la protección de la hoja de boletas para que el cliente pueda editar
 * manualmente en casos puntuales. Borra todos los protectedRange marcados con
 * descripción `dpp:invoices-lock`. Idempotente (responde ok aunque no hubiera
 * ninguno).
 *
 * El cliente debería volver a apretar "Proteger hoja" (POST) cuando termine
 * — esa acción correrá auto-sync para volcar las ediciones a la DB.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;
  console.log(`[setup-sheet-protection] DELETE (desproteger) — clientId=${clientId}`);

  try {
    const ctx = await loadClientGoogleContext(clientId);
    if ("error" in ctx) return ctx.error;
    const { sheetName, googleConfig } = ctx;

    const sheetsService = new GoogleSheetsService(googleConfig);
    const removed = await sheetsService.unprotectInvoiceColumns(sheetName);

    console.log(
      `[setup-sheet-protection] ✅ Desprotegida hoja "${sheetName}" — rangos eliminados=${removed}`
    );

    return NextResponse.json({
      ok: true,
      sheetName,
      removedRanges: removed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error al desproteger la hoja";
    console.error(`[setup-sheet-protection] ❌ ${message}`);

    if (message.includes("403") || message.includes("PERMISSION_DENIED")) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Sin permisos sobre el archivo. La service account debe ser editora del Sheets.",
        },
        { status: 403 }
      );
    }

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
