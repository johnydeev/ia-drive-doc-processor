import { z } from "zod";
import { apiOk, withClientAuth } from "@/lib/apiHandler";
import { getPrismaClient } from "@/lib/prisma";
import { previewMove } from "@/lib/invoicePeriodMove";

const bodySchema = z.object({
  invoiceIds: z.array(z.string().min(1)).min(1).max(40),
});

/**
 * POST /api/client/invoices/bulk-move-period/preview  { invoiceIds: string[] }
 *
 * Sin efectos. Para cada boleta indica si es movible al período siguiente y con
 * qué etiquetas (06/2026 → 07/2026), o el motivo de skip. Alimenta el paso 1 del
 * modal de confirmación.
 */
export const POST = withClientAuth(async ({ request, session }) => {
  const { invoiceIds } = bodySchema.parse(await request.json());
  const items = await previewMove(getPrismaClient(), session.clientId, invoiceIds);
  return apiOk({ items });
});
