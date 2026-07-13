import { describe, it, expect } from "vitest";
import { findRowInIndex, type SheetRowIndex } from "./googleSheets.service";

function makeIndex(): SheetRowIndex {
  return {
    bySource: new Map([["https://drive/a", 5]]),
    byBoleta: new Map([["0001-123", { row: 8, tax: "30111111112" }]]),
  };
}

describe("findRowInIndex", () => {
  it("matchea por sourceFileUrl (prioridad)", () => {
    expect(findRowInIndex(makeIndex(), { sourceFileUrl: "https://drive/a" })).toBe(5);
  });

  it("matchea por boletaNumber + tax", () => {
    expect(findRowInIndex(makeIndex(), { boletaNumber: "0001-123", providerTaxId: "30-11111111-2" })).toBe(8);
  });

  it("boletaNumber sin tax en el filtro → matchea igual", () => {
    expect(findRowInIndex(makeIndex(), { boletaNumber: "0001-123" })).toBe(8);
  });

  it("tax distinto → no matchea", () => {
    expect(findRowInIndex(makeIndex(), { boletaNumber: "0001-123", providerTaxId: "30-99999999-9" })).toBe(-1);
  });

  it("sin coincidencia → -1", () => {
    expect(findRowInIndex(makeIndex(), { sourceFileUrl: "https://drive/z" })).toBe(-1);
  });
});
