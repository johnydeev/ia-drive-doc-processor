import { describe, it, expect } from "vitest";
import {
  normalizeConsortiumName,
  consortiumFuzzyMatch,
  consortiumAliasMatch,
  areConsortiumNamesSimilar,
} from "@/lib/consortiumNormalizer";

describe("normalizeConsortiumName", () => {
  // Casos del contrato documentado en el JSDoc de la función.
  const cases: Array<[string, string]> = [
    ["CONSORCIO DE PROPIETARIOS AV PUEYRREDON 2418", "PUEYRREDON 2418"],
    ["CONSORCIO DE COPROPIETARIOS THAMES NUMEROS 647-649 CAPITAL F", "THAMES 647"],
    // NOTA (caracterización): el JSDoc/CLAUDE.md muestran este caso como
    // "ALMIRANTE BROWN 708" (reordenado, sin "AV"), pero el comportamiento REAL
    // es "BROWN ALMIRANTE AV 708": el normalizer expande la abreviatura pero no
    // reordena tokens ni quita el tipo de vía cuando va en el medio. Ese caso se
    // resuelve en el pipeline vía matchNames/fuzzy, no por el normalizer. El
    // ejemplo del comentario es aspiracional.
    ["BROWN ALMTE AV 708", "BROWN ALMIRANTE AV 708"],
    ["CONS. PROPIET. JUFRE 37/39/41", "JUFRE 37"],
    ["AV ALMIRANTE BROWN 00706 018", "ALMIRANTE BROWN 706"],
    ["FRAY JUSTO SANTAMARIA DE ORO 02178 001", "FRAY JUSTO SANTAMARIA DE ORO 2178"],
    ["CASTILLO 00246 C1414AWF CAPITAL FEDERAL", "CASTILLO 246"],
    ["SAN ANTONIO 345 PB A", "SAN ANTONIO 345"],
  ];

  it.each(cases)("normaliza %s → %s", (input, expected) => {
    expect(normalizeConsortiumName(input)).toBe(expected);
  });

  it("devuelve cadena vacía para entrada vacía", () => {
    expect(normalizeConsortiumName("")).toBe("");
    expect(normalizeConsortiumName("   ")).toBe("");
  });

  it("expande abreviaturas de calle (ALMTE → ALMIRANTE)", () => {
    expect(normalizeConsortiumName("ALMTE BROWN 706")).toBe("ALMIRANTE BROWN 706");
  });
});

describe("consortiumFuzzyMatch", () => {
  it("matchea cuando todos los tokens del canónico están en el OCR", () => {
    expect(
      consortiumFuzzyMatch("CONSORCIO DE COPROPIETARIOS THAMES NUMEROS 647-649 CAPITAL F", "THAMES 647")
    ).toBe(true);
  });

  it("matchea ignorando ceros a la izquierda del LSP", () => {
    expect(consortiumFuzzyMatch("ALMIRANTE BROWN 00706 018", "ALMIRANTE BROWN 706")).toBe(true);
  });

  it("NO matchea cuando el número difiere (708 vs 706)", () => {
    expect(consortiumFuzzyMatch("BROWN ALMTE AV 708", "ALMIRANTE BROWN 706")).toBe(false);
  });

  it("es falso con entradas vacías", () => {
    expect(consortiumFuzzyMatch("", "THAMES 647")).toBe(false);
    expect(consortiumFuzzyMatch("THAMES 647", "")).toBe(false);
  });
});

describe("consortiumAliasMatch", () => {
  it("matchea contra un alias registrado", () => {
    expect(
      consortiumAliasMatch("BROWN ALMTE AV 708", ["BROWN ALMTE AV 708", "ALMIRANTE BROWN 708"])
    ).toBe(true);
  });

  it("es falso cuando no hay aliases", () => {
    expect(consortiumAliasMatch("THAMES 647", [])).toBe(false);
  });
});

describe("areConsortiumNamesSimilar", () => {
  it("es true para dos representaciones que normalizan igual", () => {
    expect(
      areConsortiumNamesSimilar(
        "CONSORCIO DE PROPIETARIOS AV PUEYRREDON 2418",
        "PUEYRREDON 2418"
      )
    ).toBe(true);
  });

  it("es false para calles distintas", () => {
    expect(areConsortiumNamesSimilar("THAMES 647", "CASTILLO 246")).toBe(false);
  });
});
