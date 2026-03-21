import { NextRequest, NextResponse } from "next/server";

const AUTH_COOKIE_NAME = "dpp_session";

/**
 * Verifica JWT usando Web Crypto API (compatible con Edge Runtime).
 * No puede importar desde /lib — toda la lógica está inline.
 */
async function isValidToken(token: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [header, payload, signature] = parts;

  try {
    // Importar la clave HMAC-SHA256
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    // Convertir signature de base64url a Uint8Array
    const sigBytes = Uint8Array.from(
      atob(signature.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );

    // Verificar firma
    const data = encoder.encode(`${header}.${payload}`);
    const valid = await crypto.subtle.verify("HMAC", cryptoKey, sigBytes, data);
    if (!valid) return false;

    // Verificar expiración
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (!decoded?.clientId || !decoded?.exp) return false;
    return decoded.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const secret = process.env.SESSION_SECRET?.trim() ?? "";
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value ?? "";
  const isAuthenticated = Boolean(token) && await isValidToken(token, secret);

  if (isAdminPath(pathname) && !isAuthenticated) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    loginUrl.searchParams.set("reason", "session_expired");
    return NextResponse.redirect(loginUrl);
  }

  if (pathname === "/login" && isAuthenticated) {
    return NextResponse.redirect(new URL("/admin", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin", "/admin/:path*", "/login"],
};
