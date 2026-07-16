import { describe, it, expect } from "vitest";
import { matchProvider, normName, slugifyName, consortiumUrlKey, idFromUrlKey } from "./match";
import type { Provider, ScannedData } from "./types";

const providers: Provider[] = [
  { id: "p1", canonicalName: "TIGRE ASCENSORES S.A.", cuit: "27-33906838-6", paymentAlias: "TIGRE" },
  { id: "p2", canonicalName: "ASCENSORES POTENZA", cuit: "30-11111111-2", paymentAlias: null },
];

// Factory: ScannedData completo con overrides.
const scanned = (over: Partial<ScannedData>): ScannedData => ({
  boletaNumber: null, provider: null, providerTaxId: null, detail: null,
  observation: null, issueDate: null, dueDate: null, amount: null, tipoComprobante: null,
  ...over,
});

describe("matchProvider", () => {
  it("matchea por CUIT normalizado (dígitos, con o sin guiones)", () => {
    expect(matchProvider(providers, scanned({ providerTaxId: "27339068386" }))?.id).toBe("p1");
  });
  it("matchea por nombre canónico cuando no hay CUIT", () => {
    expect(matchProvider(providers, scanned({ provider: "tigre ascensores s.a." }))?.id).toBe("p1");
  });
  it("matchea por alias de pago", () => {
    expect(matchProvider(providers, scanned({ provider: "tigre" }))?.id).toBe("p1");
  });
  it("sin coincidencia → undefined", () => {
    expect(matchProvider(providers, scanned({ providerTaxId: "30-99999999-9", provider: "otro" }))).toBeUndefined();
  });
});

describe("normName", () => {
  it("baja a minúsculas y colapsa separadores", () => {
    expect(normName("Av. PUEYRREDON_2418")).toBe("av pueyrredon 2418");
  });
});

describe("slugify + url keys", () => {
  it("slugifyName saca acentos y arma slug", () => {
    expect(slugifyName("Av. PUEYRREDÓN 2418")).toBe("av-pueyrredon-2418");
  });
  it("consortiumUrlKey = slug + id", () => {
    expect(consortiumUrlKey({ id: "abc123", canonicalName: "THAMES 647", rawName: "" })).toBe("thames-647-abc123");
  });
  it("idFromUrlKey recupera el id (último segmento tras el guión)", () => {
    expect(idFromUrlKey("thames-647-abc123")).toBe("abc123");
  });
  it("idFromUrlKey sin guión devuelve la clave tal cual", () => {
    expect(idFromUrlKey("abc123")).toBe("abc123");
  });
});
