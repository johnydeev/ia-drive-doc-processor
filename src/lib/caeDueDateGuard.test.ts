import { describe, it, expect } from "vitest";
import { correctCaeDueDate, extractCaeExpiryDates } from "@/lib/caeDueDateGuard";

/**
 * Caso real de producción (2026-08-18): factura de Fumigaciones Miguel a EVA PERON
 * 1761 que entró con `dueDate = 2026-07-07`, que es su vencimiento de CAE.
 */
const EVA_PERON_TEXT = [
  "Nº00002-00208625",
  "Comprobante Autorizado",
  "CAE Nº: 86261388347250",
  "Fecha de Vto. de CAE: 07/07/2026",
  "Fecha 27/06/2026",
].join("\n");

/** Cómo lo dejó el OCR del membrete: "Vto" leído como "Vito". */
const OCR_TEXT = "ie Be AR( A CAE No: 86261914233887\nks Epa Fecha de Vito. de CAE: 11/07/2026";

/** Layout de BPACE: el CAE y su vencimiento en la misma línea. */
const BPACE_TEXT = "Nro. de CAE: 86095857203130 - Fecha de Vto.: 12/03/26 Total : 104,500.00";

describe("extractCaeExpiryDates", () => {
  it("detecta el vencimiento de CAE rotulado", () => {
    expect(extractCaeExpiryDates(EVA_PERON_TEXT)).toEqual(["2026-07-07"]);
  });

  it("lo detecta aunque el OCR haya deformado el rótulo", () => {
    expect(extractCaeExpiryDates(OCR_TEXT)).toEqual(["2026-07-11"]);
  });

  it("lo detecta cuando va pegado al número de CAE, con año de dos dígitos", () => {
    expect(extractCaeExpiryDates(BPACE_TEXT)).toEqual(["2026-03-12"]);
  });

  it("NO toca una fecha de vencimiento de PAGO", () => {
    // Los prompts tratan el vencimiento "para el pago" como siempre válido.
    const text = "CAE Nº: 86261388347250 Fecha de Vto. para el pago: 31/08/2026";

    expect(extractCaeExpiryDates(text)).toEqual([]);
  });

  it("no marca la fecha de emisión de la línea siguiente", () => {
    // El texto real trae "Fecha de Vto. de CAE: 07/07/2026" y debajo
    // "Fecha 27/06/2026", que es la emisión: no debe tocarse.
    expect(extractCaeExpiryDates(EVA_PERON_TEXT)).not.toContain("2026-06-27");
  });

  it("ignora fechas sin el CAE cerca", () => {
    expect(extractCaeExpiryDates("Fecha de emisión 01/07/2026\nPeriodo: JUNIO 2026")).toEqual([]);
  });

  it("descarta fechas imposibles", () => {
    expect(extractCaeExpiryDates("CAE Nº: 99/99/9999")).toEqual([]);
  });

  it("no rompe con texto vacío", () => {
    expect(extractCaeExpiryDates("")).toEqual([]);
    expect(extractCaeExpiryDates(null)).toEqual([]);
  });
});

describe("correctCaeDueDate", () => {
  it("anula el vencimiento cuando es el del CAE (el bug real)", () => {
    expect(correctCaeDueDate("2026-07-07", EVA_PERON_TEXT)).toEqual({
      dueDate: null,
      corrected: true,
    });
  });

  it("deja pasar un vencimiento de pago legítimo", () => {
    expect(correctCaeDueDate("2026-08-31", EVA_PERON_TEXT)).toEqual({
      dueDate: "2026-08-31",
      corrected: false,
    });
  });

  it("no hace nada si no había vencimiento", () => {
    expect(correctCaeDueDate(null, EVA_PERON_TEXT)).toEqual({ dueDate: null, corrected: false });
  });

  it("no hace nada sin texto (extracción por Vision)", () => {
    expect(correctCaeDueDate("2026-07-07", "")).toEqual({ dueDate: "2026-07-07", corrected: false });
  });
});
