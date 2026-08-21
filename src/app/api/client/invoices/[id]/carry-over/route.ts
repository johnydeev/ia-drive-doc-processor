import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { cancelCarryOver, requestCarryOver } from "@/services/carryOver.service";

/**
 * Marca una boleta para pasar al mes siguiente.
 *
 * NO la mueve: el traslado (Drive + Sheets + DB) ocurre al CERRAR el período. Se
 * marca ahora porque el período destino puede no existir todavía —se crea al
 * cerrar— y porque es al cerrar cuando el owner terminó de revisar el mes.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;

  const result = await requestCarryOver(auth.session.clientId, id);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, requested: result.requested });
}

/** Desmarca una boleta que todavía no se trasladó (el período sigue abierto). */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;

  const result = await cancelCarryOver(auth.session.clientId, id);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, requested: result.requested });
}
