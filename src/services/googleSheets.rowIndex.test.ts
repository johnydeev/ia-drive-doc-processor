import { describe, it, expect } from "vitest";
import { adjustIndexAfterDelete, findRowInIndex, type SheetRowIndex } from "./googleSheets.service";

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

describe("adjustIndexAfterDelete", () => {
  function makeDeletableIndex(): SheetRowIndex {
    return {
      bySource: new Map([
        ["url-a", 2],
        ["url-b", 3],
        ["url-c", 5],
      ]),
      byBoleta: new Map([
        ["0001", { row: 2, tax: "30111111118" }],
        ["0002", { row: 3, tax: "30222222229" }],
        ["0003", { row: 5, tax: "" }],
      ]),
    };
  }

  it("decrementa en 1 las filas mayores a la borrada y elimina la fila borrada", () => {
    const index = makeDeletableIndex();
    adjustIndexAfterDelete(index, 3);
    expect(index.bySource.get("url-a")).toBe(2); // menor: no cambia
    expect(index.bySource.has("url-b")).toBe(false); // borrada: sale del índice
    expect(index.bySource.get("url-c")).toBe(4); // mayor: baja 1
    expect(index.byBoleta.get("0001")?.row).toBe(2);
    expect(index.byBoleta.has("0002")).toBe(false);
    expect(index.byBoleta.get("0003")?.row).toBe(4);
  });

  it("dos borrados consecutivos acumulan el corrimiento", () => {
    const index = makeDeletableIndex();
    adjustIndexAfterDelete(index, 2); // url-a fuera; url-b→2, url-c→4
    adjustIndexAfterDelete(index, 2); // url-b fuera; url-c→3
    expect(index.bySource.has("url-a")).toBe(false);
    expect(index.bySource.has("url-b")).toBe(false);
    expect(index.bySource.get("url-c")).toBe(3);
  });
});
