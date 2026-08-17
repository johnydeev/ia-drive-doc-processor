import { describe, expect, it } from "vitest";
import {
  buildSheets,
  filterSheets,
  hasPrintableRows,
  isPrintableRow,
  toPrintableSheets,
  type OverviewPayload,
} from "./sheetModel";

const payload: OverviewPayload = {
  majorityLabel: "julio 2026",
  providers: [
    { id: "p1", canonicalName: "SEGURO LA CAJA", paymentAlias: "seguro.caja" },
    { id: "p2", canonicalName: "TECNOPAS ASC.", paymentAlias: null },
    { id: "p9", canonicalName: "EDESUR S.A.", paymentAlias: "edesur.pago" },
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
      lspServices: [
        { id: "l1", providerName: "EDESUR", clientNumber: "4804882", description: null, providerId: "p9" },
      ],
      fixedExpenses: [
        { id: "fx1", providerId: "p1", lspServiceId: null, description: null, active: true,
          obligation: { id: "ob1", status: "PENDING", amount: null } },
        { id: "fx2", providerId: null, lspServiceId: "l1", description: null, active: true,
          obligation: { id: "ob2", status: "RECEIVED", amount: 118000 } },
        { id: "fx3", providerId: "p2", lspServiceId: null, description: null, active: false,
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
      lspServices: [],
      fixedExpenses: [
        { id: "fx4", providerId: "p1", lspServiceId: null, description: null, active: true, obligation: null },
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

  it("ordena los LSP primero y después el resto alfabético", () => {
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
    remaining: 980000,
    fromLabel: "agosto 2026",
    periodSort: 202608,
    alreadyCarried: false,
    canCarry: true,
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

  it("el monto es el saldo pendiente, no el total de la boleta", () => {
    expect(buildSheets(conImpaga)[0].carried[0].monto).toBe(980000);
  });

  it("con monto vencido cargado, ese es el monto a pagar y conserva el 1° pago", () => {
    const conVencido: OverviewPayload = {
      ...conImpaga,
      consortiums: [
        { ...conImpaga.consortiums[0], carried: [{ ...impaga, lateAmount: 1050000, remaining: 1050000 }] },
        conImpaga.consortiums[1],
      ],
    };
    const fila = buildSheets(conVencido)[0].carried[0];
    expect(fila.monto).toBe(1050000);
    expect(fila.originalAmount).toBe(980000);
  });

  it("se ordenan por período de origen, lo más viejo primero", () => {
    const dos: OverviewPayload = {
      ...conImpaga,
      consortiums: [
        {
          ...conImpaga.consortiums[0],
          carried: [
            { ...impaga, invoiceId: "sep", fromLabel: "septiembre 2026", periodSort: 202609 },
            { ...impaga, invoiceId: "jul", fromLabel: "julio 2026", periodSort: 202607 },
          ],
        },
        conImpaga.consortiums[1],
      ],
    };
    expect(buildSheets(dos)[0].carried.map((c) => c.invoiceId)).toEqual(["jul", "sep"]);
  });

  it("un edificio sin impagas trae el bloque vacío", () => {
    expect(buildSheets(payload)[0].carried).toEqual([]);
  });

  it("toPrintableSheets conserva un edificio que sólo tiene impagas", () => {
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
