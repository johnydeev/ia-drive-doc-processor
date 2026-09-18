import { describe, expect, it } from "vitest";
import {
  buildSheets,
  filterSheets,
  hasPrintableRows,
  isPrintableRow,
  printableExtras,
  shortClientNumber,
  toPrintableSheets,
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

  it("ordena: con boleta arriba; después servicios antes que proveedores", () => {
    const rows = buildSheets(payload)[0].rows;
    expect(rows.map((r) => r.fixedExpenseId)).toEqual(["fx2", "fx1", "fx3"]);
  });

  it("manda los desactivados al final, aunque sean LSP", () => {
    const conLspInactivo = {
      ...payload,
      consortiums: [
        {
          ...payload.consortiums[0],
          fixedExpenses: [
            // El LSP está desactivado: pierde su lugar de privilegio y va último.
            { ...payload.consortiums[0].fixedExpenses[1], active: false },
            payload.consortiums[0].fixedExpenses[0], // SEGURO, activo
          ],
        },
      ],
    };

    const rows = buildSheets(conLspInactivo)[0].rows;
    expect(rows.map((r) => r.fixedExpenseId)).toEqual(["fx1", "fx2"]);
    expect(rows[rows.length - 1].active).toBe(false);
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

  it("van en su propio bloque, no entre los gastos fijos", () => {
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

  it("una boleta suelta del proveedor de un gasto fijo activo cuelga de su fila como 2ª boleta", () => {
    const sheet = buildSheets(withLoose([
      loose({ invoiceId: "i2", providerId: "p1", amount: 500, invoiceUrl: "https://d/2", concepto: "SEGURO LA CAJA" }),
    ]))[0];
    const seguro = sheet.rows.find((r) => r.fixedExpenseId === "fx1")!;
    expect(seguro.extras).toEqual([
      { invoiceId: "i2", ordinal: 2, monto: 500, invoiceUrl: "https://d/2", carryOverRequested: false, carriedOutTo: null },
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

  it("ordena las extras por fecha de carga y numera 2ª, 3ª", () => {
    const sheet = buildSheets(withLoose([
      loose({ invoiceId: "tarde", providerId: "p1", createdAt: "2026-07-20T00:00:00.000Z" }),
      loose({ invoiceId: "temprano", providerId: "p1", createdAt: "2026-07-05T00:00:00.000Z" }),
    ]))[0];
    const extras = sheet.rows.find((r) => r.fixedExpenseId === "fx1")!.extras;
    expect(extras.map((e) => [e.invoiceId, e.ordinal])).toEqual([["temprano", 2], ["tarde", 3]]);
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
    ({ invoiceId, ordinal: 2, monto: 100, invoiceUrl: null, carryOverRequested: false, carriedOutTo });
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

describe("orden de la hoja: dos niveles", () => {
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

  it("1° con boleta, 2° empleados → servicios → proveedores, alfabético; sin boleta igual; salteadas y desactivadas al final", () => {
    const ids = buildSheets(base)[0].rows.map((r) => r.fixedExpenseId);
    expect(ids).toEqual([
      "rec-emp", "rec-lsp", "rec-prov-a", "rec-prov-z",
      "pend-emp", "pend-lsp", "pend-prov",
      "skipped",
      "inactivo",
    ]);
  });

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

  it("'otras' también: empleados → servicios → proveedores, alfabético", () => {
    const loose = (invoiceId: string, over: Partial<OverviewLooseInvoice>): OverviewLooseInvoice => ({
      invoiceId, providerId: null, lspServiceId: null, docKind: "FACTURA", concepto: "X", matchNames: null,
      facturas: null, aliasCbu: null, amount: 1, invoiceUrl: null, carryOverRequested: false,
      createdAt: "2026-07-01T00:00:00.000Z", carriedOutTo: null, ...over,
    });
    const withOthers: OverviewPayload = {
      ...base,
      consortiums: [{
        ...base.consortiums[0],
        fixedExpenses: [],
        looseInvoices: [
          loose("z", { providerId: "prov-z", concepto: "ZETA SA" }),
          loose("s", { providerId: "p9", lspServiceId: "l-otro", concepto: "EDESUR S.A.", facturas: "99" }),
          loose("a", { providerId: "prov-a", concepto: "ALFA SRL" }),
          loose("e", { providerId: "emp", concepto: "PEREZ JUAN" }),
        ],
      }],
    };
    const others = buildSheets(withOthers)[0].others;
    expect(others.map((o) => o.invoiceId)).toEqual(["e", "s", "a", "z"]);
    expect(others.map((o) => o.group)).toEqual(["EMPLEADO", "SERVICIO", "PROVEEDOR", "PROVEEDOR"]);
  });
});

describe("shortClientNumber", () => {
  it("deja pasar los cortos y recorta los largos con puntos suspensivos", () => {
    expect(shortClientNumber(null)).toBeNull();
    expect(shortClientNumber("4804882")).toBe("4804882");
    expect(shortClientNumber("123456789012")).toBe("123456789012");
    expect(shortClientNumber("1234567890123")).toBe("123456789012…");
    expect(shortClientNumber("1234567890123", 5)).toBe("12345…");
  });
});
