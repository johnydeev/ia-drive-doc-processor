import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { apiError } from "./apiHandler";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function readBody(res: Response): Promise<{ ok: boolean; error: string }> {
  return (await res.json()) as { ok: boolean; error: string };
}

describe("apiError", () => {
  it("ZodError → 400 con los mensajes de validación", async () => {
    const schema = z.object({ name: z.string().min(1, "name requerido") });
    const result = schema.safeParse({ name: "" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const res = apiError(result.error);
    expect(res.status).toBe(400);
    expect((await readBody(res)).error).toContain("name requerido");
  });

  it("error de negocio con status explícito < 500 → mensaje visible", async () => {
    const res = apiError(new Error("Sin credenciales de Google configuradas"), 400);
    expect(res.status).toBe(400);
    expect((await readBody(res)).error).toBe("Sin credenciales de Google configuradas");
  });

  it("500 en producción → mensaje genérico (no filtra detalles internos)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = apiError(new Error("connect ECONNREFUSED prisma://interno"));
    expect(res.status).toBe(500);
    expect((await readBody(res)).error).toBe("Error interno");
  });

  it("500 fuera de producción → mensaje real (debugging local)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = apiError(new Error("detalle interno"));
    expect(res.status).toBe(500);
    expect((await readBody(res)).error).toBe("detalle interno");
  });
});
