import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthenticatedSession, type AuthenticatedSession } from "@/lib/adminAuth";
import { requireClientSession } from "@/lib/clientAuth";

/**
 * Helpers para rutas API: estandarizan el shape de respuesta (`{ ok, ... }`),
 * el manejo de errores (ZodError → 400, resto → 500) y el guard de sesión.
 *
 * Antes este plumbing estaba copiado en decenas de rutas: el guard
 * `if (auth.error) return auth.error`, el bloque ternario de ZodError y las
 * respuestas `NextResponse.json({ ok: false, ... })` ad-hoc. Centralizarlo
 * evita divergencias (status codes a ojo, catch olvidados que filtran stack
 * traces) y reduce cada endpoint a su lógica de negocio.
 *
 * Nota: los wrappers pasan solo `request`. Para rutas dinámicas (`[id]`) que
 * necesitan `params`, seguir usando los guards directamente por ahora — el
 * soporte de `params` en el HOF se puede agregar en una iteración posterior.
 */

/** Respuesta de éxito: `{ ok: true, ...data }`. */
export function apiOk(data: Record<string, unknown> = {}, status = 200): NextResponse {
  return NextResponse.json({ ok: true, ...data }, { status });
}

/**
 * Respuesta de error normalizada.
 * - `ZodError` → 400 con los mensajes de validación concatenados.
 * - Resto → `fallbackStatus` (500 por defecto) con el message del Error.
 */
export function apiError(error: unknown, fallbackStatus = 500): NextResponse {
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { ok: false, error: error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  return NextResponse.json({ ok: false, error: message }, { status: fallbackStatus });
}

type ApiHandler = (ctx: {
  request: Request;
  session: AuthenticatedSession;
}) => Promise<NextResponse> | NextResponse;

/**
 * Envuelve un handler exigiendo una sesión autenticada (cualquier rol, incluido
 * VIEWER). Aplica el guard y un `try/catch` que normaliza errores con `apiError`.
 */
export function withAuth(handler: ApiHandler) {
  return async (request: Request): Promise<NextResponse> => {
    const auth = requireAuthenticatedSession(request);
    if (auth.error) return auth.error;
    try {
      return await handler({ request, session: auth.session });
    } catch (error) {
      return apiError(error);
    }
  };
}

/**
 * Igual que `withAuth` pero exige rol CLIENT o ADMIN (rechaza VIEWER con 403).
 * Para endpoints que mutan datos del cliente.
 */
export function withClientAuth(handler: ApiHandler) {
  return async (request: Request): Promise<NextResponse> => {
    const auth = requireClientSession(request);
    if (auth.error) return auth.error;
    try {
      return await handler({ request, session: auth.session });
    } catch (error) {
      return apiError(error);
    }
  };
}
