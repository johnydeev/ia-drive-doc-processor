import { describe, expect, it } from "vitest";
import { OTHERS_TITLE, PDF_COLUMNS, pdfFileName, toPdfTables } from "./sheetPdf";
import type { SheetData } from "./sheetModel";

const sheets: SheetData[] = [
  {
    consortiumId: "c1",
    consortiumName: "FRANKLIN 25",
    bankId: "b1",
    bankName: "Santander",
    bankColor: "red",
    periodId: "per1",
    periodLabel: "julio 2026",
  periodStatus: "ACTIVE",
    rows: [
      { fixedExpenseId: "fx2", obligationId: "ob2", providerId: null, lspServiceId: "l1",
        facturas: "4804882", concepto: "EDESUR", fantasia: null, monto: 118000, aliasCbu: ["edesur.pago"],
        status: "RECEIVED", active: true, invoiceId: null, carryOverRequested: false, carriedIn: false, invoiceUrl: null, extras: [], group: "SERVICIO" },
      { fixedExpenseId: "fx1", obligationId: "ob1", providerId: "p1", lspServiceId: null,
        facturas: null, concepto: "SEGURO LA CAJA", fantasia: null, monto: null, aliasCbu: [],
        status: "PENDING", active: true, invoiceId: null, carryOverRequested: false, carriedIn: false, invoiceUrl: null, extras: [], group: "PROVEEDOR" },
      { fixedExpenseId: "fx9", obligationId: "ob9", providerId: "p9", lspServiceId: null,
        facturas: null, concepto: "FUMIGACION", fantasia: null, monto: null, aliasCbu: [],
        status: "SKIPPED", active: true, invoiceId: null, carryOverRequested: false, carriedIn: false, invoiceUrl: null, extras: [], group: "PROVEEDOR" },
    ],
    carried: [],
    others: [],
  },
];

describe("toPdfTables", () => {
  it("arma una tabla por edificio con banco y período rotulados en el subtítulo", () => {
    const tables = toPdfTables(sheets);
    expect(tables).toHaveLength(1);
    expect(tables[0].title).toBe("FRANKLIN 25");
    expect(tables[0].subtitle).toBe("BANCO: Santander   ·   PERIODO: Julio 2026");
  });

  it("un edificio sin banco sólo rotula el período", () => {
    const sinBanco = [{ ...sheets[0], bankId: null, bankName: "", periodLabel: "agosto 2026" }];
    expect(toPdfTables(sinBanco)[0].subtitle).toBe("PERIODO: Agosto 2026");
  });

  // El catálogo tiene los bancos con mayúsculas mezcladas; el papel los muestra
  // parejos sin tocar el registro.
  it("normaliza el nombre del banco para el papel", () => {
    const casos: Array<[string, string]> = [
      ["CIUDAD", "BANCO: Ciudad"],
      ["santander", "BANCO: Santander"],
      ["BANCO NACION", "BANCO: Banco Nacion"],
      ["  galicia  ", "BANCO: Galicia"],
    ];
    for (const [guardado, esperado] of casos) {
      const out = toPdfTables([{ ...sheets[0], bankName: guardado }]);
      expect(out[0].subtitle.startsWith(esperado)).toBe(true);
    }
  });

  it("usa las seis columnas de la planilla", () => {
    expect(toPdfTables(sheets)[0].head).toEqual([PDF_COLUMNS]);
    expect(PDF_COLUMNS).toHaveLength(6);
    expect(PDF_COLUMNS.slice(0, 2)).toEqual(["FACTURA/NRO CLIENTE", "PROVEEDOR/SERVICIO"]);
  });

  it("aplica el filtro de impresión: la salteada no viaja", () => {
    const body = toPdfTables(sheets)[0].body;
    expect(body).toHaveLength(2);
    expect(body.some((fila) => fila[1] === "FUMIGACION")).toBe(false);
  });

  it("formatea el monto en es-AR y deja vacío lo que no hay", () => {
    const [edesur, seguro] = toPdfTables(sheets)[0].body;
    expect(edesur[0]).toBe("4804882");
    expect(edesur[2]).toMatch(/118\.000/);
    expect(edesur[3]).toBe("edesur.pago");
    expect(seguro[0]).toBe("");
    expect(seguro[2]).toBe("");
    expect(seguro[3]).toBe("");
  });

  it("deja vacías las dos columnas de contacto, para completar a mano", () => {
    for (const fila of toPdfTables(sheets)[0].body) {
      expect(fila[4]).toBe("");
      expect(fila[5]).toBe("");
    }
  });

  it("un edificio sin filas imprimibles no genera tabla", () => {
    const salteadas = [{ ...sheets[0], rows: sheets[0].rows.map((r) => ({ ...r, status: "SKIPPED" as const })) }];
    expect(toPdfTables(salteadas)).toEqual([]);
  });
});

describe("bloque de arrastradas en el PDF", () => {
  const conImpaga: SheetData[] = [
    {
      ...sheets[0],
      carried: [
        {
          invoiceId: "inv-ago",
          facturas: "4804882",
          concepto: "EDESUR S.A.",
          monto: 980000,
          originalAmount: 980000,
          lateAmount: null,
          aliasCbu: ["edesur.pago"],
          fromLabel: "agosto 2026",
          carryOverRequested: false,
          invoiceUrl: null,
        },
      ],
    },
  ];

  it("las arrastradas van en `carried`, no mezcladas en el cuerpo del mes", () => {
    const table = toPdfTables(conImpaga)[0];
    expect(table.body).toHaveLength(2); // los dos gastos del mes
    expect(table.carried).toHaveLength(1);
  });

  it("el concepto lleva el mes de origen", () => {
    const [fila] = toPdfTables(conImpaga)[0].carried;
    expect(fila[1]).toBe("EDESUR S.A. — de agosto 2026");
    expect(fila[2]).toMatch(/980\.000/);
  });

  it("con monto vencido, MONTO lleva el 2° pago y el concepto el 1°", () => {
    const conVencido: SheetData[] = [
      {
        ...conImpaga[0],
        carried: [{ ...conImpaga[0].carried[0], lateAmount: 1050000, monto: 1050000 }],
      },
    ];
    const [fila] = toPdfTables(conVencido)[0].carried;
    expect(fila[1]).toContain("1° pago");
    expect(fila[1]).toMatch(/980\.000/);
    expect(fila[2]).toMatch(/1\.050\.000/);
  });

  it("un edificio sin gastos del mes pero con impagas igual genera hoja", () => {
    const soloImpagas: SheetData[] = [{ ...conImpaga[0], rows: [] }];
    const tables = toPdfTables(soloImpagas);
    expect(tables).toHaveLength(1);
    expect(tables[0].body).toEqual([]);
    expect(tables[0].carried).toHaveLength(1);
  });
});

describe("pdfFileName", () => {
  it("usa el mes mayoritario", () => {
    expect(pdfFileName("julio 2026")).toBe("obligaciones-julio-2026.pdf");
  });

  it("sin mes cae a un nombre genérico", () => {
    expect(pdfFileName(null)).toBe("obligaciones.pdf");
  });

  it("saca acentos y mayúsculas del nombre del archivo", () => {
    expect(pdfFileName("Diciembre 2026")).toBe("obligaciones-diciembre-2026.pdf");
  });
});

describe("adicionales y otras boletas del mes", () => {
  const extra = (invoiceId: string, ordinal: number, monto: number, carriedOutTo: string | null = null) =>
    ({ invoiceId, ordinal, monto, invoiceUrl: null, carryOverRequested: false, carriedOutTo });
  // Intl separa "$" del número con un espacio duro (U+00A0).
  const ars = (n: number) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(n);

  it("una adicional sale indentada debajo de su madre, con el alias de la madre", () => {
    const withExtra = [{
      ...sheets[0],
      rows: [{ ...sheets[0].rows[0], extras: [extra("i2", 2, 54000)] }, sheets[0].rows[1]],
    }];
    const body = toPdfTables(withExtra)[0].body;
    expect(body[0][1]).toBe("EDESUR");
    expect(body[1]).toEqual(["", "   ↳ 2ª boleta", ars(54000), "edesur.pago", "", ""]);
    expect(body[2][1]).toBe("SEGURO LA CAJA");
  });

  it("si la madre está salteada, imprime sólo la adicional con el concepto completo", () => {
    const withExtra = [{
      ...sheets[0],
      rows: [{ ...sheets[0].rows[2], extras: [extra("i9", 2, 1000)] }],
    }];
    const body = toPdfTables(withExtra)[0].body;
    expect(body).toEqual([["", "FUMIGACION — 2ª boleta", ars(1000), "", "", ""]]);
  });

  it("las otras boletas del mes van en su bloque, con la fantasía entre paréntesis", () => {
    const withOthers = [{
      ...sheets[0],
      others: [
        { invoiceId: "o1", facturas: null, concepto: "PLOMERO JUAN", fantasia: "JUAN", monto: 32000,
          aliasCbu: ["juan.plomero"], invoiceUrl: null, carryOverRequested: false, carriedOutTo: null, group: "PROVEEDOR" as const },
        { invoiceId: "o2", facturas: "77", concepto: "AYSA", fantasia: null, monto: 500,
          aliasCbu: [], invoiceUrl: null, carryOverRequested: false, carriedOutTo: null, group: "SERVICIO" as const },
      ],
    }];
    const table = toPdfTables(withOthers)[0];
    expect(table.others).toEqual([
      ["", "PLOMERO JUAN (JUAN)", ars(32000), "juan.plomero", "", ""],
      ["77", "AYSA", ars(500), "", "", ""],
    ]);
    expect(OTHERS_TITLE).toBe("OTRAS BOLETAS DEL MES");
  });

  it("lo que pasó a otro mes no va al papel", () => {
    const moved = [{
      ...sheets[0],
      rows: [{ ...sheets[0].rows[0], extras: [extra("i2", 2, 54000, "agosto 2026")] }],
      others: [{ invoiceId: "o1", facturas: null, concepto: "PLOMERO", fantasia: null, monto: 1,
                 aliasCbu: [], invoiceUrl: null, carryOverRequested: false, carriedOutTo: "agosto 2026", group: "PROVEEDOR" as const }],
    }];
    const table = toPdfTables(moved)[0];
    expect(table.body).toHaveLength(1);
    expect(table.others).toEqual([]);
  });

  it("sin adicionales ni otras, el bloque queda vacío", () => {
    expect(toPdfTables(sheets)[0].others).toEqual([]);
  });
});

describe("sueldos en el papel", () => {
  it("la fila de un empleado sale rotulada 'Empleado' en la columna FACTURA", () => {
    const conSueldo: SheetData[] = [
      {
        ...sheets[0],
        rows: [
          { fixedExpenseId: "fx3", obligationId: "ob3", providerId: "emp", lspServiceId: null,
            facturas: null, concepto: "PEREZ JUAN", fantasia: null, monto: 900000, aliasCbu: [],
            status: "RECEIVED", active: true, invoiceId: "i3", carryOverRequested: false, carriedIn: false,
            invoiceUrl: null, extras: [], group: "EMPLEADO" },
        ],
      },
    ];
    expect(toPdfTables(conSueldo)[0].body[0][0]).toBe("Empleado");
  });
});
