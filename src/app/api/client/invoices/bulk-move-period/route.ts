import { z } from "zod";
import { apiOk, apiError, withClientAuth } from "@/lib/apiHandler";
import { resolveMoveContext, moveInvoicesToNextPeriod } from "@/lib/invoicePeriodMove";

// Tope de 40 por tanda: cada boleta hace ~3-4 llamadas a Google (Drive+Sheets),
// así que un lote grande superaría el timeout de ~100s del túnel Cloudflare (524).
// La UI también lo valida y avisa; esto es el guardrail del server.
const bodySchema = z.object({
  invoiceIds: z.array(z.string().min(1)).min(1).max(40),
});

/**
 * POST /api/client/invoices/bulk-move-period  { invoiceIds: string[] }
 *
 * Mueve cada boleta al período siguiente de su consorcio (DB + Sheets + Drive +
 * obligaciones), con reversión por boleta ante fallo. El contexto de Google se
 * resuelve una vez. Una boleta fallida/salteada no aborta el lote.
 */
export const POST = withClientAuth(async ({ request, session }) => {
  const { invoiceIds } = bodySchema.parse(await request.json());

  const resolved = await resolveMoveContext(session.clientId);
  if ("error" in resolved) return apiError(new Error(resolved.error), resolved.status);

  const summary = await moveInvoicesToNextPeriod(resolved.ctx, session.clientId, invoiceIds);
  return apiOk({ ...summary });
});
