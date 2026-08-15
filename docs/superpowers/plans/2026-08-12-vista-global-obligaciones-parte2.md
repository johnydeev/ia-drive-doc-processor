# Vista global de obligaciones — Parte 2 (PDF e impresión) · Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: usar `superpowers:subagent-driven-development`
> (recomendado) o `superpowers:executing-plans` para implementar tarea por tarea. Los pasos usan
> checkboxes (`- [ ]`) para seguimiento.

> **⚠️ REGLA DEL PROYECTO — NO COMMITEAR.** Claude nunca ejecuta `git commit`, `git add` ni
> `git push`. El owner commitea con GitLens. Cada tarea cierra con **verificación**, no con commit.

**Goal:** Que el administrador se lleve el papel: un botón **Descargar PDF** que baja el archivo al
dispositivo (una hoja por edificio, agrupadas por banco) y un botón **Imprimir** que manda la misma
vista a la impresora sin pasar por Descargas.

**Architecture:** Una función pura decide **qué se imprime** (`toPrintableSheets`) y otra convierte
esas hojas en filas de tabla (`toPdfTables`). Las dos salidas —PDF y papel— parten del mismo
`SheetData[]` que la Parte 1 ya construye, así no pueden mostrar cosas distintas. El PDF se arma con
`jsPDF` + `jspdf-autotable` cargados con `import()` dinámico (no pesan hasta que se aprieta el botón);
la impresión es una hoja de estilos `@media print` sobre la vista existente.

**Tech Stack:** Next.js 16 (App Router, client components), TypeScript, React 19, `jspdf` +
`jspdf-autotable` (v5: export nombrado `autoTable(doc, opts)`), Vitest con dos proyectos.

**Spec:** `docs/superpowers/specs/2026-08-12-vista-global-obligaciones-design.md` (§4, §5, §6.8)
**Parte 1 (hecha):** `docs/superpowers/plans/2026-08-12-vista-global-obligaciones-parte1.md`

---

## Contexto que el implementador necesita saber

**Qué existe ya.** `src/app/admin/obligaciones/` tiene `lib/sheetModel.ts` (tipos + `buildSheets` +
`filterSheets`), `lib/availableTargets.ts`, `hooks/useObligationsOverview.ts`,
`components/{SheetCard,AddFixedExpenseModal}.tsx`, `page.tsx` y `page.module.css`. La vista está
validada visualmente por el owner. **Este trabajo no cambia comportamiento existente**: sólo agrega
las dos salidas.

**Qué se imprime y qué no** (decidido en el spec, §4):
- **No** se imprimen las filas **salteadas** (`status === "SKIPPED"`): no son parte de lo que hay que
  pagar este mes.
- **No** se imprimen los gastos fijos **desactivados** (`active === false`).
- **No** se imprime un edificio que queda sin filas, ni uno **sin período activo**.
- Sí se imprimen las columnas TÉCNICO O GESTOR y TEL. CONTACTO, **vacías**: el modelo no guarda esos
  datos y el administrador las completa a mano.
- El MONTO sale sólo si la boleta llegó; si no, la celda va vacía para escribir.

**La pantalla sigue mostrando todo** (salteadas y desactivadas en gris, al fondo): es la vista de
control. La divergencia es intencional y está centralizada en una sola función.

**Convenciones del repo:**
- PowerShell: **no usar `&&`**, comandos separados.
- Tests: lógica pura → `.test.ts`; hooks y componentes → `.test.tsx`. Todo con `npx vitest run`.
- **CSS Modules en modo `pure`**: todo selector necesita una clase local. `npm run build` es el único
  comando que lo detecta.
- Toda acción async en un botón va con `AsyncButton` (spinner + disabled + guard anti doble-click).
  Generar el PDF lo es (descarga las librerías y arma el documento). `window.print()` es síncrono:
  botón normal.
- Textos de UI y comentarios en **castellano**.

**Baseline verificado:** 544 tests, typecheck + lint + build + build:jobs en verde, migración de la
Parte 1 aplicada.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `package.json` **(modificar)** | Suma `jspdf` y `jspdf-autotable` |
| `src/app/admin/obligaciones/lib/sheetModel.ts` **(modificar)** | Suma `isPrintableRow`, `hasPrintableRows` y `toPrintableSheets` |
| `src/app/admin/obligaciones/lib/sheetModel.test.ts` **(modificar)** | Tests de lo anterior |
| `src/app/admin/obligaciones/lib/sheetPdf.ts` **(crear)** | `toPdfTables` + `pdfFileName` (puros) y `downloadSheetsPdf` (efecto, con `import()` dinámico) |
| `src/app/admin/obligaciones/lib/sheetPdf.test.ts` **(crear)** | Tests de las dos funciones puras |
| `src/app/admin/obligaciones/components/SheetCard.tsx` **(modificar)** | Marca la tarjeta con `data-printable` para que el CSS de impresión la esconda |
| `src/app/admin/obligaciones/components/SheetCard.test.tsx` **(modificar)** | Test del atributo |
| `src/app/admin/obligaciones/page.tsx` **(modificar)** | Botones Descargar PDF e Imprimir |
| `src/app/admin/obligaciones/page.module.css` **(modificar)** | Bloque `@media print` |

---

## Task 1: Instalar las dependencias de PDF

**Files:**
- Modify: `package.json` (vía npm)

- [ ] **Step 1: Instalar**

```bash
npm install jspdf jspdf-autotable
```

- [ ] **Step 2: Verificar que la versión instalada usa el export nombrado**

```bash
node -e "console.log(require('./package.json').dependencies['jspdf'], require('./package.json').dependencies['jspdf-autotable'])"
```

Esperado: dos versiones. **Si `jspdf-autotable` quedó en 4.x o anterior**, la API es
`doc.autoTable(opts)` en vez de `import { autoTable }`; en ese caso ajustar `sheetPdf.ts` de la Task 3
(la forma `doc.autoTable(...)` existe en las dos versiones y es el fallback seguro).

- [ ] **Step 3: Verificar que nada se rompió**

```bash
npm run typecheck
```

```bash
npm run build
```

Esperado: 0 errores. **No commitear.**

---

## Task 2: Qué se imprime (lógica pura)

**Files:**
- Modify: `src/app/admin/obligaciones/lib/sheetModel.ts`
- Test: `src/app/admin/obligaciones/lib/sheetModel.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `src/app/admin/obligaciones/lib/sheetModel.test.ts` (dejando lo existente
intacto) y sumar `isPrintableRow`, `hasPrintableRows` y `toPrintableSheets` al `import` del tope:

```ts
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
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/obligaciones/lib/sheetModel.test.ts
```

Esperado: FAIL — `toPrintableSheets is not a function`.

- [ ] **Step 3: Escribir la implementación**

Agregar al final de `src/app/admin/obligaciones/lib/sheetModel.ts`:

```ts
/**
 * ¿Esta fila va al papel?
 *
 * La pantalla muestra TODO (es la vista de control); el papel es sólo lo que hay
 * que pagar este mes. Esta función es la ÚNICA definición de esa diferencia: la
 * usan el generador de PDF y también `SheetCard`, para marcar la tarjeta que la
 * hoja de estilos de impresión tiene que esconder.
 */
export function isPrintableRow(row: SheetRow): boolean {
  if (!row.active) return false;                 // gasto fijo dado de baja
  if (row.status === "SKIPPED") return false;    // este mes no va
  if (row.status === "NO_PERIOD") return false;  // el edificio no tiene período abierto
  return true;
}

export function hasPrintableRows(sheet: SheetData): boolean {
  return sheet.rows.some(isPrintableRow);
}

/**
 * Las hojas tal como salen impresas: sin filas salteadas ni desactivadas, sin
 * edificios sin período activo y sin edificios que quedarían en blanco (no se
 * gasta papel en una hoja vacía). No muta la entrada.
 */
export function toPrintableSheets(sheets: SheetData[]): SheetData[] {
  return sheets
    .map((sheet) => ({ ...sheet, rows: sheet.rows.filter(isPrintableRow) }))
    .filter((sheet) => sheet.rows.length > 0);
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/obligaciones/lib/sheetModel.test.ts
```

Esperado: PASS, 24 tests (14 viejos + 10 nuevos).

- [ ] **Step 5: Verificar tipos**

```bash
npm run typecheck
```

Esperado: 0 errores. **No commitear.**

---

## Task 3: El documento PDF

**Files:**
- Create: `src/app/admin/obligaciones/lib/sheetPdf.ts`
- Test: `src/app/admin/obligaciones/lib/sheetPdf.test.ts`

Se testea **el armado de los datos** que recibe el generador (filas, orden, formato), no el binario:
un PDF no se puede assertar de forma útil y su render lo valida el owner a ojo.

- [ ] **Step 1: Escribir el test que falla**

Crear `src/app/admin/obligaciones/lib/sheetPdf.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PDF_COLUMNS, pdfFileName, toPdfTables } from "./sheetPdf";
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
    rows: [
      { fixedExpenseId: "fx2", obligationId: "ob2", providerId: null, lspServiceId: "l1",
        facturas: "4804882", concepto: "EDESUR", monto: 118000, aliasCbu: "edesur.pago",
        status: "RECEIVED", active: true },
      { fixedExpenseId: "fx1", obligationId: "ob1", providerId: "p1", lspServiceId: null,
        facturas: null, concepto: "SEGURO LA CAJA", monto: null, aliasCbu: null,
        status: "PENDING", active: true },
      { fixedExpenseId: "fx9", obligationId: "ob9", providerId: "p9", lspServiceId: null,
        facturas: null, concepto: "FUMIGACION", monto: null, aliasCbu: null,
        status: "SKIPPED", active: true },
    ],
  },
];

describe("toPdfTables", () => {
  it("arma una tabla por edificio con su banco y período en el subtítulo", () => {
    const tables = toPdfTables(sheets);
    expect(tables).toHaveLength(1);
    expect(tables[0].title).toBe("FRANKLIN 25");
    expect(tables[0].subtitle).toBe("Santander · julio 2026");
  });

  it("usa las seis columnas de la planilla", () => {
    expect(toPdfTables(sheets)[0].head).toEqual([PDF_COLUMNS]);
    expect(PDF_COLUMNS).toHaveLength(6);
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
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/obligaciones/lib/sheetPdf.test.ts
```

Esperado: FAIL — `Failed to resolve import "./sheetPdf"`.

- [ ] **Step 3: Escribir la implementación**

Crear `src/app/admin/obligaciones/lib/sheetPdf.ts`:

```ts
import { toPrintableSheets, type SheetData } from "./sheetModel";

/** Las seis columnas de la planilla que el administrador ya usaba. */
export const PDF_COLUMNS = [
  "FACTURAS",
  "PROVEEDORES Y SERVICIOS",
  "MONTO",
  "ALIAS CBU",
  "TÉCNICO O GESTOR",
  "TEL. CONTACTO",
];

export type PdfTable = {
  title: string;
  subtitle: string;
  head: string[][];
  body: string[][];
};

const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

/**
 * Convierte las hojas en tablas listas para `autoTable`. Puro: es lo que se
 * testea. El filtro de qué se imprime vive en `toPrintableSheets`, no acá.
 */
export function toPdfTables(sheets: SheetData[]): PdfTable[] {
  return toPrintableSheets(sheets).map((sheet) => ({
    title: sheet.consortiumName,
    subtitle: [sheet.bankName, sheet.periodLabel].filter(Boolean).join(" · "),
    head: [PDF_COLUMNS],
    body: sheet.rows.map((row) => [
      row.facturas ?? "",
      row.concepto,
      row.monto != null ? money.format(row.monto) : "",
      row.aliasCbu ?? "",
      "", // TÉCNICO O GESTOR — se completa a mano
      "", // TEL. CONTACTO — se completa a mano
    ]),
  }));
}

export function pdfFileName(majorityLabel: string | null): string {
  if (!majorityLabel) return "obligaciones.pdf";
  const slug = majorityLabel
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-");
  return `obligaciones-${slug}.pdf`;
}

/**
 * Arma el PDF y dispara la descarga.
 *
 * `jspdf` y `jspdf-autotable` se cargan con `import()` dinámico: son ~350 KB que
 * no tienen por qué viajar en el bundle del panel hasta que alguien aprieta
 * Descargar. Por eso esta función es async y el botón usa `AsyncButton`.
 */
export async function downloadSheetsPdf(
  sheets: SheetData[],
  majorityLabel: string | null
): Promise<void> {
  const tables = toPdfTables(sheets);
  if (tables.length === 0) return;

  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const generado = new Date().toLocaleDateString("es-AR");

  tables.forEach((table, index) => {
    if (index > 0) doc.addPage(); // una hoja por edificio

    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(table.subtitle.toUpperCase(), 14, 16);

    doc.setFontSize(16);
    doc.setTextColor(20);
    doc.text(table.title, 14, 24);

    autoTable(doc, {
      startY: 30,
      head: table.head,
      body: table.body,
      styles: { fontSize: 9, cellPadding: 2.5, lineColor: 200, lineWidth: 0.1 },
      headStyles: { fillColor: [240, 240, 240], textColor: 40, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 24 },
        2: { cellWidth: 26, halign: "right" },
        4: { cellWidth: 30 },
        5: { cellWidth: 28 },
      },
      margin: { left: 14, right: 14 },
    });

    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`Generado el ${generado}`, 14, doc.internal.pageSize.getHeight() - 8);
  });

  doc.save(pdfFileName(majorityLabel));
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/obligaciones/lib/sheetPdf.test.ts
```

Esperado: PASS, 9 tests. (Los tests sólo tocan `toPdfTables` y `pdfFileName`; el `import()` dinámico
de `downloadSheetsPdf` nunca se ejecuta, así que no hace falta mockear nada.)

- [ ] **Step 5: Verificar tipos y lint**

```bash
npm run typecheck
```

```bash
npm run lint
```

Esperado: 0 errores. Si el typecheck se queja de `doc.internal.pageSize.getHeight()`, usar
`doc.internal.pageSize.height`. **No commitear.**

---

## Task 4: Los dos botones en la barra

**Files:**
- Modify: `src/app/admin/obligaciones/page.tsx`

- [ ] **Step 1: Agregar los imports**

Junto a los imports existentes de `page.tsx`:

```tsx
import { AsyncButton } from "@/components/AsyncButton";
import { downloadSheetsPdf } from "./lib/sheetPdf";
import { toPrintableSheets } from "./lib/sheetModel";
```

`filterSheets` y `SheetData` ya están importados de `./lib/sheetModel`; sumar `toPrintableSheets` a
ese mismo import en vez de duplicar la línea.

- [ ] **Step 2: Calcular cuántas hojas saldrían**

Dentro del componente, junto a los otros `useMemo`:

```tsx
  // Lo que realmente se imprime: sin salteadas, sin desactivadas y sin edificios
  // vacíos. Sirve para deshabilitar los botones cuando no hay nada que sacar.
  const printableCount = useMemo(() => toPrintableSheets(sheets).length, [sheets]);
```

- [ ] **Step 3: Agregar los botones a la toolbar**

En el bloque `.toolbarRight` de `page.tsx`, **antes** del `<Link>` de Volver:

```tsx
          <AsyncButton
            type="button"
            className={styles.primaryBtn}
            disabled={printableCount === 0}
            pendingLabel="Generando…"
            onClick={() => downloadSheetsPdf(sheets, majorityLabel)}
          >
            Descargar PDF ({printableCount})
          </AsyncButton>
          <button
            type="button"
            className={styles.ghostBtn}
            disabled={printableCount === 0}
            onClick={() => window.print()}
          >
            Imprimir
          </button>
```

`Descargar PDF` es `AsyncButton` porque descarga las librerías y arma el documento; `Imprimir` es un
`<button>` normal porque `window.print()` es síncrono (convención del proyecto: sin spinner para lo
que no espera nada).

- [ ] **Step 4: Verificar**

```bash
npx vitest run
```

```bash
npm run typecheck
```

```bash
npm run lint
```

Esperado: todo verde. **No commitear.**

---

## Task 5: La hoja de estilos de impresión

**Files:**
- Modify: `src/app/admin/obligaciones/components/SheetCard.tsx`
- Modify: `src/app/admin/obligaciones/components/SheetCard.test.tsx`
- Modify: `src/app/admin/obligaciones/page.module.css`

El CSS no puede saber solo si una tarjeta quedaría vacía al imprimir, así que el componente lo marca
con un atributo — calculado con **la misma función** que usa el PDF.

- [ ] **Step 1: Escribir el test que falla**

Agregar a `src/app/admin/obligaciones/components/SheetCard.test.tsx`:

```tsx
  it("marca la tarjeta como imprimible sólo si le queda alguna fila para el papel", () => {
    const { container, unmount } = render(
      <SheetCard sheet={sheet} onAdd={vi.fn()} onToggle={vi.fn()} onSetStatus={vi.fn()} />
    );
    expect(container.querySelector("section")).toHaveAttribute("data-printable", "true");
    unmount();

    // Todo salteado o desactivado → no se imprime.
    const nadaQueImprimir = {
      ...sheet,
      rows: sheet.rows.map((r) => ({ ...r, status: "SKIPPED" as const })),
    };
    const { container: c2 } = render(
      <SheetCard sheet={nadaQueImprimir} onAdd={vi.fn()} onToggle={vi.fn()} onSetStatus={vi.fn()} />
    );
    expect(c2.querySelector("section")).toHaveAttribute("data-printable", "false");
  });
```

Agregar `hasPrintableRows` al import de `../lib/sheetModel` si el test lo necesita (no hace falta si
sólo se assertan atributos).

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/obligaciones/components/SheetCard.test.tsx
```

Esperado: FAIL — el atributo `data-printable` no existe.

- [ ] **Step 3: Marcar la tarjeta**

En `SheetCard.tsx`, sumar el import y el atributo:

```tsx
import { hasPrintableRows, type SheetData, type SheetRow } from "../lib/sheetModel";
```

```tsx
    <section
      className={styles.sheetCard}
      data-bank-color={sheet.bankColor ?? "slate"}
      data-printable={hasPrintableRows(sheet) ? "true" : "false"}
    >
```

- [ ] **Step 4: Escribir el `@media print`**

Al final de `src/app/admin/obligaciones/page.module.css`:

```css
/* ── Impresión ───────────────────────────────────────────────────────────
   Lo que sale por la impresora es la misma vista sin el cromo de la app: sin
   barra, sin buscador y sin las acciones de fila. El criterio de qué filas se
   imprimen es el mismo que usa el PDF (`isPrintableRow`), aplicado acá por
   clase; las tarjetas que quedarían vacías las marca el componente con
   `data-printable="false"`. */
@media print {
  .page { padding: 0; max-width: none; }
  .toolbar,
  .warning,
  .error,
  .bankTitle,
  .addBtn,
  .rowActions,
  .actionsHeader { display: none !important; }

  /* Una hoja por edificio. La última no fuerza salto, para no dejar una página
     en blanco al final. */
  .sheetCard {
    break-after: page;
    border: none;
    padding: 0 0 8mm;
    margin: 0;
    overflow: visible;
  }
  .sheetCard:last-of-type { break-after: auto; }
  .sheetCard[data-printable="false"] { display: none; }

  /* Salteadas y desactivadas no son parte de lo que hay que pagar. */
  .sheetTable .rowSkipped,
  .sheetTable .rowInactive { display: none; }
  .sheetTable { min-width: 0; font-size: 10pt; }
  .sheetTable td,
  .sheetTable th { border-bottom: 1px solid #999; }
  .sheetTitle { font-size: 16pt; }
  .sheetBank,
  .sheetPeriod { color: #444; }
}

@page {
  size: A4 portrait;
  margin: 12mm;
}
```

**Cuidado con el modo `pure` de CSS Modules:** `.sheetCard[data-printable="false"]` está anclado a la
clase, que es lo que exige el compilador. Un `[data-printable="false"]` suelto rompe `npm run build`.

- [ ] **Step 5: Verificar**

```bash
npx vitest run src/app/admin/obligaciones/components/SheetCard.test.tsx
```

Esperado: PASS.

```bash
npm run build
```

Esperado: `Compiled successfully`. **Este es el comando que detecta el selector impuro.**
**No commitear.**

---

## Task 6: Verificación final y documentación

**Files:**
- Modify: `docs/progreso.md`
- Modify: `docs/decisiones.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Correr la verificación completa**

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npx vitest run
```

```bash
npm run build
```

```bash
npm run build:jobs
```

Esperado: los cinco en verde. Tests: 544 + ~20 nuevos.

- [ ] **Step 2: Escribir la entrada de `docs/decisiones.md`**

Agregar arriba de todo, con fecha del día, cubriendo:
- **Decisión:** dos salidas (descarga e impresión directa) sobre **un solo** `SheetData[]`, con
  `toPrintableSheets` como única definición de qué va al papel — la pantalla muestra todo, el papel
  sólo lo pagable.
- **Decisión:** `jsPDF` + `jspdf-autotable` con `import()` dinámico, para no cargar ~350 KB en un
  panel donde la mayoría de las visitas no descarga nada.
- **Decisión:** el PDF se testea por los **datos** (`toPdfTables`), no por el binario.
- **Alternativa descartada:** generar el PDF en el servidor (Puppeteer suma cientos de MB a una
  imagen Docker que ya arrastra `@napi-rs/canvas` y Tesseract; `pdfkit` obliga a dibujar las tablas a
  mano). Y la de imprimir **sólo** con CSS sin descarga: el owner necesita el archivo en el
  dispositivo (celular o PC) antes de imprimir.

- [ ] **Step 3: Escribir la entrada de `docs/progreso.md`**

Sección nueva arriba de todo con el estado verificado, que **no requiere migración**, y el pendiente
del owner: smoke visual — descargar el PDF en PC y en celular y compararlo con la planilla de
FRANKLIN 25; imprimir y confirmar que no salen tarjetas vacías ni filas salteadas; verificar que un
edificio por hoja y que la última página no queda en blanco.

Actualizar además la sección de la Parte 1: la Parte 2 deja de ser pendiente, y el bloque de
**"Vencidas de meses anteriores"** pasa a ser el próximo trabajo (con su pregunta abierta sobre cómo
se registra el pago de una boleta vieja).

- [ ] **Step 4: Escribir la entrada de `CHANGELOG.md`**

En `## [Unreleased]`, bajo `### Added`, una entrada que describa los dos botones, qué se imprime y
qué no, y las dependencias nuevas.

- [ ] **Step 5: Actualizar `CLAUDE.md`**

En el árbol de directorios, aclarar que `admin/obligaciones/` ahora también genera el PDF imprimible.

- [ ] **Step 6: Avisar al owner**

Informar "listo para commitear", con el resumen de archivos tocados y el pendiente de smoke visual.
**No preparar staging ni sugerir mensaje de commit.**

---

## Notas de riesgo para el implementador

1. **Versión de `jspdf-autotable`.** v5 exporta `autoTable` como named export; v4 y anteriores usan
   `doc.autoTable(...)` tras importar el paquete por su efecto. Verificar en la Task 1 y ajustar.
2. **Acentos en el PDF.** Las fuentes estándar de jsPDF (helvetica) usan WinAnsi, que cubre
   `á é í ó ú ñ · —`. Si al abrir el archivo aparecen caracteres raros en "TÉCNICO" o "PERÍODO",
   la salida rápida es escribir esos rótulos sin acento; la correcta, embeber una fuente TTF.
3. **`window.print()` en el test.** jsdom no lo implementa: si algún test lo dispara, mockearlo con
   `vi.stubGlobal("print", vi.fn())`. Este plan no testea ese botón (no vale la pena testear una
   llamada al navegador).
4. **No tocar la Parte 1.** Si algo empuja a cambiar `buildSheets`, `useObligationsOverview` o los
   endpoints, es señal de que el trabajo se desvió: esta entrega sólo agrega salidas.
5. **Verificar antes de afirmar.** No declarar ninguna tarea terminada sin haber corrido el comando y
   visto la salida.
