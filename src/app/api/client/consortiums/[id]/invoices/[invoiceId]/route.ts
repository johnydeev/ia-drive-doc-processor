import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { deleteInvoiceById } from "@/lib/invoiceDeletion";

/**
 * DELETE /api/client/consortiums/[id]/invoices/[invoiceId]
 *
 * Elimina una boleta desde la vista por consorcio. El PDF se mueve a la carpeta
 * de Revisión (`failed`) — NO a Pendientes, para que el scheduler no la
 * reprocese y recree. Borra la fila del Sheet y el Invoice de la DB (rechaza si
 * tiene pagos). La lógica vive en `lib/invoiceDeletion` y se comparte con el
 * borrado masivo de la vista global de boletas.
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; invoiceId: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { invoiceId } = await context.params;

  try {
    const result = await deleteInvoiceById(auth.session.clientId, invoiceId, "failed");
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, ...(result.warning ? { warning: result.warning } : {}) });
  } catch (err) {
    console.error("[invoice-delete]", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error interno" },
      { status: 500 }
    );
  }
}
