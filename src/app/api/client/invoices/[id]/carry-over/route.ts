import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { carryOverInvoice } from "@/services/carryOver.service";

/**
 * Pasa una boleta impaga al período siguiente (Drive + Sheets + DB) y deja la
 * obligación de origen marcada como CARRIED_OVER.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;

  const result = await carryOverInvoice(auth.session.clientId, id);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, toLabel: result.toLabel, invoiceId: result.invoiceId });
}
