import { describe, it, expect, vi } from "vitest";
import { isRateLimitError, RateLimitError, callWithRetry } from "@/lib/aiErrors";

describe("isRateLimitError", () => {
  it("detecta el HTTP 429 de Gemini", () => {
    const err = new Error(
      "[GoogleGenerativeAI Error]: Error fetching ... [429 Too Many Requests] You exceeded your current quota"
    );
    expect(isRateLimitError(err)).toBe(true);
  });

  it("detecta el 429 de OpenAI", () => {
    const err = new Error("429 You exceeded your current quota, please check your plan and billing details.");
    expect(isRateLimitError(err)).toBe(true);
  });

  it("detecta RESOURCE_EXHAUSTED", () => {
    expect(isRateLimitError(new Error("RESOURCE_EXHAUSTED: quota"))).toBe(true);
  });

  it("detecta 'Too Many Requests' sin el número", () => {
    expect(isRateLimitError(new Error("Too Many Requests"))).toBe(true);
  });

  it("detecta menciones de quota", () => {
    expect(isRateLimitError(new Error("You exceeded your current quota"))).toBe(true);
  });

  it("acepta strings además de Error", () => {
    expect(isRateLimitError("HTTP 429: too many requests")).toBe(true);
  });

  it("reconoce el mensaje del barrido de modelos (en español, visto en prod)", () => {
    // Regresión real: la cadena de IA pasa el MENSAJE del error (string) al
    // pipeline; el RateLimitError del barrido dice "sin cuota" (español) y no
    // matcheaba "quota" → la boleta caía a OCR_ONLY → "SIN MONTO" → Revisión,
    // en vez de volver a Pendientes.
    expect(isRateLimitError("Gemini extraction: sin cuota en los 5 modelo(s) del barrido")).toBe(true);
  });

  it("es falso para errores normales", () => {
    expect(isRateLimitError(new Error("Network timeout"))).toBe(false);
    expect(isRateLimitError(new Error("Invalid JSON in model output"))).toBe(false);
  });

  it("NO confunde un 4290 o un 1429 con un 429 real", () => {
    expect(isRateLimitError(new Error("processed 1429 documents"))).toBe(false);
  });

  it("es falso para null/undefined", () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

describe("RateLimitError", () => {
  it("es una instancia de Error con nombre propio", () => {
    const err = new RateLimitError("gemini sin cuota");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RateLimitError");
    expect(err.message).toBe("gemini sin cuota");
  });

  it("isRateLimitError lo reconoce", () => {
    expect(isRateLimitError(new RateLimitError("x"))).toBe(true);
  });
});

describe("callWithRetry", () => {
  const noSleep = () => Promise.resolve();

  it("devuelve el resultado sin reintentar cuando fn tiene éxito", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await callWithRetry(fn, { retries: 2, sleep: noSleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propaga un error NORMAL sin reintentar", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Network timeout"));
    await expect(callWithRetry(fn, { retries: 3, sleep: noSleep })).rejects.toThrow("Network timeout");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reintenta ante rate-limit y al agotar lanza RateLimitError", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("HTTP 429 Too Many Requests"));
    const sleep = vi.fn(noSleep);
    await expect(callWithRetry(fn, { retries: 2, backoffMs: 50, sleep })).rejects.toBeInstanceOf(RateLimitError);
    expect(fn).toHaveBeenCalledTimes(3); // intento inicial + 2 reintentos
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it("tiene éxito en el reintento si el primer intento fue 429 y el segundo OK", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("429 quota exceeded"))
      .mockResolvedValueOnce("recuperado");
    const sleep = vi.fn(noSleep);
    const result = await callWithRetry(fn, { retries: 1, backoffMs: 10, sleep });
    expect(result).toBe("recuperado");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("con retries=0 no reintenta pero convierte el 429 en RateLimitError", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("429"));
    await expect(callWithRetry(fn, { retries: 0, sleep: noSleep })).rejects.toBeInstanceOf(RateLimitError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
