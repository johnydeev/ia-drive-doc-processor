import { describe, expect, it } from "vitest";
import { parseLsdOutput, buildLsdPrompt } from "./lsdExtraction";

describe("buildLsdPrompt", () => {
  it("pide los campos del libro y la lista de empleados", () => {
    const prompt = buildLsdPrompt("EMPRESA DOMICILIO FISCAL ...");
    expect(prompt).toContain("empleados");
    expect(prompt).toContain("cuil");
    expect(prompt).toContain("sueldoNeto");
    expect(prompt).toContain("IDENTIFICADOR ÚNICO DEL LIBRO");
  });

  it("incluye el texto del libro", () => {
    expect(buildLsdPrompt("TEXTO DEL LIBRO")).toContain("TEXTO DEL LIBRO");
  });
});

describe("parseLsdOutput", () => {
  it("parsea el JSON del modelo", () => {
    const out = parseLsdOutput(
      JSON.stringify({
        consortiumTaxId: "30-52063978-7",
        libroId: "000000045900718",
        periodo: "202607",
        empleados: [
          { cuil: "27-18116846-9", apellidoNombre: "BRITEZ, PAULA ADELA", sueldoNeto: 1318092 },
          { cuil: "27-29427364-1", apellidoNombre: "BUSTOS MUNIZAGA, ANDREA", sueldoNeto: 366772.8 },
        ],
      })
    );
    expect(out.consortiumTaxId).toBe("30-52063978-7");
    expect(out.libroId).toBe("000000045900718");
    expect(out.empleados).toHaveLength(2);
    expect(out.empleados[1].sueldoNeto).toBe(366772.8);
  });

  it("tolera el JSON envuelto en ```json", () => {
    const out = parseLsdOutput('```json\n{"empleados":[],"libroId":"1"}\n```');
    expect(out.libroId).toBe("1");
    expect(out.empleados).toEqual([]);
  });

  it("descarta empleados sin CUIL o sin sueldo", () => {
    const out = parseLsdOutput(
      JSON.stringify({
        libroId: "1",
        empleados: [
          { cuil: "27-18116846-9", apellidoNombre: "OK", sueldoNeto: 100 },
          { cuil: null, apellidoNombre: "SIN CUIL", sueldoNeto: 100 },
          { cuil: "20-24883768-4", apellidoNombre: "SIN SUELDO", sueldoNeto: null },
        ],
      })
    );
    expect(out.empleados).toHaveLength(1);
    expect(out.empleados[0].cuil).toBe("27-18116846-9");
  });

  it("normaliza montos en formato es-AR", () => {
    const out = parseLsdOutput(
      JSON.stringify({
        libroId: "1",
        empleados: [{ cuil: "27-18116846-9", apellidoNombre: "X", sueldoNeto: "$ 1.318.092,00" }],
      })
    );
    expect(out.empleados[0].sueldoNeto).toBe(1318092);
  });

  it("deduplica empleados repetidos por CUIL", () => {
    const out = parseLsdOutput(
      JSON.stringify({
        libroId: "1",
        empleados: [
          { cuil: "27-18116846-9", apellidoNombre: "BRITEZ", sueldoNeto: 100 },
          { cuil: "27181168469", apellidoNombre: "BRITEZ", sueldoNeto: 100 },
        ],
      })
    );
    expect(out.empleados).toHaveLength(1);
  });

  it("devuelve una extracción vacía si el JSON no trae empleados", () => {
    const out = parseLsdOutput("{}");
    expect(out.empleados).toEqual([]);
    expect(out.libroId).toBeNull();
  });
});
