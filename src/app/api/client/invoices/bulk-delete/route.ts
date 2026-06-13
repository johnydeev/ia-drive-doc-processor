import { z } from "zod";
import { apiOk, apiError, withClientAuth } from "@/lib/apiHandler";
import { resolveDeletionContext, deleteOneInvoice } from "@/lib/invoiceDeletion";

const bodySchema = z.object({
  invoiceIds: z.array(z.string().min(1)).min(1).max(200),
});

/**
 * POST /api/client/invoices/bulk-delete  { invoiceIds: string[] }
 *
 * Borra varias boletas de una (vista global de boletas entrantes). El PDF de
 * cada una vuelve a **Pendientes** → el worker las reprocesa (ideal para
 * corregir boletas mal procesadas). El contexto de Google se resuelve una sola
 * vez y se reutiliza para todas. Devuelve cuántas se borraron y el detalle de
 * las que fallaron (no aborta todo si una falla).
 */
export const POST = withClientAuth(async ({ request, session }) => {
  const { invoiceIds } = bodySchema.parse(await request.json());

  const resolved = await resolveDeletionContext(session.clientId);
  if ("error" in resolved) return apiError(new Error(resolved.error), resolved.status);

  let deleted = 0;
  const failed: Array<{ invoiceId: string; error: string }> = [];

  for (const invoiceId of invoiceIds) {
    const result = await deleteOneInvoice(resolved.ctx, session.clientId, invoiceId, "pending");
    if (result.ok) deleted += 1;
    else failed.push({ invoiceId, error: result.error ?? "Error" });
  }

  return apiOk({ deleted, failed, total: invoiceIds.length });
});
