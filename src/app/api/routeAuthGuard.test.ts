import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Red de regresión de seguridad: toda ruta API debe usar un guard de auth.
 * El guard es opt-in por ruta (el middleware solo cubre páginas /admin), así
 * que una ruta nueva sin wrapper queda pública en silencio — este test lo
 * atrapa en CI antes del deploy.
 */

// Rutas públicas INTENCIONALES. Agregar acá exige revisión consciente.
const PUBLIC_ROUTES = new Set([
  "auth/login/route.ts", // emite la sesión
  "auth/logout/route.ts", // solo limpia la cookie
  "auth/register/route.ts", // deshabilitado: devuelve 403 fijo
  "health/route.ts", // healthcheck de Docker
  "openapi/route.ts", // spec estático
]);

const GUARD_TOKENS = [
  "withAuth",
  "withClientAuth",
  "requireClientSession",
  "requireAdminSession",
  "requireAuthenticatedSession",
];

const API_DIR = __dirname; // src/app/api

function findRouteFiles(): string[] {
  return (readdirSync(API_DIR, { recursive: true }) as string[])
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f === "route.ts" || f.endsWith("/route.ts"));
}

describe("guard de auth en rutas API", () => {
  const routeFiles = findRouteFiles();

  it("encuentra rutas (sanity check del listado)", () => {
    expect(routeFiles.length).toBeGreaterThan(30);
  });

  for (const file of routeFiles) {
    if (PUBLIC_ROUTES.has(file)) continue;

    it(`${file} usa un guard de auth`, () => {
      const content = readFileSync(join(API_DIR, file), "utf8");
      const hasGuard = GUARD_TOKENS.some((token) => content.includes(token));
      expect(
        hasGuard,
        `${file} exporta handlers sin guard de auth. Usá withAuth/withClientAuth ` +
          `o require*Session; si la ruta es pública a propósito, agregala a PUBLIC_ROUTES ` +
          `en routeAuthGuard.test.ts con un comentario del motivo.`
      ).toBe(true);
    });
  }
});
