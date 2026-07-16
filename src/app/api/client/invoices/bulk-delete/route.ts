import { z } from "zod";
import { apiOk, apiError, withClientAuth } from "@/lib/apiHandler";
import { resolveDeletionContext, deleteInvoicesWithIndex } from "@/lib/invoiceDeletion";

// Tope de 10 por tanda: mismo criterio que bulk-move-period — cada boleta hace
// varias llamadas a Drive (~8.5s medidos en prod) y el túnel Cloudflare corta a
// ~100s (524). La UI también lo valida y avisa; esto es el guardrail del server.
const bodySchema = z.object({
  invoiceIds: z.array(z.string().min(1)).min(1).max(10),
});

/**
 * POST /api/client/invoices/bulk-delete  { invoiceIds: string[] }
 *
 * Borra varias boletas de una (vista global de boletas entrantes). El PDF de
 * cada una vuelve a **Pendientes** → el worker las reprocesa (ideal para
 * corregir boletas mal procesadas). El contexto de Google se resuelve una sola
 * vez y la hoja de Sheets se lee UNA vez por lote (índice compartido). Devuelve
 * cuántas se borraron y el detalle de las que fallaron (no aborta todo si una
 * falla).
 */
export const POST = withClientAuth(async ({ request, session }) => {
  const { invoiceIds } = bodySchema.parse(await request.json());

  const resolved = await resolveDeletionContext(session.clientId);
  if ("error" in resolved) return apiError(new Error(resolved.error), resolved.status);

  const results = await deleteInvoicesWithIndex(resolved.ctx, session.clientId, invoiceIds, "pending");

  let deleted = 0;
  const failed: Array<{ invoiceId: string; error: string }> = [];
  results.forEach((result, i) => {
    if (result.ok) deleted += 1;
    else failed.push({ invoiceId: invoiceIds[i], error: result.error ?? "Error" });
  });

  return apiOk({ deleted, failed, total: invoiceIds.length });
});
