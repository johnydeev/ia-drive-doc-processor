# Robustez de `bulk-move-period` (timeout 524) — Plan de implementación

> **Estado:** ejecutado y en producción (2026-07-13/14). **Ajuste vs. este plan:** el tope quedó en **10**
> (no 20 como figura en las Tasks 4/5): medido en prod ~8.5s/boleta → 20 daba 169s/524, 10 da ~82s
> single-shot. Además el modal de resultado desglosa los skips por motivo. Ver `docs/decisiones.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ Regla del proyecto (OVERRIDE):** Claude **no** ejecuta `git commit` ni `git push`. Cada commit a
> `master` es un **deploy real a producción** que hace el **owner**. Los pasos "Commit" los ejecuta el
> owner. No crear ramas (se trabaja en `master`).

> **⚠️ Documentación:** al terminar, actualizar `docs/progreso.md`, `docs/decisiones.md` y `CHANGELOG.md`
> (Task 6).

**Goal:** Que mover ~20 boletas de período complete bajo los 100s (sin 524), que reintentar sea seguro
(idempotente), que el frontend nunca muestre el error crudo y que haya logs para diagnosticar.

**Architecture:** (1) Sheets deja de re-leer la hoja entera por boleta: se lee una vez por lote (índice
de filas) y se escribe celda por celda. (2) El move pasa a ser **idempotente por período destino
explícito**: el execute recibe `{invoiceId, targetPeriodId}` y "asegura X en P" (si ya está, no-op).
(3) El frontend, ante timeout/respuesta no-JSON, no rompe: refresca y ofrece Reintentar. (4) Logs
estructurados por boleta y por lote.

**Tech Stack:** Next.js (App Router) · TypeScript · Prisma/PostgreSQL · Vitest · Google Drive & Sheets.

**Spec:** `docs/superpowers/specs/2026-07-13-bulk-move-timeout-robustez-design.md`

---

## Estructura de archivos

| Archivo | Cambio |
|---|---|
| `src/services/googleSheets.service.ts` | **Modificar.** `SheetRowIndex` + `loadRowIndex` + `findRowInIndex` (puro) + `updatePeriodCellAtRow`. |
| `src/services/googleSheets.rowIndex.test.ts` | **Crear.** Test de `findRowInIndex` (puro). |
| `src/lib/logger.ts` | **Modificar.** Namespace `moveLog`. |
| `src/lib/invoicePeriodMove.ts` | **Modificar.** `MoveSkipReason` extendido, `validateTarget`, `targetPeriodId` en preview, `moveOneInvoiceToTarget` + `moveInvoicesToTargets` (reemplazan a las `…NextPeriod`), `InvoiceMoveContext.sheetRowIndex`. |
| `src/lib/invoicePeriodMove.test.ts` | **Modificar.** Adaptar al contrato por destino + casos nuevos. |
| `src/app/api/client/invoices/bulk-move-period/route.ts` | **Modificar.** Body `{ moves }`, `max(20)`, llama `moveInvoicesToTargets`. |
| `src/app/api/client/invoices/bulk-move-period/preview/route.ts` | **Modificar.** `max(20)`. |
| `src/app/admin/boletas/page.tsx` | **Modificar.** `MAX_MOVE_BATCH=20`, arma `moves`, UX de reintento. |
| `docs/{progreso,decisiones}.md`, `CHANGELOG.md` | **Modificar.** |

Sin migración de DB.

---

## Task 1: Sheets — índice de filas (lectura única) + escritura por fila

**Files:**
- Modify: `src/services/googleSheets.service.ts`
- Test: `src/services/googleSheets.rowIndex.test.ts`

- [ ] **Step 1: Escribir el test que falla** (`googleSheets.rowIndex.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { findRowInIndex, type SheetRowIndex } from "./googleSheets.service";

function makeIndex(): SheetRowIndex {
  return {
    bySource: new Map([["https://drive/a", 5]]),
    byBoleta: new Map([["0001-123", { row: 8, tax: "30111111112" }]]),
  };
}

describe("findRowInIndex", () => {
  it("matchea por sourceFileUrl (prioridad)", () => {
    expect(findRowInIndex(makeIndex(), { sourceFileUrl: "https://drive/a" })).toBe(5);
  });

  it("matchea por boletaNumber + tax", () => {
    expect(findRowInIndex(makeIndex(), { boletaNumber: "0001-123", providerTaxId: "30-11111111-2" })).toBe(8);
  });

  it("boletaNumber sin tax en el filtro → matchea igual", () => {
    expect(findRowInIndex(makeIndex(), { boletaNumber: "0001-123" })).toBe(8);
  });

  it("tax distinto → no matchea", () => {
    expect(findRowInIndex(makeIndex(), { boletaNumber: "0001-123", providerTaxId: "30-99999999-9" })).toBe(-1);
  });

  it("sin coincidencia → -1", () => {
    expect(findRowInIndex(makeIndex(), { sourceFileUrl: "https://drive/z" })).toBe(-1);
  });
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `npx vitest run src/services/googleSheets.rowIndex.test.ts`
Expected: FAIL — `findRowInIndex` / `SheetRowIndex` no exportados.

- [ ] **Step 3: Implementar en `googleSheets.service.ts`**

Agregar cerca de la definición de `SheetsRowMapping` (arriba del archivo, tras los imports/tipos existentes):

```ts
/** Índice pre-cargado de filas de la hoja (para no re-leerla por cada boleta). */
export interface SheetRowIndex {
  bySource: Map<string, number>;
  byBoleta: Map<string, { row: number; tax: string }>;
}

/**
 * Busca la fila (1-based) en un índice ya cargado. Misma lógica de match que
 * `findInvoiceRow` (sourceFileUrl con prioridad; luego boletaNumber + tax opcional).
 * Puro: testeable sin tocar la API de Sheets.
 */
export function findRowInIndex(
  index: SheetRowIndex,
  keys: { boletaNumber?: string | null; sourceFileUrl?: string | null; providerTaxId?: string | null }
): number {
  const source = (keys.sourceFileUrl ?? "").trim();
  if (source) {
    const r = index.bySource.get(source);
    if (r) return r;
  }
  const boleta = (keys.boletaNumber ?? "").trim();
  if (boleta) {
    const hit = index.byBoleta.get(boleta);
    if (hit) {
      const tax = (keys.providerTaxId ?? "").replace(/\D/g, "");
      if (!tax || !hit.tax || hit.tax === tax) return hit.row;
    }
  }
  return -1;
}
```

Agregar los dos métodos de instancia justo después de `findInvoiceRow` (que termina con `return -1; }`):

```ts
  /**
   * Lee la hoja UNA vez y arma un índice fila→claves, para actualizar muchas
   * boletas sin re-leer la hoja por cada una. Los índices son estables mientras
   * solo se actualicen celdas (no se inserten/borren filas).
   */
  async loadRowIndex(sheetName: string, mapping: SheetsRowMapping): Promise<SheetRowIndex> {
    const range = this.getRangeFromMapping(sheetName, mapping);
    const response = await this.withRetry(() =>
      this.sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range })
    );
    const rows = response.data.values ?? [];
    const bySource = new Map<string, number>();
    const byBoleta = new Map<string, { row: number; tax: string }>();
    if (rows.length < 2) return { bySource, byBoleta };

    const columnOffsets = Object.values(mapping).map((c) => this.columnToIndex(c));
    const minIndex = Math.min(...columnOffsets);
    const idx = (col: string) => this.columnToIndex(col) - minIndex;
    const boletaIdx = idx(mapping.boletaNumber);
    const sourceIdx = idx(mapping.sourceFileUrl);
    const taxIdx = idx(mapping.providerTaxId);

    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      const source = (row[sourceIdx] ?? "").toString().trim();
      const boleta = (row[boletaIdx] ?? "").toString().trim();
      const tax = (row[taxIdx] ?? "").toString().replace(/\D/g, "");
      const rowNum = i + 1;
      if (source && !bySource.has(source)) bySource.set(source, rowNum);
      if (boleta && !byBoleta.has(boleta)) byBoleta.set(boleta, { row: rowNum, tax });
    }
    return { bySource, byBoleta };
  }

  /**
   * Actualiza la celda PERIODO de una fila ya conocida (sin re-leer la hoja),
   * con USER_ENTERED para mantener el formato de la hoja (ej. "julio-2026").
   */
  async updatePeriodCellAtRow(
    sheetName: string,
    mapping: SheetsRowMapping,
    rowNumber: number,
    periodLabel: string
  ): Promise<void> {
    await this.withRetry(() =>
      this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!${mapping.period}${rowNumber}:${mapping.period}${rowNumber}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[periodLabel]] },
      })
    );
  }
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `npx vitest run src/services/googleSheets.rowIndex.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verificar typecheck**

Run: `npm run typecheck`
Expected: 0 errores.

- [ ] **Step 6: Commit** (owner)

```bash
git add src/services/googleSheets.service.ts src/services/googleSheets.rowIndex.test.ts
git commit -m "feat(sheets): índice de filas (lectura única) + updatePeriodCellAtRow"
```

---

## Task 2: `moveLog` + `MoveSkipReason` extendido + `validateTarget` + `targetPeriodId` en preview

**Files:**
- Modify: `src/lib/logger.ts`
- Modify: `src/lib/invoicePeriodMove.ts`
- Modify: `src/lib/invoicePeriodMove.test.ts`

- [ ] **Step 1: Agregar `moveLog`** (`logger.ts`, después del bloque `apiLog`, ~línea 450)

```ts
// ═══════════════════════════════════════════════════════════════════════════
// Move (migración de boletas de período) logs
// ═══════════════════════════════════════════════════════════════════════════

/** Logger de la migración de período. El primer arg es un tag (invoiceId corto o "batch"). */
export const moveLog = {
  debug(tag: string, message: string) { log("debug", "move", message, tag); },
  info(tag: string, message: string) { log("info", "move", message, tag); },
  warn(tag: string, message: string) { log("warn", "move", message, tag); },
  error(tag: string, message: string) { log("error", "move", message, tag); },
};
```

- [ ] **Step 2: Escribir los tests que fallan** (agregar en `invoicePeriodMove.test.ts`, tras los tests de `classifyTarget`)

```ts
import { validateTarget } from "./invoicePeriodMove";

describe("validateTarget", () => {
  // fakePrisma y fakeInvoice ya están definidos arriba en este archivo.
  it("skip 'sin_periodo' si la boleta no tiene período", async () => {
    const prisma = fakePrisma(fakeInvoice({ periodId: null, periodRef: null }), null);
    const inv = await prisma.invoice.findFirst({} as never);
    expect(await validateTarget(prisma, inv as never, "perJul")).toEqual({ skip: "sin_periodo" });
  });

  it("skip 'destino_invalido' si el destino no existe", async () => {
    const prisma = fakePrisma(fakeInvoice(), null);
    const inv = await prisma.invoice.findFirst({} as never);
    expect(await validateTarget(prisma, inv as never, "perJul")).toEqual({ skip: "destino_invalido" });
  });

  it("skip 'destino_invalido' si el destino no está ACTIVE", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "CLOSED", consortiumId: "cons1", year: 2026, month: 7 });
    const inv = await prisma.invoice.findFirst({} as never);
    expect(await validateTarget(prisma, inv as never, "perJul")).toEqual({ skip: "destino_invalido" });
  });

  it("skip 'destino_invalido' si el destino es de otro consorcio", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "ACTIVE", consortiumId: "OTRO", year: 2026, month: 7 });
    const inv = await prisma.invoice.findFirst({} as never);
    expect(await validateTarget(prisma, inv as never, "perJul")).toEqual({ skip: "destino_invalido" });
  });

  it("skip 'destino_invalido' si el destino no es el mes inmediatamente siguiente", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perAgo", status: "ACTIVE", consortiumId: "cons1", year: 2026, month: 8 });
    const inv = await prisma.invoice.findFirst({} as never);
    expect(await validateTarget(prisma, inv as never, "perAgo")).toEqual({ skip: "destino_invalido" });
  });

  it("destino válido (ACTIVE, mismo consorcio, mes siguiente) → datos del move", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "ACTIVE", consortiumId: "cons1", year: 2026, month: 7 });
    const inv = await prisma.invoice.findFirst({} as never);
    expect(await validateTarget(prisma, inv as never, "perJul")).toEqual({
      periodId: "perJul", year: 2026, month: 7, fromLabel: "06/2026", toLabel: "07/2026",
    });
  });
});
```

- [ ] **Step 3: Correr y ver que falla**

Run: `npx vitest run src/lib/invoicePeriodMove.test.ts`
Expected: FAIL — `validateTarget` no exportado.

- [ ] **Step 4: Implementar en `invoicePeriodMove.ts`**

4a. Extender el tipo (reemplazar la línea `export type MoveSkipReason = …`):

```ts
export type MoveSkipReason =
  | "sin_periodo"
  | "destino_inexistente"
  | "destino_cerrado"
  | "ya_en_destino"
  | "destino_invalido";
```

4b. Agregar `targetPeriodId` a `MovePreviewResult` (dentro de la interface, tras `toLabel?`):

```ts
  targetPeriodId?: string;
```

4c. En `previewMove`, incluir `targetPeriodId` en la rama movable (reemplazar el `results.push({ … movable: true, … })`):

```ts
      results.push({
        invoiceId, consortium: name, movable: true,
        fromLabel: cls.fromLabel, toLabel: cls.toLabel, targetPeriodId: cls.periodId,
      });
```

4d. Agregar `validateTarget` (después de `classifyTarget`):

```ts
/**
 * Valida un período destino EXPLÍCITO para el move idempotente (execute). A
 * diferencia de `classifyTarget` (que calcula "mes siguiente del actual" para el
 * preview), acá el destino viene dado y se verifica: existe, ACTIVE, mismo
 * consorcio, y es el mes inmediatamente siguiente al período actual de la boleta.
 * (El caso "ya está en el destino" lo resuelve el caller antes de llamar acá.)
 */
export async function validateTarget(
  prisma: PrismaClient,
  invoice: InvoiceForMove,
  targetPeriodId: string
): Promise<{ skip: MoveSkipReason } | { periodId: string; year: number; month: number; fromLabel: string; toLabel: string }> {
  if (!invoice.periodId || !invoice.periodRef || !invoice.consortiumRef) {
    return { skip: "sin_periodo" };
  }
  const target = await prisma.period.findUnique({
    where: { id: targetPeriodId },
    select: { id: true, status: true, consortiumId: true, year: true, month: true },
  });
  if (!target || target.status !== "ACTIVE" || target.consortiumId !== invoice.consortiumRef.id) {
    return { skip: "destino_invalido" };
  }
  const next = nextPeriod(invoice.periodRef.year, invoice.periodRef.month);
  if (target.year !== next.year || target.month !== next.month) {
    return { skip: "destino_invalido" };
  }
  return {
    periodId: target.id,
    year: target.year,
    month: target.month,
    fromLabel: periodLabel(invoice.periodRef.year, invoice.periodRef.month),
    toLabel: periodLabel(target.year, target.month),
  };
}
```

- [ ] **Step 5: Correr y ver que pasa**

Run: `npx vitest run src/lib/invoicePeriodMove.test.ts`
Expected: los tests de `validateTarget` PASAN. (Los de `moveOneInvoiceToNextPeriod` siguen verdes por ahora — se reescriben en Task 3.)

- [ ] **Step 6: Commit** (owner)

```bash
git add src/lib/logger.ts src/lib/invoicePeriodMove.ts src/lib/invoicePeriodMove.test.ts
git commit -m "feat(period-move): validateTarget (destino explícito) + targetPeriodId en preview + moveLog"
```

---

## Task 3: `moveOneInvoiceToTarget` + `moveInvoicesToTargets` (idempotente, con índice de Sheets y logs)

**Files:**
- Modify: `src/lib/invoicePeriodMove.ts`
- Modify: `src/lib/invoicePeriodMove.test.ts`

- [ ] **Step 1: Adaptar/escribir los tests** — en `invoicePeriodMove.test.ts`, (a) cambiar la línea
  de import `import { moveOneInvoiceToNextPeriod, type InvoiceMoveContext } from "./invoicePeriodMove";`
  por la del bloque de abajo, (b) reemplazar la función `makeCtx` existente y (c) reemplazar el bloque
  `describe("moveOneInvoiceToNextPeriod", …)` — todo por lo siguiente:

```ts
import { moveOneInvoiceToTarget, type InvoiceMoveContext } from "./invoicePeriodMove";

function makeCtx(opts: {
  invoice?: Record<string, unknown>;
  target?: unknown;
  drive: ReturnType<typeof fakeDrive>;
  sheets: ReturnType<typeof fakeSheets>;
  order: string[];
  dbThrows?: boolean;
}): InvoiceMoveContext {
  const invoice = fakeInvoice(opts.invoice);
  // ACTIVE, mismo consorcio (cons1), mes siguiente (07/2026) por default.
  const target = "target" in opts ? opts.target : { id: "perJul", status: "ACTIVE", consortiumId: "cons1", year: 2026, month: 7 };
  return {
    prisma: fakePrisma(invoice, target),
    drive: opts.drive as never,
    sheets: opts.sheets as never,
    statementsRootId: "ROOT",
    sheetName: "Datos",
    mapping: {} as never,
    resolveStatements: async () => ({ buildingFolderId: "bld1", periodFolderId: "NEW_FOLDER" }),
    applyDb: async () => {
      opts.order.push("db");
      if (opts.dbThrows) throw new Error("db fail");
    },
  };
}

describe("moveOneInvoiceToTarget", () => {
  it("camino feliz: orden Drive → Sheets → DB y etiquetas correctas", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets();
    const drive2 = { ...drive, moveAndRenameFile: async (...a: [string, string, string, string]) => { order.push("drive"); return drive.moveAndRenameFile(...a); } };
    const sheets2 = { ...sheets, updateInvoicePeriodCell: async (...a: [string, unknown, unknown, string]) => { order.push("sheets"); return sheets.updateInvoicePeriodCell(...a); } };
    const ctx = makeCtx({ drive: drive2 as never, sheets: sheets2 as never, order });

    const res = await moveOneInvoiceToTarget(ctx, "cli1", "inv1", "perJul");

    expect(res).toEqual({ ok: true, fromLabel: "06/2026", toLabel: "07/2026" });
    expect(order).toEqual(["drive", "sheets", "db"]);
    expect(drive.calls[0]).toBe("move:OLD_FOLDER->NEW_FOLDER:EDESUR - ALMIRANTE BROWN 706 - P07-2026 - 0001-00001234.pdf");
  });

  it("idempotencia: si ya está en el destino → skip ya_en_destino sin tocar nada", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets();
    // periodId de la boleta == target
    const ctx = makeCtx({ invoice: { periodId: "perJul" }, drive, sheets, order });

    const res = await moveOneInvoiceToTarget(ctx, "cli1", "inv1", "perJul");

    expect(res).toEqual({ ok: false, skip: "ya_en_destino" });
    expect(drive.calls).toEqual([]);
    expect(sheets.calls).toEqual([]);
    expect(order).toEqual([]);
  });

  it("destino inválido (otro consorcio) → skip destino_invalido sin tocar nada", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets();
    const ctx = makeCtx({ target: { id: "perJul", status: "ACTIVE", consortiumId: "OTRO", year: 2026, month: 7 }, drive, sheets, order });

    const res = await moveOneInvoiceToTarget(ctx, "cli1", "inv1", "perJul");

    expect(res).toEqual({ ok: false, skip: "destino_invalido" });
    expect(drive.calls).toEqual([]);
  });

  it("falla Sheets → revierte Drive, reverted:true", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets(true); // lanza en la 1ª escritura
    const ctx = makeCtx({ drive, sheets, order });

    const res = await moveOneInvoiceToTarget(ctx, "cli1", "inv1", "perJul");

    expect(res).toEqual({ ok: false, error: "sheets fail", reverted: true });
    expect(drive.calls).toEqual([
      "move:OLD_FOLDER->NEW_FOLDER:EDESUR - ALMIRANTE BROWN 706 - P07-2026 - 0001-00001234.pdf",
      "move:NEW_FOLDER->OLD_FOLDER:EDESUR - ALMIRANTE BROWN 706 - P06-2026 - 0001-00001234.pdf",
    ]);
  });

  it("falla DB (último) → revierte Sheets y Drive (LIFO), reverted:true", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets();
    const ctx = makeCtx({ drive, sheets, order, dbThrows: true });

    const res = await moveOneInvoiceToTarget(ctx, "cli1", "inv1", "perJul");

    expect(res).toEqual({ ok: false, error: "db fail", reverted: true });
    expect(sheets.calls).toEqual(["period:07/2026", "period:06/2026"]);
    expect(drive.calls.length).toBe(2);
  });

  it("si una compensación falla → reverted:false", async () => {
    const order: string[] = [];
    const drive = fakeDrive(2); // la 2ª llamada de drive (la compensación) lanza
    const sheets = fakeSheets();
    const ctx = makeCtx({ drive, sheets, order, dbThrows: true });

    const res = await moveOneInvoiceToTarget(ctx, "cli1", "inv1", "perJul");

    expect(res).toMatchObject({ ok: false, error: "db fail", reverted: false });
  });
});
```

> Nota: estos tests NO setean `ctx.sheetRowIndex`, así que `moveOneInvoiceToTarget` usa el **fallback**
> `updateInvoicePeriodCell` — por eso el `fakeSheets` (que ya expone ese método) sigue sirviendo.

- [ ] **Step 2: Correr y ver que falla**

Run: `npx vitest run src/lib/invoicePeriodMove.test.ts`
Expected: FAIL — `moveOneInvoiceToTarget` no existe.

- [ ] **Step 3: Implementar** — en `invoicePeriodMove.ts`:

3a. Ajustar imports (arriba del archivo): **extender** la import existente de `googleSheets.service`
(que hoy trae `GoogleSheetsService, SheetsRowMapping`) y **agregar** la de logger:

```ts
// Reemplazar la línea existente por esta (agrega SheetRowIndex + findRowInIndex):
import { GoogleSheetsService, SheetsRowMapping, SheetRowIndex, findRowInIndex } from "@/services/googleSheets.service";
// Nueva línea:
import { moveLog, shortLogId } from "@/lib/logger";
```

3b. Agregar `sheetRowIndex` a `InvoiceMoveContext` (tras `mapping: SheetsRowMapping;`):

```ts
  /** Índice de filas de la hoja, pre-cargado por lote para no re-leer por boleta. */
  sheetRowIndex?: SheetRowIndex;
```

3c. **Reemplazar** por completo `moveOneInvoiceToNextPeriod` por `moveOneInvoiceToTarget`:

```ts
/**
 * Mueve UNA boleta al período destino EXPLÍCITO `targetPeriodId` (idempotente).
 * Orden: Drive → Sheets → DB, con pila de compensación LIFO por boleta.
 *  - Si la boleta ya está en el destino → no-op (`ya_en_destino`).
 *  - Valida el destino (ACTIVE, mismo consorcio, mes siguiente) → sino `destino_invalido`.
 * Usa `ctx.sheetRowIndex` si está (escritura sin re-leer la hoja); si no, cae al
 * método que re-lee (`updateInvoicePeriodCell`). Nunca lanza.
 */
export async function moveOneInvoiceToTarget(
  ctx: InvoiceMoveContext,
  clientId: string,
  invoiceId: string,
  targetPeriodId: string
): Promise<MoveInvoiceResult> {
  const started = Date.now();
  const tag = shortLogId(invoiceId);

  const invoice = await loadInvoice(ctx.prisma, clientId, invoiceId);
  if (!invoice) return { ok: false, error: "Boleta no encontrada", reverted: true };

  // Idempotencia: ya está en el destino → no-op.
  if (invoice.periodId === targetPeriodId) {
    moveLog.info(tag, "skip ya_en_destino");
    return { ok: false, skip: "ya_en_destino" };
  }

  const v = await validateTarget(ctx.prisma, invoice, targetPeriodId);
  if ("skip" in v) {
    moveLog.info(tag, `skip ${v.skip}`);
    return { ok: false, skip: v.skip };
  }

  const resolveStmts = ctx.resolveStatements ?? resolveStatementsFolders;
  const applyDb = ctx.applyDb ?? ((inv, pid) => applyDbMove(ctx.prisma, inv, pid));

  const oldFileName = buildInvoiceFileName({
    provider: invoice.provider, consortium: invoice.consortium,
    month: invoice.periodRef!.month, year: invoice.periodRef!.year,
    boletaNumber: invoice.boletaNumber, documentHash: invoice.documentHash,
  });
  const newFileName = buildInvoiceFileName({
    provider: invoice.provider, consortium: invoice.consortium,
    month: v.month, year: v.year,
    boletaNumber: invoice.boletaNumber, documentHash: invoice.documentHash,
  });

  const sheetKeys = {
    boletaNumber: invoice.boletaNumber,
    sourceFileUrl: invoice.sourceFileUrl,
    providerTaxId: invoice.providerTaxId,
  };
  const compensations: Array<() => Promise<unknown>> = [];
  let step = "start";

  try {
    // 1. Drive (mover + renombrar). Sólo si la boleta tiene archivo.
    if (invoice.driveFileId) {
      step = "drive";
      const fileId = invoice.driveFileId;
      const parents = await ctx.drive.getFileParents(fileId);
      const oldParent = parents[0] ?? null;
      const { periodFolderId } = await resolveStmts({
        drive: ctx.drive,
        statementsRootId: ctx.statementsRootId,
        consortium: {
          id: invoice.consortiumRef!.id,
          rawName: invoice.consortiumRef!.rawName,
          statementsFolderId: invoice.consortiumRef!.statementsFolderId,
        },
        month: v.month,
        year: v.year,
      });

      if (oldParent && oldParent !== periodFolderId) {
        await ctx.drive.moveAndRenameFile(fileId, oldParent, periodFolderId, newFileName);
        compensations.push(() => ctx.drive.moveAndRenameFile(fileId, periodFolderId, oldParent, oldFileName));
      } else {
        await ctx.drive.renameFile(fileId, newFileName);
        compensations.push(() => ctx.drive.renameFile(fileId, oldFileName));
      }
    }

    // 2. Sheets: celda PERIODO (M) → destino.
    step = "sheets";
    if (ctx.sheetRowIndex) {
      const rowNumber = findRowInIndex(ctx.sheetRowIndex, sheetKeys);
      if (rowNumber >= 2) {
        await ctx.sheets.updatePeriodCellAtRow(ctx.sheetName, ctx.mapping, rowNumber, v.toLabel);
        compensations.push(() => ctx.sheets.updatePeriodCellAtRow(ctx.sheetName, ctx.mapping, rowNumber, v.fromLabel));
      }
    } else {
      await ctx.sheets.updateInvoicePeriodCell(ctx.sheetName, ctx.mapping, sheetKeys, v.toLabel);
      compensations.push(() => ctx.sheets.updateInvoicePeriodCell(ctx.sheetName, ctx.mapping, sheetKeys, v.fromLabel));
    }

    // 3. DB (última, transaccional).
    step = "db";
    await applyDb(invoice, v.periodId);

    moveLog.info(tag, `ok ${v.fromLabel}->${v.toLabel} ${Date.now() - started}ms`);
    return { ok: true, fromLabel: v.fromLabel, toLabel: v.toLabel };
  } catch (err) {
    let reverted = true;
    for (const comp of compensations.reverse()) {
      try {
        await comp();
      } catch {
        reverted = false;
      }
    }
    const msg = err instanceof Error ? err.message : "Error";
    moveLog.error(tag, `failed step=${step} reverted=${reverted}: ${msg} (${Date.now() - started}ms)`);
    return { ok: false, error: msg, reverted };
  }
}
```

3d. **Reemplazar** `moveInvoicesToNextPeriod` por `moveInvoicesToTargets`:

```ts
/**
 * Mueve un lote de boletas a sus períodos destino explícitos. Pre-carga el índice
 * de filas de Sheets UNA vez (evita N lecturas completas). Una boleta fallida o
 * salteada no aborta el resto.
 */
export async function moveInvoicesToTargets(
  ctx: InvoiceMoveContext,
  clientId: string,
  moves: Array<{ invoiceId: string; targetPeriodId: string }>
): Promise<BulkMoveSummary> {
  const started = Date.now();

  if (!ctx.sheetRowIndex) {
    try {
      ctx.sheetRowIndex = await ctx.sheets.loadRowIndex(ctx.sheetName, ctx.mapping);
    } catch (err) {
      moveLog.warn("batch", `no se pudo pre-cargar el índice de Sheets: ${err instanceof Error ? err.message : "Error"}`);
    }
  }

  let moved = 0;
  const skipped: BulkMoveSummary["skipped"] = [];
  const failed: BulkMoveSummary["failed"] = [];

  for (const { invoiceId, targetPeriodId } of moves) {
    const r = await moveOneInvoiceToTarget(ctx, clientId, invoiceId, targetPeriodId);
    if (r.ok) moved += 1;
    else if ("skip" in r) skipped.push({ invoiceId, reason: r.skip });
    else failed.push({ invoiceId, error: r.error, reverted: r.reverted });
  }

  moveLog.info("batch", `total=${moves.length} moved=${moved} skipped=${skipped.length} failed=${failed.length} ${Date.now() - started}ms`);
  return { moved, skipped, failed, total: moves.length };
}
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `npx vitest run src/lib/invoicePeriodMove.test.ts`
Expected: PASS (todos: `validateTarget` + `moveOneInvoiceToTarget`).

- [ ] **Step 5: Verificar typecheck** (detecta que la ruta execute todavía usa el nombre viejo)

Run: `npm run typecheck`
Expected: error en `bulk-move-period/route.ts` (usa `moveInvoicesToNextPeriod`). Se arregla en Task 4.

- [ ] **Step 6: Commit** (owner)

```bash
git add src/lib/invoicePeriodMove.ts src/lib/invoicePeriodMove.test.ts
git commit -m "feat(period-move): move idempotente por destino explícito + índice de Sheets + logs"
```

---

## Task 4: Endpoints — contrato `moves` + tope 20

**Files:**
- Modify: `src/app/api/client/invoices/bulk-move-period/route.ts`
- Modify: `src/app/api/client/invoices/bulk-move-period/preview/route.ts`

- [ ] **Step 1: Reescribir el endpoint execute** (`bulk-move-period/route.ts`)

```ts
import { z } from "zod";
import { apiOk, apiError, withClientAuth } from "@/lib/apiHandler";
import { resolveMoveContext, moveInvoicesToTargets } from "@/lib/invoicePeriodMove";

// Tope de 20 por tanda: cada boleta hace ~3-4 llamadas a Google; un lote más
// grande superaría el timeout de ~100s del túnel Cloudflare (524). La UI también
// lo valida y avisa; esto es el guardrail del server.
const bodySchema = z.object({
  moves: z.array(z.object({
    invoiceId: z.string().min(1),
    targetPeriodId: z.string().min(1),
  })).min(1).max(20),
});

/**
 * POST /api/client/invoices/bulk-move-period  { moves: [{ invoiceId, targetPeriodId }] }
 *
 * Mueve cada boleta a su período destino EXPLÍCITO (idempotente: si ya está ahí,
 * no-op). Reintentar la misma lista es seguro. Una boleta fallida/salteada no
 * aborta el lote.
 */
export const POST = withClientAuth(async ({ request, session }) => {
  const { moves } = bodySchema.parse(await request.json());

  const resolved = await resolveMoveContext(session.clientId);
  if ("error" in resolved) return apiError(new Error(resolved.error), resolved.status);

  const summary = await moveInvoicesToTargets(resolved.ctx, session.clientId, moves);
  return apiOk({ ...summary });
});
```

- [ ] **Step 2: Bajar el tope del preview a 20** (`bulk-move-period/preview/route.ts`)

Reemplazar `.min(1).max(40)` por `.min(1).max(20)`:

```ts
const bodySchema = z.object({
  invoiceIds: z.array(z.string().min(1)).min(1).max(20),
});
```

- [ ] **Step 3: Verificar typecheck**

Run: `npm run typecheck`
Expected: 0 errores.

- [ ] **Step 4: Commit** (owner)

```bash
git add src/app/api/client/invoices/bulk-move-period
git commit -m "feat(api): bulk-move-period contrato moves + tope 20"
```

---

## Task 5: UI — tope 20, armado de `moves`, UX de reintento

**Files:**
- Modify: `src/app/admin/boletas/page.tsx`

- [ ] **Step 1: Bajar el tope a 20** — reemplazar la constante:

```tsx
const MAX_MOVE_BATCH = 20;
```

- [ ] **Step 2: Extender el tipo del preview y el estado** — reemplazar el `type MovePreviewItem` por (agrega `targetPeriodId`):

```tsx
type MovePreviewItem = { invoiceId: string; consortium: string | null; movable: boolean; fromLabel?: string; toLabel?: string; targetPeriodId?: string; skip?: string };
```

Y agregar estado nuevo junto a los otros de move (tras `const [moveResult, setMoveResult] = …`):

```tsx
  const [pendingMoves, setPendingMoves] = useState<Array<{ invoiceId: string; targetPeriodId: string }>>([]);
  const [pendingItems, setPendingItems] = useState<Array<{ invoiceId: string; toLabel?: string; fromLabel?: string }>>([]);
```

Y ampliar el tipo de `moveStep` (reemplazar su declaración) para incluir `"unknown"`:

```tsx
  const [moveStep, setMoveStep] = useState<null | "preview" | "result" | "unknown">(null);
```

- [ ] **Step 3: Reemplazar `confirmMove`** por la versión robusta + `runMove`:

```tsx
  const runMove = useCallback(async (moves: Array<{ invoiceId: string; targetPeriodId: string }>) => {
    if (moves.length === 0) return;
    setMoving(true);
    setError(null);
    try {
      const res = await guardedFetch("/api/client/invoices/bulk-move-period", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moves }),
      });
      let data: MoveSummary | null = null;
      try { data = (await res.json()) as MoveSummary; } catch { data = null; }

      if (!res.ok || !data || !(data as unknown as { ok?: boolean }).ok) {
        // Resultado desconocido (timeout 524 / HTML / red). NO romper.
        setPendingMoves(moves);
        setSelected(new Set());
        await fetchInvoices();
        setMoveStep("unknown");
        return;
      }

      setMoveResult(data);
      setMoveStep("result");
      setSelected(new Set());
      await fetchInvoices();
    } catch {
      // Error de red / timeout del fetch.
      setPendingMoves(moves);
      setSelected(new Set());
      await fetchInvoices();
      setMoveStep("unknown");
    } finally {
      setMoving(false);
    }
  }, [guardedFetch, fetchInvoices]);

  const confirmMove = useCallback(async () => {
    const items = movePreview.filter((i) => i.movable && i.targetPeriodId);
    const moves = items.map((i) => ({ invoiceId: i.invoiceId, targetPeriodId: i.targetPeriodId! }));
    setPendingItems(items.map((i) => ({ invoiceId: i.invoiceId, toLabel: i.toLabel, fromLabel: i.fromLabel })));
    await runMove(moves);
  }, [movePreview, runMove]);
```

- [ ] **Step 4: Conteo best-effort para el paso "unknown"** — agregar tras `const skippablePreview = …`:

```tsx
  // Conteo best-effort tras un timeout: de las que se intentaron, cuántas ya
  // muestran el destino en la lista refrescada vs. siguen en el origen.
  const invoiceById = useMemo(() => new Map(invoices.map((i) => [i.id, i])), [invoices]);
  const doneCount = pendingItems.filter((it) => it.toLabel && invoiceById.get(it.invoiceId)?.period === it.toLabel).length;
  const stillPendingCount = pendingItems.length - doneCount;
```

- [ ] **Step 5: Agregar el paso "unknown" al modal** — dentro del bloque `{moveStep !== null && (…)}`, después del bloque `{moveStep === "result" && …}`, agregar:

```tsx
            {moveStep === "unknown" && (
              <>
                <h2 style={{ marginTop: 0 }}>No pude confirmar el resultado</h2>
                <p>
                  Puede que la operación haya terminado igual (los lotes grandes a veces cortan la
                  conexión pero el proceso sigue). Revisé la lista:
                </p>
                <p>
                  <strong>{doneCount}</strong> ya figuran en el período nuevo ·{" "}
                  <strong>{stillPendingCount}</strong> podrían seguir en el anterior.
                </p>
                <p style={{ color: "#b45309" }}>
                  Si quedaron pendientes, reintentá — es seguro, no mueve dos veces.
                </p>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                  <button type="button" className={styles.ghostBtn} onClick={closeMoveModal} disabled={moving}>Cerrar</button>
                  <button type="button" className={styles.ghostBtn}
                    style={{ background: "#2563eb", borderColor: "#2563eb", color: "#fff" }}
                    disabled={moving} onClick={() => void runMove(pendingMoves)}>
                    {moving ? "Reintentando..." : "Reintentar"}
                  </button>
                </div>
              </>
            )}
```

- [ ] **Step 6: Agregar los labels de los skips nuevos** — en el objeto `SKIP_LABELS`, agregar dos entradas:

```tsx
    ya_en_destino: "ya estaba en el período destino",
    destino_invalido: "el período destino ya no es válido (recargá y reintentá)",
```

- [ ] **Step 7: Verificar typecheck + lint + build**

Run: `npm run typecheck`
Expected: 0 errores.
Run: `npm run lint`
Expected: 0 errores (warnings preexistentes OK).
Run: `npm run build`
Expected: build OK.

- [ ] **Step 8: Verificación manual (owner, `npm run dev`)**

1. Seleccionar >20 → el botón avisa "hasta 20 por tanda".
2. Mover ≤20 con período siguiente ACTIVE → modal de resultado con contadores; la lista refresca con el período nuevo (formato "julio-2026").
3. Reintentar el mismo lote (volver a seleccionar y mover) → todas caen en `ya_en_destino` (0 movidas), sin duplicar el avance.

- [ ] **Step 9: Commit** (owner)

```bash
git add src/app/admin/boletas/page.tsx
git commit -m "feat(ui): bulk-move tope 20 + UX de reintento robusta ante timeout"
```

---

## Task 6: Documentación + verificación final

**Files:**
- Modify: `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`

- [ ] **Step 1: `docs/progreso.md`** — nueva sección al inicio:

```markdown
## Robustez de `bulk-move-period` ante timeout 524 (2026-07-13)

**Estado: implementado y verificado (typecheck + lint 0 errores + tests + build:jobs OK). Sin migración.
Sin commitear (lo hace el owner).**

Mover ~20 boletas pegaba el 524 del túnel (>100s). Cambios:
- **Sheets 1 lectura/lote:** `loadRowIndex` + `findRowInIndex` + `updatePeriodCellAtRow` (antes cada
  boleta re-leía la hoja entera). Baja ~9s→~2-3s/boleta.
- **Move idempotente por destino explícito:** el execute recibe `{ moves: [{invoiceId, targetPeriodId}] }`;
  `moveOneInvoiceToTarget` "asegura X en P" (si ya está → `ya_en_destino`). Reintentar es seguro.
- **Frontend robusto:** ante timeout/respuesta no-JSON, muestra paso "unknown" con conteo best-effort y
  botón Reintentar (en vez del error crudo). Tope 20.
- **Logs:** `moveLog` por boleta (paso que falló, duración, reverted) + resumen de lote.

Spec/plan: `docs/superpowers/{specs,plans}/2026-07-13-bulk-move-timeout-robustez*`.
```

- [ ] **Step 2: `docs/decisiones.md`** — entrada nueva (tras el header `---`):

```markdown
## 2026-07-13 — bulk-move-period: idempotencia por destino explícito + Sheets 1 lectura/lote

**Problema:** mover ~20 boletas superaba los 100s → 524 de Cloudflare (HTML parseado como JSON en el
front). Además el move no era idempotente (reintentar avanzaba +1 otra vez) y quedaba un riesgo de
estado parcial si el proceso moría a la mitad.

**Decisión:** (1) **Sheets set-based en la lectura**: leer la hoja una vez por lote (`loadRowIndex`) y
escribir celda por celda (`updatePeriodCellAtRow`), en vez de re-leer la hoja entera por boleta. (2)
**Idempotencia por destino explícito**: el execute recibe `targetPeriodId` por boleta; el move "asegura
X en P" y saltea si ya está (`ya_en_destino`), validando destino ACTIVE + mismo consorcio + mes
siguiente. Reintentar la misma lista nunca avanza de más y reconcilia parciales (DB last = fuente de
verdad, pasos idempotentes). (3) **Frontend**: timeout ≠ error crudo → paso "unknown" + Reintentar. (4)
Tope 20. (5) `moveLog` estructurado.

**Alternativas descartadas:** cola/worker en background (opción 3) — correcto a largo plazo pero más
trabajo; se dejó anotado. Paralelizar llamadas a Google — riesgo de carreras al crear carpetas.

**Impacto:** `googleSheets.service.ts` (índice + escritura por fila), `invoicePeriodMove.ts` (contrato
por destino), `logger.ts` (`moveLog`), endpoints `bulk-move-period`, UI `boletas/page.tsx`. Sin migración.
```

- [ ] **Step 3: `CHANGELOG.md`** — bajo `## [Unreleased]`, en `### Fixed`:

```markdown
- **`bulk-move-period` daba 524 con lotes grandes (2026-07-13)**. Mover ~20 boletas superaba los 100s
  del túnel. Se optimizó Sheets (1 lectura/lote en vez de re-leer por boleta), el move pasó a ser
  idempotente por período destino explícito (reintentar es seguro), el frontend maneja el timeout sin
  romper (paso "unknown" + Reintentar) y se bajó el tope a 20. Logs `moveLog` por boleta y lote.
```

- [ ] **Step 4: Verificación final completa**

Run: `npm run typecheck`
Run: `npm run lint`
Run: `npx vitest run`
Run: `npm run build:jobs`
Expected: todo OK, sin regresiones.

- [ ] **Step 5: Commit** (owner)

```bash
git add docs/progreso.md docs/decisiones.md CHANGELOG.md
git commit -m "docs: robustez bulk-move-period (timeout 524)"
```

---

## Notas de reutilización / cuidado

- **No romper la compensación LIFO:** el orden Drive→Sheets→DB y la pila de compensación se mantienen; el
  índice de Sheets solo cambia *cómo* se ubica/escribe la fila, no el modelo de reversión.
- **`ctx.sheetRowIndex` es mutable:** lo setea `moveInvoicesToTargets` una vez por lote. Si falla la
  pre-carga, `moveOneInvoiceToTarget` cae al `updateInvoicePeriodCell` (re-lee) — correcto, solo más lento.
- **Idempotencia:** la seguridad del reintento depende de que el destino sea EXPLÍCITO (no "actual+1"). No
  volver a calcular el destino dentro del execute.
- **Preview sin cambios de request:** sigue recibiendo `invoiceIds`; solo agrega `targetPeriodId` a la
  respuesta. La UI arma `moves` con eso.
