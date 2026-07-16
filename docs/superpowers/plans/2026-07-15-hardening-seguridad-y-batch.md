# Hardening de seguridad + robustez batch + docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar los hallazgos del análisis de seguridad/arquitectura de la sesión 44: bulk-delete a prueba de 524, revocación de sesión en ≤60s, hardening menor (apiError/JWT/login), test de guard de auth, y pasada de docs.

**Architecture:** Cambios quirúrgicos sobre módulos existentes + 2 módulos nuevos con lógica pura testeable (`sessionRevocation.ts`, `adjustIndexAfterDelete`). Sin migración de DB. Los guards de auth pasan a async (re-chequeo de `isActive` con cache 60s), propagación mecánica de `await` en ~39 rutas.

**Tech Stack:** Next.js App Router, Prisma, Vitest, googleapis (Sheets/Drive), zod.

**Spec:** `docs/superpowers/specs/2026-07-15-hardening-seguridad-y-batch-design.md`

**⚠️ REGLA DEL PROYECTO: NO commitear ni pushear — lo hace el owner (cada commit a master es deploy real a producción).** Los pasos de "commit" habituales se reemplazan por checkpoints de verificación.

---

### Task 1: `adjustIndexAfterDelete` + `deleteRowAtNumber` en el servicio de Sheets

**Files:**
- Modify: `src/services/googleSheets.service.ts` (junto a `findRowInIndex`, ~línea 65, y junto a `deleteInvoiceRow`, ~línea 698)
- Test: `src/services/googleSheets.rowIndex.test.ts` (archivo existente)

- [ ] **Step 1: Escribir tests que fallan para `adjustIndexAfterDelete`**

Agregar al final de `src/services/googleSheets.rowIndex.test.ts`:

```typescript
import { adjustIndexAfterDelete } from "./googleSheets.service"; // sumar al import existente

describe("adjustIndexAfterDelete", () => {
  function makeIndex(): SheetRowIndex {
    return {
      bySource: new Map([
        ["url-a", 2],
        ["url-b", 3],
        ["url-c", 5],
      ]),
      byBoleta: new Map([
        ["0001", { row: 2, tax: "30111111118" }],
        ["0002", { row: 3, tax: "30222222229" }],
        ["0003", { row: 5, tax: "" }],
      ]),
    };
  }

  it("decrementa en 1 las filas mayores a la borrada y elimina la fila borrada", () => {
    const index = makeIndex();
    adjustIndexAfterDelete(index, 3);
    expect(index.bySource.get("url-a")).toBe(2); // menor: no cambia
    expect(index.bySource.has("url-b")).toBe(false); // borrada: sale del índice
    expect(index.bySource.get("url-c")).toBe(4); // mayor: baja 1
    expect(index.byBoleta.get("0001")?.row).toBe(2);
    expect(index.byBoleta.has("0002")).toBe(false);
    expect(index.byBoleta.get("0003")?.row).toBe(4);
  });

  it("dos borrados consecutivos acumulan el corrimiento", () => {
    const index = makeIndex();
    adjustIndexAfterDelete(index, 2); // url-a fuera; url-b→2, url-c→4
    adjustIndexAfterDelete(index, 2); // url-b fuera; url-c→3
    expect(index.bySource.has("url-a")).toBe(false);
    expect(index.bySource.has("url-b")).toBe(false);
    expect(index.bySource.get("url-c")).toBe(3);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run src/services/googleSheets.rowIndex.test.ts`
Expected: FAIL — `adjustIndexAfterDelete` no existe.

- [ ] **Step 3: Implementar `adjustIndexAfterDelete`**

En `src/services/googleSheets.service.ts`, debajo de `findRowInIndex` (~línea 65):

```typescript
/**
 * Ajusta el índice tras borrar una fila de la hoja: la fila borrada sale del
 * índice y todas las filas siguientes suben una posición (deleteDimension hace
 * shift-up). MUTA el índice recibido — el caller mantiene la referencia del lote.
 */
export function adjustIndexAfterDelete(index: SheetRowIndex, deletedRowNumber: number): void {
  for (const [key, row] of index.bySource) {
    if (row === deletedRowNumber) index.bySource.delete(key);
    else if (row > deletedRowNumber) index.bySource.set(key, row - 1);
  }
  for (const [key, hit] of index.byBoleta) {
    if (hit.row === deletedRowNumber) index.byBoleta.delete(key);
    else if (hit.row > deletedRowNumber) index.byBoleta.set(key, { ...hit, row: hit.row - 1 });
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run src/services/googleSheets.rowIndex.test.ts`
Expected: PASS (los nuevos + los existentes del archivo).

- [ ] **Step 5: Extraer `deleteRowAtNumber` de `deleteInvoiceRow`**

En la clase `GoogleSheetsService`, agregar método (junto a `deleteInvoiceRow`, ~línea 698) y dejar `deleteInvoiceRow` como wrapper:

```typescript
/**
 * Borra una fila YA CONOCIDA de la hoja (sin re-leerla). deleteDimension hace
 * shift-up: el caller debe ajustar su índice con `adjustIndexAfterDelete`.
 */
async deleteRowAtNumber(sheetName: string, rowNumber: number): Promise<boolean> {
  if (rowNumber < 2) return false;
  const sheetId = await this.getSheetId(sheetName);
  if (sheetId === null) return false;

  // Sheets API usa índices 0-based; rowNumber es 1-based.
  await this.withRetry(() =>
    this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: { sheetId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber },
            },
          },
        ],
      },
    })
  );
  return true;
}
```

Y `deleteInvoiceRow` queda:

```typescript
async deleteInvoiceRow(
  sheetName: string,
  mapping: SheetsRowMapping,
  keys: { boletaNumber?: string | null; sourceFileUrl?: string | null; providerTaxId?: string | null }
): Promise<boolean> {
  const rowNumber = await this.findInvoiceRow(sheetName, mapping, keys);
  if (rowNumber < 2) return false;
  return this.deleteRowAtNumber(sheetName, rowNumber);
}
```

- [ ] **Step 6: Checkpoint**

Run: `npx vitest run src/services/googleSheets.rowIndex.test.ts` y `npm run typecheck`
Expected: verde / 0 errores.

---

### Task 2: `invoiceDeletion` con índice de Sheets por lote

**Files:**
- Modify: `src/lib/invoiceDeletion.ts`
- Modify: `src/app/api/client/invoices/bulk-delete/route.ts`
- Test: `src/lib/invoiceDeletion.test.ts` (nuevo)

- [ ] **Step 1: Escribir test que falla (1 lectura de hoja por lote)**

Crear `src/lib/invoiceDeletion.test.ts`. Se testea la unidad nueva `deleteInvoicesWithIndex` (wrapper de lote) con servicios falsos — el objetivo es contar lecturas:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock de prisma: invoice fija sin pagos ni recibo, y transacción no-op.
const fakeInvoice = {
  id: "inv-1", clientId: "cli-1", driveFileId: null, sourceFileUrl: "url-a",
  boletaNumber: "0001", providerTaxId: "30-11111111-8",
  _count: { payments: 0 }, receipt: null,
};
const findFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  getPrismaClient: () => ({
    invoice: { findFirst },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        receipt: { delete: vi.fn() },
        expenseObligation: { updateMany: vi.fn() },
        invoice: { delete: vi.fn() },
      })
    ),
  }),
}));

import { deleteInvoicesWithIndex, type InvoiceDeletionContext } from "./invoiceDeletion";
import { DEFAULT_SHEETS_MAPPING } from "./invoiceDeletion";

function makeCtx() {
  const loadRowIndex = vi.fn(async () => ({
    bySource: new Map([["url-a", 2], ["url-b", 3]]),
    byBoleta: new Map(),
  }));
  const deleteRowAtNumber = vi.fn(async () => true);
  const ctx = {
    driveService: { getFileParents: vi.fn(), moveFileToFolder: vi.fn(), trashFile: vi.fn() },
    sheetsService: { loadRowIndex, deleteRowAtNumber },
    folders: { pending: "f-pending", failed: "f-failed", scanned: null, unassigned: null },
    sheetName: "Datos",
    mapping: DEFAULT_SHEETS_MAPPING,
  } as unknown as InvoiceDeletionContext;
  return { ctx, loadRowIndex, deleteRowAtNumber };
}

beforeEach(() => {
  findFirst.mockReset();
});

describe("deleteInvoicesWithIndex", () => {
  it("lee la hoja UNA sola vez para todo el lote", async () => {
    findFirst
      .mockResolvedValueOnce({ ...fakeInvoice, id: "inv-1", sourceFileUrl: "url-a" })
      .mockResolvedValueOnce({ ...fakeInvoice, id: "inv-2", sourceFileUrl: "url-b" });
    const { ctx, loadRowIndex, deleteRowAtNumber } = makeCtx();

    const results = await deleteInvoicesWithIndex(ctx, "cli-1", ["inv-1", "inv-2"], "pending");

    expect(loadRowIndex).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.ok)).toBe(true);
    // url-a estaba en fila 2; url-b en fila 3, pero tras borrar la 2 sube a la 2.
    expect(deleteRowAtNumber).toHaveBeenNthCalledWith(1, "Datos", 2);
    expect(deleteRowAtNumber).toHaveBeenNthCalledWith(2, "Datos", 2);
  });

  it("boleta inexistente reporta 404 sin abortar el lote", async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...fakeInvoice, id: "inv-2", sourceFileUrl: "url-b" });
    const { ctx } = makeCtx();

    const results = await deleteInvoicesWithIndex(ctx, "cli-1", ["inv-x", "inv-2"], "pending");

    expect(results[0]).toMatchObject({ ok: false, status: 404 });
    expect(results[1].ok).toBe(true);
  });

  it("fila no encontrada en el índice: continúa (Sheets ya estaba desincronizado)", async () => {
    findFirst.mockResolvedValueOnce({ ...fakeInvoice, sourceFileUrl: "url-zzz", boletaNumber: null });
    const { ctx, deleteRowAtNumber } = makeCtx();

    const results = await deleteInvoicesWithIndex(ctx, "cli-1", ["inv-1"], "pending");

    expect(results[0].ok).toBe(true);
    expect(deleteRowAtNumber).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run src/lib/invoiceDeletion.test.ts`
Expected: FAIL — `deleteInvoicesWithIndex` no existe.

- [ ] **Step 3: Implementar en `invoiceDeletion.ts`**

Cambios:
1. Import: sumar `SheetRowIndex`, `findRowInIndex`, `adjustIndexAfterDelete` desde `@/services/googleSheets.service`.
2. `deleteOneInvoice` recibe el índice como 5º parámetro **obligatorio** y reemplaza el bloque "Fila de Sheets" (líneas ~137-146):

```typescript
export async function deleteOneInvoice(
  ctx: InvoiceDeletionContext,
  clientId: string,
  invoiceId: string,
  destination: InvoiceDeleteDestination,
  rowIndex: SheetRowIndex
): Promise<InvoiceDeleteResult> {
  // ... todo igual hasta el bloque de Sheets ...

  // Fila de Sheets: buscar en el índice del lote (1 lectura por lote, no por boleta).
  try {
    const rowNumber = findRowInIndex(rowIndex, {
      boletaNumber: invoice.boletaNumber,
      sourceFileUrl: invoice.sourceFileUrl,
      providerTaxId: invoice.providerTaxId,
    });
    if (rowNumber >= 2) {
      const deleted = await ctx.sheetsService.deleteRowAtNumber(ctx.sheetName, rowNumber);
      if (deleted) adjustIndexAfterDelete(rowIndex, rowNumber);
    }
    // rowNumber -1: la fila no está en la hoja (desincronización previa) → seguir igual
    // que hoy (deleteInvoiceRow devolvía false y no se cortaba el borrado).
  } catch (err) {
    return { ok: false, status: 502, error: `Sheets falló al borrar la fila: ${err instanceof Error ? err.message : "Error"}` };
  }

  // ... transacción DB igual ...
}
```

3. Nuevo wrapper de lote (después de `deleteOneInvoice`):

```typescript
/**
 * Borra un lote de boletas cargando el índice de la hoja UNA sola vez.
 * Una boleta fallida no aborta el resto. Devuelve un resultado por invoiceId
 * en el mismo orden de entrada.
 */
export async function deleteInvoicesWithIndex(
  ctx: InvoiceDeletionContext,
  clientId: string,
  invoiceIds: string[],
  destination: InvoiceDeleteDestination
): Promise<InvoiceDeleteResult[]> {
  const rowIndex = await ctx.sheetsService.loadRowIndex(ctx.sheetName, ctx.mapping);
  const results: InvoiceDeleteResult[] = [];
  for (const invoiceId of invoiceIds) {
    results.push(await deleteOneInvoice(ctx, clientId, invoiceId, destination, rowIndex));
  }
  return results;
}
```

4. `deleteInvoiceById` (borrado individual) usa el mismo camino:

```typescript
export async function deleteInvoiceById(
  clientId: string,
  invoiceId: string,
  destination: InvoiceDeleteDestination
): Promise<InvoiceDeleteResult> {
  const resolved = await resolveDeletionContext(clientId);
  if ("error" in resolved) return { ok: false, status: resolved.status, error: resolved.error };
  const [result] = await deleteInvoicesWithIndex(resolved.ctx, clientId, [invoiceId], destination);
  return result;
}
```

- [ ] **Step 4: Actualizar el endpoint bulk-delete para usar el wrapper**

`src/app/api/client/invoices/bulk-delete/route.ts` — el loop manual se reemplaza:

```typescript
export const POST = withClientAuth(async ({ request, session }) => {
  const { invoiceIds } = bodySchema.parse(await request.json());

  const resolved = await resolveDeletionContext(session.clientId);
  if ("error" in resolved) return apiError(new Error(resolved.error), resolved.status);

  const results = await deleteInvoicesWithIndex(resolved.ctx, session.clientId, invoiceIds, "pending");

  const failed: Array<{ invoiceId: string; error: string }> = [];
  let deleted = 0;
  results.forEach((result, i) => {
    if (result.ok) deleted += 1;
    else failed.push({ invoiceId: invoiceIds[i], error: result.error ?? "Error" });
  });

  return apiOk({ deleted, failed, total: invoiceIds.length });
});
```

- [ ] **Step 5: Verificar quién más llamaba `deleteOneInvoice` / `deleteInvoiceRow`**

Run: `grep -rn "deleteOneInvoice\|deleteInvoiceRow\|deleteInvoiceById" src --include="*.ts" --include="*.tsx"`
Ajustar cualquier call site restante al nuevo contrato (se espera: el route de invoice por consorcio usa `deleteInvoiceById` — ya cubierto; si `deleteInvoiceRow` queda sin usos fuera del servicio, dejarlo como wrapper documentado).

- [ ] **Step 6: Correr tests y verificar que pasan**

Run: `npx vitest run src/lib/invoiceDeletion.test.ts` y `npm run typecheck`
Expected: PASS / 0 errores.

---

### Task 3: Tope 10 en bulk-delete (server + UI)

**Files:**
- Modify: `src/app/api/client/invoices/bulk-delete/route.ts:6`
- Modify: `src/app/admin/boletas/page.tsx` (~línea 145, `handleDeleteSelected`)

- [ ] **Step 1: Bajar el tope del schema**

```typescript
// Tope de 10 por tanda: mismo criterio que bulk-move-period — cada boleta hace
// varias llamadas a Drive (~8.5s medidos en prod) y el túnel Cloudflare corta a
// ~100s (524). La UI también lo valida; esto es el guardrail del server.
const bodySchema = z.object({
  invoiceIds: z.array(z.string().min(1)).min(1).max(10),
});
```

- [ ] **Step 2: Guard en la UI (replica el patrón de `openMoveModal`)**

En `src/app/admin/boletas/page.tsx`: agregar constante junto a `MAX_MOVE_BATCH` (buscar su definición) `const MAX_DELETE_BATCH = 10;` y al inicio de `handleDeleteSelected` (línea ~146, después del `if (selectedCount === 0) return;`):

```typescript
if (selectedCount > MAX_DELETE_BATCH) {
  setError(`No se pueden borrar más de ${MAX_DELETE_BATCH} boletas por tanda. Seleccioná hasta ${MAX_DELETE_BATCH} y hacé el resto en la siguiente tanda.`);
  return;
}
```

- [ ] **Step 3: Checkpoint**

Run: `npm run typecheck` y `npm run lint`
Expected: 0 errores.

---

### Task 4: `sessionRevocation.ts` — cache de validez de sesión (TDD)

**Files:**
- Create: `src/lib/sessionRevocation.ts`
- Test: `src/lib/sessionRevocation.test.ts` (nuevo)

- [ ] **Step 1: Escribir tests que fallan**

```typescript
import { describe, it, expect, vi } from "vitest";
import { createSessionValidityResolver } from "./sessionRevocation";

const activeClient = { isActive: true, role: "CLIENT" as const };

describe("createSessionValidityResolver", () => {
  it("consulta la DB la primera vez y cachea dentro del TTL", async () => {
    const fetchAccount = vi.fn(async () => activeClient);
    let clock = 0;
    const resolve = createSessionValidityResolver({ fetchAccount, ttlMs: 60_000, now: () => clock });

    expect(await resolve("cli-1")).toEqual(activeClient);
    clock = 59_000;
    expect(await resolve("cli-1")).toEqual(activeClient);
    expect(fetchAccount).toHaveBeenCalledTimes(1);
  });

  it("re-consulta cuando el TTL venció", async () => {
    const fetchAccount = vi.fn(async () => activeClient);
    let clock = 0;
    const resolve = createSessionValidityResolver({ fetchAccount, ttlMs: 60_000, now: () => clock });

    await resolve("cli-1");
    clock = 61_000;
    await resolve("cli-1");
    expect(fetchAccount).toHaveBeenCalledTimes(2);
  });

  it("cliente inactivo o inexistente → null (sesión inválida)", async () => {
    const resolveInactive = createSessionValidityResolver({
      fetchAccount: async () => ({ isActive: false, role: "CLIENT" as const }),
      ttlMs: 60_000,
      now: () => 0,
    });
    expect(await resolveInactive("cli-1")).toBeNull();

    const resolveMissing = createSessionValidityResolver({
      fetchAccount: async () => null,
      ttlMs: 60_000,
      now: () => 0,
    });
    expect(await resolveMissing("cli-1")).toBeNull();
  });

  it("si la DB falla usa el cache vencido; sin cache previo → null (fail-closed)", async () => {
    let shouldFail = false;
    let clock = 0;
    const fetchAccount = vi.fn(async () => {
      if (shouldFail) throw new Error("P1001");
      return activeClient;
    });
    const resolve = createSessionValidityResolver({ fetchAccount, ttlMs: 60_000, now: () => clock });

    await resolve("cli-1"); // cachea
    shouldFail = true;
    clock = 120_000; // cache vencido
    expect(await resolve("cli-1")).toEqual(activeClient); // stale pero usable

    expect(await resolve("cli-nunca-visto")).toBeNull(); // sin cache → rechazo
  });

  it("clientes distintos cachean por separado", async () => {
    const fetchAccount = vi.fn(async (id: string) =>
      id === "cli-1" ? activeClient : { isActive: false, role: "CLIENT" as const }
    );
    const resolve = createSessionValidityResolver({ fetchAccount, ttlMs: 60_000, now: () => 0 });
    expect(await resolve("cli-1")).toEqual(activeClient);
    expect(await resolve("cli-2")).toBeNull();
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run src/lib/sessionRevocation.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementar `src/lib/sessionRevocation.ts`**

```typescript
import { ClientRole } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";

/**
 * Re-verificación de sesiones contra la DB con cache en memoria.
 *
 * El JWT dura 24h y no hay revocación server-side: sin este chequeo, un cliente
 * desactivado (o con rol degradado) retiene acceso a la API hasta que expira el
 * token. Acá se consulta `Client.isActive`/`role` como máximo una vez por TTL
 * (60s) por cliente: desactivar hace efecto en ≤60s con costo despreciable.
 *
 * Fallos de DB (blip del pooler): se usa la última entrada de cache aunque esté
 * vencida (no echar sesiones válidas por un blip); si nunca se vio al cliente,
 * se rechaza (fail-closed).
 *
 * NOTA: cache por proceso. Producción corre 1 solo contenedor `web`, así que no
 * hay problema de coherencia. Si algún día se escala horizontal, cada instancia
 * converge sola en ≤TTL — revisar si eso alcanza.
 */

export interface SessionAccount {
  isActive: boolean;
  role: ClientRole;
}

interface CacheEntry {
  account: SessionAccount | null; // null = cliente inexistente
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 60_000;

export function createSessionValidityResolver(opts: {
  fetchAccount: (clientId: string) => Promise<SessionAccount | null>;
  ttlMs?: number;
  now?: () => number;
}): (clientId: string) => Promise<SessionAccount | null> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  return async function resolveSessionValidity(clientId: string): Promise<SessionAccount | null> {
    const cached = cache.get(clientId);
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return cached.account?.isActive ? cached.account : null;
    }

    let account: SessionAccount | null;
    try {
      account = await opts.fetchAccount(clientId);
    } catch {
      // Blip de DB: última verdad conocida (aunque vencida) antes que echar a todos.
      if (cached) return cached.account?.isActive ? cached.account : null;
      return null;
    }

    cache.set(clientId, { account, fetchedAt: now() });
    return account?.isActive ? account : null;
  };
}

async function fetchAccountFromDb(clientId: string): Promise<SessionAccount | null> {
  const prisma = getPrismaClient();
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { isActive: true, role: true },
  });
  return client ?? null;
}

/** Instancia por defecto usada por los guards de auth. */
export const resolveSessionValidity = createSessionValidityResolver({ fetchAccount: fetchAccountFromDb });
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run src/lib/sessionRevocation.test.ts`
Expected: PASS.

---

### Task 5: Guards async + propagación de `await`

**Files:**
- Modify: `src/lib/adminAuth.ts`
- Modify: `src/lib/clientAuth.ts`
- Modify: `src/lib/apiHandler.ts` (`withAuth`/`withClientAuth`)
- Modify: las 39 rutas listadas abajo (agregar `await` al guard)

- [ ] **Step 1: `requireAuthenticatedSession` async con re-chequeo**

En `src/lib/adminAuth.ts`:

```typescript
import { resolveSessionValidity } from "@/lib/sessionRevocation";

export async function requireAuthenticatedSession(
  request: Request
): Promise<{ session: AuthenticatedSession; error: null } | { session: null; error: NextResponse }> {
  // ... secret + token + verifySessionToken idénticos a hoy ...

  // Re-chequeo contra la DB (cache 60s): cliente desactivado o borrado → 401
  // aunque el JWT siga vigente. El rol se toma de la DB (un downgrade aplica
  // en ≤60s, sin esperar a que expire el token).
  const account = await resolveSessionValidity(payload.clientId);
  if (!account) {
    return {
      session: null,
      error: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    };
  }

  return {
    session: {
      clientId: payload.clientId,
      email: payload.email,
      role: account.role,
    },
    error: null,
  };
}
```

`requireAdminSession` pasa a `async` y hace `const auth = await requireAuthenticatedSession(request);` (resto igual).

- [ ] **Step 2: `requireClientSession` async**

En `src/lib/clientAuth.ts`: firma `export async function requireClientSession(...)`, cuerpo con `const auth = await requireAuthenticatedSession(request);` (resto igual).

- [ ] **Step 3: `withAuth`/`withClientAuth` con await**

En `src/lib/apiHandler.ts`, en ambos wrappers: `const auth = await requireClientSession(request);` / `const auth = await requireAuthenticatedSession(request);`.

- [ ] **Step 4: Propagar `await` en las rutas que llaman guards directo**

Correr `npm run typecheck` — cada llamada sin `await` va a fallar con un error de tipos (Promise usada como objeto). Agregar `await` en cada una. Lista esperada (39 archivos, de `grep -rln "require(Client|Admin|Authenticated)Session" src/app/api`):

`admin/audit/clients`, `admin/clients` (+ `[id]`, `[id]/debug-mode`, `[id]/purge`), `admin/invoices`, `admin/scheduler/{run,status,toggle}`, `auth/me`, `client/coeficientes/[id]`, `client/consortiums` (+ `[id]` y sub-rutas: `close-period`, `fixed-expenses` (+`[fxId]`), `invoices` (+`[invoiceId]`, `receipt`, `scan`), `lsp-services` (+`[lspId]`), `periods`), `client/import` (+ `template`), `client/invoices/[id]/payments` (+ `[paymentId]`), `client/obligations/[id]`, `client/periods/[id]/obligations`, `client/periods/close-all` (+ `preview`), `client/providers`, `client/rubros/[id]`, `client/setup-sheet-protection`, `client/sync-directory`, `client/sync-payments`, `client/unassigned/{preview,requeue}`, `process`.

El patrón en cada una: `const auth = requireXSession(request);` → `const auth = await requireXSession(request);`

- [ ] **Step 5: Verificación completa del cambio**

Run: `npm run typecheck` → 0 errores. Luego `npx vitest run` → todos verdes. Luego `npm run build` → OK (atrapa cualquier ruta olvidada).

---

### Task 6: `apiError` sanitizado (TDD)

**Files:**
- Modify: `src/lib/apiHandler.ts:31-41`
- Test: `src/lib/apiHandler.test.ts` (nuevo)

- [ ] **Step 1: Escribir tests que fallan**

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { apiError } from "./apiHandler";

const originalEnv = process.env.NODE_ENV;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("apiError", () => {
  it("ZodError → 400 con los mensajes de validación", async () => {
    const schema = z.object({ name: z.string().min(1, "name requerido") });
    const result = schema.safeParse({});
    const res = apiError(result.error);
    expect(res.status).toBe(400);
  });

  it("error de negocio con status explícito < 500 → mensaje visible", async () => {
    const res = apiError(new Error("Sin credenciales de Google configuradas"), 400);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Sin credenciales de Google configuradas");
  });

  it("500 en producción → mensaje genérico (no filtra detalles internos)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = apiError(new Error("connect ECONNREFUSED prisma://interno"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Error interno");
  });

  it("500 fuera de producción → mensaje real (debugging local)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = apiError(new Error("detalle interno"));
    expect((await res.json()).error).toBe("detalle interno");
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run src/lib/apiHandler.test.ts`
Expected: FAIL en el test de producción (hoy devuelve el mensaje real).

- [ ] **Step 3: Implementar**

Reemplazar `apiError` en `src/lib/apiHandler.ts`:

```typescript
/**
 * Respuesta de error normalizada.
 * - `ZodError` → 400 con los mensajes de validación.
 * - Status explícito < 500 (error de negocio intencional) → mensaje visible.
 * - Status 500 (error inesperado): en producción responde genérico y loguea el
 *   detalle server-side — los mensajes de Prisma/Google traen nombres de tablas,
 *   queries e IDs internos que no deben llegar al cliente.
 */
export function apiError(error: unknown, fallbackStatus = 500): NextResponse {
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { ok: false, error: error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  if (fallbackStatus >= 500) {
    console.error("[apiError] error interno:", error);
    const publicMessage = process.env.NODE_ENV === "production" ? "Error interno" : message;
    return NextResponse.json({ ok: false, error: publicMessage }, { status: fallbackStatus });
  }
  return NextResponse.json({ ok: false, error: message }, { status: fallbackStatus });
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run src/lib/apiHandler.test.ts`
Expected: PASS.

---

### Task 7: JWT constant-time + login sin enumeración

**Files:**
- Modify: `src/lib/authSession.ts:39-49`
- Modify: `src/app/api/auth/login/route.ts:45-47` y `:75-84`
- Test: `src/lib/authSession.test.ts` (verificar si existe; si no, los tests existentes de integración cubren — el cambio es interno)

- [ ] **Step 1: Comparación constant-time en `verifySessionToken`**

En `src/lib/authSession.ts` (import: sumar `timingSafeEqual` al import de `crypto`):

```typescript
const [encodedHeader, encodedPayload, signature] = parts;
const expected = sign(`${encodedHeader}.${encodedPayload}`, secret);
const sigBuf = Buffer.from(signature);
const expectedBuf = Buffer.from(expected);
if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
  return null;
}
```

- [ ] **Step 2: Login — inactivo indistinguible de credenciales inválidas**

En `src/app/api/auth/login/route.ts`, reemplazar el bloque de `isActive` (líneas 45-47):

```typescript
if (!user.isActive) {
  // Misma respuesta que credenciales inválidas: no confirmar que el email existe.
  console.warn(`[login] intento de login de cuenta inactiva: ${user.id}`);
  return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
}
```

- [ ] **Step 3: Login — catch sin fuga de mensajes internos**

Reemplazar el `catch` (líneas 75-84):

```typescript
} catch (error) {
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { ok: false, error: error.issues.map((issue) => issue.message).join(", ") },
      { status: 400 }
    );
  }
  console.error("[login] error interno:", error);
  const message =
    process.env.NODE_ENV === "production"
      ? "Error interno"
      : error instanceof Error
        ? error.message
        : "Unknown error";
  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}
```

- [ ] **Step 4: Checkpoint**

Run: `npx vitest run` y `npm run typecheck`
Expected: verde (si algún test asertaba "User is inactive"/403, actualizarlo a la nueva respuesta).

---

### Task 8: Test de guard de auth en todas las rutas API

**Files:**
- Test: `src/app/api/routeAuthGuard.test.ts` (nuevo)

- [ ] **Step 1: Escribir el test (pasa en verde desde el inicio — es una red de regresión)**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { globSync } from "glob"; // ya es dependencia transitiva de vitest; si no resuelve, usar fast-glob o recorrido manual con readdirSync

/**
 * Red de regresión de seguridad: toda ruta API debe usar un guard de auth.
 * El guard es opt-in por ruta (el middleware solo cubre páginas /admin), así
 * que una ruta nueva sin wrapper queda pública en silencio — este test lo
 * atrapa en CI antes del deploy.
 */

// Rutas públicas INTENCIONALES. Agregar acá exige revisión consciente.
const PUBLIC_ROUTES = new Set([
  "auth/login/route.ts",
  "auth/logout/route.ts",
  "auth/register/route.ts", // deshabilitado: devuelve 403 fijo
  "health/route.ts",        // healthcheck de Docker
  "openapi/route.ts",       // spec estático
]);

const GUARD_TOKENS = [
  "withAuth",
  "withClientAuth",
  "requireClientSession",
  "requireAdminSession",
  "requireAuthenticatedSession",
];

const API_DIR = join(__dirname); // src/app/api

describe("guard de auth en rutas API", () => {
  const routeFiles = globSync("**/route.ts", { cwd: API_DIR });

  it("encuentra rutas (sanity check del glob)", () => {
    expect(routeFiles.length).toBeGreaterThan(30);
  });

  for (const file of routeFiles) {
    const normalized = file.split(sep).join("/");
    if (PUBLIC_ROUTES.has(normalized)) continue;

    it(`${normalized} usa un guard de auth`, () => {
      const content = readFileSync(join(API_DIR, file), "utf8");
      const hasGuard = GUARD_TOKENS.some((token) => content.includes(token));
      expect(
        hasGuard,
        `${normalized} exporta handlers sin guard de auth. Usá withAuth/withClientAuth ` +
        `o require*Session; si la ruta es pública a propósito, agregala a PUBLIC_ROUTES ` +
        `en routeAuthGuard.test.ts con un comentario del motivo.`
      ).toBe(true);
    });
  }
});
```

- [ ] **Step 2: Correr y verificar que pasa (y que atrapa un negativo)**

Run: `npx vitest run src/app/api/routeAuthGuard.test.ts`
Expected: PASS. Verificación del detector: comentar temporalmente el `withClientAuth` de una ruta cualquiera en un sandbox mental NO — en su lugar, agregar `"health/route.ts"` de la allowlist... **Método concreto:** quitar `"openapi/route.ts"` de `PUBLIC_ROUTES`, correr, ver que FALLA por openapi, restaurar. Eso prueba que el test detecta rutas sin guard.

---

### Task 9: DRY del mapping de columnas

**Files:**
- Modify: `src/app/api/client/invoices/[id]/payments/route.ts:15-36`

- [ ] **Step 1: Reemplazar el mapping local por el export compartido**

Borrar la constante local `DEFAULT_MAPPING` (líneas 15-36) y usar:

```typescript
import { DEFAULT_SHEETS_MAPPING } from "@/lib/invoiceDeletion";
```

Renombrar los usos de `DEFAULT_MAPPING` → `DEFAULT_SHEETS_MAPPING` dentro del archivo (buscar con grep en el propio archivo; también en `payments/[paymentId]/route.ts` si repite el patrón).

- [ ] **Step 2: Checkpoint**

Run: `npm run typecheck` y `npx vitest run`
Expected: 0 errores / verde.

---

### Task 10: Pasada de docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `src/services/aiExtraction.ts` (docstring líneas ~8 y ~27)
- Modify: `CHANGELOG.md`, `docs/progreso.md`, `docs/decisiones.md`

- [ ] **Step 1: CLAUDE.md — 6 correcciones**

1. Descripción del proyecto: "usando IA (Gemini → OpenAI fallback)" → "usando IA (cadena Cerebras → Gemini → OpenAI → Claude; Groq soportado pero fuera de la cadena de producción)".
2. Sección "Google Sheets — columnas por defecto": completar A–U (N = ESTADO PAGO, O = BANCO, P = SALDO PENDIENTE, Q = MONTO PAGADO, R = CANT CUOTAS, S = FECHA PAGO, T = URL COMPROBANTE, U = MEDIO PAGO).
3. Schema: agregar al diagrama `Payment` (bajo Invoice, con `paymentType TOTAL/LIBRE/CUOTA`), `FixedExpense` y `ExpenseObligation` (bajo Consortium/Period, con `ObligationStatus PENDING/RECEIVED/NOT_RECEIVED/SKIPPED` — verificar el enum real en `prisma/schema.prisma` línea 53), `ConsortiumProvider`.
4. Sección "Matching de proveedor (3 niveles)" → reescribir: solo CUIT; nombre únicamente para sindicales/ARCA (`allowNameMatch`).
5. Estructura de directorios: agregar `admin/boletas/` y los endpoints `invoices/bulk-delete`, `invoices/bulk-move-period`, `invoices/[id]/payments`, `obligations/`, `consortiums/[id]/fixed-expenses`, `sync-payments`, `setup-sheet-protection`.
6. Pendientes conocidos: quitar "Agregar URL de recibo a columna de Google Sheets" y "Columna paymentMethod en Sheets (Stage 2)" (ya existen, columnas T y U); agregar "Job en background para operaciones batch (bulk-move/bulk-delete) — spec propio pendiente" y "Re-chequeo de sesión: revisar TTL/coherencia si se escala el web a más de 1 instancia".

- [ ] **Step 2: Docstring de `aiExtraction.ts`**

Línea ~27: "Gemini → OpenAI → Claude" → "Cerebras → Groq → Gemini → OpenAI → Claude (ver `createAiExtractionChain`)". Verificar la línea ~8 ("Los tres servicios") → "Todos los servicios".

- [ ] **Step 3: CHANGELOG.md / progreso.md / decisiones.md**

- `CHANGELOG.md`: entrada 2026-07-15 con los ítems de este plan + catch-up de los commits de UI sin documentar (revisar `git log --oneline -15`: AsyncButton, acordeón de configuración, tarjetas, bulk-move — los que falten).
- `docs/progreso.md`: sección nueva "Hardening de seguridad + robustez batch (2026-07-15)" con estado, y actualizar el estado del cambio del working tree en `boletas/page.tsx` (desglose de salteadas por motivo en el modal de bulk-move).
- `docs/decisiones.md`: entrada 2026-07-15 con: (a) revocación por cache 60s (alternativas: query siempre / sessionVersion — descartadas y por qué), (b) tope 10 + índice por lote en bulk-delete (mismo patrón que bulk-move), (c) sanitización de apiError, (d) test de guard como red de regresión.

- [ ] **Step 4: Actualizar memoria**

Si el catch-up de docs de UI quedó completo, actualizar/eliminar la memoria `pending-ui-docs-pass.md` (en `C:\Users\jony\.claude\projects\...\memory\`).

---

### Task 11: Verificación global final

- [ ] **Step 1: Suite completa**

Run: `npx vitest run`
Expected: todos los tests verdes (238 preexistentes + los nuevos).

- [ ] **Step 2: Estática y builds**

Run (por separado, PowerShell sin `&&`):
- `npm run typecheck` → 0 errores
- `npm run lint` → 0 errores
- `npm run build:jobs` → OK
- `npm run build` → OK (obligatorio por el cambio async en las 39 rutas)

- [ ] **Step 3: Resumen para el owner**

Reportar: qué se cambió, que NO hay migración, que el deploy aplica todo solo (commit del owner), y el checklist de cierre de sesión (ritual: tabla de lo hecho + consistencia de docs).
