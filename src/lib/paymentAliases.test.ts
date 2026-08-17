import { describe, expect, it } from "vitest";
import { MAX_PAYMENT_ALIASES, formatAliasesInline, parsePaymentAliases } from "./paymentAliases";

describe("parsePaymentAliases", () => {
  it("uno solo", () => {
    expect(parsePaymentAliases("tigre.pago")).toEqual(["tigre.pago"]);
  });

  it("varios separados por |, sin espacios sobrantes", () => {
    expect(parsePaymentAliases(" tigre.pago | tigre.mp ")).toEqual(["tigre.pago", "tigre.mp"]);
  });

  it("acepta un CBU como valor: no valida el formato", () => {
    expect(parsePaymentAliases("0070999530004012345678")).toEqual(["0070999530004012345678"]);
  });

  it("corta en el tope y no rompe", () => {
    expect(parsePaymentAliases("a|b|c|d|e")).toEqual(["a", "b", "c"]);
    expect(MAX_PAYMENT_ALIASES).toBe(3);
  });

  it("descarta vacíos y separadores consecutivos", () => {
    expect(parsePaymentAliases("a||b|")).toEqual(["a", "b"]);
  });

  it("celda vacía o nula devuelve lista vacía", () => {
    expect(parsePaymentAliases("")).toEqual([]);
    expect(parsePaymentAliases(null)).toEqual([]);
    expect(parsePaymentAliases(undefined)).toEqual([]);
  });
});

describe("formatAliasesInline", () => {
  it("une con separador visible para la celda de Sheets", () => {
    expect(formatAliasesInline("a|b|c")).toBe("a · b · c");
  });

  it("sin alias devuelve string vacío", () => {
    expect(formatAliasesInline(null)).toBe("");
  });
});
