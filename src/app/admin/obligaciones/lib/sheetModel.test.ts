import { describe, expect, it } from "vitest";
import {
  buildSheets,
  columnIndex,
  facturasLabel,
  filterSheets,
  FALLBACK_COLUMN,
  grandTotals,
  groupByRubro,
  hasPrintableRows,
  isItemPrintable,
  isPrintableRow,
  monthOnly,
  NO_RUBRO_TITLE,
  PENDING_MARK,
  printableExtras,
  shortClientNumber,
  showsPendingMark,
  toPrintableSheets,
  type OverviewConsortium,
  type OverviewFixedExpense,
  type OverviewLooseInvoice,
  type OverviewPayload,
} from "./sheetModel";

const payload: OverviewPayload = {
  month: 7,
  year: 2026,
  monthLabel: "julio 2026",
  providers: [
    { id: "p1", canonicalName: "SEGURO LA CAJA", paymentAlias: "seguro.caja", matchNames: null },
    { id: "p2", canonicalName: "TECNOPAS ASC.", paymentAlias: null, matchNames: "TECNOPAS|TECNO PAS ASCENSORES" },
    { id: "p9", canonicalName: "EDESUR S.A.", paymentAlias: "edesur.pago", matchNames: "EDESUR" },
  ],
  consortiums: [
    {
      consortiumId: "c1",
      consortiumName: "FRANKLIN 25",
      bankId: "b1",
      bankName: "Santander",
      bankColor: "red",
      periodId: "per1",
      periodLabel: "julio 2026",
  periodStatus: "ACTIVE",
      lspServices: [
        { id: "l1", providerName: "EDESUR", clientNumber: "4804882", description: null, providerId: "p9" },
      ],
      fixedExpenses: [
        { id: "fx1", providerId: "p1", lspServiceId: null, description: null, kind: "FACTURA", active: true,
          obligation: { id: "ob1", status: "PENDING", amount: null, invoiceId: null, carryOverRequested: false, carriedIn: false, invoiceUrl: null } },
        { id: "fx2", providerId: null, lspServiceId: "l1", description: null, kind: "FACTURA", active: true,
          obligation: { id: "ob2", status: "RECEIVED", amount: 118000, invoiceId: null, carryOverRequested: false, carriedIn: false, invoiceUrl: null } },
        { id: "fx3", providerId: "p2", lspServiceId: null, description: null, kind: "FACTURA", active: false,
          obligation: null },
      ],
    },
    {
      consortiumId: "c2",
      consortiumName: "ARENALES 2154",
      bankId: null,
      bankName: null,
      bankColor: null,
      periodId: null,
      periodLabel: null,
  periodStatus: "ACTIVE",
      lspServices: [],
      fixedExpenses: [
        { id: "fx4", providerId: "p1", lspServiceId: null, description: null, kind: "FACTURA", active: true, obligation: null },
      ],
    },
  ],
};

describe("buildSheets", () => {
  it("arma una hoja por consorcio con banco y período", () => {
    const sheets = buildSheets(payload);
    expect(sheets).toHaveLength(2);
    const franklin = sheets.find((s) => s.consortiumId === "c1")!;
    expect(franklin.bankName).toBe("Santander");
    expect(franklin.periodLabel).toBe("julio 2026");
  });

  it("pone el número de cliente sólo en las filas LSP", () => {
    const rows = buildSheets(payload)[0].rows;
    const edesur = rows.find((r) => r.fixedExpenseId === "fx2")!;
    const seguro = rows.find((r) => r.fixedExpenseId === "fx1")!;
    expect(edesur.facturas).toBe("4804882");
    expect(seguro.facturas).toBeNull();
  });

  it("expone la URL del PDF de la boleta vinculada, y null si no llegó", () => {
    const withUrl: OverviewPayload = {
      ...payload,
      consortiums: [{
        ...payload.consortiums[0],
        fixedExpenses: [
          { id: "fx1", providerId: "p1", lspServiceId: null, description: null, kind: "FACTURA", active: true,
            obligation: { id: "ob1", status: "RECEIVED", amount: 5000, invoiceId: "inv1", carryOverRequested: false, carriedIn: false,
              invoiceUrl: "https://drive.google.com/file/d/ABC/view" } },
          { id: "fx2", providerId: null, lspServiceId: "l1", description: null, kind: "FACTURA", active: true,
            obligation: { id: "ob2", status: "PENDING", amount: null, invoiceId: null, carryOverRequested: false, carriedIn: false, invoiceUrl: null } },
        ],
      }],
    };
    const rows = buildSheets(withUrl)[0].rows;
    expect(rows.find((r) => r.fixedExpenseId === "fx1")?.invoiceUrl).toBe("https://drive.google.com/file/d/ABC/view");
    expect(rows.find((r) => r.fixedExpenseId === "fx2")?.invoiceUrl).toBeNull();
  });

  it("toma el monto de la boleta vinculada y lo deja null si no llegó", () => {
    const rows = buildSheets(payload)[0].rows;
    expect(rows.find((r) => r.fixedExpenseId === "fx2")!.monto).toBe(118000);
    expect(rows.find((r) => r.fixedExpenseId === "fx1")!.monto).toBeNull();
  });

  it("resuelve el alias: del proveedor, y para un LSP el de su proveedor asociado", () => {
    const rows = buildSheets(payload)[0].rows;
    expect(rows.find((r) => r.fixedExpenseId === "fx1")!.aliasCbu).toEqual(["seguro.caja"]);
    expect(rows.find((r) => r.fixedExpenseId === "fx2")!.aliasCbu).toEqual(["edesur.pago"]);
    expect(rows.find((r) => r.fixedExpenseId === "fx3")!.aliasCbu).toEqual([]);
  });

  it("parte los alias del proveedor en lista, con tope de 3", () => {
    const conVarios: OverviewPayload = {
      ...payload,
      providers: payload.providers.map((p) =>
        p.id === "p1" ? { ...p, paymentAlias: "uno|dos|tres|cuatro" } : p
      ),
    };
    const rows = buildSheets(conVarios)[0].rows;
    expect(rows.find((r) => r.fixedExpenseId === "fx1")!.aliasCbu).toEqual(["uno", "dos", "tres"]);
  });

  it("expone el nombre de fantasía del proveedor (primer valor de matchNames), y nada si no tiene", () => {
    const rows = buildSheets(payload)[0].rows;
    expect(rows.find((r) => r.fixedExpenseId === "fx3")!.fantasia).toBe("TECNOPAS");
    expect(rows.find((r) => r.fixedExpenseId === "fx1")!.fantasia).toBeNull();
  });

  it("una fila LSP no lleva nombre de fantasía: el concepto ya es el nombre corto del servicio", () => {
    const rows = buildSheets(payload)[0].rows;
    expect(rows.find((r) => r.fixedExpenseId === "fx2")!.fantasia).toBeNull();
  });

  it("ignora un matchNames vacío o de puros separadores", () => {
    const vacio: OverviewPayload = {
      ...payload,
      providers: payload.providers.map((p) => (p.id === "p2" ? { ...p, matchNames: " | " } : p)),
    };
    expect(buildSheets(vacio)[0].rows.find((r) => r.fixedExpenseId === "fx3")!.fantasia).toBeNull();
  });

  it("un gasto fijo RETENCION se llama '<razón social> — Retención' (spec 2026-09-17)", () => {
    const sheets = buildSheets({
      ...payload,
      consortiums: [{
        ...payload.consortiums[0],
        fixedExpenses: [
          ...payload.consortiums[0].fixedExpenses,
          { id: "fx-ret", providerId: "p1", lspServiceId: null, description: null, kind: "RETENCION", active: true, obligation: null },
        ],
      }],
    });
    const conceptos = sheets[0].rows.map((r) => r.concepto);
    expect(conceptos).toContain("SEGURO LA CAJA — Retención");
    // la factura del mismo proveedor sigue con su nombre pelado
    expect(conceptos).toContain("SEGURO LA CAJA");
  });

  it("sin obligación pero con período, la fila queda PENDING y sin obligationId", () => {
    const rows = buildSheets(payload)[0].rows;
    const inactiva = rows.find((r) => r.fixedExpenseId === "fx3")!;
    expect(inactiva.status).toBe("PENDING");
    expect(inactiva.obligationId).toBeNull();
    expect(inactiva.active).toBe(false);
  });

  it("sin período activo la fila queda NO_PERIOD", () => {
    const arenales = buildSheets(payload).find((s) => s.consortiumId === "c2")!;
    expect(arenales.periodLabel).toBeNull();
    expect(arenales.rows[0].status).toBe("NO_PERIOD");
  });

  it("ordena las hojas por banco y deja 'Sin banco' al final", () => {
    const sheets = buildSheets(payload);
    expect(sheets.map((s) => s.bankName)).toEqual(["Santander", "Sin banco"]);
  });

  it("un consorcio sin gastos fijos da una hoja con cero filas", () => {
    const sheets = buildSheets({
      ...payload,
      consortiums: [{ ...payload.consortiums[1], fixedExpenses: [] }],
    });
    expect(sheets[0].rows).toEqual([]);
  });
});

describe("filterSheets", () => {
  it("sin query devuelve todo", () => {
    expect(filterSheets(buildSheets(payload), "")).toHaveLength(2);
  });

  it("matchea por nombre de edificio", () => {
    const out = filterSheets(buildSheets(payload), "franklin");
    expect(out.map((s) => s.consortiumId)).toEqual(["c1"]);
  });

  it("matchea por concepto y recorta las filas de esa hoja", () => {
    const out = filterSheets(buildSheets(payload), "edesur");
    expect(out).toHaveLength(1);
    expect(out[0].rows.map((r) => r.fixedExpenseId)).toEqual(["fx2"]);
  });

  it("matchea por banco sin recortar filas", () => {
    const out = filterSheets(buildSheets(payload), "santander");
    expect(out).toHaveLength(1);
    expect(out[0].rows).toHaveLength(3);
  });
});

describe("toPrintableSheets", () => {
  const base = buildSheets(payload);

  it("descarta las filas salteadas", () => {
    const conSalteada = base.map((s) =>
      s.consortiumId === "c1"
        ? { ...s, rows: s.rows.map((r) => (r.fixedExpenseId === "fx1" ? { ...r, status: "SKIPPED" as const } : r)) }
        : s
    );
    const out = toPrintableSheets(conSalteada);
    const franklin = out.find((s) => s.consortiumId === "c1")!;
    expect(franklin.rows.map((r) => r.fixedExpenseId)).not.toContain("fx1");
  });

  it("descarta los gastos desactivados", () => {
    const out = toPrintableSheets(base);
    const franklin = out.find((s) => s.consortiumId === "c1")!;
    // fx3 está `active: false` en el payload de arriba.
    expect(franklin.rows.map((r) => r.fixedExpenseId)).not.toContain("fx3");
  });

  it("descarta los edificios sin período activo", () => {
    // c2 (ARENALES) no tiene período: sus filas son NO_PERIOD.
    expect(toPrintableSheets(base).map((s) => s.consortiumId)).not.toContain("c2");
  });

  it("descarta los edificios que quedan sin ninguna fila imprimible", () => {
    const todoDesactivado = base.map((s) => ({ ...s, rows: s.rows.map((r) => ({ ...r, active: false })) }));
    expect(toPrintableSheets(todoDesactivado)).toEqual([]);
  });

  it("conserva el orden y los datos de las filas que sí van", () => {
    const out = toPrintableSheets(base);
    expect(out).toHaveLength(1);
    expect(out[0].consortiumName).toBe("FRANKLIN 25");
    expect(out[0].bankName).toBe("Santander");
    expect(out[0].rows.map((r) => r.fixedExpenseId)).toEqual(["fx2", "fx1"]);
  });

  it("no muta las hojas de entrada", () => {
    const antes = JSON.stringify(base);
    toPrintableSheets(base);
    expect(JSON.stringify(base)).toBe(antes);
  });
});

describe("impagas de meses anteriores", () => {
  const impaga = {
    invoiceId: "inv-ago",
    concepto: "EDESUR S.A.",
    facturas: "4804882",
    aliasCbu: "edesur.pago",
    originalAmount: 980000,
    lateAmount: null,
    fromLabel: "agosto 2026",
    carryOverRequested: false,
  };

  const conImpaga: OverviewPayload = {
    ...payload,
    consortiums: [
      { ...payload.consortiums[0], carried: [impaga] },
      payload.consortiums[1],
    ],
  };

  it("no se mezclan con las filas de gastos fijos: viajan en `carried`", () => {
    const sheet = buildSheets(conImpaga)[0];
    expect(sheet.rows.some((r) => r.monto === 980000)).toBe(false);
    expect(sheet.carried).toHaveLength(1);
    expect(sheet.carried[0].fromLabel).toBe("agosto 2026");
    expect(sheet.carried[0].facturas).toBe("4804882");
  });

  it("el monto a pagar es el de la boleta mientras no haya 2° vencimiento", () => {
    expect(buildSheets(conImpaga)[0].carried[0].monto).toBe(980000);
  });

  it("con monto vencido cargado, ese es el monto a pagar y conserva el 1° pago", () => {
    const conVencido: OverviewPayload = {
      ...conImpaga,
      consortiums: [
        { ...conImpaga.consortiums[0], carried: [{ ...impaga, lateAmount: 1050000 }] },
        conImpaga.consortiums[1],
      ],
    };
    const fila = buildSheets(conVencido)[0].carried[0];
    expect(fila.monto).toBe(1050000);
    expect(fila.originalAmount).toBe(980000);
  });

  it("se ordenan alfabéticamente por concepto", () => {
    // Todas vienen del mes anterior, así que ordenar por período de origen dejó
    // de significar algo: lo útil es encontrarlas por nombre.
    const dos: OverviewPayload = {
      ...conImpaga,
      consortiums: [
        {
          ...conImpaga.consortiums[0],
          carried: [
            { ...impaga, invoiceId: "z", concepto: "ZETA SRL" },
            { ...impaga, invoiceId: "a", concepto: "ALFA SRL" },
          ],
        },
        conImpaga.consortiums[1],
      ],
    };
    expect(buildSheets(dos)[0].carried.map((c) => c.invoiceId)).toEqual(["a", "z"]);
  });

  it("un edificio sin arrastradas trae el bloque vacío", () => {
    expect(buildSheets(payload)[0].carried).toEqual([]);
  });

  it("toPrintableSheets conserva un edificio que sólo tiene arrastradas", () => {
    const soloImpagas: OverviewPayload = {
      ...conImpaga,
      consortiums: [
        { ...conImpaga.consortiums[0], fixedExpenses: [] },
        conImpaga.consortiums[1],
      ],
    };
    const out = toPrintableSheets(buildSheets(soloImpagas));
    expect(out).toHaveLength(1);
    expect(out[0].rows).toEqual([]);
    expect(out[0].carried).toHaveLength(1);
  });
});

describe("isPrintableRow / hasPrintableRows", () => {
  const [row] = buildSheets(payload)[0].rows;

  it("una fila activa y no salteada se imprime", () => {
    expect(isPrintableRow(row)).toBe(true);
  });

  it("una salteada o una desactivada, no", () => {
    expect(isPrintableRow({ ...row, status: "SKIPPED" })).toBe(false);
    expect(isPrintableRow({ ...row, active: false })).toBe(false);
  });

  it("una fila sin período no se imprime", () => {
    expect(isPrintableRow({ ...row, status: "NO_PERIOD" })).toBe(false);
  });

  it("una fila cuya boleta pasó a otro mes (CARRIED_OVER) no se imprime", () => {
    expect(isPrintableRow({ ...row, status: "CARRIED_OVER", carriedOutTo: "agosto 2026" })).toBe(false);
  });

  it("hasPrintableRows resume la hoja entera", () => {
    expect(hasPrintableRows(buildSheets(payload)[0])).toBe(true);
    expect(hasPrintableRows({ ...buildSheets(payload)[0], rows: [] })).toBe(false);
  });
});

describe("boletas adicionales y otras del mes", () => {
  const loose = (over: Partial<OverviewLooseInvoice> & { invoiceId: string }): OverviewLooseInvoice => ({
    providerId: null, lspServiceId: null, docKind: "FACTURA",
    concepto: "X", matchNames: null, facturas: null, aliasCbu: null,
    amount: 1000, invoiceUrl: null, carryOverRequested: false,
    createdAt: "2026-07-10T00:00:00.000Z", carriedOutTo: null,
    ...over,
  });
  const withLoose = (items: OverviewLooseInvoice[]): OverviewPayload => ({
    ...payload,
    consortiums: [{ ...payload.consortiums[0], looseInvoices: items }, payload.consortiums[1]],
  });

  it("una boleta suelta del proveedor de un gasto fijo activo cuelga de su fila como adicional", () => {
    const sheet = buildSheets(withLoose([
      loose({ invoiceId: "i2", providerId: "p1", amount: 500, invoiceUrl: "https://d/2", concepto: "SEGURO LA CAJA" }),
    ]))[0];
    const seguro = sheet.rows.find((r) => r.fixedExpenseId === "fx1")!;
    expect(seguro.extras).toEqual([
      { invoiceId: "i2", facturas: null, monto: 500, invoiceUrl: "https://d/2", carryOverRequested: false, carriedOutTo: null,
        rubroId: null, coeficienteId: null },
    ]);
    expect(sheet.others).toEqual([]);
  });

  it("matchea por LSP: una 2ª boleta de EDESUR con el mismo servicio cuelga de la fila del servicio", () => {
    const sheet = buildSheets(withLoose([
      loose({ invoiceId: "i3", lspServiceId: "l1", providerId: "p9", concepto: "EDESUR S.A.", facturas: "4804882" }),
    ]))[0];
    expect(sheet.rows.find((r) => r.fixedExpenseId === "fx2")!.extras.map((e) => e.invoiceId)).toEqual(["i3"]);
    expect(sheet.others).toEqual([]);
  });

  it("una RETENCION no cuelga de la fila FACTURA del mismo proveedor: va a otras", () => {
    const sheet = buildSheets(withLoose([
      loose({ invoiceId: "i4", providerId: "p1", docKind: "RETENCION", concepto: "SEGURO LA CAJA" }),
    ]))[0];
    expect(sheet.rows.find((r) => r.fixedExpenseId === "fx1")!.extras).toEqual([]);
    expect(sheet.others.map((o) => o.invoiceId)).toEqual(["i4"]);
  });

  it("ordena las extras por fecha de carga", () => {
    const sheet = buildSheets(withLoose([
      loose({ invoiceId: "tarde", providerId: "p1", createdAt: "2026-07-20T00:00:00.000Z" }),
      loose({ invoiceId: "temprano", providerId: "p1", createdAt: "2026-07-05T00:00:00.000Z" }),
    ]))[0];
    const extras = sheet.rows.find((r) => r.fixedExpenseId === "fx1")!.extras;
    expect(extras.map((e) => e.invoiceId)).toEqual(["temprano", "tarde"]);
  });

  it("una boleta de un proveedor sin gasto fijo va a 'otras' con concepto, fantasía, alias y nro. de cliente", () => {
    const sheet = buildSheets(withLoose([
      loose({ invoiceId: "i5", providerId: "pZ", concepto: "PLOMERO JUAN", matchNames: "JUAN|EL PLOMERO",
              aliasCbu: "juan.plomero|0000003100012345678901", facturas: null, amount: 32000, invoiceUrl: "https://d/5" }),
    ]))[0];
    expect(sheet.others).toEqual([{
      invoiceId: "i5", facturas: null, concepto: "PLOMERO JUAN", fantasia: "JUAN", monto: 32000,
      aliasCbu: ["juan.plomero", "0000003100012345678901"], invoiceUrl: "https://d/5",
      carryOverRequested: false, carriedOutTo: null, group: "PROVEEDOR",
      rubroId: null, coeficienteId: null,
    }]);
  });

  it("una boleta de un gasto fijo DESACTIVADO va a 'otras', no a la tabla plegada", () => {
    const sheet = buildSheets(withLoose([
      loose({ invoiceId: "i6", providerId: "p2", concepto: "TECNOPAS ASC." }),
    ]))[0];
    expect(sheet.rows.find((r) => r.fixedExpenseId === "fx3")!.extras).toEqual([]);
    expect(sheet.others.map((o) => o.invoiceId)).toEqual(["i6"]);
  });

  it("'otras' se ordena alfabéticamente por concepto", () => {
    const sheet = buildSheets(withLoose([
      loose({ invoiceId: "b", providerId: "pB", concepto: "ZETA SRL" }),
      loose({ invoiceId: "a", providerId: "pA", concepto: "ALFA SA" }),
    ]))[0];
    expect(sheet.others.map((o) => o.concepto)).toEqual(["ALFA SA", "ZETA SRL"]);
  });

  it("propaga carriedOutTo en extras y en otras", () => {
    const sheet = buildSheets(withLoose([
      loose({ invoiceId: "e", providerId: "p1", carriedOutTo: "agosto 2026" }),
      loose({ invoiceId: "o", providerId: "pZ", concepto: "PLOMERO", carriedOutTo: "agosto 2026" }),
    ]))[0];
    expect(sheet.rows.find((r) => r.fixedExpenseId === "fx1")!.extras[0].carriedOutTo).toBe("agosto 2026");
    expect(sheet.others[0].carriedOutTo).toBe("agosto 2026");
  });

  it("una madre SKIPPED conserva sus extras", () => {
    const skipped: OverviewPayload = {
      ...payload,
      consortiums: [{
        ...payload.consortiums[0],
        fixedExpenses: payload.consortiums[0].fixedExpenses.map((fx) =>
          fx.id === "fx1" ? { ...fx, obligation: { ...fx.obligation!, status: "SKIPPED" as const } } : fx
        ),
        looseInvoices: [loose({ invoiceId: "i7", providerId: "p1" })],
      }, payload.consortiums[1]],
    };
    const row = buildSheets(skipped)[0].rows.find((r) => r.fixedExpenseId === "fx1")!;
    expect(row.status).toBe("SKIPPED");
    expect(row.extras.map((e) => e.invoiceId)).toEqual(["i7"]);
  });

  it("sin boletas sueltas, extras y otras quedan vacías", () => {
    const sheet = buildSheets(payload)[0];
    expect(sheet.rows.every((r) => r.extras.length === 0)).toBe(true);
    expect(sheet.others).toEqual([]);
  });
});

describe("imprimibles con extras y otras", () => {
  const base = buildSheets(payload)[0];
  const extra = (invoiceId: string, carriedOutTo: string | null = null) =>
    ({ invoiceId, facturas: null, monto: 100, invoiceUrl: null, carryOverRequested: false, carriedOutTo });
  const other = (invoiceId: string, carriedOutTo: string | null = null) =>
    ({ invoiceId, facturas: null, concepto: "PLOMERO", fantasia: null, monto: 100, aliasCbu: [],
       invoiceUrl: null, carryOverRequested: false, carriedOutTo, group: "PROVEEDOR" as const });

  it("printableExtras deja afuera las que pasaron a otro mes", () => {
    const row = { ...base.rows[1], extras: [extra("a"), extra("b", "agosto 2026")] };
    expect(printableExtras(row).map((e) => e.invoiceId)).toEqual(["a"]);
  });

  it("hasPrintableRows: un edificio con todo salteado pero con una extra o una otra se imprime", () => {
    const todoSalteado = { ...base, rows: base.rows.map((r) => ({ ...r, status: "SKIPPED" as const })) };
    expect(hasPrintableRows(todoSalteado)).toBe(false);
    expect(hasPrintableRows({ ...todoSalteado, rows: [{ ...todoSalteado.rows[1], extras: [extra("a")] }] })).toBe(true);
    expect(hasPrintableRows({ ...todoSalteado, others: [other("o")] })).toBe(true);
    expect(hasPrintableRows({ ...todoSalteado, others: [other("o", "agosto 2026")] })).toBe(false);
  });

  it("toPrintableSheets conserva una madre salteada que tiene extras, recorta las extras que pasaron y limpia otras", () => {
    const sheet = {
      ...base,
      rows: base.rows.map((r) =>
        r.fixedExpenseId === "fx1" ? { ...r, status: "SKIPPED" as const, extras: [extra("a"), extra("b", "agosto 2026")] } : r
      ),
      others: [other("o1"), other("o2", "agosto 2026")],
    };
    const out = toPrintableSheets([sheet])[0];
    const madre = out.rows.find((r) => r.fixedExpenseId === "fx1")!;
    expect(madre.status).toBe("SKIPPED");
    expect(madre.extras.map((e) => e.invoiceId)).toEqual(["a"]);
    expect(out.others.map((o) => o.invoiceId)).toEqual(["o1"]);
  });

  it("isItemPrintable: mismo criterio que toPrintableSheets, por ítem de sección", () => {
    const salteada = { ...base.rows[1], status: "SKIPPED" as const };
    expect(isItemPrintable({ kind: "row", row: base.rows[1] })).toBe(isPrintableRow(base.rows[1]));
    // Madre salteada: sólo si le queda alguna adicional que vive en este mes.
    expect(isItemPrintable({ kind: "row", row: { ...salteada, extras: [] } })).toBe(false);
    expect(isItemPrintable({ kind: "row", row: { ...salteada, extras: [extra("b", "agosto 2026")] } })).toBe(false);
    expect(isItemPrintable({ kind: "row", row: { ...salteada, extras: [extra("a")] } })).toBe(true);
    expect(isItemPrintable({ kind: "extra", row: salteada, extra: extra("a") })).toBe(true);
    expect(isItemPrintable({ kind: "extra", row: salteada, extra: extra("b", "agosto 2026") })).toBe(false);
    expect(isItemPrintable({ kind: "other", other: other("o") })).toBe(true);
    expect(isItemPrintable({ kind: "other", other: other("o", "agosto 2026") })).toBe(false);
  });

  it("toPrintableSheets conserva un edificio que sólo tiene otras", () => {
    const sheet = { ...base, rows: base.rows.map((r) => ({ ...r, status: "SKIPPED" as const })), others: [other("o")] };
    expect(toPrintableSheets([sheet])).toHaveLength(1);
  });

  it("filterSheets encuentra por concepto en otras", () => {
    const sheet = { ...base, others: [other("o")] };
    const out = filterSheets([sheet], "plomero");
    expect(out).toHaveLength(1);
    expect(out[0].rows).toEqual([]);
    expect(out[0].others.map((o) => o.invoiceId)).toEqual(["o"]);
  });
});

describe("grupo de la fila", () => {
  const fx = (id: string, over: Partial<OverviewPayload["consortiums"][0]["fixedExpenses"][0]> = {}) => ({
    id, providerId: null, lspServiceId: null, description: null, kind: "FACTURA" as const, active: true,
    obligation: { id: `ob-${id}`, status: "PENDING" as const, amount: null, invoiceId: null,
      carryOverRequested: false, carriedIn: false, invoiceUrl: null },
    ...over,
  });
  const recibida = (id: string, over: Partial<OverviewPayload["consortiums"][0]["fixedExpenses"][0]> = {}) =>
    fx(id, { ...over, obligation: { id: `ob-${id}`, status: "RECEIVED", amount: 100, invoiceId: `inv-${id}`,
      carryOverRequested: false, carriedIn: false, invoiceUrl: null } });
  const base: OverviewPayload = {
    ...payload,
    providers: [
      { id: "emp", canonicalName: "PEREZ JUAN", paymentAlias: null, matchNames: null, providerType: "EMPLEADO" },
      { id: "prov-a", canonicalName: "ALFA SRL", paymentAlias: null, matchNames: null, providerType: "PROVEEDOR" },
      { id: "prov-z", canonicalName: "ZETA SA", paymentAlias: null, matchNames: null, providerType: "PROVEEDOR" },
      { id: "p9", canonicalName: "EDESUR S.A.", paymentAlias: null, matchNames: null, providerType: "SERVICIO" },
    ],
    consortiums: [{
      ...payload.consortiums[0],
      fixedExpenses: [
        fx("pend-prov", { providerId: "prov-a" }),
        recibida("rec-prov-z", { providerId: "prov-z" }),
        fx("pend-lsp", { lspServiceId: "l1" }),
        recibida("rec-emp", { providerId: "emp" }),
        fx("skipped", { providerId: "prov-z", obligation: { id: "ob-s", status: "SKIPPED", amount: null, invoiceId: null,
          carryOverRequested: false, carriedIn: false, invoiceUrl: null } }),
        recibida("rec-lsp", { lspServiceId: "l1" }),
        fx("inactivo", { providerId: "emp", active: false }),
        recibida("rec-prov-a", { providerId: "prov-a" }),
        fx("pend-emp", { providerId: "emp" }),
      ],
    }],
  };

  it("cada fila dice su grupo", () => {
    const rows = buildSheets(base)[0].rows;
    const g = (id: string) => rows.find((r) => r.fixedExpenseId === id)!.group;
    expect(g("rec-emp")).toBe("EMPLEADO");
    expect(g("rec-lsp")).toBe("SERVICIO");
    expect(g("rec-prov-a")).toBe("PROVEEDOR");
  });

  it("un proveedor sin providerType cuenta como PROVEEDOR", () => {
    expect(buildSheets(payload)[0].rows.find((r) => r.fixedExpenseId === "fx1")!.group).toBe("PROVEEDOR");
  });
});

describe("shortClientNumber", () => {
  it("deja pasar los cortos y recorta los largos con puntos suspensivos", () => {
    expect(shortClientNumber(null)).toBeNull();
    expect(shortClientNumber("4804882")).toBe("4804882");
    expect(shortClientNumber("00003-00001234")).toBe("00003-00001234");
    expect(shortClientNumber("123456789012345")).toBe("12345678901234…");
    expect(shortClientNumber("1234567890123", 5)).toBe("12345…");
  });
});

describe("facturasLabel", () => {
  it("rotula 'Empleado' la fila de un sueldo, que nunca trae nro. de cliente", () => {
    expect(facturasLabel({ facturas: null, group: "EMPLEADO" })).toBe("Empleado");
  });

  it("deja el nro. de cliente cuando lo hay y vacía el resto", () => {
    expect(facturasLabel({ facturas: "4804882", group: "SERVICIO" })).toBe("4804882");
    expect(facturasLabel({ facturas: null, group: "SERVICIO" })).toBeNull();
    expect(facturasLabel({ facturas: null, group: "PROVEEDOR" })).toBeNull();
  });
});

describe("agrupado por rubro (spec 2026-09-24, Parte 2)", () => {
  type Ob = NonNullable<OverviewFixedExpense["obligation"]>;
  const ob = (id: string, over: Partial<Ob> = {}): Ob => ({
    id: `ob-${id}`, status: "PENDING", amount: null, invoiceId: null,
    carryOverRequested: false, carriedIn: false, invoiceUrl: null, ...over,
  });
  const recibida = (id: string, amount: number, over: Partial<Ob> = {}): Ob =>
    ob(id, { status: "RECEIVED", amount, invoiceId: `inv-${id}`, ...over });
  const fx = (id: string, over: Partial<OverviewFixedExpense> = {}): OverviewFixedExpense => ({
    id, providerId: null, lspServiceId: null, description: id.toUpperCase(), kind: "FACTURA",
    active: true, rubroId: null, coeficienteId: null, obligation: ob(id), ...over,
  });

  const conRubros = (fixedExpenses: OverviewFixedExpense[], extra: Partial<OverviewConsortium> = {}): OverviewPayload => ({
    ...payload,
    providers: [],
    consortiums: [{
      ...payload.consortiums[0],
      lspServices: [],
      rubros: [
        { id: "r4", order: 4, name: "ABONOS DE SERVICIOS" },
        { id: "r3", order: 3, name: "SERVICIOS PÚBLICOS" },
        { id: "rx", order: null, name: "VARIOS" },
      ],
      coeficientes: [{ id: "cB", code: "B" }, { id: "cA", code: "A" }],
      fixedExpenses,
      ...extra,
    }],
  });
  const sheetOf = (p: OverviewPayload) => buildSheets(p)[0];

  it("FACTURA/NRO CLIENTE: nro. de la factura del mes en un proveedor, nro. de cliente en un servicio", () => {
    const s = sheetOf(conRubros([fx("a", { providerId: "p1", obligation: recibida("a", 10, { invoiceBoletaNumber: "0003-00001234" }) })]));
    expect(s.rows[0].facturas).toBe("0003-00001234");
    const lsp = buildSheets({
      ...payload,
      consortiums: [{ ...payload.consortiums[0], fixedExpenses: [{ ...payload.consortiums[0].fixedExpenses[1],
        obligation: { ...payload.consortiums[0].fixedExpenses[1].obligation!, invoiceBoletaNumber: "B-999" } }] }],
    })[0];
    expect(lsp.rows[0].facturas).toBe("4804882");
  });

  it("una adicional con coeficiente propio suma en esa columna, no en la de su madre", () => {
    const s = sheetOf(conRubros([fx("a", { rubroId: "r3", coeficienteId: "cB", obligation: recibida("a", 100) })]));
    const conExtra = { ...s, rows: [{ ...s.rows[0], extras: [
      { invoiceId: "e1", facturas: null, monto: 5, invoiceUrl: null, carryOverRequested: false, carriedOutTo: null, coeficienteId: "cA" },
    ] }] };
    expect(groupByRubro(conExtra)[0].totals).toEqual([5, 100]);
  });

  it("una adicional con otro rubro que su madre va suelta a esa sección, con el nombre de la madre", () => {
    const s = sheetOf(conRubros([fx("a", { rubroId: "r3", coeficienteId: "cB", obligation: recibida("a", 100) })]));
    const extra = { invoiceId: "e1", facturas: null, monto: 5, invoiceUrl: null, carryOverRequested: false, carriedOutTo: null, rubroId: "r4" };
    const conExtra = { ...s, rows: [{ ...s.rows[0], extras: [extra] }] };
    const sections = groupByRubro(conExtra);
    const r3 = sections.find((x) => x.rubroId === "r3")!;
    const r4 = sections.find((x) => x.rubroId === "r4")!;
    expect(r3.items).toHaveLength(1);
    expect(r3.items[0].kind === "row" && r3.items[0].row.extras).toEqual([]);
    expect(r3.totals).toEqual([0, 100]);
    expect(r4.items).toEqual([{ kind: "extra", row: conExtra.rows[0], extra }]);
    // Sin coeficiente propio hereda el de la madre (B).
    expect(r4.totals).toEqual([0, 5]);
  });

  it("expone los rubros por número (los sin número al final) y las columnas por código", () => {
    const s = sheetOf(conRubros([]));
    expect(s.rubros.map((r) => r.id)).toEqual(["r3", "r4", "rx"]);
    expect(s.coefColumns).toEqual([{ id: "cA", code: "A" }, { id: "cB", code: "B" }]);
  });

  it("sin coeficientes asignados usa la columna única MONTO", () => {
    expect(sheetOf(conRubros([], { coeficientes: [] })).coefColumns).toEqual([FALLBACK_COLUMN]);
    expect(FALLBACK_COLUMN.code).toBe("MONTO");
  });

  it("la etiqueta de la boleta manda; si no tiene, vale la del gasto fijo", () => {
    const s = sheetOf(conRubros([
      fx("a", { rubroId: "r3", coeficienteId: "cA", obligation: recibida("a", 10, { invoiceRubroId: "r4", invoiceCoeficienteId: "cB" }) }),
      fx("b", { rubroId: "r3", coeficienteId: "cA", obligation: recibida("b", 10) }),
    ]));
    const a = s.rows.find((r) => r.fixedExpenseId === "a")!;
    const b = s.rows.find((r) => r.fixedExpenseId === "b")!;
    expect([a.rubroId, a.coeficienteId]).toEqual(["r4", "cB"]);
    expect([b.rubroId, b.coeficienteId]).toEqual(["r3", "cA"]);
  });

  it("una sección por rubro asignado, en orden, aunque esté vacía, con totales en cero", () => {
    const sections = groupByRubro(sheetOf(conRubros([fx("a", { rubroId: "r3" })])));
    expect(sections.map((x) => x.title)).toEqual(["3 SERVICIOS PÚBLICOS", "4 ABONOS DE SERVICIOS", "VARIOS"]);
    expect(sections[1].items).toEqual([]);
    expect(sections[1].totals).toEqual([0, 0]);
    expect(sections.map((x) => x.totalLabel)).toEqual(["TOTAL RUBRO 3", "TOTAL RUBRO 4", "TOTAL VARIOS"]);
  });

  it("'Sin rubro' va al final con lo que no tiene rubro o tiene uno que el edificio no usa", () => {
    const sections = groupByRubro(sheetOf(conRubros([
      fx("a", { rubroId: "r3" }), fx("b"), fx("c", { rubroId: "r-ajeno" }),
    ])));
    const sin = sections[sections.length - 1];
    expect(sin.rubroId).toBeNull();
    expect(sin.title).toBe(NO_RUBRO_TITLE);
    expect(sin.items.map((i) => i.kind === "row" && i.row.fixedExpenseId)).toEqual(["b", "c"]);
  });

  it("sin nada sin rubro, no hay sección 'Sin rubro'", () => {
    const sections = groupByRubro(sheetOf(conRubros([fx("a", { rubroId: "r3" })])));
    expect(sections.some((x) => x.rubroId === null)).toBe(false);
  });

  it("dentro del rubro: con boleta, después pendientes, después salteadas; alfabético en cada tramo", () => {
    const sections = groupByRubro(sheetOf(conRubros([
      fx("zeta-pend", { rubroId: "r3" }),
      fx("beta-rec", { rubroId: "r3", obligation: recibida("beta-rec", 1) }),
      fx("alfa-salt", { rubroId: "r3", obligation: ob("alfa-salt", { status: "SKIPPED" }) }),
      fx("alfa-pend", { rubroId: "r3" }),
    ])));
    expect(sections[0].items.map((i) => i.kind === "row" && i.row.fixedExpenseId))
      .toEqual(["beta-rec", "alfa-pend", "zeta-pend", "alfa-salt"]);
  });

  it("los desactivados no entran en ninguna sección", () => {
    const sections = groupByRubro(sheetOf(conRubros([fx("a", { rubroId: "r3", active: false })])));
    expect(sections.flatMap((x) => x.items)).toEqual([]);
  });

  it("totaliza por columna; sin coeficiente va a la primera; las adicionales suman en la columna de la madre", () => {
    const p = conRubros([
      fx("a", { rubroId: "r3", coeficienteId: "cB", obligation: recibida("a", 100) }),
      fx("b", { rubroId: "r3", obligation: recibida("b", 50) }),
    ], {
      looseInvoices: [{
        invoiceId: "extra", providerId: null, lspServiceId: null, docKind: "FACTURA", concepto: "A",
        matchNames: null, facturas: null, aliasCbu: null, amount: 7, invoiceUrl: null,
        carryOverRequested: false, createdAt: "2026-07-01T00:00:00.000Z", carriedOutTo: null,
      }],
    });
    // La boleta suelta no matchea ningún gasto fijo (no tienen proveedor): es eventual, sin rubro.
    const sections = groupByRubro(sheetOf(p));
    expect(sections[0].totals).toEqual([50, 100]);
    const sinRubro = sections[sections.length - 1];
    expect(sinRubro.rubroId).toBeNull();
    expect(sinRubro.totals).toEqual([7, 0]);

    const s = sheetOf(conRubros([fx("a", { rubroId: "r3", coeficienteId: "cB", obligation: recibida("a", 100) })]));
    const conExtra = { ...s, rows: [{ ...s.rows[0], extras: [
      { invoiceId: "e1", facturas: null, monto: 5, invoiceUrl: null, carryOverRequested: false, carriedOutTo: null },
      { invoiceId: "e2", facturas: null, monto: 9, invoiceUrl: null, carryOverRequested: false, carriedOutTo: "agosto 2026" },
    ] }] };
    expect(groupByRubro(conExtra)[0].totals).toEqual([0, 105]);
  });

  it("una eventual con carriedOutTo (pasó a otro mes) no suma en el total de su sección", () => {
    const p = conRubros([], {
      looseInvoices: [{
        invoiceId: "o2", providerId: "p-x", lspServiceId: null, docKind: "FACTURA", concepto: "PLOMERO",
        matchNames: null, facturas: null, aliasCbu: null, amount: 30, invoiceUrl: null,
        carryOverRequested: false, createdAt: "2026-07-01T00:00:00.000Z", carriedOutTo: "agosto 2026",
        rubroId: "r4", coeficienteId: "cA",
      }],
    });
    const r4 = groupByRubro(sheetOf(p)).find((x) => x.rubroId === "r4")!;
    expect(r4.items).toHaveLength(1);
    expect(r4.totals).toEqual([0, 0]);
  });

  it("los totales se redondean a centavos: sin drift de punto flotante", () => {
    const s = sheetOf(conRubros([
      fx("a", { rubroId: "r3", coeficienteId: "cA", obligation: recibida("a", 0.1) }),
      fx("b", { rubroId: "r3", coeficienteId: "cA", obligation: recibida("b", 0.2) }),
    ]));
    expect(groupByRubro(s)[0].totals).toEqual([0.3, 0]);
  });

  it("una boleta eventual entra en su rubro como 'other' y suma en su columna", () => {
    const p = conRubros([], {
      looseInvoices: [{
        invoiceId: "o1", providerId: "p-x", lspServiceId: null, docKind: "FACTURA", concepto: "PLOMERO",
        matchNames: null, facturas: null, aliasCbu: null, amount: 30, invoiceUrl: null,
        carryOverRequested: false, createdAt: "2026-07-01T00:00:00.000Z", carriedOutTo: null,
        rubroId: "r4", coeficienteId: "cA",
      }],
    });
    const r4 = groupByRubro(sheetOf(p)).find((x) => x.rubroId === "r4")!;
    expect(r4.items).toHaveLength(1);
    expect(r4.items[0].kind).toBe("other");
    expect(r4.totals).toEqual([30, 0]);
  });

  it("grandTotals suma las secciones columna por columna", () => {
    const s = sheetOf(conRubros([
      fx("a", { rubroId: "r3", coeficienteId: "cB", obligation: recibida("a", 100) }),
      fx("b", { rubroId: "r4", obligation: recibida("b", 50) }),
      fx("c", { obligation: recibida("c", 1) }),
    ]));
    expect(grandTotals(groupByRubro(s), 2)).toEqual([51, 100]);
  });

  it("showsPendingMark: sólo una fila activa, pendiente y sin boleta ni monto (D12)", () => {
    const s = sheetOf(conRubros([
      fx("pend", { rubroId: "r3" }),
      fx("rec", { rubroId: "r3", obligation: recibida("rec", 5) }),
      fx("salt", { rubroId: "r3", obligation: ob("salt", { status: "SKIPPED" }) }),
      fx("inact", { rubroId: "r3", active: false }),
    ]));
    const mark = (id: string) => showsPendingMark(s.rows.find((r) => r.fixedExpenseId === id)!);
    expect([mark("pend"), mark("rec"), mark("salt"), mark("inact")]).toEqual([true, false, false, false]);
    expect(PENDING_MARK).toBe("—");
  });

  it("columnIndex: la columna del coeficiente, o la primera si no está", () => {
    const cols = [{ id: "cA", code: "A" }, { id: "cB", code: "B" }];
    expect(columnIndex(cols, "cB")).toBe(1);
    expect(columnIndex(cols, null)).toBe(0);
    expect(columnIndex(cols, "cZ")).toBe(0);
  });
});

describe("monthOnly", () => {
  it("deja sólo el mes de un rótulo de período", () => {
    expect(monthOnly("septiembre 2026")).toBe("septiembre");
    expect(monthOnly("  octubre   2026 ")).toBe("octubre");
    expect(monthOnly("julio")).toBe("julio");
  });

  it("null o vacío → null", () => {
    expect(monthOnly(null)).toBeNull();
    expect(monthOnly("   ")).toBeNull();
  });
});

describe("arrastradas en rubros y origen marcado (spec 2026-09-28)", () => {
  type Ob = NonNullable<OverviewFixedExpense["obligation"]>;
  const ob = (id: string, over: Partial<Ob> = {}): Ob => ({
    id: `ob-${id}`, status: "RECEIVED", amount: 100, invoiceId: `inv-${id}`,
    carryOverRequested: false, carriedIn: false, invoiceUrl: null, ...over,
  });
  const fx = (id: string, over: Partial<OverviewFixedExpense> = {}): OverviewFixedExpense => ({
    id, providerId: null, lspServiceId: null, description: id.toUpperCase(), kind: "FACTURA",
    active: true, rubroId: null, coeficienteId: null, obligation: ob(id), ...over,
  });
  const arrastrada = (invoiceId: string, over: Record<string, unknown> = {}) => ({
    invoiceId, concepto: invoiceId.toUpperCase(), facturas: null, aliasCbu: null,
    originalAmount: 40, lateAmount: null, fromLabel: "septiembre 2026", carryOverRequested: false,
    invoiceUrl: null, ...over,
  });
  const hoja = (extra: Partial<OverviewConsortium>) => buildSheets({
    ...payload,
    providers: [],
    consortiums: [{
      ...payload.consortiums[0],
      lspServices: [],
      rubros: [{ id: "r3", order: 3, name: "SERVICIOS PÚBLICOS" }, { id: "r4", order: 4, name: "ABONOS" }],
      coeficientes: [{ id: "cA", code: "A" }, { id: "cB", code: "B" }],
      fixedExpenses: [],
      ...extra,
    }],
  })[0];

  it("buildSheets lleva el rubro y el coeficiente de la arrastrada", () => {
    const s = hoja({ carried: [arrastrada("x", { rubroId: "r4", coeficienteId: "cB" })] });
    expect([s.carried[0].rubroId, s.carried[0].coeficienteId]).toEqual(["r4", "cB"]);
    const sinEtiqueta = hoja({ carried: [arrastrada("y")] });
    expect([sinEtiqueta.carried[0].rubroId, sinEtiqueta.carried[0].coeficienteId]).toEqual([null, null]);
  });

  it("la arrastrada va a la sección de su rubro y suma en la columna de su coeficiente", () => {
    const s = hoja({
      fixedExpenses: [fx("a", { rubroId: "r4", coeficienteId: "cA", obligation: ob("a", { amount: 100 }) })],
      carried: [arrastrada("x", { rubroId: "r4", coeficienteId: "cB", lateAmount: 55 })],
    });
    const r4 = groupByRubro(s).find((x) => x.rubroId === "r4")!;
    expect(r4.items.map((i) => i.kind)).toEqual(["row", "carried"]);
    // Suma el monto a pagar: el vencido si se cargó.
    expect(r4.totals).toEqual([100, 55]);
  });

  it("sin rubro, o con uno que el edificio no usa, va a 'Sin rubro' (columna del coeficiente o la primera)", () => {
    const s = hoja({ carried: [arrastrada("x"), arrastrada("y", { rubroId: "r-ajeno", coeficienteId: "cB" })] });
    const sections = groupByRubro(s);
    const sin = sections[sections.length - 1];
    expect(sin.rubroId).toBeNull();
    expect(sin.items.map((i) => i.kind === "carried" && i.carried.invoiceId)).toEqual(["x", "y"]);
    expect(sin.totals).toEqual([40, 40]);
  });

  it("va en el tramo de las que tienen boleta, alfabética con ellas", () => {
    const s = hoja({
      fixedExpenses: [
        fx("beta", { rubroId: "r3" }),
        fx("zeta-pend", { rubroId: "r3", obligation: ob("zeta-pend", { status: "PENDING", amount: null, invoiceId: null }) }),
      ],
      carried: [arrastrada("alfa", { rubroId: "r3" })],
    });
    const items = groupByRubro(s)[0].items;
    expect(items.map((i) => (i.kind === "carried" ? i.carried.invoiceId : i.kind === "row" ? i.row.fixedExpenseId : "?")))
      .toEqual(["alfa", "beta", "zeta-pend"]);
  });

  it("grandTotals incluye la arrastrada", () => {
    const s = hoja({
      fixedExpenses: [fx("a", { rubroId: "r3", coeficienteId: "cA", obligation: ob("a", { amount: 100 }) })],
      carried: [arrastrada("x", { rubroId: "r3", coeficienteId: "cA" })],
    });
    expect(grandTotals(groupByRubro(s), 2)).toEqual([140, 0]);
  });

  it("buildSheets mapea invoiceCarriedOutTo a carriedOutTo; sin dato, null", () => {
    const s = hoja({
      fixedExpenses: [
        fx("a", { obligation: ob("a", { status: "CARRIED_OVER", invoiceCarriedOutTo: "octubre 2026" }) }),
        fx("b"),
      ],
    });
    expect(s.rows.find((r) => r.fixedExpenseId === "a")!.carriedOutTo).toBe("octubre 2026");
    expect(s.rows.find((r) => r.fixedExpenseId === "b")!.carriedOutTo).toBeNull();
  });

  it("la fila CARRIED_OVER no suma (sus adicionales sí), no se imprime y va al final de su sección", () => {
    const s = hoja({
      fixedExpenses: [
        fx("alfa", { rubroId: "r3", obligation: ob("alfa", { status: "CARRIED_OVER", amount: 100, invoiceCarriedOutTo: "octubre 2026" }) }),
        fx("zeta-pend", { rubroId: "r3", obligation: ob("zeta-pend", { status: "PENDING", amount: null, invoiceId: null }) }),
        fx("beta", { rubroId: "r3", obligation: ob("beta", { amount: 10 }) }),
      ],
    });
    const pasada = s.rows.find((r) => r.fixedExpenseId === "alfa")!;
    const conExtra = { ...s, rows: s.rows.map((r) => r === pasada ? { ...r, extras: [
      { invoiceId: "e1", facturas: null, monto: 5, invoiceUrl: null, carryOverRequested: false, carriedOutTo: null },
    ] } : r) };
    const r3 = groupByRubro(conExtra)[0];
    expect(r3.items.map((i) => i.kind === "row" && i.row.fixedExpenseId)).toEqual(["beta", "zeta-pend", "alfa"]);
    expect(r3.totals).toEqual([15, 0]);
    expect(isPrintableRow(pasada)).toBe(false);
    // Sin la adicional, la hoja no tiene nada que la fila pasada aporte al papel.
    expect(toPrintableSheets([s])[0].rows.map((r) => r.fixedExpenseId)).toEqual(["beta", "zeta-pend"]);
  });

  it("filterSheets encuentra por concepto una arrastrada y conserva la hoja", () => {
    const s = hoja({ fixedExpenses: [fx("a")], carried: [arrastrada("plomero"), arrastrada("gasista")] });
    const out = filterSheets([s], "plomer");
    expect(out).toHaveLength(1);
    expect(out[0].rows).toEqual([]);
    expect(out[0].carried.map((c) => c.invoiceId)).toEqual(["plomero"]);
  });
});
