# Boletas adicionales y "Otras boletas del mes" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la hoja de obligaciones (pantalla + PDF del banco) muestre TODAS las boletas del mes del edificio: las adicionales de un proveedor que ya es gasto fijo, colgadas de su fila, y las de proveedores sin gasto fijo, en un bloque "Otras boletas del mes".

**Architecture:** Derivado, sin tocar el modelo. El overview trae las boletas del período que no ocupan ninguna obligación (`obligation: null`) más las que nacieron acá y se empujaron al mes siguiente; `sheetModel.buildSheets` (puro) las cruza contra los gastos fijos activos con `obligationMatchesInvoice` y las reparte en `row.extras[]` o `sheet.others[]`. `SheetCard` y `sheetPdf` consumen ese modelo. `syncObligationsForClient` pasa a revincular en todos los períodos activos para que, borrada la principal, la siguiente suba al sincronizar.

**Tech Stack:** Next.js 15 (App Router), Prisma, React, Vitest (proyectos `node` para `.test.ts` y `jsdom` para `.test.tsx`), jsPDF + jspdf-autotable.

**Spec:** `docs/superpowers/specs/2026-09-18-boletas-adicionales-y-otras-del-mes-design.md`

**Reglas del repo que mandan sobre este plan:**
- Claude **no commitea** ni hace `git add`: el owner commitea con GitLens. Los pasos "Commit" de la plantilla se reemplazan por "avisar listo".
- Sin migraciones: no se toca `prisma/schema.prisma`.
- Todo botón que dispara una mutación es `AsyncButton` (spinner + disabled).
- Al terminar: `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md` actualizados.

---

## Mapa de archivos

| Archivo | Responsabilidad | Cambio |
|---|---|---|
| `src/app/admin/obligaciones/lib/sheetModel.ts` | Modelo puro de la hoja (única fuente de pantalla y PDF) | tipos `OverviewLooseInvoice`, `ExtraRow`, `OtherRow`; cruce en `buildSheets`; `printableExtras`; `hasPrintableRows`, `toPrintableSheets`, `filterSheets` |
| `src/app/admin/obligaciones/lib/sheetModel.test.ts` | Tests del modelo | tests nuevos + `extras: []`/`others: []` en fixtures |
| `src/app/admin/obligaciones/lib/sheetPdf.ts` | Tablas para jsPDF | extras en `body`, `others` + `OTHERS_TITLE`, render del bloque |
| `src/app/admin/obligaciones/lib/sheetPdf.test.ts` | Tests del PDF | tests nuevos + fixtures |
| `src/app/admin/obligaciones/components/SheetCard.tsx` | Tarjeta del edificio | subfilas `rowExtra`, bloque `othersBlock`, nota vacía |
| `src/app/admin/obligaciones/components/SheetCard.test.tsx` | Tests del componente | tests nuevos + fixtures |
| `src/app/admin/obligaciones/page.module.css` | Estilos | `rowExtra`, `extraLabel`, `othersBlock`, `othersTitle`, `rowOther`, `rowCarriedOut` + print |
| `src/app/api/client/obligations/overview/route.ts` | Endpoint del overview | queries `loose` + `carriedOut`, campo `looseInvoices` por consorcio |
| `src/services/obligation.service.ts` | Obligaciones | `syncObligationsForClient`: vínculo retroactivo en todos los períodos activos |
| `src/services/obligation.service.test.ts` | Tests del service | test nuevo |
| `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`, `CLAUDE.md` | Documentación | entradas del 2026-09-18 |

---

### Task 1: Modelo puro — tipos y cruce en `buildSheets`

**Files:**
- Modify: `src/app/admin/obligaciones/lib/sheetModel.ts`
- Test: `src/app/admin/obligaciones/lib/sheetModel.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `sheetModel.test.ts`:

```ts
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
      carryOverRequested: false, carriedOutTo: null,
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
       invoiceUrl: null, carryOverRequested: false, carriedOutTo });

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
```

Y en el `import` del tope agregar `printableExtras` y `type OverviewLooseInvoice`.

- [ ] **Step 2: Correr y ver que falla**

Run: `npx vitest run src/app/admin/obligaciones/lib/sheetModel.test.ts`
Expected: FAIL — `printableExtras` no exportado / `extras` undefined.

- [ ] **Step 3: Implementar en `sheetModel.ts`**

Import nuevo al tope:
```ts
import { obligationMatchesInvoice } from "@/lib/fixedExpense";
```

Tipos nuevos (después de `OverviewCarried`):
```ts
/**
 * Boleta del mes que NO ocupa ninguna obligación: la 2ª del mismo proveedor, o
 * la de un proveedor que no es gasto fijo del edificio. `carriedOutTo` la marca
 * si nació acá y el owner la empujó al mes siguiente (el origen la sigue
 * mostrando, sin acciones).
 */
export type OverviewLooseInvoice = {
  invoiceId: string;
  providerId: string | null;
  lspServiceId: string | null;
  docKind: "FACTURA" | "RETENCION";
  concepto: string;
  matchNames: string | null;
  facturas: string | null;
  aliasCbu: string | null;
  amount: number | null;
  invoiceUrl: string | null;
  carryOverRequested: boolean;
  createdAt: string;
  carriedOutTo: string | null;
};
```

En `OverviewConsortium` agregar `looseInvoices?: OverviewLooseInvoice[];`.

Después de `SheetRow` (antes, para poder referenciarlo) agregar:
```ts
/**
 * Boleta ADICIONAL de un gasto fijo: la 2ª, 3ª… del mismo proveedor en el mes.
 * No es una obligación (no se omite, no vence): es otro gasto a pagar, con su
 * PDF, su recibo y su arrastre. Concepto y alias los hereda de la fila madre.
 */
export type ExtraRow = {
  invoiceId: string;
  /** 2, 3, … (la principal, vinculada a la obligación, es la 1ª). */
  ordinal: number;
  monto: number | null;
  invoiceUrl: string | null;
  carryOverRequested: boolean;
  /** "octubre 2026" si el owner la empujó al mes siguiente; null si vive acá. */
  carriedOutTo: string | null;
};

/**
 * Boleta de un proveedor que NO es gasto fijo del edificio (ticket, trabajo
 * eventual, razón social hermana de un proveedor cargado). Bloque propio,
 * "Otras boletas del mes".
 */
export type OtherRow = {
  invoiceId: string;
  facturas: string | null;
  concepto: string;
  fantasia: string | null;
  monto: number | null;
  aliasCbu: string[];
  invoiceUrl: string | null;
  carryOverRequested: boolean;
  carriedOutTo: string | null;
};
```

En `SheetRow` agregar al final: `extras: ExtraRow[];`. En `SheetData` agregar después de `carried`: `others: OtherRow[];`.

En `buildSheets`, dentro del `map` de consorcios, ANTES de armar `rows`, calcular el reparto:
```ts
    // Boletas del mes que no ocupan ninguna obligación: si el edificio tiene un
    // gasto fijo ACTIVO que matchee (mismo criterio que el pipeline), cuelgan de
    // esa fila como adicionales; si no, van a "Otras boletas del mes". Un gasto
    // fijo desactivado no cuenta: su tabla está plegada y no se imprime, y la
    // boleta hay que pagarla igual.
    const extrasByFx = new Map<string, ExtraRow[]>();
    const others: OtherRow[] = [];
    const looseSorted = [...(c.looseInvoices ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const inv of looseSorted) {
      const fx = c.fixedExpenses.find(
        (f) =>
          f.active &&
          obligationMatchesInvoice(
            { providerId: f.providerId, lspServiceId: f.lspServiceId, kind: f.kind },
            { providerId: inv.providerId, lspServiceId: inv.lspServiceId, docKind: inv.docKind }
          )
      );
      if (fx) {
        const list = extrasByFx.get(fx.id) ?? [];
        list.push({
          invoiceId: inv.invoiceId,
          ordinal: list.length + 2,
          monto: inv.amount,
          invoiceUrl: inv.invoiceUrl,
          carryOverRequested: inv.carryOverRequested,
          carriedOutTo: inv.carriedOutTo,
        });
        extrasByFx.set(fx.id, list);
      } else {
        others.push({
          invoiceId: inv.invoiceId,
          facturas: inv.facturas,
          concepto: inv.concepto,
          fantasia: firstMatchName(inv.matchNames),
          monto: inv.amount,
          aliasCbu: parsePaymentAliases(inv.aliasCbu),
          invoiceUrl: inv.invoiceUrl,
          carryOverRequested: inv.carryOverRequested,
          carriedOutTo: inv.carriedOutTo,
        });
      }
    }
    others.sort((a, b) => a.concepto.localeCompare(b.concepto, "es"));
```

En el objeto que devuelve el `map` de `rows`, agregar `extras: extrasByFx.get(fx.id) ?? [],`.

En el `return` de la hoja agregar `others,` después de `carried,`.

Reemplazar `hasPrintableRows` y `toPrintableSheets`, y agregar `printableExtras`:
```ts
/** Las adicionales que van al papel: las que siguen viviendo en este mes. */
export function printableExtras(row: SheetRow): ExtraRow[] {
  return row.extras.filter((e) => !e.carriedOutTo);
}

/**
 * ¿Esta hoja tiene algo que imprimir? Cuenta los gastos del mes, las adicionales
 * (aunque su madre esté salteada: llegó una boleta, hay que pagarla), las
 * impagas arrastradas y las otras boletas del mes.
 */
export function hasPrintableRows(sheet: SheetData): boolean {
  return (
    sheet.rows.some(isPrintableRow) ||
    sheet.rows.some((r) => printableExtras(r).length > 0) ||
    sheet.carried.length > 0 ||
    sheet.others.some((o) => !o.carriedOutTo)
  );
}

/**
 * Las hojas tal como salen impresas: sin filas salteadas ni desactivadas, sin
 * edificios sin período activo y sin edificios que quedarían en blanco (no se
 * gasta papel en una hoja vacía). Una madre no imprimible con adicionales
 * QUEDA: el PDF decide con `isPrintableRow` si imprime su línea o sólo las
 * adicionales. Lo que pasó a otro mes no va. El bloque de impagas viaja
 * intacto. No muta la entrada.
 */
export function toPrintableSheets(sheets: SheetData[]): SheetData[] {
  return sheets
    .map((sheet) => ({
      ...sheet,
      rows: sheet.rows
        .filter((row) => isPrintableRow(row) || printableExtras(row).length > 0)
        .map((row) => ({ ...row, extras: printableExtras(row) })),
      others: sheet.others.filter((o) => !o.carriedOutTo),
    }))
    .filter((sheet) => sheet.rows.length > 0 || sheet.carried.length > 0 || sheet.others.length > 0);
}
```

En `filterSheets`, reemplazar el bloque del concepto:
```ts
    const rows = sheet.rows.filter((r) => norm(r.concepto).includes(q));
    const others = sheet.others.filter((o) => norm(o.concepto).includes(q));
    if (rows.length > 0 || others.length > 0) out.push({ ...sheet, rows, others });
```

- [ ] **Step 4: Correr los tests del modelo**

Run: `npx vitest run src/app/admin/obligaciones/lib/sheetModel.test.ts`
Expected: PASS (los viejos y los nuevos). Si un test viejo construye `SheetData`/`SheetRow` a mano y falla por tipo, agregarle `extras: []` / `others: []`.

---

### Task 2: PDF — extras debajo de su madre y bloque "OTRAS BOLETAS DEL MES"

**Files:**
- Modify: `src/app/admin/obligaciones/lib/sheetPdf.ts`
- Test: `src/app/admin/obligaciones/lib/sheetPdf.test.ts`

- [ ] **Step 1: Fixtures + tests que fallan**

En el fixture `sheets` de `sheetPdf.test.ts`, agregar `extras: []` a cada fila y `others: []` a la hoja. Importar `OTHERS_TITLE` junto a `PDF_COLUMNS`. Agregar al final:

```ts
describe("adicionales y otras boletas del mes", () => {
  const extra = (invoiceId: string, ordinal: number, monto: number, carriedOutTo: string | null = null) =>
    ({ invoiceId, ordinal, monto, invoiceUrl: null, carryOverRequested: false, carriedOutTo });

  it("una adicional sale indentada debajo de su madre, con el alias de la madre", () => {
    const withExtra = [{
      ...sheets[0],
      rows: [{ ...sheets[0].rows[0], extras: [extra("i2", 2, 54000)] }, sheets[0].rows[1]],
    }];
    const body = toPdfTables(withExtra)[0].body;
    expect(body[0][1]).toBe("EDESUR");
    expect(body[1]).toEqual(["", "   ↳ 2ª boleta", "$ 54.000,00", "edesur.pago", "", ""]);
    expect(body[2][1]).toBe("SEGURO LA CAJA");
  });

  it("si la madre está salteada, imprime sólo la adicional con el concepto completo", () => {
    const withExtra = [{
      ...sheets[0],
      rows: [{ ...sheets[0].rows[2], extras: [extra("i9", 2, 1000)] }],
    }];
    const body = toPdfTables(withExtra)[0].body;
    expect(body).toEqual([["", "FUMIGACION — 2ª boleta", "$ 1.000,00", "", "", ""]]);
  });

  it("las otras boletas del mes van en su bloque, con la fantasía entre paréntesis", () => {
    const withOthers = [{
      ...sheets[0],
      others: [
        { invoiceId: "o1", facturas: null, concepto: "PLOMERO JUAN", fantasia: "JUAN", monto: 32000,
          aliasCbu: ["juan.plomero"], invoiceUrl: null, carryOverRequested: false, carriedOutTo: null },
        { invoiceId: "o2", facturas: "77", concepto: "AYSA", fantasia: null, monto: 500,
          aliasCbu: [], invoiceUrl: null, carryOverRequested: false, carriedOutTo: null },
      ],
    }];
    const table = toPdfTables(withOthers)[0];
    expect(table.others).toEqual([
      ["", "PLOMERO JUAN (JUAN)", "$ 32.000,00", "juan.plomero", "", ""],
      ["77", "AYSA", "$ 500,00", "", "", ""],
    ]);
    expect(OTHERS_TITLE).toBe("OTRAS BOLETAS DEL MES");
  });

  it("lo que pasó a otro mes no va al papel", () => {
    const moved = [{
      ...sheets[0],
      rows: [{ ...sheets[0].rows[0], extras: [extra("i2", 2, 54000, "agosto 2026")] }],
      others: [{ invoiceId: "o1", facturas: null, concepto: "PLOMERO", fantasia: null, monto: 1,
                 aliasCbu: [], invoiceUrl: null, carryOverRequested: false, carriedOutTo: "agosto 2026" }],
    }];
    const table = toPdfTables(moved)[0];
    expect(table.body).toHaveLength(1);
    expect(table.others).toEqual([]);
  });

  it("sin adicionales ni otras, el bloque queda vacío", () => {
    expect(toPdfTables(sheets)[0].others).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `npx vitest run src/app/admin/obligaciones/lib/sheetPdf.test.ts`
Expected: FAIL — `OTHERS_TITLE` no existe / `others` undefined.

- [ ] **Step 3: Implementar en `sheetPdf.ts`**

Import: `import { isPrintableRow, toPrintableSheets, type SheetData, type SheetRow } from "./sheetModel";`

En `PdfTable` agregar `others: string[][];` (comentario: bloque "Otras boletas del mes", entre la tabla del mes y las impagas). Junto a `CARRIED_TITLE`:
```ts
/** Título del bloque de boletas de proveedores que no son gasto fijo del edificio. */
export const OTHERS_TITLE = "OTRAS BOLETAS DEL MES";
```

Helper antes de `toPdfTables`:
```ts
/**
 * Una fila madre y sus adicionales. Si la madre no se imprime (salteada), las
 * adicionales llevan el concepto completo: no hay línea a la que indentarse.
 */
function rowLines(row: SheetRow): string[][] {
  const madre = isPrintableRow(row);
  const extras = row.extras.map((e) => [
    "",
    madre ? `   ↳ ${e.ordinal}ª boleta` : `${row.concepto} — ${e.ordinal}ª boleta`,
    e.monto != null ? money.format(e.monto) : "",
    row.aliasCbu.join("\n"),
    "",
    "",
  ]);
  if (!madre) return extras;
  return [
    [
      row.facturas ?? "",
      row.concepto,
      row.monto != null ? money.format(row.monto) : "",
      row.aliasCbu.join("\n"),
      "", // TÉCNICO O GESTOR — se completa a mano
      "", // TEL. CONTACTO — se completa a mano
    ],
    ...extras,
  ];
}
```

En `toPdfTables` reemplazar `body: sheet.rows.map(...)` por `body: sheet.rows.flatMap(rowLines),` y agregar después de `body`:
```ts
    others: sheet.others.map((row) => [
      row.facturas ?? "",
      row.fantasia ? `${row.concepto} (${row.fantasia})` : row.concepto,
      row.monto != null ? money.format(row.monto) : "",
      row.aliasCbu.join("\n"),
      "",
      "",
    ]),
```

En `downloadSheetsPdf`, extraer el render del bloque a un helper local y usarlo dos veces (otras antes que impagas):
```ts
    // Un bloque = título + segunda tabla en la MISMA hoja, debajo de la anterior.
    // `lastAutoTable` existe en runtime (verificado con jspdf-autotable 5.0.8:
    // devuelve `{ finalY }`), pero la v5 no lo declara en sus tipos — el plugin
    // lo agrega al documento sin augmentar la interfaz de jsPDF.
    const appendBlock = (title: string, body: string[][]) => {
      if (body.length === 0) return;
      const withLast = doc as unknown as { lastAutoTable?: { finalY?: number } };
      const finalY = withLast.lastAutoTable?.finalY ?? 30;
      doc.setFontSize(10);
      doc.setTextColor(60);
      doc.text(title, 14, finalY + 10);
      autoTable(doc, { startY: finalY + 13, head: table.head, body, ...tableStyles });
    };

    autoTable(doc, { startY: 30, head: table.head, body: table.body, ...tableStyles });
    // Primero lo que llegó este mes fuera del padrón, después lo que viene
    // atrasado: el administrador lee de lo corriente a lo viejo.
    appendBlock(OTHERS_TITLE, table.others);
    appendBlock(CARRIED_TITLE, table.carried);
```
(Borrar el `if (table.carried.length > 0) { ... }` viejo.)

- [ ] **Step 4: Correr los tests del PDF**

Run: `npx vitest run src/app/admin/obligaciones/lib/sheetPdf.test.ts`
Expected: PASS.

---

### Task 3: `SheetCard` — subfilas de adicionales y bloque "Otras boletas del mes"

**Files:**
- Modify: `src/app/admin/obligaciones/components/SheetCard.tsx`
- Modify: `src/app/admin/obligaciones/page.module.css`
- Test: `src/app/admin/obligaciones/components/SheetCard.test.tsx`

- [ ] **Step 1: Fixtures + tests que fallan**

En el fixture `sheet` de `SheetCard.test.tsx`, agregar `extras: []` a cada fila y `others: []` a la hoja. Agregar al final:

```tsx
describe("adicionales y otras boletas del mes", () => {
  const extra = (over: Partial<SheetData["rows"][number]["extras"][number]> = {}) => ({
    invoiceId: "inv2", ordinal: 2, monto: 54000, invoiceUrl: "https://drive.google.com/file/d/X2/view",
    carryOverRequested: false, carriedOutTo: null, ...over,
  });
  const other = (over: Partial<SheetData["others"][number]> = {}) => ({
    invoiceId: "o1", facturas: null, concepto: "PLOMERO JUAN", fantasia: "JUAN", monto: 32000,
    aliasCbu: ["juan.plomero"], invoiceUrl: "https://drive.google.com/file/d/O1/view",
    carryOverRequested: false, carriedOutTo: null, ...over,
  });

  it("una adicional se dibuja debajo de su madre con su monto y ofrece pasarla al mes siguiente", async () => {
    const props = renderCard({ sheet: { ...sheet, rows: [{ ...sheet.rows[0], extras: [extra()] }] } });
    const fila = screen.getByText("↳ 2ª boleta").closest("tr")!;
    expect(within(fila).getByText("$ 54.000,00")).toBeInTheDocument();
    expect(within(fila).getByText("edesur.pago")).toBeInTheDocument();
    expect(within(fila).queryByRole("button", { name: /saltear/i })).toBeNull();
    expect(within(fila).queryByRole("button", { name: /desactivar/i })).toBeNull();
    await userEvent.click(within(fila).getByRole("button", { name: /pasar al mes siguiente/i }));
    expect(props.onToggleCarryOver).toHaveBeenCalledWith("inv2", true);
  });

  it("una adicional ofrece la vista previa de SU pdf", () => {
    renderCard({ sheet: { ...sheet, rows: [{ ...sheet.rows[0], extras: [extra()] }] } });
    expect(screen.getByRole("button", { name: /vista previa de la boleta de edesur — 2ª boleta/i })).toBeInTheDocument();
  });

  it("una adicional que pasó a otro mes lo dice y no tiene acciones", () => {
    renderCard({ sheet: { ...sheet, rows: [{ ...sheet.rows[0], extras: [extra({ carriedOutTo: "agosto 2026" })] }] } });
    const fila = screen.getByText("↳ 2ª boleta").closest("tr")!;
    expect(within(fila).getByText(/pasó a agosto 2026/i)).toBeInTheDocument();
    expect(within(fila).queryByRole("button", { name: /pasar al mes siguiente/i })).toBeNull();
  });

  it("las otras boletas del mes van en su bloque, con fantasía y alias, y se pueden pasar", async () => {
    const props = renderCard({ sheet: { ...sheet, others: [other()] } });
    const bloque = screen.getByRole("heading", { name: /otras boletas del mes/i }).parentElement!;
    expect(within(bloque).getByText("PLOMERO JUAN")).toBeInTheDocument();
    expect(within(bloque).getByText("JUAN")).toBeInTheDocument();
    expect(within(bloque).getByText("$ 32.000,00")).toBeInTheDocument();
    expect(within(bloque).getByText("juan.plomero")).toBeInTheDocument();
    await userEvent.click(within(bloque).getByRole("button", { name: /pasar al mes siguiente/i }));
    expect(props.onToggleCarryOver).toHaveBeenCalledWith("o1", true);
  });

  it("sin otras no dibuja el bloque", () => {
    renderCard();
    expect(screen.queryByRole("heading", { name: /otras boletas del mes/i })).toBeNull();
  });

  it("un edificio sin gastos fijos pero con otras boletas no dice que no se va a imprimir", () => {
    const { container } = render(
      <SheetCard sheet={{ ...sheet, rows: [], others: [other()] }} onAdd={vi.fn()} onToggle={vi.fn()}
        onSetStatus={vi.fn()} onToggleCarryOver={vi.fn()} onUndoCarryOver={vi.fn()} onSetLateAmount={vi.fn()} />
    );
    expect(screen.getByText(/sin gastos fijos cargados/i)).toBeInTheDocument();
    expect(screen.queryByText(/no se va a imprimir/i)).toBeNull();
    expect(container.querySelector("section")?.getAttribute("data-printable")).toBe("true");
  });
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `npx vitest run src/app/admin/obligaciones/components/SheetCard.test.tsx`
Expected: FAIL — no existe "↳ 2ª boleta" ni el heading.

- [ ] **Step 3: Implementar en `SheetCard.tsx`**

Import: `import { Fragment, useState } from "react";` y `import { hasPrintableRows, type ExtraRow, type SheetData, type SheetRow } from "../lib/sheetModel";`

Botón de arrastre compartido (dentro del componente, antes de `renderRow`):
```tsx
  /** El único botón de una boleta sin obligación: marcarla para el mes siguiente. */
  const carryBtn = (invoiceId: string, requested: boolean) => (
    <AsyncButton
      type="button"
      className={requested ? styles.actionBtnMarked : styles.actionBtn}
      pendingLabel={requested ? "Quitando…" : "Marcando…"}
      onClick={() => onToggleCarryOver(invoiceId, !requested)}
    >
      {requested ? "Pasa al mes siguiente ✓" : "Pasar al mes siguiente"}
    </AsyncButton>
  );

  /** Adicional: otra boleta del mismo proveedor. Sin estado, sin saltear ni
      desactivar: si no corresponde, se borra desde Boletas. */
  const renderExtra = (row: SheetRow, extra: ExtraRow) => (
    <tr
      key={extra.invoiceId}
      className={extra.carriedOutTo ? `${styles.rowExtra} ${styles.rowCarriedOut}` : styles.rowExtra}
    >
      {previewCell(extra.invoiceUrl, `${row.concepto} — ${extra.ordinal}ª boleta`)}
      <td />
      <td>
        <span className={styles.extraLabel}>↳ {extra.ordinal}ª boleta</span>
        {extra.carriedOutTo && <span className={styles.carriedBadge}>pasó a {extra.carriedOutTo}</span>}
      </td>
      <td>{extra.monto != null ? money.format(extra.monto) : ""}</td>
      <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
      <td />
      <td />
      <td className={styles.rowActions}>
        {!extra.carriedOutTo && carryBtn(extra.invoiceId, extra.carryOverRequested)}
      </td>
    </tr>
  );
```

`renderRow`: envolver en `Fragment` y emitir las extras después de la madre:
```tsx
  const renderRow = (row: SheetRow) => {
    const isSkipped = Boolean(row.obligationId) && row.status === "SKIPPED";
    return (
      <Fragment key={row.fixedExpenseId}>
        <tr className={rowClass(row)}>
          ...(contenido actual de la fila, sin el `key`)...
        </tr>
        {row.extras.map((extra) => renderExtra(row, extra))}
      </Fragment>
    );
  };
```

Nota vacía: reemplazar el `<p className={styles.emptyNote}>` por:
```tsx
        <p className={styles.emptyNote}>
          {inactiveRows.length === 0
            ? "Este edificio está sin gastos fijos cargados"
            : "Este edificio está sin gastos fijos activos"}
          {hasPrintableRows(sheet) ? "." : ": no se va a imprimir."}
        </p>
```

Bloque "Otras boletas del mes", entre el `<details>` de desactivados y el bloque de arrastradas:
```tsx
      {/* Otras boletas del mes: proveedores que no son gasto fijo del edificio
          (ticket, trabajo eventual, razón social hermana). Bloque propio para
          que la tabla de arriba siga siendo "el padrón del edificio". */}
      {sheet.others.length > 0 && (
        <div className={styles.othersBlock}>
          <h3 className={styles.othersTitle}>Otras boletas del mes</h3>
          <table className={styles.sheetTable}>
            {columns}
            <tbody>
              {sheet.others.map((row) => (
                <tr
                  key={row.invoiceId}
                  className={row.carriedOutTo ? `${styles.rowOther} ${styles.rowCarriedOut}` : styles.rowOther}
                >
                  {previewCell(row.invoiceUrl, row.concepto)}
                  <td>{row.facturas ?? ""}</td>
                  <td>
                    {row.concepto}
                    {row.fantasia && <strong className={styles.fantasia}>{row.fantasia}</strong>}
                    {row.carriedOutTo && <span className={styles.carriedBadge}>pasó a {row.carriedOutTo}</span>}
                  </td>
                  <td>{row.monto != null ? money.format(row.monto) : ""}</td>
                  <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
                  <td />
                  <td />
                  <td className={styles.rowActions}>
                    {!row.carriedOutTo && carryBtn(row.invoiceId, row.carryOverRequested)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
```

El botón de arrastre de la fila madre (el `{row.invoiceId && (<AsyncButton ...>)}` existente) se reemplaza por `{row.invoiceId && carryBtn(row.invoiceId, row.carryOverRequested)}`; el del bloque de arrastradas también.

- [ ] **Step 4: CSS en `page.module.css`**

Después de `.rowCarried td { ... }`:
```css
/* Adicional: otra boleta del mismo proveedor, colgada de su fila. */
.rowExtra td { background: rgba(127, 127, 127, 0.05); }
.rowExtra td:nth-child(3) { padding-left: 22px; }
.extraLabel { opacity: 0.8; }

/* Otras boletas del mes: proveedores que no son gasto fijo del edificio. */
.othersBlock { margin-top: 18px; border-top: 1px dashed rgba(127, 127, 127, 0.45); padding-top: 10px; }
.othersTitle {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  opacity: 0.75; margin: 0 0 6px;
}
.rowOther td { background: rgba(37, 99, 235, 0.05); }
/* Nació este mes y ya pasó al siguiente: se ve (rendición), no se paga acá. */
.rowCarriedOut td { opacity: 0.55; }
```

En el `@media print` principal, junto a `.sheetTable .rowSkipped, .sheetTable .rowInactive { display: none; }`:
```css
  .sheetTable .rowCarriedOut { display: none; }
```

- [ ] **Step 5: Correr los tests del componente**

Run: `npx vitest run src/app/admin/obligaciones/components/SheetCard.test.tsx`
Expected: PASS. Si "un edificio sin gastos fijos avisa y no dibuja tabla" o "si todos están desactivados…" comparan el texto completo, ajustar su regex a `/sin gastos fijos (cargados|activos)/i`.

---

### Task 4: Overview — `loose` + `carriedOut` → `looseInvoices`

**Files:**
- Modify: `src/app/api/client/obligations/overview/route.ts`

Sin test unitario (el endpoint no tiene); se verifica con `typecheck` y el smoke de Task 7.

- [ ] **Step 1: Queries**

Después de la query `carried`, agregar:
```ts
  // Boletas del mes que NO ocupan ninguna obligación: la 2ª del mismo proveedor,
  // o la de un proveedor que no es gasto fijo del edificio. `sheetModel` decide
  // en cuál de los dos casos está cada una. `obligation: null` es la inversa de
  // `ExpenseObligation.invoiceId`.
  const looseSelect = {
    id: true, consortiumId: true, periodId: true, providerId: true, lspServiceId: true,
    docKind: true, amount: true, sourceFileUrl: true, carryOverRequestedAt: true, createdAt: true,
    provider: true,
    providerRef: { select: { canonicalName: true, paymentAlias: true, matchNames: true } },
    lspServiceRef: { select: { clientNumber: true } },
  } as const;

  const loose = periodIds.length
    ? await prisma.invoice.findMany({
        where: { clientId, periodId: { in: periodIds }, carriedFromPeriodId: null, obligation: null },
        select: looseSelect,
      })
    : [];

  // Las que NACIERON en este mes y el owner empujó al siguiente: el origen las
  // sigue mostrando (rendición ante los inquilinos), sin acciones. `obligation:
  // null` también acá: la principal arrastrada conserva su obligación (queda
  // CARRIED_OVER y ya se muestra en su fila); sin el filtro saldría dos veces.
  const carriedOut = periodIds.length
    ? await prisma.invoice.findMany({
        where: { clientId, carriedFromPeriodId: { in: periodIds }, obligation: null },
        select: { ...looseSelect, carriedFromPeriodId: true, period: { select: { year: true, month: true } } },
      })
    : [];

  type LooseRow = (typeof loose)[number] & { carriedFromPeriodId?: string | null; period?: { year: number; month: number } | null };
  const toLoose = (inv: LooseRow, carriedOutTo: string | null) => ({
    invoiceId: inv.id,
    providerId: inv.providerId,
    lspServiceId: inv.lspServiceId,
    docKind: inv.docKind,
    concepto: inv.providerRef?.canonicalName ?? inv.provider ?? "—",
    matchNames: inv.providerRef?.matchNames ?? null,
    facturas: inv.lspServiceRef?.clientNumber ?? null,
    aliasCbu: inv.providerRef?.paymentAlias ?? null,
    // Decimal de Prisma serializa como string: la UI espera número.
    amount: inv.amount != null ? Number(inv.amount) : null,
    invoiceUrl: inv.sourceFileUrl ?? null,
    carryOverRequested: Boolean(inv.carryOverRequestedAt),
    createdAt: inv.createdAt.toISOString(),
    carriedOutTo,
  });
```

- [ ] **Step 2: Campo por consorcio**

En el `consortiums.map`, después de `carried: ...`, agregar:
```ts
        looseInvoices: [
          ...loose.filter((inv) => inv.consortiumId === c.id).map((inv) => toLoose(inv, null)),
          ...carriedOut
            .filter((inv) => inv.consortiumId === c.id && inv.carriedFromPeriodId === period?.id)
            .map((inv) => toLoose(inv, inv.period ? periodLabel(inv.period.year, inv.period.month) : null)),
        ],
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: sin errores. Si `obligation: null` no tipa, usar `obligation: { is: null }`.

---

### Task 5: `syncObligationsForClient` — vínculo retroactivo en todos los períodos activos

**Files:**
- Modify: `src/services/obligation.service.ts:209-255`
- Test: `src/services/obligation.service.test.ts`

- [ ] **Step 1: Test que falla**

Agregar dentro del `describe("syncObligationsForClient")`:
```ts
  it("revincula una boleta suelta a una obligación PENDING aunque no haya creado nada (la principal se borró)", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "per1", consortiumId: "c1" }],
      fixedExpenses: [{ id: "fx1", consortiumId: "c1", providerId: "p1", lspServiceId: null }],
      existing: [{ periodId: "per1", fixedExpenseId: "fx1", invoiceId: null }],
      fresh: [{ id: "ob1", periodId: "per1", fixedExpenseId: "fx1" }],
      invoices: [{ id: "inv2", periodId: "per1", providerId: "p1", lspServiceId: null }],
    });

    const res = await syncObligationsForClient("cl1", fake.client);

    expect(res.created).toBe(0);
    expect(res.linked).toBe(1);
    expect(fake.createdMany).toHaveLength(0);
    expect(fake.updated[0]).toMatchObject({ where: { id: "ob1" }, data: { status: "RECEIVED", invoiceId: "inv2" } });
  });
```

- [ ] **Step 2: Correr y ver que falla**

Run: `npx vitest run src/services/obligation.service.test.ts`
Expected: FAIL — `linked` es 0 (el early return corta antes del vínculo).

- [ ] **Step 3: Implementar**

Reemplazar desde `if (toCreate.length === 0) return ...` hasta el `return` final por:
```ts
  if (toCreate.length > 0) {
    await prisma.expenseObligation.createMany({ data: toCreate, skipDuplicates: true });
  }

  // Vínculo retroactivo en TODOS los períodos activos, no sólo donde se creó
  // algo: si la principal se borró, la obligación volvió a PENDING y la
  // siguiente boleta del proveedor (que estaba como adicional) tiene que subir
  // acá, porque el pipeline no la reprocesa. En régimen normal no hay PENDING
  // con boleta suelta y esto no hace ningún update.
  const fresh = await prisma.expenseObligation.findMany({
    where: { periodId: { in: periodIds }, status: "PENDING", invoiceId: null },
    select: { id: true, periodId: true, fixedExpenseId: true },
  });

  if (fresh.length === 0) return { created: toCreate.length, linked: 0, periods: periods.length };

  const invoices = await prisma.invoice.findMany({
    // Mismo motivo que en `generateObligationsForPeriod`: una boleta arrastrada
    // ya tiene su obligación en el período de origen.
    where: { periodId: { in: periodIds }, carriedFromPeriodId: null },
    select: { id: true, periodId: true, providerId: true, lspServiceId: true, docKind: true },
  });

  const fxById = new Map(fixedExpenses.map((fx) => [fx.id, fx]));
  let linked = 0;

  for (const ob of fresh) {
    const fx = fxById.get(ob.fixedExpenseId);
    if (!fx) continue;

    const match = invoices.find(
      (inv) =>
        inv.periodId === ob.periodId &&
        !takenInvoiceIds.has(inv.id) &&
        obligationMatchesInvoice(
          { providerId: fx.providerId, lspServiceId: fx.lspServiceId, kind: fx.kind },
          { providerId: inv.providerId, lspServiceId: inv.lspServiceId, docKind: inv.docKind }
        )
    );
    if (!match) continue;

    await prisma.expenseObligation.update({
      where: { id: ob.id },
      data: { status: "RECEIVED", invoiceId: match.id },
    });
    takenInvoiceIds.add(match.id);
    linked++;
  }

  return { created: toCreate.length, linked, periods: periods.length };
```
Borrar la variable `touchedPeriodIds`. Actualizar el docblock de la función: "Son ~6 queries en total" y una línea sobre el vínculo retroactivo en todos los períodos (spec 2026-09-18).

- [ ] **Step 4: Correr los tests del service**

Run: `npx vitest run src/services/obligation.service.test.ts`
Expected: PASS (incluido "es idempotente: si no falta nada, no escribe", cuyo `fresh` por defecto es `[]`).

---

### Task 6: Documentación

**Files:**
- Modify: `docs/progreso.md` (cabecera → sesión 69; sección nueva bajo la del padrón; tablero: fila de "N boletas por obligación" → ✅)
- Modify: `docs/decisiones.md` (entrada `## 2026-09-18 — Las boletas de más se derivan, no se registran`)
- Modify: `CHANGELOG.md` (`### Added` bajo Unreleased)
- Modify: `CLAUDE.md` (bloque `ExpenseObligation` del schema y sección de UI `/admin/obligaciones`)

- [ ] **Step 1: `docs/decisiones.md`** — entrada con Problema (2ª boleta invisible; eventuales invisibles), Decisión (derivado en lectura: `obligation: null` + `obligationMatchesInvoice` en `sheetModel`; extras sólo de gastos fijos activos; sin estado propio; sync revincula en todos los períodos), Alternativas descartadas (obligación por extra; tabla puente), Impacto (archivos de la tabla del plan).

- [ ] **Step 2: `docs/progreso.md`** — sección "## 📄 Adicionales y otras boletas del mes en la hoja (2026-09-18)" con qué se ve ahora, cómo se prueba, y qué queda (CUITs hermanos → ítem 9). Actualizar la lista de "próximas funcionalidades" de la sección del padrón: 1 ✅.

- [ ] **Step 3: `CHANGELOG.md`** — bullet "Hoja de obligaciones: boletas adicionales del mismo proveedor debajo de su fila y bloque «Otras boletas del mes»; PDF del banco incluye ambas; Sincronizar obligaciones revincula en todos los períodos activos".

- [ ] **Step 4: `CLAUDE.md`** — en `ExpenseObligation`: "una obligación = UNA boleta principal (la primera que llega); las demás del mismo proveedor y las de proveedores sin gasto fijo se **derivan en lectura** (`obligation: null`) y se muestran como adicionales / «Otras boletas del mes» (spec 2026-09-18)". En la sección de `/admin/obligaciones`: una línea sobre los dos bloques.

---

### Task 7: Verificación completa + smoke en el navegador

- [ ] **Step 1: Suite completa**

Run: `npx vitest run`
Expected: todo verde.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck` y `npm run lint`
Expected: sin errores.

- [ ] **Step 3: Dev server**

`preview_start { name: "web" }` (puerto 3100, ya configurado en `.claude/launch.json`). Ir a `/admin/obligaciones`, mes en curso. Buscar un edificio con dos boletas del mismo proveedor (QBICAR, OLIVERI, CIMEX) o el Edificio de Prueba. Verificar:
- subfila `↳ 2ª boleta` con monto y ojo del PDF;
- bloque "Otras boletas del mes" si el edificio tiene boletas de proveedores sin gasto fijo;
- `read_console_messages` sin errores; `read_network_requests` del overview con `looseInvoices` poblado;
- Descargar PDF: la subfila y el bloque salen.

- [ ] **Step 4: Avisar "listo para commitear"** con la lista de archivos tocados. Sin `git add`, sin commit.
