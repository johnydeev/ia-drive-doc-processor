# Rubros y coeficientes — Parte 2: la hoja de obligaciones por rubro

> **Para quien ejecute esto:** REQUIRED SUB-SKILL: superpowers:executing-plans (o subagent-driven-development).
> Los pasos usan checkbox (`- [ ]`).
> **Este repo NO se commitea desde Claude.** Donde un plan normal dice "commit", acá dice "verificar y
> avisar al owner". Cada commit a `master` es un deploy real.
> **Claude no levanta el servidor de desarrollo:** el `.env` local apunta a producción (ver
> `docs/superpowers/plans/2026-09-26-separar-entornos-dev-prod.md`). La verificación en navegador la
> hace el owner después del deploy, sobre el "Edificio de Prueba".

**Objetivo:** que la hoja de obligaciones (pantalla y PDF del banco) se lea como la liquidación:
secciones por rubro en su orden, el monto en la columna de su coeficiente, total por rubro y del mes,
y el bloque "Sin rubro" plegado al final.

**Arquitectura:** el overview suma los rubros/coeficientes del edificio y la etiqueta de cada gasto
fijo y boleta. `sheetModel` sigue siendo la única fuente: `buildSheets` etiqueta cada fila y una
función pura nueva, `groupByRubro`, arma las secciones con sus totales; pantalla y PDF la consumen
igual. La edición en la fila escribe gasto fijo y boleta en un endpoint nuevo, en una transacción.

**Stack:** Next.js 16 (App Router), Prisma, Vitest (`.test.ts` node / `.test.tsx` jsdom), React 19,
jspdf + jspdf-autotable (import dinámico).

**Spec:** `docs/superpowers/specs/2026-09-24-rubros-y-coeficientes-design.md` — secciones "La hoja de
obligaciones", "Edición inline" y "El PDF del banco".

---

## Decisiones tomadas al planificar (confirmar o corregir antes de ejecutar)

| # | Decisión | Por qué |
|---|---|---|
| D1 | **"Sin rubro" plegado por defecto**, con su cantidad en el botón. Excepción: si el edificio no tiene NINGÚN rubro asignado, arranca desplegado. | Pedido del owner (2026-09-27): no alargar la hoja. La excepción evita que un cliente sin rubros vea la hoja vacía. |
| D2 | Al imprimir (`@media print`) y en el PDF, "Sin rubro" sale **desplegado** como sección `SIN RUBRO`. | Son pagos reales del mes: no pueden faltar en el papel. |
| D3 | En pantalla se muestran **todos** los rubros asignados aunque estén vacíos (checklist del mes, como pide el spec). En el **PDF se omiten las secciones vacías**. | 11 secciones vacías en un A4 son papel sin información. |
| D4 | La etiqueta que vale para una fila es **la de su boleta del mes si la tiene; si no, la del gasto fijo**. | Las boletas vinculadas antes del 2026-09-27 no tienen rubro (el copiado es al vincular); así igual caen en su sección. |
| D5 | El editor de rubro/coeficiente va **al principio de la celda de acciones** (no en una columna nueva). | Las acciones ya se esconden al imprimir: el editor también, sin CSS extra. |
| D6 | Las boletas eventuales (ex "Otras boletas del mes") entran en su rubro con un distintivo **`eventual`**; sin rubro, van a "Sin rubro". El bloque "Otras boletas del mes" desaparece. | Spec. |
| D7 | Las adicionales (`↳ 2ª boleta`) suman en la columna del coeficiente **de su madre**. | Cuelgan de la fila madre; no tienen obligación propia ni etiqueta copiada. |
| D8 | Los importes de las columnas de coeficiente y de los totales van **sin el signo `$`** (`118.000,00`), en pantalla y en el PDF (8 pt). El `1° pago / 2° pago` de las arrastradas conserva el `$`. | Con 4 columnas (A, B, C, EXTRA) cada una tiene 104 px en pantalla y 20 mm en el papel: con `$` no entra un monto de millones. El encabezado COEFICIENTE ya dice que son importes. |
| D9 | Un edificio sin coeficientes asignados usa una columna única **`MONTO`** (`FALLBACK_COLUMN`). | Cliente sin catálogo: la hoja se ve como antes. |
| D10 | "Vienen del mes anterior" queda como bloque aparte, con su monto en la **primera** columna, y su concepto dice **qué gasto fijo arrastra** (`EDESUR S.A. — PORTERIA`, `X — Retención`). | Spec: es deuda arrastrada, no un gasto del mes; "suma la aclaración de qué gasto fijo arrastra". |
| D11 | Los gastos fijos **desactivados** siguen en su bloque plegado "Desactivados (N)", **fuera** de las secciones (el spec los ponía al final de cada rubro). | Decisión del owner (2026-09-27): el bloque ya existe, está testeado y la impresión lo esconde entero; meterlos en cada rubro alarga la hoja con lo que no se paga. |
| D12 | Una fila **pendiente** (sin boleta) muestra **`—`** en la columna de su coeficiente, en pantalla y en el PDF. | Spec: "marca su coeficiente con la celda vacía". En el papel indica dónde se anota el monto a mano. |
| D13 | Con una **búsqueda activa** no se muestran los rubros vacíos. | Buscar "EDESUR" y ver 10 secciones vacías alrededor es ruido. |

**Fuera de este plan:** `tipoGasto = EXTRAORDINARIO` → columna `EXTRA` automática; columnas puntuales de
prorrateo (Aguinaldo, Adicional…); el prorrateo por unidad funcional.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/app/api/client/obligations/overview/route.ts` | Modificar: rubros y coeficientes del edificio + etiqueta de gasto fijo, boleta vinculada y boletas sueltas |
| `src/app/admin/obligaciones/lib/sheetModel.ts` | Modificar: tipos nuevos, etiqueta por fila, `groupByRubro`, `grandTotals`, `columnIndex`; se eliminan `compareRows` y `GROUP_RANK` |
| `src/app/admin/obligaciones/lib/sheetModel.test.ts` | Modificar: tests nuevos del agrupado; se borran los del orden viejo |
| `src/lib/rubroAssignment.ts` (+ `.test.ts`) | Modificar: `labelData` (qué campos escribe la edición) |
| `src/services/labelAssignment.service.ts` (+ `.test.ts`) | Crear: `validateLabels`, la validación contra el edificio que comparten los dos endpoints |
| `src/app/api/client/labels/route.ts` | Crear: `PATCH` que escribe rubro/coeficiente en gasto fijo y boleta, validado contra el edificio |
| `src/app/api/client/consortiums/[id]/fixed-expenses/[fxId]/route.ts` | Modificar: usa `validateLabels` en lugar de la validación en línea |
| `src/app/admin/obligaciones/hooks/useObligationsOverview.ts` | Modificar: `setLabels` |
| `src/app/admin/obligaciones/components/LabelEditor.tsx` (+ `.test.tsx`) | Crear: el control "3 · A" de la fila |
| `src/app/admin/obligaciones/components/SheetCard.tsx` | Reescribir: secciones, columnas de coeficiente, totales, "Sin rubro" plegado |
| `src/app/admin/obligaciones/components/SheetCard.test.tsx` | Modificar: fixture y tests del bloque "otras" |
| `src/app/admin/obligaciones/page.module.css` | Modificar: estilos de secciones, totales, distintivo, editor, impresión |
| `src/app/admin/obligaciones/lib/sheetPdf.ts` (+ `.test.ts`) | Reescribir: secciones, encabezado de dos niveles, anchos por cantidad de coeficientes |
| `src/app/admin/obligaciones/page.tsx` | Modificar: pasar `onSetLabels` |

---

## Supuestos verificados contra el código (2026-09-27)

| Supuesto | Estado |
|---|---|
| `Consortium.rubros` → `ConsortiumRubro.rubro`; `Consortium.coeficientes` → `ConsortiumCoeficiente.coeficiente` | ✅ schema |
| `Invoice.rubroId` / `Invoice.coeficienteId` existen | ✅ schema (`rubroRef`, `coeficienteRef`) |
| `FixedExpense.rubroId` / `coeficienteId` existen y están cargados (704/749 con rubro) | ✅ producción, 27/09 |
| `withClientAuth` sirve para rutas sin `[id]`; `apiError(err, status<500)` muestra el mensaje | ✅ `src/lib/apiHandler.ts` |
| `checkAssignable` existe y está testeado | ✅ `src/lib/rubroAssignment.ts` |
| Los fixtures de `sheetModel.test.ts` construyen `OverviewPayload` sin rubros | ✅ → los campos nuevos del overview son **opcionales** |
| Tests que dependen del orden viejo: `ordena: con boleta arriba…`, `manda los desactivados al final…`, el describe `orden de la hoja: dos niveles` (sus `it` 1° y 4°) | ✅ se borran en la Tarea 2 |
| `SheetCard.test.tsx` busca el encabezado `MONTO` y el bloque `Otras boletas del mes` | ✅ se reemplazan en la Tarea 6 |
| `sheetPdf.test.ts` usa índices de fila fijos y `OTHERS_TITLE` | ✅ se reescribe en la Tarea 7 |

---

### Tarea 1: El overview trae rubros, coeficientes y etiquetas

**Files:**
- Modify: `src/app/api/client/obligations/overview/route.ts`

- [ ] **Paso 1: Pedir los rubros y coeficientes del edificio y la etiqueta del gasto fijo**

En el `select` de `prisma.consortium.findMany`, agregar después de `lspServices: {…},`:

```ts
      // Rubros y coeficientes que usa el edificio (spec 2026-09-24): arman las
      // secciones y las columnas de la hoja.
      rubros: { select: { rubro: { select: { id: true, order: true, name: true } } } },
      coeficientes: { select: { coeficiente: { select: { id: true, code: true } } } },
```

y en `fixedExpenses.select` sumar `rubroId: true, coeficienteId: true`:

```ts
      fixedExpenses: {
        select: {
          id: true, providerId: true, lspServiceId: true, description: true, kind: true, active: true,
          rubroId: true, coeficienteId: true,
        },
      },
```

- [ ] **Paso 2: La etiqueta de la boleta vinculada y de las sueltas**

En `obligations` → `invoice.select`, sumar `rubroId: true, coeficienteId: true`:

```ts
          invoice: {
            select: {
              id: true, amount: true, sourceFileUrl: true, carryOverRequestedAt: true, carriedFromPeriodId: true,
              rubroId: true, coeficienteId: true,
            },
          },
```

En `looseSelect`, agregar `rubroId: true, coeficienteId: true,` en la primera línea:

```ts
  const looseSelect = {
    id: true, consortiumId: true, periodId: true, providerId: true, lspServiceId: true,
    docKind: true, amount: true, sourceFileUrl: true, carryOverRequestedAt: true, createdAt: true,
    rubroId: true, coeficienteId: true,
    provider: true,
```

y en `toLoose`, antes de `carriedOutTo,`:

```ts
    rubroId: inv.rubroId,
    coeficienteId: inv.coeficienteId,
```

- [ ] **Paso 3: Devolverlos**

En el objeto de cada consorcio de la respuesta, después de `lspServices: c.lspServices,`:

```ts
        rubros: c.rubros.map((r) => r.rubro),
        coeficientes: c.coeficientes.map((k) => k.coeficiente),
```

En el `map` de `fixedExpenses`, después de `active: fx.active,`:

```ts
            rubroId: fx.rubroId,
            coeficienteId: fx.coeficienteId,
```

y dentro de `obligation`, después de `carriedIn: …,`:

```ts
                  /** Etiqueta propia de la boleta; manda sobre la del gasto fijo (decisión D4). */
                  invoiceRubroId: ob.invoice?.rubroId ?? null,
                  invoiceCoeficienteId: ob.invoice?.coeficienteId ?? null,
```

- [ ] **Paso 4: Qué gasto fijo arrastra cada boleta del mes anterior (D10)**

En la consulta `carried`, reemplazar las dos líneas de `providerRef` / `lspServiceRef` del `select` por:

```ts
          docKind: true,
          providerRef: { select: { canonicalName: true, paymentAlias: true } },
          lspServiceRef: { select: { clientNumber: true, providerName: true, description: true } },
```

y en la respuesta, reemplazar la línea `concepto: inv.providerRef?.canonicalName ?? inv.provider ?? "—",`
del bloque `carried` por:

```ts
            // Mismo rótulo que la fila del gasto fijo que arrastra: el servicio con su
            // descripción (EDESUR S.A. — PORTERIA) y la retención marcada. Sin esto, dos
            // EDESUR del mismo edificio no se distinguían (spec: "suma la aclaración de
            // qué gasto fijo arrastra").
            concepto:
              (inv.lspServiceRef
                ? `${inv.lspServiceRef.providerName}${inv.lspServiceRef.description ? ` — ${inv.lspServiceRef.description}` : ""}`
                : inv.providerRef?.canonicalName ?? inv.provider ?? "—") +
              (inv.docKind === "RETENCION" ? " — Retención" : ""),
```

- [ ] **Paso 5: Verificar**

Run: `npm run typecheck`
Expected: sin errores (los tipos del overview de `sheetModel` son opcionales y se amplían en la Tarea 2;
la ruta no los importa).

Avisar: "Tarea 1 lista".

---

### Tarea 2: El modelo etiqueta cada fila y agrupa por rubro

**Files:**
- Modify: `src/app/admin/obligaciones/lib/sheetModel.ts`
- Test: `src/app/admin/obligaciones/lib/sheetModel.test.ts`

- [ ] **Paso 1: Borrar los tests del orden viejo**

En `sheetModel.test.ts` borrar estos `it` completos:
- `it("ordena: con boleta arriba; después servicios antes que proveedores", …)`
- `it("manda los desactivados al final, aunque sean LSP", …)`
- dentro de `describe("orden de la hoja: dos niveles", …)`: `it("1° con boleta, 2° empleados → servicios → proveedores, …")` y `it("'otras' también: empleados → servicios → proveedores, alfabético", …)`.

Renombrar ese describe a `describe("grupo de la fila", …)` (quedan `cada fila dice su grupo` y
`un proveedor sin providerType cuenta como PROVEEDOR`).

- [ ] **Paso 2: Escribir los tests nuevos (fallan)**

Agregar al final de `sheetModel.test.ts` (y sumar `columnIndex, grandTotals, groupByRubro,
FALLBACK_COLUMN, NO_RUBRO_TITLE, PENDING_MARK, showsPendingMark, type OverviewConsortium,
type OverviewFixedExpense` al import de
`./sheetModel`). Los helpers van tipados: `npm run typecheck` también revisa los tests.

```ts
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
      fx("alfa-salt", { rubroId: "r3", obligation: ob("alfa-salt", { status: "SKIPPED" }) }),      fx("alfa-pend", { rubroId: "r3" }),
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

    const s = sheetOf(conRubros([fx("a", { rubroId: "r3", coeficienteId: "cB", obligation: recibida("a", 100) })]));
    const conExtra = { ...s, rows: [{ ...s.rows[0], extras: [
      { invoiceId: "e1", ordinal: 2, monto: 5, invoiceUrl: null, carryOverRequested: false, carriedOutTo: null },
      { invoiceId: "e2", ordinal: 3, monto: 9, invoiceUrl: null, carryOverRequested: false, carriedOutTo: "agosto 2026" },
    ] }] };
    expect(groupByRubro(conExtra)[0].totals).toEqual([0, 105]);
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
```

- [ ] **Paso 3: Correrlos y ver que fallan**

Run: `npx vitest run src/app/admin/obligaciones/lib/sheetModel.test.ts`
Expected: FAIL — `groupByRubro` / `FALLBACK_COLUMN` no existen.

- [ ] **Paso 4: Tipos nuevos en `sheetModel.ts`**

Después de `export type SheetStatus = …;` agregar:

```ts
/** Rubro que usa el edificio: el número y el nombre con los que se titula la sección. */
export type RubroInfo = { id: string; order: number | null; name: string };
/**
 * Columna de importe de la hoja (spec 2026-09-24). `id: null` = columna única de
 * respaldo para un edificio sin coeficientes asignados (decisión D9).
 */
export type CoefColumn = { id: string | null; code: string };
export const FALLBACK_COLUMN: CoefColumn = { id: null, code: "MONTO" };
export const NO_RUBRO_TITLE = "SIN RUBRO";
export const GRAND_TOTAL_LABEL = "TOTAL DEL MES";
```

En `OverviewFixedExpense`, después de `active: boolean;`:

```ts
  /** Etiqueta del gasto fijo. Opcional: payloads viejos / fixtures de test no la traen. */
  rubroId?: string | null;
  coeficienteId?: string | null;
```

y dentro de su `obligation`, después de `invoiceUrl: string | null;`:

```ts
    /** Etiqueta propia de la boleta vinculada; manda sobre la del gasto fijo (D4). */
    invoiceRubroId?: string | null;
    invoiceCoeficienteId?: string | null;
```

En `OverviewLooseInvoice`, después de `carriedOutTo: string | null;`:

```ts
  rubroId?: string | null;
  coeficienteId?: string | null;
```

En `OverviewConsortium`, después de `looseInvoices?: OverviewLooseInvoice[];`:

```ts
  /** Rubros y coeficientes que usa el edificio. Ausentes → sin secciones / columna MONTO. */
  rubros?: RubroInfo[];
  coeficientes?: Array<{ id: string; code: string }>;
```

En `OtherRow` y en `SheetRow`, después de `group: RowGroup;`:

```ts
  /** Rubro y coeficiente que valen para esta fila (D4). Ausentes = sin etiqueta. */
  rubroId?: string | null;
  coeficienteId?: string | null;
```

En `SheetData`, después de `others: OtherRow[];`:

```ts
  /** Rubros del edificio en orden de impresión: son las secciones. */
  rubros: RubroInfo[];
  /** Columnas de importe, por código (A, B, C, EXTRA). Nunca vacío: ver FALLBACK_COLUMN. */
  coefColumns: CoefColumn[];
```

Y agregar, después de `SheetData`:

```ts
/** Lo que va dentro de una sección: una fila del padrón o una boleta eventual (D6). */
export type SectionItem = { kind: "row"; row: SheetRow } | { kind: "other"; other: OtherRow };

export type RubroSection = {
  /** null = "Sin rubro". */
  rubroId: string | null;
  /** "3 SERVICIOS PÚBLICOS" */
  title: string;
  /** "TOTAL RUBRO 3" — como en la liquidación. */
  totalLabel: string;
  items: SectionItem[];
  /** Un total por columna, en el orden de `coefColumns`. */
  totals: number[];
};
```

- [ ] **Paso 5: Sacar el orden viejo y etiquetar las filas**

Borrar `GROUP_RANK` y `compareRows` completos (y su comentario). `groupOf` se queda (lo usa
`facturasLabel` vía `group`).

En `buildSheets`:

1. En el `others.push({…})`, después de `carriedOutTo: inv.carriedOutTo,`:

```ts
          rubroId: inv.rubroId ?? null,
          coeficienteId: inv.coeficienteId ?? null,
```

2. Reemplazar el `others.sort(…)` por:

```ts
    // El orden de verdad lo pone `groupByRubro` dentro de cada sección.
    others.sort((a, b) => a.concepto.localeCompare(b.concepto, "es"));
```

3. En el objeto que devuelve `c.fixedExpenses.map`, después de `group: groupOf(…),`:

```ts
        rubroId: fx.obligation?.invoiceRubroId ?? fx.rubroId ?? null,
        coeficienteId: fx.obligation?.invoiceCoeficienteId ?? fx.coeficienteId ?? null,
```

4. Reemplazar `rows.sort(compareRows);` por:

```ts
    rows.sort((a, b) => a.concepto.localeCompare(b.concepto, "es"));
```

5. En el `return { … }` de cada hoja, después de `others,`:

```ts
      rubros: sortRubros(c.rubros ?? []),
      coefColumns: toColumns(c.coeficientes ?? []),
```

- [ ] **Paso 6: Las funciones de agrupado**

Agregar antes de `export function buildSheets`:

```ts
/** Número ascendente; los rubros sin número al final, alfabéticos. */
function sortRubros(rubros: RubroInfo[]): RubroInfo[] {
  return [...rubros].sort((a, b) => {
    if (a.order == null && b.order != null) return 1;
    if (a.order != null && b.order == null) return -1;
    return (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, "es");
  });
}

/** Columnas por código (A, B, C, EXTRA); sin coeficientes, la columna única MONTO. */
function toColumns(coefs: Array<{ id: string; code: string }>): CoefColumn[] {
  if (coefs.length === 0) return [FALLBACK_COLUMN];
  return [...coefs].sort((a, b) => a.code.localeCompare(b.code, "es")).map((k) => ({ id: k.id, code: k.code }));
}

/** En qué columna va el importe: la de su coeficiente, o la primera si no tiene (spec). */
export function columnIndex(columns: CoefColumn[], coeficienteId: string | null | undefined): number {
  const i = columns.findIndex((c) => c.id !== null && c.id === coeficienteId);
  return i >= 0 ? i : 0;
}

export function rubroTitle(r: RubroInfo): string {
  return r.order != null ? `${r.order} ${r.name}` : r.name;
}

/** Marca de la celda de una fila pendiente (D12): dónde va a caer el monto. */
export const PENDING_MARK = "—";

/** ¿La fila lleva la marca de pendiente en su columna? Fuente única de pantalla y PDF. */
export function showsPendingMark(row: SheetRow): boolean {
  return row.active && row.status === "PENDING" && !row.invoiceId && row.monto == null;
}
```

Y agregar al final del archivo:

```ts
/** Tramo dentro de la sección: con boleta (0), pendiente (1), salteada (2). Una eventual siempre trae boleta. */
function itemTier(item: SectionItem): number {
  if (item.kind === "other") return 0;
  if (item.row.status === "SKIPPED") return 2;
  return item.row.invoiceId || item.row.monto != null ? 0 : 1;
}

function itemConcepto(item: SectionItem): string {
  return item.kind === "row" ? item.row.concepto : item.other.concepto;
}

/**
 * La hoja en secciones de rubro, como la liquidación (spec 2026-09-24, Parte 2).
 *
 * - Una sección por rubro asignado al edificio, en su orden, aunque esté vacía:
 *   es el checklist del mes (el PDF omite las vacías, decisión D3).
 * - "Sin rubro" al final, sólo si tiene algo: lo que no tiene rubro y lo que tiene
 *   uno que el edificio ya no usa.
 * - Los desactivados no entran: viven en su bloque plegado.
 * - Totales por columna de coeficiente; una fila sin coeficiente suma en la primera;
 *   las adicionales en la columna de su madre (D7); lo que pasó a otro mes no suma.
 *
 * Pura: la consumen la pantalla y el PDF, así ven exactamente lo mismo.
 */
export function groupByRubro(sheet: SheetData): RubroSection[] {
  const columns = sheet.coefColumns.length > 0 ? sheet.coefColumns : [FALLBACK_COLUMN];
  const assigned = new Set(sheet.rubros.map((r) => r.id));
  const buckets = new Map<string | null, SectionItem[]>();
  const put = (rubroId: string | null | undefined, item: SectionItem) => {
    const key = rubroId && assigned.has(rubroId) ? rubroId : null;
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  };
  for (const row of sheet.rows) if (row.active) put(row.rubroId, { kind: "row", row });
  for (const other of sheet.others) put(other.rubroId, { kind: "other", other });

  const sortItems = (items: SectionItem[]) =>
    [...items].sort((a, b) => itemTier(a) - itemTier(b) || itemConcepto(a).localeCompare(itemConcepto(b), "es"));

  const totalsOf = (items: SectionItem[]) => {
    const totals = columns.map(() => 0);
    for (const item of items) {
      if (item.kind === "row") {
        const col = columnIndex(columns, item.row.coeficienteId);
        if (item.row.monto != null) totals[col] += item.row.monto;
        for (const e of item.row.extras) if (!e.carriedOutTo && e.monto != null) totals[col] += e.monto;
      } else if (!item.other.carriedOutTo && item.other.monto != null) {
        totals[columnIndex(columns, item.other.coeficienteId)] += item.other.monto;
      }
    }
    return totals;
  };

  const sections: RubroSection[] = sheet.rubros.map((r) => {
    const items = sortItems(buckets.get(r.id) ?? []);
    return {
      rubroId: r.id,
      title: rubroTitle(r),
      totalLabel: r.order != null ? `TOTAL RUBRO ${r.order}` : `TOTAL ${r.name}`,
      items,
      totals: totalsOf(items),
    };
  });

  const sinRubro = buckets.get(null) ?? [];
  if (sinRubro.length > 0) {
    const items = sortItems(sinRubro);
    sections.push({
      rubroId: null, title: NO_RUBRO_TITLE, totalLabel: `TOTAL ${NO_RUBRO_TITLE}`, items, totals: totalsOf(items),
    });
  }
  return sections;
}

/** Total del mes, columna por columna. */
export function grandTotals(sections: RubroSection[], columnCount: number): number[] {
  const totals = Array.from({ length: Math.max(1, columnCount) }, () => 0);
  for (const s of sections) s.totals.forEach((t, i) => { totals[i] += t; });
  return totals;
}
```

- [ ] **Paso 7: Correr los tests**

Run: `npx vitest run src/app/admin/obligaciones/lib/sheetModel.test.ts`
Expected: PASS, todos (los viejos que quedan y los nuevos).

- [ ] **Paso 8: Verificar y avisar**

Run: `npm run typecheck`
Expected: errores SÓLO en `SheetCard.test.tsx` y `sheetPdf.test.ts` (fixtures de `SheetData` sin
`rubros`/`coefColumns`): se arreglan en las Tareas 6 y 7. Ningún error en código de producción.

Avisar: "Tarea 2 lista".

---

### Tarea 3: Endpoint para editar la etiqueta desde la hoja

**Files:**
- Modify: `src/lib/rubroAssignment.ts`, `src/lib/rubroAssignment.test.ts`
- Create: `src/app/api/client/labels/route.ts`

- [ ] **Paso 1: Test de `labelData` (falla)**

Agregar a `src/lib/rubroAssignment.test.ts` (y `labelData` al import):

```ts
describe("labelData", () => {
  it("sólo escribe los campos que vinieron; null desasigna", () => {
    expect(labelData({ rubroId: "r3" })).toEqual({ rubroId: "r3" });
    expect(labelData({ coeficienteId: null })).toEqual({ coeficienteId: null });
    expect(labelData({ rubroId: "r3", coeficienteId: "cA" })).toEqual({ rubroId: "r3", coeficienteId: "cA" });
  });

  it("sin campos no escribe nada", () => {
    expect(labelData({})).toEqual({});
  });
});
```

Run: `npx vitest run src/lib/rubroAssignment.test.ts` → FAIL (`labelData` no existe).

- [ ] **Paso 2: Implementar `labelData`**

Agregar al final de `src/lib/rubroAssignment.ts`:

```ts
/**
 * Qué escribe la edición de rubro/coeficiente de una fila. `undefined` = no se tocó
 * (no se escribe); `null` = desasignar. Mismo criterio en gasto fijo y boleta.
 */
export function labelData(p: { rubroId?: string | null; coeficienteId?: string | null }): {
  rubroId?: string | null;
  coeficienteId?: string | null;
} {
  return {
    ...(p.rubroId !== undefined ? { rubroId: p.rubroId } : {}),
    ...(p.coeficienteId !== undefined ? { coeficienteId: p.coeficienteId } : {}),
  };
}
```

Run: `npx vitest run src/lib/rubroAssignment.test.ts` → PASS.

- [ ] **Paso 3: La validación contra el edificio, en un solo lugar**

Hoy el `PATCH` de `fixed-expenses/[fxId]` trae lo asignado al edificio y llama a `checkAssignable` en
línea; el endpoint nuevo necesita exactamente lo mismo. Se saca a un servicio compartido.

Test primero — crear `src/services/labelAssignment.service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateLabels } from "./labelAssignment.service";

function fakePrisma(rubroIds: string[], coeficienteIds: string[]) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      consortiumRubro: { findMany: async () => { calls.push("rubro"); return rubroIds.map((rubroId) => ({ rubroId })); } },
      consortiumCoeficiente: { findMany: async () => { calls.push("coef"); return coeficienteIds.map((coeficienteId) => ({ coeficienteId })); } },
    } as any,
  };
}

describe("validateLabels", () => {
  it("acepta lo que el edificio tiene asignado", async () => {
    const f = fakePrisma(["r3"], ["cA"]);
    expect(await validateLabels(f.client, "c1", { rubroId: "r3", coeficienteId: "cA" })).toBeNull();
  });

  it("rechaza un rubro ajeno al edificio con el mensaje de checkAssignable", async () => {
    const f = fakePrisma(["r3"], ["cA"]);
    expect(await validateLabels(f.client, "c1", { rubroId: "r9" })).toBe("Ese rubro no está asignado a este edificio");
  });

  it("rechaza un coeficiente ajeno", async () => {
    const f = fakePrisma([], ["cA"]);
    expect(await validateLabels(f.client, "c1", { coeficienteId: "cZ" })).toBe("Ese coeficiente no está asignado a este edificio");
  });

  it("sólo consulta lo que vino: sin coeficiente no toca ConsortiumCoeficiente", async () => {
    const f = fakePrisma(["r3"], []);
    await validateLabels(f.client, "c1", { rubroId: null });
    expect(f.calls).toEqual(["rubro"]);
  });
});
```

Run: `npx vitest run src/services/labelAssignment.service.test.ts` → FAIL.

Crear `src/services/labelAssignment.service.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import { checkAssignable } from "@/lib/rubroAssignment";

/**
 * ¿El rubro / coeficiente se puede poner en un gasto fijo o boleta de este edificio?
 * Devuelve el mensaje de error, o null si vale. Sólo consulta lo que viene definido
 * (`undefined` = no se toca). Lo usan el PATCH del gasto fijo y el de etiquetas.
 */
export async function validateLabels(
  prisma: PrismaClient,
  consortiumId: string,
  labels: { rubroId?: string | null; coeficienteId?: string | null }
): Promise<string | null> {
  if (labels.rubroId !== undefined) {
    const asignados = await prisma.consortiumRubro.findMany({ where: { consortiumId }, select: { rubroId: true } });
    const check = checkAssignable(labels.rubroId, asignados.map((a) => a.rubroId), "rubro");
    if (!check.ok) return check.error;
  }
  if (labels.coeficienteId !== undefined) {
    const asignados = await prisma.consortiumCoeficiente.findMany({ where: { consortiumId }, select: { coeficienteId: true } });
    const check = checkAssignable(labels.coeficienteId, asignados.map((a) => a.coeficienteId), "coeficiente");
    if (!check.ok) return check.error;
  }
  return null;
}
```

Run: `npx vitest run src/services/labelAssignment.service.test.ts` → PASS, 4 tests.

Y en `src/app/api/client/consortiums/[id]/fixed-expenses/[fxId]/route.ts`, reemplazar los dos bloques
`if (parsed.data.rubroId !== undefined) { … }` y `if (parsed.data.coeficienteId !== undefined) { … }` por:

```ts
      const error = await validateLabels(prisma, fx.consortiumId, parsed.data);
      if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
```

cambiando el import `import { checkAssignable } from "@/lib/rubroAssignment";` por
`import { validateLabels } from "@/services/labelAssignment.service";`.

- [ ] **Paso 4: El endpoint**

Crear `src/app/api/client/labels/route.ts`:

```ts
import { z } from "zod";
import { apiError, apiOk, withClientAuth } from "@/lib/apiHandler";
import { getPrismaClient } from "@/lib/prisma";
import { labelData } from "@/lib/rubroAssignment";
import { validateLabels } from "@/services/labelAssignment.service";

/**
 * Edición de rubro/coeficiente desde la hoja de obligaciones (spec 2026-09-24,
 * "Editar es corregir y también fijar").
 *
 * Con `fixedExpenseId` + `invoiceId` escribe los DOS en una transacción: la boleta
 * del mes queda corregida y el gasto fijo fija la regla para los meses que vienen
 * (las boletas anteriores no se tocan). Con sólo `invoiceId` es una eventual: no
 * hay regla que fijar. Todo se valida contra lo que el EDIFICIO tiene asignado.
 */
const schema = z
  .object({
    fixedExpenseId: z.string().optional(),
    invoiceId: z.string().optional(),
    rubroId: z.string().nullable().optional(),
    coeficienteId: z.string().nullable().optional(),
  })
  .refine((b) => b.fixedExpenseId || b.invoiceId, { message: "Falta el gasto fijo o la boleta" })
  .refine((b) => b.rubroId !== undefined || b.coeficienteId !== undefined, { message: "No hay nada para cambiar" });

export const PATCH = withClientAuth(async ({ request, session }) => {
  const body = schema.parse(await request.json());
  const prisma = getPrismaClient();
  const clientId = session.clientId;

  const fx = body.fixedExpenseId
    ? await prisma.fixedExpense.findFirst({
        where: { id: body.fixedExpenseId, clientId },
        select: { id: true, consortiumId: true },
      })
    : null;
  if (body.fixedExpenseId && !fx) return apiError(new Error("Gasto fijo no encontrado"), 404);

  const inv = body.invoiceId
    ? await prisma.invoice.findFirst({
        where: { id: body.invoiceId, clientId },
        select: { id: true, consortiumId: true },
      })
    : null;
  if (body.invoiceId && !inv) return apiError(new Error("Boleta no encontrada"), 404);

  if (fx && inv && inv.consortiumId && fx.consortiumId !== inv.consortiumId) {
    return apiError(new Error("La boleta y el gasto fijo son de edificios distintos"), 400);
  }
  const consortiumId = fx?.consortiumId ?? inv?.consortiumId ?? null;
  if (!consortiumId) return apiError(new Error("La boleta no tiene edificio asignado"), 400);

  const invalid = await validateLabels(prisma, consortiumId, body);
  if (invalid) return apiError(new Error(invalid), 400);

  const data = labelData(body);
  await prisma.$transaction(async (tx) => {
    if (fx) await tx.fixedExpense.update({ where: { id: fx.id }, data });
    if (inv) await tx.invoice.update({ where: { id: inv.id }, data });
  });

  return apiOk({});
});
```

- [ ] **Paso 5: Verificar y avisar**

Run: `npm run typecheck`, `npm run lint` y `npx vitest run src/lib src/services`
Expected: sin errores nuevos; PASS. (La deuda de tests de handler es la misma de la Parte 1: la decisión
vive en `checkAssignable`, `labelData` y `validateLabels`, que están testeadas.)

Avisar: "Tarea 3 lista".

---

### Tarea 4: `setLabels` en el hook

**Files:**
- Modify: `src/app/admin/obligaciones/hooks/useObligationsOverview.ts`

- [ ] **Paso 1: Agregar la mutación**

Después de `setObligationStatus` (antes de `goToPreviousMonth`):

```ts
  /**
   * Rubro y coeficiente de una fila. Con gasto fijo + boleta escribe los dos (la
   * boleta del mes y la regla hacia adelante); con sólo boleta, una eventual.
   */
  const setLabels = useCallback(
    async (
      target: { fixedExpenseId?: string; invoiceId?: string },
      labels: { rubroId: string | null; coeficienteId: string | null }
    ) => {
      try {
        const res = await guardedFetch("/api/client/labels", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...target, ...labels }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo cambiar el rubro");
      }
      await loadOverview();
    },
    [guardedFetch, loadOverview]
  );
```

y sumar `setLabels,` al objeto que devuelve el hook (después de `setLateAmount,`).

- [ ] **Paso 2: Verificar**

Run: `npx vitest run src/app/admin/obligaciones/hooks` y `npm run typecheck`
Expected: PASS; sin errores nuevos.

Avisar: "Tarea 4 lista".

---

### Tarea 5: El control de la fila (`LabelEditor`)

**Files:**
- Create: `src/app/admin/obligaciones/components/LabelEditor.tsx`
- Test: `src/app/admin/obligaciones/components/LabelEditor.test.tsx`

- [ ] **Paso 1: Tests (fallan)**

Crear `LabelEditor.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LabelEditor } from "./LabelEditor";

const rubros = [
  { id: "r3", order: 3, name: "SERVICIOS PÚBLICOS" },
  { id: "r4", order: 4, name: "ABONOS DE SERVICIOS" },
];
const coefColumns = [{ id: "cA", code: "A" }, { id: "cB", code: "B" }];

function setup(value = { rubroId: "r3", coeficienteId: "cA" }, onSave = vi.fn()) {
  render(<LabelEditor rubros={rubros} coefColumns={coefColumns} value={value} concepto="EDESUR" onSave={onSave} />);
  return onSave;
}

describe("LabelEditor", () => {
  it("cargado muestra número de rubro y código de coeficiente", () => {
    setup();
    expect(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i })).toHaveTextContent("3 · A");
  });

  it("vacío muestra 'Rubro · Coef'", () => {
    setup({ rubroId: null, coeficienteId: null });
    expect(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i })).toHaveTextContent("Rubro · Coef");
  });

  it("al editar ofrece sólo lo del edificio y guarda lo elegido", async () => {
    const onSave = setup();
    await userEvent.click(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i }));
    await userEvent.selectOptions(screen.getByLabelText("Rubro de EDESUR"), "r4");
    await userEvent.selectOptions(screen.getByLabelText("Coeficiente de EDESUR"), "cB");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSave).toHaveBeenCalledWith({ rubroId: "r4", coeficienteId: "cB" });
  });

  it("elegir 'Sin rubro' manda null", async () => {
    const onSave = setup();
    await userEvent.click(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i }));
    await userEvent.selectOptions(screen.getByLabelText("Rubro de EDESUR"), "");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSave).toHaveBeenCalledWith({ rubroId: null, coeficienteId: "cA" });
  });

  it("cancelar no guarda", async () => {
    const onSave = setup();
    await userEvent.click(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i })).toBeInTheDocument();
  });

  it("mientras guarda, el botón se deshabilita y muestra 'Guardando…'", async () => {
    let resolve!: () => void;
    setup(undefined, vi.fn(() => new Promise<void>((r) => { resolve = r; })));
    await userEvent.click(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i }));
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    const btn = screen.getByRole("button", { name: "Guardando…" });
    expect(btn).toBeDisabled();
    await act(async () => resolve());
  });
});
```

Run: `npx vitest run src/app/admin/obligaciones/components/LabelEditor.test.tsx` → FAIL (no existe).

- [ ] **Paso 2: Implementación**

Crear `LabelEditor.tsx`:

```tsx
"use client";

import { useState } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import type { CoefColumn, RubroInfo } from "../lib/sheetModel";

export type Labels = { rubroId: string | null; coeficienteId: string | null };
/** Qué se escribe: gasto fijo + boleta del mes, o sólo la boleta (eventual). */
export type LabelTarget = { fixedExpenseId?: string; invoiceId?: string };

type Props = {
  rubros: RubroInfo[];
  coefColumns: CoefColumn[];
  value: Labels;
  /** Nombre de la fila, para los rótulos accesibles. */
  concepto: string;
  onSave: (labels: Labels) => void | Promise<void>;
};

/**
 * Rubro y coeficiente de una fila de la hoja (spec 2026-09-24, "Edición inline").
 * Cerrado muestra "3 · A" (o "Rubro · Coef" si no tiene); abierto, dos listas con
 * lo que el EDIFICIO tiene asignado. Guardar escribe boleta y gasto fijo (lo decide
 * el llamador con el `target`).
 */
export function LabelEditor({ rubros, coefColumns, value, concepto, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [rubroId, setRubroId] = useState(value.rubroId ?? "");
  const [coeficienteId, setCoeficienteId] = useState(value.coeficienteId ?? "");

  const rubro = rubros.find((r) => r.id === value.rubroId);
  const coef = coefColumns.find((c) => c.id !== null && c.id === value.coeficienteId);
  const coefs = coefColumns.filter((c): c is { id: string; code: string } => c.id !== null);

  if (!editing) {
    return (
      <button
        type="button"
        className={styles.labelBtn}
        aria-label={`Rubro y coeficiente de ${concepto}`}
        title={rubro ? rubro.name : "Sin rubro"}
        onClick={() => {
          setRubroId(value.rubroId ?? "");
          setCoeficienteId(value.coeficienteId ?? "");
          setEditing(true);
        }}
      >
        {rubro ? rubro.order ?? rubro.name : "Rubro"} · {coef ? coef.code : "Coef"}
      </button>
    );
  }

  return (
    <span className={styles.labelEditor}>
      <select aria-label={`Rubro de ${concepto}`} value={rubroId} onChange={(e) => setRubroId(e.target.value)}>
        <option value="">Sin rubro</option>
        {rubros.map((r) => (
          <option key={r.id} value={r.id}>{r.order != null ? `${r.order} ` : ""}{r.name}</option>
        ))}
      </select>
      <select aria-label={`Coeficiente de ${concepto}`} value={coeficienteId} onChange={(e) => setCoeficienteId(e.target.value)}>
        <option value="">Sin coef.</option>
        {coefs.map((c) => (<option key={c.id} value={c.id}>{c.code}</option>))}
      </select>
      <AsyncButton
        type="button"
        className={styles.actionBtn}
        pendingLabel="Guardando…"
        onClick={async () => {
          await onSave({ rubroId: rubroId || null, coeficienteId: coeficienteId || null });
          setEditing(false);
        }}
      >
        Guardar
      </AsyncButton>
      <button type="button" className={styles.actionBtn} onClick={() => setEditing(false)}>Cancelar</button>
    </span>
  );
}
```

- [ ] **Paso 3: Correr los tests**

Run: `npx vitest run src/app/admin/obligaciones/components/LabelEditor.test.tsx`
Expected: PASS, 6 tests.

Avisar: "Tarea 5 lista".

---

### Tarea 6: La hoja en pantalla

**Files:**
- Modify (reescritura): `src/app/admin/obligaciones/components/SheetCard.tsx`
- Modify: `src/app/admin/obligaciones/components/SheetCard.test.tsx`
- Modify: `src/app/admin/obligaciones/page.module.css`
- Modify: `src/app/admin/obligaciones/page.tsx`

- [ ] **Paso 1: Actualizar el fixture de los tests**

En `SheetCard.test.tsx`, en el objeto `sheet`, después de `others: [],`:

```ts
  rubros: [{ id: "r3", order: 3, name: "SERVICIOS PÚBLICOS" }],
  coefColumns: [{ id: "cA", code: "A" }],
```

y en las TRES filas de `rows`, agregar `rubroId: "r3", coeficienteId: "cA"` (al final de cada objeto,
después de `group: …`). En `renderCard`, sumar `onSetLabels: vi.fn(),` a `props`.

- [ ] **Paso 2: Reemplazar los tests que cambian (fallan)**

Reemplazar `it("dibuja las seis columnas de la planilla", …)` por:

```tsx
  it("dibuja las columnas de la planilla, con una columna por coeficiente bajo COEFICIENTE", () => {
    renderCard();
    for (const header of ["FACTURA/NRO CLIENTE", "PROVEEDOR/SERVICIO", "A", "ALIAS - CBU", "TÉCNICO O GESTOR", "TEL. CONTACTO"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    expect(screen.getByRole("columnheader", { name: "COEFICIENTE" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "MONTO" })).toBeNull();
  });
```

Reemplazar `it("muestra el monto formateado sólo cuando la boleta llegó", …)` (el monto ahora también
aparece en `TOTAL RUBRO 3` y `TOTAL DEL MES`, y `getByText` sobre toda la tarjeta falla por repetido):

```tsx
  it("muestra el monto sólo cuando la boleta llegó, sin '$' (D8)", () => {
    renderCard();
    const edesur = screen.getByText("EDESUR").closest("tr")!;
    expect(within(edesur).getByText("118.000,00")).toBeInTheDocument();
    // SEGURO está pendiente: su celda de la columna A (índice 3) lleva la marca, no un monto (D12).
    const seguro = within(screen.getByText("SEGURO LA CAJA").closest("tr")!).getAllByRole("cell");
    expect(seguro[3].textContent).toBe("—");
    expect(seguro.map((c) => c.textContent).join("")).not.toMatch(/\$/);
  });
```

Borrar `it("sin otras no dibuja el bloque", …)`. Reemplazar
`it("las otras boletas del mes van en su bloque, con fantasía y alias, y se pueden pasar", …)` por:

```tsx
  it("una boleta eventual entra en su rubro con el distintivo 'eventual' y se puede pasar", async () => {
    const props = renderCard({ sheet: { ...sheet, others: [{ ...other(), rubroId: "r3", coeficienteId: "cA" }] } });
    const fila = screen.getByText("PLOMERO JUAN").closest("tr")!;
    expect(within(fila).getByText("eventual")).toBeInTheDocument();
    expect(within(fila).getByText("JUAN")).toBeInTheDocument();
    expect(within(fila).getByText(/32\.000/)).toBeInTheDocument();
    expect(within(fila).getByText("juan.plomero")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /otras boletas del mes/i })).toBeNull();
    await userEvent.click(within(fila).getByRole("button", { name: /mes siguiente/i }));
    expect(props.onToggleCarryOver).toHaveBeenCalledWith("o1", true);
  });
```

Reemplazar `it("las tablas comparten el mismo colgroup, …", …)` por:

```tsx
  it("la tabla de rubros y la de 'Sin rubro' comparten el mismo colgroup", () => {
    const { container } = render(
      <SheetCard sheet={{ ...sheet, others: [{ invoiceId: "o1", facturas: "77", concepto: "PLOMERO", fantasia: null,
        monto: 1, aliasCbu: [], invoiceUrl: null, carryOverRequested: false, carriedOutTo: null, group: "PROVEEDOR" }] }}
        onAdd={vi.fn()} onToggle={vi.fn()} onSetStatus={vi.fn()} onToggleCarryOver={vi.fn()}
        onUndoCarryOver={vi.fn()} onSetLateAmount={vi.fn()} />
    );
    const groups = container.querySelectorAll("table colgroup");
    expect(groups).toHaveLength(2);
    expect(groups[0].innerHTML).toBe(groups[1].innerHTML);
  });
```

Agregar al final del archivo:

```tsx
describe("secciones por rubro", () => {
  const dosRubros: SheetData = {
    ...sheet,
    rubros: [
      { id: "r3", order: 3, name: "SERVICIOS PÚBLICOS" },
      { id: "r4", order: 4, name: "ABONOS DE SERVICIOS" },
    ],
    coefColumns: [{ id: "cA", code: "A" }, { id: "cB", code: "B" }],
    rows: [
      { ...sheet.rows[0], coeficienteId: "cB" },          // EDESUR 118.000 → columna B
      { ...sheet.rows[1], rubroId: null },                 // SEGURO → Sin rubro
    ],
  };

  it("titula cada rubro con su número y cierra con su total", () => {
    renderCard({ sheet: dosRubros });
    expect(screen.getByText("3 SERVICIOS PÚBLICOS")).toBeInTheDocument();
    expect(screen.getByText("4 ABONOS DE SERVICIOS")).toBeInTheDocument();
    const total = screen.getByText("TOTAL RUBRO 3").closest("tr")!;
    const celdas = within(total).getAllByRole("cell").map((c) => c.textContent);
    expect(celdas.some((t) => /118\.000/.test(t ?? ""))).toBe(true);
  });

  it("el monto va en la columna de su coeficiente", () => {
    renderCard({ sheet: dosRubros });
    const fila = screen.getByText("EDESUR").closest("tr")!;
    const celdas = within(fila).getAllByRole("cell");
    // preview, facturas, concepto, A, B, …
    expect(celdas[3].textContent).toBe("");
    expect(celdas[4].textContent).toMatch(/118\.000/);
  });

  it("una fila pendiente marca con '—' la columna de su coeficiente (D12)", () => {
    renderCard({ sheet: { ...dosRubros, rows: [{ ...dosRubros.rows[1], rubroId: "r3", coeficienteId: "cB" }] } });
    const celdas = within(screen.getByText("SEGURO LA CAJA").closest("tr")!).getAllByRole("cell");
    expect(celdas[3].textContent).toBe("");
    expect(celdas[4].textContent).toBe("—");
  });

  it("con una búsqueda activa no muestra los rubros vacíos (D13)", () => {
    renderCard({ sheet: dosRubros, hideEmptySections: true });
    expect(screen.getByText("3 SERVICIOS PÚBLICOS")).toBeInTheDocument();
    expect(screen.queryByText("4 ABONOS DE SERVICIOS")).toBeNull();
  });

  it("'Sin rubro' arranca plegado, dice cuántos tiene y se despliega", async () => {
    renderCard({ sheet: dosRubros });
    const toggle = screen.getByRole("button", { name: /sin rubro \(1\)/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /saltear periodo/i })).toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /saltear periodo/i })).toBeInTheDocument();
  });

  it("un edificio sin rubros asignados muestra 'Sin rubro' desplegado", () => {
    renderCard({ sheet: { ...sheet, rubros: [] } });
    expect(screen.getByRole("button", { name: /sin rubro \(3\)/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("el total del mes suma todas las secciones, incluida 'Sin rubro'", () => {
    renderCard({ sheet: { ...dosRubros, rows: [dosRubros.rows[0], { ...dosRubros.rows[1], monto: 5000, invoiceId: "inv9" }] } });
    const total = screen.getByText("TOTAL DEL MES").closest("tr")!;
    const textos = within(total).getAllByRole("cell").map((c) => c.textContent ?? "");
    expect(textos.some((t) => /5\.000/.test(t))).toBe(true);
    expect(textos.some((t) => /118\.000/.test(t))).toBe(true);
  });

  it("editar el rubro de una fila con boleta escribe gasto fijo y boleta", async () => {
    const props = renderCard({ sheet: dosRubros });
    await userEvent.click(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i }));
    await userEvent.selectOptions(screen.getByLabelText("Rubro de EDESUR"), "r4");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(props.onSetLabels).toHaveBeenCalledWith(
      { fixedExpenseId: "fx1", invoiceId: "inv1" },
      { rubroId: "r4", coeficienteId: "cB" }
    );
  });

  it("en una fila sin boleta, sólo el gasto fijo", async () => {
    const props = renderCard({ sheet: { ...dosRubros, rows: [{ ...dosRubros.rows[1], rubroId: "r3" }] } });
    await userEvent.click(screen.getByRole("button", { name: /rubro y coeficiente de seguro la caja/i }));
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(props.onSetLabels).toHaveBeenCalledWith({ fixedExpenseId: "fx2" }, { rubroId: "r3", coeficienteId: "cA" });
  });
});
```

Run: `npx vitest run src/app/admin/obligaciones/components/SheetCard.test.tsx` → FAIL.

- [ ] **Paso 3: Reescribir `SheetCard.tsx`**

Reemplazar el archivo completo por:

```tsx
"use client";

import { Fragment, useState } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { PdfPreviewModal, type PdfPreview } from "@/components/PdfPreviewModal";
import { LabelEditor, type LabelTarget, type Labels } from "./LabelEditor";
import {
  columnIndex,
  facturasLabel,
  GRAND_TOTAL_LABEL,
  grandTotals,
  groupByRubro,
  hasPrintableRows,
  PENDING_MARK,
  shortClientNumber,
  showsPendingMark,
  type ExtraRow,
  type OtherRow,
  type RubroSection,
  type SheetData,
  type SheetRow,
} from "../lib/sheetModel";

type Props = {
  sheet: SheetData;
  onAdd: (consortiumId: string) => void;
  // Todas devuelven la promesa de la mutación: `AsyncButton` la espera para
  // mostrar el spinner y cortar el doble click.
  onToggle: (consortiumId: string, fixedExpenseId: string, active: boolean) => void | Promise<void>;
  onSetStatus: (obligationId: string, status: "PENDING" | "SKIPPED") => void | Promise<void>;
  /** Marca o desmarca la boleta para pasar al mes siguiente. NO la mueve. */
  onToggleCarryOver: (invoiceId: string, requested: boolean) => void | Promise<void>;
  /** Devuelve al mes de origen una boleta que YA se trasladó. */
  onUndoCarryOver: (invoiceId: string) => void | Promise<void>;
  onSetLateAmount: (invoiceId: string, lateAmount: number) => void | Promise<void>;
  /** Rubro y coeficiente de una fila. Sin handler no se ofrece la edición. */
  onSetLabels?: (target: LabelTarget, labels: Labels) => void | Promise<void>;
  /** Con una búsqueda activa no se dibujan los rubros vacíos (D13). */
  hideEmptySections?: boolean;
  /** Acordeón: la hoja está desplegada. Por defecto sí (tests, impresión). */
  open?: boolean;
  /** Click en el encabezado. El padre decide cuál queda abierta (una por vez). */
  onToggleOpen?: (consortiumId: string) => void;
};

const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
/** Importes de las columnas de coeficiente y totales: sin `$`, para que entren (D8). */
const amount = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Columnas antes de las de coeficiente (vista previa, factura, concepto) y después (alias, técnico, tel., acciones). */
const LEAD = 3;
const TRAIL = 4;

/**
 * La hoja de un edificio, en secciones de rubro como la liquidación (spec
 * 2026-09-24, Parte 2). En pantalla se ve como va a salir impresa, más las
 * acciones de fila (que la hoja de estilos de impresión esconde).
 *
 * - Cada rubro asignado es una sección, con su total; el monto va en la columna
 *   de su coeficiente (una por coeficiente del edificio).
 * - "Sin rubro" va plegado al final (pedido del owner) salvo que el edificio no
 *   tenga rubros; al imprimir sale desplegado.
 * - Las boletas eventuales entran en su rubro con el distintivo "eventual".
 * - Los desactivados siguen en su bloque plegado, fuera de las secciones.
 *
 * **No hay borrado.** Un gasto fijo que deja de corresponder se DESACTIVA: el
 * registro y sus obligaciones de todos los períodos quedan intactos, que es lo
 * que exige una rendición de cuentas o una auditoría posterior.
 */
export function SheetCard({
  sheet, onAdd, onToggle, onSetStatus, onToggleCarryOver, onUndoCarryOver, onSetLateAmount, onSetLabels,
  hideEmptySections = false, open = true, onToggleOpen,
}: Props) {
  const [lateFor, setLateFor] = useState<string | null>(null);
  const [lateValue, setLateValue] = useState("");
  const [preview, setPreview] = useState<PdfPreview | null>(null);
  // Plegado por defecto; si el edificio no tiene rubros, todo cae acá y arranca abierto.
  const [sinRubroOpen, setSinRubroOpen] = useState(sheet.rubros.length === 0);

  const columns = sheet.coefColumns;
  const totalCols = LEAD + columns.length + TRAIL;
  const hasCoefs = columns.some((c) => c.id !== null);

  const activeRows = sheet.rows.filter((r) => r.active);
  const inactiveRows = sheet.rows.filter((r) => !r.active);
  const hasItems = activeRows.length > 0 || sheet.others.length > 0;
  const sections = groupByRubro(sheet);
  const rubroSections = sections.filter((s) => s.rubroId !== null && (!hideEmptySections || s.items.length > 0));
  const sinRubro = sections.find((s) => s.rubroId === null) ?? null;
  const grand = grandTotals(sections, columns.length);

  /** Ícono de vista previa: sólo si la boleta llegó y tiene PDF. */
  const previewCell = (url: string | null, concepto: string) => (
    <td className={styles.previewCell}>
      {url && (
        <button
          type="button"
          className={styles.previewBtn}
          onClick={() => setPreview({ sourceUrl: url, title: `${concepto} — ${sheet.consortiumName}` })}
          aria-label={`Vista previa de la boleta de ${concepto}`}
          title="Vista previa de la boleta"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      )}
    </td>
  );

  const rowClass = (row: SheetRow) => {
    if (!row.active) return styles.rowInactive;
    if (row.status === "SKIPPED") return styles.rowSkipped;
    return "";
  };

  /** Nro. de cliente recortado (o "Empleado"), con el completo en el tooltip y en el PDF. */
  const facturasCell = (value: string | null) => (
    <td className={styles.facturasCell}>
      {value && <span title={value}>{shortClientNumber(value)}</span>}
    </td>
  );

  /** Una celda por coeficiente; el monto sólo en la de su columna. Pendiente: "—" en su columna (D12). */
  const amountCells = (value: number | null, coeficienteId: string | null | undefined, pending = false) => {
    const col = columnIndex(columns, coeficienteId);
    return columns.map((c, i) => (
      <td key={c.code} className={styles.amountCell}>
        {i !== col ? "" : value != null ? amount.format(value) : pending ? PENDING_MARK : ""}
      </td>
    ));
  };

  /** Todas las tablas comparten colgroup y encabezado: las columnas coinciden verticalmente. */
  const tableHead = (
    <>
      <colgroup>
        <col className={styles.colPreview} />
        <col className={styles.colFacturas} />
        <col className={styles.colConcepto} />
        {columns.map((c) => (<col key={c.code} className={styles.colCoef} />))}
        <col className={styles.colAlias} />
        <col className={styles.colTecnico} />
        <col className={styles.colTel} />
        <col className={styles.colActions} />
      </colgroup>
      <thead>
        <tr className={styles.coefGroupRow}>
          <th colSpan={LEAD} />
          <th colSpan={columns.length} className={styles.coefGroupHeader}>{hasCoefs ? "COEFICIENTE" : ""}</th>
          <th colSpan={TRAIL} />
        </tr>
        <tr>
          <th className={styles.previewCell} aria-label="Vista previa" />
          <th>FACTURA/NRO CLIENTE</th>
          <th>PROVEEDOR/SERVICIO</th>
          {columns.map((c) => (<th key={c.code} className={styles.amountHeader}>{c.code}</th>))}
          <th>ALIAS - CBU</th>
          <th>TÉCNICO O GESTOR</th>
          <th>TEL. CONTACTO</th>
          <th className={styles.actionsHeader} aria-label="Acciones" />
        </tr>
      </thead>
    </>
  );

  /** Marcar / desmarcar una boleta para pasar al mes siguiente. NO la mueve. */
  const carryBtn = (invoiceId: string, requested: boolean) => (
    <AsyncButton
      type="button"
      className={requested ? styles.actionBtnMarked : styles.actionBtn}
      pendingLabel={requested ? "Quitando…" : "Marcando…"}
      onClick={() => onToggleCarryOver(invoiceId, !requested)}
      title={requested ? "Marcada para pasar al mes siguiente (click para quitar)" : "Pasar al mes siguiente"}
    >
      {requested ? "Mes siguiente ✓" : "Mes siguiente"}
    </AsyncButton>
  );

  /** Rubro y coeficiente de la fila (decisión D5: al principio de las acciones). */
  const labelEditor = (target: LabelTarget, rubroId: string | null | undefined, coeficienteId: string | null | undefined, concepto: string) =>
    onSetLabels ? (
      <LabelEditor
        rubros={sheet.rubros}
        coefColumns={columns}
        value={{ rubroId: rubroId ?? null, coeficienteId: coeficienteId ?? null }}
        concepto={concepto}
        onSave={(labels) => onSetLabels(target, labels)}
      />
    ) : null;

  /** Adicional: otra boleta del mismo proveedor en el mes, colgada de su fila. Suma en la columna de la madre (D7). */
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
      {amountCells(extra.monto, row.coeficienteId)}
      <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
      <td />
      <td />
      <td className={styles.rowActions}>
        {!extra.carriedOutTo && carryBtn(extra.invoiceId, extra.carryOverRequested)}
      </td>
    </tr>
  );

  const renderRow = (row: SheetRow) => {
    const isSkipped = Boolean(row.obligationId) && row.status === "SKIPPED";
    const target: LabelTarget = row.invoiceId
      ? { fixedExpenseId: row.fixedExpenseId, invoiceId: row.invoiceId }
      : { fixedExpenseId: row.fixedExpenseId };
    return (
      <Fragment key={row.fixedExpenseId}>
        <tr className={rowClass(row)}>
          {previewCell(row.invoiceUrl, row.concepto)}
          {facturasCell(facturasLabel(row))}
          <td>
            {row.concepto}
            {row.fantasia && <strong className={styles.fantasia}>{row.fantasia}</strong>}
          </td>
          {amountCells(row.monto, row.coeficienteId, showsPendingMark(row))}
          <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
          <td />
          <td />
          <td className={styles.rowActions}>
            {row.active && labelEditor(target, row.rubroId, row.coeficienteId, row.concepto)}
            {/* Una acción por vez: en cada estado sólo se ofrece la que lo revierte. */}
            {!row.active ? (
              <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Activando…"
                onClick={() => onToggle(sheet.consortiumId, row.fixedExpenseId, true)}>
                Activar
              </AsyncButton>
            ) : isSkipped ? (
              <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Agregando…"
                onClick={() => onSetStatus(row.obligationId!, "PENDING")}>
                Agregar al periodo
              </AsyncButton>
            ) : (
              <>
                {row.obligationId && row.status === "PENDING" && (
                  <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Salteando…"
                    onClick={() => onSetStatus(row.obligationId!, "SKIPPED")}
                    title="No se espera boleta este mes">
                    Saltear periodo
                  </AsyncButton>
                )}
                {row.invoiceId && carryBtn(row.invoiceId, row.carryOverRequested)}
                <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Desactivando…"
                  onClick={() => onToggle(sheet.consortiumId, row.fixedExpenseId, false)}>
                  Desactivar
                </AsyncButton>
              </>
            )}
          </td>
        </tr>
        {row.extras.map((extra) => renderExtra(row, extra))}
      </Fragment>
    );
  };

  /** Boleta eventual: un proveedor que no es gasto fijo del edificio (D6). */
  const renderOther = (row: OtherRow) => (
    <tr
      key={row.invoiceId}
      className={row.carriedOutTo ? `${styles.rowOther} ${styles.rowCarriedOut}` : styles.rowOther}
    >
      {previewCell(row.invoiceUrl, row.concepto)}
      {facturasCell(facturasLabel(row))}
      <td>
        {row.concepto}
        <span className={styles.eventualBadge}>eventual</span>
        {row.fantasia && <strong className={styles.fantasia}>{row.fantasia}</strong>}
        {row.carriedOutTo && <span className={styles.carriedBadge}>pasó a {row.carriedOutTo}</span>}
      </td>
      {amountCells(row.monto, row.coeficienteId)}
      <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
      <td />
      <td />
      <td className={styles.rowActions}>
        {!row.carriedOutTo && (
          <>
            {labelEditor({ invoiceId: row.invoiceId }, row.rubroId, row.coeficienteId, row.concepto)}
            {carryBtn(row.invoiceId, row.carryOverRequested)}
          </>
        )}
      </td>
    </tr>
  );

  const renderSection = (section: RubroSection) => (
    <Fragment key={section.rubroId ?? "sin-rubro"}>
      <tr className={styles.sectionRow}>
        <td colSpan={totalCols}>{section.title}</td>
      </tr>
      {section.items.map((item) => (item.kind === "row" ? renderRow(item.row) : renderOther(item.other)))}
      <tr className={styles.sectionTotal}>
        <td colSpan={LEAD}>{section.totalLabel}</td>
        {section.totals.map((t, i) => (
          <td key={columns[i]?.code ?? i} className={styles.amountCell}>{amount.format(t)}</td>
        ))}
        <td colSpan={TRAIL} />
      </tr>
    </Fragment>
  );

  return (
    // `data-printable` lo consume el @media print: una tarjeta sin filas
    // imprimibles no debe ocupar una hoja. El criterio es el mismo que usa el PDF.
    <section
      className={styles.sheetCard}
      data-bank-color={sheet.bankColor ?? "slate"}
      data-printable={hasPrintableRows(sheet) ? "true" : "false"}
    >
      <header className={styles.sheetHeader}>
        <button
          type="button"
          className={styles.sheetToggle}
          aria-expanded={open}
          aria-controls={`sheet-body-${sheet.consortiumId}`}
          onClick={() => onToggleOpen?.(sheet.consortiumId)}
        >
          <span className={styles.sheetChevron} aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span>
            <span className={styles.sheetBank}>
              {sheet.bankId ? `BANCO: ${sheet.bankName}` : sheet.bankName}
            </span>
            <span className={styles.sheetTitle}>{sheet.consortiumName}</span>
          </span>
        </button>
        <div className={styles.sheetHeaderRight}>
          <span className={styles.sheetPeriod}>
            {sheet.periodLabel ?? "sin período abierto"}
          </span>
          <button
            type="button"
            className={styles.addBtn}
            onClick={() => onAdd(sheet.consortiumId)}
            aria-label={`Agregar gasto fijo a ${sheet.consortiumName}`}
            title="Agregar gastos fijos"
          >
            +
          </button>
        </div>
      </header>

      <div id={`sheet-body-${sheet.consortiumId}`} className={styles.sheetBody} hidden={!open}>
        {activeRows.length === 0 && (
          <p className={styles.emptyNote}>
            {inactiveRows.length === 0
              ? "Este edificio está sin gastos fijos cargados"
              : "Este edificio está sin gastos fijos activos"}
            {hasPrintableRows(sheet) ? "." : ": no se va a imprimir."}
          </p>
        )}

        {hasItems && rubroSections.length > 0 && (
          <table className={styles.sheetTable}>
            {tableHead}
            <tbody>{rubroSections.map(renderSection)}</tbody>
            <tfoot>
              <tr className={styles.grandTotal}>
                <td colSpan={LEAD}>{GRAND_TOTAL_LABEL}</td>
                {grand.map((t, i) => (
                  <td key={columns[i]?.code ?? i} className={styles.amountCell}>{amount.format(t)}</td>
                ))}
                <td colSpan={TRAIL} />
              </tr>
            </tfoot>
          </table>
        )}

        {/* "Sin rubro": plegado para no alargar la hoja (D1). Al imprimir sale entero (D2). */}
        {hasItems && sinRubro && (
          <div className={styles.sinRubroBlock}>
            <button
              type="button"
              className={styles.sinRubroToggle}
              aria-expanded={sinRubroOpen}
              onClick={() => setSinRubroOpen((o) => !o)}
            >
              {sinRubroOpen ? "▾" : "▸"} Sin rubro ({sinRubro.items.length})
            </button>
            <div className={styles.sinRubroBody} hidden={!sinRubroOpen}>
              <table className={styles.sheetTable}>
                {tableHead}
                <tbody>{renderSection(sinRubro)}</tbody>
              </table>
            </div>
          </div>
        )}

        {/* Archivo del edificio: lo que se desactivó. Plegado; la impresión lo esconde. */}
        {inactiveRows.length > 0 && (
          <details className={styles.inactiveBlock}>
            <summary className={styles.inactiveSummary}>Desactivados ({inactiveRows.length})</summary>
            <table className={styles.sheetTable}>
              {tableHead}
              <tbody>{inactiveRows.map(renderRow)}</tbody>
            </table>
          </details>
        )}

        {/* Vienen del mes anterior: deuda arrastrada, fuera de los rubros (D10). */}
        {sheet.carried.length > 0 && (
          <div className={styles.carriedBlock}>
            <h3 className={styles.carriedTitle}>Vienen del mes anterior</h3>
            <table className={styles.sheetTable}>
              {tableHead}
              <tbody>
                {sheet.carried.map((row) => (
                  <tr key={row.invoiceId} className={styles.rowCarried}>
                    {previewCell(row.invoiceUrl, row.concepto)}
                    {facturasCell(row.facturas)}
                    <td>
                      {row.concepto}
                      {row.fromLabel && <span className={styles.carriedBadge}>de {row.fromLabel}</span>}
                      {row.lateAmount != null && row.originalAmount != null && (
                        <span className={styles.carriedAmounts}>
                          1° pago {money.format(row.originalAmount)} · 2° pago {money.format(row.lateAmount)}
                        </span>
                      )}
                    </td>
                    {amountCells(row.monto, null)}
                    <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
                    <td />
                    <td />
                    <td className={styles.rowActions}>
                      {carryBtn(row.invoiceId, row.carryOverRequested)}
                      <AsyncButton
                        type="button"
                        className={styles.actionBtn}
                        pendingLabel="Devolviendo…"
                        onClick={() => onUndoCarryOver(row.invoiceId)}
                        title={`Devolver a ${row.fromLabel ?? "su mes"}`}
                      >
                        Devolver
                      </AsyncButton>
                      {lateFor === row.invoiceId ? (
                        <>
                          <input
                            className={styles.lateInput}
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="Monto vencido"
                            aria-label={`Monto vencido de ${row.concepto}`}
                            value={lateValue}
                            onChange={(e) => setLateValue(e.target.value)}
                          />
                          <AsyncButton
                            type="button"
                            className={styles.actionBtn}
                            pendingLabel="Guardando…"
                            disabled={!(Number(lateValue) > 0)}
                            onClick={async () => {
                              await onSetLateAmount(row.invoiceId, Number(lateValue));
                              setLateFor(null);
                              setLateValue("");
                            }}
                          >
                            Guardar
                          </AsyncButton>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={styles.actionBtn}
                          onClick={() => {
                            setLateFor(row.invoiceId);
                            setLateValue(row.lateAmount != null ? String(row.lateAmount) : "");
                          }}
                          title="Cargar el monto del 2° vencimiento"
                        >
                          Monto vencido
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PdfPreviewModal preview={preview} onClose={() => setPreview(null)} />
    </section>
  );
}
```

- [ ] **Paso 4: Estilos**

En `page.module.css`, reemplazar la línea `.colMonto { width: 124px; }` por:

```css
.colCoef { width: 104px; }
```

y achicar las columnas que en pantalla van siempre vacías (se completan a mano en el papel), para
hacerle lugar a hasta 4 columnas de coeficiente sin aplastar PROVEEDOR/SERVICIO, y ensanchar las
acciones, que ahora arrancan con el botón "3 · A":

```css
.colFacturas { width: 110px; }
.colAlias { width: 150px; }
.colTecnico { width: 56px; }
.colTel { width: 56px; }
.colActions { width: 370px; }
```

(reemplazan las líneas actuales de esas cinco clases).

Cuenta con 4 coeficientes: 34 + 110 + 4×104 + 150 + 56 + 56 + 370 = 1192 px fijos, sobre ~1350 px útiles
(1440 − márgenes de página y tarjeta) → PROVEEDOR/SERVICIO ~150 px; con 3 coeficientes ~250 px. Con
los anchos de hoy quedaba en ~100 px. Los importes de estas columnas van **sin `$`** también en pantalla
(D8): `1.198.875,19` entra en 104 px a 13 px de letra; `$ 1.198.875,19` no.

y agregar antes del primer `@media print`:

```css
/* ── Secciones por rubro y columnas de coeficiente (spec 2026-09-24, Parte 2) ── */
.coefGroupRow th { padding-bottom: 0; border-bottom: none; }
.coefGroupHeader { text-align: center; font-size: 11px; letter-spacing: 0.08em; opacity: 0.7; }
.amountHeader { text-align: right; }
.amountCell { text-align: right; white-space: nowrap; }
.sectionRow td { font-weight: 700; padding-top: 12px; border-bottom: 1px solid rgba(127, 127, 127, 0.35); }
.sectionTotal td { font-weight: 600; font-size: 12px; border-bottom: 2px solid rgba(127, 127, 127, 0.25); }
.grandTotal td { font-weight: 800; padding-top: 10px; border-top: 2px solid rgba(127, 127, 127, 0.5); }
.eventualBadge {
  margin-left: 6px; padding: 1px 6px; border-radius: 999px;
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  background: rgba(37, 99, 235, 0.12);
}
.sinRubroBlock { margin-top: 14px; border-top: 1px dashed rgba(127, 127, 127, 0.45); padding-top: 8px; }
.sinRubroToggle {
  background: none; border: none; color: inherit; font: inherit; font-weight: 600;
  cursor: pointer; padding: 4px 0;
}
.labelBtn {
  font-size: 12px; padding: 2px 8px; border: 1px solid rgba(127, 127, 127, 0.45);
  border-radius: 6px; background: transparent; color: inherit; cursor: pointer; white-space: nowrap;
}
.labelEditor { display: inline-flex; gap: 4px; align-items: center; }
.labelEditor select { font-size: 12px; max-width: 150px; }
```

y dentro del PRIMER bloque `@media print { … }`, antes de su `}` final:

```css
  /* "Sin rubro" se pliega en pantalla, no en papel (D2). */
  .sinRubroBody[hidden] { display: block; }
  .sinRubroToggle { padding: 0; }
  .eventualBadge { background: none; padding: 0; }
```

- [ ] **Paso 5: Conectar en la página**

En `src/app/admin/obligaciones/page.tsx`, sumar `setLabels,` a lo que se desestructura de
`useObligationsOverview()` y, en `<SheetCard …>`, después de `onSetLateAmount={setLateAmount}`:

```tsx
                onSetLabels={setLabels}
                hideEmptySections={query.trim() !== ""}
```

(`query` es el estado de la búsqueda que la página ya pasa a `filterSheets`.)

- [ ] **Paso 6: Correr los tests de la vista**

Run: `npx vitest run src/app/admin/obligaciones`
Expected: PASS todos, salvo `sheetPdf.test.ts` (Tarea 7).

Avisar: "Tarea 6 lista".

---

### Tarea 7: El PDF del banco

**Files:**
- Modify (reescritura): `src/app/admin/obligaciones/lib/sheetPdf.ts`
- Modify (reescritura): `src/app/admin/obligaciones/lib/sheetPdf.test.ts`

- [ ] **Paso 1: Tests nuevos (fallan)**

Reemplazar `sheetPdf.test.ts` completo por:

```ts
import { describe, expect, it } from "vitest";
import { CARRIED_TITLE, pdfColumnWidths, pdfFileName, toPdfTables, type PdfCell } from "./sheetPdf";
import type { SheetData } from "./sheetModel";

const num = (n: number) => new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
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
      status: "RECEIVED", active: true, invoiceId: "i2", carryOverRequested: false, carriedIn: false, invoiceUrl: null,
      extras: [], group: "SERVICIO", rubroId: "r3", coeficienteId: "cB" },
    { fixedExpenseId: "fx1", obligationId: "ob1", providerId: "p1", lspServiceId: null,
      facturas: null, concepto: "SEGURO LA CAJA", fantasia: null, monto: null, aliasCbu: [],
      status: "PENDING", active: true, invoiceId: null, carryOverRequested: false, carriedIn: false, invoiceUrl: null,
      extras: [], group: "PROVEEDOR", rubroId: "r10", coeficienteId: null },
    { fixedExpenseId: "fx9", obligationId: "ob9", providerId: "p9", lspServiceId: null,
      facturas: null, concepto: "FUMIGACION", fantasia: null, monto: null, aliasCbu: [],
      status: "SKIPPED", active: true, invoiceId: null, carryOverRequested: false, carriedIn: false, invoiceUrl: null,
      extras: [], group: "PROVEEDOR", rubroId: "r4", coeficienteId: null },
  ],
  carried: [],
  others: [],
};

describe("toPdfTables", () => {
  it("rotula banco y período en el subtítulo", () => {
    const t = toPdfTables([base])[0];
    expect(t.title).toBe("FRANKLIN 25");
    expect(t.subtitle).toBe("BANCO: Santander   ·   PERIODO: Julio 2026");
  });

  it("encabezado de dos niveles: COEFICIENTE sobre A y B", () => {
    const [grupo, columnas] = toPdfTables([base])[0].head;
    expect(grupo[1]).toEqual({ content: "COEFICIENTE", colSpan: 2, styles: { halign: "center" } });
    expect(columnas).toEqual(["FACTURA/NRO CLIENTE", "PROVEEDOR/SERVICIO", "A", "B", "ALIAS - CBU", "TÉCNICO O GESTOR", "TEL. CONTACTO"]);
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

  it("una adicional sale indentada bajo su madre, en la columna de la madre", () => {
    const conExtra = { ...base, rows: [{ ...base.rows[0], extras: [
      { invoiceId: "e1", ordinal: 2, monto: 54000, invoiceUrl: null, carryOverRequested: false, carriedOutTo: null },
    ] }] };
    expect(items(toPdfTables([conExtra])[0].body)[1]).toEqual(["", "   ↳ 2ª boleta", "", num(54000), "edesur.pago", "", ""]);
  });

  it("la fila de un empleado sale rotulada 'Empleado'", () => {
    const sueldo = { ...base, rows: [{ ...base.rows[0], facturas: null, group: "EMPLEADO" as const }] };
    expect(items(toPdfTables([sueldo])[0].body)[0][0]).toBe("Empleado");
  });

  it("las arrastradas van en su bloque, con el monto en la primera columna", () => {
    const conArrastre = { ...base, carried: [{ invoiceId: "c9", facturas: null, concepto: "AYSA", monto: 900,
      originalAmount: 900, lateAmount: null, aliasCbu: [], fromLabel: "junio 2026", carryOverRequested: false, invoiceUrl: null }] };
    expect(toPdfTables([conArrastre])[0].carried).toEqual([["", "AYSA — de junio 2026", num(900), "", "", "", ""]]);
    expect(CARRIED_TITLE).toBe("VIENEN DEL MES ANTERIOR");
  });

  it("un edificio sin nada imprimible no genera tabla", () => {
    const salteadas = { ...base, rows: base.rows.map((r) => ({ ...r, status: "SKIPPED" as const })) };
    expect(toPdfTables([salteadas])).toEqual([]);
  });
});

describe("pdfColumnWidths", () => {
  it.each([1, 2, 3, 4])("con %i coeficiente(s) suma los 182 mm útiles del A4", (n) => {
    const w = pdfColumnWidths(n);
    expect(w).toHaveLength(5 + n);
    expect(w.reduce((a, b) => a + b, 0)).toBe(182);
    expect(w[1]).toBeGreaterThanOrEqual(40); // PROVEEDOR/SERVICIO sigue legible
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
```

Run: `npx vitest run src/app/admin/obligaciones/lib/sheetPdf.test.ts` → FAIL.

- [ ] **Paso 2: Reescribir `sheetPdf.ts`**

Reemplazar el archivo completo por:

```ts
// Import de SÓLO TIPOS: se borra al compilar, así que no rompe el `import()`
// dinámico de la librería (que es lo que la mantiene fuera del bundle).
import type { UserOptions } from "jspdf-autotable";
import {
  columnIndex,
  FALLBACK_COLUMN,
  facturasLabel,
  GRAND_TOTAL_LABEL,
  grandTotals,
  groupByRubro,
  isPrintableRow,
  PENDING_MARK,
  showsPendingMark,
  toPrintableSheets,
  type CoefColumn,
  type OtherRow,
  type RubroSection,
  type SheetData,
  type SheetRow,
} from "./sheetModel";

/** Columnas fijas antes y después de las de coeficiente. */
export const LEAD_COLUMNS = ["FACTURA/NRO CLIENTE", "PROVEEDOR/SERVICIO"];
export const TRAIL_COLUMNS = ["ALIAS - CBU", "TÉCNICO O GESTOR", "TEL. CONTACTO"];

type PdfCellStyles = {
  fontStyle?: "bold" | "normal";
  fillColor?: [number, number, number];
  halign?: "left" | "center" | "right";
};
/** Celda de autoTable: texto, o un objeto para las filas de sección y total. */
export type PdfCell = string | { content: string; colSpan?: number; styles?: PdfCellStyles };

export type PdfTable = {
  title: string;
  subtitle: string;
  /** Dos niveles: COEFICIENTE arriba, los códigos abajo. */
  head: PdfCell[][];
  /** Secciones por rubro + total del mes. */
  body: PdfCell[][];
  /** Bloque "Vienen del mes anterior", debajo. */
  carried: PdfCell[][];
  /** Ancho de cada columna en mm; suman 182 (A4 con márgenes de 14 mm). */
  widths: number[];
};

/** Título del bloque de impagas dentro de la hoja del edificio. */
export const CARRIED_TITLE = "VIENEN DEL MES ANTERIOR";

/** Sin `$` (D8): con 4 columnas de coeficiente cada una tiene 20 mm. */
const amount = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (value: number | null) => (value != null ? amount.format(value) : "");
const SECTION_FILL: [number, number, number] = [245, 245, 245];

/** "agosto 2026" → "Agosto 2026" (la API devuelve el mes en minúscula). */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Normaliza el nombre del banco **sólo para el papel**. No toca el registro. */
function formatBankName(value: string): string {
  return value.trim().toLocaleLowerCase("es-AR").split(/\s+/).map((w) => capitalize(w)).join(" ");
}

/**
 * Anchos en mm según cuántas columnas de coeficiente tenga el edificio: los 182 mm
 * útiles se reparten y TÉCNICO / TEL. se achican primero (spec: se completan a mano).
 */
export function pdfColumnWidths(coefCount: number): number[] {
  const n = Math.max(1, coefCount);
  const amountW = n <= 2 ? 28 : 20;
  const fixed =
    n === 1 ? { facturas: 18, alias: 26, tecnico: 22, tel: 20 }
    : n === 2 ? { facturas: 16, alias: 24, tecnico: 14, tel: 14 }
    : { facturas: 16, alias: 22, tecnico: 10, tel: 10 };
  const concepto = 182 - amountW * n - fixed.facturas - fixed.alias - fixed.tecnico - fixed.tel;
  return [fixed.facturas, concepto, ...Array.from({ length: n }, () => amountW), fixed.alias, fixed.tecnico, fixed.tel];
}

/** El monto en su columna; una fila pendiente, "—" en su columna (D12). */
function amountCells(value: number | null, col: number, n: number, pending = false): string[] {
  return Array.from({ length: n }, (_, i) => (i !== col ? "" : value != null ? fmt(value) : pending ? PENDING_MARK : ""));
}

/**
 * Una fila madre y sus adicionales, en la columna del coeficiente de la madre (D7).
 * Si la madre no se imprime (salteada), las adicionales llevan el concepto completo.
 */
function rowLines(row: SheetRow, columns: CoefColumn[]): PdfCell[][] {
  const n = columns.length;
  const col = columnIndex(columns, row.coeficienteId);
  const madre = isPrintableRow(row);
  const extras = row.extras.map((e) => [
    "",
    madre ? `   ↳ ${e.ordinal}ª boleta` : `${row.concepto} — ${e.ordinal}ª boleta`,
    ...amountCells(e.monto, col, n),
    row.aliasCbu.join("\n"),
    "",
    "",
  ]);
  if (!madre) return extras;
  return [
    [facturasLabel(row) ?? "", row.concepto, ...amountCells(row.monto, col, n, showsPendingMark(row)), row.aliasCbu.join("\n"), "", ""],
    ...extras,
  ];
}

function otherLine(row: OtherRow, columns: CoefColumn[]): PdfCell[] {
  return [
    facturasLabel(row) ?? "",
    row.fantasia ? `${row.concepto} (${row.fantasia})` : row.concepto,
    ...amountCells(row.monto, columnIndex(columns, row.coeficienteId), columns.length),
    row.aliasCbu.join("\n"),
    "",
    "",
  ];
}

function sectionLines(section: RubroSection, columns: CoefColumn[]): PdfCell[][] {
  const width = LEAD_COLUMNS.length + columns.length + TRAIL_COLUMNS.length;
  return [
    [{ content: section.title, colSpan: width, styles: { fontStyle: "bold", fillColor: SECTION_FILL } }],
    ...section.items.flatMap((item) =>
      item.kind === "row" ? rowLines(item.row, columns) : [otherLine(item.other, columns)]
    ),
    [
      { content: section.totalLabel, colSpan: LEAD_COLUMNS.length, styles: { fontStyle: "bold" } },
      ...section.totals.map((t) => amount.format(t)),
      "", "", "",
    ],
  ];
}

/**
 * Convierte las hojas en tablas listas para `autoTable`. Puro: es lo que se testea.
 * Mismo modelo y mismo agrupado que la pantalla (`groupByRubro`); el filtro de qué
 * se imprime vive en `toPrintableSheets`. Las secciones vacías no van (D3).
 */
export function toPdfTables(sheets: SheetData[]): PdfTable[] {
  return toPrintableSheets(sheets).map((sheet) => {
    const columns = sheet.coefColumns.length > 0 ? sheet.coefColumns : [FALLBACK_COLUMN];
    const n = columns.length;
    const sections = groupByRubro(sheet).filter((s) => s.items.length > 0);
    const grand = grandTotals(sections, n);
    return {
      title: sheet.consortiumName,
      subtitle: [
        sheet.bankName ? `BANCO: ${formatBankName(sheet.bankName)}` : null,
        sheet.periodLabel ? `PERIODO: ${capitalize(sheet.periodLabel)}` : null,
      ].filter(Boolean).join("   ·   "),
      head: [
        [
          { content: "", colSpan: LEAD_COLUMNS.length },
          { content: columns.some((c) => c.id !== null) ? "COEFICIENTE" : "", colSpan: n, styles: { halign: "center" } },
          { content: "", colSpan: TRAIL_COLUMNS.length },
        ],
        [...LEAD_COLUMNS, ...columns.map((c) => c.code), ...TRAIL_COLUMNS],
      ],
      body:
        sections.length === 0
          ? []
          : [
              ...sections.flatMap((s) => sectionLines(s, columns)),
              [
                { content: GRAND_TOTAL_LABEL, colSpan: LEAD_COLUMNS.length, styles: { fontStyle: "bold" } },
                ...grand.map((t) => amount.format(t)),
                "", "", "",
              ],
            ],
      // El monto de una impaga es el saldo (sobre el 2° vencimiento si se cargó);
      // el 1° pago va en el concepto. Primera columna (D10).
      carried: sheet.carried.map((row) => [
        row.facturas ?? "",
        `${row.concepto}${row.fromLabel ? ` — de ${row.fromLabel}` : ""}` +
          (row.lateAmount != null && row.originalAmount != null ? ` (1° pago ${fmt(row.originalAmount)})` : ""),
        ...amountCells(row.monto, 0, n),
        row.aliasCbu.join("\n"),
        "",
        "",
      ]),
      widths: pdfColumnWidths(n),
    };
  });
}

export function pdfFileName(majorityLabel: string | null): string {
  if (!majorityLabel) return "obligaciones.pdf";
  const slug = majorityLabel.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim().replace(/\s+/g, "-");
  return `obligaciones-${slug}.pdf`;
}

/**
 * Arma el PDF y dispara la descarga. `jspdf` y `jspdf-autotable` se cargan con
 * `import()` dinámico: ~350 KB fuera del bundle hasta que alguien aprieta Descargar.
 */
export async function downloadSheetsPdf(sheets: SheetData[], majorityLabel: string | null): Promise<void> {
  const tables = toPdfTables(sheets);
  if (tables.length === 0) return;

  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const generado = new Date().toLocaleDateString("es-AR");

  tables.forEach((table, index) => {
    if (index > 0) doc.addPage(); // una hoja por edificio

    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(table.subtitle, 14, 16);
    doc.setFontSize(16);
    doc.setTextColor(20);
    doc.text(table.title, 14, 24);

    const n = table.widths.length - LEAD_COLUMNS.length - TRAIL_COLUMNS.length;
    const isAmount = (i: number) => i >= LEAD_COLUMNS.length && i < LEAD_COLUMNS.length + n;
    const tableStyles: Partial<UserOptions> = {
      styles: {
        fontSize: 9,
        cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 },
        lineColor: 200,
        lineWidth: 0.1,
        valign: "middle",
      },
      headStyles: { fillColor: [240, 240, 240], textColor: 40, fontStyle: "bold" },
      columnStyles: Object.fromEntries(
        table.widths.map((w, i) => [i, isAmount(i) ? { cellWidth: w, halign: "right" as const, fontSize: 8 } : { cellWidth: w }])
      ),
      margin: { left: 14, right: 14 },
    };
    const head = table.head as unknown as UserOptions["head"];

    autoTable(doc, { startY: 30, head, body: table.body as unknown as UserOptions["body"], ...tableStyles });

    // `lastAutoTable` existe en runtime (jspdf-autotable 5.0.8 → `{ finalY }`) pero
    // la v5 no lo declara en sus tipos.
    if (table.carried.length > 0) {
      const withLast = doc as unknown as { lastAutoTable?: { finalY?: number } };
      const finalY = withLast.lastAutoTable?.finalY ?? 30;
      doc.setFontSize(10);
      doc.setTextColor(60);
      doc.text(CARRIED_TITLE, 14, finalY + 10);
      autoTable(doc, { startY: finalY + 13, head, body: table.carried as unknown as UserOptions["body"], ...tableStyles });
    }

    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`Generado el ${generado}`, 14, doc.internal.pageSize.getHeight() - 8);
  });

  doc.save(pdfFileName(majorityLabel));
}
```

- [ ] **Paso 3: Correr los tests**

Run: `npx vitest run src/app/admin/obligaciones/lib/sheetPdf.test.ts`
Expected: PASS.

- [ ] **Paso 4: Buscar usos de lo que se borró**

Run: `npx tsc --noEmit -p tsconfig.json` (o `npm run typecheck`)
Expected: sin referencias a `PDF_COLUMNS` ni `OTHERS_TITLE` fuera de este archivo. Si alguna aparece,
reemplazarla por `LEAD_COLUMNS`/`TRAIL_COLUMNS` (no hay otro consumidor conocido).

Avisar: "Tarea 7 lista".

---

### Tarea 8: Verificación completa

- [ ] **Paso 1:** `npm test` → todo verde.
- [ ] **Paso 2:** `npm run typecheck` → sin errores.
- [ ] **Paso 3:** `npm run lint` → 0 errores (13 warnings preexistentes).
- [ ] **Paso 4:** `npm run build:jobs` → OK.
- [ ] **Paso 5:** `npm run build` (Next) → OK. **Obligatorio**: los CSS Modules corren en modo `pure` y un
  selector sin clase local compila en dev pero rompe acá (ver `CLAUDE.md`).
- [ ] **Paso 6:** la red del pipeline no se tocó, pero correrla igual:
  `npx vitest run src/jobs/processPendingDocuments.job.test.ts` → PASS.

---

### Tarea 9: Documentación

- [ ] `docs/progreso.md`: sección nueva arriba (qué se hizo, decisiones D1–D13, verificación pendiente
  del owner en producción sobre "Edificio de Prueba").
- [ ] `docs/decisiones.md`: entrada 2026-09-27 con el diseño (una sola fuente `groupByRubro`,
  etiqueta boleta > gasto fijo, "Sin rubro" plegado, importes sin `$` y anchos por cantidad de
  coeficientes, desactivados fuera de los rubros, marca "—" de pendiente, endpoint `labels`
  transaccional con `validateLabels` compartido) y las alternativas descartadas (columna nueva para el
  editor, un PATCH por separado para boleta y gasto fijo, secciones vacías en el papel, desactivados al
  final de cada rubro).
- [ ] `CHANGELOG.md`: entrada `Added`.
- [ ] `CLAUDE.md`: en "Pendientes conocidos" marcar la Parte 2 hecha; en la estructura de
  directorios, `api/client/labels/`; en "UI … obligaciones", el agrupado por rubro.

Avisar al owner: listo para commitear, y qué verificar después del deploy:
1. Abrir `/admin/obligaciones`, desplegar un edificio con liquidación (ej. Arenales 2154): secciones
   en orden, montos en su columna, totales por rubro y del mes.
2. "Sin rubro" plegado con su cantidad; desplegarlo. Una fila pendiente muestra "—" en su columna.
   Buscar "EDESUR": no aparecen los rubros vacíos. Una fila de "Vienen del mes anterior" dice qué
   servicio es (ej. `EDESUR S.A. — PORTERIA`).
3. En "Edificio de Prueba": cambiar el rubro de una fila con el editor y confirmar que pasa de sección.
4. Descargar el PDF y revisar que entren las columnas (un edificio con A, B, C y EXTRA).
