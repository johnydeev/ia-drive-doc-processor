import { NextResponse } from "next/server";
import { requireAuthenticatedSession, type AuthenticatedSession } from "@/lib/adminAuth";

/**
 * Verifica que el request tenga una sesión autenticada con rol CLIENT o ADMIN.
 * Los VIEWER no tienen acceso a endpoints de cliente que mutan datos.
 */
export function requireClientSession(
  request: Request
): { session: AuthenticatedSession; error: null } | { session: null; error: NextResponse } {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) {
    return auth;
  }

  if (auth.session.role === "VIEWER") {
    return {
      session: null,
      error: NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 }
      ),
    };
  }

  return auth;
}
