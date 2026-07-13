import { z } from "zod";
import { apiOk, apiError, withClientAuth } from "@/lib/apiHandler";
import { resolveMoveContext, moveInvoicesToTargets } from "@/lib/invoicePeriodMove";

// Tope de 20 por tanda: cada boleta hace ~3-4 llamadas a Google; un lote más
// grande superaría el timeout de ~100s del túnel Cloudflare (524). La UI también
// lo valida y avisa; esto es el guardrail del server.
const bodySchema = z.object({
  moves: z.array(z.object({
    invoiceId: z.string().min(1),
    targetPeriodId: z.string().min(1),
  })).min(1).max(20),
});

/**
 * POST /api/client/invoices/bulk-move-period  { moves: [{ invoiceId, targetPeriodId }] }
 *
 * Mueve cada boleta a su período destino EXPLÍCITO (idempotente: si ya está ahí,
 * no-op). Reintentar la misma lista es seguro. Una boleta fallida/salteada no
 * aborta el lote.
 */
export const POST = withClientAuth(async ({ request, session }) => {
  const { moves } = bodySchema.parse(await request.json());

  const resolved = await resolveMoveContext(session.clientId);
  if ("error" in resolved) return apiError(new Error(resolved.error), resolved.status);

  const summary = await moveInvoicesToTargets(resolved.ctx, session.clientId, moves);
  return apiOk({ ...summary });
});
