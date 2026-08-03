# Bancos por consorcio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catálogo de bancos a nivel cliente, datos de cuenta bancaria por consorcio, y una vista general agrupada por banco con navegación de dos niveles.

**Architecture:** Modelo `Bank` por `Client` (nombre + slug de color), FK `bankId` en `Consortium` que reemplaza el campo muerto `bank String?`, y seis campos de cuenta en `Consortium` (una cuenta por edificio). La UI suma un nivel 0 de cards de banco delante de la grilla de edificios actual, que no se modifica. Piezas nuevas siguiendo el patrón del refactor cerrado: hook de dominio + componente presentacional + helpers puros en `lib/`.

**Tech Stack:** Next.js 15 (App Router), TypeScript, Prisma + PostgreSQL (Supabase), Vitest (proyectos `node` para `.test.ts` y `jsdom` para `.test.tsx`), CSS Modules.

**Spec:** `docs/superpowers/specs/2026-08-03-bancos-por-consorcio-design.md`

---

## Convenciones de este plan

- **Claude nunca commitea.** Donde un plan normal diría "Commit", acá hay un paso de
  **Verificación**. El owner commitea con GitLens cuando el trabajo está listo.
- **Claude nunca corre `prisma migrate` ni `prisma generate`.** La Tarea 1 deja la migración
  escrita y **bloquea** hasta que el owner la ejecute.
- PowerShell: comandos por separado, sin `&&`.
- Comandos de verificación:

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
npm run build:jobs
```

---

## Estructura de archivos

**Crear:**

| Archivo | Responsabilidad |
|---|---|
| `prisma/migrations/20260803000000_bancos_por_consorcio/migration.sql` | Migración: tabla `Bank`, FK, rename `paymentAlias`→`bankAlias`, drop `bank`. |
| `src/app/admin/consortiums/lib/bankPalette.ts` | Slugs de color válidos + labels. Fuente única (UI + Zod). |
| `src/app/admin/consortiums/lib/bankPalette.test.ts` | Tier 0: consistencia de slugs. |
| `src/app/admin/consortiums/lib/groupByBank.ts` | Agrupación pura consorcios→bancos + filtro de búsqueda. |
| `src/app/admin/consortiums/lib/groupByBank.test.ts` | Tier 0: agrupación y filtrado. |
| `src/repositories/bank.repository.ts` | Acceso a datos de `Bank`. |
| `src/app/api/client/banks/route.ts` | GET (listar) + POST (crear). |
| `src/app/api/client/banks/[id]/route.ts` | PATCH (renombrar/color) + DELETE. |
| `src/app/admin/consortiums/hooks/useBanks.ts` | Catálogo + ABM + estado del modal. |
| `src/app/admin/consortiums/hooks/useBanks.test.tsx` | Tier 1. |
| `src/app/admin/consortiums/components/BanksModal.tsx` | ABM presentacional. |
| `src/app/admin/consortiums/components/BanksModal.test.tsx` | Tier 2. |
| `src/app/admin/consortiums/components/BankGrid.tsx` | Nivel 0: cards de banco con badges. |
| `src/app/admin/consortiums/components/BankGrid.test.tsx` | Tier 2. |

**Modificar:**

| Archivo | Cambio |
|---|---|
| `prisma/schema.prisma` | Modelo `Bank`, `Client.banks`, cambios en `Consortium`. |
| `src/repositories/consortium.repository.ts:124` | `include: { bank: true }` en `listByClient`. |
| `src/repositories/lspService.repository.ts:11` | `select` del consorcio incluye la relación `bank`. |
| `src/app/api/client/consortiums/[id]/route.ts:82-85` | Whitelist del PATCH: `bankId` + 6 campos de cuenta. |
| `src/app/api/client/consortiums/[id]/invoices/route.ts:97,330` | `select`/uso de `bank` por relación. |
| `src/jobs/processPendingDocuments.job.ts:347,415` | `consortium.bank?.name`. |
| `src/jobs/processPendingDocuments.job.test.ts:127` | Fixture con la relación. |
| `src/services/googleSheets.service.ts:98,128,414` | `_Consorcios` baja a 3 columnas. |
| `src/app/api/client/sync-directory/route.ts:122,131` | Upsert sin `paymentAlias` de consorcio. |
| `src/app/api/client/import/route.ts:110,132` | Hoja Edificios sin "Alias de pago". |
| `src/app/api/client/import/template/route.ts` | Template sin esa columna. |
| `src/app/admin/consortiums/lib/types.ts:6-11` | Tipos `Bank`, `BankGroup`, `Consortium` actualizado. |
| `src/app/admin/consortiums/hooks/useConsortiumConfig.ts` | Sub-dominio `bank`. |
| `src/app/admin/consortiums/components/ConfigModal.tsx` | Sección "Banco" del acordeón. |
| `src/app/admin/consortiums/page.tsx` | Nivel 0/1, botón sidebar, wiring. |
| `src/app/admin/consortiums/page.module.css` | Estilos de cards de banco, badges y paleta. |
| `CLAUDE.md`, `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md` | Documentación. |

---

## Task 1: Schema + migración (BLOQUEANTE)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260803000000_bancos_por_consorcio/migration.sql`

- [ ] **Step 1: Agregar el modelo `Bank` al schema**

En `prisma/schema.prisma`, después del modelo `Consortium`:

```prisma
model Bank {
  id          String       @id @default(cuid())
  clientId    String
  name        String
  /// Slug de la paleta fija (ver src/app/admin/consortiums/lib/bankPalette.ts).
  /// No es un hex libre: garantiza contraste en dark y light.
  color       String       @default("slate")
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  client      Client       @relation(fields: [clientId], references: [id], onDelete: Cascade)
  consortiums Consortium[]

  @@unique([clientId, name])
  @@index([clientId])
}
```

- [ ] **Step 2: Agregar la relación inversa en `Client`**

En el modelo `Client`, junto a las otras relaciones (`consortiums`, `providers`, …):

```prisma
  banks                  Bank[]
```

- [ ] **Step 3: Cambiar `Consortium`**

Borrar la línea `bank String?` y borrar `paymentAlias String?` **con su comentario**. En su lugar,
después de `matchNames`:

```prisma
  /// Banco del catálogo del cliente. Reemplaza el viejo `bank String?`, que era
  /// texto suelto y ningún código llenaba.
  bankId                 String?
  bank                   Bank?                @relation(fields: [bankId], references: [id], onDelete: SetNull)
  /// Datos de la cuenta del consorcio (bloque FORMA DE PAGO de la liquidación).
  /// Una sola cuenta por consorcio. Se cargan por UI, no por el archivo ALTA.
  /// `bankAlias` es el alias CBU (ex `paymentAlias`, que nació sin consumidor).
  bankAlias              String?
  cbu                    String?
  accountNumber          String?
  branch                 String?
  accountType            String?
  accountHolder          String?
```

- [ ] **Step 4: Escribir la migración**

Crear `prisma/migrations/20260803000000_bancos_por_consorcio/migration.sql`:

```sql
-- 1. Catálogo de bancos por cliente
CREATE TABLE "Bank" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Bank_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Bank_clientId_name_key" ON "Bank"("clientId", "name");
CREATE INDEX "Bank_clientId_idx" ON "Bank"("clientId");

ALTER TABLE "Bank" ADD CONSTRAINT "Bank_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Backfill defensivo: si alguien cargó Consortium.bank a mano por Supabase Studio,
--    esos valores se convierten en filas del catálogo. Se espera 0 filas.
INSERT INTO "Bank" ("id", "clientId", "name", "color", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "clientId", TRIM("bank"), 'slate', NOW(), NOW()
FROM (
    SELECT DISTINCT "clientId", "bank"
    FROM "Consortium"
    WHERE "bank" IS NOT NULL AND TRIM("bank") <> ''
) AS distinct_banks;

-- 3. Columnas nuevas en Consortium
ALTER TABLE "Consortium" ADD COLUMN "bankId" TEXT;
ALTER TABLE "Consortium" ADD COLUMN "cbu" TEXT;
ALTER TABLE "Consortium" ADD COLUMN "accountNumber" TEXT;
ALTER TABLE "Consortium" ADD COLUMN "branch" TEXT;
ALTER TABLE "Consortium" ADD COLUMN "accountType" TEXT;
ALTER TABLE "Consortium" ADD COLUMN "accountHolder" TEXT;

-- 4. Enlazar los consorcios con el banco backfilleado
UPDATE "Consortium" c
SET "bankId" = b."id"
FROM "Bank" b
WHERE b."clientId" = c."clientId"
  AND b."name" = TRIM(c."bank")
  AND c."bank" IS NOT NULL;

-- 5. Baja del campo de texto suelto (ningún código lo escribía)
ALTER TABLE "Consortium" DROP COLUMN "bank";

-- 6. El alias del consorcio pasa a ser el alias CBU de su cuenta.
--    Rename preserva valores; en la práctica están todos en NULL.
ALTER TABLE "Consortium" RENAME COLUMN "paymentAlias" TO "bankAlias";

-- 7. FK del banco asignado
ALTER TABLE "Consortium" ADD CONSTRAINT "Consortium_bankId_fkey"
    FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 5: BLOQUEO — avisar al owner**

Decirle al owner, textual:

> Migración lista en `prisma/migrations/20260803000000_bancos_por_consorcio/`. Necesito que corras
> el procedimiento (`npx prisma migrate deploy`, después `npx prisma generate`) antes de seguir: el
> resto del código usa tipos de Prisma que todavía no existen y `npm run typecheck` va a fallar hasta
> entonces.

**No continuar con la Tarea 2 hasta que el owner confirme.** El código de las tareas siguientes se
puede escribir, pero la verificación de tipos no va a pasar.

---

## Task 2: Paleta de colores

**Files:**
- Create: `src/app/admin/consortiums/lib/bankPalette.ts`
- Test: `src/app/admin/consortiums/lib/bankPalette.test.ts`

- [ ] **Step 1: Escribir el test que falla**

`src/app/admin/consortiums/lib/bankPalette.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BANK_COLORS, BANK_COLOR_SLUGS, DEFAULT_BANK_COLOR, isBankColor } from "./bankPalette";

describe("bankPalette", () => {
  it("expone los slugs derivados de la paleta, sin duplicados", () => {
    expect(BANK_COLOR_SLUGS).toEqual(BANK_COLORS.map((c) => c.slug));
    expect(new Set(BANK_COLOR_SLUGS).size).toBe(BANK_COLOR_SLUGS.length);
  });

  it("el color por defecto pertenece a la paleta", () => {
    expect(BANK_COLOR_SLUGS).toContain(DEFAULT_BANK_COLOR);
  });

  it("cada color tiene label no vacío", () => {
    for (const color of BANK_COLORS) {
      expect(color.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("isBankColor acepta slugs de la paleta y rechaza el resto", () => {
    expect(isBankColor("red")).toBe(true);
    expect(isBankColor("slate")).toBe(true);
    expect(isBankColor("#ff0000")).toBe(false);
    expect(isBankColor("fucsia")).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/consortiums/lib/bankPalette.test.ts
```

Esperado: FAIL — `Failed to resolve import "./bankPalette"`.

- [ ] **Step 3: Escribir la implementación**

`src/app/admin/consortiums/lib/bankPalette.ts`:

```ts
// Paleta fija de colores de banco. Fuente única: la usan el selector del ABM,
// el CSS de las cards (via data-bank-color) y el Zod del endpoint.
//
// Son slugs, no hex: el color real vive en page.module.css con un valor propio
// por tema (dark/light), así ningún banco puede quedar ilegible.

export type BankColor = {
  slug: string;
  label: string;
};

export const BANK_COLORS: BankColor[] = [
  { slug: "slate", label: "Gris" },
  { slug: "red", label: "Rojo" },
  { slug: "amber", label: "Ámbar" },
  { slug: "emerald", label: "Verde" },
  { slug: "teal", label: "Turquesa" },
  { slug: "sky", label: "Celeste" },
  { slug: "violet", label: "Violeta" },
  { slug: "rose", label: "Rosa" },
];

export const BANK_COLOR_SLUGS = BANK_COLORS.map((c) => c.slug);

export const DEFAULT_BANK_COLOR = "slate";

export function isBankColor(value: string): boolean {
  return BANK_COLOR_SLUGS.includes(value);
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/consortiums/lib/bankPalette.test.ts
```

Esperado: PASS, 4 tests.

---

## Task 3: Tipos de la UI

**Files:**
- Modify: `src/app/admin/consortiums/lib/types.ts:6-11`

- [ ] **Step 1: Agregar `Bank` y `BankGroup`, actualizar `Consortium`**

Reemplazar el tipo `Consortium` actual por:

```ts
export type Bank = {
  id: string; name: string; color: string;
  _count?: { consortiums: number };
};
export type Consortium = {
  id: string; canonicalName: string; rawName: string; cuit: string | null; cutoffDay: number;
  matchNames: string | null; statementsFolderUrl: string | null;
  bankId: string | null;
  bank: { id: string; name: string; color: string } | null;
  bankAlias: string | null; cbu: string | null; accountNumber: string | null;
  branch: string | null; accountType: string | null; accountHolder: string | null;
  periods: Period[]; _count: { invoices: number };
  activePeriodInvoiceCount: number; activePeriodDebt: number; totalDebt: number;
};
/** Grupo de la vista nivel 0. El grupo "Sin banco" usa el id centinela
 *  `UNASSIGNED_BANK_ID` de `groupByBank.ts`, no null: así el header navega igual. */
export type BankGroup = {
  id: string;
  name: string;
  color: string;
  consortiums: Consortium[];
};
```

Nota: el `bank: string | null` viejo desaparece; ahora es la relación.

- [ ] **Step 2: Agregar el tipo del formulario de cuenta**

Al final del archivo, junto a `ConfigSection` y `LspForm`:

```ts
/** Sección Banco del acordeón de Config: banco asignado + datos de la cuenta. */
export type BankAccountForm = {
  bankId: string;
  bankAlias: string;
  cbu: string;
  accountNumber: string;
  branch: string;
  accountType: string;
  accountHolder: string;
};
```

Y ampliar `ConfigSection`:

```ts
export type ConfigSection = "matchNames" | "bank" | "lsp" | "fixed";
```

---

## Task 4: Agrupación por banco (lógica pura)

**Files:**
- Create: `src/app/admin/consortiums/lib/groupByBank.ts`
- Test: `src/app/admin/consortiums/lib/groupByBank.test.ts`

- [ ] **Step 1: Escribir el test que falla**

`src/app/admin/consortiums/lib/groupByBank.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { groupByBank, UNASSIGNED_BANK_ID } from "./groupByBank";
import type { Bank, Consortium } from "./types";

const banks: Bank[] = [
  { id: "b1", name: "Santander", color: "red" },
  { id: "b2", name: "Galicia", color: "amber" },
];

function consortium(id: string, rawName: string, bank: Bank | null): Consortium {
  return {
    id, canonicalName: rawName, rawName, cuit: null, cutoffDay: 5,
    matchNames: null, statementsFolderUrl: null,
    bankId: bank?.id ?? null,
    bank: bank ? { id: bank.id, name: bank.name, color: bank.color } : null,
    bankAlias: null, cbu: null, accountNumber: null,
    branch: null, accountType: null, accountHolder: null,
    periods: [], _count: { invoices: 0 },
    activePeriodInvoiceCount: 0, activePeriodDebt: 0, totalDebt: 0,
  };
}

const arenales = consortium("c1", "ARENALES 2154", banks[0]);
const thames = consortium("c2", "THAMES 647", banks[0]);
const castillo = consortium("c3", "CASTILLO 246", banks[1]);
const huerfano = consortium("c4", "MITRE 1225", null);

describe("groupByBank", () => {
  it("agrupa los consorcios bajo su banco, en el orden de los bancos", () => {
    const groups = groupByBank(banks, [castillo, arenales, thames], "");
    expect(groups.map((g) => g.id)).toEqual(["b1", "b2"]);
    expect(groups[0].consortiums.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(groups[0].color).toBe("red");
  });

  it("emite el grupo Sin banco al final cuando hay consorcios sin asignar", () => {
    const groups = groupByBank(banks, [arenales, huerfano], "");
    expect(groups.at(-1)?.id).toBe(UNASSIGNED_BANK_ID);
    expect(groups.at(-1)?.consortiums.map((c) => c.id)).toEqual(["c4"]);
  });

  it("no emite el grupo Sin banco cuando todos tienen banco", () => {
    const groups = groupByBank(banks, [arenales, castillo], "");
    expect(groups.some((g) => g.id === UNASSIGNED_BANK_ID)).toBe(false);
  });

  it("incluye bancos sin consorcios (para que se vean los recién creados)", () => {
    const groups = groupByBank(banks, [arenales], "");
    expect(groups.map((g) => g.id)).toEqual(["b1", "b2"]);
    expect(groups[1].consortiums).toEqual([]);
  });

  it("filtrando por nombre de banco muestra ese banco con todos sus consorcios", () => {
    const groups = groupByBank(banks, [arenales, thames, castillo], "santander");
    expect(groups.map((g) => g.id)).toEqual(["b1"]);
    expect(groups[0].consortiums).toHaveLength(2);
  });

  it("filtrando por nombre de edificio reduce los consorcios del grupo", () => {
    const groups = groupByBank(banks, [arenales, thames, castillo], "thames");
    expect(groups.map((g) => g.id)).toEqual(["b1"]);
    expect(groups[0].consortiums.map((c) => c.id)).toEqual(["c2"]);
  });

  it("filtra también dentro del grupo Sin banco", () => {
    const groups = groupByBank(banks, [arenales, huerfano], "mitre");
    expect(groups.map((g) => g.id)).toEqual([UNASSIGNED_BANK_ID]);
    expect(groups[0].consortiums.map((c) => c.id)).toEqual(["c4"]);
  });

  it("devuelve lista vacía si nada matchea", () => {
    expect(groupByBank(banks, [arenales], "zzz")).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/consortiums/lib/groupByBank.test.ts
```

Esperado: FAIL — `Failed to resolve import "./groupByBank"`.

- [ ] **Step 3: Escribir la implementación**

`src/app/admin/consortiums/lib/groupByBank.ts`:

```ts
// Agrupación de la vista nivel 0: consorcios bajo la card de su banco.
// Lógica pura, sin React: se testea sin montar nada.
import { normName } from "./match";
import type { Bank, BankGroup, Consortium } from "./types";

/** Id centinela del grupo de consorcios sin banco asignado. */
export const UNASSIGNED_BANK_ID = "__unassigned__";

/**
 * Arma los grupos de la grilla de bancos.
 *
 * Reglas de búsqueda (`query`):
 * - Si el nombre del BANCO matchea, el grupo se muestra con todos sus consorcios.
 * - Si no, el grupo se muestra sólo si alguno de sus consorcios matchea, y en ese
 *   caso se recorta a los que matchean.
 * - Los bancos sin consorcios se muestran igual (query vacío), para que un banco
 *   recién creado sea visible.
 */
export function groupByBank(banks: Bank[], consortiums: Consortium[], query: string): BankGroup[] {
  const q = normName(query);
  const matchesConsortium = (c: Consortium) =>
    !q || normName(c.rawName).includes(q) || normName(c.canonicalName).includes(q);

  const groups: BankGroup[] = [];

  for (const bank of banks) {
    const own = consortiums.filter((c) => c.bankId === bank.id);
    const bankMatches = !q || normName(bank.name).includes(q);
    const visible = bankMatches ? own : own.filter(matchesConsortium);

    if (!bankMatches && visible.length === 0) continue;
    groups.push({ id: bank.id, name: bank.name, color: bank.color, consortiums: visible });
  }

  const orphans = consortiums.filter((c) => !c.bankId).filter(matchesConsortium);
  if (orphans.length > 0) {
    groups.push({ id: UNASSIGNED_BANK_ID, name: "Sin banco", color: "slate", consortiums: orphans });
  }

  return groups;
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/consortiums/lib/groupByBank.test.ts
```

Esperado: PASS, 8 tests.

---

## Task 5: Repositorio de bancos

**Files:**
- Create: `src/repositories/bank.repository.ts`

- [ ] **Step 1: Escribir el repositorio**

`src/repositories/bank.repository.ts`:

```ts
import { Bank, PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";

/**
 * Acceso a datos del catálogo de bancos (nivel Client, como Rubro y Coeficiente).
 * Sólo operaciones de base de datos — la validación vive en las rutas.
 */
export class BankRepository {
  constructor(private readonly injectedPrisma?: PrismaClient) {}
  private get prisma(): PrismaClient {
    return this.injectedPrisma ?? getPrismaClient();
  }

  /** Bancos del cliente, alfabéticos, con la cantidad de consorcios asignados. */
  async listByClient(clientId: string): Promise<Array<Bank & { _count: { consortiums: number } }>> {
    return this.prisma.bank.findMany({
      where: { clientId },
      include: { _count: { select: { consortiums: true } } },
      orderBy: { name: "asc" },
    });
  }

  async findById(clientId: string, id: string): Promise<Bank | null> {
    return this.prisma.bank.findFirst({ where: { id, clientId } });
  }

  async create(clientId: string, name: string, color: string): Promise<Bank> {
    return this.prisma.bank.create({ data: { clientId, name, color } });
  }

  async update(id: string, data: { name?: string; color?: string }): Promise<Bank> {
    return this.prisma.bank.update({ where: { id }, data });
  }

  /** Borra el banco. Los consorcios asignados quedan con `bankId = null` (SetNull). */
  async remove(id: string): Promise<void> {
    await this.prisma.bank.delete({ where: { id } });
  }
}
```

- [ ] **Step 2: Verificar tipos**

```bash
npm run typecheck
```

Esperado: sin errores (requiere que el owner haya corrido `prisma generate` — Tarea 1).

---

## Task 6: Endpoints del catálogo de bancos

**Files:**
- Create: `src/app/api/client/banks/route.ts`
- Create: `src/app/api/client/banks/[id]/route.ts`

- [ ] **Step 1: GET + POST**

`src/app/api/client/banks/route.ts` — usa los HOF `withAuth`/`withClientAuth` como
`api/client/rubros/route.ts`:

```ts
import { z } from "zod";
import { apiError, apiOk, withAuth, withClientAuth } from "@/lib/apiHandler";
import { BankRepository } from "@/repositories/bank.repository";
import { BANK_COLOR_SLUGS, DEFAULT_BANK_COLOR } from "@/app/admin/consortiums/lib/bankPalette";

const createSchema = z.object({
  name: z.string().min(1, "El nombre es obligatorio").max(60),
  color: z.string().refine((c) => BANK_COLOR_SLUGS.includes(c), "Color inválido").optional(),
});

export const GET = withAuth(async ({ session }) => {
  const repo = new BankRepository();
  const banks = await repo.listByClient(session.clientId);
  return apiOk({ banks });
});

export const POST = withClientAuth(async ({ request, session }) => {
  const body = createSchema.parse(await request.json());
  const name = body.name.trim();
  const repo = new BankRepository();

  const banks = await repo.listByClient(session.clientId);
  if (banks.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
    return apiError(new Error("Ya existe un banco con ese nombre"), 409);
  }

  const bank = await repo.create(session.clientId, name, body.color ?? DEFAULT_BANK_COLOR);
  return apiOk({ bank }, 201);
});
```

- [ ] **Step 2: PATCH + DELETE**

`src/app/api/client/banks/[id]/route.ts` — ruta dinámica, así que usa el guard directo
(`requireClientSession`), igual que `api/client/rubros/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { apiError, apiOk } from "@/lib/apiHandler";
import { BankRepository } from "@/repositories/bank.repository";
import { BANK_COLOR_SLUGS } from "@/app/admin/consortiums/lib/bankPalette";

const updateSchema = z.object({
  name: z.string().min(1, "El nombre es obligatorio").max(60).optional(),
  color: z.string().refine((c) => BANK_COLOR_SLUGS.includes(c), "Color inválido").optional(),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const { id } = await context.params;

  try {
    const repo = new BankRepository();
    const bank = await repo.findById(auth.session.clientId, id);
    if (!bank) {
      return NextResponse.json({ ok: false, error: "Banco no encontrado" }, { status: 404 });
    }

    const body = updateSchema.parse(await request.json());
    const name = body.name?.trim();

    if (name) {
      const banks = await repo.listByClient(auth.session.clientId);
      if (banks.some((b) => b.id !== id && b.name.toLowerCase() === name.toLowerCase())) {
        return apiError(new Error("Ya existe un banco con ese nombre"), 409);
      }
    }

    const updated = await repo.update(id, {
      ...(name !== undefined && { name }),
      ...(body.color !== undefined && { color: body.color }),
    });
    return apiOk({ bank: updated });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const { id } = await context.params;

  try {
    const repo = new BankRepository();
    const bank = await repo.findById(auth.session.clientId, id);
    if (!bank) {
      return NextResponse.json({ ok: false, error: "Banco no encontrado" }, { status: 404 });
    }

    // Los consorcios asignados quedan con bankId = null por el ON DELETE SET NULL.
    await repo.remove(id);
    return apiOk();
  } catch (error) {
    return apiError(error);
  }
}
```

- [ ] **Step 3: Verificar que el test de guards sigue verde**

```bash
npx vitest run src/app/api/routeAuthGuard.test.ts
```

Esperado: PASS — las rutas nuevas usan guards, así que no aparecen como no protegidas.

---

## Task 7: PATCH de consorcio extendido

**Files:**
- Modify: `src/app/api/client/consortiums/[id]/route.ts:82-90`

- [ ] **Step 1: Ampliar la whitelist**

Reemplazar el bloque:

```ts
    const data: Record<string, unknown> = {};
    if (typeof body.matchNames === "string" || body.matchNames === null) {
      data.matchNames = body.matchNames || null;
    }
```

por:

```ts
    const data: Record<string, unknown> = {};
    if (typeof body.matchNames === "string" || body.matchNames === null) {
      data.matchNames = body.matchNames || null;
    }

    // Banco asignado: null desasigna. Se valida que pertenezca al mismo cliente
    // para que un id de otro tenant no pueda enlazarse.
    if (typeof body.bankId === "string" || body.bankId === null) {
      if (body.bankId) {
        const bank = await prisma.bank.findFirst({
          where: { id: body.bankId, clientId: auth.session.clientId },
        });
        if (!bank) {
          return NextResponse.json({ ok: false, error: "Banco no encontrado" }, { status: 404 });
        }
        data.bankId = body.bankId;
      } else {
        data.bankId = null;
      }
    }

    // Datos de la cuenta del consorcio (bloque FORMA DE PAGO).
    const accountFields = ["bankAlias", "cbu", "accountNumber", "branch", "accountType", "accountHolder"] as const;
    for (const field of accountFields) {
      const value = body[field];
      if (typeof value === "string" || value === null) {
        data[field] = typeof value === "string" ? value.trim() || null : null;
      }
    }
```

- [ ] **Step 2: Devolver la relación en la respuesta**

Reemplazar:

```ts
    const updated = await prisma.consortium.update({
      where: { id: consortiumId },
      data,
    });
```

por:

```ts
    const updated = await prisma.consortium.update({
      where: { id: consortiumId },
      data,
      include: { bank: true },
    });
```

- [ ] **Step 3: Verificación**

```bash
npm run typecheck
```

Esperado: sin errores.

---

## Task 8: Pipeline y repositorios leen el banco por relación

**Files:**
- Modify: `src/repositories/consortium.repository.ts:124-135`
- Modify: `src/repositories/lspService.repository.ts:11`
- Modify: `src/jobs/processPendingDocuments.job.ts:347,415`
- Modify: `src/app/api/client/consortiums/[id]/invoices/route.ts:97,330`
- Modify: `src/jobs/processPendingDocuments.job.test.ts:127`

- [ ] **Step 1: Correr los tests de caracterización ANTES de tocar nada**

```bash
npx vitest run src/jobs/processPendingDocuments.job.test.ts
```

Esperado: PASS. Anotar el número de tests — tiene que ser el mismo al final.

- [ ] **Step 2: `listByClient` incluye la relación**

En `src/repositories/consortium.repository.ts`, en `listByClient`, cambiar el `include`:

```ts
    const consortiums = await prisma.consortium.findMany({
      where: { clientId },
      include: {
        periods: true,
        bank: true,
        _count: {
          select: { invoices: true },
        },
      },
      orderBy: {
        canonicalName: "asc",
      },
    });
```

Y en la firma del método, agregar `bank` al tipo de retorno:

```ts
  async listByClient(
    clientId: string
  ): Promise<
    Array<
      Consortium & {
        periods: Period[];
        bank: Bank | null;
        _count: { invoices: number };
        activePeriodInvoiceCount: number;
        activePeriodDebt: number;
        totalDebt: number;
      }
    >
  > {
```

Agregar `Bank` al import de `@prisma/client` en la línea 1:

```ts
import { Bank, Consortium, Period, Prisma, PrismaClient } from "@prisma/client";
```

- [ ] **Step 3: `lspService.repository.ts` trae la relación**

Cambiar el select del consorcio (línea 11):

```ts
    select: { id: true, canonicalName: true, rawName: true, bank: { select: { name: true } }, statementsFolderId: true },
```

- [ ] **Step 4: El job lee `bank?.name`**

En `src/jobs/processPendingDocuments.job.ts`, línea ~347 (rama LSP):

```ts
          consortiumBank: lspService.consortium.bank?.name ?? null,
```

Línea ~415 (rama normal):

```ts
  base.consortiumBank = consortium.bank?.name ?? null;
```

Buscar dónde se carga ese `consortium` en la rama normal y agregarle `include: { bank: true }` si el
query no lo trae. Verificar con:

```bash
npx tsc --noEmit
```

- [ ] **Step 5: `invoices/route.ts`**

Línea 97, el select del consorcio:

```ts
      select: { id: true, rawName: true, bank: { select: { name: true } }, statementsFolderId: true },
```

Línea ~330, el uso:

```ts
            bank: consortium.bank?.name ?? null,
```

- [ ] **Step 6: Actualizar el fixture del test**

En `src/jobs/processPendingDocuments.job.test.ts:127`:

```ts
      cuit: "30-11111111-1", bank: null, statementsFolderId: null,
```

`bank: null` sigue siendo válido como relación nula — sólo verificar que el tipo del fixture no
declare `bank: string | null` explícitamente. Si lo hace, cambiarlo a
`bank: { name: string } | null`.

- [ ] **Step 7: Correr los tests de caracterización DESPUÉS**

```bash
npx vitest run src/jobs/processPendingDocuments.job.test.ts
```

Esperado: PASS, mismo número de tests que en el Step 1.

---

## Task 9: Baja del alias de consorcio en ALTA e import

**Files:**
- Modify: `src/services/googleSheets.service.ts:98,128,414` y el rango de `_Consorcios`
- Modify: `src/app/api/client/sync-directory/route.ts:122,131`
- Modify: `src/app/api/client/import/route.ts:110,132`
- Modify: `src/app/api/client/import/template/route.ts`

- [ ] **Step 1: `googleSheets.service.ts` — tipo de `DirectoryData`**

Línea ~128, sacar `paymentAlias` **sólo de consortiums** (providers no se toca):

```ts
  consortiums: { canonicalName: string; cuit: string | null; matchNames: string | null }[];
  providers: { canonicalName: string; cuit: string | null; matchNames: string | null; paymentAlias: string | null; providerType: "PROVEEDOR" | "EMPLEADO" }[];
```

- [ ] **Step 2: `googleSheets.service.ts` — rango y mapeo**

En `readDirectory`, cambiar el rango de la hoja de consorcios:

```ts
      readTab("_Consorcios", "A:C"),
```

Y el mapeo (línea ~414), sacando `row[3]`:

```ts
      consortiums: consortiumRows
        .map((row) => ({
          canonicalName: row[0]?.toString().trim().toUpperCase() ?? "",
          cuit: row[1]?.toString().trim() || null,
          matchNames: row[2]?.toString().trim() || null,
        }))
        .filter((c) => c.canonicalName),
```

- [ ] **Step 3: `googleSheets.service.ts` — headers auto-creados**

Alrededor de la línea 98 están los headers que se escriben cuando la hoja no existe. Sacar `"ALIAS"`
**de la definición de `_Consorcios` únicamente**, dejando las 3 columnas restantes. La de
`_Proveedores` queda igual.

- [ ] **Step 4: `sync-directory/route.ts` — upsert sin alias**

Línea ~122 (create) y ~131 (update): sacar `paymentAlias: c.paymentAlias` de ambos objetos. El
`data` del update queda:

```ts
          data: { cuit: formatCuit(c.cuit) ?? c.cuit, matchNames: c.matchNames },
```

**No tocar** las líneas 228 y 238 (proveedores).

- [ ] **Step 5: `import/route.ts` — hoja Edificios sin alias**

Línea ~110: borrar la lectura de `paymentAlias` en el bloque de **edificios**. Línea ~132: sacar
`paymentAlias: paymentAlias || null` del `data` de creación del consorcio.

**No tocar** las líneas 171 y 202 (proveedores).

- [ ] **Step 6: `import/template/route.ts` — sacar la columna del template**

En la hoja `Edificios` del template, sacar la columna "Alias de pago" (header y valor de ejemplo).
La hoja `Proveedores` queda igual.

- [ ] **Step 7: Verificación**

```bash
npm run typecheck
```

```bash
npx vitest run
```

Esperado: sin errores de tipos, todos los tests verdes.

---

## Task 10: Hook `useBanks`

**Files:**
- Create: `src/app/admin/consortiums/hooks/useBanks.ts`
- Test: `src/app/admin/consortiums/hooks/useBanks.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

`src/app/admin/consortiums/hooks/useBanks.test.tsx`:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBanks } from "./useBanks";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({
  useAuthGuard: () => ({ guardedFetch: (...args: unknown[]) => guardedFetch(...args) }),
}));

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

const santander = { id: "b1", name: "Santander", color: "red", _count: { consortiums: 2 } };

describe("useBanks", () => {
  beforeEach(() => {
    guardedFetch.mockReset();
    guardedFetch.mockResolvedValue(jsonResponse({ ok: true, banks: [santander] }));
  });

  it("carga el catálogo al montar", async () => {
    const { result } = renderHook(() => useBanks());
    await waitFor(() => expect(result.current.banks).toHaveLength(1));
    expect(result.current.banks[0].name).toBe("Santander");
  });

  it("crea un banco y lo agrega al catálogo", async () => {
    const { result } = renderHook(() => useBanks());
    await waitFor(() => expect(result.current.banks).toHaveLength(1));

    guardedFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, bank: { id: "b2", name: "Galicia", color: "amber" } }, true, 201)
    );
    guardedFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, banks: [santander, { id: "b2", name: "Galicia", color: "amber", _count: { consortiums: 0 } }] })
    );

    act(() => { result.current.setForm({ name: "Galicia", color: "amber" }); });
    await act(async () => { await result.current.create(); });

    await waitFor(() => expect(result.current.banks).toHaveLength(2));
    expect(result.current.form.name).toBe("");
  });

  it("expone el error del 409 por nombre duplicado", async () => {
    const { result } = renderHook(() => useBanks());
    await waitFor(() => expect(result.current.banks).toHaveLength(1));

    guardedFetch.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "Ya existe un banco con ese nombre" }, false, 409)
    );

    act(() => { result.current.setForm({ name: "Santander" }); });
    await act(async () => { await result.current.create(); });

    expect(result.current.error).toBe("Ya existe un banco con ese nombre");
  });

  it("no llama a la API si el nombre está vacío", async () => {
    const { result } = renderHook(() => useBanks());
    await waitFor(() => expect(result.current.banks).toHaveLength(1));
    guardedFetch.mockClear();

    await act(async () => { await result.current.create(); });

    expect(guardedFetch).not.toHaveBeenCalled();
    expect(result.current.error).toBe("El nombre es obligatorio");
  });

  it("borra un banco y limpia la confirmación", async () => {
    const { result } = renderHook(() => useBanks());
    await waitFor(() => expect(result.current.banks).toHaveLength(1));

    guardedFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    guardedFetch.mockResolvedValueOnce(jsonResponse({ ok: true, banks: [] }));

    act(() => { result.current.setConfirmDeleteId("b1"); });
    await act(async () => { await result.current.remove("b1"); });

    await waitFor(() => expect(result.current.banks).toHaveLength(0));
    expect(result.current.confirmDeleteId).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/consortiums/hooks/useBanks.test.tsx
```

Esperado: FAIL — `Failed to resolve import "./useBanks"`.

- [ ] **Step 3: Escribir el hook**

`src/app/admin/consortiums/hooks/useBanks.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { DEFAULT_BANK_COLOR } from "../lib/bankPalette";
import type { Bank } from "../lib/types";

export type BankFormValues = { name: string; color: string };
const EMPTY_FORM: BankFormValues = { name: "", color: DEFAULT_BANK_COLOR };

/**
 * Catálogo de bancos del cliente (nivel Client, como Rubro y Coeficiente) + su ABM.
 * El modal de gestión vive en el sidebar; la asignación a cada consorcio la hace
 * la sección Banco del modal de Configuración.
 */
export function useBanks() {
  const { guardedFetch } = useAuthGuard();

  const [banks, setBanks] = useState<Bank[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [form, setFormState] = useState<BankFormValues>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const fetchBanks = useCallback(async () => {
    try {
      const res = await guardedFetch("/api/client/banks", { cache: "no-store" });
      const data = await res.json();
      if (data.ok) setBanks(data.banks ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  useEffect(() => { void fetchBanks(); }, [fetchBanks]);

  const setForm = (patch: Partial<BankFormValues>) => setFormState((f) => ({ ...f, ...patch }));

  const create = async () => {
    const name = form.name.trim();
    if (!name) { setError("El nombre es obligatorio"); return; }
    setError(null);
    try {
      const res = await guardedFetch("/api/client/banks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: form.color }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setFormState(EMPTY_FORM);
      await fetchBanks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al crear banco");
    }
  };

  const update = async (id: string, patch: Partial<BankFormValues>) => {
    setError(null);
    try {
      const res = await guardedFetch(`/api/client/banks/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setEditingId(null);
      await fetchBanks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al actualizar banco");
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      const res = await guardedFetch(`/api/client/banks/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await fetchBanks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al eliminar banco");
    } finally {
      setConfirmDeleteId(null);
    }
  };

  return {
    banks, reload: fetchBanks,
    isOpen,
    open: () => { setError(null); setFormState(EMPTY_FORM); setIsOpen(true); },
    close: () => { setIsOpen(false); setConfirmDeleteId(null); setEditingId(null); },
    form, setForm,
    error,
    confirmDeleteId, setConfirmDeleteId,
    editingId, setEditingId,
    create, update, remove,
  };
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/consortiums/hooks/useBanks.test.tsx
```

Esperado: PASS, 5 tests.

---

## Task 11: Componente `BanksModal`

**Files:**
- Create: `src/app/admin/consortiums/components/BanksModal.tsx`
- Test: `src/app/admin/consortiums/components/BanksModal.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

`src/app/admin/consortiums/components/BanksModal.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BanksModal } from "./BanksModal";
import type { Bank } from "../lib/types";

const banks: Bank[] = [
  { id: "b1", name: "Santander", color: "red", _count: { consortiums: 2 } },
  { id: "b2", name: "Galicia", color: "amber", _count: { consortiums: 0 } },
];

function setup(overrides: Partial<React.ComponentProps<typeof BanksModal>> = {}) {
  const props: React.ComponentProps<typeof BanksModal> = {
    banks,
    form: { name: "", color: "slate" },
    error: null,
    confirmDeleteId: null,
    editingId: null,
    onChangeForm: vi.fn(),
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onConfirmDelete: vi.fn(),
    onEdit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<BanksModal {...props} />);
  return props;
}

describe("BanksModal", () => {
  it("lista los bancos con su contador de edificios", () => {
    setup();
    expect(screen.getByText("Santander")).toBeInTheDocument();
    expect(screen.getByText("Galicia")).toBeInTheDocument();
    expect(screen.getByText("2 edificios")).toBeInTheDocument();
    expect(screen.getByText("Sin edificios")).toBeInTheDocument();
  });

  it("dispara onCreate al agregar", async () => {
    const props = setup({ form: { name: "BBVA", color: "sky" } });
    await userEvent.click(screen.getByRole("button", { name: /agregar/i }));
    expect(props.onCreate).toHaveBeenCalled();
  });

  it("pide confirmación antes de borrar", async () => {
    const props = setup();
    await userEvent.click(screen.getAllByRole("button", { name: /eliminar/i })[0]);
    expect(props.onConfirmDelete).toHaveBeenCalledWith("b1");
  });

  it("avisa cuántos edificios quedan sin banco al confirmar el borrado", () => {
    setup({ confirmDeleteId: "b1" });
    expect(screen.getByText(/2 edificios quedarán sin banco/i)).toBeInTheDocument();
  });

  it("muestra el error", () => {
    setup({ error: "Ya existe un banco con ese nombre" });
    expect(screen.getByText("Ya existe un banco con ese nombre")).toBeInTheDocument();
  });

  it("al editar muestra los campos de la fila y guarda con onUpdate", async () => {
    const props = setup({ editingId: "b1" });
    const input = screen.getByDisplayValue("Santander");
    await userEvent.clear(input);
    await userEvent.type(input, "Santander Río");
    await userEvent.click(screen.getByRole("button", { name: /^guardar$/i }));
    expect(props.onUpdate).toHaveBeenCalledWith("b1", { name: "Santander Río", color: "red" });
  });

  it("dispara onEdit al tocar Editar", async () => {
    const props = setup();
    await userEvent.click(screen.getAllByRole("button", { name: /editar/i })[0]);
    expect(props.onEdit).toHaveBeenCalledWith("b1");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/consortiums/components/BanksModal.test.tsx
```

Esperado: FAIL — `Failed to resolve import "./BanksModal"`.

- [ ] **Step 3: Escribir el componente**

`src/app/admin/consortiums/components/BanksModal.tsx`:

```tsx
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { BANK_COLORS } from "../lib/bankPalette";
import type { Bank } from "../lib/types";
import type { BankFormValues } from "../hooks/useBanks";

type Props = {
  banks: Bank[];
  form: BankFormValues;
  error: string | null;
  confirmDeleteId: string | null;
  editingId: string | null;
  onChangeForm: (patch: Partial<BankFormValues>) => void;
  onCreate: () => void;
  onUpdate: (id: string, patch: BankFormValues) => void;
  onDelete: (id: string) => void;
  onConfirmDelete: (id: string | null) => void;
  onEdit: (id: string | null) => void;
  onClose: () => void;
};

/** ABM del catálogo de bancos del cliente. Presentacional: el estado vive en `useBanks`.
 *  La edición de una fila usa estado local propio (el borrador del renombre no
 *  pertenece al catálogo; se descarta al cancelar). */
export function BanksModal({
  banks, form, error, confirmDeleteId, editingId,
  onChangeForm, onCreate, onUpdate, onDelete, onConfirmDelete, onEdit, onClose,
}: Props) {
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Bancos</h3>
        <p className={styles.modalSubtitle}>
          Catálogo del cliente. Cada consorcio se asigna a un banco desde su Configuración.
        </p>

        {banks.length > 0 ? (
          <div className={styles.lspTableWrap}>
            <table className={styles.lspTable}>
              <thead>
                <tr><th>Banco</th><th>Edificios</th><th>Acciones</th></tr>
              </thead>
              <tbody>
                {banks.map((b) => (
                  <BankRow
                    key={b.id}
                    bank={b}
                    isEditing={editingId === b.id}
                    isConfirmingDelete={confirmDeleteId === b.id}
                    onUpdate={onUpdate}
                    onDelete={onDelete}
                    onConfirmDelete={onConfirmDelete}
                    onEdit={onEdit}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.lspEmpty}>No hay bancos cargados.</p>
        )}

        <div className={styles.lspAddForm}>
          <input
            className={styles.formInput}
            value={form.name}
            onChange={(e) => onChangeForm({ name: e.target.value })}
            placeholder="Nombre del banco"
          />
          <select
            className={styles.formSelect}
            value={form.color}
            onChange={(e) => onChangeForm({ color: e.target.value })}
            aria-label="Color del banco"
          >
            {BANK_COLORS.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
          </select>
          <AsyncButton type="button" className={styles.addInvoiceBtn} onClick={onCreate} pendingLabel="Agregando…">
            Agregar
          </AsyncButton>
        </div>
        {error && <p className={styles.errorMsg}>{error}</p>}

        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}

type RowProps = {
  bank: Bank;
  isEditing: boolean;
  isConfirmingDelete: boolean;
  onUpdate: (id: string, patch: BankFormValues) => void;
  onDelete: (id: string) => void;
  onConfirmDelete: (id: string | null) => void;
  onEdit: (id: string | null) => void;
};

/** Fila del catálogo. El borrador del renombre es estado local: si se cancela,
 *  no tiene que haber ensuciado nada de arriba. */
function BankRow({ bank, isEditing, isConfirmingDelete, onUpdate, onDelete, onConfirmDelete, onEdit }: RowProps) {
  const [draft, setDraft] = useState<BankFormValues>({ name: bank.name, color: bank.color });
  const count = bank._count?.consortiums ?? 0;

  // Al entrar en edición, el borrador arranca de los valores actuales de la fila.
  useEffect(() => {
    if (isEditing) setDraft({ name: bank.name, color: bank.color });
  }, [isEditing, bank.name, bank.color]);

  if (isEditing) {
    return (
      <tr>
        <td>
          <input
            className={styles.formInput}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            aria-label="Nombre del banco"
          />
        </td>
        <td>
          <select
            className={styles.formSelect}
            value={draft.color}
            onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
            aria-label="Color"
          >
            {BANK_COLORS.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
          </select>
        </td>
        <td>
          <AsyncButton type="button" className={styles.addInvoiceBtn} onClick={() => onUpdate(bank.id, draft)} pendingLabel="Guardando…">
            Guardar
          </AsyncButton>{" "}
          <button type="button" className={styles.ghostBtn} onClick={() => onEdit(null)}>Cancelar</button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>
        <span className={styles.bankDot} data-bank-color={bank.color} aria-hidden="true" />
        {bank.name}
      </td>
      <td>{count > 0 ? `${count} edificios` : "Sin edificios"}</td>
      <td>
        {isConfirmingDelete ? (
          <span className={styles.lspConfirmDelete}>
            {count > 0 ? `${count} edificios quedarán sin banco. ¿Confirmar?` : "¿Confirmar?"}{" "}
            <AsyncButton type="button" className={styles.lspConfirmYes} onClick={() => onDelete(bank.id)} pendingLabel="…">Sí</AsyncButton>
            <button type="button" className={styles.lspConfirmNo} onClick={() => onConfirmDelete(null)}>No</button>
          </span>
        ) : (
          <>
            <button type="button" className={styles.matchNamesEditBtn} onClick={() => onEdit(bank.id)}>Editar</button>{" "}
            <button type="button" className={styles.lspDeleteBtn} onClick={() => onConfirmDelete(bank.id)}>Eliminar</button>
          </>
        )}
      </td>
    </tr>
  );
}
```

El import del archivo necesita `useEffect` y `useState` de React:

```tsx
import { useEffect, useState } from "react";
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/consortiums/components/BanksModal.test.tsx
```

Esperado: PASS, 7 tests.

---

## Task 12: Componente `BankGrid` (nivel 0)

**Files:**
- Create: `src/app/admin/consortiums/components/BankGrid.tsx`
- Test: `src/app/admin/consortiums/components/BankGrid.test.tsx`
- Modify: `src/app/admin/consortiums/page.module.css`

- [ ] **Step 1: Escribir el test que falla**

`src/app/admin/consortiums/components/BankGrid.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BankGrid } from "./BankGrid";
import { UNASSIGNED_BANK_ID } from "../lib/groupByBank";
import type { BankGroup, Consortium } from "../lib/types";

function consortium(id: string, rawName: string): Consortium {
  return {
    id, canonicalName: rawName, rawName, cuit: null, cutoffDay: 5,
    matchNames: null, statementsFolderUrl: null,
    bankId: null, bank: null,
    bankAlias: null, cbu: null, accountNumber: null,
    branch: null, accountType: null, accountHolder: null,
    periods: [], _count: { invoices: 0 },
    activePeriodInvoiceCount: 0, activePeriodDebt: 0, totalDebt: 0,
  };
}

const groups: BankGroup[] = [
  { id: "b1", name: "Santander", color: "red", consortiums: [consortium("c1", "ARENALES 2154"), consortium("c2", "THAMES 647")] },
  { id: UNASSIGNED_BANK_ID, name: "Sin banco", color: "slate", consortiums: [consortium("c3", "MITRE 1225")] },
];

describe("BankGrid", () => {
  it("renderiza una card por grupo con sus badges", () => {
    render(<BankGrid groups={groups} onSelectBank={vi.fn()} onSelectConsortium={vi.fn()} />);
    expect(screen.getByText("Santander")).toBeInTheDocument();
    expect(screen.getByText("Sin banco")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ARENALES 2154" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "THAMES 647" })).toBeInTheDocument();
  });

  it("muestra la cantidad de edificios de cada grupo", () => {
    render(<BankGrid groups={groups} onSelectBank={vi.fn()} onSelectConsortium={vi.fn()} />);
    expect(screen.getByText("2 edificios")).toBeInTheDocument();
    expect(screen.getByText("1 edificio")).toBeInTheDocument();
  });

  it("al clickear el título del banco entra al nivel de edificios", async () => {
    const onSelectBank = vi.fn();
    render(<BankGrid groups={groups} onSelectBank={onSelectBank} onSelectConsortium={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Santander/ }));
    expect(onSelectBank).toHaveBeenCalledWith("b1");
  });

  it("al clickear un badge entra directo a ese consorcio", async () => {
    const onSelectConsortium = vi.fn();
    render(<BankGrid groups={groups} onSelectBank={vi.fn()} onSelectConsortium={onSelectConsortium} />);
    await userEvent.click(screen.getByRole("button", { name: "THAMES 647" }));
    expect(onSelectConsortium).toHaveBeenCalledWith(groups[0].consortiums[1]);
  });

  it("aplica el color del grupo con data-bank-color", () => {
    const { container } = render(<BankGrid groups={groups} onSelectBank={vi.fn()} onSelectConsortium={vi.fn()} />);
    expect(container.querySelector('[data-bank-color="red"]')).not.toBeNull();
  });

  it("avisa cuando un banco no tiene edificios", () => {
    render(
      <BankGrid
        groups={[{ id: "b2", name: "Galicia", color: "amber", consortiums: [] }]}
        onSelectBank={vi.fn()}
        onSelectConsortium={vi.fn()}
      />
    );
    expect(screen.getByText("Sin edificios asignados")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/consortiums/components/BankGrid.test.tsx
```

Esperado: FAIL — `Failed to resolve import "./BankGrid"`.

- [ ] **Step 3: Escribir el componente**

`src/app/admin/consortiums/components/BankGrid.tsx`:

```tsx
import styles from "../page.module.css";
import type { BankGroup, Consortium } from "../lib/types";

type Props = {
  groups: BankGroup[];
  onSelectBank: (bankId: string) => void;
  onSelectConsortium: (c: Consortium) => void;
};

/**
 * Nivel 0 de la vista general: una card por banco con los edificios como badges.
 *
 * La card es un `<div>` (no un `<button>`) porque los badges son botones: anidar
 * controles interactivos rompe la semántica y la navegación por teclado.
 */
export function BankGrid({ groups, onSelectBank, onSelectConsortium }: Props) {
  return (
    <div className={styles.cardGrid}>
      {groups.map((group) => (
        <div key={group.id} className={styles.bankCard} data-bank-color={group.color}>
          <button
            type="button"
            className={styles.bankCardHeader}
            onClick={() => onSelectBank(group.id)}
          >
            <span className={styles.cardIcon} aria-hidden="true">🏦</span>
            <span className={styles.cardName}>{group.name}</span>
            <span className={styles.bankCardCount}>
              {group.consortiums.length === 1 ? "1 edificio" : `${group.consortiums.length} edificios`}
            </span>
          </button>

          {group.consortiums.length > 0 ? (
            <div className={styles.bankBadges}>
              {group.consortiums.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={styles.bankBadge}
                  onClick={() => onSelectConsortium(c)}
                >
                  {c.rawName}
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.lspEmpty}>Sin edificios asignados</p>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/consortiums/components/BankGrid.test.tsx
```

Esperado: PASS, 6 tests. El grupo "Sin banco" tiene `id: UNASSIGNED_BANK_ID` (string), así que su
header también navega — el filtrado por ese id se resuelve en `page.tsx` (Tarea 13).

- [ ] **Step 5: Agregar los estilos**

Al final de `src/app/admin/consortiums/page.module.css`:

```css
/* ── Nivel 0: cards de banco ───────────────────────────────────────────── */
.bankCard {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--bank-accent, var(--border));
  border-radius: 14px;
  background: var(--bank-bg, var(--bg-card));
  transition: border-color 0.15s, transform 0.15s, background 0.15s;
}
.bankCard:hover { transform: translateY(-2px); }

.bankCardHeader {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  color: inherit;
}
.bankCardCount {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.bankBadges { display: flex; flex-wrap: wrap; gap: 6px; }
.bankBadge {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.bankBadge:hover { border-color: var(--bank-accent, var(--accent)); color: var(--text-heading); }

.bankDot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 8px;
  border-radius: 50%;
  background: var(--bank-accent, var(--border));
  vertical-align: middle;
}

/* Paleta de bancos: un par accent/bg por slug y por tema.
   El texto nunca se colorea — así ningún banco queda ilegible. */
[data-bank-color="slate"] { --bank-accent: rgba(148,163,184,0.55); --bank-bg: rgba(148,163,184,0.07); }
[data-bank-color="red"]     { --bank-accent: rgba(248,113,113,0.55); --bank-bg: rgba(248,113,113,0.07); }
[data-bank-color="amber"]   { --bank-accent: rgba(251,191,36,0.55);  --bank-bg: rgba(251,191,36,0.07); }
[data-bank-color="emerald"] { --bank-accent: rgba(52,211,153,0.55);  --bank-bg: rgba(52,211,153,0.07); }
[data-bank-color="teal"]    { --bank-accent: rgba(45,212,191,0.55);  --bank-bg: rgba(45,212,191,0.07); }
[data-bank-color="sky"]     { --bank-accent: rgba(56,189,248,0.55);  --bank-bg: rgba(56,189,248,0.07); }
[data-bank-color="violet"]  { --bank-accent: rgba(167,139,250,0.55); --bank-bg: rgba(167,139,250,0.07); }
[data-bank-color="rose"]    { --bank-accent: rgba(251,113,133,0.55); --bank-bg: rgba(251,113,133,0.07); }

/* En tema claro los mismos tonos necesitan más saturación para no lavarse. */
:global([data-theme="light"]) [data-bank-color="slate"]   { --bank-accent: rgba(100,116,139,0.6); --bank-bg: rgba(100,116,139,0.06); }
:global([data-theme="light"]) [data-bank-color="red"]     { --bank-accent: rgba(220,38,38,0.6);   --bank-bg: rgba(220,38,38,0.05); }
:global([data-theme="light"]) [data-bank-color="amber"]   { --bank-accent: rgba(180,83,9,0.6);    --bank-bg: rgba(180,83,9,0.05); }
:global([data-theme="light"]) [data-bank-color="emerald"] { --bank-accent: rgba(5,150,105,0.6);   --bank-bg: rgba(5,150,105,0.05); }
:global([data-theme="light"]) [data-bank-color="teal"]    { --bank-accent: rgba(13,148,136,0.6);  --bank-bg: rgba(13,148,136,0.05); }
:global([data-theme="light"]) [data-bank-color="sky"]     { --bank-accent: rgba(2,132,199,0.6);   --bank-bg: rgba(2,132,199,0.05); }
:global([data-theme="light"]) [data-bank-color="violet"]  { --bank-accent: rgba(124,58,237,0.6);  --bank-bg: rgba(124,58,237,0.05); }
:global([data-theme="light"]) [data-bank-color="rose"]    { --bank-accent: rgba(225,29,72,0.6);   --bank-bg: rgba(225,29,72,0.05); }
```

---

## Task 13: Integración en `page.tsx`

**Files:**
- Modify: `src/app/admin/consortiums/page.tsx`

- [ ] **Step 1: Imports y hook**

Agregar a los imports (después de `ConfigModal`):

```tsx
import { useBanks } from "./hooks/useBanks";
import { BanksModal } from "./components/BanksModal";
import { BankGrid } from "./components/BankGrid";
import { groupByBank, UNASSIGNED_BANK_ID } from "./lib/groupByBank";
```

Después de `const provider = useProviderForm(...)` (línea ~87):

```tsx
  const banks = useBanks();
  // Nivel 0 = grilla de bancos; nivel 1 = grilla de edificios del banco elegido.
  const [selectedBankId, setSelectedBankId] = useState<string | null>(null);
```

- [ ] **Step 2: Botón "Bancos" en el sidebar**

En el `<nav className={styles.navSidebarNav}>`, después del botón "Sincronizar directorio":

```tsx
          <button type="button" className={styles.navSidebarItem} onClick={() => { banks.open(); setNavMobileOpen(false); }}>
            <span className={styles.navSidebarItemIcon}>🏦</span>
            {!navCollapsed && <span className={styles.navSidebarItemLabel}>Bancos</span>}
          </button>
```

- [ ] **Step 3: Reemplazar el bloque de la grilla por los dos niveles**

Reemplazar el bloque `{!selectedId && !pendingRestore && (...)}` (líneas ~460-532) por:

```tsx
          {!selectedId && !pendingRestore && (
            <>
              <div className={styles.gridToolbar}>
                <div className={styles.searchRow}>
                  <input
                    type="text"
                    className={styles.searchInput}
                    placeholder={selectedBankId ? "Buscar consorcio..." : "Buscar banco o consorcio..."}
                    value={consortiumSearch}
                    onChange={(e) => setConsortiumSearch(e.target.value)}
                  />
                  {consortiumSearch && (
                    <button type="button" className={styles.clearSearch} onClick={() => setConsortiumSearch("")} aria-label="Limpiar búsqueda">✕</button>
                  )}
                </div>
                <span className={styles.gridCount}>
                  {loadingList ? "..." : `${consortiums.length} consorcio${consortiums.length === 1 ? "" : "s"}`}
                </span>
              </div>

              {loadingList && <div className={styles.gridInfo}>Cargando consorcios...</div>}
              {listError && <div className={styles.sidebarError}>{listError}</div>}

              {/* Nivel 0: grilla de bancos */}
              {!loadingList && !listError && !selectedBankId && (() => {
                const groups = groupByBank(banks.banks, consortiums, consortiumSearch);
                if (consortiums.length === 0 && banks.banks.length === 0) {
                  return <div className={styles.gridInfo}>No hay consorcios cargados.</div>;
                }
                if (groups.length === 0) {
                  return <div className={styles.gridInfo}>Nada coincide con &quot;{consortiumSearch}&quot;.</div>;
                }
                return (
                  <BankGrid
                    groups={groups}
                    onSelectBank={(bankId) => { setSelectedBankId(bankId); setConsortiumSearch(""); }}
                    onSelectConsortium={(c) => void selectConsortium(c)}
                  />
                );
              })()}

              {/* Nivel 1: grilla de edificios del banco elegido (la de siempre) */}
              {!loadingList && !listError && selectedBankId && (() => {
                const bankName = selectedBankId === UNASSIGNED_BANK_ID
                  ? "Sin banco"
                  : banks.banks.find((b) => b.id === selectedBankId)?.name ?? "Banco";
                const ofBank = consortiums.filter((c) =>
                  selectedBankId === UNASSIGNED_BANK_ID ? !c.bankId : c.bankId === selectedBankId
                );
                const q = normName(consortiumSearch);
                const filtered = q
                  ? ofBank.filter((c) => normName(c.rawName).includes(q) || normName(c.canonicalName).includes(q))
                  : ofBank;

                return (
                  <>
                    <div className={styles.bankBreadcrumb}>
                      <button type="button" className={styles.backToGrid} onClick={() => { setSelectedBankId(null); setConsortiumSearch(""); }}>
                        ← Todos los bancos
                      </button>
                      <span className={styles.cardName}>{bankName}</span>
                    </div>

                    {filtered.length === 0 ? (
                      <div className={styles.gridInfo}>
                        {ofBank.length === 0
                          ? "Este banco no tiene edificios asignados."
                          : `Ningún consorcio coincide con "${consortiumSearch}".`}
                      </div>
                    ) : (
                      <div className={styles.cardGrid}>
                        {filtered.map((c) => {
                          const hasPeriodDebt = c.activePeriodDebt > 0;
                          const hasTotalDebt = c.totalDebt > 0;
                          return (
                            <button key={c.id} type="button" className={styles.consortiumCard} onClick={() => void selectConsortium(c)}>
                              <div className={styles.cardTop}>
                                <span className={styles.cardIcon}>🏢</span>
                                <span className={styles.cardName}>{c.rawName}</span>
                              </div>
                              <div className={styles.cardStats}>
                                <div className={styles.cardStat}>
                                  <span className={styles.cardStatLabel}>Boletas</span>
                                  <span className={styles.cardStatValue}>{c.activePeriodInvoiceCount}</span>
                                </div>
                                <div className={styles.cardStat}>
                                  <span className={styles.cardStatLabel}>Deuda mes</span>
                                  <span className={`${styles.cardStatValue} ${hasPeriodDebt ? styles.cardDebt : styles.cardNoDebt}`}>
                                    {formatAmount(c.activePeriodDebt)}
                                  </span>
                                </div>
                              </div>
                              <div className={styles.cardTotalDebt}>
                                <span className={styles.cardStatLabel}>Deuda total</span>
                                <span className={`${styles.cardTotalValue} ${hasTotalDebt ? styles.cardDebt : styles.cardNoDebt}`}>
                                  {formatAmount(c.totalDebt)}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </>
                );
              })()}
            </>
          )}
```

- [ ] **Step 4: Estilo del breadcrumb**

Agregar a `page.module.css`:

```css
.bankBreadcrumb {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
```

- [ ] **Step 5: Renderizar el `BanksModal`**

Junto a los otros modales al final del JSX (después del bloque de `ConfigModal`):

```tsx
      {/* ── Modal ABM de bancos ── */}
      {banks.isOpen && (
        <BanksModal
          banks={banks.banks}
          form={banks.form}
          error={banks.error}
          confirmDeleteId={banks.confirmDeleteId}
          editingId={banks.editingId}
          onChangeForm={banks.setForm}
          onCreate={banks.create}
          onUpdate={banks.update}
          onDelete={banks.remove}
          onConfirmDelete={banks.setConfirmDeleteId}
          onEdit={banks.setEditingId}
          onClose={() => { banks.close(); void fetchConsortiums(); }}
        />
      )}
```

Al cerrar se recargan los consorcios porque borrar un banco desasigna edificios y eso cambia los
grupos del nivel 0.

- [ ] **Step 6: Verificación**

```bash
npm run typecheck
```

```bash
npm run lint
```

Esperado: 0 errores; el único warning baseline es `uploadingReceiptId`.

---

## Task 14: Sección "Banco" en el modal de Configuración

**Files:**
- Modify: `src/app/admin/consortiums/hooks/useConsortiumConfig.ts`
- Modify: `src/app/admin/consortiums/components/ConfigModal.tsx`
- Modify: `src/app/admin/consortiums/page.tsx`
- Test: `src/app/admin/consortiums/hooks/useConsortiumConfig.test.tsx`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final del `describe` de `useConsortiumConfig.test.tsx`:

```tsx
  it("load() carga los datos bancarios del consorcio", () => {
    const { result } = renderHook(() => useConsortiumConfig({ consortiumId: "c1", onMatchNamesSaved: vi.fn() }));

    act(() => {
      result.current.load({
        ...baseConsortium,
        id: "c1",
        bankId: "b1",
        bank: { id: "b1", name: "Santander", color: "red" },
        bankAlias: "BROWN.706.CONS",
        cbu: "0720500220000000294986",
        accountNumber: "500-002949/8",
        branch: "016",
        accountType: "Cuenta Corriente",
        accountHolder: "Consorcio A. Brown 706",
      });
    });

    expect(result.current.bank.form.bankId).toBe("b1");
    expect(result.current.bank.form.cbu).toBe("0720500220000000294986");
    expect(result.current.bank.form.branch).toBe("016");
  });

  it("load() resetea los datos bancarios al cambiar a un consorcio sin banco", () => {
    const { result } = renderHook(() => useConsortiumConfig({ consortiumId: "c1", onMatchNamesSaved: vi.fn() }));

    act(() => { result.current.load({ ...baseConsortium, id: "c1", bankId: "b1", bank: { id: "b1", name: "Santander", color: "red" }, cbu: "123" }); });
    act(() => { result.current.load({ ...baseConsortium, id: "c2" }); });

    expect(result.current.bank.form.bankId).toBe("");
    expect(result.current.bank.form.cbu).toBe("");
  });

  it("save() manda el PATCH con los datos bancarios normalizados", async () => {
    guardedFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ ok: true, consortium: { id: "c1", bankId: "b1" } }),
    } as unknown as Response);

    const onBankSaved = vi.fn();
    const { result } = renderHook(() => useConsortiumConfig({ consortiumId: "c1", onMatchNamesSaved: vi.fn(), onBankSaved }));

    act(() => { result.current.bank.setForm({ bankId: "b1", cbu: " 0720500220000000294986 " }); });
    await act(async () => { await result.current.bank.save(); });

    const [url, init] = guardedFetch.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("/api/client/consortiums/c1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toMatchObject({
      bankId: "b1",
      cbu: "0720500220000000294986",
    });
    expect(onBankSaved).toHaveBeenCalled();
  });
```

Si el archivo de test no tiene un `baseConsortium`, agregarlo arriba del `describe`:

```tsx
const baseConsortium = {
  id: "c1", canonicalName: "ARENALES 2154", rawName: "ARENALES 2154", cuit: null, cutoffDay: 5,
  matchNames: null, statementsFolderUrl: null,
  bankId: null, bank: null,
  bankAlias: null, cbu: null, accountNumber: null,
  branch: null, accountType: null, accountHolder: null,
  periods: [], _count: { invoices: 0 },
  activePeriodInvoiceCount: 0, activePeriodDebt: 0, totalDebt: 0,
} as const;
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
npx vitest run src/app/admin/consortiums/hooks/useConsortiumConfig.test.tsx
```

Esperado: FAIL — `result.current.bank is undefined`.

- [ ] **Step 3: Agregar el sub-dominio `bank` al hook**

En `useConsortiumConfig.ts`, agregar el import del tipo:

```ts
import type { BankAccountForm, ConfigSection, Consortium, FixedExpenseRow, LspForm, LspService } from "../lib/types";
```

La constante del form vacío, junto a `EMPTY_LSP_FORM`:

```ts
const EMPTY_BANK_FORM: BankAccountForm = {
  bankId: "", bankAlias: "", cbu: "", accountNumber: "", branch: "", accountType: "", accountHolder: "",
};
```

La firma pasa a aceptar el callback de guardado:

```ts
export function useConsortiumConfig({ consortiumId, onMatchNamesSaved, onBankSaved }: {
  consortiumId: string | null;
  onMatchNamesSaved: (matchNames: string | null) => void;
  onBankSaved?: () => void;
}) {
```

El estado, junto a los otros:

```ts
  // Banco + datos de la cuenta del consorcio
  const [bankForm, setBankForm] = useState<BankAccountForm>(EMPTY_BANK_FORM);
  const [bankMsg, setBankMsg] = useState<string | null>(null);
  const { pending: savingBank, run: runBank } = useAsyncAction();
```

En `load(c)`, agregar antes de los fetches:

```ts
    setBankMsg(null);
    setBankForm({
      bankId: c.bankId ?? "",
      bankAlias: c.bankAlias ?? "",
      cbu: c.cbu ?? "",
      accountNumber: c.accountNumber ?? "",
      branch: c.branch ?? "",
      accountType: c.accountType ?? "",
      accountHolder: c.accountHolder ?? "",
    });
```

El handler de guardado, después de `saveMatchNames`:

```ts
  // ── Banco + cuenta ───────────────────────────────────────────────────────
  const saveBank = async () => {
    if (!consortiumId) return;
    setBankMsg(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bankId: bankForm.bankId || null,
          bankAlias: bankForm.bankAlias.trim() || null,
          cbu: bankForm.cbu.trim() || null,
          accountNumber: bankForm.accountNumber.trim() || null,
          branch: bankForm.branch.trim() || null,
          accountType: bankForm.accountType.trim() || null,
          accountHolder: bankForm.accountHolder.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setBankMsg("Guardado correctamente");
      setTimeout(() => setBankMsg(null), 3000);
      onBankSaved?.();
    } catch (err) {
      setBankMsg(err instanceof Error ? err.message : "Error al guardar");
    }
  };
```

Y el sub-objeto en el return, entre `matchNames` y `lsp`:

```ts
    bank: {
      form: bankForm,
      msg: bankMsg,
      saving: savingBank,
      setForm: (patch: Partial<BankAccountForm>) => setBankForm((f) => ({ ...f, ...patch })),
      save: () => runBank(saveBank),
    },
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
npx vitest run src/app/admin/consortiums/hooks/useConsortiumConfig.test.tsx
```

Esperado: PASS, los previos + 3 nuevos.

- [ ] **Step 5: Agregar la sección al `ConfigModal`**

En `ConfigModal.tsx`, agregar al tipo `Props` (después de `providers`):

```tsx
  banks: Bank[];
  bank: {
    form: BankAccountForm;
    msg: string | null;
    onChangeForm: (patch: Partial<BankAccountForm>) => void;
    onSave: () => void;
  };
```

Y al import de tipos:

```tsx
import type { Bank, BankAccountForm, ConfigSection, FixedExpenseRow, LspForm, LspService, Provider } from "../lib/types";
```

Destructurar `banks, bank` en la firma del componente. Insertar la sección **después** del bloque de
`matchNames` y antes del de `lsp`:

```tsx
        <div className={styles.configSection}>
          <button
            type="button"
            className={styles.lspToggle}
            onClick={() => onToggleSection("bank")}
            aria-expanded={openSection === "bank"}
          >
            <span className={styles.lspToggleChevron} aria-hidden="true">{openSection === "bank" ? "▾" : "▸"}</span>
            <span className={styles.lspTitle}>Banco y cuenta</span>
          </button>
          {openSection === "bank" && (
            <div className={styles.lspContent}>
              <p className={styles.configSectionDesc}>
                Banco donde cobra el consorcio y datos de su cuenta (bloque FORMA DE PAGO).
              </p>
              <div className={styles.providerFormGrid}>
                <div className={`${styles.formField} ${styles.formFieldFull}`}>
                  <label>Banco</label>
                  <select
                    className={styles.formSelect}
                    value={bank.form.bankId}
                    onChange={(e) => bank.onChangeForm({ bankId: e.target.value })}
                  >
                    <option value="">— Sin banco —</option>
                    {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div className={styles.formField}>
                  <label>Alias</label>
                  <input className={styles.formInput} value={bank.form.bankAlias} onChange={(e) => bank.onChangeForm({ bankAlias: e.target.value })} placeholder="BROWN.706.CONS" />
                </div>
                <div className={styles.formField}>
                  <label>CBU</label>
                  <input className={styles.formInput} value={bank.form.cbu} onChange={(e) => bank.onChangeForm({ cbu: e.target.value })} placeholder="0720500220000000294986" />
                </div>
                <div className={styles.formField}>
                  <label>Nº de cuenta</label>
                  <input className={styles.formInput} value={bank.form.accountNumber} onChange={(e) => bank.onChangeForm({ accountNumber: e.target.value })} placeholder="500-002949/8" />
                </div>
                <div className={styles.formField}>
                  <label>Sucursal</label>
                  <input className={styles.formInput} value={bank.form.branch} onChange={(e) => bank.onChangeForm({ branch: e.target.value })} placeholder="016" />
                </div>
                <div className={styles.formField}>
                  <label>Tipo de cuenta</label>
                  <input className={styles.formInput} list="accountTypes" value={bank.form.accountType} onChange={(e) => bank.onChangeForm({ accountType: e.target.value })} placeholder="Cuenta Corriente" />
                  <datalist id="accountTypes">
                    <option value="Cuenta Corriente" />
                    <option value="Caja de Ahorro" />
                  </datalist>
                </div>
                <div className={`${styles.formField} ${styles.formFieldFull}`}>
                  <label>Titular</label>
                  <input className={styles.formInput} value={bank.form.accountHolder} onChange={(e) => bank.onChangeForm({ accountHolder: e.target.value })} placeholder="Consorcio de Propietarios A. Brown 706" />
                </div>
              </div>
              <div className={styles.matchNamesActions}>
                <AsyncButton type="button" className={styles.addInvoiceBtn} onClick={bank.onSave} pendingLabel="Guardando…">
                  Guardar
                </AsyncButton>
              </div>
              {bank.msg && <p className={styles.infoMsg} style={{ marginTop: 6 }}>{bank.msg}</p>}
            </div>
          )}
        </div>
```

- [ ] **Step 6: Cablear en `page.tsx`**

En la llamada a `useConsortiumConfig` (línea ~150), agregar el callback:

```tsx
  const config = useConsortiumConfig({
    consortiumId: selectedId,
    onMatchNamesSaved: (matchNames) =>
      setSelectedConsortium((prev) => prev ? { ...prev, matchNames } : prev),
    onBankSaved: () => { void fetchConsortiums(); },
  });
```

Y en el render del `ConfigModal`, agregar las dos props nuevas después de `providers={providers}`:

```tsx
          banks={banks.banks}
          bank={{
            form: config.bank.form,
            msg: config.bank.msg,
            onChangeForm: config.bank.setForm,
            onSave: config.bank.save,
          }}
```

- [ ] **Step 7: Verificación completa**

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
npm run build:jobs
```

```bash
npm run build
```

Esperado: 0 errores, todos los tests verdes (419 previos + ~27 nuevos).

---

## Task 15: Documentación

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/progreso.md`
- Modify: `docs/decisiones.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: `CLAUDE.md`**

- En el schema: agregar `Bank` bajo `Client` y los campos nuevos de `Consortium`.
- En "Campos importantes en Consortium": documentar `bankId`/`bank`, `bankAlias`, `cbu`,
  `accountNumber`, `branch`, `accountType`, `accountHolder`. Sacar la mención de `paymentAlias` del
  consorcio (ahora es `bankAlias` y ya no viene del ALTA).
- En "Formato del archivo ALTA": la hoja `_Consorcios` baja a 3 columnas (sacar ALIAS). La de
  `_Proveedores` queda igual.
- En la estructura de endpoints: agregar `banks/` bajo `api/client/`.
- En "UI del panel cliente": documentar la vista de dos niveles y el botón Bancos del sidebar.

- [ ] **Step 2: `docs/decisiones.md`**

Entrada nueva con fecha 2026-08-03 que cubra:
- **Problema:** sin eje de organización en la vista general; datos de cuenta fuera del sistema.
- **Decisión:** catálogo `Bank` a nivel cliente + una cuenta por consorcio.
- **Hallazgos:** `Consortium.bank` se leía hasta la columna O de Sheets pero nadie lo escribía;
  `Consortium.paymentAlias` nació por simetría en `aa7784f` sin consumidor y se recicla como
  `bankAlias`.
- **Alternativas descartadas:** tabla `BankAccount` 1:N, color hex libre, bloquear el borrado de
  banco con 409.
- **Impacto:** archivos tocados + la migración.

- [ ] **Step 3: `docs/progreso.md`**

Sección nueva al inicio con el estado, qué se hizo, el conteo de tests y los pendientes del owner
(migración, smoke visual).

- [ ] **Step 4: `CHANGELOG.md`**

Entradas en `[Unreleased]` bajo `### Added` (catálogo de bancos, datos de cuenta, vista agrupada) y
`### Changed` (alias de consorcio ya no se carga por ALTA ni import; columna O de Sheets empieza a
llenarse).

- [ ] **Step 5: Avisar al owner**

Reportar: qué quedó listo, que la migración necesita correrse, y la lista de smoke visual de la §11
del spec.

---

## Checklist de cierre

- [ ] `npm run typecheck` — 0 errores
- [ ] `npm run lint` — 0 errores (warning baseline: `uploadingReceiptId`)
- [ ] `npx vitest run` — todos verdes
- [ ] `npm run build:jobs` — OK
- [ ] `npm run build` — OK
- [ ] `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`, `CLAUDE.md` actualizados
- [ ] Owner avisado: migración pendiente + smoke visual
