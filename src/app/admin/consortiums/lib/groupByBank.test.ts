import { describe, expect, it } from "vitest";
import { groupByBank, UNASSIGNED_BANK_ID } from "./groupByBank";
import type { Bank, Consortium } from "./types";

const banks: Bank[] = [
  { id: "b1", name: "Santander", color: "red" },
  { id: "b2", name: "Galicia", color: "amber" },
];

function consortium(id: string, rawName: string, bank: Bank | null): Consortium {
  return {
    id, canonicalName: rawName, rawName, cuit: null, cutoffDay: 5,
    matchNames: null, statementsFolderUrl: null,
    bankId: bank?.id ?? null,
    bank: bank ? { id: bank.id, name: bank.name, color: bank.color } : null,
    bankAlias: null, cbu: null, accountNumber: null,
    branch: null, accountType: null, accountHolder: null,
    periods: [], _count: { invoices: 0 },
    activePeriodInvoiceCount: 0, activePeriodDebt: 0, totalDebt: 0,
  };
}

const arenales = consortium("c1", "ARENALES 2154", banks[0]);
const thames = consortium("c2", "THAMES 647", banks[0]);
const castillo = consortium("c3", "CASTILLO 246", banks[1]);
const huerfano = consortium("c4", "MITRE 1225", null);

describe("groupByBank", () => {
  it("agrupa los consorcios bajo su banco, en el orden de los bancos", () => {
    const groups = groupByBank(banks, [castillo, arenales, thames], "");
    expect(groups.map((g) => g.id)).toEqual(["b1", "b2"]);
    expect(groups[0].consortiums.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(groups[0].color).toBe("red");
  });

  it("emite el grupo Sin banco al final cuando hay consorcios sin asignar", () => {
    const groups = groupByBank(banks, [arenales, huerfano], "");
    expect(groups.at(-1)?.id).toBe(UNASSIGNED_BANK_ID);
    expect(groups.at(-1)?.consortiums.map((c) => c.id)).toEqual(["c4"]);
  });

  it("no emite el grupo Sin banco cuando todos tienen banco", () => {
    const groups = groupByBank(banks, [arenales, castillo], "");
    expect(groups.some((g) => g.id === UNASSIGNED_BANK_ID)).toBe(false);
  });

  it("incluye bancos sin consorcios (para que se vean los recién creados)", () => {
    const groups = groupByBank(banks, [arenales], "");
    expect(groups.map((g) => g.id)).toEqual(["b1", "b2"]);
    expect(groups[1].consortiums).toEqual([]);
  });

  it("filtrando por nombre de banco muestra ese banco con todos sus consorcios", () => {
    const groups = groupByBank(banks, [arenales, thames, castillo], "santander");
    expect(groups.map((g) => g.id)).toEqual(["b1"]);
    expect(groups[0].consortiums).toHaveLength(2);
  });

  it("filtrando por nombre de edificio reduce los consorcios del grupo", () => {
    const groups = groupByBank(banks, [arenales, thames, castillo], "thames");
    expect(groups.map((g) => g.id)).toEqual(["b1"]);
    expect(groups[0].consortiums.map((c) => c.id)).toEqual(["c2"]);
  });

  it("filtra también dentro del grupo Sin banco", () => {
    const groups = groupByBank(banks, [arenales, huerfano], "mitre");
    expect(groups.map((g) => g.id)).toEqual([UNASSIGNED_BANK_ID]);
    expect(groups[0].consortiums.map((c) => c.id)).toEqual(["c4"]);
  });

  it("devuelve lista vacía si nada matchea", () => {
    expect(groupByBank(banks, [arenales], "zzz")).toEqual([]);
  });
});
