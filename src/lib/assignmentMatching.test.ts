import { describe, it, expect } from "vitest";
import {
  matchConsortium,
  matchProvider,
  type ConsortiumMatchRow,
  type ProviderMatchRow,
} from "@/lib/assignmentMatching";

const consortium = (over: Partial<ConsortiumMatchRow>): ConsortiumMatchRow => ({
  id: "c1",
  canonicalName: "THAMES 647",
  rawName: "CONSORCIO THAMES 647",
  cuit: null,
  matchNames: null,
  ...over,
});

const provider = (over: Partial<ProviderMatchRow>): ProviderMatchRow => ({
  id: "p1",
  canonicalName: "TIGRE ASCENSORES S.A.",
  cuit: null,
  matchNames: null,
  paymentAlias: null,
  ...over,
});

describe("matchConsortium", () => {
  it("matchea por CUIT (allTaxIds) con prioridad sobre el nombre", () => {
    const rows = [
      consortium({ id: "c1", canonicalName: "THAMES 647", cuit: "30-11111111-1" }),
      consortium({ id: "c2", canonicalName: "CASTILLO 246", cuit: "30-22222222-2" }),
    ];
    const result = matchConsortium(rows, "OTRO NOMBRE", ["30222222222"]);
    expect(result?.row.id).toBe("c2");
    expect(result?.method).toMatch(/^CUIT/);
  });

  it("matchea por CUIT alternativo en matchNames", () => {
    const rows = [consortium({ id: "c1", cuit: "30-11111111-1", matchNames: "30-99999999-9" })];
    const result = matchConsortium(rows, null, ["30999999999"]);
    expect(result?.row.id).toBe("c1");
    expect(result?.method).toMatch(/^CUIT/);
  });

  it("matchea por nombre exacto normalizado", () => {
    const rows = [consortium({ canonicalName: "PUEYRREDON 2418" })];
    const result = matchConsortium(rows, "CONSORCIO DE PROPIETARIOS AV PUEYRREDON 2418", []);
    expect(result?.method).toBe("exacto");
    expect(result?.row.canonicalName).toBe("PUEYRREDON 2418");
  });

  it("matchea por fuzzy cuando el exacto no coincide pero los tokens están presentes", () => {
    // El raw normaliza a "ALMIRANTE BROWN 706" (≠ canónico "BROWN 706"), así que el
    // exacto falla; el fuzzy pasa porque los tokens del canónico (BROWN, 706) están
    // en el raw.
    const rows = [consortium({ canonicalName: "BROWN 706" })];
    const result = matchConsortium(rows, "ALMIRANTE BROWN 706", []);
    expect(result?.method).toBe("fuzzy");
  });

  it("matchea por alias (matchNames) cuando el número difiere", () => {
    const rows = [consortium({ canonicalName: "ALMIRANTE BROWN 706", matchNames: "BROWN ALMTE AV 708" })];
    const result = matchConsortium(rows, "BROWN ALMTE AV 708", []);
    expect(result?.method).toBe("alias");
  });

  it("devuelve null cuando nada matchea", () => {
    const rows = [consortium({ canonicalName: "THAMES 647" })];
    expect(matchConsortium(rows, "CALLE INEXISTENTE 9999", [])).toBeNull();
  });

  it("devuelve null si no hay nombre ni CUIT para matchear", () => {
    const rows = [consortium({ canonicalName: "THAMES 647" })];
    expect(matchConsortium(rows, null, [])).toBeNull();
  });
});

describe("matchProvider", () => {
  it("matchea por CUIT (allTaxIds) excluyendo el CUIT del consorcio", () => {
    const rows = [provider({ id: "p1", cuit: "30-65511651-2" })];
    const result = matchProvider(rows, null, null, ["30655116512", "30999999999"], "30999999999");
    expect(result?.row.id).toBe("p1");
    expect(result?.method).toMatch(/CUIT/);
  });

  it("NO matchea si el único CUIT disponible es el del consorcio", () => {
    const rows = [provider({ id: "p1", cuit: "30-99999999-9" })];
    const result = matchProvider(rows, null, null, ["30999999999"], "30999999999");
    expect(result).toBeNull();
  });

  it("matchea por providerTaxId (rawCuit) cuando no hay allTaxIds", () => {
    const rows = [provider({ id: "p1", cuit: "30-65511651-2" })];
    const result = matchProvider(rows, "30-65511651-2", null, [], "30111111111");
    expect(result?.row.id).toBe("p1");
    expect(result?.method).toMatch(/CUIT/);
  });

  it("devuelve null cuando nada matchea", () => {
    const rows = [provider({ id: "p1", canonicalName: "TIGRE ASCENSORES S.A.", cuit: "30-65511651-2" })];
    expect(matchProvider(rows, "30-00000000-0", "OTRA EMPRESA", [], "30111111111")).toBeNull();
  });

  describe("facturas normales: proveedor SOLO por CUIT (allowNameMatch=false, default)", () => {
    // Regresión del bug real (2026-07-02): una factura de "ASCENSORES POTENZA"
    // (proveedor NO cargado, sin CUIT propio en el texto) se asignaba por error a
    // otro "ASCENSORES ..." que sí estaba en la DB, por el match de nombre parcial
    // (`slice(0,5)` → ambos comparten "ascen"). Ahora, sin CUIT de proveedor, va a
    // Sin Asignar en vez de asignarse mal.
    it("NO asigna por nombre a otro proveedor con prefijo común (bug ASCENSORES POTENZA)", () => {
      const rows = [provider({ id: "p-tigre", canonicalName: "ASCENSORES TIGRE S.A.", cuit: "30-65511651-2" })];
      // El único CUIT del papel es el del consorcio; el proveedor real no está cargado.
      const result = matchProvider(rows, null, "ASCENSORES POTENZA", ["30717417182"], "30717417182");
      expect(result).toBeNull();
    });

    it("NO matchea por nombre exacto aunque el nombre coincida (sin CUIT → Sin Asignar)", () => {
      const rows = [provider({ id: "p1", canonicalName: "TIGRE ASCENSORES S.A." })];
      expect(matchProvider(rows, null, "Tigre Ascensores SA", [], "30111111111")).toBeNull();
    });

    it("NO matchea por matchNames si no hay CUIT", () => {
      const rows = [provider({ id: "p1", canonicalName: "TIGRE ASCENSORES S.A.", matchNames: "TIGRE ASCENSORES" })];
      expect(matchProvider(rows, null, "TIGRE ASCENSORES", [], "30111111111")).toBeNull();
    });

    it("sí matchea si el CUIT del proveedor está presente (camino feliz)", () => {
      const rows = [provider({ id: "p1", canonicalName: "ASCENSORES POTENZA S.R.L.", cuit: "30-70200241-5" })];
      const result = matchProvider(rows, null, "ASCENSORES POTENZA", ["30702002415", "30717417182"], "30717417182");
      expect(result?.row.id).toBe("p1");
      expect(result?.method).toMatch(/CUIT/);
    });
  });

  describe("match por nombre habilitado (allowNameMatch=true, solo sindicales/ARCA)", () => {
    it("matchea por nombre exacto normalizado (ignora sufijos legales)", () => {
      const rows = [provider({ id: "p1", canonicalName: "TIGRE ASCENSORES S.A." })];
      const result = matchProvider(rows, null, "Tigre Ascensores SA", [], "30111111111", true);
      expect(result?.row.id).toBe("p1");
      expect(result?.method).toMatch(/nombre exacto/);
    });

    it("matchea por matchNames (alias interno)", () => {
      const rows = [provider({ id: "p1", canonicalName: "TIGRE ASCENSORES S.A.", matchNames: "TIGRE ASCENSORES" })];
      const result = matchProvider(rows, null, "TIGRE ASCENSORES", [], "30111111111", true);
      expect(result?.row.id).toBe("p1");
    });

    it("matchea por nombre parcial cuando no hay exacto", () => {
      const rows = [provider({ id: "p1", canonicalName: "ASCENSORES TIGRE SOCIEDAD ANONIMA" })];
      const result = matchProvider(rows, null, "ASCENSORES TIGRE", [], "30111111111", true);
      expect(result?.row.id).toBe("p1");
      expect(result?.method).toMatch(/parcial/);
    });
  });

  describe("CUIT compartido entre varios proveedores (ej. SUTERH/FATERYH/SERACARH)", () => {
    const sindicales = [
      provider({ id: "p-fateryh", canonicalName: "FATERYH", cuit: "30-54675623-4" }),
      provider({ id: "p-suterh", canonicalName: "SUTERH", cuit: "30-54675623-4" }),
      provider({ id: "p-seracarh", canonicalName: "SERACARH", cuit: "30-54675623-4" }),
    ];

    it("desambigua por nombre cuando varios proveedores comparten el CUIT (allTaxIds)", () => {
      const result = matchProvider(sindicales, null, "SUTERH", ["30546756234"], "30111111111");
      expect(result?.row.id).toBe("p-suterh");
    });

    it("desambigua por nombre con el CUIT legacy (providerTaxId)", () => {
      const result = matchProvider(sindicales, "30-54675623-4", "SERACARH", [], "30111111111");
      expect(result?.row.id).toBe("p-seracarh");
    });

    it("desambigua también por matchNames", () => {
      const rows = [
        provider({ id: "p-a", canonicalName: "FED. TRABAJADORES EDIFICIOS", cuit: "30-54675623-4", matchNames: "FATERYH" }),
        provider({ id: "p-b", canonicalName: "SINDICATO EDIFICIOS", cuit: "30-54675623-4", matchNames: "SUTERH" }),
      ];
      const result = matchProvider(rows, null, "SUTERH", ["30546756234"], "30111111111");
      expect(result?.row.id).toBe("p-b");
    });

    it("si el nombre no desambigua, devuelve el primero (comportamiento estable)", () => {
      const result = matchProvider(sindicales, null, "ALGO QUE NO COINCIDE", ["30546756234"], "30111111111");
      expect(result?.row.id).toBe("p-fateryh");
      expect(result?.method).toMatch(/CUIT/);
    });

    it("con CUIT único (sin colisión) el nombre no influye", () => {
      const rows = [
        provider({ id: "p1", canonicalName: "EDESUR S.A.", cuit: "30-65511651-2" }),
      ];
      const result = matchProvider(rows, null, "OTRO NOMBRE", ["30655116512"], "30111111111");
      expect(result?.row.id).toBe("p1");
    });
  });

  describe("proveedores sindicales SIN CUIT (matching solo por nombre)", () => {
    // Modelo: 2 proveedores sin CUIT — SUTERH y FATERYH; SERACARH es anexo de
    // FATERYH (alias en matchNames). El CUIT del documento es del consorcio
    // (consortiumCuit), no del proveedor.
    const sindicales = [
      provider({ id: "p-suterh", canonicalName: "SUTERH", cuit: null }),
      provider({ id: "p-fateryh", canonicalName: "FATERYH", cuit: null, matchNames: "SERACARH" }),
    ];
    const consortiumCuit = "30546756234"; // CUIT del edificio (BOEDO 414)
    // Sindicales/ARCA: match por nombre habilitado (CUIT del papel = consorcio).

    it("boleta SUTERH → proveedor SUTERH por nombre", () => {
      const r = matchProvider(sindicales, null, "SUTERH", [consortiumCuit], consortiumCuit, true);
      expect(r?.row.id).toBe("p-suterh");
      expect(r?.method).toMatch(/nombre/);
    });

    it("boleta FATERYH → proveedor FATERYH por nombre", () => {
      const r = matchProvider(sindicales, null, "FATERYH", [consortiumCuit], consortiumCuit, true);
      expect(r?.row.id).toBe("p-fateryh");
    });

    it("boleta SERACARH → proveedor FATERYH (vía alias matchNames)", () => {
      const r = matchProvider(sindicales, null, "SERACARH", [consortiumCuit], consortiumCuit, true);
      expect(r?.row.id).toBe("p-fateryh");
    });

    it("el CUIT del consorcio NO matchea a ningún proveedor (queda excluido)", () => {
      // Aunque allTaxIds traiga el CUIT del edificio, ningún proveedor lo tiene
      // → no hay falso match por CUIT; el nombre manda.
      const r = matchProvider(sindicales, null, "SUTERH", [consortiumCuit], consortiumCuit, true);
      expect(r?.method).not.toMatch(/CUIT/);
    });

    it("sin allowNameMatch (default) NO matchearía por nombre (van a Sin Asignar)", () => {
      // Blindaje: si un sindical no se detecta como tal (allowNameMatch=false),
      // no se asigna por nombre — el caller lo activa con usesConsortiumCuit().
      const r = matchProvider(sindicales, null, "SUTERH", [consortiumCuit], consortiumCuit);
      expect(r).toBeNull();
    });
  });
});
