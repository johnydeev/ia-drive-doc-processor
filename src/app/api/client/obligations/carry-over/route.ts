import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { carryOverInvoice } from "@/services/carryOver.service";
import { validateCarryOverBatch } from "@/lib/carryOverBatch";

/**
 * Mueve UNA TANDA de boletas marcadas al mes siguiente (Drive + Sheets + DB).
 *
 * Deliberadamente NO vive dentro del cierre del período: cerrar es irreversible y
 * tiene que ser atómico y rápido, mover boletas es lento y reintentable. La UI
 * llama a este endpoint en bucle mostrando el avance; el límite de 100 s del túnel
 * es por request, así que el total deja de tener techo (spec 2026-08-20).
 *
 * Reentrante: `moveOneInvoiceToTarget` detecta `ya_en_destino`, así que reintentar
 * una tanda ya movida no duplica nada.
 */
export async function POST(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const body = (await request.json()) as { invoiceIds?: unknown };
  const batch = validateCarryOverBatch(body.invoiceIds);
  if (!batch.ok) {
    return NextResponse.json({ ok: false, error: batch.error }, { status: 400 });
  }

  const results: Array<{ invoiceId: string; ok: boolean; error?: string; toLabel?: string }> = [];

  // Secuencial a propósito: en paralelo se rozaría la cuota de escritura de
  // Sheets (60/min) y las boletas empezarían a rebotar por cuota.
  for (const invoiceId of batch.invoiceIds) {
    try {
      const result = await carryOverInvoice(auth.session.clientId, invoiceId);
      results.push(
        result.ok
          ? { invoiceId, ok: true, toLabel: result.toLabel }
          : { invoiceId, ok: false, error: result.error }
      );
    } catch (error) {
      results.push({
        invoiceId,
        ok: false,
        error: error instanceof Error ? error.message : "Error inesperado",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    moved: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
