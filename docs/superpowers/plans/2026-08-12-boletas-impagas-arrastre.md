# Arrastre de boletas impagas al mes siguiente — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: `superpowers:subagent-driven-development` o
> `superpowers:executing-plans`. Los pasos usan checkboxes (`- [ ]`).

> **⚠️ NO COMMITEAR** (lo hace el owner con GitLens) y **⚠️ NO MIGRAR** (Claude crea el `.sql`; el
> owner corre `migrate deploy` + `generate`).

**Goal:** Que una boleta de gasto fijo que llegó y no se pudo pagar se pase al mes siguiente con un
botón, quede registrada como impaga en el mes de origen, y aparezca en la hoja del mes destino como
fila aparte con su mes de origen y —si se carga— el importe del 2° vencimiento.

**Architecture:** Se reusa `moveOneInvoiceToTarget` (Drive → Sheets → DB, con compensación LIFO e
idempotencia) inyectando un `applyDb` propio por su seam `InvoiceMoveContext.applyDb`: en vez de
"vaciar la obligación de origen y re-vincular en destino", hace "marcar la obligación de origen como
`CARRIED_OVER` conservando su `invoiceId` y dejar la boleta suelta en el destino". El camino de
Boletas entrantes no se modifica.

**Tech Stack:** Next.js 16, TypeScript, Prisma 6 + PostgreSQL, Vitest (proyectos `node` y `jsdom`).

**Spec:** `docs/superpowers/specs/2026-08-12-boletas-impagas-arrastre-design.md`

---

## Contexto que el implementador necesita saber

**El caso.** El consorcio no juntó los fondos y la boleta de EDESUR de agosto no se pagó. Se abona en
septiembre junto con la de septiembre. Decisión del owner: **el gasto se registra en el mes en que se
paga**, y el mes de origen tiene que conservar la evidencia de que quedó impaga (transparencia hacia
los inquilinos).

**Tres piezas del código que condicionan todo:**

1. `moveOneInvoiceToTarget` (`src/lib/invoicePeriodMove.ts:235`) ya mueve Drive + Sheets + DB, es
   idempotente y compensa si algo falla. **Se reusa tal cual.**
2. `applyDbMove` (`:207`) vacía la obligación de origen y re-vincula en destino. Para el arrastre eso
   es **exactamente lo contrario** de lo que se necesita, pero hay un seam: `ctx.applyDb` (`:200`).
3. `remainingBalance` se siembra con `invoice.amount` en el primer pago
   (`src/repositories/payment.repository.ts:151`). Si hay `lateAmount`, esa es la base.

**Los prompts extraen sólo el 1er vencimiento** (`extraction.ts:686`, `:740`), a propósito. El importe
del 2° no está en la base y se carga a mano.

**Convenciones:** PowerShell sin `&&`; tests puros `.test.ts` / UI `.test.tsx`; CSS Modules en modo
`pure` (`npm run build` lo detecta); toda acción async con `AsyncButton`; textos en castellano;
`requireClientSession` en endpoints de cliente.

**Baseline:** 565 tests verdes, migración de la Parte 1 aplicada.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `prisma/schema.prisma` **(modificar)** | `CARRIED_OVER` en el enum + `carriedFromPeriodId` y `lateAmount` en `Invoice` |
| `prisma/migrations/20260813000000_carry_over_unpaid_invoices/migration.sql` **(crear)** | El SQL |
| `src/lib/invoiceCarryOver.ts` **(crear)** | `applyCarryOverDbMove` (la transacción propia) + `recalcRemainingForLateAmount` (puro) |
| `src/lib/invoiceCarryOver.test.ts` **(crear)** | Tests de ambas |
| `src/services/carryOver.service.ts` **(crear)** | Orquesta: valida, resuelve destino y llama al move con el `applyDb` inyectado |
| `src/app/api/client/obligations/[id]/carry-over/route.ts` **(crear)** | POST |
| `src/app/api/client/invoices/[id]/late-amount/route.ts` **(crear)** | PATCH |
| `src/repositories/payment.repository.ts` **(modificar)** | Base del saldo = `lateAmount ?? amount` |
| `src/app/api/client/obligations/overview/route.ts` **(modificar)** | Devuelve las arrastradas del período activo |
| `src/app/admin/obligaciones/lib/sheetModel.ts` **(modificar)** | `SheetRow` gana `carriedFrom`/`lateAmount`/`originalAmount`; orden y filtro |
| `src/app/admin/obligaciones/lib/sheetPdf.ts` **(modificar)** | Concepto con el mes de origen y el 1° pago |
| `src/app/admin/obligaciones/hooks/useObligationsOverview.ts` **(modificar)** | `carryOver` y `setLateAmount` |
| `src/app/admin/obligaciones/components/SheetCard.tsx` **(modificar)** | Fila arrastrada + los dos botones |
| `page.module.css` **(modificar)** | Estilo de la fila arrastrada |

---

## Task 1: Migración

**Files:** `prisma/schema.prisma`, `prisma/migrations/20260813000000_carry_over_unpaid_invoices/migration.sql`

- [ ] **Step 1: Schema**

En `enum ObligationStatus` agregar `CARRIED_OVER`. En `model Invoice`:

```prisma
  /// Período del que se arrastró por quedar impaga. Null = nació en su período.
  carriedFromPeriodId String?
  carriedFrom         Period?  @relation("InvoiceCarriedFrom", fields: [carriedFromPeriodId], references: [id], onDelete: SetNull)
  /// Importe del 2° vencimiento (pago fuera de término). Se carga a mano.
  lateAmount          Decimal? @db.Decimal(14, 2)
```

En `model Period`, la contraparte de la relación:

```prisma
  carriedInvoices Invoice[] @relation("InvoiceCarriedFrom")
```

- [ ] **Step 2: `migration.sql`**

```sql
ALTER TYPE "ObligationStatus" ADD VALUE 'CARRIED_OVER';

ALTER TABLE "Invoice" ADD COLUMN "carriedFromPeriodId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "lateAmount" DECIMAL(14,2);

CREATE INDEX "Invoice_carriedFromPeriodId_idx" ON "Invoice"("carriedFromPeriodId");

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_carriedFromPeriodId_fkey"
  FOREIGN KEY ("carriedFromPeriodId") REFERENCES "Period"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 3: Validar**

```bash
npx prisma validate
```

Esperado: schema válido. **El owner corre `migrate deploy` + `generate`.** Hasta que lo haga, el
cliente Prisma no conoce los campos nuevos y el typecheck de las tareas que los usan va a fallar: por
eso la Task 2 en adelante se escriben igual y se verifican al final, o el owner migra ahora.

---

## Task 2: La transacción del arrastre (lógica pura + DB)

**Files:** `src/lib/invoiceCarryOver.ts`, `src/lib/invoiceCarryOver.test.ts`

- [ ] **Step 1: Test que falla**

```ts
import { describe, expect, it } from "vitest";
import { applyCarryOverDbMove, recalcRemainingForLateAmount } from "./invoiceCarryOver";

function fakeTx(invoice: { id: string; carriedFromPeriodId: string | null; periodId: string }) {
  const calls: any[] = [];
  const tx: any = {
    expenseObligation: {
      updateMany: async (args: any) => { calls.push(["obligation", args]); return { count: 1 }; },
    },
    invoice: {
      findUnique: async () => invoice,
      update: async (args: any) => { calls.push(["invoice", args]); return { ...invoice, ...args.data }; },
    },
  };
  return { tx, calls, prisma: { $transaction: async (fn: any) => fn(tx) } as any };
}

describe("applyCarryOverDbMove", () => {
  it("marca la obligación de origen CARRIED_OVER conservando el invoiceId", async () => {
    const f = fakeTx({ id: "inv1", carriedFromPeriodId: null, periodId: "ago" });
    await applyCarryOverDbMove(f.prisma, { id: "inv1", periodId: "ago" }, "sep");

    const [, args] = f.calls.find(([k]) => k === "obligation")!;
    expect(args.where).toMatchObject({ invoiceId: "inv1" });
    expect(args.data).toEqual({ status: "CARRIED_OVER" });
    expect(args.data).not.toHaveProperty("invoiceId"); // NO se desvincula
  });

  it("mueve la boleta y registra el período de origen", async () => {
    const f = fakeTx({ id: "inv1", carriedFromPeriodId: null, periodId: "ago" });
    await applyCarryOverDbMove(f.prisma, { id: "inv1", periodId: "ago" }, "sep");

    const [, args] = f.calls.find(([k]) => k === "invoice")!;
    expect(args.data).toMatchObject({ periodId: "sep", carriedFromPeriodId: "ago" });
  });

  it("en un arrastre encadenado conserva el origen original", async () => {
    const f = fakeTx({ id: "inv1", carriedFromPeriodId: "ago", periodId: "sep" });
    await applyCarryOverDbMove(f.prisma, { id: "inv1", periodId: "sep" }, "oct");

    const [, args] = f.calls.find(([k]) => k === "invoice")!;
    expect(args.data).toMatchObject({ periodId: "oct" });
    expect(args.data).not.toHaveProperty("carriedFromPeriodId");
  });
});

describe("recalcRemainingForLateAmount", () => {
  it("sin pagos previos, el saldo pasa a ser el monto vencido", () => {
    expect(recalcRemainingForLateAmount({ amount: 1000, lateAmount: null, remaining: null, next: 1200 }))
      .toEqual({ remaining: 1200, isPaid: false });
  });

  it("con un pago parcial, sube por la diferencia del recargo", () => {
    // Boleta 1000, pagó 400 → saldo 600. Monto vencido 1200 → saldo 800.
    expect(recalcRemainingForLateAmount({ amount: 1000, lateAmount: null, remaining: 600, next: 1200 }))
      .toEqual({ remaining: 800, isPaid: false });
  });

  it("cambiar un monto vencido ya cargado usa el anterior como base", () => {
    expect(recalcRemainingForLateAmount({ amount: 1000, lateAmount: 1200, remaining: 800, next: 1300 }))
      .toEqual({ remaining: 900, isPaid: false });
  });

  it("nunca deja saldo negativo y marca pagada", () => {
    expect(recalcRemainingForLateAmount({ amount: 1000, lateAmount: 1200, remaining: 100, next: 1000 }))
      .toEqual({ remaining: 0, isPaid: true });
  });
});
```

- [ ] **Step 2: Correr y ver el fallo**

```bash
npx vitest run src/lib/invoiceCarryOver.test.ts
```

- [ ] **Step 3: Implementación**

```ts
import type { PrismaClient } from "@prisma/client";

/**
 * Transacción de DB del ARRASTRE de una boleta impaga.
 *
 * Se inyecta por el seam `InvoiceMoveContext.applyDb`, en lugar del `applyDbMove`
 * genérico. La diferencia es deliberada y es el corazón de la feature:
 *
 * - `applyDbMove` (Boletas entrantes) significa "esta boleta entró en el mes
 *   equivocado": vacía la obligación de origen y re-vincula en destino.
 * - Acá significa "llegó y no se pagó": la obligación de origen **conserva su
 *   `invoiceId`** y pasa a `CARRIED_OVER`, para que el mes de origen siga
 *   mostrando que la boleta existió y quedó impaga. En el destino la boleta
 *   queda suelta: la obligación de ese mes es de su propia boleta.
 */
export async function applyCarryOverDbMove(
  prisma: PrismaClient,
  invoice: { id: string; periodId: string | null },
  newPeriodId: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.expenseObligation.updateMany({
      where: { invoiceId: invoice.id },
      data: { status: "CARRIED_OVER" },
    });

    const current = await tx.invoice.findUnique({
      where: { id: invoice.id },
      select: { carriedFromPeriodId: true, periodId: true },
    });

    // El origen se escribe UNA sola vez: un arrastre encadenado
    // (agosto → septiembre → octubre) sigue diciendo "agosto".
    const data: { periodId: string; carriedFromPeriodId?: string } = { periodId: newPeriodId };
    if (!current?.carriedFromPeriodId && current?.periodId) {
      data.carriedFromPeriodId = current.periodId;
    }

    await tx.invoice.update({ where: { id: invoice.id }, data });
  });
}

/**
 * Recalcula el saldo al cargar (o cambiar) el importe del 2° vencimiento.
 * Puro: la base anterior es el `lateAmount` previo si existía, o el `amount`.
 */
export function recalcRemainingForLateAmount(input: {
  amount: number;
  lateAmount: number | null;
  remaining: number | null;
  next: number;
}): { remaining: number; isPaid: boolean } {
  const base = input.lateAmount ?? input.amount;
  const current = input.remaining ?? base;
  const remaining = Math.max(0, Number((current + (input.next - base)).toFixed(2)));
  return { remaining, isPaid: remaining === 0 };
}
```

- [ ] **Step 4: Correr hasta verde**

```bash
npx vitest run src/lib/invoiceCarryOver.test.ts
```

Esperado: 7 tests.

---

> **⚠️ CORRECCIÓN DEL 2026-08-12 (revisión antes de codear las tareas 3-8).** Dos bloqueantes
> encontrados leyendo el código, que cambian las tareas 3, 5, 6 y 7:
>
> 1. **El botón no puede vivir en la fila de la obligación.** `classifyTarget` exige destino `ACTIVE`
>    y del mes siguiente; como hay un solo período abierto por consorcio, la obligación impaga queda
>    en un período **cerrado**, que el `overview` no consulta. La feature se dispara desde un **bloque
>    "Impagas de meses anteriores"** alimentado por boletas con saldo de períodos no activos.
> 2. **El vínculo retroactivo choca con el unique `ExpenseObligation.invoiceId`.** Hay que filtrar
>    `carriedFromPeriodId: null` en `generateObligationsForPeriod` y en `syncObligationsForClient`, o
>    la sincronización revienta con P2002 al encontrar la boleta arrastrada en el período destino.
>
> Además: `ObligationStatus` nuevo → sumar `CARRIED_OVER` a la unión manual de
> `consortiums/lib/types.ts:72` y su badge en `consortiums/page.tsx:865`.
>
> Las tareas 1 y 2 (migración y transacción) **no cambian** y ya están hechas.

## Task 2b: Blindar el vínculo retroactivo (bloqueante 2)

**Files:** `src/services/obligation.service.ts` + su test

- [ ] **Step 1: Test que falla**

En `obligation.service.test.ts`, en el fake de `syncObligationsForClient`, agregar una boleta
arrastrada y verificar que **no** se vincula:

```ts
  it("no vincula una boleta arrastrada de otro período", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "sep", consortiumId: "c1" }],
      fixedExpenses: [{ id: "fx1", consortiumId: "c1", providerId: "p1", lspServiceId: null }],
      existing: [],
      // La boleta que vive en septiembre vino arrastrada de agosto: la
      // obligación de agosto la conserva y `invoiceId` es unique.
      invoices: [{ id: "inv-ago", periodId: "sep", providerId: "p1", lspServiceId: null, carriedFromPeriodId: "ago" }],
      fresh: [{ id: "ob-sep", periodId: "sep", fixedExpenseId: "fx1" }],
    });

    const res = await syncObligationsForClient("cl1", fake.client);

    expect(res.linked).toBe(0);
    expect(fake.updated).toHaveLength(0);
  });
```

El fake tiene que respetar el `where` del `findMany` de boletas: si trae
`carriedFromPeriodId: null`, devolver sólo las que lo tengan en null.

- [ ] **Step 2: Implementación**

En las dos queries de boletas (`obligation.service.ts:32` y `:218`) agregar al `where`:

```ts
      // Una boleta arrastrada de un período anterior NO ocupa la obligación del
      // período destino: esa es de la boleta del mes. Además su obligación de
      // origen la conserva, y `ExpenseObligation.invoiceId` es unique.
      carriedFromPeriodId: null,
```

- [ ] **Step 3: Verde**

```bash
npx vitest run src/services/obligation.service.test.ts
```

---

## Task 3: Servicio y endpoint de arrastre

**Files:** `src/services/carryOver.service.ts`, `src/app/api/client/invoices/[id]/carry-over/route.ts`

**Corregido:** la ruta recibe el **`invoiceId`**, no el id de la obligación. La acción se dispara
desde una boleta impaga de un período anterior, que en la vista no tiene obligación visible (su
período está cerrado). El servicio pasa a llamarse `carryOverInvoice(clientId, invoiceId)`, valida
que la boleta tenga saldo y que su período sea el anterior al activo, y busca la obligación **por
`invoiceId`** para marcarla `CARRIED_OVER` (si no hay ninguna, el arrastre igual procede: puede ser
una boleta que no era gasto fijo).

- [ ] **Step 1: El servicio**

```ts
import { getPrismaClient } from "@/lib/prisma";
import { classifyTarget, loadInvoice, moveOneInvoiceToTarget, resolveMoveContext } from "@/lib/invoicePeriodMove";
import { applyCarryOverDbMove } from "@/lib/invoiceCarryOver";

export type CarryOverResult =
  | { ok: true; toLabel: string; invoiceId: string }
  | { ok: false; error: string; status: number };

/**
 * Pasa al período siguiente una boleta de gasto fijo que quedó impaga.
 *
 * Reusa `moveOneInvoiceToTarget` (Drive → Sheets → DB, idempotente y con
 * compensación) inyectando `applyCarryOverDbMove` por el seam `ctx.applyDb`.
 */
export async function carryOverObligation(
  clientId: string,
  obligationId: string
): Promise<CarryOverResult> {
  const prisma = getPrismaClient();

  const obligation = await prisma.expenseObligation.findFirst({
    where: { id: obligationId, clientId },
    include: {
      invoice: { select: { id: true, isPaid: true, remainingBalance: true, amount: true } },
      period: { select: { id: true, year: true, month: true, consortiumId: true } },
    },
  });
  if (!obligation) return { ok: false, error: "Obligación no encontrada", status: 404 };
  if (obligation.status !== "RECEIVED" || !obligation.invoice) {
    return { ok: false, error: "La obligación no tiene una boleta recibida para pasar.", status: 409 };
  }
  if (obligation.invoice.isPaid) {
    return { ok: false, error: "La boleta ya está paga.", status: 409 };
  }

  const invoice = await loadInvoice(prisma, clientId, obligation.invoice.id);
  if (!invoice) return { ok: false, error: "Boleta no encontrada", status: 404 };

  const target = await classifyTarget(prisma, invoice);
  if ("skip" in target) {
    const motivo =
      target.skip === "destino_inexistente"
        ? "El período siguiente todavía no existe: cerrá el período primero."
        : target.skip === "destino_cerrado"
        ? "El período siguiente está cerrado."
        : "No se puede determinar el período destino.";
    return { ok: false, error: motivo, status: 409 };
  }

  const resolved = await resolveMoveContext(clientId);
  if ("error" in resolved) return { ok: false, error: resolved.error, status: resolved.status };

  const ctx = {
    ...resolved.ctx,
    applyDb: (inv: { id: string; periodId: string | null }, pid: string) =>
      applyCarryOverDbMove(prisma, inv, pid),
  };

  const result = await moveOneInvoiceToTarget(ctx, clientId, invoice.id, target.periodId);
  if (!result.ok) {
    return { ok: false, error: result.error ?? "No se pudo pasar la boleta", status: 502 };
  }

  return { ok: true, toLabel: target.toLabel, invoiceId: invoice.id };
}
```

> Si `classifyTarget` tiene otra firma, adaptarla: lo que importa es obtener el `periodId` destino y
> su etiqueta. Verificar con `grep -n "export async function classifyTarget" -A 10 src/lib/invoicePeriodMove.ts`.

- [ ] **Step 2: El endpoint**

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { carryOverObligation } from "@/services/carryOver.service";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;

  const result = await carryOverObligation(auth.session.clientId, id);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, toLabel: result.toLabel, invoiceId: result.invoiceId });
}
```

- [ ] **Step 3: Verificar**

```bash
npx vitest run src/app/api/routeAuthGuard.test.ts
```

```bash
npm run typecheck
```

---

## Task 4: Endpoint del monto vencido + base del saldo

**Files:** `src/app/api/client/invoices/[id]/late-amount/route.ts`, `src/repositories/payment.repository.ts`

- [ ] **Step 1: El endpoint**

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { recalcRemainingForLateAmount } from "@/lib/invoiceCarryOver";

const schema = z.object({ lateAmount: z.number().positive() });

/**
 * Carga el importe del 2° vencimiento de una boleta ARRASTRADA y recalcula su
 * saldo. Sólo aplica a boletas con `carriedFromPeriodId`: en una boleta del mes
 * el importe correcto es el que extrajo el pipeline.
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
  }

  const prisma = getPrismaClient();
  const invoice = await prisma.invoice.findFirst({
    where: { id, clientId: auth.session.clientId },
    select: { id: true, amount: true, lateAmount: true, remainingBalance: true, carriedFromPeriodId: true },
  });
  if (!invoice) return NextResponse.json({ ok: false, error: "Boleta no encontrada" }, { status: 404 });
  if (!invoice.carriedFromPeriodId) {
    return NextResponse.json(
      { ok: false, error: "El monto vencido sólo se carga en una boleta arrastrada de otro período." },
      { status: 409 }
    );
  }

  const { remaining, isPaid } = recalcRemainingForLateAmount({
    amount: Number(invoice.amount ?? 0),
    lateAmount: invoice.lateAmount != null ? Number(invoice.lateAmount) : null,
    remaining: invoice.remainingBalance != null ? Number(invoice.remainingBalance) : null,
    next: parsed.data.lateAmount,
  });

  const updated = await prisma.invoice.update({
    where: { id },
    data: { lateAmount: parsed.data.lateAmount, remainingBalance: remaining, isPaid },
    select: { id: true, lateAmount: true, remainingBalance: true, isPaid: true },
  });

  return NextResponse.json({ ok: true, invoice: updated });
}
```

- [ ] **Step 2: La base del saldo en pagos**

En `payment.repository.ts`, donde se calcula `invoiceAmount` a partir de la boleta, usar el monto
vencido si está cargado. Buscar con:

```bash
grep -n "invoiceAmount" src/repositories/payment.repository.ts
```

y reemplazar la derivación por `invoice.lateAmount ?? invoice.amount` (sumando `lateAmount` al
`select` de la boleta si hace falta), con este comentario:

```ts
// Si la boleta se arrastró y se cargó el importe del 2° vencimiento, ESE es el
// monto real a pagar: el saldo y el "pagada" se calculan sobre él.
```

- [ ] **Step 3: Verificar**

```bash
npx vitest run src/repositories
```

```bash
npm run typecheck
```

---

## Task 5: El `overview` devuelve las impagas de meses anteriores

**Files:** `src/app/api/client/obligations/overview/route.ts`

**Corregido:** no alcanza con las ya arrastradas. Hay que traer **toda boleta con saldo pendiente que
no sea del período activo de su consorcio**, más las que ya se pasaron (viven en el activo pero
tienen `carriedFromPeriodId`). Sin eso, la impaga de agosto no se ve en ningún lado y la acción no
tiene desde dónde dispararse.

- [ ] **Step 1: Query nueva**

Después de `obligations`:

```ts
  // Impagas de meses anteriores: lo que el administrador todavía debe y que no
  // sale de las obligaciones del mes. Dos casos en una sola consulta:
  //  - boletas de un período anterior con saldo (todavía sin pasar);
  //  - boletas ya pasadas a este período (`carriedFromPeriodId`), que siguen impagas.
  const consortiumIds = consortiums.map((c) => c.id);
  const unpaid = consortiumIds.length
    ? await prisma.invoice.findMany({
        where: {
          clientId,
          consortiumId: { in: consortiumIds },
          isPaid: false,
          periodId: { not: null },
          OR: [
            { periodId: { notIn: activePeriodIds } },
            { carriedFromPeriodId: { not: null } },
          ],
        },
        select: {
          id: true,
          consortiumId: true,
          periodId: true,
          provider: true,
          amount: true,
          lateAmount: true,
          remainingBalance: true,
          carriedFromPeriodId: true,
          providerRef: { select: { canonicalName: true, paymentAlias: true } },
          lspService: { select: { clientNumber: true } },
          periodRef: { select: { year: true, month: true } },
          carriedFrom: { select: { year: true, month: true } },
        },
      })
    : [];
```

> Verificar los nombres de relación de `Invoice` (`providerRef`, `lspService`, `periodRef`) con
> `grep -n "model Invoice" -A 45 prisma/schema.prisma`.

- [ ] **Step 2: Devolverlas por consorcio**

En el `map` de consorcios, la clave `carried`:

```ts
        carried: unpaid
          .filter((inv) => inv.consortiumId === c.id)
          .map((inv) => {
            // El origen que se muestra: si ya se pasó, el período del que vino;
            // si todavía no, el período en el que está.
            const origin = inv.carriedFrom ?? inv.periodRef;
            return {
              invoiceId: inv.id,
              concepto: inv.providerRef?.canonicalName ?? inv.provider ?? "—",
              facturas: inv.lspService?.clientNumber ?? null,
              aliasCbu: inv.providerRef?.paymentAlias ?? null,
              originalAmount: inv.amount != null ? Number(inv.amount) : null,
              lateAmount: inv.lateAmount != null ? Number(inv.lateAmount) : null,
              remaining: inv.remainingBalance != null ? Number(inv.remainingBalance) : Number(inv.amount ?? 0),
              fromLabel: origin ? periodLabel(origin.year, origin.month) : null,
              // Ya vive en el período activo → se pasó.
              alreadyCarried: inv.periodId === period?.id,
              // Sólo se puede pasar si su período es el inmediatamente anterior
              // al activo: es lo que valida `classifyTarget`.
              canCarry:
                period != null &&
                inv.periodRef != null &&
                inv.periodId !== period.id &&
                isPreviousMonth(inv.periodRef, { year: period.year, month: period.month }),
            };
          }),
```

Con un helper local:

```ts
/** ¿`a` es el mes inmediatamente anterior a `b`? (envuelve diciembre → enero) */
function isPreviousMonth(a: { year: number; month: number }, b: { year: number; month: number }): boolean {
  const next = a.month === 12 ? { year: a.year + 1, month: 1 } : { year: a.year, month: a.month + 1 };
  return next.year === b.year && next.month === b.month;
}
```

El `select` de consorcios necesita `year`/`month` del período activo (ya los trae) y el `id` del
consorcio en `unpaid` (agregado arriba).

- [ ] **Step 3: Verificar**

```bash
npm run typecheck
```

---

## Task 6: El bloque de impagas en el modelo de la hoja

**Files:** `src/app/admin/obligaciones/lib/sheetModel.ts` + su test

**Corregido:** las impagas **no** son filas de `rows`. Van en `SheetData.carried`, un bloque aparte:
la tabla de arriba tiene que seguir significando "los gastos fijos de este edificio".

- [ ] **Step 1: Tests que fallan**

```ts
describe("impagas de meses anteriores", () => {
  const conImpaga: OverviewPayload = {
    ...payload,
    consortiums: [
      {
        ...payload.consortiums[0],
        carried: [
          {
            invoiceId: "inv-ago",
            concepto: "EDESUR S.A.",
            facturas: "4804882",
            aliasCbu: "edesur.pago",
            originalAmount: 980000,
            lateAmount: null,
            remaining: 980000,
            fromLabel: "agosto 2026",
            alreadyCarried: false,
            canCarry: true,
          },
        ],
      },
      payload.consortiums[1],
    ],
  };

  it("van en su propio bloque, no entre los gastos fijos", () => {
    const sheet = buildSheets(conImpaga)[0];
    expect(sheet.rows.some((r) => r.concepto === "EDESUR S.A." && r.monto === 980000)).toBe(false);
    expect(sheet.carried).toHaveLength(1);
    expect(sheet.carried[0].fromLabel).toBe("agosto 2026");
  });

  it("el monto es el saldo pendiente, no el total de la boleta", () => {
    expect(buildSheets(conImpaga)[0].carried[0].monto).toBe(980000);
  });

  it("con monto vencido cargado, ese es el monto a pagar y conserva el 1° pago", () => {
    const conVencido = {
      ...conImpaga,
      consortiums: [
        { ...conImpaga.consortiums[0], carried: [{ ...conImpaga.consortiums[0].carried![0], lateAmount: 1050000, remaining: 1050000 }] },
        conImpaga.consortiums[1],
      ],
    };
    const fila = buildSheets(conVencido)[0].carried[0];
    expect(fila.monto).toBe(1050000);
    expect(fila.originalAmount).toBe(980000);
  });

  it("se ordenan por período de origen, lo más viejo primero", () => {
    const dos = {
      ...conImpaga,
      consortiums: [
        {
          ...conImpaga.consortiums[0],
          carried: [
            { ...conImpaga.consortiums[0].carried![0], invoiceId: "sep", fromLabel: "septiembre 2026", periodSort: 202609 },
            { ...conImpaga.consortiums[0].carried![0], invoiceId: "jul", fromLabel: "julio 2026", periodSort: 202607 },
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
    const soloImpagas = {
      ...conImpaga,
      consortiums: [{ ...conImpaga.consortiums[0], fixedExpenses: [] }, conImpaga.consortiums[1]],
    };
    const out = toPrintableSheets(buildSheets(soloImpagas));
    expect(out).toHaveLength(1);
    expect(out[0].carried).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implementación**

- `OverviewConsortium` gana `carried?: OverviewCarried[]` (el tipo de la Task 5, más `periodSort`
  para ordenar: `year * 100 + month` del período de origen, calculado en el endpoint).
- `SheetData` gana `carried: CarriedRow[]`, con:

```ts
export type CarriedRow = {
  invoiceId: string;
  facturas: string | null;
  concepto: string;
  /** Lo que hay que pagar: el saldo, sobre el monto vencido si se cargó. */
  monto: number;
  /** El importe del 1° pago, para mostrarlo al lado cuando hay monto vencido. */
  originalAmount: number | null;
  lateAmount: number | null;
  aliasCbu: string | null;
  /** "agosto 2026" */
  fromLabel: string | null;
  alreadyCarried: boolean;
  canCarry: boolean;
};
```

- `buildSheets` mapea `consortium.carried ?? []` ordenado por `periodSort` ascendente.
- **`toPrintableSheets` cambia:** una hoja se imprime si tiene filas imprimibles **o** impagas. Un
  edificio sin gastos del mes pero con una deuda vieja tiene que salir en el papel.
- `SheetRow` **no** se toca: las impagas no son filas de la tabla de gastos fijos.

- [ ] **Step 3: Verde**

```bash
npx vitest run src/app/admin/obligaciones/lib
```

---

## Task 7: PDF y UI

**Files:** `lib/sheetPdf.ts`, `components/SheetCard.tsx`, `hooks/useObligationsOverview.ts`, `page.module.css` + tests

- [ ] **Step 1: PDF — el bloque de impagas**

`toPdfTables` devuelve, por edificio, la tabla de gastos fijos y —si hay impagas— **una segunda
tabla** con el título `IMPAGAS DE MESES ANTERIORES` y las mismas seis columnas. El tipo `PdfTable`
gana `carried?: { head; body }` o se devuelve un array de tablas por hoja; lo que no cambia es que
ambas salen en la misma página, la segunda debajo de la primera (`startY: doc.lastAutoTable.finalY + 8`).

El concepto de una impaga:

```ts
      `${row.concepto} — de ${row.fromLabel}` +
        (row.lateAmount != null && row.originalAmount != null
          ? ` (1° pago ${money.format(row.originalAmount)})`
          : "")
```

La celda MONTO sigue con **un solo número**: el que hay que pagar.

Tests: una hoja con impagas produce dos tablas; el concepto lleva el mes de origen; con `lateAmount`
aparece el 1° pago en el concepto y el vencido en MONTO.

- [ ] **Step 2: Hook — dos acciones nuevas**

```ts
  const carryOverInvoice = useCallback(async (invoiceId: string) => { /* POST …/invoices/{id}/carry-over */ }, [...]);
  const setLateAmount = useCallback(async (invoiceId: string, lateAmount: number) => { /* PATCH …/invoices/{id}/late-amount */ }, [...]);
```

Mismo patrón que las mutaciones existentes: `guardedFetch`, `setError` con el mensaje del servidor,
`await loadOverview()` al final.

> **Nota:** el endpoint de arrastre pasa a recibir el **`invoiceId`**, no el id de la obligación: la
> acción se dispara desde una boleta impaga, que puede no tener obligación visible. Ajustar la Task 3
> en consecuencia (la ruta queda `POST /api/client/invoices/[id]/carry-over` y el servicio busca la
> obligación por `invoiceId` para marcarla `CARRIED_OVER`).

- [ ] **Step 3: `SheetCard` — el bloque**

Debajo de la tabla de gastos fijos, cuando `sheet.carried.length > 0`:

- Título `IMPAGAS DE MESES ANTERIORES` (clase `styles.carriedTitle`).
- Una tabla con las mismas columnas; cada fila muestra el concepto con su badge *"de agosto"* y,
  cuando hay `lateAmount`, la línea chica `1° pago … · 2° pago …`.
- **"Pasar a este período"** (`AsyncButton`) si `canCarry`; si no, botón deshabilitado con el motivo
  en el `title`. Si `alreadyCarried`, en su lugar el badge *"pasada a este período"*.
- **"Cargar monto vencido"** (`AsyncButton` + input) sólo si `alreadyCarried`.

Tests: el bloque no se renderiza sin impagas; el botón de pase aparece sólo con `canCarry`; una ya
pasada muestra el badge y ofrece cargar el monto vencido.

- [ ] **Step 4: Verde**

```bash
npx vitest run src/app/admin/obligaciones
```

```bash
npm run build
```

---

## Task 8: Verificación final y documentación

- [ ] **Step 1: Los cinco comandos**

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

- [ ] **Step 2: Docs**

`docs/decisiones.md` (por qué la obligación de origen conserva el `invoiceId`; por qué `lateAmount` va
aparte de `amount`; por qué se reusa el seam `applyDb` en vez de tocar `applyDbMove`),
`docs/progreso.md` (estado + migración pendiente + smoke del owner) y `CHANGELOG.md`.

- [ ] **Step 3: Avisar** "listo para commitear" + la migración pendiente. **No commitear.**

---

## Notas de riesgo

1. **El typecheck falla hasta que el owner migre**: los campos nuevos no existen en el cliente Prisma
   generado. Es esperado; correr la verificación completa después de `migrate deploy` + `generate`.
2. **`ALTER TYPE … ADD VALUE` no corre dentro de una transacción** en Postgres viejo; Prisma lo maneja,
   pero si la migración falla por eso, separarla en su propio archivo.
3. **No tocar `applyDbMove` ni el camino de Boletas entrantes.** El arrastre usa el seam.
4. **Verificar antes de afirmar.**
