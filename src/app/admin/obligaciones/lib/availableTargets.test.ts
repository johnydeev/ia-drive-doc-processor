import { describe, expect, it } from "vitest";
import { availableTargets } from "./availableTargets";
import type { OverviewConsortium } from "./sheetModel";

const providers = [
  { id: "p1", canonicalName: "SEGURO LA CAJA", paymentAlias: null, matchNames: null },
  { id: "p2", canonicalName: "TECNOPAS ASC.", paymentAlias: null, matchNames: null },
  { id: "p3", canonicalName: "N.G. FUMIGACION", paymentAlias: null, matchNames: null },
];

const consortium: OverviewConsortium = {
  consortiumId: "c1",
  consortiumName: "FRANKLIN 25",
  bankId: null, bankName: null, bankColor: null,
  periodId: "per1", periodLabel: "julio 2026",
  periodStatus: "ACTIVE",
  lspServices: [
    { id: "l1", providerName: "EDESUR", clientNumber: "4804882", description: null, providerId: "p9" },
    { id: "l2", providerName: "AYSA", clientNumber: "66757", description: null, providerId: null },
  ],
  fixedExpenses: [
    { id: "fx1", providerId: "p1", lspServiceId: null, description: null, active: true, obligation: null },
    { id: "fx2", providerId: null, lspServiceId: "l1", description: null, active: true, obligation: null },
  ],
};

describe("availableTargets", () => {
  it("saca lo ya cargado de las dos listas", () => {
    const out = availableTargets(consortium, providers, "");
    expect(out.lsp.map((o) => o.id)).toEqual(["l2"]);
    expect(out.providers.map((o) => o.id)).toEqual(["p3", "p2"]);
  });

  it("un gasto fijo desactivado también ocupa el lugar (no se puede duplicar)", () => {
    const withInactive: OverviewConsortium = {
      ...consortium,
      fixedExpenses: [
        { id: "fx1", providerId: "p1", lspServiceId: null, description: null, active: false, obligation: null },
      ],
    };
    const out = availableTargets(withInactive, providers, "");
    expect(out.providers.some((o) => o.id === "p1")).toBe(false);
  });

  it("arma la etiqueta del LSP con su número de cliente", () => {
    const out = availableTargets(consortium, providers, "");
    expect(out.lsp[0].label).toBe("AYSA (66757)");
  });

  it("filtra por búsqueda en las dos listas", () => {
    const out = availableTargets(consortium, providers, "fumi");
    expect(out.providers.map((o) => o.label)).toEqual(["N.G. FUMIGACION"]);
    expect(out.lsp).toEqual([]);
  });

  it("la búsqueda ignora acentos y mayúsculas", () => {
    const out = availableTargets(consortium, [{ id: "p8", canonicalName: "FUMIGACIÓN SUR", paymentAlias: null, matchNames: null }], "fumigacion");
    expect(out.providers.map((o) => o.id)).toEqual(["p8"]);
  });

  it("muestra el nombre de fantasía entre paréntesis y lo encuentra al buscar", () => {
    const withFantasia = [
      { id: "p8", canonicalName: "REY MONICA ALEJANDRA", paymentAlias: null, matchNames: "LA POPULAR|POPULAR" },
      { id: "p9", canonicalName: "MORINIGO MARCOS DAVID", paymentAlias: null, matchNames: " | " },
    ];
    const all = availableTargets(consortium, withFantasia, "");
    expect(all.providers.map((o) => o.label)).toEqual(["MORINIGO MARCOS DAVID", "REY MONICA ALEJANDRA (LA POPULAR)"]);

    const byFantasia = availableTargets(consortium, withFantasia, "popular");
    expect(byFantasia.providers.map((o) => o.id)).toEqual(["p8"]);
  });

  it("devuelve listas vacías cuando ya está todo cargado", () => {
    const full: OverviewConsortium = {
      ...consortium,
      fixedExpenses: [
        { id: "a", providerId: "p1", lspServiceId: null, description: null, active: true, obligation: null },
        { id: "b", providerId: "p2", lspServiceId: null, description: null, active: true, obligation: null },
        { id: "c", providerId: "p3", lspServiceId: null, description: null, active: true, obligation: null },
        { id: "d", providerId: null, lspServiceId: "l1", description: null, active: true, obligation: null },
        { id: "e", providerId: null, lspServiceId: "l2", description: null, active: true, obligation: null },
      ],
    };
    const out = availableTargets(full, providers, "");
    expect(out.lsp).toEqual([]);
    expect(out.providers).toEqual([]);
  });
});
