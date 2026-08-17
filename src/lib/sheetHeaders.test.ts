import { describe, expect, it } from "vitest";
import { headersNeedUpdate } from "./sheetHeaders";

const ESPERADOS = ["RAZÓN SOCIAL", "CUIT", "NOMBRE FANTASÍA", "ALIAS DE PAGO", "TIPO", "OFICIO"];

describe("headersNeedUpdate", () => {
  it("iguales: no hay nada que escribir", () => {
    expect(headersNeedUpdate(ESPERADOS, ESPERADOS)).toBe(false);
  });

  it("ignora mayúsculas y espacios sobrantes", () => {
    expect(
      headersNeedUpdate(
        [" razón social ", "cuit", "Nombre Fantasía", "alias de pago", "tipo", "oficio"],
        ESPERADOS
      )
    ).toBe(false);
  });

  it("encabezados viejos: hay que corregirlos", () => {
    expect(
      headersNeedUpdate(["NOMBRE CANÓNICO", "CUIT", "NOMBRES ALTERNATIVOS", "ALIAS", "TIPO"], ESPERADOS)
    ).toBe(true);
  });

  it("falta la columna nueva", () => {
    expect(
      headersNeedUpdate(["RAZÓN SOCIAL", "CUIT", "NOMBRE FANTASÍA", "ALIAS DE PAGO", "TIPO"], ESPERADOS)
    ).toBe(true);
  });

  it("fila vacía (hoja recién creada a mano)", () => {
    expect(headersNeedUpdate([], ESPERADOS)).toBe(true);
  });

  it("columnas de más a la derecha no importan", () => {
    expect(headersNeedUpdate([...ESPERADOS, "NOTAS"], ESPERADOS)).toBe(false);
  });
});
