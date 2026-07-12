# Migrar boleta al período siguiente — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ Regla del proyecto (OVERRIDE):** Claude **no** ejecuta `git commit` ni `git push`. Cada
> commit a `master` es un **deploy real a producción** que hace el **owner**. Los pasos
> **"Commit"** de este plan los ejecuta el owner: Claude deja el árbol de trabajo listo,
> verifica (typecheck + lint + test + build:jobs) y avisa. No crear ramas (se trabaja en `master`).

> **⚠️ Regla del proyecto:** al terminar, actualizar `docs/progreso.md`, `docs/decisiones.md` y
> `CHANGELOG.md` (Task 8). El trabajo no está terminado sin eso.

**Goal:** Agregar una acción masiva en `/admin/boletas` que mueva cada boleta seleccionada al
período siguiente (+1 mes) de su consorcio, manteniendo consistentes DB, Google Sheets, el PDF
en Drive y las obligaciones de gastos fijos, con reversión por boleta ante cualquier fallo.

**Architecture:** Espeja el patrón del borrado masivo (`lib/invoiceDeletion.ts` +
`api/client/invoices/bulk-delete` + acción en `/admin/boletas`). Un nuevo módulo
`lib/invoicePeriodMove.ts` concentra la lógica: por boleta hace Drive → Sheets → DB (última y
transaccional) con una **pila de compensación** que revierte los pasos externos si algo falla.
Dos endpoints (preview sin efectos + ejecución) y un modal de 2 pasos en la UI.

**Tech Stack:** Next.js (App Router) · TypeScript · Prisma/PostgreSQL · Vitest · Google Drive &
Sheets API (`googleapis`).

**Spec:** `docs/superpowers/specs/2026-07-10-migrar-boleta-periodo-design.md`

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/services/googleDrive.service.ts` | **Modificar.** Nuevo método `moveAndRenameFile` (mover+renombrar en 1 llamada atómica). |
| `src/lib/invoiceDeletion.ts` | **Modificar.** Exportar `DEFAULT_SHEETS_MAPPING` para reusar (DRY). |
| `src/lib/invoicePeriodMove.ts` | **Crear.** Tipos, `nextPeriod`, `classifyTarget`, `previewMove`, `applyDbMove`, `moveOneInvoiceToNextPeriod`, `moveInvoicesToNextPeriod`, `resolveMoveContext`. |
| `src/lib/invoicePeriodMove.test.ts` | **Crear.** Tests de período destino, skips, orden y reversión. |
| `src/app/api/client/invoices/bulk-move-period/preview/route.ts` | **Crear.** POST preview (sin efectos). |
| `src/app/api/client/invoices/bulk-move-period/route.ts` | **Crear.** POST ejecución. |
| `src/app/admin/boletas/page.tsx` | **Modificar.** Botón + modal de 2 pasos. |
| `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md` | **Modificar.** Documentación obligatoria. |

---

## Task 1: Método `moveAndRenameFile` en GoogleDriveService

**Files:**
- Modify: `src/services/googleDrive.service.ts` (junto a `moveFileToFolder`, ~línea 237)

- [ ] **Step 1: Agregar el método**

Insertar después de `moveFileToFolder` (que termina ~línea 237):

```ts
  /**
   * Mueve Y renombra un archivo en UNA sola llamada atómica a Drive (o aplica
   * todo o nada). Usado por la migración de período, que necesita mover el PDF a
   * la subcarpeta del período nuevo y renombrarlo (el nombre embebe el período,
   * `P06-2026` → `P07-2026`) sin ventana intermedia inconsistente.
   */
  async moveAndRenameFile(
    fileId: string,
    fromFolderId: string,
    toFolderId: string,
    newName: string
  ): Promise<void> {
    await this.drive.files.update({
      fileId,
      addParents: toFolderId,
      removeParents: fromFolderId,
      requestBody: { name: newName },
      fields: "id, parents, name",
      supportsAllDrives: true,
    });
  }
```

- [ ] **Step 2: Verificar typecheck**

Run: `npm run typecheck`
Expected: 0 errores.

- [ ] **Step 3: Commit** (lo ejecuta el owner)

```bash
git add src/services/googleDrive.service.ts
git commit -m "feat(drive): moveAndRenameFile atómico para migración de período"
```

---

## Task 2: Exportar `DEFAULT_SHEETS_MAPPING` desde invoiceDeletion (DRY)

**Files:**
- Modify: `src/lib/invoiceDeletion.ts:34-40`

- [ ] **Step 1: Renombrar la constante local a exportada**

Reemplazar la declaración actual (`const DEFAULT_MAPPING: SheetsRowMapping = {…}`) por:

```ts
/**
 * Mapeo de columnas por defecto de la hoja de boletas (A–U). Se exporta para que
 * otros flujos (migración de período) reusen el mismo default sin duplicarlo.
 */
export const DEFAULT_SHEETS_MAPPING: SheetsRowMapping = {
  boletaNumber: "A", provider: "B", consortium: "C", providerTaxId: "D",
  detail: "E", observation: "F", dueDate: "G", amount: "H", alias: "I",
  clientNumber: "J", sourceFileUrl: "K", isDuplicate: "L", period: "M",
  paymentStatus: "N", bank: "O", remainingBalance: "P", paidAmount: "Q",
  installmentsCount: "R", paymentDate: "S", receiptUrl: "T", paidWith: "U",
};
```

- [ ] **Step 2: Actualizar el uso interno**

En `resolveDeletionContext` (~línea 70), cambiar `?? DEFAULT_MAPPING` por
`?? DEFAULT_SHEETS_MAPPING`.

- [ ] **Step 3: Verificar typecheck**

Run: `npm run typecheck`
Expected: 0 errores.

- [ ] **Step 4: Commit** (owner)

```bash
git add src/lib/invoiceDeletion.ts
git commit -m "refactor(sheets): exportar DEFAULT_SHEETS_MAPPING para reuso"
```

---

## Task 3: Núcleo de `invoicePeriodMove.ts` — tipos, período destino y clasificación

**Files:**
- Create: `src/lib/invoicePeriodMove.ts`
- Test: `src/lib/invoicePeriodMove.test.ts`

- [ ] **Step 1: Escribir el test que falla** (`invoicePeriodMove.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { nextPeriod, classifyTarget, previewMove } from "./invoicePeriodMove";

/** Invoice mínimo con los campos que usa la migración. */
function fakeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv1",
    clientId: "cli1",
    periodId: "perJun",
    driveFileId: "file1",
    sourceFileUrl: "https://drive/inv1",
    boletaNumber: "0001-00001234",
    providerTaxId: "30-11111111-1",
    provider: "EDESUR",
    consortium: "ALMIRANTE BROWN 706",
    documentHash: "abcdef1234567890",
    providerId: "prov1",
    lspServiceId: null,
    periodRef: { year: 2026, month: 6 },
    consortiumRef: { id: "cons1", rawName: "ALMIRANTE BROWN 706", statementsFolderId: "bld1" },
    ...overrides,
  };
}

/** Prisma falso: sólo las lecturas que usa classify/preview. */
function fakePrisma(invoice: unknown, targetPeriod: unknown): PrismaClient {
  return {
    invoice: { findFirst: async () => invoice },
    period: { findUnique: async () => targetPeriod },
  } as unknown as PrismaClient;
}

describe("nextPeriod", () => {
  it("avanza un mes dentro del año", () => {
    expect(nextPeriod(2026, 6)).toEqual({ year: 2026, month: 7 });
  });
  it("envuelve diciembre a enero del año siguiente", () => {
    expect(nextPeriod(2026, 12)).toEqual({ year: 2027, month: 1 });
  });
});

describe("classifyTarget", () => {
  it("skip 'sin_periodo' cuando la boleta no tiene período", async () => {
    const prisma = fakePrisma(fakeInvoice({ periodId: null, periodRef: null }), null);
    const inv = await prisma.invoice.findFirst({} as never);
    const res = await classifyTarget(prisma, inv as never);
    expect(res).toEqual({ skip: "sin_periodo" });
  });

  it("skip 'destino_inexistente' cuando no existe el período +1", async () => {
    const prisma = fakePrisma(fakeInvoice(), null);
    const inv = await prisma.invoice.findFirst({} as never);
    const res = await classifyTarget(prisma, inv as never);
    expect(res).toEqual({ skip: "destino_inexistente" });
  });

  it("skip 'destino_cerrado' cuando el período +1 existe pero está CLOSED", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "CLOSED" });
    const inv = await prisma.invoice.findFirst({} as never);
    const res = await classifyTarget(prisma, inv as never);
    expect(res).toEqual({ skip: "destino_cerrado" });
  });

  it("resuelve destino ACTIVE con etiquetas from/to", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "ACTIVE" });
    const inv = await prisma.invoice.findFirst({} as never);
    const res = await classifyTarget(prisma, inv as never);
    expect(res).toEqual({
      periodId: "perJul",
      targetYear: 2026,
      targetMonth: 7,
      fromLabel: "06/2026",
      toLabel: "07/2026",
    });
  });
});

describe("previewMove", () => {
  it("marca movable + etiquetas para destino ACTIVE", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "ACTIVE" });
    const [row] = await previewMove(prisma, "cli1", ["inv1"]);
    expect(row).toEqual({
      invoiceId: "inv1",
      consortium: "ALMIRANTE BROWN 706",
      movable: true,
      fromLabel: "06/2026",
      toLabel: "07/2026",
    });
  });

  it("marca no-movable con motivo para destino cerrado", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "CLOSED" });
    const [row] = await previewMove(prisma, "cli1", ["inv1"]);
    expect(row).toMatchObject({ invoiceId: "inv1", movable: false, skip: "destino_cerrado" });
  });
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `npx vitest run src/lib/invoicePeriodMove.test.ts`
Expected: FAIL — `Cannot find module './invoicePeriodMove'` / export no definido.

- [ ] **Step 3: Implementar el núcleo** (`src/lib/invoicePeriodMove.ts`)

```ts
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";

export type MoveSkipReason = "sin_periodo" | "destino_inexistente" | "destino_cerrado";

/** Campos de la boleta que usa la migración (proyección del select). */
export interface InvoiceForMove {
  id: string;
  clientId: string;
  periodId: string | null;
  driveFileId: string | null;
  sourceFileUrl: string | null;
  boletaNumber: string | null;
  providerTaxId: string | null;
  provider: string | null;
  consortium: string | null;
  documentHash: string;
  providerId: string | null;
  lspServiceId: string | null;
  periodRef: { year: number; month: number } | null;
  consortiumRef: { id: string; rawName: string; statementsFolderId: string | null } | null;
}

export type ClassifyResult =
  | { skip: MoveSkipReason }
  | {
      periodId: string;
      targetYear: number;
      targetMonth: number;
      fromLabel: string;
      toLabel: string;
    };

export interface MovePreviewResult {
  invoiceId: string;
  consortium: string | null;
  movable: boolean;
  fromLabel?: string;
  toLabel?: string;
  skip?: MoveSkipReason;
}

/** +1 mes, envolviendo diciembre → enero del año siguiente. */
export function nextPeriod(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** "MM/YYYY" (formato de la columna PERIODO en Sheets). */
export function periodLabel(year: number, month: number): string {
  return `${String(month).padStart(2, "0")}/${year}`;
}

/** Carga la boleta con la proyección que usa la migración. Null si no existe. */
export async function loadInvoice(
  prisma: PrismaClient,
  clientId: string,
  invoiceId: string
): Promise<InvoiceForMove | null> {
  return prisma.invoice.findFirst({
    where: { id: invoiceId, clientId },
    select: {
      id: true, clientId: true, periodId: true, driveFileId: true, sourceFileUrl: true,
      boletaNumber: true, providerTaxId: true, provider: true, consortium: true,
      documentHash: true, providerId: true, lspServiceId: true,
      periodRef: { select: { year: true, month: true } },
      consortiumRef: { select: { id: true, rawName: true, statementsFolderId: true } },
    },
  }) as Promise<InvoiceForMove | null>;
}

/**
 * Determina el destino (+1 mes del consorcio de la boleta) o el motivo de skip.
 * - sin_periodo: la boleta no tiene período (o consorcio) actual.
 * - destino_inexistente: no existe el Period +1 de ese consorcio.
 * - destino_cerrado: existe pero no está ACTIVE (no se ensucian períodos cerrados).
 */
export async function classifyTarget(
  prisma: PrismaClient,
  invoice: InvoiceForMove
): Promise<ClassifyResult> {
  if (!invoice.periodId || !invoice.periodRef || !invoice.consortiumRef) {
    return { skip: "sin_periodo" };
  }
  const { year, month } = nextPeriod(invoice.periodRef.year, invoice.periodRef.month);
  const target = await prisma.period.findUnique({
    where: {
      consortiumId_year_month: { consortiumId: invoice.consortiumRef.id, year, month },
    },
    select: { id: true, status: true },
  });
  if (!target) return { skip: "destino_inexistente" };
  if (target.status !== "ACTIVE") return { skip: "destino_cerrado" };
  return {
    periodId: target.id,
    targetYear: year,
    targetMonth: month,
    fromLabel: periodLabel(invoice.periodRef.year, invoice.periodRef.month),
    toLabel: periodLabel(year, month),
  };
}

/** Preview sin efectos: para cada id calcula movible/skip (sólo lecturas de DB). */
export async function previewMove(
  prisma: PrismaClient,
  clientId: string,
  invoiceIds: string[]
): Promise<MovePreviewResult[]> {
  const results: MovePreviewResult[] = [];
  for (const invoiceId of invoiceIds) {
    const invoice = await loadInvoice(prisma, clientId, invoiceId);
    if (!invoice) {
      results.push({ invoiceId, consortium: null, movable: false });
      continue;
    }
    const name = invoice.consortium ?? invoice.consortiumRef?.rawName ?? null;
    const cls = await classifyTarget(prisma, invoice);
    if ("skip" in cls) {
      results.push({ invoiceId, consortium: name, movable: false, skip: cls.skip });
    } else {
      results.push({
        invoiceId, consortium: name, movable: true,
        fromLabel: cls.fromLabel, toLabel: cls.toLabel,
      });
    }
  }
  return results;
}
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `npx vitest run src/lib/invoicePeriodMove.test.ts`
Expected: PASS (todos los `describe` de este task).

- [ ] **Step 5: Commit** (owner)

```bash
git add src/lib/invoicePeriodMove.ts src/lib/invoicePeriodMove.test.ts
git commit -m "feat(period-move): núcleo de clasificación de destino + preview"
```

---

## Task 4: `applyDbMove` + `moveOneInvoiceToNextPeriod` (camino feliz + reversión)

**Files:**
- Modify: `src/lib/invoicePeriodMove.ts`
- Modify: `src/lib/invoicePeriodMove.test.ts`

- [ ] **Step 1: Escribir los tests que fallan** (agregar al final de `invoicePeriodMove.test.ts`)

```ts
import { moveOneInvoiceToNextPeriod, type InvoiceMoveContext } from "./invoicePeriodMove";

/** Drive falso: registra llamadas; puede lanzar en la N-ésima llamada de move/rename. */
function fakeDrive(throwOnDriveCall?: number) {
  const calls: string[] = [];
  let n = 0;
  const move = async (fileId: string, from: string, to: string, name: string) => {
    n += 1;
    calls.push(`move:${from}->${to}:${name}`);
    if (throwOnDriveCall === n) throw new Error("drive fail");
  };
  return {
    calls,
    getFileParents: async () => ["OLD_FOLDER"],
    moveAndRenameFile: move,
    renameFile: async (_id: string, name: string) => { calls.push(`rename:${name}`); },
  };
}

/** Sheets falso: registra el valor de period escrito; puede lanzar la 1ª vez. */
function fakeSheets(throwFirst = false) {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    updateInvoicePaymentInfo: async (
      _sheet: string, _map: unknown, _keys: unknown, values: { period?: string }
    ) => {
      n += 1;
      calls.push(`period:${values.period}`);
      if (throwFirst && n === 1) throw new Error("sheets fail");
      return true;
    },
  };
}

function makeCtx(opts: {
  invoice?: Record<string, unknown>;
  target?: unknown;
  drive: ReturnType<typeof fakeDrive>;
  sheets: ReturnType<typeof fakeSheets>;
  order: string[];
  dbThrows?: boolean;
}): InvoiceMoveContext {
  const invoice = fakeInvoice(opts.invoice);
  const target = opts.target ?? { id: "perJul", status: "ACTIVE" };
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

describe("moveOneInvoiceToNextPeriod", () => {
  it("camino feliz: orden Drive → Sheets → DB y etiquetas correctas", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets();
    // envolver drive/sheets para registrar el orden global
    const drive2 = { ...drive, moveAndRenameFile: async (...a: [string,string,string,string]) => { order.push("drive"); return drive.moveAndRenameFile(...a); } };
    const sheets2 = { ...sheets, updateInvoicePaymentInfo: async (...a: [string,unknown,unknown,{period?:string}]) => { order.push("sheets"); return sheets.updateInvoicePaymentInfo(...a); } };
    const ctx = makeCtx({ drive: drive2 as never, sheets: sheets2 as never, order });

    const res = await moveOneInvoiceToNextPeriod(ctx, "cli1", "inv1");

    expect(res).toEqual({ ok: true, fromLabel: "06/2026", toLabel: "07/2026" });
    expect(order).toEqual(["drive", "sheets", "db"]);
    expect(drive.calls[0]).toBe("move:OLD_FOLDER->NEW_FOLDER:EDESUR - ALMIRANTE BROWN 706 - P07-2026 - 0001-00001234.pdf");
  });

  it("falla Sheets → revierte Drive y reporta reverted:true", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets(true); // lanza en la 1ª escritura
    const ctx = makeCtx({ drive, sheets, order });

    const res = await moveOneInvoiceToNextPeriod(ctx, "cli1", "inv1");

    expect(res).toEqual({ ok: false, error: "sheets fail", reverted: true });
    // Drive: forward + compensación (volver a OLD_FOLDER con nombre viejo)
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

    const res = await moveOneInvoiceToNextPeriod(ctx, "cli1", "inv1");

    expect(res).toEqual({ ok: false, error: "db fail", reverted: true });
    // Sheets: forward "07/2026" + compensación "06/2026"
    expect(sheets.calls).toEqual(["period:07/2026", "period:06/2026"]);
    // Drive: forward + compensación
    expect(drive.calls.length).toBe(2);
  });

  it("si una compensación falla → reverted:false", async () => {
    const order: string[] = [];
    const drive = fakeDrive(2); // la 2ª llamada de drive (la compensación) lanza
    const sheets = fakeSheets();
    const ctx = makeCtx({ drive, sheets, order, dbThrows: true });

    const res = await moveOneInvoiceToNextPeriod(ctx, "cli1", "inv1");

    expect(res).toMatchObject({ ok: false, error: "db fail", reverted: false });
  });

  it("skip se propaga sin tocar Drive/Sheets", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets();
    const ctx = makeCtx({ drive, sheets, order, target: null }); // destino_inexistente

    const res = await moveOneInvoiceToNextPeriod(ctx, "cli1", "inv1");

    expect(res).toEqual({ ok: false, skip: "destino_inexistente" });
    expect(drive.calls).toEqual([]);
    expect(sheets.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `npx vitest run src/lib/invoicePeriodMove.test.ts`
Expected: FAIL — `moveOneInvoiceToNextPeriod` / `InvoiceMoveContext` no exportados.

- [ ] **Step 3: Implementar** (agregar a `src/lib/invoicePeriodMove.ts`)

Agregar los imports arriba del archivo:

```ts
import { GoogleDriveService } from "@/services/googleDrive.service";
import { GoogleSheetsService, SheetsRowMapping } from "@/services/googleSheets.service";
import { resolveStatementsFolders } from "@/services/statementsFolders.service";
import { buildInvoiceFileName } from "@/lib/statementsNaming";
import { linkInvoiceToObligation } from "@/services/obligation.service";
```

Agregar al final del archivo:

```ts
export type MoveInvoiceResult =
  | { ok: true; fromLabel: string; toLabel: string }
  | { ok: false; skip: MoveSkipReason }
  | { ok: false; error: string; reverted: boolean };

export interface InvoiceMoveContext {
  prisma: PrismaClient;
  drive: GoogleDriveService;
  sheets: GoogleSheetsService;
  statementsRootId: string;
  sheetName: string;
  mapping: SheetsRowMapping;
  /** Seams inyectables (default a la impl real; se sobreescriben en tests). */
  resolveStatements?: typeof resolveStatementsFolders;
  applyDb?: (invoice: InvoiceForMove, newPeriodId: string) => Promise<void>;
}

/**
 * Transacción de DB: reasigna el período y reajusta la obligación de gasto fijo.
 * Es el ÚLTIMO paso; si lanza, Prisma hace rollback → no requiere compensación manual.
 */
export async function applyDbMove(
  prisma: PrismaClient,
  invoice: InvoiceForMove,
  newPeriodId: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // La obligación vinculada a esta boleta (si hay) vuelve a PENDING.
    await tx.expenseObligation.updateMany({
      where: { invoiceId: invoice.id },
      data: { status: "PENDING", invoiceId: null },
    });
    await tx.invoice.update({ where: { id: invoice.id }, data: { periodId: newPeriodId } });
    // Re-vincula a una obligación PENDING del período nuevo, si matchea.
    await linkInvoiceToObligation(
      { id: invoice.id, periodId: newPeriodId, providerId: invoice.providerId, lspServiceId: invoice.lspServiceId },
      tx as unknown as PrismaClient
    );
  });
}

/**
 * Mueve UNA boleta al período siguiente de su consorcio. Orden: Drive → Sheets → DB.
 * Ante cualquier fallo revierte lo ya hecho (pila de compensación LIFO) → la boleta
 * queda como estaba. Nunca lanza: devuelve un resultado discriminado.
 */
export async function moveOneInvoiceToNextPeriod(
  ctx: InvoiceMoveContext,
  clientId: string,
  invoiceId: string
): Promise<MoveInvoiceResult> {
  const invoice = await loadInvoice(ctx.prisma, clientId, invoiceId);
  if (!invoice) return { ok: false, error: "Boleta no encontrada", reverted: true };

  const cls = await classifyTarget(ctx.prisma, invoice);
  if ("skip" in cls) return { ok: false, skip: cls.skip };

  const resolveStmts = ctx.resolveStatements ?? resolveStatementsFolders;
  const applyDb = ctx.applyDb ?? ((inv, pid) => applyDbMove(ctx.prisma, inv, pid));

  const oldFileName = buildInvoiceFileName({
    provider: invoice.provider, consortium: invoice.consortium,
    month: invoice.periodRef!.month, year: invoice.periodRef!.year,
    boletaNumber: invoice.boletaNumber, documentHash: invoice.documentHash,
  });
  const newFileName = buildInvoiceFileName({
    provider: invoice.provider, consortium: invoice.consortium,
    month: cls.targetMonth, year: cls.targetYear,
    boletaNumber: invoice.boletaNumber, documentHash: invoice.documentHash,
  });

  const compensations: Array<() => Promise<unknown>> = [];

  try {
    // 1. Drive (mover + renombrar). Sólo si la boleta tiene archivo.
    if (invoice.driveFileId) {
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
        month: cls.targetMonth,
        year: cls.targetYear,
      });

      if (oldParent && oldParent !== periodFolderId) {
        await ctx.drive.moveAndRenameFile(fileId, oldParent, periodFolderId, newFileName);
        compensations.push(() =>
          ctx.drive.moveAndRenameFile(fileId, periodFolderId, oldParent, oldFileName)
        );
      } else {
        // Misma carpeta o sin parent conocido → sólo renombrar.
        await ctx.drive.renameFile(fileId, newFileName);
        compensations.push(() => ctx.drive.renameFile(fileId, oldFileName));
      }
    }

    // 2. Sheets: celda PERIODO (M) → destino.
    await ctx.sheets.updateInvoicePaymentInfo(
      ctx.sheetName, ctx.mapping,
      { boletaNumber: invoice.boletaNumber, sourceFileUrl: invoice.sourceFileUrl, providerTaxId: invoice.providerTaxId },
      { period: cls.toLabel }
    );
    compensations.push(() =>
      ctx.sheets.updateInvoicePaymentInfo(
        ctx.sheetName, ctx.mapping,
        { boletaNumber: invoice.boletaNumber, sourceFileUrl: invoice.sourceFileUrl, providerTaxId: invoice.providerTaxId },
        { period: cls.fromLabel }
      )
    );

    // 3. DB (última, transaccional).
    await applyDb(invoice, cls.periodId);

    return { ok: true, fromLabel: cls.fromLabel, toLabel: cls.toLabel };
  } catch (err) {
    let reverted = true;
    for (const comp of compensations.reverse()) {
      try {
        await comp();
      } catch {
        reverted = false;
      }
    }
    return { ok: false, error: err instanceof Error ? err.message : "Error", reverted };
  }
}
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `npx vitest run src/lib/invoicePeriodMove.test.ts`
Expected: PASS (todos los tests de los Task 3 y 4).

- [ ] **Step 5: Commit** (owner)

```bash
git add src/lib/invoicePeriodMove.ts src/lib/invoicePeriodMove.test.ts
git commit -m "feat(period-move): mover una boleta con reversión por compensación (TDD)"
```

---

## Task 5: Contexto + runner de lote (`resolveMoveContext`, `moveInvoicesToNextPeriod`)

**Files:**
- Modify: `src/lib/invoicePeriodMove.ts`

- [ ] **Step 1: Implementar** (agregar imports + funciones)

Agregar imports arriba:

```ts
import {
  loadProcessingClient,
  resolveGoogleConfig,
  resolveSheetName,
  resolveMapping,
  resolveFolders,
} from "@/lib/clientProcessingConfig";
import { DEFAULT_SHEETS_MAPPING } from "@/lib/invoiceDeletion";
```

Agregar al final:

```ts
export interface BulkMoveSummary {
  moved: number;
  skipped: Array<{ invoiceId: string; reason: MoveSkipReason }>;
  failed: Array<{ invoiceId: string; error: string; reverted: boolean }>;
  total: number;
}

/**
 * Resuelve el contexto de Google (Drive + Sheets + config) UNA vez por lote.
 * Espeja `resolveDeletionContext`. Exige la carpeta Rendiciones (statements).
 */
export async function resolveMoveContext(
  clientId: string
): Promise<{ ctx: InvoiceMoveContext } | { error: string; status: number }> {
  const processingClient = await loadProcessingClient(clientId);
  if (!processingClient) return { error: "Cliente no encontrado", status: 404 };

  const googleConfig = resolveGoogleConfig(processingClient);
  if (!googleConfig) return { error: "Sin credenciales de Google configuradas", status: 400 };

  const folders = resolveFolders(processingClient);
  if (!folders.statements) {
    return { error: "Falta la carpeta Rendiciones (statements) en la config del cliente", status: 400 };
  }

  return {
    ctx: {
      prisma: getPrismaClient(),
      drive: new GoogleDriveService(googleConfig),
      sheets: new GoogleSheetsService(googleConfig),
      statementsRootId: folders.statements,
      sheetName: resolveSheetName(processingClient),
      mapping: resolveMapping(processingClient) ?? DEFAULT_SHEETS_MAPPING,
    },
  };
}

/** Recorre las boletas; una fallida/salteada no aborta el resto. */
export async function moveInvoicesToNextPeriod(
  ctx: InvoiceMoveContext,
  clientId: string,
  invoiceIds: string[]
): Promise<BulkMoveSummary> {
  let moved = 0;
  const skipped: BulkMoveSummary["skipped"] = [];
  const failed: BulkMoveSummary["failed"] = [];

  for (const invoiceId of invoiceIds) {
    const r = await moveOneInvoiceToNextPeriod(ctx, clientId, invoiceId);
    if (r.ok) moved += 1;
    else if ("skip" in r) skipped.push({ invoiceId, reason: r.skip });
    else failed.push({ invoiceId, error: r.error, reverted: r.reverted });
  }

  return { moved, skipped, failed, total: invoiceIds.length };
}
```

- [ ] **Step 2: Verificar typecheck + tests**

Run: `npm run typecheck`
Expected: 0 errores.
Run: `npx vitest run src/lib/invoicePeriodMove.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit** (owner)

```bash
git add src/lib/invoicePeriodMove.ts
git commit -m "feat(period-move): contexto de Google + runner de lote"
```

---

## Task 6: Endpoints (preview + ejecución)

**Files:**
- Create: `src/app/api/client/invoices/bulk-move-period/preview/route.ts`
- Create: `src/app/api/client/invoices/bulk-move-period/route.ts`

- [ ] **Step 1: Endpoint de preview**

```ts
import { z } from "zod";
import { apiOk, withClientAuth } from "@/lib/apiHandler";
import { getPrismaClient } from "@/lib/prisma";
import { previewMove } from "@/lib/invoicePeriodMove";

const bodySchema = z.object({
  invoiceIds: z.array(z.string().min(1)).min(1).max(200),
});

/**
 * POST /api/client/invoices/bulk-move-period/preview  { invoiceIds: string[] }
 *
 * Sin efectos. Para cada boleta indica si es movible al período siguiente y con
 * qué etiquetas (06/2026 → 07/2026), o el motivo de skip. Alimenta el paso 1 del
 * modal de confirmación.
 */
export const POST = withClientAuth(async ({ request, session }) => {
  const { invoiceIds } = bodySchema.parse(await request.json());
  const items = await previewMove(getPrismaClient(), session.clientId, invoiceIds);
  return apiOk({ items });
});
```

- [ ] **Step 2: Endpoint de ejecución**

```ts
import { z } from "zod";
import { apiOk, apiError, withClientAuth } from "@/lib/apiHandler";
import { resolveMoveContext, moveInvoicesToNextPeriod } from "@/lib/invoicePeriodMove";

const bodySchema = z.object({
  invoiceIds: z.array(z.string().min(1)).min(1).max(200),
});

/**
 * POST /api/client/invoices/bulk-move-period  { invoiceIds: string[] }
 *
 * Mueve cada boleta al período siguiente de su consorcio (DB + Sheets + Drive +
 * obligaciones), con reversión por boleta ante fallo. El contexto de Google se
 * resuelve una vez. Una boleta fallida/salteada no aborta el lote.
 */
export const POST = withClientAuth(async ({ request, session }) => {
  const { invoiceIds } = bodySchema.parse(await request.json());

  const resolved = await resolveMoveContext(session.clientId);
  if ("error" in resolved) return apiError(new Error(resolved.error), resolved.status);

  const summary = await moveInvoicesToNextPeriod(resolved.ctx, session.clientId, invoiceIds);
  return apiOk(summary);
});
```

- [ ] **Step 3: Verificar typecheck + build**

Run: `npm run typecheck`
Expected: 0 errores.

- [ ] **Step 4: Commit** (owner)

```bash
git add src/app/api/client/invoices/bulk-move-period
git commit -m "feat(api): endpoints preview + ejecución de migración de período"
```

---

## Task 7: UI — botón + modal de 2 pasos en `/admin/boletas`

**Files:**
- Modify: `src/app/admin/boletas/page.tsx`

- [ ] **Step 1: Agregar estado del modal** (después de la línea `const [deleting, setDeleting] = useState(false);`, ~línea 72)

```tsx
  const [moving, setMoving] = useState(false);
  type MovePreviewItem = { invoiceId: string; consortium: string | null; movable: boolean; fromLabel?: string; toLabel?: string; skip?: string };
  type MoveSummary = { moved: number; skipped: Array<{ invoiceId: string; reason: string }>; failed: Array<{ invoiceId: string; error: string; reverted: boolean }>; total: number };
  const [moveStep, setMoveStep] = useState<null | "preview" | "result">(null);
  const [movePreview, setMovePreview] = useState<MovePreviewItem[]>([]);
  const [moveResult, setMoveResult] = useState<MoveSummary | null>(null);
```

- [ ] **Step 2: Agregar el mapa de motivos legibles + handlers** (después de `handleDeleteSelected`, ~línea 165)

```tsx
  const SKIP_LABELS: Record<string, string> = {
    sin_periodo: "sin período asignado",
    destino_inexistente: "el período siguiente no existe todavía (cerrá el período primero)",
    destino_cerrado: "el período siguiente está cerrado",
  };

  const openMoveModal = useCallback(async () => {
    if (selectedCount === 0) return;
    setError(null);
    setNotice(null);
    setMoveResult(null);
    setMoving(true);
    try {
      const res = await guardedFetch("/api/client/invoices/bulk-move-period/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceIds: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMovePreview(data.items as MovePreviewItem[]);
      setMoveStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al previsualizar");
    } finally {
      setMoving(false);
    }
  }, [guardedFetch, selected, selectedCount]);

  const confirmMove = useCallback(async () => {
    setMoving(true);
    setError(null);
    try {
      const res = await guardedFetch("/api/client/invoices/bulk-move-period", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceIds: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMoveResult(data as MoveSummary);
      setMoveStep("result");
      setSelected(new Set());
      await fetchInvoices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al mover");
    } finally {
      setMoving(false);
    }
  }, [guardedFetch, selected, fetchInvoices]);

  const closeMoveModal = useCallback(() => {
    setMoveStep(null);
    setMovePreview([]);
    setMoveResult(null);
  }, []);

  const movableCount = movePreview.filter((i) => i.movable).length;
  const skippablePreview = movePreview.filter((i) => !i.movable);
```

- [ ] **Step 3: Agregar el botón** (junto al de "Borrar seleccionadas", después de su `</button>`, ~línea 198)

```tsx
          <button type="button" className={styles.ghostBtn}
            disabled={selectedCount === 0 || moving || deleting} onClick={() => void openMoveModal()}>
            {moving && moveStep === null ? "Cargando..." : `Mover al período siguiente${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
          </button>
```

- [ ] **Step 4: Agregar el modal** (antes del cierre `</main>` del return, al final del JSX)

```tsx
        {moveStep !== null && (
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}
            onClick={closeMoveModal}
          >
            <div
              style={{ background: theme === "dark" ? "#111827" : "#fff", color: theme === "dark" ? "#f9fafb" : "#111827", borderRadius: 12, padding: 24, maxWidth: 560, width: "90%", maxHeight: "80vh", overflowY: "auto" }}
              onClick={(e) => e.stopPropagation()}
            >
              {moveStep === "preview" && (
                <>
                  <h2 style={{ marginTop: 0 }}>Mover al período siguiente</h2>
                  <p><strong>{movableCount}</strong> boleta(s) se moverán al mes siguiente de su consorcio.</p>
                  <ul style={{ maxHeight: 180, overflowY: "auto", paddingLeft: 18 }}>
                    {movePreview.filter((i) => i.movable).map((i) => (
                      <li key={i.invoiceId}>{i.consortium ?? "(sin consorcio)"}: {i.fromLabel} → {i.toLabel}</li>
                    ))}
                  </ul>
                  {skippablePreview.length > 0 && (
                    <>
                      <p style={{ color: "#b45309" }}><strong>{skippablePreview.length}</strong> se saltearán:</p>
                      <ul style={{ maxHeight: 140, overflowY: "auto", paddingLeft: 18, color: "#b45309" }}>
                        {skippablePreview.map((i) => (
                          <li key={i.invoiceId}>{i.consortium ?? "(sin consorcio)"}: {i.skip ? SKIP_LABELS[i.skip] ?? i.skip : "no evaluable"}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                    <button type="button" className={styles.ghostBtn} onClick={closeMoveModal} disabled={moving}>Cancelar</button>
                    <button type="button" className={styles.ghostBtn}
                      style={{ background: "#2563eb", borderColor: "#2563eb", color: "#fff", opacity: movableCount > 0 ? 1 : 0.5 }}
                      disabled={moving || movableCount === 0} onClick={() => void confirmMove()}>
                      {moving ? "Moviendo..." : `Confirmar (${movableCount})`}
                    </button>
                  </div>
                </>
              )}
              {moveStep === "result" && moveResult && (
                <>
                  <h2 style={{ marginTop: 0 }}>Resultado</h2>
                  <p>
                    <strong>{moveResult.moved}</strong> movida(s) · <strong>{moveResult.skipped.length}</strong> salteada(s) · <strong>{moveResult.failed.length}</strong> con error
                  </p>
                  {moveResult.failed.length > 0 && (
                    <ul style={{ maxHeight: 180, overflowY: "auto", paddingLeft: 18, color: "#b91c1c" }}>
                      {moveResult.failed.map((f) => (
                        <li key={f.invoiceId}>
                          {f.invoiceId}: {f.error}{f.reverted ? " (revertida)" : " — NO revertida, revisar manualmente"}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
                    <button type="button" className={styles.ghostBtn} onClick={closeMoveModal}>Cerrar</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
```

- [ ] **Step 5: Verificar typecheck + lint + build**

Run: `npm run typecheck`
Expected: 0 errores.
Run: `npm run lint`
Expected: 0 errores.
Run: `npm run build`
Expected: build OK.

- [ ] **Step 6: Verificación manual (owner, `npm run dev`)**

1. En `/admin/boletas`, seleccionar boletas de un consorcio cuyo período siguiente **exista y esté ACTIVE** → "Mover al período siguiente" → el modal muestra `MM/AAAA → MM/AAAA` → Confirmar → contadores; la lista refresca con el período nuevo.
2. Verificar en Google Sheets que la celda PERIODO cambió y en Drive que el PDF se renombró (`P07-…`) y está en la subcarpeta del mes nuevo.
3. Seleccionar boletas cuyo período siguiente **no exista** → aparecen en "se saltearán" con el motivo.

- [ ] **Step 7: Commit** (owner)

```bash
git add src/app/admin/boletas/page.tsx
git commit -m "feat(ui): botón + modal de 2 pasos para migrar boletas de período"
```

---

## Task 8: Documentación obligatoria

**Files:**
- Modify: `docs/progreso.md` (entrada nueva arriba)
- Modify: `docs/decisiones.md` (entrada con fecha 2026-07-10)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: `docs/progreso.md`** — nueva sección al inicio:

```markdown
## Migrar boleta al período siguiente (2026-07-10)

**Estado: implementado y verificado (typecheck + lint + tests + build:jobs OK). Sin migración.
Sin commitear (lo hace el owner → deploy automático).**

Acción masiva en `/admin/boletas`: seleccionar boletas y moverlas al período siguiente (+1 mes)
de su consorcio, resolviendo DB + Google Sheets + PDF en Drive + obligaciones de gastos fijos.
Solo mueve a un período destino que exista y esté ACTIVE (sino saltea con aviso: `sin_periodo`,
`destino_inexistente`, `destino_cerrado`). Reversión por boleta ante cualquier fallo (Drive →
Sheets → DB con pila de compensación LIFO; DB última y transaccional). Modal de 2 pasos
(preview → resultado). Nuevo `lib/invoicePeriodMove.ts` + método `moveAndRenameFile` en el
servicio de Drive. Spec/plan: `docs/superpowers/{specs,plans}/2026-07-10-migrar-boleta-periodo*`.
```

- [ ] **Step 2: `docs/decisiones.md`** — entrada nueva:

```markdown
## Migración de período: orden Drive → Sheets → DB con compensación (2026-07-10)

**Problema:** al olvidar cerrar un período, entran boletas que quedan en el mes equivocado. El
workaround era borrar + cerrar período + reprocesar. Se quiere mover las boletas directo, tocando
tres sistemas sin transacción común (Drive, Sheets, DB) sin dejar estados inconsistentes.

**Decisión:** por boleta, ejecutar Drive → Sheets → DB con una pila de compensación (LIFO). La DB
va **última** y es transaccional, así su propio rollback cubre `periodId` + obligaciones sin
inversión manual; las únicas compensaciones son las de los pasos externos (una llamada inversa
cada uno). Drive mueve+renombra en **una sola llamada atómica** (`moveAndRenameFile`). Si algún
paso falla, se revierte lo hecho y la boleta queda como estaba; el lote continúa y se reporta al
final. Solo se mueve a períodos existentes y ACTIVE (no se crean períodos ni se cierran: eso es
"Cerrar Periodo General"). La subcarpeta de período creada en Drive no se borra al revertir (es
válida e inofensiva; se reutiliza al reintentar).

**Alternativas descartadas:** (a) crear el período destino si falta → rompe la invariante de un
solo período ACTIVE por consorcio; (b) saga/reintentos distribuidos → YAGNI.

**Impacto:** nuevo `src/lib/invoicePeriodMove.ts` (+ test), `moveAndRenameFile` en
`googleDrive.service.ts`, endpoints `bulk-move-period` (+ `/preview`), UI en `admin/boletas`.
Sin migración de DB.
```

- [ ] **Step 3: `CHANGELOG.md`** — agregar bajo la fecha de hoy:

```markdown
### 2026-07-10
- feat: migrar boletas de período (+1 mes) desde la vista de boletas entrantes, con reversión
  por boleta (Drive + Sheets + DB + obligaciones) y modal de 2 pasos (preview → resultado).
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
git commit -m "docs: migración de boletas de período"
```

---

## Notas de reutilización (no reinventar)

- `resolveStatementsFolders` — edificio + subcarpeta de período (crea si falta).
- `buildInvoiceFileName` — naming con período embebido (`P07-2026`).
- `updateInvoicePaymentInfo({ period })` — actualiza sólo la celda PERIODO por fila.
- `linkInvoiceToObligation(invoice, tx)` — vínculo boleta↔obligación del período nuevo.
- `loadProcessingClient` / `resolveGoogleConfig` / `resolveFolders` / `resolveSheetName` /
  `resolveMapping` — contexto Google (igual que `invoiceDeletion`).
- `DEFAULT_SHEETS_MAPPING` — exportado de `invoiceDeletion` (Task 2).
```
