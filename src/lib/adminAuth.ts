import { NextResponse } from "next/server";
import { ClientRole } from "@prisma/client";
import { env } from "@/config/env";
import { readAuthTokenFromRequest, verifySessionToken } from "@/lib/authSession";
import { resolveSessionValidity } from "@/lib/sessionRevocation";

export interface AuthenticatedSession {
  clientId: string;
  email: string;
  role: ClientRole;
}

export async function requireAuthenticatedSession(
  request: Request
): Promise<{ session: AuthenticatedSession; error: null } | { session: null; error: NextResponse }> {
  const secret = env.SESSION_SECRET?.trim();
  if (!secret) {
    return {
      session: null,
      error: NextResponse.json(
        {
          ok: false,
          error: "SESSION_SECRET is not configured",
        },
        { status: 500 }
      ),
    };
  }

  const token = readAuthTokenFromRequest(request);
  if (!token) {
    return {
      session: null,
      error: NextResponse.json(
        {
          ok: false,
          error: "Unauthorized",
        },
        { status: 401 }
      ),
    };
  }

  const payload = verifySessionToken(token, secret);
  if (!payload) {
    return {
      session: null,
      error: NextResponse.json(
        {
          ok: false,
          error: "Unauthorized",
        },
        { status: 401 }
      ),
    };
  }

  // Re-chequeo contra la DB (cache 60s): cliente desactivado o borrado → 401
  // aunque el JWT siga vigente. El rol se toma de la DB (un downgrade aplica
  // en ≤60s, sin esperar a que expire el token).
  const account = await resolveSessionValidity(payload.clientId);
  if (!account) {
    return {
      session: null,
      error: NextResponse.json(
        {
          ok: false,
          error: "Unauthorized",
        },
        { status: 401 }
      ),
    };
  }

  return {
    session: {
      clientId: payload.clientId,
      email: payload.email,
      role: account.role,
    },
    error: null,
  };
}

export async function requireAdminSession(
  request: Request
): Promise<{ session: AuthenticatedSession; error: null } | { session: null; error: NextResponse }> {
  const auth = await requireAuthenticatedSession(request);
  if (auth.error) {
    return auth;
  }

  if (auth.session.role !== "ADMIN") {
    return {
      session: null,
      error: NextResponse.json(
        {
          ok: false,
          error: "Forbidden",
        },
        { status: 403 }
      ),
    };
  }

  return auth;
}
