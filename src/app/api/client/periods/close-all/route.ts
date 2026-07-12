import { NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { executeCloseAll } from "@/services/closePeriods.service";

/**
 * POST /api/client/periods/close-all
 *
 * Cierra el "Periodo General" del cliente: cierra los períodos ACTIVE del mes
 * mayoritario y crea los del mes siguiente. La lógica es set-based e idempotente
 * (ver `executeCloseAll`): corre en ~4 queries (<1s), muy por debajo del timeout
 * del proxy, y un reintento es un no-op seguro (no vuelve a avanzar el período).
 */
export async function POST(request: Request) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  try {
    const result = await executeCloseAll(auth.session.clientId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error al cerrar períodos" },
      { status: 500 }
    );
  }
}
