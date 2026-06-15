import { describe, it, expect, vi } from "vitest";
import { isTransientDbError, withDbRetry } from "@/lib/dbRetry";

const noSleep = async () => {};

describe("isTransientDbError", () => {
  it("reconoce P1017 (el pooler cerró la conexión)", () => {
    expect(
      isTransientDbError(new Error("Server has closed the connection. (P1017)"))
    ).toBe(true);
  });

  it("reconoce 'server has closed the connection' sin código", () => {
    expect(isTransientDbError(new Error("server has closed the connection"))).toBe(true);
  });

  it("reconoce P1001 (no se puede alcanzar la DB)", () => {
    expect(isTransientDbError(new Error("Can't reach database server (P1001)"))).toBe(true);
  });

  it("reconoce ECONNRESET", () => {
    expect(isTransientDbError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("reconoce timeout del pool de conexiones", () => {
    expect(
      isTransientDbError(new Error("Timed out fetching a new connection from the connection pool"))
    ).toBe(true);
  });

  it("NO reconoce una violación de unique constraint (P2002)", () => {
    expect(
      isTransientDbError(new Error("Unique constraint failed on the fields (P2002)"))
    ).toBe(false);
  });

  it("NO reconoce un error de negocio cualquiera", () => {
    expect(isTransientDbError(new Error("Importe inválido"))).toBe(false);
  });

  it("NO reconoce null / undefined", () => {
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
  });
});

describe("withDbRetry", () => {
  it("devuelve el resultado al primer intento si no hay error (no reintenta)", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await withDbRetry(fn, { sleep: noSleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reintenta ante un error transitorio y cede cuando se recupera", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Server has closed the connection. (P1017)");
      return "ok";
    });
    const result = await withDbRetry(fn, { retries: 3, sleep: noSleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("propaga de inmediato un error NO transitorio (sin reintentar)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("Unique constraint failed (P2002)");
    });
    await expect(withDbRetry(fn, { retries: 3, sleep: noSleep })).rejects.toThrow(/P2002/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("agota los reintentos y relanza el error ORIGINAL", async () => {
    const fn = vi.fn(async () => {
      throw new Error("Server has closed the connection. (P1017)");
    });
    await expect(withDbRetry(fn, { retries: 2, sleep: noSleep })).rejects.toThrow(/P1017/);
    expect(fn).toHaveBeenCalledTimes(3); // intento inicial + 2 reintentos
  });

  it("invoca onRetry en cada reintento (no en el intento inicial)", async () => {
    let attempts = 0;
    const onRetry = vi.fn();
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("read ECONNRESET");
      return "ok";
    });
    await withDbRetry(fn, { retries: 3, onRetry, sleep: noSleep });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});
