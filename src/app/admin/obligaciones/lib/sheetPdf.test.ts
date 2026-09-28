import { describe, expect, it } from "vitest";
import { pdfColumnWidths, pdfFileName, toPdfTables, type PdfCell } from "./sheetPdf";
import type { SheetData } from "./sheetModel";

const num = (n: number) => new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const currency = (n: number) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(n);
/** Filas de datos: las de sección y total empiezan con una celda objeto. */
const items = (body: PdfCell[][]) => body.filter((r) => typeof r[0] === "string");
const titleOf = (r: PdfCell[]) => (typeof r[0] === "string" ? r[0] : r[0].content);

const base: SheetData = {
  consortiumId: "c1",
  consortiumName: "FRANKLIN 25",
  bankId: "b1",
  bankName: "Santander",
  bankColor: "red",
  periodId: "per1",
  periodLabel: "julio 2026",
  periodStatus: "ACTIVE",
  rubros: [
    { id: "r3", order: 3, name: "SERVICIOS PÚBLICOS" },
    { id: "r4", order: 4, name: "ABONOS DE SERVICIOS" },
    { id: "r10", order: 10, name: "SEGUROS" },
  ],
  coefColumns: [{ id: "cA", code: "A" }, { id: "cB", code: "B" }],
  rows: [
    { fixedExpenseId: "fx2", obligationId: "ob2", providerId: null, lspServiceId: "l1",
      facturas: "4804882", concepto: "EDESUR", fantasia: null, monto: 118000, aliasCbu: ["edesur.pago"],
      status: "RECEIVED", active: true, invoiceId: "i2", carryOverRequested: false, carriedIn: false, carriedOutTo: null, invoiceUrl: null,
      extras: [], group: "SERVICIO", rubroId: "r3", coeficienteId: "cB" },
    { fixedExpenseId: "fx1", obligationId: "ob1", providerId: "p1", lspServiceId: null,
      facturas: null, concepto: "SEGURO LA CAJA", fantasia: null, monto: null, aliasCbu: [],
      status: "PENDING", active: true, invoiceId: null, carryOverRequested: false, carriedIn: false, carriedOutTo: null, invoiceUrl: null,
      extras: [], group: "PROVEEDOR", rubroId: "r10", coeficienteId: null },
    { fixedExpenseId: "fx9", obligationId: "ob9", providerId: "p9", lspServiceId: null,
      facturas: null, concepto: "FUMIGACION", fantasia: null, monto: null, aliasCbu: [],
      status: "SKIPPED", active: true, invoiceId: null, carryOverRequested: false, carriedIn: false, carriedOutTo: null, invoiceUrl: null,
      extras: [], group: "PROVEEDOR", rubroId: "r4", coeficienteId: null },
  ],
  carried: [],
  others: [],
};

/** Impaga arrastrada del mes anterior; por defecto en el rubro 3, columna A. */
const arrastrada = (over: Partial<SheetData["carried"][number]> = {}): SheetData["carried"][number] => ({
  invoiceId: "c9", facturas: null, concepto: "AYSA", monto: 900, originalAmount: 900, lateAmount: null,
  aliasCbu: [], fromLabel: "junio 2026", carryOverRequested: false, invoiceUrl: null,
  rubroId: "r3", coeficienteId: "cA", ...over,
});

describe("toPdfTables", () => {
  it("rotula banco y período en el subtítulo", () => {
    const t = toPdfTables([base])[0];
    expect(t.title).toBe("FRANKLIN 25");
    expect(t.subtitle).toBe("BANCO: Santander   ·   PERIODO: Julio 2026");
  });

  it("encabezado de dos niveles: COEFICIENTE sobre A y B", () => {
    const [grupo, columnas] = toPdfTables([base])[0].head;
    expect(grupo[1]).toEqual({ content: "COEFICIENTE", colSpan: 2, styles: { halign: "center" } });
    // El primer rótulo trae un salto de línea explícito: en columna angosta, autoTable
    // lo respeta en vez de cortar "FACT./NRO CLIENTE" a mitad de palabra.
    expect(columnas).toEqual(["FACT./\nNRO CLIENTE", "PROVEEDOR/SERVICIO", "A", "B", "ALIAS - CBU", "TÉCNICO", "TEL."]);
  });

  it("con la columna MONTO (fallback, sin coeficientes) el encabezado COEFICIENTE queda vacío", () => {
    const sinCoef = { ...base, coefColumns: [] };
    const [grupo, columnas] = toPdfTables([sinCoef])[0].head;
    expect(grupo[1]).toEqual({ content: "", colSpan: 1, styles: { halign: "center" } });
    expect(columnas).toEqual(["FACT./\nNRO CLIENTE", "PROVEEDOR/SERVICIO", "MONTO", "ALIAS - CBU", "TÉCNICO", "TEL."]);
  });

  it("con 3+ coeficientes la columna TÉCNICO baja de 14mm y el rótulo se acorta a 'TÉC.'", () => {
    const conTres = { ...base, coefColumns: [{ id: "cA", code: "A" }, { id: "cB", code: "B" }, { id: "cC", code: "C" }] };
    const [, columnas] = toPdfTables([conTres])[0].head;
    expect(columnas).toContain("TÉC.");
    expect(columnas).not.toContain("TÉCNICO");
  });

  it("sección por rubro con filas, omite los rubros vacíos y cierra con el total del mes", () => {
    const titulos = toPdfTables([base])[0].body.map(titleOf);
    // El 4 sólo tiene la salteada, que no va al papel: la sección se omite (D3).
    expect(titulos).toEqual([
      "3 SERVICIOS PÚBLICOS", "4804882", "TOTAL RUBRO 3",
      "10 SEGUROS", "", "TOTAL RUBRO 10",
      "TOTAL DEL MES",
    ]);
  });

  it("el monto va en la columna de su coeficiente, sin signo $; la pendiente sin coeficiente marca '—' en la primera", () => {
    const [edesur, seguro] = items(toPdfTables([base])[0].body);
    expect(edesur).toEqual(["4804882", "EDESUR", "", num(118000), "edesur.pago", "", ""]);
    expect(seguro).toEqual(["", "SEGURO LA CAJA", "—", "", "", "", ""]);
  });

  it("el total del rubro y del mes van por columna", () => {
    const body = toPdfTables([base])[0].body;
    const total3 = body.find((r) => titleOf(r) === "TOTAL RUBRO 3")!;
    expect(total3.slice(1, 3)).toEqual([num(0), num(118000)]);
    const mes = body[body.length - 1];
    expect(mes.slice(1, 3)).toEqual([num(0), num(118000)]);
  });

  it("lo que no tiene rubro sale como sección SIN RUBRO, desplegada (D2)", () => {
    const sinRubro = { ...base, rows: [{ ...base.rows[0], rubroId: null }] };
    expect(toPdfTables([sinRubro])[0].body.map(titleOf)).toContain("SIN RUBRO");
  });

  it("una eventual va en su rubro con la fantasía entre paréntesis", () => {
    const conOtra = { ...base, others: [{ invoiceId: "o1", facturas: null, concepto: "PLOMERO JUAN", fantasia: "JUAN",
      monto: 32000, aliasCbu: ["juan.plomero"], invoiceUrl: null, carryOverRequested: false, carriedOutTo: null,
      group: "PROVEEDOR" as const, rubroId: "r4", coeficienteId: "cA" }] };
    const body = toPdfTables([conOtra])[0].body;
    expect(body.map(titleOf)).toContain("4 ABONOS DE SERVICIOS");
    expect(items(body)).toContainEqual(["", "PLOMERO JUAN (JUAN)", num(32000), "", "juan.plomero", "", ""]);
  });

  it("una adicional sale debajo de su madre con el mismo nombre, su factura y en la columna de la madre", () => {
    const conExtra = { ...base, rows: [{ ...base.rows[0], extras: [
      { invoiceId: "e1", facturas: "0001-00000077", monto: 54000, invoiceUrl: null, carryOverRequested: false, carriedOutTo: null },
    ] }] };
    expect(items(toPdfTables([conExtra])[0].body)[1]).toEqual(["0001-00000077", "EDESUR", "", num(54000), "edesur.pago", "", ""]);
  });

  it("una adicional con coeficiente propio sale en esa columna", () => {
    const conExtra = { ...base, rows: [{ ...base.rows[0], extras: [
      { invoiceId: "e1", facturas: null, monto: 54000, invoiceUrl: null, carryOverRequested: false, carriedOutTo: null, coeficienteId: "cA" },
    ] }] };
    expect(items(toPdfTables([conExtra])[0].body)[1]).toEqual(["", "EDESUR", num(54000), "", "edesur.pago", "", ""]);
  });

  it("la adicional de una madre salteada sale sola, con el nombre de la madre", () => {
    const salteada = { ...base, rows: [{ ...base.rows[0], status: "SKIPPED" as const, extras: [
      { invoiceId: "e2", facturas: null, monto: 54000, invoiceUrl: null, carryOverRequested: false, carriedOutTo: null },
    ] }] };
    expect(items(toPdfTables([salteada])[0].body)).toContainEqual(["", "EDESUR", "", num(54000), "edesur.pago", "", ""]);
  });

  it("madre salteada cuya única adicional cayó en otro rubro: su sección no sale vacía", () => {
    // La madre queda en el rubro 3 sin adicionales propias (la suya se fue al 4):
    // es un ítem de la sección pero no imprime nada. Sin el filtro por lo
    // imprimible, el papel mostraba "3 SERVICIOS PÚBLICOS" y su total sin filas.
    for (const status of ["SKIPPED", "CARRIED_OVER"] as const) {
      const madre = { ...base, rows: [{ ...base.rows[0], status, extras: [
        { invoiceId: "e3", facturas: "0001-00000088", monto: 54000, invoiceUrl: null, carryOverRequested: false, carriedOutTo: null, rubroId: "r4" },
      ] }] };
      const titulos = toPdfTables([madre])[0].body.map(titleOf);
      expect(titulos).not.toContain("3 SERVICIOS PÚBLICOS");
      expect(titulos).toEqual(["4 ABONOS DE SERVICIOS", "0001-00000088", "TOTAL RUBRO 4", "TOTAL DEL MES"]);
    }
  });

  it("la fila de un empleado sale rotulada 'Empleado'", () => {
    const sueldo = { ...base, rows: [{ ...base.rows[0], facturas: null, group: "EMPLEADO" as const }] };
    expect(items(toPdfTables([sueldo])[0].body)[0][0]).toBe("Empleado");
  });

  it("una arrastrada va en su rubro con «(de junio)», en la columna de su coeficiente, y suma en los totales", () => {
    const conArrastre = { ...base, carried: [arrastrada()] };
    const t = toPdfTables([conArrastre])[0];
    expect(t.body.map(titleOf).slice(0, 4)).toEqual(["3 SERVICIOS PÚBLICOS", "", "4804882", "TOTAL RUBRO 3"]);
    expect(items(t.body)).toContainEqual(["", "AYSA (de junio)", num(900), "", "", "", ""]);
    const total3 = t.body.find((r) => titleOf(r) === "TOTAL RUBRO 3")!;
    expect(total3.slice(1, 3)).toEqual([num(900), num(118000)]);
    expect(t.body[t.body.length - 1].slice(1, 3)).toEqual([num(900), num(118000)]);
    // Ya no hay bloque ni tabla aparte.
    expect(t).not.toHaveProperty("carried");
  });

  it("una arrastrada sin rubro sale en SIN RUBRO", () => {
    const t = toPdfTables([{ ...base, carried: [arrastrada({ rubroId: null })] }])[0];
    const iSin = t.body.findIndex((r) => titleOf(r) === "SIN RUBRO");
    expect(iSin).toBeGreaterThan(-1);
    expect(t.body[iSin + 1]).toEqual(["", "AYSA (de junio)", num(900), "", "", "", ""]);
  });

  it("la impaga con 2° vencimiento muestra el 1° pago con signo $ (D8: es texto, no columna de monto)", () => {
    const t = toPdfTables([{ ...base, carried: [arrastrada({ monto: 950, lateAmount: 950 })] }])[0];
    const row = items(t.body).find((r) => String(r[1]).startsWith("AYSA"))!;
    expect(row[1]).toBe(`AYSA (de junio) (1° pago ${currency(900)})`);
    expect(row[2]).toBe(num(950));
  });

  it("la fila cuya boleta pasó a otro mes (CARRIED_OVER) no sale", () => {
    const pasada = { ...base, rows: [{ ...base.rows[0], status: "CARRIED_OVER" as const, carriedOutTo: "agosto 2026" }, base.rows[1]] };
    const t = toPdfTables([pasada])[0];
    expect(t.body.map(titleOf)).not.toContain("4804882");
  });

  it("un edificio sin nada imprimible no genera tabla", () => {
    const salteadas = { ...base, rows: base.rows.map((r) => ({ ...r, status: "SKIPPED" as const })) };
    expect(toPdfTables([salteadas])).toEqual([]);
  });

  it("un edificio sólo con impagas arrastradas genera la tabla con su sección", () => {
    const soloArrastre = {
      ...base,
      rows: base.rows.map((r) => ({ ...r, status: "SKIPPED" as const })),
      carried: [arrastrada()],
    };
    const [t] = toPdfTables([soloArrastre]);
    expect(t.body.map(titleOf)).toEqual(["3 SERVICIOS PÚBLICOS", "", "TOTAL RUBRO 3", "TOTAL DEL MES"]);
  });

  describe("ancho de fila = ancho de columnas", () => {
    const colSpanOf = (cell: PdfCell) => (typeof cell === "string" ? 1 : cell.colSpan ?? 1);
    const rowSpan = (row: PdfCell[]) => row.reduce((sum, c) => sum + colSpanOf(c), 0);

    it("cada fila de head/body suma exactamente widths.length, con MONTO (n=1) y con 2 coeficientes", () => {
      for (const sheet of [base, { ...base, coefColumns: [] }]) {
        const t = toPdfTables([sheet])[0];
        for (const row of [...t.head, ...t.body]) {
          expect(rowSpan(row)).toBe(t.widths.length);
        }
      }
    });

    it("la línea de una arrastrada también suma widths.length", () => {
      const t = toPdfTables([{ ...base, carried: [arrastrada()] }])[0];
      for (const row of t.body) {
        expect(rowSpan(row)).toBe(t.widths.length);
      }
    });
  });
});

describe("pdfColumnWidths", () => {
  it.each([1, 2, 3, 4])("con %i coeficiente(s) suma los 182 mm útiles del A4", (n) => {
    const w = pdfColumnWidths(n);
    expect(w).toHaveLength(5 + n);
    expect(w.reduce((a, b) => a + b, 0)).toBe(182);
    expect(w[1]).toBeGreaterThanOrEqual(40); // PROVEEDOR/SERVICIO sigue legible
  });

  it.each([5, 6, 8])("con %i coeficientes sigue sumando 182 y el concepto no queda en 0", (n) => {
    const w = pdfColumnWidths(n);
    expect(w).toHaveLength(5 + n);
    expect(w.reduce((a, b) => a + b, 0)).toBe(182);
    expect(w[1]).toBeGreaterThan(0);
    if (n === 5) expect(w[1]).toBeGreaterThanOrEqual(40);
  });
});

describe("pdfFileName", () => {
  it("usa el mes mayoritario", () => {
    expect(pdfFileName("agosto 2026")).toBe("obligaciones-agosto-2026.pdf");
  });
  it("sin mes cae a un nombre genérico", () => {
    expect(pdfFileName(null)).toBe("obligaciones.pdf");
  });
});
