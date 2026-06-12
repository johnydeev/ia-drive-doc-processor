import { describe, it, expect } from "vitest";
import { nextQuotaResetUtc } from "@/lib/quotaReset";

// La cuota diaria del free tier de Gemini resetea a la MEDIANOCHE del Pacífico
// (America/Los_Angeles). En verano (PDT, UTC-7) eso es 07:00 UTC; en invierno
// (PST, UTC-8) es 08:00 UTC. La función suma un buffer de 5 min.

describe("nextQuotaResetUtc", () => {
  it("en horario de verano (PDT): próxima medianoche LA = 07:05 UTC", () => {
    const now = new Date("2026-06-12T17:00:00Z"); // 10:00 LA del 12/06
    expect(nextQuotaResetUtc(now).toISOString()).toBe("2026-06-13T07:05:00.000Z");
  });

  it("en horario de invierno (PST): próxima medianoche LA = 08:05 UTC", () => {
    const now = new Date("2026-01-15T12:00:00Z"); // 04:00 LA del 15/01
    expect(nextQuotaResetUtc(now).toISOString()).toBe("2026-01-16T08:05:00.000Z");
  });

  it("recién pasada la medianoche LA, apunta a la del día siguiente", () => {
    const now = new Date("2026-06-13T07:30:00Z"); // 00:30 LA del 13/06
    expect(nextQuotaResetUtc(now).toISOString()).toBe("2026-06-14T07:05:00.000Z");
  });

  it("siempre devuelve un instante futuro", () => {
    const samples = [
      new Date("2026-06-12T06:59:00Z"),
      new Date("2026-06-12T07:00:00Z"),
      new Date("2026-12-01T23:59:59Z"),
    ];
    for (const now of samples) {
      expect(nextQuotaResetUtc(now).getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
