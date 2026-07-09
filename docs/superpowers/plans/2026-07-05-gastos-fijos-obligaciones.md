# Gastos fijos + obligaciones de pago — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cada consorcio defina sus gastos fijos mensuales y que, por período, aparezcan como obligaciones de pago que se cumplen solas cuando llega la boleta, con aviso de faltantes al cerrar.

**Architecture:** Dos modelos nuevos — `FixedExpense` (definición recurrente por consorcio, apunta a un `Provider` o `LspService`) y `ExpenseObligation` (instancia por período, con estado). Las obligaciones se generan al abrir el período, se vinculan a la boleta en el pipeline (solo DB, sin Sheets), y al cerrar el período las pendientes pasan a `NOT_RECEIVED` con reporte. UI: gestión de gastos fijos en el detalle del consorcio + pestaña "Obligaciones" en la vista del período.

**Tech Stack:** Next.js + TypeScript + Prisma + PostgreSQL (Supabase); Vitest para tests; patrón repositorio/servicio existente.

**Spec:** `docs/superpowers/specs/2026-07-05-gastos-fijos-obligaciones-design.md`

**Reglas del proyecto que aplican a TODAS las tareas:**
- **Commits:** los hace el owner. Donde el patrón TDD pide "commit", este plan pone un **Checkpoint** (verificación). El owner agrupa y commitea.
- **Migraciones / `prisma generate`:** los corre el owner. Claude crea el `.sql`; el owner aplica `migrate deploy` → `generate`.
- **Verificación estándar de una tarea:** `npx vitest run <archivo>` (si hay test), `npm run typecheck`, `npm run lint`, y `npm run build:jobs` si se tocó algo importado por los jobs.
- **PowerShell:** comandos por separado (sin `&&`).

---

## Estructura de archivos

**Nuevos:**
- `prisma/migrations/20260705000200_add_fixed_expenses/migration.sql` — enum + 2 tablas + índices.
- `src/lib/fixedExpense.ts` — helpers puros (validación de objetivo, matcher obligación↔boleta, resumen de faltantes).
- `src/lib/fixedExpense.test.ts` — tests de los helpers puros.
- `src/repositories/fixedExpense.repository.ts` — CRUD de `FixedExpense`.
- `src/services/obligation.service.ts` — generación, vinculación y cierre de obligaciones.
- `src/services/obligation.service.test.ts` — tests de generación/vinculación con prisma inyectado.
- `src/app/api/client/consortiums/[id]/fixed-expenses/route.ts` — GET (listar) + POST (crear).
- `src/app/api/client/consortiums/[id]/fixed-expenses/[fxId]/route.ts` — PATCH + DELETE.
- `src/app/api/client/periods/[id]/obligations/route.ts` — GET (listar) + POST (generar).
- `src/app/api/client/obligations/[id]/route.ts` — PATCH (estado, ej. omitir).

**Modificados:**
- `prisma/schema.prisma` — modelos + relaciones + enum.
- `src/jobs/processPendingDocuments.job.ts` — paso de vinculación tras persistir la Invoice.
- `src/jobs/pipeline/context.ts` — dep opcional para el link de obligación (seam para tests).
- `src/lib/invoiceDeletion.ts` — al borrar/reprocesar una boleta, la obligación vuelve a `PENDING`.
- `src/app/api/client/periods/close-all/route.ts` (o el/los archivos preview+execute) — marcar `NOT_RECEIVED` + resumen.
- `src/repositories/consortium.repository.ts` — al crear un período (`createManual`), generar obligaciones.
- `src/app/admin/consortiums/page.tsx` — sección "Gastos fijos" en el consorcio + pestaña "Obligaciones".
- `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`.

---

## Task 1: Schema Prisma + migración (BLOQUEANTE)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260705000200_add_fixed_expenses/migration.sql`

- [ ] **Step 1: Agregar el enum y los dos modelos al schema**

En `prisma/schema.prisma`, después del enum `PaymentType`, agregar:

```prisma
enum ObligationStatus {
  PENDING
  RECEIVED
  SKIPPED
  NOT_RECEIVED
}
```

Y al final del archivo, los dos modelos:

```prisma
model FixedExpense {
  id           String              @id @default(cuid())
  clientId     String
  consortiumId String
  providerId   String?
  lspServiceId String?
  description  String?
  active       Boolean             @default(true)
  createdAt    DateTime            @default(now())
  updatedAt    DateTime            @updatedAt
  client       Client              @relation(fields: [clientId], references: [id], onDelete: Cascade)
  consortium   Consortium          @relation(fields: [consortiumId], references: [id], onDelete: Cascade)
  provider     Provider?           @relation(fields: [providerId], references: [id], onDelete: Cascade)
  lspService   LspService?         @relation(fields: [lspServiceId], references: [id], onDelete: Cascade)
  obligations  ExpenseObligation[]

  @@index([clientId])
  @@index([consortiumId])
}

model ExpenseObligation {
  id             String           @id @default(cuid())
  clientId       String
  consortiumId   String
  periodId       String
  fixedExpenseId String
  status         ObligationStatus @default(PENDING)
  invoiceId      String?          @unique
  createdAt      DateTime         @default(now())
  updatedAt      DateTime         @updatedAt
  client         Client           @relation(fields: [clientId], references: [id], onDelete: Cascade)
  consortium     Consortium       @relation(fields: [consortiumId], references: [id], onDelete: Cascade)
  period         Period           @relation(fields: [periodId], references: [id], onDelete: Cascade)
  fixedExpense   FixedExpense     @relation(fields: [fixedExpenseId], references: [id], onDelete: Cascade)
  invoice        Invoice?         @relation(fields: [invoiceId], references: [id], onDelete: SetNull)

  @@unique([periodId, fixedExpenseId])
  @@index([clientId])
  @@index([periodId, status])
}
```

- [ ] **Step 2: Agregar las back-relations en los modelos existentes**

Agregar estos campos de relación (sin cambiar los existentes):
- En `model Client { ... }`: `fixedExpenses FixedExpense[]` y `obligations ExpenseObligation[]`.
- En `model Consortium { ... }`: `fixedExpenses FixedExpense[]` y `obligations ExpenseObligation[]`.
- En `model Provider { ... }`: `fixedExpenses FixedExpense[]`.
- En `model LspService { ... }`: `fixedExpenses FixedExpense[]`.
- En `model Period { ... }`: `obligations ExpenseObligation[]`.
- En `model Invoice { ... }`: `obligation ExpenseObligation?`.

- [ ] **Step 3: Crear el archivo de migración**

`prisma/migrations/20260705000200_add_fixed_expenses/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('PENDING', 'RECEIVED', 'SKIPPED', 'NOT_RECEIVED');

-- CreateTable
CREATE TABLE "FixedExpense" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "consortiumId" TEXT NOT NULL,
    "providerId" TEXT,
    "lspServiceId" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FixedExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseObligation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "consortiumId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "fixedExpenseId" TEXT NOT NULL,
    "status" "ObligationStatus" NOT NULL DEFAULT 'PENDING',
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExpenseObligation_pkey" PRIMARY KEY ("id")
);

-- Indexes FixedExpense
CREATE INDEX "FixedExpense_clientId_idx" ON "FixedExpense"("clientId");
CREATE INDEX "FixedExpense_consortiumId_idx" ON "FixedExpense"("consortiumId");

-- Indexes ExpenseObligation
CREATE UNIQUE INDEX "ExpenseObligation_invoiceId_key" ON "ExpenseObligation"("invoiceId");
CREATE UNIQUE INDEX "ExpenseObligation_periodId_fixedExpenseId_key" ON "ExpenseObligation"("periodId", "fixedExpenseId");
CREATE INDEX "ExpenseObligation_clientId_idx" ON "ExpenseObligation"("clientId");
CREATE INDEX "ExpenseObligation_periodId_status_idx" ON "ExpenseObligation"("periodId", "status");

-- FKs FixedExpense
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_consortiumId_fkey" FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_lspServiceId_fkey" FOREIGN KEY ("lspServiceId") REFERENCES "LspService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FKs ExpenseObligation
ALTER TABLE "ExpenseObligation" ADD CONSTRAINT "ExpenseObligation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpenseObligation" ADD CONSTRAINT "ExpenseObligation_consortiumId_fkey" FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpenseObligation" ADD CONSTRAINT "ExpenseObligation_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "Period"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpenseObligation" ADD CONSTRAINT "ExpenseObligation_fixedExpenseId_fkey" FOREIGN KEY ("fixedExpenseId") REFERENCES "FixedExpense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpenseObligation" ADD CONSTRAINT "ExpenseObligation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 4 (OWNER): aplicar la migración y regenerar el cliente**

> ⛔ **Handoff al owner.** Con el `npm run dev` de este proyecto parado:
> ```
> npx prisma migrate deploy
> npx prisma generate
> ```
> Nada del resto del plan tipa hasta que esto corra (el cliente Prisma necesita conocer los modelos nuevos).

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck`
Expected: PASS (el schema compila y el cliente tiene `FixedExpense`, `ExpenseObligation`, `ObligationStatus`).

---

## Task 2: Helpers puros de gasto fijo (TDD)

**Files:**
- Create: `src/lib/fixedExpense.ts`
- Test: `src/lib/fixedExpense.test.ts`

- [ ] **Step 1: Escribir el test que falla**

`src/lib/fixedExpense.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  validateFixedExpenseTarget,
  obligationMatchesInvoice,
} from "./fixedExpense";

describe("validateFixedExpenseTarget", () => {
  it("acepta exactamente un objetivo (provider)", () => {
    expect(validateFixedExpenseTarget({ providerId: "p1", lspServiceId: null })).toBeNull();
  });
  it("acepta exactamente un objetivo (lspService)", () => {
    expect(validateFixedExpenseTarget({ providerId: null, lspServiceId: "l1" })).toBeNull();
  });
  it("rechaza ninguno", () => {
    expect(validateFixedExpenseTarget({ providerId: null, lspServiceId: null })).toMatch(/proveedor o un servicio/i);
  });
  it("rechaza ambos", () => {
    expect(validateFixedExpenseTarget({ providerId: "p1", lspServiceId: "l1" })).toMatch(/uno solo/i);
  });
});

describe("obligationMatchesInvoice", () => {
  it("gasto LSP matchea por lspServiceId", () => {
    expect(
      obligationMatchesInvoice(
        { providerId: null, lspServiceId: "l1" },
        { providerId: "pX", lspServiceId: "l1" }
      )
    ).toBe(true);
  });
  it("gasto LSP NO matchea si difiere el lspServiceId", () => {
    expect(
      obligationMatchesInvoice(
        { providerId: null, lspServiceId: "l1" },
        { providerId: "pX", lspServiceId: "l2" }
      )
    ).toBe(false);
  });
  it("gasto por proveedor matchea por providerId", () => {
    expect(
      obligationMatchesInvoice(
        { providerId: "p1", lspServiceId: null },
        { providerId: "p1", lspServiceId: null }
      )
    ).toBe(true);
  });
  it("gasto por proveedor NO matchea si difiere el providerId", () => {
    expect(
      obligationMatchesInvoice(
        { providerId: "p1", lspServiceId: null },
        { providerId: "p2", lspServiceId: null }
      )
    ).toBe(false);
  });
  it("no matchea si la invoice no tiene el dato objetivo", () => {
    expect(
      obligationMatchesInvoice(
        { providerId: "p1", lspServiceId: null },
        { providerId: null, lspServiceId: null }
      )
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run src/lib/fixedExpense.test.ts`
Expected: FAIL ("Cannot find module './fixedExpense'").

- [ ] **Step 3: Implementar los helpers**

`src/lib/fixedExpense.ts`:

```ts
/** Objetivo de un gasto fijo: exactamente uno de provider / lspService. */
export interface FixedExpenseTarget {
  providerId: string | null;
  lspServiceId: string | null;
}

/**
 * Valida que un gasto fijo apunte a EXACTAMENTE un objetivo.
 * Devuelve un mensaje de error, o null si es válido.
 */
export function validateFixedExpenseTarget(t: FixedExpenseTarget): string | null {
  const hasProvider = Boolean(t.providerId);
  const hasLsp = Boolean(t.lspServiceId);
  if (!hasProvider && !hasLsp) {
    return "El gasto fijo debe apuntar a un proveedor o un servicio (LSP).";
  }
  if (hasProvider && hasLsp) {
    return "El gasto fijo debe apuntar a uno solo: proveedor o servicio, no ambos.";
  }
  return null;
}

/**
 * ¿La boleta cumple la obligación de este gasto fijo?
 * - Gasto LSP  → matchea por lspServiceId.
 * - Gasto por proveedor → matchea por providerId.
 */
export function obligationMatchesInvoice(
  target: FixedExpenseTarget,
  invoice: { providerId: string | null; lspServiceId: string | null }
): boolean {
  if (target.lspServiceId) {
    return Boolean(invoice.lspServiceId) && invoice.lspServiceId === target.lspServiceId;
  }
  if (target.providerId) {
    return Boolean(invoice.providerId) && invoice.providerId === target.providerId;
  }
  return false;
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run src/lib/fixedExpense.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck` y `npm run lint`
Expected: PASS, 0 errores.

---

## Task 3: Repositorio de gastos fijos

**Files:**
- Create: `src/repositories/fixedExpense.repository.ts`

- [ ] **Step 1: Implementar el repositorio**

Sigue el patrón de `src/repositories/payment.repository.ts` (constructor con `injectedPrisma` opcional). `src/repositories/fixedExpense.repository.ts`:

```ts
import { FixedExpense, PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";
import { validateFixedExpenseTarget } from "@/lib/fixedExpense";

export interface CreateFixedExpenseInput {
  clientId: string;
  consortiumId: string;
  providerId?: string | null;
  lspServiceId?: string | null;
  description?: string | null;
}

export class FixedExpenseError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "FixedExpenseError";
  }
}

export class FixedExpenseRepository {
  constructor(private readonly injectedPrisma?: PrismaClient) {}
  private get prisma(): PrismaClient {
    return this.injectedPrisma ?? getPrismaClient();
  }

  async listByConsortium(consortiumId: string, clientId: string): Promise<FixedExpense[]> {
    return this.prisma.fixedExpense.findMany({
      where: { consortiumId, clientId },
      orderBy: { createdAt: "asc" },
    });
  }

  async create(input: CreateFixedExpenseInput): Promise<FixedExpense> {
    const target = {
      providerId: input.providerId ?? null,
      lspServiceId: input.lspServiceId ?? null,
    };
    const err = validateFixedExpenseTarget(target);
    if (err) throw new FixedExpenseError(err, 400);

    // Dedupe a nivel app: mismo consorcio + mismo objetivo.
    const existing = await this.prisma.fixedExpense.findFirst({
      where: {
        consortiumId: input.consortiumId,
        providerId: target.providerId,
        lspServiceId: target.lspServiceId,
      },
    });
    if (existing) throw new FixedExpenseError("Ese gasto fijo ya está cargado en el consorcio.", 409);

    return this.prisma.fixedExpense.create({
      data: {
        clientId: input.clientId,
        consortiumId: input.consortiumId,
        providerId: target.providerId,
        lspServiceId: target.lspServiceId,
        description: input.description ?? null,
      },
    });
  }

  async update(
    id: string,
    clientId: string,
    data: { active?: boolean; description?: string | null }
  ): Promise<FixedExpense> {
    const fx = await this.prisma.fixedExpense.findFirst({ where: { id, clientId } });
    if (!fx) throw new FixedExpenseError("Gasto fijo no encontrado", 404);
    return this.prisma.fixedExpense.update({
      where: { id },
      data: {
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
      },
    });
  }

  async delete(id: string, clientId: string): Promise<void> {
    const fx = await this.prisma.fixedExpense.findFirst({ where: { id, clientId } });
    if (!fx) throw new FixedExpenseError("Gasto fijo no encontrado", 404);
    await this.prisma.fixedExpense.delete({ where: { id } });
  }
}
```

- [ ] **Step 2: Checkpoint**

Run: `npm run typecheck` y `npm run lint`
Expected: PASS, 0 errores.

---

## Task 4: Servicio de obligaciones — generación y vinculación (TDD)

**Files:**
- Create: `src/services/obligation.service.ts`
- Test: `src/services/obligation.service.test.ts`

- [ ] **Step 1: Escribir el test que falla**

El servicio recibe un `PrismaClient` inyectable. El test usa un fake mínimo del cliente que implementa solo lo que el servicio usa. `src/services/obligation.service.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateObligationsForPeriod } from "./obligation.service";

/** Fake prisma en memoria, solo con lo que usa generateObligationsForPeriod. */
function makeFakePrisma(opts: {
  period: { id: string; consortiumId: string; clientId: string };
  fixedExpenses: Array<{ id: string; providerId: string | null; lspServiceId: string | null }>;
  invoices: Array<{ id: string; providerId: string | null; lspServiceId: string | null }>;
  existingObligations?: Array<{ fixedExpenseId: string }>;
}) {
  const created: any[] = [];
  const updated: any[] = [];
  return {
    created,
    updated,
    client: {
      period: {
        findUnique: async () => opts.period,
      },
      fixedExpense: {
        findMany: async () => opts.fixedExpenses.filter(() => true),
      },
      expenseObligation: {
        findMany: async () => (opts.existingObligations ?? []).map((o) => ({ fixedExpenseId: o.fixedExpenseId })),
        create: async ({ data }: any) => { created.push(data); return { id: `ob-${created.length}`, ...data }; },
        update: async ({ where, data }: any) => { updated.push({ where, data }); return { ...where, ...data }; },
      },
      invoice: {
        findMany: async () => opts.invoices,
      },
    } as any,
  };
}

describe("generateObligationsForPeriod", () => {
  it("crea una obligación PENDING por cada gasto fijo activo, idempotente", async () => {
    const fake = makeFakePrisma({
      period: { id: "per1", consortiumId: "c1", clientId: "cl1" },
      fixedExpenses: [
        { id: "fx1", providerId: "p1", lspServiceId: null },
        { id: "fx2", providerId: null, lspServiceId: "l1" },
      ],
      invoices: [],
      existingObligations: [{ fixedExpenseId: "fx1" }], // fx1 ya existe → no se recrea
    });
    const res = await generateObligationsForPeriod("per1", fake.client);
    expect(res.created).toBe(1); // solo fx2
    expect(fake.created[0]).toMatchObject({ fixedExpenseId: "fx2", status: "PENDING", periodId: "per1" });
  });

  it("vincula retroactivamente una boleta ya presente que matchea", async () => {
    const fake = makeFakePrisma({
      period: { id: "per1", consortiumId: "c1", clientId: "cl1" },
      fixedExpenses: [{ id: "fx2", providerId: null, lspServiceId: "l1" }],
      invoices: [{ id: "inv9", providerId: "pX", lspServiceId: "l1" }],
    });
    const res = await generateObligationsForPeriod("per1", fake.client);
    expect(res.created).toBe(1);
    expect(res.linked).toBe(1);
    expect(fake.updated[0].data).toMatchObject({ status: "RECEIVED", invoiceId: "inv9" });
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run src/services/obligation.service.test.ts`
Expected: FAIL ("Cannot find module './obligation.service'").

- [ ] **Step 3: Implementar el servicio**

`src/services/obligation.service.ts`:

```ts
import { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";
import { obligationMatchesInvoice } from "@/lib/fixedExpense";

export interface GenerateResult {
  created: number;
  linked: number;
}

/**
 * Genera (idempotente) las obligaciones PENDING de un período — una por gasto fijo
 * activo del consorcio — y vincula retroactivamente boletas ya presentes que matcheen.
 */
export async function generateObligationsForPeriod(
  periodId: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<GenerateResult> {
  const period = await prisma.period.findUnique({ where: { id: periodId } });
  if (!period) return { created: 0, linked: 0 };

  const fixedExpenses = await prisma.fixedExpense.findMany({
    where: { consortiumId: period.consortiumId, active: true },
  });
  if (fixedExpenses.length === 0) return { created: 0, linked: 0 };

  const existing = await prisma.expenseObligation.findMany({
    where: { periodId },
    select: { fixedExpenseId: true },
  });
  const existingIds = new Set(existing.map((o) => o.fixedExpenseId));

  const invoices = await prisma.invoice.findMany({
    where: { periodId },
    select: { id: true, providerId: true, lspServiceId: true },
  });

  let created = 0;
  let linked = 0;

  for (const fx of fixedExpenses) {
    if (existingIds.has(fx.id)) continue;

    const match = invoices.find((inv) =>
      obligationMatchesInvoice(
        { providerId: fx.providerId, lspServiceId: fx.lspServiceId },
        { providerId: inv.providerId, lspServiceId: inv.lspServiceId }
      )
    );

    const obligation = await prisma.expenseObligation.create({
      data: {
        clientId: period.clientId,
        consortiumId: period.consortiumId,
        periodId,
        fixedExpenseId: fx.id,
        status: "PENDING",
      },
    });
    created++;

    if (match) {
      await prisma.expenseObligation.update({
        where: { id: obligation.id },
        data: { status: "RECEIVED", invoiceId: match.id },
      });
      linked++;
    }
  }

  return { created, linked };
}

/**
 * Vincula una boleta recién persistida a su obligación PENDING (si existe) en su período.
 * Se usa en el pipeline. No toca Sheets.
 */
export async function linkInvoiceToObligation(
  invoice: { id: string; periodId: string | null; providerId: string | null; lspServiceId: string | null },
  prisma: PrismaClient = getPrismaClient()
): Promise<boolean> {
  if (!invoice.periodId) return false;

  const candidates = await prisma.expenseObligation.findMany({
    where: { periodId: invoice.periodId, status: "PENDING" },
    include: { fixedExpense: { select: { providerId: true, lspServiceId: true } } },
    orderBy: { createdAt: "asc" },
  });

  const target = candidates.find((ob) =>
    obligationMatchesInvoice(
      { providerId: ob.fixedExpense.providerId, lspServiceId: ob.fixedExpense.lspServiceId },
      { providerId: invoice.providerId, lspServiceId: invoice.lspServiceId }
    )
  );
  if (!target) return false;

  await prisma.expenseObligation.update({
    where: { id: target.id },
    data: { status: "RECEIVED", invoiceId: invoice.id },
  });
  return true;
}

/**
 * Al cerrar un período: las obligaciones PENDING pasan a NOT_RECEIVED.
 * Devuelve el detalle de faltantes (para el resumen del cierre).
 */
export async function closeObligationsForPeriod(
  periodId: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<{ notReceived: number; labels: string[] }> {
  const pending = await prisma.expenseObligation.findMany({
    where: { periodId, status: "PENDING" },
    include: {
      fixedExpense: {
        include: {
          provider: { select: { canonicalName: true } },
          lspService: { select: { providerName: true, clientNumber: true } },
        },
      },
    },
  });

  const labels = pending.map((ob) => {
    if (ob.fixedExpense.lspService) {
      return `${ob.fixedExpense.lspService.providerName} (${ob.fixedExpense.lspService.clientNumber})`;
    }
    return ob.fixedExpense.provider?.canonicalName ?? ob.fixedExpense.description ?? "Gasto fijo";
  });

  if (pending.length > 0) {
    await prisma.expenseObligation.updateMany({
      where: { periodId, status: "PENDING" },
      data: { status: "NOT_RECEIVED" },
    });
  }

  return { notReceived: pending.length, labels };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run src/services/obligation.service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck`, `npm run lint`, `npm run build:jobs`
Expected: PASS, 0 errores.

---

## Task 5: Generar obligaciones al crear un período

**Files:**
- Modify: `src/repositories/consortium.repository.ts` (método `createManual` y cualquier alta de período)

- [ ] **Step 1: Localizar la creación de período**

Run: `npx rg -n "period.create|createManual" src/repositories/consortium.repository.ts`
Expected: encontrar dónde se crea el `Period` (método `createManual`).

- [ ] **Step 2: Generar obligaciones tras crear el período**

En `consortium.repository.ts`, importar el servicio arriba:

```ts
import { generateObligationsForPeriod } from "@/services/obligation.service";
```

Justo después de crear el `Period` (fuera de la transacción de creación, con el `id` ya disponible), agregar:

```ts
// Materializa las obligaciones de gastos fijos del consorcio para el período nuevo.
// Es idempotente y no falla el alta si algo sale mal (solo loguea).
try {
  await generateObligationsForPeriod(createdPeriod.id, this.prisma);
} catch (err) {
  console.warn(`[obligations] no se pudieron generar para el período ${createdPeriod.id}: ${err instanceof Error ? err.message : err}`);
}
```

> Ajustar `createdPeriod` al nombre real de la variable del período recién creado en ese método. Si `this.prisma` no existe en ese repo, usar el cliente que ya use el método.

- [ ] **Step 3: Checkpoint**

Run: `npm run typecheck` y `npm run lint`
Expected: PASS.

---

## Task 6: Cierre de período — marcar faltantes + resumen

**Files:**
- Modify: `src/app/api/client/periods/close-all/route.ts` (o los archivos preview/execute del cierre general)

- [ ] **Step 1: Localizar el endpoint de cierre**

Run: `npx rg -n "close-all|closed|CLOSED|resolveMajorityMonth" src/app/api/client/periods`
Expected: ubicar el POST que cierra períodos (ACTIVE→CLOSED) y el GET del preview.

- [ ] **Step 2: En el EXECUTE, cerrar obligaciones de cada período cerrado**

Importar arriba del route:

```ts
import { closeObligationsForPeriod } from "@/services/obligation.service";
```

En el POST, dentro del bucle donde cada período pasa a `CLOSED` (con su `periodId` a mano), después de cerrarlo:

```ts
const obRes = await closeObligationsForPeriod(periodId, prisma);
if (obRes.notReceived > 0) {
  warnings.push(`${consortiumName}: faltaron ${obRes.notReceived} boleta(s) de gastos fijos (${obRes.labels.join(", ")}).`);
}
```

> Adaptar `periodId`, `consortiumName`, `warnings` y `prisma` a los nombres reales del handler. Si el cierre usa una transacción `tx`, pasar `tx` a `closeObligationsForPeriod(periodId, tx)`.

- [ ] **Step 3: En el PREVIEW, contar pendientes (opcional pero recomendado)**

En el GET del preview, para los períodos que se cerrarían, contar obligaciones `PENDING` y sumarlo a la respuesta:

```ts
const pendingObligations = await prisma.expenseObligation.count({
  where: { periodId, status: "PENDING" },
});
```

Agregar `pendingObligations` al item del preview para que la UI lo muestre.

- [ ] **Step 4: Mostrar los faltantes en el modal de cierre (UI)**

En `src/app/admin/consortiums/page.tsx`, localizar el modal de "Cerrar Periodo General" (paso 1 / preview):

Run: `npx rg -n "close-all|Cerrar Periodo|toClose|majorityMonth" src/app/admin/consortiums/page.tsx`

En la lista de consorcios "a cerrar" del preview, si el item trae `pendingObligations > 0`, mostrar un aviso junto al consorcio:

```tsx
{item.pendingObligations > 0 && (
  <span className={styles.badgeWarn}>Faltan {item.pendingObligations} boleta(s) de gastos fijos</span>
)}
```

> Adaptar `item` al nombre real del elemento del preview y `styles.badgeWarn` a una clase de aviso existente.

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck` y `npm run lint`
Expected: PASS.

---

## Task 7: Vincular la boleta a su obligación en el pipeline

**Files:**
- Modify: `src/jobs/pipeline/context.ts` (seam: dep opcional)
- Modify: `src/jobs/processPendingDocuments.job.ts` (paso tras persistir la Invoice)

- [ ] **Step 1: Agregar el seam en el contexto del pipeline**

Run: `npx rg -n "resolveStatementsFolders|buildInvoiceFileName|ProcessingContext" src/jobs/pipeline/context.ts`
Expected: ver cómo se declaran las deps opcionales inyectables.

En `context.ts`, agregar a la interfaz de deps (junto a las existentes) una función opcional con default al real:

```ts
linkInvoiceToObligation?: (
  invoice: { id: string; periodId: string | null; providerId: string | null; lspServiceId: string | null }
) => Promise<boolean>;
```

Y en la factory que arma el contexto real, el default:

```ts
import { linkInvoiceToObligation } from "@/services/obligation.service";
// ...
linkInvoiceToObligation: deps.linkInvoiceToObligation ?? ((inv) => linkInvoiceToObligation(inv)),
```

> Seguir exactamente el patrón que ya usan `resolveStatementsFolders` / `buildInvoiceFileName` en ese archivo (mismo estilo de default + override para tests).

- [ ] **Step 2: Llamar al link tras persistir la Invoice**

En `processPendingDocuments.job.ts`, localizar el paso que guarda la Invoice:

Run: `npx rg -n "invoice.create|persist|saveInvoice|Guardar Invoice" src/jobs/processPendingDocuments.job.ts`

Justo después de que la Invoice se crea con éxito y **solo si no es duplicada** (mismo guard que ya usa la persistencia), agregar:

```ts
// Vincula la boleta a la obligación de gasto fijo del período (solo DB, no Sheets).
try {
  await ctx.deps.linkInvoiceToObligation({
    id: savedInvoice.id,
    periodId: savedInvoice.periodId,
    providerId: savedInvoice.providerId,
    lspServiceId: savedInvoice.lspServiceId,
  });
} catch (err) {
  ctx.log?.warn?.(`[obligations] link falló: ${err instanceof Error ? err.message : err}`);
}
```

> Adaptar `savedInvoice` y `ctx.deps` / `ctx.log` a los nombres reales del paso de persistencia. No debe cambiar el resultado del pipeline si falla (best-effort).

- [ ] **Step 3: Test de caracterización del paso**

Agregar a `src/jobs/processPendingDocuments.job.test.ts` un test del camino "ok" que verifique que se invoca `linkInvoiceToObligation` con el id de la boleta, usando un mock inyectado por el contexto (seguir el patrón de los mocks existentes en ese archivo — `resolveStatementsFolders`, etc.):

```ts
it("vincula la boleta a su obligación tras persistir (camino ok)", async () => {
  const linkSpy = vi.fn().mockResolvedValue(true);
  // ...armar el contexto ok existente + override deps.linkInvoiceToObligation = linkSpy...
  // ...ejecutar el pipeline...
  expect(linkSpy).toHaveBeenCalledOnce();
});
```

> Copiar la estructura del test "ok" ya presente (mismos mocks de Drive/Sheets/repos) y solo agregar el override del spy + la aserción.

- [ ] **Step 4: Correr los tests del pipeline**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: PASS (los existentes + el nuevo).

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck`, `npm run lint`, `npm run build:jobs`
Expected: PASS.

---

## Task 8: Revertir la obligación al borrar/reprocesar una boleta

**Files:**
- Modify: `src/lib/invoiceDeletion.ts`

- [ ] **Step 1: Localizar el borrado de la Invoice**

Run: `npx rg -n "invoice.delete|deleteMany|ProcessingJob" src/lib/invoiceDeletion.ts`
Expected: ver dónde se borran las invoices (dentro de una transacción).

- [ ] **Step 2: Antes de borrar, revertir las obligaciones vinculadas**

Dentro de la transacción de borrado, **antes** de `invoice.delete`/`deleteMany`, para las invoices que se borran (por sus ids):

```ts
// Las obligaciones que apuntaban a estas boletas vuelven a PENDING.
await tx.expenseObligation.updateMany({
  where: { invoiceId: { in: invoiceIds } },
  data: { status: "PENDING", invoiceId: null },
});
```

> Adaptar `tx` y `invoiceIds` a los nombres reales. Si el borrado no arma un array de ids, obtenerlo antes (`const invoiceIds = invoices.map(i => i.id)`).

- [ ] **Step 3: Checkpoint**

Run: `npm run typecheck` y `npm run lint`
Expected: PASS.

---

## Task 9: Endpoints — CRUD de gastos fijos

**Files:**
- Create: `src/app/api/client/consortiums/[id]/fixed-expenses/route.ts`
- Create: `src/app/api/client/consortiums/[id]/fixed-expenses/[fxId]/route.ts`

- [ ] **Step 1: GET (listar) + POST (crear)**

`src/app/api/client/consortiums/[id]/fixed-expenses/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { FixedExpenseRepository, FixedExpenseError } from "@/repositories/fixedExpense.repository";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: consortiumId } = await context.params;
  const clientId = auth.session.clientId;

  const repo = new FixedExpenseRepository();
  const items = await repo.listByConsortium(consortiumId, clientId);
  return NextResponse.json({ ok: true, fixedExpenses: items });
}

const createSchema = z.object({
  providerId: z.string().optional().nullable(),
  lspServiceId: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: consortiumId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
    }

    // El consorcio debe pertenecer al cliente.
    const prisma = getPrismaClient();
    const consortium = await prisma.consortium.findFirst({ where: { id: consortiumId, clientId } });
    if (!consortium) return NextResponse.json({ ok: false, error: "Consorcio no encontrado" }, { status: 404 });

    const repo = new FixedExpenseRepository();
    const created = await repo.create({
      clientId,
      consortiumId,
      providerId: parsed.data.providerId ?? null,
      lspServiceId: parsed.data.lspServiceId ?? null,
      description: parsed.data.description ?? null,
    });
    return NextResponse.json({ ok: true, fixedExpense: created }, { status: 201 });
  } catch (err) {
    if (err instanceof FixedExpenseError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Error interno" }, { status: 500 });
  }
}
```

- [ ] **Step 2: PATCH + DELETE**

`src/app/api/client/consortiums/[id]/fixed-expenses/[fxId]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { FixedExpenseRepository, FixedExpenseError } from "@/repositories/fixedExpense.repository";

const patchSchema = z.object({
  active: z.boolean().optional(),
  description: z.string().optional().nullable(),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string; fxId: string }> }) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;
  const { fxId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    const repo = new FixedExpenseRepository();
    const updated = await repo.update(fxId, clientId, parsed.data);
    return NextResponse.json({ ok: true, fixedExpense: updated });
  } catch (err) {
    if (err instanceof FixedExpenseError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Error interno" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string; fxId: string }> }) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;
  const { fxId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const repo = new FixedExpenseRepository();
    await repo.delete(fxId, clientId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof FixedExpenseError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Error interno" }, { status: 500 });
  }
}
```

- [ ] **Step 3: Checkpoint**

Run: `npm run typecheck` y `npm run lint`
Expected: PASS.

---

## Task 10: Endpoints — obligaciones (listar, generar, cambiar estado)

**Files:**
- Create: `src/app/api/client/periods/[id]/obligations/route.ts`
- Create: `src/app/api/client/obligations/[id]/route.ts`

- [ ] **Step 1: GET (listar) + POST (generar) por período**

`src/app/api/client/periods/[id]/obligations/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { generateObligationsForPeriod } from "@/services/obligation.service";

async function assertPeriodOwned(periodId: string, clientId: string) {
  const prisma = getPrismaClient();
  return prisma.period.findFirst({ where: { id: periodId, clientId } });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: periodId } = await context.params;
  const clientId = auth.session.clientId;

  const period = await assertPeriodOwned(periodId, clientId);
  if (!period) return NextResponse.json({ ok: false, error: "Período no encontrado" }, { status: 404 });

  const prisma = getPrismaClient();
  const obligations = await prisma.expenseObligation.findMany({
    where: { periodId },
    include: {
      fixedExpense: {
        include: {
          provider: { select: { canonicalName: true } },
          lspService: { select: { providerName: true, clientNumber: true } },
        },
      },
      invoice: { select: { id: true, isPaid: true, remainingBalance: true, amount: true, sourceFileUrl: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ ok: true, obligations });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: periodId } = await context.params;
  const clientId = auth.session.clientId;

  const period = await assertPeriodOwned(periodId, clientId);
  if (!period) return NextResponse.json({ ok: false, error: "Período no encontrado" }, { status: 404 });

  const result = await generateObligationsForPeriod(periodId);
  return NextResponse.json({ ok: true, ...result });
}
```

- [ ] **Step 2: PATCH estado de una obligación (ej. omitir)**

`src/app/api/client/obligations/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";

const patchSchema = z.object({
  status: z.enum(["PENDING", "SKIPPED"]),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const clientId = auth.session.clientId;

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
  }

  const prisma = getPrismaClient();
  const ob = await prisma.expenseObligation.findFirst({ where: { id, clientId } });
  if (!ob) return NextResponse.json({ ok: false, error: "Obligación no encontrada" }, { status: 404 });

  // Solo se permite omitir/reactivar cuando NO está recibida (no pisar un vínculo real).
  if (ob.status === "RECEIVED") {
    return NextResponse.json({ ok: false, error: "La obligación ya tiene boleta recibida." }, { status: 409 });
  }

  const updated = await prisma.expenseObligation.update({ where: { id }, data: { status: parsed.data.status } });
  return NextResponse.json({ ok: true, obligation: updated });
}
```

- [ ] **Step 3: Checkpoint**

Run: `npm run typecheck` y `npm run lint`
Expected: PASS.

---

## Task 11: UI — sección "Gastos fijos" en el detalle del consorcio

**Files:**
- Modify: `src/app/admin/consortiums/page.tsx`

- [ ] **Step 1: Ubicar la sección LSP como molde**

Run: `npx rg -n "Servicios públicos \(LSP\)|lspCollapsed|LspService" src/app/admin/consortiums/page.tsx`
Expected: ubicar la sección colapsable de LSP y sus estados (molde a copiar).

- [ ] **Step 2: Estado + fetch de gastos fijos**

Cerca del estado del consorcio seleccionado, agregar:

```tsx
type FixedExpenseRow = {
  id: string; providerId: string | null; lspServiceId: string | null;
  description: string | null; active: boolean;
};
const [fixedExpenses, setFixedExpenses] = useState<FixedExpenseRow[]>([]);
const [fxCollapsed, setFxCollapsed] = useState(true);

const fetchFixedExpenses = async (consortiumId: string) => {
  try {
    const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/fixed-expenses`, { cache: "no-store" });
    const data = await res.json();
    if (data.ok) setFixedExpenses(data.fixedExpenses);
  } catch { /* silent */ }
};
```

Llamar `fetchFixedExpenses(consortiumId)` donde ya se cargan los datos del consorcio seleccionado (junto al fetch de LSP/boletas).

- [ ] **Step 3: Render de la sección (agregar/quitar/activar)**

Debajo de la sección "Servicios públicos (LSP)", agregar una sección colapsable equivalente. El selector de objetivo ofrece los proveedores del cliente y los LspServices del consorcio (ambos ya disponibles en el estado de la página; reusar las listas existentes `providers` y `lspServices`). Estructura:

```tsx
<div className={styles.lspSection}>
  <button type="button" className={styles.lspHeader} onClick={() => setFxCollapsed((v) => !v)}>
    ▸ Gastos fijos <span className={styles.lspBadge}>{fixedExpenses.length}</span>
  </button>
  {!fxCollapsed && (
    <div className={styles.lspBody}>
      {/* Alta */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select id="fx-target" className={styles.formSelect}>
          <option value="" disabled hidden>Elegir proveedor o servicio…</option>
          <optgroup label="Proveedores">
            {providers.map((p) => <option key={`p-${p.id}`} value={`provider:${p.id}`}>{p.canonicalName}</option>)}
          </optgroup>
          <optgroup label="Servicios (LSP)">
            {lspServices.map((l) => <option key={`l-${l.id}`} value={`lsp:${l.id}`}>{l.providerName} ({l.clientNumber})</option>)}
          </optgroup>
        </select>
        <button
          type="button"
          className={styles.addInvoiceBtn}
          onClick={async () => {
            const sel = (document.getElementById("fx-target") as HTMLSelectElement)?.value;
            if (!sel) return;
            const [kind, targetId] = sel.split(":");
            const body = kind === "provider" ? { providerId: targetId } : { lspServiceId: targetId };
            const res = await fetch(`/api/client/consortiums/${selectedId}/fixed-expenses`, {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok || !data.ok) { setError(data.error ?? "Error"); return; }
            if (selectedId) fetchFixedExpenses(selectedId);
          }}
        >Agregar</button>
      </div>

      {/* Lista */}
      <ul className={styles.lspList}>
        {fixedExpenses.map((fx) => {
          const prov = providers.find((p) => p.id === fx.providerId);
          const lsp = lspServices.find((l) => l.id === fx.lspServiceId);
          const label = lsp ? `${lsp.providerName} (${lsp.clientNumber})` : prov?.canonicalName ?? "—";
          return (
            <li key={fx.id} className={styles.lspItem}>
              <span>{label}{!fx.active && " · (inactivo)"}</span>
              <div style={{ display: "inline-flex", gap: 6 }}>
                <button type="button" className={styles.ghostBtn} onClick={async () => {
                  await fetch(`/api/client/consortiums/${selectedId}/fixed-expenses/${fx.id}`, {
                    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ active: !fx.active }),
                  });
                  if (selectedId) fetchFixedExpenses(selectedId);
                }}>{fx.active ? "Desactivar" : "Activar"}</button>
                <button type="button" className={styles.lspDeleteBtn} onClick={async () => {
                  await fetch(`/api/client/consortiums/${selectedId}/fixed-expenses/${fx.id}`, { method: "DELETE" });
                  if (selectedId) fetchFixedExpenses(selectedId);
                }}>Quitar</button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  )}
</div>
```

> Reusar las clases CSS reales de la sección LSP (inspeccionar los nombres exactos en `page.module.css`; los de arriba son ilustrativos y deben mapearse a los existentes). `providers` y `lspServices` deben ser los estados ya cargados de la página; si no existen con esos nombres, usar los reales.

- [ ] **Step 4: Verificación manual (owner)**

Levantar `npm run dev`, abrir un consorcio, expandir "Gastos fijos", agregar uno por proveedor y otro por LSP, desactivar y quitar. Confirmar que persisten (recargar).

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck` y `npm run lint`
Expected: PASS.

---

## Task 12: UI — pestaña "Obligaciones" en la vista del período

**Files:**
- Modify: `src/app/admin/consortiums/page.tsx`

- [ ] **Step 1: Ubicar las pestañas Boletas/Pagos**

Run: `npx rg -n "Boletas|Pagos|activeTab|setActiveTab|PagosView" src/app/admin/consortiums/page.tsx`
Expected: ver cómo se define el switch de pestañas del período.

- [ ] **Step 2: Estado + fetch de obligaciones del período**

```tsx
type ObligationRow = {
  id: string; status: "PENDING" | "RECEIVED" | "SKIPPED" | "NOT_RECEIVED";
  fixedExpense: {
    description: string | null;
    provider: { canonicalName: string } | null;
    lspService: { providerName: string; clientNumber: string } | null;
  };
  invoice: { id: string; isPaid: boolean; remainingBalance: string | number | null; amount: string | number | null; sourceFileUrl: string | null } | null;
};
const [obligations, setObligations] = useState<ObligationRow[]>([]);

const fetchObligations = async (periodId: string) => {
  try {
    const res = await guardedFetch(`/api/client/periods/${periodId}/obligations`, { cache: "no-store" });
    const data = await res.json();
    if (data.ok) setObligations(data.obligations);
  } catch { /* silent */ }
};
```

Llamar `fetchObligations(selectedPeriod.id)` cuando cambia el período seleccionado (junto al fetch de boletas).

Contador de faltantes para el badge:

```tsx
const pendingObligations = obligations.filter((o) => o.status === "PENDING").length;
```

- [ ] **Step 3: Agregar la pestaña con badge**

Donde se renderizan las pestañas Boletas/Pagos, agregar una tercera:

```tsx
<button
  type="button"
  className={activeTab === "obligaciones" ? styles.tabActive : styles.tab}
  onClick={() => setActiveTab("obligaciones")}
>
  Obligaciones
  {pendingObligations > 0 && <span className={styles.badgeWarn}>{pendingObligations}</span>}
</button>
```

> Ampliar el tipo de `activeTab` para incluir `"obligaciones"`.

- [ ] **Step 4: Render del contenido de la pestaña**

```tsx
{activeTab === "obligaciones" && (
  <div className={styles.tableWrap}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
      <span>{pendingObligations > 0 ? `Faltan ${pendingObligations} boleta(s) de gastos fijos` : "Sin faltantes"}</span>
      {obligations.length === 0 && (
        <button type="button" className={styles.addInvoiceBtn} onClick={async () => {
          if (!selectedPeriod) return;
          await fetch(`/api/client/periods/${selectedPeriod.id}/obligations`, { method: "POST" });
          fetchObligations(selectedPeriod.id);
        }}>Generar obligaciones</button>
      )}
    </div>
    {obligations.length === 0 ? (
      <div className={styles.tableEmpty}>No hay obligaciones generadas para este período.</div>
    ) : (
      <table className={styles.table}>
        <thead><tr><th>GASTO FIJO</th><th>ESTADO</th><th>BOLETA / PAGO</th><th>ACCIONES</th></tr></thead>
        <tbody>
          {obligations.map((ob) => {
            const label = ob.fixedExpense.lspService
              ? `${ob.fixedExpense.lspService.providerName} (${ob.fixedExpense.lspService.clientNumber})`
              : ob.fixedExpense.provider?.canonicalName ?? ob.fixedExpense.description ?? "—";
            const badge =
              ob.status === "RECEIVED" ? <span className={styles.badgeOk}>Recibida</span>
              : ob.status === "PENDING" ? <span className={styles.badgeWarn}>Pendiente</span>
              : ob.status === "NOT_RECEIVED" ? <span className={styles.badgeDuplicate}>No recibida</span>
              : <span className={styles.badgeManual}>Omitida</span>;
            return (
              <tr key={ob.id}>
                <td>{label}</td>
                <td>{badge}</td>
                <td>
                  {ob.invoice
                    ? <>{ob.invoice.isPaid ? "Pagada" : "Impaga"} · {ob.invoice.sourceFileUrl
                        ? <a href={ob.invoice.sourceFileUrl} target="_blank" rel="noopener noreferrer" className={styles.fileLink}>Ver PDF</a>
                        : "—"}</>
                    : "—"}
                </td>
                <td>
                  {ob.status === "PENDING" && (
                    <button type="button" className={styles.ghostBtn} onClick={async () => {
                      await fetch(`/api/client/obligations/${ob.id}`, {
                        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "SKIPPED" }),
                      });
                      if (selectedPeriod) fetchObligations(selectedPeriod.id);
                    }}>Omitir</button>
                  )}
                  {ob.status === "SKIPPED" && (
                    <button type="button" className={styles.ghostBtn} onClick={async () => {
                      await fetch(`/api/client/obligations/${ob.id}`, {
                        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "PENDING" }),
                      });
                      if (selectedPeriod) fetchObligations(selectedPeriod.id);
                    }}>Reactivar</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    )}
  </div>
)}
```

> Mapear `styles.badgeWarn`, `styles.tab`, `styles.tabActive` a las clases reales (inspeccionar `page.module.css`; usar las que ya existen para badges de estado y pestañas).

- [ ] **Step 5: Verificación manual (owner)**

Con `npm run dev`: en un período con gastos fijos cargados, apretar "Generar obligaciones" → aparecen en Pendiente; procesar/cargar una boleta que matchee → la obligación pasa a "Recibida" con link a la boleta y estado de pago; "Omitir"/"Reactivar" funcionan; el badge de la pestaña muestra el nº de pendientes.

- [ ] **Step 6: Checkpoint**

Run: `npm run typecheck`, `npm run lint`, `npm run build:jobs`
Expected: PASS.

---

## Task 13: Documentación

**Files:**
- Modify: `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`

- [ ] **Step 1: Actualizar los tres archivos**

- `docs/progreso.md`: nueva sección "Gastos fijos + obligaciones de pago" con estado (implementado/verificado), resumen de las 7 decisiones y el detalle de tablas/flujo.
- `docs/decisiones.md`: entrada `2026-07-05` con problema (falta de visibilidad de gastos recurrentes), decisión (2 modelos, materializado por período, vinculado a Provider/LspService, solo DB), alternativas descartadas (texto libre, cálculo al vuelo, monto esperado, Sheets) e impacto (archivos + migración).
- `CHANGELOG.md`: bullet en `### Feature` describiendo la feature y la migración `20260705000200_add_fixed_expenses`.

- [ ] **Step 2: Checkpoint final (verificación completa)**

Run (por separado): `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:jobs`
Expected: todo PASS, 0 errores de lint, todos los tests verdes.

> Avisar al owner: migración `20260705000200_add_fixed_expenses` pendiente de `migrate deploy` (ya debería estar de la Task 1); commit de la feature pendiente (lo hace el owner).

---

## Notas de ejecución
- **Orden:** la Task 1 es bloqueante (sin `migrate deploy` + `generate` no tipa nada). Las Tasks 2–4 son la base lógica; 5–8 integran; 9–10 exponen API; 11–12 UI; 13 docs.
- **Best-effort:** la generación (Task 5) y el link en el pipeline (Task 7) NO deben romper el flujo principal si fallan (try/catch + warn).
- **Sin Sheets:** ninguna parte de esta feature escribe en Google Sheets (decidido en el spec).
