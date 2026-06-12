import { describe, it, expect } from "vitest";
import {
  cuitDigits,
  isValidCuit,
  formatCuit,
  cuitsEqual,
  extractCuitsFromText,
} from "@/lib/cuit";

// CUITs reales (checksum mod-11 válido): 20-94037036-2 y 30-70958299-9.

describe("cuitDigits", () => {
  it("deja solo dígitos", () => {
    expect(cuitDigits("20-94037036-2")).toBe("20940370362");
    expect(cuitDigits("20 94037036 2")).toBe("20940370362");
    expect(cuitDigits("20.94037036.2")).toBe("20940370362");
    expect(cuitDigits("20940370362")).toBe("20940370362");
  });

  it("devuelve cadena vacía para null/undefined", () => {
    expect(cuitDigits(null)).toBe("");
    expect(cuitDigits(undefined)).toBe("");
  });
});

describe("isValidCuit", () => {
  it("acepta CUITs reales en cualquier formato", () => {
    expect(isValidCuit("20-94037036-2")).toBe(true);
    expect(isValidCuit("30709582999")).toBe(true);
  });

  it("rechaza checksum inválido", () => {
    expect(isValidCuit("20-94037036-3")).toBe(false);
  });

  it("rechaza longitudes incorrectas", () => {
    expect(isValidCuit("307095829999")).toBe(false); // 12 dígitos
    expect(isValidCuit("3070958299")).toBe(false); // 10 dígitos
    expect(isValidCuit("")).toBe(false);
    expect(isValidCuit(null)).toBe(false);
  });
});

describe("formatCuit", () => {
  it("normaliza al formato canónico XX-XXXXXXXX-X desde cualquier formato", () => {
    expect(formatCuit("20940370362")).toBe("20-94037036-2");
    expect(formatCuit("20 94037036 2")).toBe("20-94037036-2");
    expect(formatCuit("20-94037036-2")).toBe("20-94037036-2");
    expect(formatCuit("20.94037036.2")).toBe("20-94037036-2");
  });

  it("devuelve null si no hay 11 dígitos", () => {
    expect(formatCuit("307095829999")).toBeNull(); // 12
    expect(formatCuit("12345")).toBeNull();
    expect(formatCuit("")).toBeNull();
    expect(formatCuit(null)).toBeNull();
    expect(formatCuit("sin numeros")).toBeNull();
  });
});

describe("cuitsEqual", () => {
  it("compara ignorando el formato", () => {
    expect(cuitsEqual("20-94037036-2", "20940370362")).toBe(true);
    expect(cuitsEqual("20 94037036 2", "20.94037036.2")).toBe(true);
  });

  it("false para CUITs distintos o vacíos", () => {
    expect(cuitsEqual("20-94037036-2", "30709582999")).toBe(false);
    expect(cuitsEqual("", "")).toBe(false);
    expect(cuitsEqual(null, "20940370362")).toBe(false);
  });
});

describe("extractCuitsFromText", () => {
  it("extrae CUITs con y sin guiones, deduplicados y normalizados a dígitos", () => {
    const text = [
      "LUZARDO JAVIEL JOSE EMILIO",
      "20940370362",
      "CUIT: 30-70958299-9",
      "20-94037036-2", // mismo que el primero, otro formato
    ].join("\n");
    expect(extractCuitsFromText(text).sort()).toEqual(["20940370362", "30709582999"]);
  });

  it("NO extrae secuencias de 12 dígitos ni checksum inválido ni CAE", () => {
    expect(extractCuitsFromText("307095829999")).toEqual([]);
    expect(extractCuitsFromText("20-94037036-3")).toEqual([]);
    expect(extractCuitsFromText("CAE N°: 86227311721564")).toEqual([]);
  });

  it("NO extrae 11 dígitos con prefijo no-CUIT", () => {
    expect(extractCuitsFromText("Tel: 11409403702")).toEqual([]);
  });

  it("[] para vacío/null", () => {
    expect(extractCuitsFromText("")).toEqual([]);
    expect(extractCuitsFromText(null)).toEqual([]);
  });
});
