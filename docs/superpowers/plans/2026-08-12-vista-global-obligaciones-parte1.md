# Vista global de obligaciones — Parte 1 (vista + administración) · Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: usar `superpowers:subagent-driven-development`
> (recomendado) o `superpowers:executing-plans` para implementar tarea por tarea. Los pasos usan
> checkboxes (`- [ ]`) para seguimiento.

> **⚠️ REGLA DEL PROYECTO — NO COMMITEAR.** Claude nunca ejecuta `git commit`, `git add` ni
> `git push`. El owner commitea con GitLens. Cada tarea cierra con **verificación**, no con commit.
> No sugerir mensajes de commit ni preparar staging.

> **⚠️ REGLA DEL PROYECTO — NO MIGRAR.** Claude crea la carpeta y el `migration.sql`, pero **no**
> corre `prisma migrate deploy` ni `prisma generate`. Eso lo hace el owner.

**Goal:** Una pantalla nueva (`/admin/obligaciones`) donde el administrador ve los gastos fijos de
todos sus edificios agrupados por banco, con la forma exacta de la hoja que después va a imprimir, y
puede agregarlos (de a varios), desactivarlos, eliminarlos y omitir la obligación del mes — sin
entrar a 47 pantallas.

**Architecture:** Al montar, la vista dispara una sincronización **set-based** que crea las
obligaciones faltantes de todos los períodos activos del cliente (~5 queries, no 47 llamadas), y
después carga un `overview` que devuelve todo lo que la pantalla necesita en ~4 queries. Una función
pura convierte esa respuesta en `SheetData[]` — el modelo del documento — que la Parte 2 reutilizará
tal cual para generar el PDF. Piezas nuevas siguiendo el patrón del proyecto: lógica pura en `lib/`,
hook en `hooks/`, componentes presentacionales en `components/`.

**Tech Stack:** Next.js 16 (App Router, client components), TypeScript, React 19, Prisma 6 +
PostgreSQL, Vitest con dos proyectos (`node` para `*.test.ts`, `jsdom` para `*.test.tsx`),
`@testing-library/react` + `user-event`.

**Spec:** `docs/superpowers/specs/2026-08-12-vista-global-obligaciones-design.md`

---

## Contexto que el implementador necesita saber

**El dominio.** Un **gasto fijo** (`FixedExpense`) es la definición permanente: "este edificio paga
EDESUR todos los meses". Apunta a **exactamente uno** de `Provider` o `LspService` (regla validada por
`validateFixedExpenseTarget`). Una **obligación** (`ExpenseObligation`) es la instancia de ese gasto
en un mes concreto, con `status` (`PENDING` / `RECEIVED` / `SKIPPED` / `NOT_RECEIVED`) y un
`invoiceId` opcional. Cuando la boleta entra por el pipeline y matchea, la obligación pasa a
`RECEIVED` y de ahí sale el monto.

**Por qué la sincronización.** Las obligaciones se generan al crear el período. Si alguien agrega un
gasto fijo a mitad de mes, el período abierto no se entera. La vista sincroniza al abrir para que el
papel nunca salga incompleto.

**Por qué set-based.** `generateObligationsForPeriod` recibe **un** período y hace un `create` por
gasto fijo dentro de un `for`. Llamarlo 47 veces son cientos de queries secuenciales: el patrón que
produjo el timeout 524 del túnel Cloudflare en `close-all` (`docs/decisiones.md`, 2026-07-12). La
función nueva usa `createMany`.

**Convenciones del repo que hay que respetar:**
- PowerShell: **no usar `&&`**, comandos separados.
- Tests: lógica pura → `.test.ts` (proyecto `node`); hooks y componentes → `.test.tsx` (proyecto
  `jsdom`). Todo con `npx vitest run`.
- **CSS Modules corren en modo `pure`:** todo selector necesita al menos una clase local. Un
  `[data-bank-color="x"]` suelto compila en dev y pasa los tests, pero **rompe `npm run build`** con
  "Selector is not pure". Anclarlo siempre a la clase (`.sheetCard[data-bank-color="red"]`).
- Endpoints de cliente: `requireClientSession` (no `requireAuthenticatedSession`, que es del panel
  admin). Hay un test que escanea las rutas y falla si una queda sin guard
  (`src/app/api/routeAuthGuard.test.ts`).
- Textos de UI y comentarios en **castellano**.
- Fetch desde el front: `useAuthGuard().guardedFetch`, nunca `fetch` pelado.

**Desvíos del spec, decididos acá y a propósito:**
1. **No se usa `groupByBank`.** Esa función existe para la grilla de bancos con su búsqueda por card
   y devuelve `Consortium[]`, un tipo que esta vista no maneja. El agrupamiento acá es un `reduce`
   sobre `SheetData[]` ya ordenado. Sí se reutiliza `bankPalette` para los colores.
2. **No hay `useAddFixedExpenseModal`.** El estado del modal es búsqueda + selección; vive en el
   componente. Un hook para eso sería ceremonia sin valor (YAGNI).
3. **`toPrintableSheets` no se implementa acá.** Es de la Parte 2 (PDF/impresión). Esta entrega deja
   el `SheetData[]` construido y testeado, que es su insumo.

**Baseline verificado:** `master` en `379d6f6`, **456 tests** verdes.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `prisma/schema.prisma` **(modificar)** | Dos `@@unique` en `FixedExpense` |
| `prisma/migrations/20260812000000_unique_fixed_expense_target/migration.sql` **(crear)** | El SQL de esos índices |
| `src/services/obligation.service.ts` **(modificar)** | Suma `syncObligationsForClient` (set-based) |
| `src/services/obligation.service.test.ts` **(modificar)** | Tests de la función nueva |
| `src/app/api/client/obligations/sync/route.ts` **(crear)** | POST: dispara la sincronización |
| `src/app/api/client/obligations/overview/route.ts` **(crear)** | GET: todo lo que la vista necesita |
| `src/app/api/client/consortiums/[id]/fixed-expenses/route.ts` **(modificar)** | El POST acepta `items[]` |
| `src/app/admin/obligaciones/lib/sheetModel.ts` **(crear)** | Tipos + `buildSheets` + `filterSheets` |
| `src/app/admin/obligaciones/lib/sheetModel.test.ts` **(crear)** | Tests tier 0 |
| `src/app/admin/obligaciones/lib/availableTargets.ts` **(crear)** | Qué queda disponible para el modal de alta |
| `src/app/admin/obligaciones/lib/availableTargets.test.ts` **(crear)** | Tests tier 0 |
| `src/app/admin/obligaciones/hooks/useObligationsOverview.ts` **(crear)** | Sincroniza, carga y muta |
| `src/app/admin/obligaciones/hooks/useObligationsOverview.test.tsx` **(crear)** | Tests tier 1 |
| `src/app/admin/obligaciones/components/AddFixedExpenseModal.tsx` **(crear)** | Alta múltiple con checkboxes |
| `src/app/admin/obligaciones/components/AddFixedExpenseModal.test.tsx` **(crear)** | Tests tier 2 |
| `src/app/admin/obligaciones/components/SheetCard.tsx` **(crear)** | La tarjeta-hoja de un edificio |
| `src/app/admin/obligaciones/components/SheetCard.test.tsx` **(crear)** | Tests tier 2 |
| `src/app/admin/obligaciones/page.tsx` **(crear)** | Cablea todo |
| `src/app/admin/obligaciones/page.module.css` **(crear)** | Layout |
| `src/app/admin/consortiums/page.tsx` **(modificar)** | Botón del sidebar + rename del botón de la pestaña |
| `src/app/admin/consortiums/components/ConfigModal.tsx` **(modificar)** | Gastos fijos → solo lectura + link |
| `src/app/admin/consortiums/hooks/useConsortiumConfig.ts` **(modificar)** | Salen los handlers de alta/toggle/borrado |

---

## Task 1: Migración — índice único del objetivo del gasto fijo

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260812000000_unique_fixed_expense_target/migration.sql`

Postgres trata los `NULL` como distintos entre sí, así que `@@unique([consortiumId, providerId])` no
molesta a los gastos fijos LSP (que tienen `providerId: null`) ni al revés. No hace falta índice
parcial.

- [ ] **Step 1: Agregar los índices al schema**

En `prisma/schema.prisma`, en el bloque `model FixedExpense`, junto a los `@@index` existentes:

```prisma
  @@unique([consortiumId, providerId])
  @@unique([consortiumId, lspServiceId])
  @@index([clientId])
  @@index([consortiumId])
```

- [ ] **Step 2: Crear el archivo de migración**

Crear `prisma/migrations/20260812000000_unique_fixed_expense_target/migration.sql`:

```sql
-- Un gasto fijo por objetivo y por consorcio.
-- Postgres considera los NULL distintos entre sí, así que un gasto LSP
-- (providerId NULL) nunca colisiona con otro LSP del mismo consorcio.
CREATE UNIQUE INDEX "FixedExpense_consortiumId_providerId_key"
  ON "FixedExpense"("consortiumId", "providerId");

CREATE UNIQUE INDEX "FixedExpense_consortiumId_lspServiceId_key"
  ON "FixedExpense"("consortiumId", "lspServiceId");
```

- [ ] **Step 3: Validar el schema**

```bash
npx prisma validate
```

Esperado: `The schema at prisma\schema.prisma is valid 🚀`. **No correr `migrate deploy` ni
`generate`** — lo hace el owner.

- [ ] **Step 4: Dejar anotada la query de verificación previa**

El owner tiene que correr esto en Supabase **antes** de aplicar la migración; si devuelve filas, la
migración falla y hay que limpiar a mano primero:

```sql
SELECT "consortiumId", "providerId", "lspServiceId", COUNT(*)
FROM "FixedExpense"
GROUP BY 1, 2, 3
HAVING COUNT(*) > 1;
```

Esperado: 0 filas (el repositorio ya rechaza duplicados con 409 desde que existe la feature).

---

## Task 2: Sincronización set-based

**Files:**
- Modify: `src/services/obligation.service.ts`
- Test: `src/services/obligation.service.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `src/services/obligation.service.test.ts` (dejando intacto lo que ya está):

```ts
import { syncObligationsForClient } from "./obligation.service";

/** Fake prisma para syncObligationsForClient: set-based, sin `create` de a uno. */
function makeFakeSyncPrisma(opts: {
  periods: Array<{ id: string; consortiumId: string }>;
  fixedExpenses: Array<{ id: string; consortiumId: string; providerId: string | null; lspServiceId: string | null }>;
  existing?: Array<{ periodId: string; fixedExpenseId: string; invoiceId: string | null }>;
  invoices?: Array<{ id: string; periodId: string; providerId: string | null; lspServiceId: string | null }>;
  /** Obligaciones que la 2ª lectura devuelve como recién creadas (sin boleta). */
  fresh?: Array<{ id: string; periodId: string; fixedExpenseId: string }>;
}) {
  const createdMany: any[] = [];
  const updated: any[] = [];
  return {
    createdMany,
    updated,
    client: {
      period: { findMany: async () => opts.periods },
      fixedExpense: { findMany: async () => opts.fixedExpenses },
      expenseObligation: {
        findMany: async (args: any) => {
          // 2ª lectura: las que quedaron PENDING sin boleta (las recién creadas).
          if (args?.where?.invoiceId === null) return opts.fresh ?? [];
          return opts.existing ?? [];
        },
        createMany: async ({ data }: any) => { createdMany.push(...data); return { count: data.length }; },
        update: async ({ where, data }: any) => { updated.push({ where, data }); return { ...where, ...data }; },
      },
      invoice: { findMany: async () => opts.invoices ?? [] },
    } as any,
  };
}

describe("syncObligationsForClient", () => {
  it("crea las faltantes de todos los períodos activos con un solo createMany", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [
        { id: "per1", consortiumId: "c1" },
        { id: "per2", consortiumId: "c2" },
      ],
      fixedExpenses: [
        { id: "fx1", consortiumId: "c1", providerId: "p1", lspServiceId: null },
        { id: "fx2", consortiumId: "c1", providerId: null, lspServiceId: "l1" },
        { id: "fx3", consortiumId: "c2", providerId: "p2", lspServiceId: null },
      ],
      existing: [{ periodId: "per1", fixedExpenseId: "fx1", invoiceId: null }],
    });

    const res = await syncObligationsForClient("cl1", fake.client);

    expect(res.created).toBe(2); // fx2 en per1 y fx3 en per2
    expect(res.periods).toBe(2);
    expect(fake.createdMany).toHaveLength(2);
    expect(fake.createdMany).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ periodId: "per1", fixedExpenseId: "fx2", status: "PENDING", clientId: "cl1", consortiumId: "c1" }),
        expect.objectContaining({ periodId: "per2", fixedExpenseId: "fx3", status: "PENDING", clientId: "cl1", consortiumId: "c2" }),
      ])
    );
  });

  it("es idempotente: si no falta nada, no escribe", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "per1", consortiumId: "c1" }],
      fixedExpenses: [{ id: "fx1", consortiumId: "c1", providerId: "p1", lspServiceId: null }],
      existing: [{ periodId: "per1", fixedExpenseId: "fx1", invoiceId: null }],
    });

    const res = await syncObligationsForClient("cl1", fake.client);

    expect(res).toEqual({ created: 0, linked: 0, periods: 1 });
    expect(fake.createdMany).toHaveLength(0);
    expect(fake.updated).toHaveLength(0);
  });

  it("sin períodos activos no toca nada", async () => {
    const fake = makeFakeSyncPrisma({ periods: [], fixedExpenses: [] });
    const res = await syncObligationsForClient("cl1", fake.client);
    expect(res).toEqual({ created: 0, linked: 0, periods: 0 });
  });

  it("vincula una boleta ya presente a una obligación recién creada", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "per1", consortiumId: "c1" }],
      fixedExpenses: [{ id: "fx2", consortiumId: "c1", providerId: null, lspServiceId: "l1" }],
      existing: [],
      invoices: [{ id: "inv9", periodId: "per1", providerId: "pX", lspServiceId: "l1" }],
      fresh: [{ id: "ob9", periodId: "per1", fixedExpenseId: "fx2" }],
    });

    const res = await syncObligationsForClient("cl1", fake.client);

    expect(res.created).toBe(1);
    expect(res.linked).toBe(1);
    expect(fake.updated[0]).toMatchObject({
      where: { id: "ob9" },
      data: { status: "RECEIVED", invoiceId: "inv9" },
    });
  });

  it("no roba una boleta que ya está vinculada a otra obligación", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "per1", consortiumId: "c1" }],
      fixedExpenses: [
        { id: "fx1", consortiumId: "c1", providerId: null, lspServiceId: "l1" },
        { id: "fx2", consortiumId: "c1", providerId: "p1", lspServiceId: null },
      ],
      existing: [{ periodId: "per1", fixedExpenseId: "fx1", invoiceId: "inv9" }],
      invoices: [{ id: "inv9", periodId: "per1", providerId: null, lspServiceId: "l1" }],
      fresh: [{ id: "ob2", periodId: "per1", fixedExpenseId: "fx2" }],
    });

    const res = await syncObligationsForClient("cl1", fake.client);

    expect(res.created).toBe(1);
    expect(res.linked).toBe(0);
    expect(fake.updated).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/services/obligation.service.test.ts
```

Esperado: FAIL — `syncObligationsForClient is not a function` (o error de import).

- [ ] **Step 3: Escribir la implementación**

Agregar al final de `src/services/obligation.service.ts`:

```ts
export interface SyncResult {
  created: number;
  linked: number;
  /** Cuántos períodos activos se consideraron (para el aviso de la UI). */
  periods: number;
}

/**
 * Sincroniza las obligaciones de TODOS los períodos activos de un cliente.
 *
 * Es la versión set-based de `generateObligationsForPeriod`: la vista global la
 * llama al montar con 47 edificios, así que no puede hacer una query por gasto
 * fijo (ese patrón produjo el 524 del túnel en `close-all`, ver
 * `docs/decisiones.md` 2026-07-12). Son ~5 queries en total, sin importar el
 * tamaño de la cartera.
 *
 * Idempotente: correrla dos veces seguidas no crea nada.
 */
export async function syncObligationsForClient(
  clientId: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<SyncResult> {
  const periods = await prisma.period.findMany({
    where: { clientId, status: "ACTIVE" },
    select: { id: true, consortiumId: true },
  });
  if (periods.length === 0) return { created: 0, linked: 0, periods: 0 };

  const consortiumIds = [...new Set(periods.map((p) => p.consortiumId))];
  const periodIds = periods.map((p) => p.id);

  const fixedExpenses = await prisma.fixedExpense.findMany({
    where: { consortiumId: { in: consortiumIds }, active: true },
    select: { id: true, consortiumId: true, providerId: true, lspServiceId: true },
  });

  const existing = await prisma.expenseObligation.findMany({
    where: { periodId: { in: periodIds } },
    select: { periodId: true, fixedExpenseId: true, invoiceId: true },
  });
  const alreadyThere = new Set(existing.map((o) => `${o.periodId}:${o.fixedExpenseId}`));
  const takenInvoiceIds = new Set(existing.map((o) => o.invoiceId).filter((id): id is string => Boolean(id)));

  const byConsortium = new Map<string, typeof fixedExpenses>();
  for (const fx of fixedExpenses) {
    const list = byConsortium.get(fx.consortiumId) ?? [];
    list.push(fx);
    byConsortium.set(fx.consortiumId, list);
  }

  const toCreate = periods.flatMap((period) =>
    (byConsortium.get(period.consortiumId) ?? [])
      .filter((fx) => !alreadyThere.has(`${period.id}:${fx.id}`))
      .map((fx) => ({
        clientId,
        consortiumId: period.consortiumId,
        periodId: period.id,
        fixedExpenseId: fx.id,
        status: "PENDING" as const,
      }))
  );

  if (toCreate.length === 0) return { created: 0, linked: 0, periods: periods.length };

  await prisma.expenseObligation.createMany({ data: toCreate, skipDuplicates: true });

  // Vínculo retroactivo, acotado a los períodos donde efectivamente se creó algo:
  // en régimen normal esto no hace ningún update.
  const touchedPeriodIds = [...new Set(toCreate.map((o) => o.periodId))];

  const fresh = await prisma.expenseObligation.findMany({
    where: { periodId: { in: touchedPeriodIds }, status: "PENDING", invoiceId: null },
    select: { id: true, periodId: true, fixedExpenseId: true },
  });

  const invoices = await prisma.invoice.findMany({
    where: { periodId: { in: touchedPeriodIds } },
    select: { id: true, periodId: true, providerId: true, lspServiceId: true },
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
          { providerId: fx.providerId, lspServiceId: fx.lspServiceId },
          { providerId: inv.providerId, lspServiceId: inv.lspServiceId }
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
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/services/obligation.service.test.ts
```

Esperado: PASS, 7 tests (2 viejos + 5 nuevos).

- [ ] **Step 5: Verificar tipos**

```bash
npm run typecheck
```

Esperado: 0 errores. **No commitear.**

---

## Task 3: Endpoints de sincronización y overview

**Files:**
- Create: `src/app/api/client/obligations/sync/route.ts`
- Create: `src/app/api/client/obligations/overview/route.ts`

Estas rutas no llevan test propio: el test que importa es
`src/app/api/routeAuthGuard.test.ts`, que escanea las rutas y falla si alguna queda sin guard.

- [ ] **Step 1: Crear el endpoint de sincronización**

Crear `src/app/api/client/obligations/sync/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { syncObligationsForClient } from "@/services/obligation.service";

/**
 * Sincroniza las obligaciones de todos los períodos activos del cliente.
 * La vista global lo llama al montar; es idempotente y set-based.
 */
export async function POST(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const result = await syncObligationsForClient(auth.session.clientId);
  return NextResponse.json({ ok: true, ...result });
}
```

- [ ] **Step 2: Crear el endpoint de overview**

Crear `src/app/api/client/obligations/overview/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function periodLabel(year: number, month: number): string {
  return `${MONTHS[month - 1] ?? month} ${year}`;
}

/**
 * Todo lo que la vista global de obligaciones necesita, en 4 queries.
 *
 * Los proveedores son de nivel cliente y viajan UNA vez al tope de la respuesta
 * (no repetidos por consorcio): el filtrado de "lo ya cargado" lo hace el cliente
 * con `availableTargets`.
 */
export async function GET(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const clientId = auth.session.clientId;
  const prisma = getPrismaClient();

  const consortiums = await prisma.consortium.findMany({
    where: { clientId },
    select: {
      id: true,
      canonicalName: true,
      bank: { select: { id: true, name: true, color: true } },
      periods: {
        where: { status: "ACTIVE" },
        select: { id: true, year: true, month: true },
        take: 1,
      },
      fixedExpenses: {
        select: {
          id: true, providerId: true, lspServiceId: true, description: true, active: true,
        },
      },
      lspServices: {
        select: { id: true, providerName: true, clientNumber: true, description: true, providerId: true },
      },
    },
    orderBy: { canonicalName: "asc" },
  });

  const activePeriodIds = consortiums
    .map((c) => c.periods[0]?.id)
    .filter((id): id is string => Boolean(id));

  const obligations = activePeriodIds.length
    ? await prisma.expenseObligation.findMany({
        where: { periodId: { in: activePeriodIds } },
        select: {
          id: true,
          status: true,
          fixedExpenseId: true,
          periodId: true,
          invoice: { select: { amount: true } },
        },
      })
    : [];

  const obligationByKey = new Map(
    obligations.map((o) => [`${o.periodId}:${o.fixedExpenseId}`, o])
  );

  const providers = await prisma.provider.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true, paymentAlias: true },
    orderBy: { canonicalName: "asc" },
  });

  // Mes mayoritario entre los períodos activos, para el título del documento.
  const freq = new Map<string, number>();
  for (const c of consortiums) {
    const p = c.periods[0];
    if (!p) continue;
    const key = `${p.year}-${p.month}`;
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  let majorityLabel: string | null = null;
  let best = 0;
  for (const [key, count] of freq) {
    if (count > best) {
      best = count;
      const [y, m] = key.split("-").map(Number);
      majorityLabel = periodLabel(y, m);
    }
  }

  return NextResponse.json({
    ok: true,
    majorityLabel,
    providers,
    consortiums: consortiums.map((c) => {
      const period = c.periods[0] ?? null;
      return {
        consortiumId: c.id,
        consortiumName: c.canonicalName,
        bankId: c.bank?.id ?? null,
        bankName: c.bank?.name ?? null,
        bankColor: c.bank?.color ?? null,
        periodId: period?.id ?? null,
        periodLabel: period ? periodLabel(period.year, period.month) : null,
        lspServices: c.lspServices,
        fixedExpenses: c.fixedExpenses.map((fx) => {
          const ob = period ? obligationByKey.get(`${period.id}:${fx.id}`) : undefined;
          return {
            id: fx.id,
            providerId: fx.providerId,
            lspServiceId: fx.lspServiceId,
            description: fx.description,
            active: fx.active,
            obligation: ob
              ? { id: ob.id, status: ob.status, amount: ob.invoice?.amount ?? null }
              : null,
          };
        }),
      };
    }),
  });
}
```

- [ ] **Step 3: Verificar el guard de rutas y los tipos**

```bash
npx vitest run src/app/api/routeAuthGuard.test.ts
```

Esperado: PASS — las dos rutas nuevas se detectan con `requireClientSession`.

```bash
npm run typecheck
```

Esperado: 0 errores.

> **Nota sobre `amount`:** en Prisma el importe de `Invoice` puede llegar como `Decimal`. Si el
> typecheck se queja al asignarlo a `number | null`, convertirlo explícitamente:
> `ob.invoice?.amount != null ? Number(ob.invoice.amount) : null`. **No commitear.**

---

## Task 4: El modelo del documento (lógica pura)

**Files:**
- Create: `src/app/admin/obligaciones/lib/sheetModel.ts`
- Test: `src/app/admin/obligaciones/lib/sheetModel.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/app/admin/obligaciones/lib/sheetModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSheets, filterSheets, type OverviewPayload } from "./sheetModel";

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

  it("toma el monto de la boleta vinculada y lo deja null si no llegó", () => {
    const rows = buildSheets(payload)[0].rows;
    expect(rows.find((r) => r.fixedExpenseId === "fx2")!.monto).toBe(118000);
    expect(rows.find((r) => r.fixedExpenseId === "fx1")!.monto).toBeNull();
  });

  it("resuelve el alias: del proveedor, y para un LSP el de su proveedor asociado", () => {
    const rows = buildSheets(payload)[0].rows;
    expect(rows.find((r) => r.fixedExpenseId === "fx1")!.aliasCbu).toBe("seguro.caja");
    expect(rows.find((r) => r.fixedExpenseId === "fx2")!.aliasCbu).toBe("edesur.pago");
    expect(rows.find((r) => r.fixedExpenseId === "fx3")!.aliasCbu).toBeNull();
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
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/obligaciones/lib/sheetModel.test.ts
```

Esperado: FAIL — `Failed to resolve import "./sheetModel"`.

- [ ] **Step 3: Escribir la implementación**

Crear `src/app/admin/obligaciones/lib/sheetModel.ts`:

```ts
/**
 * Modelo del documento "hoja de obligaciones", como datos puros.
 *
 * Es la ÚNICA fuente que consumen la pantalla y (en la Parte 2) el generador de
 * PDF: si un edificio deja de aparecer, deja de aparecer en los dos lados a la
 * vez. Sin React, sin fetch — se testea sin montar nada.
 */

export type ObligationStatus = "PENDING" | "RECEIVED" | "SKIPPED" | "NOT_RECEIVED";
/** `NO_PERIOD` = el edificio no tiene período activo, así que no hay obligación posible. */
export type SheetStatus = ObligationStatus | "NO_PERIOD";

export type OverviewFixedExpense = {
  id: string;
  providerId: string | null;
  lspServiceId: string | null;
  description: string | null;
  active: boolean;
  obligation: { id: string; status: ObligationStatus; amount: number | null } | null;
};

export type OverviewLspService = {
  id: string;
  providerName: string;
  clientNumber: string;
  description: string | null;
  providerId: string | null;
};

export type OverviewConsortium = {
  consortiumId: string;
  consortiumName: string;
  bankId: string | null;
  bankName: string | null;
  bankColor: string | null;
  periodId: string | null;
  periodLabel: string | null;
  lspServices: OverviewLspService[];
  fixedExpenses: OverviewFixedExpense[];
};

export type OverviewPayload = {
  majorityLabel: string | null;
  providers: Array<{ id: string; canonicalName: string; paymentAlias: string | null }>;
  consortiums: OverviewConsortium[];
};

export type SheetRow = {
  fixedExpenseId: string;
  obligationId: string | null;
  providerId: string | null;
  lspServiceId: string | null;
  /** Columna FACTURAS: número de cliente, sólo en filas LSP. */
  facturas: string | null;
  /** Columna PROVEEDORES Y SERVICIOS. */
  concepto: string;
  /** Columna MONTO: sale de la boleta vinculada; null mientras no llegó. */
  monto: number | null;
  /** Columna ALIAS CBU. */
  aliasCbu: string | null;
  status: SheetStatus;
  active: boolean;
};

export type SheetData = {
  consortiumId: string;
  consortiumName: string;
  bankId: string | null;
  bankName: string;
  bankColor: string | null;
  periodId: string | null;
  periodLabel: string | null;
  rows: SheetRow[];
};

/** Etiqueta del grupo de edificios sin banco asignado. Va último en el orden. */
export const NO_BANK_LABEL = "Sin banco";

function norm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // saca los acentos: "FUMIGACIÓN" matchea con "fumigacion"
    .toLowerCase()
    .trim();
}

export function buildSheets(payload: OverviewPayload): SheetData[] {
  const providerById = new Map(payload.providers.map((p) => [p.id, p]));

  const sheets = payload.consortiums.map((c) => {
    const lspById = new Map(c.lspServices.map((l) => [l.id, l]));

    const rows: SheetRow[] = c.fixedExpenses.map((fx) => {
      const lsp = fx.lspServiceId ? lspById.get(fx.lspServiceId) ?? null : null;
      const provider = fx.providerId ? providerById.get(fx.providerId) ?? null : null;
      // Para un LSP el alias de pago vive en el proveedor asociado, si lo tiene.
      const lspProvider = lsp?.providerId ? providerById.get(lsp.providerId) ?? null : null;

      const concepto = lsp
        ? `${lsp.providerName}${lsp.description ? ` — ${lsp.description}` : ""}`
        : provider?.canonicalName ?? fx.description ?? "—";

      return {
        fixedExpenseId: fx.id,
        obligationId: fx.obligation?.id ?? null,
        providerId: fx.providerId,
        lspServiceId: fx.lspServiceId,
        facturas: lsp?.clientNumber ?? null,
        concepto,
        monto: fx.obligation?.amount ?? null,
        aliasCbu: (lsp ? lspProvider?.paymentAlias : provider?.paymentAlias) ?? null,
        status: c.periodId ? fx.obligation?.status ?? "PENDING" : "NO_PERIOD",
        active: fx.active,
      };
    });

    // LSP primero (son los que llevan número de cliente), después el resto alfabético.
    rows.sort((a, b) => {
      const aLsp = a.lspServiceId ? 0 : 1;
      const bLsp = b.lspServiceId ? 0 : 1;
      if (aLsp !== bLsp) return aLsp - bLsp;
      return a.concepto.localeCompare(b.concepto, "es");
    });

    return {
      consortiumId: c.consortiumId,
      consortiumName: c.consortiumName,
      bankId: c.bankId,
      bankName: c.bankName ?? NO_BANK_LABEL,
      bankColor: c.bankColor,
      periodId: c.periodId,
      periodLabel: c.periodLabel,
      rows,
    };
  });

  // Banco alfabético con "Sin banco" al final; dentro, edificio alfabético.
  return sheets.sort((a, b) => {
    const aNo = a.bankId === null ? 1 : 0;
    const bNo = b.bankId === null ? 1 : 0;
    if (aNo !== bNo) return aNo - bNo;
    const byBank = a.bankName.localeCompare(b.bankName, "es");
    if (byBank !== 0) return byBank;
    return a.consortiumName.localeCompare(b.consortiumName, "es");
  });
}

/**
 * Búsqueda de la barra superior.
 *
 * Si matchea el edificio o el banco, la hoja se muestra entera; si sólo matchea
 * por concepto, se recorta a las filas que matchean (mismo criterio que la
 * búsqueda de la grilla de bancos).
 */
export function filterSheets(sheets: SheetData[], query: string): SheetData[] {
  const q = norm(query);
  if (!q) return sheets;

  const out: SheetData[] = [];
  for (const sheet of sheets) {
    if (norm(sheet.consortiumName).includes(q) || norm(sheet.bankName).includes(q)) {
      out.push(sheet);
      continue;
    }
    const rows = sheet.rows.filter((r) => norm(r.concepto).includes(q));
    if (rows.length > 0) out.push({ ...sheet, rows });
  }
  return out;
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/obligaciones/lib/sheetModel.test.ts
```

Esperado: PASS, 13 tests.

- [ ] **Step 5: Verificar tipos**

```bash
npm run typecheck
```

Esperado: 0 errores. **No commitear.**

---

## Task 5: Qué queda disponible para agregar (lógica pura)

**Files:**
- Create: `src/app/admin/obligaciones/lib/availableTargets.ts`
- Test: `src/app/admin/obligaciones/lib/availableTargets.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/app/admin/obligaciones/lib/availableTargets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { availableTargets } from "./availableTargets";
import type { OverviewConsortium } from "./sheetModel";

const providers = [
  { id: "p1", canonicalName: "SEGURO LA CAJA", paymentAlias: null },
  { id: "p2", canonicalName: "TECNOPAS ASC.", paymentAlias: null },
  { id: "p3", canonicalName: "N.G. FUMIGACION", paymentAlias: null },
];

const consortium: OverviewConsortium = {
  consortiumId: "c1",
  consortiumName: "FRANKLIN 25",
  bankId: null, bankName: null, bankColor: null,
  periodId: "per1", periodLabel: "julio 2026",
  lspServices: [
    { id: "l1", providerName: "EDESUR", clientNumber: "4804882", description: null, providerId: "p9" },
    { id: "l2", providerName: "AYSA", clientNumber: "66757", description: null, providerId: null },
  ],
  fixedExpenses: [
    { id: "fx1", providerId: "p1", lspServiceId: null, description: null, active: true, obligation: null },
    { id: "fx2", providerId: null, lspServiceId: "l1", description: null, active: true, obligation: null },
  ],
};

describe("availableTargets", () => {
  it("saca lo ya cargado de las dos listas", () => {
    const out = availableTargets(consortium, providers, "");
    expect(out.lsp.map((o) => o.id)).toEqual(["l2"]);
    expect(out.providers.map((o) => o.id)).toEqual(["N.G. FUMIGACION", "TECNOPAS ASC."].map(
      (name) => providers.find((p) => p.canonicalName === name)!.id
    ));
  });

  it("un gasto fijo desactivado también ocupa el lugar (no se puede duplicar)", () => {
    const withInactive: OverviewConsortium = {
      ...consortium,
      fixedExpenses: [
        { id: "fx1", providerId: "p1", lspServiceId: null, description: null, active: false, obligation: null },
      ],
    };
    const out = availableTargets(withInactive, providers, "");
    expect(out.providers.some((o) => o.id === "p1")).toBe(false);
  });

  it("arma la etiqueta del LSP con su número de cliente", () => {
    const out = availableTargets(consortium, providers, "");
    expect(out.lsp[0].label).toBe("AYSA (66757)");
  });

  it("filtra por búsqueda en las dos listas", () => {
    const out = availableTargets(consortium, providers, "fumi");
    expect(out.providers.map((o) => o.label)).toEqual(["N.G. FUMIGACION"]);
    expect(out.lsp).toEqual([]);
  });

  it("la búsqueda ignora acentos y mayúsculas", () => {
    const out = availableTargets(consortium, [{ id: "p8", canonicalName: "FUMIGACIÓN SUR", paymentAlias: null }], "fumigacion");
    expect(out.providers.map((o) => o.id)).toEqual(["p8"]);
  });

  it("devuelve listas vacías cuando ya está todo cargado", () => {
    const full: OverviewConsortium = {
      ...consortium,
      fixedExpenses: [
        { id: "a", providerId: "p1", lspServiceId: null, description: null, active: true, obligation: null },
        { id: "b", providerId: "p2", lspServiceId: null, description: null, active: true, obligation: null },
        { id: "c", providerId: "p3", lspServiceId: null, description: null, active: true, obligation: null },
        { id: "d", providerId: null, lspServiceId: "l1", description: null, active: true, obligation: null },
        { id: "e", providerId: null, lspServiceId: "l2", description: null, active: true, obligation: null },
      ],
    };
    const out = availableTargets(full, providers, "");
    expect(out.lsp).toEqual([]);
    expect(out.providers).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/obligaciones/lib/availableTargets.test.ts
```

Esperado: FAIL — `Failed to resolve import "./availableTargets"`.

- [ ] **Step 3: Escribir la implementación**

Crear `src/app/admin/obligaciones/lib/availableTargets.ts`:

```ts
import type { OverviewConsortium, OverviewPayload } from "./sheetModel";

export type TargetOption = {
  kind: "provider" | "lsp";
  id: string;
  label: string;
};

export type AvailableTargets = {
  lsp: TargetOption[];
  providers: TargetOption[];
};

function norm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // saca los acentos: "FUMIGACIÓN" matchea con "fumigacion"
    .toLowerCase()
    .trim();
}

/**
 * Qué puede agregarse todavía a este consorcio.
 *
 * Saca de las listas lo que ya está cargado — **incluidos los gastos fijos
 * desactivados**, porque el índice único de la base es por objetivo y no mira
 * `active`: ofrecerlos llevaría a un 409. Para volver a usar uno desactivado,
 * el camino es reactivarlo desde la fila.
 */
export function availableTargets(
  consortium: OverviewConsortium,
  providers: OverviewPayload["providers"],
  query: string
): AvailableTargets {
  const usedProviderIds = new Set(
    consortium.fixedExpenses.map((fx) => fx.providerId).filter((id): id is string => Boolean(id))
  );
  const usedLspIds = new Set(
    consortium.fixedExpenses.map((fx) => fx.lspServiceId).filter((id): id is string => Boolean(id))
  );

  const q = norm(query);
  const matches = (label: string) => !q || norm(label).includes(q);

  const lsp: TargetOption[] = consortium.lspServices
    .filter((l) => !usedLspIds.has(l.id))
    .map((l) => ({ kind: "lsp" as const, id: l.id, label: `${l.providerName} (${l.clientNumber})` }))
    .filter((o) => matches(o.label))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));

  const provs: TargetOption[] = providers
    .filter((p) => !usedProviderIds.has(p.id))
    .map((p) => ({ kind: "provider" as const, id: p.id, label: p.canonicalName }))
    .filter((o) => matches(o.label))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));

  return { lsp, providers: provs };
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/obligaciones/lib/availableTargets.test.ts
```

Esperado: PASS, 6 tests.

- [ ] **Step 5: Verificar tipos**

```bash
npm run typecheck
```

Esperado: 0 errores. **No commitear.**

---

## Task 6: Alta múltiple en el endpoint de gastos fijos

**Files:**
- Modify: `src/app/api/client/consortiums/[id]/fixed-expenses/route.ts`

El POST hoy crea **uno**. Se extiende para aceptar `{ items: [...] }` sin romper la forma vieja, y
tras crear genera las obligaciones del período activo para que las filas aparezcan en el acto.

- [ ] **Step 1: Reemplazar el schema y el handler POST**

En `src/app/api/client/consortiums/[id]/fixed-expenses/route.ts`, reemplazar el `createSchema` y el
`export async function POST` completos por:

```ts
const itemSchema = z.object({
  providerId: z.string().optional().nullable(),
  lspServiceId: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

/** Acepta la forma vieja (un objeto) y la nueva (`{ items: [...] }`). */
const createSchema = z.union([
  itemSchema,
  z.object({ items: z.array(itemSchema).min(1).max(50) }),
]);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
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

    const items = "items" in parsed.data ? parsed.data.items : [parsed.data];
    const repo = new FixedExpenseRepository();

    const created: unknown[] = [];
    const skipped: Array<{ providerId: string | null; lspServiceId: string | null; reason: string }> = [];

    for (const item of items) {
      try {
        created.push(
          await repo.create({
            clientId,
            consortiumId,
            providerId: item.providerId ?? null,
            lspServiceId: item.lspServiceId ?? null,
            description: item.description ?? null,
          })
        );
      } catch (err) {
        // Un objetivo ya cargado (409) no aborta el resto de la selección.
        if (err instanceof FixedExpenseError) {
          skipped.push({
            providerId: item.providerId ?? null,
            lspServiceId: item.lspServiceId ?? null,
            reason: err.message,
          });
          continue;
        }
        throw err;
      }
    }

    // Que las filas nuevas aparezcan en el período abierto sin esperar otra sincronización.
    if (created.length > 0) {
      const activePeriod = await prisma.period.findFirst({
        where: { consortiumId, status: "ACTIVE" },
        select: { id: true },
      });
      if (activePeriod) await generateObligationsForPeriod(activePeriod.id);
    }

    // Forma vieja (un solo objeto): se conserva la respuesta de siempre.
    if (!("items" in parsed.data)) {
      if (skipped.length > 0) {
        return NextResponse.json({ ok: false, error: skipped[0].reason }, { status: 409 });
      }
      return NextResponse.json({ ok: true, fixedExpense: created[0] }, { status: 201 });
    }

    return NextResponse.json({ ok: true, created: created.length, skipped }, { status: 201 });
  } catch (err) {
    if (err instanceof FixedExpenseError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Error interno" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Agregar el import que falta**

Arriba del archivo, junto a los imports existentes:

```ts
import { generateObligationsForPeriod } from "@/services/obligation.service";
```

- [ ] **Step 3: Verificar**

```bash
npm run typecheck
```

```bash
npx vitest run src/app/api/routeAuthGuard.test.ts
```

Esperado: 0 errores y PASS. **No commitear.**

---

## Task 7: El hook de la vista

**Files:**
- Create: `src/app/admin/obligaciones/hooks/useObligationsOverview.ts`
- Test: `src/app/admin/obligaciones/hooks/useObligationsOverview.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/app/admin/obligaciones/hooks/useObligationsOverview.test.tsx`:

```tsx
import { renderHook, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useObligationsOverview } from "./useObligationsOverview";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({
  useAuthGuard: () => ({ guardedFetch }),
}));

const payload = {
  ok: true,
  majorityLabel: "julio 2026",
  providers: [{ id: "p1", canonicalName: "SEGURO", paymentAlias: null }],
  consortiums: [
    {
      consortiumId: "c1",
      consortiumName: "FRANKLIN 25",
      bankId: "b1", bankName: "Santander", bankColor: "red",
      periodId: "per1", periodLabel: "julio 2026",
      lspServices: [],
      fixedExpenses: [
        { id: "fx1", providerId: "p1", lspServiceId: null, description: null, active: true,
          obligation: { id: "ob1", status: "PENDING", amount: null } },
      ],
    },
  ],
};

function jsonOk(body: unknown) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  guardedFetch.mockReset();
  guardedFetch.mockImplementation(async (url: string) => {
    if (url.includes("/obligations/sync")) return jsonOk({ ok: true, created: 2, linked: 0, periods: 1 });
    if (url.includes("/obligations/overview")) return jsonOk(payload);
    return jsonOk({ ok: true });
  });
});

describe("useObligationsOverview", () => {
  it("sincroniza antes de cargar el overview", async () => {
    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const urls = guardedFetch.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain("/api/client/obligations/sync");
    expect(urls[1]).toContain("/api/client/obligations/overview");
    expect(result.current.sheets).toHaveLength(1);
    expect(result.current.sheets[0].consortiumName).toBe("FRANKLIN 25");
  });

  it("si la sincronización falla, igual carga y avisa", async () => {
    guardedFetch.mockImplementation(async (url: string) => {
      if (url.includes("/obligations/sync")) throw new Error("red caída");
      if (url.includes("/obligations/overview")) return jsonOk(payload);
      return jsonOk({ ok: true });
    });

    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.syncWarning).toMatch(/no se pudo sincronizar/i);
    expect(result.current.sheets).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("si el overview falla, expone el error", async () => {
    guardedFetch.mockImplementation(async (url: string) => {
      if (url.includes("/obligations/sync")) return jsonOk({ ok: true, created: 0, linked: 0, periods: 0 });
      return { ok: false, json: async () => ({ ok: false, error: "explotó" }) };
    });

    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe("explotó");
    expect(result.current.sheets).toEqual([]);
  });

  it("addFixedExpenses postea los items y recarga", async () => {
    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    guardedFetch.mockClear();

    await act(async () => {
      await result.current.addFixedExpenses("c1", [
        { kind: "provider", id: "p2", label: "TECNOPAS" },
        { kind: "lsp", id: "l1", label: "AYSA (66757)" },
      ]);
    });

    const post = guardedFetch.mock.calls.find((c) => (c[0] as string).includes("/fixed-expenses"))!;
    expect(post[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({
      items: [{ providerId: "p2" }, { lspServiceId: "l1" }],
    });
    expect(guardedFetch.mock.calls.some((c) => (c[0] as string).includes("/overview"))).toBe(true);
  });

  it("setObligationStatus propaga el mensaje de error del servidor", async () => {
    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    guardedFetch.mockImplementation(async () => ({
      ok: false,
      json: async () => ({ ok: false, error: "La obligación ya tiene boleta recibida." }),
    }));

    await act(async () => {
      await result.current.setObligationStatus("ob1", "SKIPPED");
    });

    expect(result.current.error).toBe("La obligación ya tiene boleta recibida.");
  });

  it("deleteFixedExpense llama al DELETE del gasto fijo", async () => {
    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    guardedFetch.mockClear();

    await act(async () => {
      await result.current.deleteFixedExpense("c1", "fx1");
    });

    const del = guardedFetch.mock.calls.find((c) => (c[1] as RequestInit)?.method === "DELETE")!;
    expect(del[0]).toBe("/api/client/consortiums/c1/fixed-expenses/fx1");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/obligaciones/hooks/useObligationsOverview.test.tsx
```

Esperado: FAIL — `Failed to resolve import "./useObligationsOverview"`.

- [ ] **Step 3: Escribir la implementación**

Crear `src/app/admin/obligaciones/hooks/useObligationsOverview.ts`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { buildSheets, type OverviewPayload, type SheetData, type ObligationStatus } from "../lib/sheetModel";
import type { TargetOption } from "../lib/availableTargets";

/**
 * Dueño de los datos de la vista global de obligaciones.
 *
 * Al montar sincroniza (idempotente y set-based) y después carga el overview. Si
 * la sincronización falla NO bloquea la pantalla: carga igual y expone un aviso,
 * porque una lista vieja sigue siendo más útil que una pantalla en blanco.
 */
export function useObligationsOverview() {
  const { guardedFetch } = useAuthGuard();

  const [payload, setPayload] = useState<OverviewPayload | null>(null);
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      const res = await guardedFetch("/api/client/obligations/overview", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPayload(data as OverviewPayload);
      setSheets(buildSheets(data as OverviewPayload));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la vista");
      setSheets([]);
    }
  }, [guardedFetch]);

  const sync = useCallback(async () => {
    try {
      const res = await guardedFetch("/api/client/obligations/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSyncWarning(null);
    } catch {
      setSyncWarning("No se pudo sincronizar: la lista puede estar incompleta.");
    }
  }, [guardedFetch]);

  const reload = useCallback(async () => {
    setIsLoading(true);
    await sync();
    await loadOverview();
    setIsLoading(false);
  }, [sync, loadOverview]);

  useEffect(() => { void reload(); }, [reload]);

  const addFixedExpenses = useCallback(
    async (consortiumId: string, targets: TargetOption[]) => {
      if (targets.length === 0) return;
      try {
        const items = targets.map((t) =>
          t.kind === "provider" ? { providerId: t.id } : { lspServiceId: t.id }
        );
        const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/fixed-expenses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudieron agregar los gastos fijos");
      }
      await loadOverview();
    },
    [guardedFetch, loadOverview]
  );

  const toggleFixedExpense = useCallback(
    async (consortiumId: string, fixedExpenseId: string, active: boolean) => {
      try {
        const res = await guardedFetch(
          `/api/client/consortiums/${consortiumId}/fixed-expenses/${fixedExpenseId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ active }),
          }
        );
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo actualizar el gasto fijo");
      }
      await loadOverview();
    },
    [guardedFetch, loadOverview]
  );

  const deleteFixedExpense = useCallback(
    async (consortiumId: string, fixedExpenseId: string) => {
      try {
        const res = await guardedFetch(
          `/api/client/consortiums/${consortiumId}/fixed-expenses/${fixedExpenseId}`,
          { method: "DELETE" }
        );
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo eliminar el gasto fijo");
      }
      await loadOverview();
    },
    [guardedFetch, loadOverview]
  );

  const setObligationStatus = useCallback(
    async (obligationId: string, status: Extract<ObligationStatus, "PENDING" | "SKIPPED">) => {
      try {
        const res = await guardedFetch(`/api/client/obligations/${obligationId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo cambiar el estado");
        return;
      }
      await loadOverview();
    },
    [guardedFetch, loadOverview]
  );

  return {
    payload,
    sheets,
    majorityLabel: payload?.majorityLabel ?? null,
    isLoading,
    error,
    syncWarning,
    reload,
    addFixedExpenses,
    toggleFixedExpense,
    deleteFixedExpense,
    setObligationStatus,
  };
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/obligaciones/hooks/useObligationsOverview.test.tsx
```

Esperado: PASS, 6 tests.

- [ ] **Step 5: Verificar tipos y lint**

```bash
npm run typecheck
```

```bash
npm run lint
```

Esperado: 0 errores en ambos. **No commitear.**

---

## Task 8: Modal de alta múltiple

**Files:**
- Create: `src/app/admin/obligaciones/components/AddFixedExpenseModal.tsx`
- Test: `src/app/admin/obligaciones/components/AddFixedExpenseModal.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/app/admin/obligaciones/components/AddFixedExpenseModal.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddFixedExpenseModal } from "./AddFixedExpenseModal";
import type { OverviewConsortium } from "../lib/sheetModel";

const consortium: OverviewConsortium = {
  consortiumId: "c1",
  consortiumName: "FRANKLIN 25",
  bankId: null, bankName: null, bankColor: null,
  periodId: "per1", periodLabel: "julio 2026",
  lspServices: [
    { id: "l1", providerName: "AYSA", clientNumber: "66757", description: null, providerId: null },
  ],
  fixedExpenses: [],
};

const providers = [
  { id: "p1", canonicalName: "SEGURO LA CAJA", paymentAlias: null },
  { id: "p2", canonicalName: "TECNOPAS ASC.", paymentAlias: null },
];

function renderModal(overrides: Partial<React.ComponentProps<typeof AddFixedExpenseModal>> = {}) {
  const props = {
    consortium,
    providers,
    onAdd: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<AddFixedExpenseModal {...props} />);
  return props;
}

describe("AddFixedExpenseModal", () => {
  it("lista servicios y proveedores disponibles", () => {
    renderModal();
    expect(screen.getByText("FRANKLIN 25")).toBeInTheDocument();
    expect(screen.getByLabelText("AYSA (66757)")).toBeInTheDocument();
    expect(screen.getByLabelText("SEGURO LA CAJA")).toBeInTheDocument();
  });

  it("el botón arranca deshabilitado y cuenta la selección", async () => {
    renderModal();
    expect(screen.getByRole("button", { name: /Agregar/ })).toBeDisabled();

    await userEvent.click(screen.getByLabelText("SEGURO LA CAJA"));
    await userEvent.click(screen.getByLabelText("AYSA (66757)"));

    expect(screen.getByRole("button", { name: "Agregar (2)" })).toBeEnabled();
  });

  it("manda la selección y cierra", async () => {
    const props = renderModal();
    await userEvent.click(screen.getByLabelText("TECNOPAS ASC."));
    await userEvent.click(screen.getByRole("button", { name: "Agregar (1)" }));

    expect(props.onAdd).toHaveBeenCalledWith("c1", [
      { kind: "provider", id: "p2", label: "TECNOPAS ASC." },
    ]);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("el buscador recorta las opciones", async () => {
    renderModal();
    await userEvent.type(screen.getByPlaceholderText(/Buscar/), "aysa");
    expect(screen.getByLabelText("AYSA (66757)")).toBeInTheDocument();
    expect(screen.queryByLabelText("SEGURO LA CAJA")).not.toBeInTheDocument();
  });

  it("sin nada disponible avisa", () => {
    renderModal({
      consortium: {
        ...consortium,
        fixedExpenses: [
          { id: "a", providerId: "p1", lspServiceId: null, description: null, active: true, obligation: null },
          { id: "b", providerId: "p2", lspServiceId: null, description: null, active: true, obligation: null },
          { id: "c", providerId: null, lspServiceId: "l1", description: null, active: true, obligation: null },
        ],
      },
    });
    expect(screen.getByText(/Ya están cargados todos/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/obligaciones/components/AddFixedExpenseModal.test.tsx
```

Esperado: FAIL — `Failed to resolve import "./AddFixedExpenseModal"`.

- [ ] **Step 3: Escribir la implementación**

Crear `src/app/admin/obligaciones/components/AddFixedExpenseModal.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import styles from "../page.module.css";
import { availableTargets, type TargetOption } from "../lib/availableTargets";
import type { OverviewConsortium, OverviewPayload } from "../lib/sheetModel";

type Props = {
  consortium: OverviewConsortium;
  providers: OverviewPayload["providers"];
  onAdd: (consortiumId: string, targets: TargetOption[]) => Promise<void>;
  onClose: () => void;
};

/**
 * Alta múltiple de gastos fijos para un edificio.
 *
 * Lo ya cargado no aparece en la lista: es la primera defensa contra el
 * duplicado (la segunda es el índice único de la base).
 */
export function AddFixedExpenseModal({ consortium, providers, onAdd, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Map<string, TargetOption>>(new Map());
  const [saving, setSaving] = useState(false);

  const options = useMemo(
    () => availableTargets(consortium, providers, query),
    [consortium, providers, query]
  );
  const nothingLeft = options.lsp.length === 0 && options.providers.length === 0 && query === "";

  const toggle = (option: TargetOption) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const key = `${option.kind}:${option.id}`;
      if (next.has(key)) next.delete(key);
      else next.set(key, option);
      return next;
    });
  };

  const submit = async () => {
    if (selected.size === 0 || saving) return;
    setSaving(true);
    try {
      await onAdd(consortium.consortiumId, [...selected.values()]);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const renderOption = (option: TargetOption) => {
    const key = `${option.kind}:${option.id}`;
    return (
      <li key={key} className={styles.targetItem}>
        <label className={styles.targetLabel}>
          <input
            type="checkbox"
            checked={selected.has(key)}
            onChange={() => toggle(option)}
          />
          <span>{option.label}</span>
        </label>
      </li>
    );
  };

  return (
    <div className={styles.modalOverlay} role="dialog" aria-modal="true">
      <div className={styles.modalCard}>
        <h2 className={styles.modalTitle}>Agregar gastos fijos</h2>
        <p className={styles.modalSubtitle}>{consortium.consortiumName}</p>

        {nothingLeft ? (
          <p className={styles.emptyNote}>
            Ya están cargados todos los proveedores y servicios disponibles para este edificio.
          </p>
        ) : (
          <>
            <input
              className={styles.searchInput}
              placeholder="Buscar proveedor o servicio..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className={styles.targetList}>
              {options.lsp.length > 0 && (
                <>
                  <h3 className={styles.targetGroupTitle}>Servicios (LSP)</h3>
                  <ul className={styles.targetGroup}>{options.lsp.map(renderOption)}</ul>
                </>
              )}
              {options.providers.length > 0 && (
                <>
                  <h3 className={styles.targetGroupTitle}>Proveedores</h3>
                  <ul className={styles.targetGroup}>{options.providers.map(renderOption)}</ul>
                </>
              )}
              {options.lsp.length === 0 && options.providers.length === 0 && (
                <p className={styles.emptyNote}>Nada coincide con la búsqueda.</p>
              )}
            </div>
          </>
        )}

        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={selected.size === 0 || saving}
            onClick={() => void submit()}
          >
            {saving ? "Agregando..." : `Agregar (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Requiere que `page.module.css` exista (Task 10 lo crea con todas las clases). Para no bloquear, crear
ahora el archivo con un comentario placeholder si no existe:

```bash
node -e "const fs=require('fs');const p='src/app/admin/obligaciones/page.module.css';if(!fs.existsSync(p))fs.writeFileSync(p,'/* estilos en Task 10 */\n');"
```

```bash
npx vitest run src/app/admin/obligaciones/components/AddFixedExpenseModal.test.tsx
```

Esperado: PASS, 5 tests. (En jsdom, un CSS Module sin las clases definidas devuelve `undefined` para
cada clase: el render funciona igual y los tests no dependen de estilos.)

- [ ] **Step 5: Verificar tipos**

```bash
npm run typecheck
```

Esperado: 0 errores. **No commitear.**

---

## Task 9: La tarjeta-hoja del edificio

**Files:**
- Create: `src/app/admin/obligaciones/components/SheetCard.tsx`
- Test: `src/app/admin/obligaciones/components/SheetCard.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/app/admin/obligaciones/components/SheetCard.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SheetCard } from "./SheetCard";
import type { SheetData } from "../lib/sheetModel";

const sheet: SheetData = {
  consortiumId: "c1",
  consortiumName: "FRANKLIN 25",
  bankId: "b1",
  bankName: "Santander",
  bankColor: "red",
  periodId: "per1",
  periodLabel: "julio 2026",
  rows: [
    { fixedExpenseId: "fx1", obligationId: "ob1", providerId: null, lspServiceId: "l1",
      facturas: "4804882", concepto: "EDESUR", monto: 118000, aliasCbu: "edesur.pago",
      status: "RECEIVED", active: true },
    { fixedExpenseId: "fx2", obligationId: "ob2", providerId: "p1", lspServiceId: null,
      facturas: null, concepto: "SEGURO LA CAJA", monto: null, aliasCbu: null,
      status: "PENDING", active: true },
    { fixedExpenseId: "fx3", obligationId: "ob3", providerId: "p2", lspServiceId: null,
      facturas: null, concepto: "N.G. FUMIGACION", monto: null, aliasCbu: null,
      status: "SKIPPED", active: true },
  ],
};

function renderCard(overrides: Partial<React.ComponentProps<typeof SheetCard>> = {}) {
  const props = {
    sheet,
    onAdd: vi.fn(),
    onToggle: vi.fn(),
    onDelete: vi.fn(),
    onSetStatus: vi.fn(),
    ...overrides,
  };
  render(<SheetCard {...props} />);
  return props;
}

describe("SheetCard", () => {
  it("muestra edificio, banco y período", () => {
    renderCard();
    expect(screen.getByText("FRANKLIN 25")).toBeInTheDocument();
    expect(screen.getByText(/Santander/)).toBeInTheDocument();
    expect(screen.getByText(/julio 2026/)).toBeInTheDocument();
  });

  it("dibuja las seis columnas de la planilla", () => {
    renderCard();
    for (const header of ["FACTURAS", "PROVEEDORES Y SERVICIOS", "MONTO", "ALIAS CBU", "TÉCNICO O GESTOR", "TEL. CONTACTO"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
  });

  it("muestra el monto formateado sólo cuando la boleta llegó", () => {
    renderCard();
    expect(screen.getByText(/118\.000/)).toBeInTheDocument();
    const seguroRow = screen.getByText("SEGURO LA CAJA").closest("tr")!;
    expect(seguroRow.textContent).not.toMatch(/\$/);
  });

  it("una fila omitida ofrece Reactivar y una pendiente ofrece Omitir", async () => {
    const props = renderCard();
    const pendiente = screen.getByText("SEGURO LA CAJA").closest("tr")!;
    const omitida = screen.getByText("N.G. FUMIGACION").closest("tr")!;

    await userEvent.click(within(pendiente).getByRole("button", { name: "Omitir" }));
    expect(props.onSetStatus).toHaveBeenCalledWith("ob2", "SKIPPED");

    expect(within(omitida).getByRole("button", { name: "Reactivar" })).toBeInTheDocument();
  });

  it("una fila con boleta recibida no ofrece Omitir", () => {
    renderCard();
    const recibida = screen.getByText("EDESUR").closest("tr")!;
    expect(within(recibida).queryByRole("button", { name: "Omitir" })).not.toBeInTheDocument();
  });

  it("el botón + dispara onAdd con el consorcio", async () => {
    const props = renderCard();
    await userEvent.click(screen.getByRole("button", { name: /Agregar gasto fijo/ }));
    expect(props.onAdd).toHaveBeenCalledWith("c1");
  });

  it("eliminar pide confirmación antes de avisar", async () => {
    const props = renderCard();
    const fila = screen.getByText("SEGURO LA CAJA").closest("tr")!;

    await userEvent.click(within(fila).getByRole("button", { name: "Eliminar" }));
    expect(props.onDelete).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Sí, eliminar/ }));
    expect(props.onDelete).toHaveBeenCalledWith("c1", "fx2");
  });

  it("un edificio sin gastos fijos avisa y no dibuja tabla", () => {
    renderCard({ sheet: { ...sheet, rows: [] } });
    expect(screen.getByText(/sin gastos fijos cargados/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("un edificio sin período activo lo advierte", () => {
    renderCard({ sheet: { ...sheet, periodId: null, periodLabel: null } });
    expect(screen.getByText(/sin período abierto/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/obligaciones/components/SheetCard.test.tsx
```

Esperado: FAIL — `Failed to resolve import "./SheetCard"`.

- [ ] **Step 3: Escribir la implementación**

Crear `src/app/admin/obligaciones/components/SheetCard.tsx`:

```tsx
"use client";

import { useState } from "react";
import styles from "../page.module.css";
import type { SheetData, SheetRow } from "../lib/sheetModel";

type Props = {
  sheet: SheetData;
  onAdd: (consortiumId: string) => void;
  onToggle: (consortiumId: string, fixedExpenseId: string, active: boolean) => void;
  onDelete: (consortiumId: string, fixedExpenseId: string) => void;
  onSetStatus: (obligationId: string, status: "PENDING" | "SKIPPED") => void;
};

const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

/**
 * La hoja de un edificio: en pantalla se ve como va a salir impresa, más las
 * acciones de fila (que la hoja de estilos de impresión esconde).
 *
 * Muestra TODO — incluidas las omitidas y los gastos desactivados, en gris —
 * porque es la vista de control. El filtrado para el papel es de la Parte 2.
 */
export function SheetCard({ sheet, onAdd, onToggle, onDelete, onSetStatus }: Props) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const rowClass = (row: SheetRow) => {
    if (!row.active) return styles.rowInactive;
    if (row.status === "SKIPPED") return styles.rowSkipped;
    return "";
  };

  return (
    <section className={styles.sheetCard} data-bank-color={sheet.bankColor ?? "slate"}>
      <header className={styles.sheetHeader}>
        <div>
          <span className={styles.sheetBank}>{sheet.bankName}</span>
          <h2 className={styles.sheetTitle}>{sheet.consortiumName}</h2>
        </div>
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

      {sheet.rows.length === 0 ? (
        <p className={styles.emptyNote}>
          Este edificio está sin gastos fijos cargados: no se va a imprimir.
        </p>
      ) : (
        <table className={styles.sheetTable}>
          <thead>
            <tr>
              <th>FACTURAS</th>
              <th>PROVEEDORES Y SERVICIOS</th>
              <th>MONTO</th>
              <th>ALIAS CBU</th>
              <th>TÉCNICO O GESTOR</th>
              <th>TEL. CONTACTO</th>
              <th className={styles.actionsHeader} aria-label="Acciones" />
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row) => (
              <tr key={row.fixedExpenseId} className={rowClass(row)}>
                <td>{row.facturas ?? ""}</td>
                <td>{row.concepto}</td>
                <td>{row.monto != null ? money.format(row.monto) : ""}</td>
                <td>{row.aliasCbu ?? ""}</td>
                <td />
                <td />
                <td className={styles.rowActions}>
                  {row.obligationId && row.status === "SKIPPED" && (
                    <button type="button" className={styles.linkBtn}
                      onClick={() => onSetStatus(row.obligationId!, "PENDING")}>
                      Reactivar
                    </button>
                  )}
                  {row.obligationId && row.status === "PENDING" && (
                    <button type="button" className={styles.linkBtn}
                      onClick={() => onSetStatus(row.obligationId!, "SKIPPED")}>
                      Omitir
                    </button>
                  )}
                  <button type="button" className={styles.linkBtn}
                    onClick={() => onToggle(sheet.consortiumId, row.fixedExpenseId, !row.active)}>
                    {row.active ? "Desactivar" : "Activar"}
                  </button>
                  <button type="button" className={styles.dangerBtn}
                    onClick={() => setConfirmDeleteId(row.fixedExpenseId)}>
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirmDeleteId && (
        <div className={styles.confirmBox}>
          <p>
            Eliminar el gasto fijo borra también su historial de obligaciones en todos los períodos,
            incluidos los cerrados. Si sólo querés que deje de aparecer de acá en adelante, usá
            <strong> Desactivar</strong>.
          </p>
          <div className={styles.confirmActions}>
            <button type="button" className={styles.ghostBtn} onClick={() => setConfirmDeleteId(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className={styles.dangerBtn}
              onClick={() => {
                onDelete(sheet.consortiumId, confirmDeleteId);
                setConfirmDeleteId(null);
              }}
            >
              Sí, eliminar
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/obligaciones/components/SheetCard.test.tsx
```

Esperado: PASS, 9 tests.

- [ ] **Step 5: Verificar tipos y lint**

```bash
npm run typecheck
```

```bash
npm run lint
```

Esperado: 0 errores. **No commitear.**

---

## Task 10: La página y sus estilos

**Files:**
- Create: `src/app/admin/obligaciones/page.tsx`
- Create/replace: `src/app/admin/obligaciones/page.module.css`

- [ ] **Step 1: Escribir la página**

Crear `src/app/admin/obligaciones/page.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import styles from "./page.module.css";
import { useObligationsOverview } from "./hooks/useObligationsOverview";
import { SheetCard } from "./components/SheetCard";
import { AddFixedExpenseModal } from "./components/AddFixedExpenseModal";
import { filterSheets, type SheetData } from "./lib/sheetModel";

/** Agrupa hojas YA ordenadas (banco, después edificio) en bloques por banco. */
function groupSheetsByBank(sheets: SheetData[]): Array<{ bankName: string; sheets: SheetData[] }> {
  const groups: Array<{ bankName: string; sheets: SheetData[] }> = [];
  for (const sheet of sheets) {
    const last = groups[groups.length - 1];
    if (last && last.bankName === sheet.bankName) last.sheets.push(sheet);
    else groups.push({ bankName: sheet.bankName, sheets: [sheet] });
  }
  return groups;
}

export default function ObligacionesPage() {
  const {
    payload, sheets, majorityLabel, isLoading, error, syncWarning, reload,
    addFixedExpenses, toggleFixedExpense, deleteFixedExpense, setObligationStatus,
  } = useObligationsOverview();

  const [query, setQuery] = useState("");
  const [addingFor, setAddingFor] = useState<string | null>(null);

  const visible = useMemo(() => filterSheets(sheets, query), [sheets, query]);
  const groups = useMemo(() => groupSheetsByBank(visible), [visible]);

  const totals = useMemo(() => {
    const withRows = sheets.filter((s) => s.rows.length > 0);
    return {
      edificios: withRows.length,
      gastos: sheets.reduce((acc, s) => acc + s.rows.length, 0),
      vacios: sheets.length - withRows.length,
    };
  }, [sheets]);

  const consortiumToAdd = payload?.consortiums.find((c) => c.consortiumId === addingFor) ?? null;

  return (
    <div className={styles.page}>
      <header className={styles.toolbar}>
        <div>
          <h1 className={styles.pageTitle}>Obligaciones del período</h1>
          {majorityLabel && <p className={styles.pageSubtitle}>{majorityLabel}</p>}
        </div>

        <input
          className={styles.searchInput}
          placeholder="Buscar edificio, banco o servicio..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className={styles.toolbarRight}>
          <span className={styles.counters}>
            {totals.edificios} edificios · {totals.gastos} gastos fijos
            {totals.vacios > 0 && ` · ${totals.vacios} sin cargar`}
          </span>
          <Link href="/admin/consortiums" className={styles.ghostBtn}>
            Volver
          </Link>
        </div>
      </header>

      {syncWarning && (
        <div className={styles.warning}>
          {syncWarning}{" "}
          <button type="button" className={styles.linkBtn} onClick={() => void reload()}>
            Reintentar
          </button>
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}

      {isLoading ? (
        <p className={styles.loading}>Sincronizando y cargando...</p>
      ) : groups.length === 0 ? (
        <p className={styles.emptyNote}>No hay edificios que coincidan con la búsqueda.</p>
      ) : (
        groups.map((group) => (
          <section key={group.bankName} className={styles.bankGroup}>
            <h2 className={styles.bankTitle}>{group.bankName}</h2>
            {group.sheets.map((sheet) => (
              <SheetCard
                key={sheet.consortiumId}
                sheet={sheet}
                onAdd={setAddingFor}
                onToggle={(cid, fxId, active) => void toggleFixedExpense(cid, fxId, active)}
                onDelete={(cid, fxId) => void deleteFixedExpense(cid, fxId)}
                onSetStatus={(obId, status) => void setObligationStatus(obId, status)}
              />
            ))}
          </section>
        ))
      )}

      {consortiumToAdd && payload && (
        <AddFixedExpenseModal
          consortium={consortiumToAdd}
          providers={payload.providers}
          onAdd={addFixedExpenses}
          onClose={() => setAddingFor(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Escribir los estilos**

Reemplazar el contenido de `src/app/admin/obligaciones/page.module.css` por:

```css
/* Vista global de obligaciones. En la Parte 2 se suma el bloque @media print. */

.page { padding: 24px; max-width: 1200px; margin: 0 auto; }

.toolbar {
  display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
  position: sticky; top: 0; z-index: 10;
  background: var(--background); padding: 12px 0; margin-bottom: 16px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.2);
}
.pageTitle { font-size: 20px; margin: 0; }
.pageSubtitle { margin: 2px 0 0; opacity: 0.7; font-size: 13px; text-transform: capitalize; }
.toolbarRight { margin-left: auto; display: flex; align-items: center; gap: 12px; }
.counters { font-size: 13px; opacity: 0.75; }

.searchInput {
  flex: 1; min-width: 220px; padding: 8px 12px; border-radius: 8px;
  border: 1px solid rgba(127, 127, 127, 0.35); background: transparent; color: inherit;
}

.bankGroup { margin-bottom: 28px; }
.bankTitle { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.7; margin: 0 0 10px; }

.sheetCard {
  border: 1px solid rgba(127, 127, 127, 0.25);
  border-radius: 10px; padding: 16px; margin-bottom: 16px;
  border-left-width: 4px;
}
/* El color del banco tiñe sólo el borde izquierdo. Todo selector lleva la clase
   local: CSS Modules corre en modo `pure` y un [data-*] suelto rompe el build. */
.sheetCard[data-bank-color="red"] { border-left-color: #dc2626; }
.sheetCard[data-bank-color="blue"] { border-left-color: #2563eb; }
.sheetCard[data-bank-color="green"] { border-left-color: #16a34a; }
.sheetCard[data-bank-color="amber"] { border-left-color: #d97706; }
.sheetCard[data-bank-color="violet"] { border-left-color: #7c3aed; }
.sheetCard[data-bank-color="slate"] { border-left-color: #64748b; }

.sheetHeader { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
.sheetBank { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.6; }
.sheetTitle { font-size: 17px; margin: 2px 0 0; }
.sheetHeaderRight { display: flex; align-items: center; gap: 10px; }
.sheetPeriod { font-size: 13px; opacity: 0.75; text-transform: capitalize; }

.addBtn {
  width: 30px; height: 30px; border-radius: 8px; font-size: 18px; line-height: 1;
  border: 1px solid rgba(127, 127, 127, 0.4); background: transparent; color: inherit; cursor: pointer;
}
.addBtn:hover { background: rgba(127, 127, 127, 0.12); }

.sheetTable { width: 100%; border-collapse: collapse; font-size: 13px; }
.sheetTable th {
  text-align: left; font-size: 11px; letter-spacing: 0.04em;
  padding: 6px 8px; border-bottom: 1px solid rgba(127, 127, 127, 0.3); white-space: nowrap;
}
.sheetTable td { padding: 6px 8px; border-bottom: 1px solid rgba(127, 127, 127, 0.12); }
.actionsHeader { width: 1%; }
.rowActions { display: flex; gap: 8px; justify-content: flex-end; white-space: nowrap; }
.rowSkipped { opacity: 0.5; text-decoration: line-through; }
.rowInactive { opacity: 0.45; font-style: italic; }

.linkBtn { background: none; border: none; padding: 0; color: #2563eb; cursor: pointer; font-size: 12px; }
.dangerBtn { background: none; border: none; padding: 0; color: #b91c1c; cursor: pointer; font-size: 12px; }
.ghostBtn {
  padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(127, 127, 127, 0.4);
  background: transparent; color: inherit; cursor: pointer; font-size: 13px; text-decoration: none;
}
.primaryBtn {
  padding: 6px 14px; border-radius: 8px; border: 1px solid #2563eb;
  background: #2563eb; color: #fff; cursor: pointer; font-size: 13px;
}
.primaryBtn:disabled { opacity: 0.5; cursor: default; }

.confirmBox {
  margin-top: 12px; padding: 12px; border-radius: 8px;
  border: 1px solid rgba(185, 28, 28, 0.5); font-size: 13px;
}
.confirmActions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }

.emptyNote { font-size: 13px; opacity: 0.65; margin: 8px 0; }
.loading { font-size: 14px; opacity: 0.75; }
.warning { padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(217, 119, 6, 0.5); margin-bottom: 12px; font-size: 13px; }
.error { padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(185, 28, 28, 0.5); margin-bottom: 12px; font-size: 13px; }

.modalOverlay {
  position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
}
.modalCard {
  background: var(--background); color: inherit; border-radius: 12px; padding: 20px;
  width: 90%; max-width: 520px; max-height: 80vh; display: flex; flex-direction: column; gap: 10px;
}
.modalTitle { margin: 0; font-size: 17px; }
.modalSubtitle { margin: 0; font-size: 13px; opacity: 0.7; }
.modalActions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }

.targetList { overflow-y: auto; flex: 1; }
.targetGroupTitle { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.6; margin: 10px 0 4px; }
.targetGroup { list-style: none; margin: 0; padding: 0; }
.targetItem { padding: 3px 0; }
.targetLabel { display: flex; gap: 8px; align-items: center; cursor: pointer; font-size: 13px; }
```

- [ ] **Step 3: Verificar la suite completa y el build**

```bash
npx vitest run
```

Esperado: PASS, **500 tests** — 456 de baseline + 44 nuevos (5 de Task 2, 13 de Task 4, 6 de Task 5,
6 de Task 7, 5 de Task 8, 9 de Task 9). El número final cambia en la Task 12, que borra los tests del
alta de gastos fijos del `ConfigModal` y agrega uno; anotar el conteo real de esa tarea al cerrar.

```bash
npm run build
```

Esperado: build OK. **Este es el comando que detecta los selectores impuros de CSS Modules** — si
falla con "Selector is not pure", revisar que todo selector con `[data-...]` esté anclado a una clase.

**No commitear.**

---

## Task 11: Entrada en el sidebar y rename del botón

**Files:**
- Modify: `src/app/admin/consortiums/page.tsx`

- [ ] **Step 1: Agregar el botón del sidebar**

En `src/app/admin/consortiums/page.tsx`, inmediatamente **después** del botón "Bancos"
(`page.tsx:314-317`), agregar:

```tsx
          {isClient && (
            <a href="/admin/obligaciones" className={styles.navSidebarItem} onClick={() => setNavMobileOpen(false)}>
              <span className={styles.navSidebarItemIcon}>📋</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>Obligaciones</span>}
            </a>
          )}
```

Se usa `<a>` y no `<button>` porque navega a otra ruta. La clase es la misma que la de los botones
hermanos, así que se ve igual.

- [ ] **Step 2: Renombrar el botón de la pestaña Obligaciones**

En `page.tsx:840`, cambiar el texto del botón:

```tsx
                        Sincronizar gastos fijos
```

El `onClick` y todo lo demás quedan igual: sigue llamando al POST de
`/api/client/periods/[id]/obligations`. Sólo cambia la etiqueta, porque el botón **sincroniza** (es
idempotente y sólo agrega lo que falta), no crea desde cero.

- [ ] **Step 3: Verificar**

```bash
npx vitest run
```

```bash
npm run typecheck
```

```bash
npm run lint
```

Esperado: todo verde. Si algún test de `consortiums` afirmaba el texto "Generar obligaciones",
actualizarlo al texto nuevo. **No commitear.**

---

## Task 12: `ConfigModal` — gastos fijos a solo lectura

**Files:**
- Modify: `src/app/admin/consortiums/components/ConfigModal.tsx`
- Modify: `src/app/admin/consortiums/hooks/useConsortiumConfig.ts`
- Modify: `src/app/admin/consortiums/components/ConfigModal.test.tsx`
- Modify: `src/app/admin/consortiums/hooks/useConsortiumConfig.test.tsx`

La edición pasa a vivir en la vista global; acá queda el resumen y el acceso.

- [ ] **Step 1: Reemplazar el cuerpo de la sección "Gastos fijos"**

En `ConfigModal.tsx`, reemplazar todo el bloque `{openSection === "fixed" && ( ... )}`
(líneas ~240-296, desde `{openSection === "fixed" && (` hasta su cierre `)}`) por:

```tsx
          {openSection === "fixed" && (
            <div className={styles.lspContent}>
              <p className={styles.lspEmpty}>
                {fixed.list.length === 0
                  ? "No hay gastos fijos cargados para este consorcio."
                  : `${fixed.list.filter((fx) => fx.active).length} gasto(s) fijo(s) activo(s) de ${fixed.list.length}.`}
              </p>
              <p className={styles.lspEmpty}>
                Los gastos fijos se administran desde la vista de{" "}
                <a href="/admin/obligaciones" className={styles.linkInline}>Obligaciones</a>, donde se
                ven todos los edificios juntos.
              </p>
            </div>
          )}
```

- [ ] **Step 2: Sacar del componente lo que quedó sin uso**

En `ConfigModal.tsx`, en el tipo de props, la clave `fixed` pasa a:

```tsx
  fixed: {
    list: FixedExpenseRow[];
  };
```

Borrar de la desestructuración y del tipo las claves `target`, `error`, `onChangeTarget`, `onAdd`,
`onToggle`, `onDelete`. Si `AsyncButton` o `LSP_PROVIDERS` quedan sin uso en el archivo, borrar sus
imports (el lint lo marca).

- [ ] **Step 3: Sacar los handlers del hook**

En `useConsortiumConfig.ts`, borrar `handleAddFixedExpense`, `handleToggleFixedExpense`,
`handleDeleteFixedExpense` y los estados `fxTarget` / `fxError` con sus setters. El `fetchFixedExpenses`
y el estado `fixedExpenses` **se quedan** (alimentan el resumen). El objeto devuelto pasa a:

```ts
    fixed: {
      list: fixedExpenses,
    },
```

- [ ] **Step 4: Ajustar los tests existentes**

En `useConsortiumConfig.test.tsx` y `ConfigModal.test.tsx`, borrar los casos que ejercitan el alta, el
toggle y el borrado de gastos fijos, y agregar uno al modal:

```tsx
  it("la sección de gastos fijos es de solo lectura y linkea a Obligaciones", async () => {
    renderModal({ fixed: { list: [
      { id: "fx1", providerId: "p1", lspServiceId: null, description: null, active: true },
      { id: "fx2", providerId: "p2", lspServiceId: null, description: null, active: false },
    ] } });

    await userEvent.click(screen.getByRole("button", { name: /Gastos fijos/ }));

    expect(screen.getByText(/1 gasto\(s\) fijo\(s\) activo\(s\) de 2/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Obligaciones" })).toHaveAttribute("href", "/admin/obligaciones");
    expect(screen.queryByRole("button", { name: "Agregar" })).not.toBeInTheDocument();
  });
```

Ajustar `renderModal` a la forma que ya usa ese archivo para las props por defecto.

- [ ] **Step 5: Agregar la clase del link**

En `src/app/admin/consortiums/page.module.css`, si no existe una clase equivalente, agregar:

```css
.linkInline { color: #2563eb; text-decoration: underline; }
```

- [ ] **Step 6: Verificar**

```bash
npx vitest run
```

```bash
npm run typecheck
```

```bash
npm run lint
```

Esperado: todo verde, con el conteo de tests ajustado (bajan los del alta de gastos fijos, sube el
nuevo). **No commitear.**

---

## Task 13: Verificación final y documentación

**Files:**
- Modify: `docs/progreso.md`
- Modify: `docs/decisiones.md`
- Modify: `CHANGELOG.md`

La regla de documentación del proyecto (ver `CLAUDE.md`) es obligatoria: sin estos tres archivos
actualizados, el trabajo no está terminado.

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

Esperado: los cinco en verde. El único warning de lint conocido de baseline es `uploadingReceiptId`
en `consortiums/page.tsx`, ajeno a este trabajo.

- [ ] **Step 2: Escribir la entrada de `docs/decisiones.md`**

Agregar arriba de todo, con fecha **2026-08-12**, cubriendo:
- **Problema:** administrar gastos fijos costaba 47 pantallas y no había forma de ver la cartera
  entera; además la lista de un período podía quedar incompleta sin que se notara.
- **Decisión:** vista global que sincroniza al abrir con una función **set-based**
  (`syncObligationsForClient`), y no llamando 47 veces a `generateObligationsForPeriod` — con la
  referencia explícita al incidente 524 de `close-all` (2026-07-12) como razón.
- **Decisión:** el modelo del documento (`SheetData[]`) es una función pura, para que la Parte 2
  (PDF) consuma exactamente lo mismo que la pantalla.
- **Alternativas descartadas:** basar la hoja en `FixedExpense` sin sincronizar (perdía el estado del
  mes); reutilizar `groupByBank` (devuelve `Consortium[]`, tipo ajeno a esta vista).
- **Impacto:** archivos nuevos, migración de índices únicos, `ConfigModal` reducido a solo lectura.

- [ ] **Step 3: Escribir la entrada de `docs/progreso.md`**

Sección nueva arriba de todo con el estado verificado (tests, typecheck, lint, builds), que **requiere
migración** (`20260812000000_unique_fixed_expense_target`), y los pendientes del owner:
1. Correr la query de duplicados de la Task 1, Step 4.
2. Aplicar la migración (`migrate deploy` + `generate`).
3. Smoke visual: abrir la vista con la cartera completa; agregar dos gastos fijos de una a un
   edificio y verlos aparecer; omitir uno y ver la fila tachada; desactivar otro; intentar eliminar y
   leer la advertencia; buscar por banco, por edificio y por servicio.

Anotar además que la **Parte 2 (PDF + impresión)** queda pendiente, con su plan propio.

- [ ] **Step 4: Escribir la entrada de `CHANGELOG.md`**

En `## [Unreleased]`, bajo `### Added`:

```markdown
- **Vista global de obligaciones (2026-08-12, Parte 1)**. Nueva pantalla `/admin/obligaciones`
  (sidebar, rol CLIENT) con los gastos fijos de todos los edificios agrupados por banco, cada uno con
  la forma exacta de la hoja que después se va a imprimir: FACTURAS · PROVEEDORES Y SERVICIOS ·
  MONTO · ALIAS CBU · TÉCNICO O GESTOR · TEL. CONTACTO. El monto sale de la boleta cuando llegó; las
  dos últimas columnas van vacías (el modelo todavía no guarda contacto). Desde la misma pantalla se
  agregan gastos fijos **de a varios** (modal con checkboxes que esconde lo ya cargado), se
  desactivan, se eliminan (con aviso de que arrastra el historial) y se omiten o reactivan las
  obligaciones del mes. Al abrir, la vista sincroniza sola las obligaciones faltantes de todos los
  períodos activos con una función **set-based** (~5 queries), así la lista nunca sale incompleta.
  Piezas nuevas: `obligaciones/lib/sheetModel` + `obligaciones/lib/availableTargets` (tier 0),
  `obligaciones/hooks/useObligationsOverview` (tier 1), `obligaciones/components/SheetCard` +
  `AddFixedExpenseModal` (tier 2), y los endpoints `/api/client/obligations/overview` y
  `/api/client/obligations/sync`. **Requiere migración** `20260812000000_unique_fixed_expense_target`.
```

Bajo `### Changed`:

```markdown
- **El botón "Generar obligaciones" pasa a llamarse "Sincronizar gastos fijos" (2026-08-12)**. Es lo
  que siempre hizo: es idempotente y sólo agrega al período abierto los gastos fijos que todavía no
  tenían obligación. El nombre viejo sugería que creaba algo desde cero.
- **La sección "Gastos fijos" del modal de Configuración es ahora de solo lectura (2026-08-12)**.
  Muestra cuántos hay activos y linkea a la vista de Obligaciones, que es el único lugar de edición.
```

- [ ] **Step 5: Avisar al owner**

Informar: "listo para commitear", con el resumen de archivos tocados, **la migración pendiente** y el
pendiente de smoke visual. **No preparar staging ni sugerir mensaje de commit** — el owner usa GitLens.

---

## Notas de riesgo para el implementador

1. **La migración no se aplica acá.** Claude crea la carpeta y el `.sql`; el owner corre
   `migrate deploy` y `generate`. Ningún test de este plan depende de que la migración esté aplicada
   (los índices únicos no cambian los tipos generados).
2. **`Decimal` de Prisma.** `Invoice.amount` puede tipar como `Decimal`. Si el typecheck se queja en
   el overview, convertir con `Number(...)` como indica la nota de la Task 3.
3. **Modo `pure` de CSS Modules.** `npm run build` es el único comando que detecta un selector sin
   clase local. Correrlo antes de dar por terminada la Task 10.
4. **No tocar el pipeline ni Google Sheets.** Esta feature es panel + DB. Si algo empuja a modificar
   `processPendingDocuments.job.ts` o `googleSheets.service.ts`, es señal de que algo se desvió.
5. **Verificar antes de afirmar.** No declarar ninguna tarea terminada sin haber corrido el comando y
   visto la salida.
