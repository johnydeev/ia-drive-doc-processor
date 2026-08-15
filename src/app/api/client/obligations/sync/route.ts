import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { syncObligationsForClient } from "@/services/obligation.service";

/**
 * Sincroniza las obligaciones de todos los períodos activos del cliente.
 * La vista global lo llama al montar; es idempotente y set-based.
 */
export async function POST(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const result = await syncObligationsForClient(auth.session.clientId);
  return NextResponse.json({ ok: true, ...result });
}
