import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { undoCarryOver } from "@/services/carryOver.service";

/**
 * Devuelve al período de origen una boleta que YA se trasladó.
 *
 * Funciona aunque el origen esté cerrado: el traslado ocurre justo al cerrar el
 * mes, así que exigir un origen abierto lo bloquearía casi siempre.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;

  const result = await undoCarryOver(auth.session.clientId, id);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, toLabel: result.toLabel });
}
