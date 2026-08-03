import { describe, expect, it } from "vitest";
import { BANK_COLORS, BANK_COLOR_SLUGS, DEFAULT_BANK_COLOR, isBankColor } from "./bankPalette";

describe("bankPalette", () => {
  it("expone los slugs derivados de la paleta, sin duplicados", () => {
    expect(BANK_COLOR_SLUGS).toEqual(BANK_COLORS.map((c) => c.slug));
    expect(new Set(BANK_COLOR_SLUGS).size).toBe(BANK_COLOR_SLUGS.length);
  });

  it("el color por defecto pertenece a la paleta", () => {
    expect(BANK_COLOR_SLUGS).toContain(DEFAULT_BANK_COLOR);
  });

  it("cada color tiene label no vacío", () => {
    for (const color of BANK_COLORS) {
      expect(color.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("isBankColor acepta slugs de la paleta y rechaza el resto", () => {
    expect(isBankColor("red")).toBe(true);
    expect(isBankColor("slate")).toBe(true);
    expect(isBankColor("#ff0000")).toBe(false);
    expect(isBankColor("fucsia")).toBe(false);
  });
});
