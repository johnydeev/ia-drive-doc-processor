# Rubros y coeficientes — Parte 1: modelo y carga

> **Para quien ejecute esto:** los pasos usan checkbox (`- [ ]`) para seguimiento.
> **Este repo NO se commitea desde Claude.** Donde un plan normal diría "commit", acá dice
> "verificar y avisar al owner": él commitea con GitLens. Cada commit a `master` es un deploy real.

**Objetivo:** que cada gasto fijo pueda llevar un rubro y un coeficiente, que las boletas los hereden
al procesarse, y cargar los ~725 rubros del padrón con un script.

**Arquitectura:** tres capas encadenadas — catálogo del cliente (ya existe), qué usa cada edificio
(tablas de unión nuevas), qué lleva cada gasto fijo (columnas nuevas). El pipeline copia del gasto
fijo a la boleta en el punto donde ya vincula la obligación. Toda la decisión de validación vive en
una función pura testeable sin base de datos.

**Stack:** Next.js 15 (App Router), Prisma + PostgreSQL, Vitest (proyecto `node` para `.test.ts`,
`jsdom` para `.test.tsx`), React 19.

**Spec:** [`docs/superpowers/specs/2026-09-24-rubros-y-coeficientes-design.md`](../specs/2026-09-24-rubros-y-coeficientes-design.md)

**Fuera de este plan:** el rediseño de la hoja de obligaciones (agrupado por rubro, columnas de
coeficiente, edición inline) y del PDF. Va en la Parte 2, que depende de que esto esté andando.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `prisma/schema.prisma` | Modificar: `Rubro.order`, dos modelos nuevos, dos columnas en `FixedExpense` |
| `prisma/migrations/<ts>_rubros_y_coeficientes_por_edificio/migration.sql` | Crear: la migración |
| `src/lib/rubroAssignment.ts` | Crear: decisión pura de si un rubro/coeficiente es asignable |
| `src/lib/rubroAssignment.test.ts` | Crear: sus tests |
| `src/app/api/client/rubros/route.ts` | Modificar: `order` en GET y POST |
| `src/app/api/client/rubros/[id]/route.ts` | Modificar: `order` en PATCH |
| `src/app/api/client/consortiums/[id]/catalogos/route.ts` | Crear: GET + PUT de lo asignado al edificio |
| `src/app/api/client/consortiums/[id]/fixed-expenses/[fxId]/route.ts` | Modificar: el `PATCH` existente acepta `rubroId` y `coeficienteId` |
| `src/repositories/fixedExpense.repository.ts` | Modificar: el `update` acepta los dos campos nuevos |
| `src/services/obligation.service.ts` | Modificar: copiar rubro y coeficiente al vincular |
| `src/lib/invoicePeriodMove.ts` | Verificar: si no pasa por `linkInvoiceToObligation`, agregar el copiado |
| `src/app/admin/consortiums/lib/types.ts` | Modificar: `Rubro.order`, `Coeficiente.code`, `value` nullable |
| `src/app/admin/consortiums/hooks/useCatalogos.ts` | Crear: estado del ABM de rubros y coeficientes |
| `src/app/admin/consortiums/components/CatalogosModal.tsx` | Crear: el ABM, copiando `BanksModal` |
| `src/app/admin/consortiums/components/ConfigModal.tsx` | Modificar: sección "Rubros y coeficientes" |
| `scripts/seed-rubros.ts` | Crear: carga inicial del padrón |

---

## Supuestos verificados contra el código (2026-09-24)

Chequeados antes de dar el plan por bueno. Si alguno cambió, la tarea que lo usa se cae.

| Supuesto | Estado |
|---|---|
| `withAuth` / `withClientAuth` **no** reciben `params` (`apiHandler.ts:17`) | ✅ confirmado — las rutas dinámicas usan `requireClientSession` + `context.params` |
| `[fxId]/route.ts` ya existe con un `PATCH` de `{ active, description }` sobre `FixedExpenseRepository` | ✅ confirmado — el Task 5 lo extiende, no lo reemplaza |
| El sync del ALTA **no** pisa `Rubro.order` (`applyUpdates(tx, "Rubro", [{ name: "description" }], …)`) | ✅ confirmado — no hay que tocar `_Rubros` ni `directorySyncPlan` |
| `linkInvoiceToObligation` ya trae el `fixedExpense` en el `include` | ✅ confirmado — sólo hay que ampliar el `select` |
| `syncObligationsForClient` hace un `update` por vínculo en un loop, y en régimen normal no hace ninguno | ✅ confirmado — sumar el `invoice.update` no cambia el orden de magnitud |
| El helper de `ConfigModal.test.tsx` se llama `setup` | ✅ confirmado |
| `Rubro` y `Coeficiente` en `lib/types.ts` del panel están incompletos | ✅ confirmado — el Task 8 los amplía |
| `styles.checkboxList` / `checkboxRow` no existen en `page.module.css` | ✅ confirmado — hay que agregarlos |
| `orderBy` con `nulls: "last"` | ⚠️ primer uso en el repo (Prisma 6.17.1) — el Task 3 trae el plan B |
| Suite completa en verde antes de empezar | ✅ 1070 tests, 98 archivos, exit 0 |

---

### Task 1: Schema y migración

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260924120000_rubros_y_coeficientes_por_edificio/migration.sql`

- [ ] **Step 1: Agregar `order` a `Rubro` y sus relaciones**

En `prisma/schema.prisma`, el modelo `Rubro` (línea ~253) queda así:

```prisma
model Rubro {
  id            String            @id @default(cuid())
  clientId      String
  name          String
  description   String?
  /// Número con el que se muestra y ordena en la liquidación (3 SERVICIOS PÚBLICOS).
  /// Nullable y sin unique: dos rubros con el mismo número son un error de carga que
  /// el ABM avisa, no algo que la base tenga que impedir. Los rubros sin número van
  /// al final, alfabéticos.
  order         Int?
  createdAt     DateTime          @default(now())
  updatedAt     DateTime          @updatedAt
  client        Client            @relation(fields: [clientId], references: [id], onDelete: Cascade)
  invoices      Invoice[]
  fixedExpenses FixedExpense[]
  consortiums   ConsortiumRubro[]

  @@unique([clientId, name])
  @@index([clientId])
}
```

- [ ] **Step 2: Agregar las relaciones nuevas a `Coeficiente`**

```prisma
model Coeficiente {
  id            String                  @id @default(cuid())
  clientId      String
  code          String
  name          String
  value         Decimal?                @db.Decimal(10, 6)
  createdAt     DateTime                @default(now())
  updatedAt     DateTime                @updatedAt
  client        Client                  @relation(fields: [clientId], references: [id], onDelete: Cascade)
  invoices      Invoice[]
  fixedExpenses FixedExpense[]
  consortiums   ConsortiumCoeficiente[]

  @@unique([clientId, code])
  @@index([clientId])
}
```

- [ ] **Step 3: Crear los dos modelos de unión**

Agregar después de `model Rubro`:

```prisma
/// Qué rubros del catálogo del cliente usa este edificio. Un edificio sin empleado
/// propio no tiene el rubro 1 y su liquidación arranca en el 2, sin renumerar.
model ConsortiumRubro {
  id           String     @id @default(cuid())
  consortiumId String
  rubroId      String
  createdAt    DateTime   @default(now())
  consortium   Consortium @relation(fields: [consortiumId], references: [id], onDelete: Cascade)
  rubro        Rubro      @relation(fields: [rubroId], references: [id], onDelete: Cascade)

  @@unique([consortiumId, rubroId])
  @@index([consortiumId])
}

/// Qué coeficientes usa este edificio. Son las columnas de la liquidación: Araoz 192
/// tiene A y B; Callao 1441 tiene A, B y C.
model ConsortiumCoeficiente {
  id            String      @id @default(cuid())
  consortiumId  String
  coeficienteId String
  createdAt     DateTime    @default(now())
  consortium    Consortium  @relation(fields: [consortiumId], references: [id], onDelete: Cascade)
  coeficiente   Coeficiente @relation(fields: [coeficienteId], references: [id], onDelete: Cascade)

  @@unique([consortiumId, coeficienteId])
  @@index([consortiumId])
}
```

- [ ] **Step 4: Agregar las relaciones inversas a `Consortium`**

Dentro de `model Consortium`, junto a las demás relaciones:

```prisma
  rubros        ConsortiumRubro[]
  coeficientes  ConsortiumCoeficiente[]
```

- [ ] **Step 5: Agregar las columnas a `FixedExpense`**

En `model FixedExpense`, después de `kind`:

```prisma
  /// Rubro y coeficiente que heredan las boletas de este gasto fijo. SetNull: borrar
  /// un rubro del catálogo deja el gasto fijo sin etiqueta, no lo borra.
  rubroId       String?
  coeficienteId String?
```

y en el bloque de relaciones:

```prisma
  rubro         Rubro?       @relation(fields: [rubroId], references: [id], onDelete: SetNull)
  coeficiente   Coeficiente? @relation(fields: [coeficienteId], references: [id], onDelete: SetNull)
```

- [ ] **Step 6: Escribir la migración**

Crear `prisma/migrations/20260924120000_rubros_y_coeficientes_por_edificio/migration.sql`:

```sql
-- Rubro: número de orden (3 SERVICIOS PÚBLICOS). Nullable, sin unique.
ALTER TABLE "Rubro" ADD COLUMN "order" INTEGER;

-- Qué rubros usa cada edificio
CREATE TABLE "ConsortiumRubro" (
    "id" TEXT NOT NULL,
    "consortiumId" TEXT NOT NULL,
    "rubroId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsortiumRubro_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConsortiumRubro_consortiumId_rubroId_key" ON "ConsortiumRubro"("consortiumId", "rubroId");
CREATE INDEX "ConsortiumRubro_consortiumId_idx" ON "ConsortiumRubro"("consortiumId");
ALTER TABLE "ConsortiumRubro" ADD CONSTRAINT "ConsortiumRubro_consortiumId_fkey"
    FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsortiumRubro" ADD CONSTRAINT "ConsortiumRubro_rubroId_fkey"
    FOREIGN KEY ("rubroId") REFERENCES "Rubro"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Qué coeficientes usa cada edificio
CREATE TABLE "ConsortiumCoeficiente" (
    "id" TEXT NOT NULL,
    "consortiumId" TEXT NOT NULL,
    "coeficienteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsortiumCoeficiente_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConsortiumCoeficiente_consortiumId_coeficienteId_key" ON "ConsortiumCoeficiente"("consortiumId", "coeficienteId");
CREATE INDEX "ConsortiumCoeficiente_consortiumId_idx" ON "ConsortiumCoeficiente"("consortiumId");
ALTER TABLE "ConsortiumCoeficiente" ADD CONSTRAINT "ConsortiumCoeficiente_consortiumId_fkey"
    FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsortiumCoeficiente" ADD CONSTRAINT "ConsortiumCoeficiente_coeficienteId_fkey"
    FOREIGN KEY ("coeficienteId") REFERENCES "Coeficiente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Qué lleva cada gasto fijo
ALTER TABLE "FixedExpense" ADD COLUMN "rubroId" TEXT;
ALTER TABLE "FixedExpense" ADD COLUMN "coeficienteId" TEXT;
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_rubroId_fkey"
    FOREIGN KEY ("rubroId") REFERENCES "Rubro"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_coeficienteId_fkey"
    FOREIGN KEY ("coeficienteId") REFERENCES "Coeficiente"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 7: Validar el schema**

Ejecutar: `npx prisma validate`
Esperado: `The schema at prisma\schema.prisma is valid 🚀`

- [ ] **Step 8: Avisar al owner**

Decirle que hay una migración pendiente y que corre el procedimiento completo de `CLAUDE.md`
(`npx prisma migrate deploy` → `npx prisma generate`, con los procesos parados). **No ejecutarlo.**
Hasta que el owner la aplique y corra `prisma generate`, las tareas que siguen no compilan.

---

### Task 2: Decisión de asignación (función pura)

Toda la validación de la cadena vive acá: un rubro sólo es asignable a un gasto fijo si el edificio lo
tiene asignado. Es lo único con lógica, así que va separado de los endpoints y se testea sin base.

**Files:**
- Create: `src/lib/rubroAssignment.ts`
- Test: `src/lib/rubroAssignment.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/lib/rubroAssignment.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { checkAssignable } from "./rubroAssignment";

describe("checkAssignable", () => {
  it("acepta un id que el edificio tiene asignado", () => {
    expect(checkAssignable("r3", ["r1", "r3"], "rubro")).toEqual({ ok: true });
  });

  it("acepta null: desasignar siempre se puede", () => {
    expect(checkAssignable(null, ["r1"], "rubro")).toEqual({ ok: true });
  });

  it("rechaza un id que el edificio no tiene, y lo dice", () => {
    expect(checkAssignable("r9", ["r1", "r3"], "rubro")).toEqual({
      ok: false,
      error: "Ese rubro no está asignado a este edificio",
    });
  });

  it("nombra al coeficiente en su propio mensaje", () => {
    expect(checkAssignable("c9", [], "coeficiente")).toEqual({
      ok: false,
      error: "Ese coeficiente no está asignado a este edificio",
    });
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Ejecutar: `npx vitest run src/lib/rubroAssignment.test.ts`
Esperado: FAIL — `Failed to resolve import "./rubroAssignment"`

- [ ] **Step 3: Escribir la implementación mínima**

Crear `src/lib/rubroAssignment.ts`:

```typescript
/**
 * Decisión de si un rubro o coeficiente se puede asignar a un gasto fijo.
 *
 * La cadena es: catálogo del cliente → lo que el edificio tiene asignado → lo que
 * lleva el gasto fijo. Cada capa sólo ofrece lo que habilitó la anterior, y este
 * es el guardián de la última. Puro a propósito: es lo único con lógica de las tres
 * capas, y así se prueba sin base de datos.
 */
export type AssignmentKind = "rubro" | "coeficiente";

export type AssignmentCheck = { ok: true } | { ok: false; error: string };

export function checkAssignable(
  id: string | null,
  assignedToConsortium: string[],
  kind: AssignmentKind
): AssignmentCheck {
  // Desasignar siempre vale: un gasto fijo sin etiqueta es un estado legítimo.
  if (id == null) return { ok: true };
  if (assignedToConsortium.includes(id)) return { ok: true };
  return { ok: false, error: `Ese ${kind} no está asignado a este edificio` };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Ejecutar: `npx vitest run src/lib/rubroAssignment.test.ts`
Esperado: PASS, 4 tests.

- [ ] **Step 5: Verificar y avisar**

Ejecutar: `npm run typecheck` y `npm run lint`
Esperado: sin errores nuevos (el lint tiene 13 warnings preexistentes).
Avisar al owner: "Task 2 lista para commitear".

---

### Task 3: `order` en la API del catálogo de rubros

**Files:**
- Modify: `src/app/api/client/rubros/route.ts`
- Modify: `src/app/api/client/rubros/[id]/route.ts`

- [ ] **Step 1: Aceptar y devolver `order` en la colección**

En `src/app/api/client/rubros/route.ts`, reemplazar `createSchema` y el `GET`:

```typescript
const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(255).optional(),
  order: z.number().int().min(1).max(99).optional(),
});

export const GET = withAuth(async ({ session }) => {
  const prisma = getPrismaClient();
  // Los rubros numerados primero, en su número; los sin número al final, alfabéticos.
  // `nulls: "last"` es de Prisma para PostgreSQL. Es el PRIMER uso en este repo, así
  // que si el cliente generado lo rechaza, reemplazar por `orderBy: { name: "asc" }`
  // y ordenar por `order` en el front (el ABM son ~11 filas).
  const rubros = await prisma.rubro.findMany({
    where: { clientId: session.clientId },
    orderBy: [{ order: { sort: "asc", nulls: "last" } }, { name: "asc" }],
  });
  return apiOk({ rubros });
});
```

y en el `POST`, agregar `order` al `data`:

```typescript
    data: {
      clientId: session.clientId,
      name: body.name.trim().toUpperCase(),
      description: body.description?.trim() ?? null,
      order: body.order ?? null,
    },
```

- [ ] **Step 2: Aceptar `order` en el PATCH**

En `src/app/api/client/rubros/[id]/route.ts`, reemplazar `updateSchema`:

```typescript
const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(255).nullable().optional(),
  order: z.number().int().min(1).max(99).nullable().optional(),
});
```

y agregar la línea al `data` del `update`:

```typescript
        ...(body.order !== undefined && { order: body.order }),
```

- [ ] **Step 3: Verificar que compila**

Ejecutar: `npm run typecheck`
Esperado: sin errores. Si falla con `Property 'order' does not exist`, el owner todavía no corrió
`prisma generate` — pedírselo antes de seguir.

- [ ] **Step 4: Verificar y avisar**

Ejecutar: `npm run lint`
Avisar: "Task 3 lista para commitear".

---

### Task 4: API de lo que usa cada edificio

**Files:**
- Create: `src/app/api/client/consortiums/[id]/catalogos/route.ts`

- [ ] **Step 1: Escribir el endpoint**

Crear `src/app/api/client/consortiums/[id]/catalogos/route.ts`:

> **Los wrappers `withAuth` / `withClientAuth` NO reciben `params`.** Está dicho en el comentario de
> `src/lib/apiHandler.ts:17`: *"Para rutas dinámicas (`[id]`) que necesitan `params`, seguir usando los
> guards directamente por ahora"*. Esta ruta es dinámica, así que usa `requireClientSession` con
> `context.params`, igual que `src/app/api/client/rubros/[id]/route.ts`. `apiOk` y `apiError` sí se
> pueden usar: son funciones sueltas, no wrappers.

```typescript
import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk } from "@/lib/apiHandler";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";

/**
 * Capa 2 de rubros y coeficientes: qué usa este edificio del catálogo del cliente.
 *
 * El PUT recibe el set COMPLETO, no un delta: es lo que devuelve una lista de
 * casillas, y hace la operación idempotente (mandar dos veces lo mismo no rompe).
 */
const putSchema = z.object({
  rubroIds: z.array(z.string()),
  coeficienteIds: z.array(z.string()),
});

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: consortiumId } = await context.params;
  const prisma = getPrismaClient();

  const consortium = await prisma.consortium.findFirst({
    where: { id: consortiumId, clientId: auth.session.clientId },
    select: { id: true },
  });
  if (!consortium) return apiError(new Error("Consorcio no encontrado"), 404);

  const [rubros, coeficientes] = await Promise.all([
    prisma.consortiumRubro.findMany({ where: { consortiumId }, select: { rubroId: true } }),
    prisma.consortiumCoeficiente.findMany({ where: { consortiumId }, select: { coeficienteId: true } }),
  ]);

  return apiOk({
    rubroIds: rubros.map((r) => r.rubroId),
    coeficienteIds: coeficientes.map((c) => c.coeficienteId),
  });
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: consortiumId } = await context.params;
  const prisma = getPrismaClient();
  const session = auth.session;
  const body = putSchema.parse(await request.json());

  const consortium = await prisma.consortium.findFirst({
    where: { id: consortiumId, clientId: session.clientId },
    select: { id: true },
  });
  if (!consortium) return apiError(new Error("Consorcio no encontrado"), 404);

  // Sólo se acepta lo que está en el catálogo del cliente: la capa 2 no puede
  // habilitar algo que la capa 1 no tiene.
  const [rubrosDelCliente, coefsDelCliente] = await Promise.all([
    prisma.rubro.findMany({ where: { clientId: session.clientId, id: { in: body.rubroIds } }, select: { id: true } }),
    prisma.coeficiente.findMany({ where: { clientId: session.clientId, id: { in: body.coeficienteIds } }, select: { id: true } }),
  ]);
  if (rubrosDelCliente.length !== body.rubroIds.length) {
    return apiError(new Error("Hay rubros que no pertenecen a este cliente"), 400);
  }
  if (coefsDelCliente.length !== body.coeficienteIds.length) {
    return apiError(new Error("Hay coeficientes que no pertenecen a este cliente"), 400);
  }

  // Cuántos gastos fijos quedan sin etiqueta por lo que se está sacando. No bloquea:
  // se informa para que el panel lo muestre, como hace el borrado de un banco.
  const [rubrosHuerfanos, coefsHuerfanos] = await Promise.all([
    prisma.fixedExpense.count({
      where: { consortiumId, rubroId: { not: null, notIn: body.rubroIds } },
    }),
    prisma.fixedExpense.count({
      where: { consortiumId, coeficienteId: { not: null, notIn: body.coeficienteIds } },
    }),
  ]);

  await prisma.$transaction(async (tx) => {
    await tx.consortiumRubro.deleteMany({ where: { consortiumId, rubroId: { notIn: body.rubroIds } } });
    await tx.consortiumCoeficiente.deleteMany({ where: { consortiumId, coeficienteId: { notIn: body.coeficienteIds } } });
    await tx.consortiumRubro.createMany({
      data: body.rubroIds.map((rubroId) => ({ consortiumId, rubroId })),
      skipDuplicates: true,
    });
    await tx.consortiumCoeficiente.createMany({
      data: body.coeficienteIds.map((coeficienteId) => ({ consortiumId, coeficienteId })),
      skipDuplicates: true,
    });
    // Los gastos fijos que apuntaban a algo que ya no está asignado quedan sin etiqueta.
    if (rubrosHuerfanos > 0) {
      await tx.fixedExpense.updateMany({
        where: { consortiumId, rubroId: { not: null, notIn: body.rubroIds } },
        data: { rubroId: null },
      });
    }
    if (coefsHuerfanos > 0) {
      await tx.fixedExpense.updateMany({
        where: { consortiumId, coeficienteId: { not: null, notIn: body.coeficienteIds } },
        data: { coeficienteId: null },
      });
    }
  });

  return apiOk({ rubrosHuerfanos, coefsHuerfanos });
}
```

- [ ] **Step 2: Verificar que compila**

Ejecutar: `npm run typecheck`
Esperado: sin errores.

- [ ] **Step 3: Verificar y avisar**

Ejecutar: `npm run lint`
Avisar: "Task 4 lista para commitear".

---

### Task 5: Rubro y coeficiente en el PATCH del gasto fijo

> **Ojo: `src/app/api/client/consortiums/[id]/fixed-expenses/[fxId]/route.ts` YA EXISTE** con un
> `PATCH` que acepta `{ active, description }` y delega en `FixedExpenseRepository.update`. Esta tarea
> **extiende** ese camino; no crea un endpoint nuevo ni reemplaza el archivo.

**Files:**
- Modify: `src/repositories/fixedExpense.repository.ts:68-82` (el `update`)
- Modify: `src/app/api/client/consortiums/[id]/fixed-expenses/[fxId]/route.ts` (el `patchSchema` y la
  validación de cadena)

- [ ] **Step 1: Ampliar el repositorio**

En `src/repositories/fixedExpense.repository.ts`, el `update` pasa a aceptar los dos campos nuevos:

```typescript
  async update(
    id: string,
    clientId: string,
    data: {
      active?: boolean;
      description?: string | null;
      rubroId?: string | null;
      coeficienteId?: string | null;
    }
  ): Promise<FixedExpense> {
    const fx = await this.prisma.fixedExpense.findFirst({ where: { id, clientId } });
    if (!fx) throw new FixedExpenseError("Gasto fijo no encontrado", 404);
    return this.prisma.fixedExpense.update({
      where: { id },
      data: {
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.rubroId !== undefined ? { rubroId: data.rubroId } : {}),
        ...(data.coeficienteId !== undefined ? { coeficienteId: data.coeficienteId } : {}),
      },
    });
  }
```

- [ ] **Step 2: Ampliar el schema del endpoint y validar la cadena**

En `[fxId]/route.ts`, reemplazar `patchSchema` y agregar la validación antes del `repo.update`:

```typescript
import { getPrismaClient } from "@/lib/prisma";
import { checkAssignable } from "@/lib/rubroAssignment";

/**
 * `rubroId` y `coeficienteId` fijan la regla hacia adelante: las boletas que entren
 * después la heredan. La boleta del mes en curso la corrige el llamador (la hoja
 * manda las dos cosas).
 */
const patchSchema = z.object({
  active: z.boolean().optional(),
  description: z.string().optional().nullable(),
  rubroId: z.string().nullable().optional(),
  coeficienteId: z.string().nullable().optional(),
});
```

y dentro del `try`, después de `parsed.success` y antes de `repo.update`:

```typescript
    // Capa 3: sólo se acepta lo que el edificio tiene asignado en la capa 2.
    if (parsed.data.rubroId !== undefined || parsed.data.coeficienteId !== undefined) {
      const prisma = getPrismaClient();
      const fx = await prisma.fixedExpense.findFirst({
        where: { id: fxId, clientId },
        select: { consortiumId: true },
      });
      if (!fx) {
        return NextResponse.json({ ok: false, error: "Gasto fijo no encontrado" }, { status: 404 });
      }

      if (parsed.data.rubroId !== undefined) {
        const asignados = await prisma.consortiumRubro.findMany({
          where: { consortiumId: fx.consortiumId },
          select: { rubroId: true },
        });
        const check = checkAssignable(parsed.data.rubroId, asignados.map((a) => a.rubroId), "rubro");
        if (!check.ok) return NextResponse.json({ ok: false, error: check.error }, { status: 400 });
      }

      if (parsed.data.coeficienteId !== undefined) {
        const asignados = await prisma.consortiumCoeficiente.findMany({
          where: { consortiumId: fx.consortiumId },
          select: { coeficienteId: true },
        });
        const check = checkAssignable(
          parsed.data.coeficienteId,
          asignados.map((a) => a.coeficienteId),
          "coeficiente"
        );
        if (!check.ok) return NextResponse.json({ ok: false, error: check.error }, { status: 400 });
      }
    }
```

- [ ] **Step 3: Correr los tests del repositorio**

Ejecutar: `npx vitest run src/repositories`
Esperado: PASS. El `update` es retrocompatible — los dos campos nuevos son opcionales, así que
`{ active }` y `{ description }` siguen funcionando igual.

- [ ] **Step 4: Verificar y avisar**

Ejecutar: `npm run typecheck` y `npm run lint`
Avisar: "Task 5 lista para commitear".

---

### Task 6: El pipeline copia al vincular

**Files:**
- Modify: `src/services/obligation.service.ts:81-105`
- Test: `src/services/obligation.service.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `src/services/obligation.service.test.ts`:

```typescript
/** Fake prisma mínimo para linkInvoiceToObligation. */
function makeFakeLinkPrisma(opts: {
  obligations: Array<{
    id: string;
    fixedExpense: {
      providerId: string | null;
      lspServiceId: string | null;
      kind: "FACTURA" | "RETENCION";
      rubroId: string | null;
      coeficienteId: string | null;
    };
  }>;
}) {
  const obligationUpdates: any[] = [];
  const invoiceUpdates: any[] = [];
  return {
    obligationUpdates,
    invoiceUpdates,
    client: {
      expenseObligation: {
        findMany: async () => opts.obligations.map((o, i) => ({ ...o, createdAt: new Date(2026, 0, i + 1) })),
        update: async ({ where, data }: any) => { obligationUpdates.push({ where, data }); return {}; },
      },
      invoice: {
        update: async ({ where, data }: any) => { invoiceUpdates.push({ where, data }); return {}; },
      },
    } as any,
  };
}

describe("linkInvoiceToObligation — rubro y coeficiente", () => {
  it("copia el rubro y el coeficiente del gasto fijo a la boleta", async () => {
    const fake = makeFakeLinkPrisma({
      obligations: [
        {
          id: "ob1",
          fixedExpense: {
            providerId: null, lspServiceId: "l1", kind: "FACTURA",
            rubroId: "r3", coeficienteId: "cA",
          },
        },
      ],
    });
    const linked = await linkInvoiceToObligation(
      { id: "inv1", periodId: "per1", providerId: null, lspServiceId: "l1" },
      fake.client
    );
    expect(linked).toBe(true);
    expect(fake.invoiceUpdates).toHaveLength(1);
    expect(fake.invoiceUpdates[0]).toMatchObject({
      where: { id: "inv1" },
      data: { rubroId: "r3", coeficienteId: "cA" },
    });
  });

  it("no toca la boleta si el gasto fijo no tiene ninguno de los dos", async () => {
    const fake = makeFakeLinkPrisma({
      obligations: [
        {
          id: "ob1",
          fixedExpense: {
            providerId: "p1", lspServiceId: null, kind: "FACTURA",
            rubroId: null, coeficienteId: null,
          },
        },
      ],
    });
    const linked = await linkInvoiceToObligation(
      { id: "inv1", periodId: "per1", providerId: "p1", lspServiceId: null },
      fake.client
    );
    expect(linked).toBe(true);
    expect(fake.invoiceUpdates).toHaveLength(0);
  });
});
```

Agregar `linkInvoiceToObligation` al import del principio del archivo:

```typescript
import { generateObligationsForPeriod, linkInvoiceToObligation, syncObligationsForClient } from "./obligation.service";
```

- [ ] **Step 2: Correr el test y verificar que falla**

Ejecutar: `npx vitest run src/services/obligation.service.test.ts -t "rubro y coeficiente"`
Esperado: FAIL — `expected [] to have a length of 1`

- [ ] **Step 3: Implementar el copiado**

En `src/services/obligation.service.ts`, en `linkInvoiceToObligation`, cambiar el `include` para que
traiga las dos columnas nuevas:

```typescript
    include: { fixedExpense: { select: { providerId: true, lspServiceId: true, kind: true, rubroId: true, coeficienteId: true } } },
```

y reemplazar el bloque final (el `update` de la obligación) por:

```typescript
  await prisma.expenseObligation.update({
    where: { id: target.id },
    data: { status: "RECEIVED", invoiceId: invoice.id },
  });

  // La boleta hereda la etiqueta del gasto fijo. Se copia, no se lee al vuelo: la
  // liquidación de un mes ya emitido no tiene que moverse si mañana se cambia la regla.
  const { rubroId, coeficienteId } = target.fixedExpense;
  if (rubroId || coeficienteId) {
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        ...(rubroId && { rubroId }),
        ...(coeficienteId && { coeficienteId }),
      },
    });
  }

  return true;
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Ejecutar: `npx vitest run src/services/obligation.service.test.ts`
Esperado: PASS, todos los tests del archivo (los viejos incluidos).

- [ ] **Step 5: Correr la red del pipeline**

Ejecutar: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Esperado: PASS. Si algo falla acá, el cambio rompió un camino de salida del pipeline — arreglar antes
de seguir.

- [ ] **Step 6: Verificar y avisar**

Ejecutar: `npm run typecheck`, `npm run lint` y `npm run build:jobs`
Avisar: "Task 6 lista para commitear".

---

### Task 7: El mismo copiado en los otros dos vínculos

`linkInvoiceToObligation` no es el único lugar donde una boleta se ata a una obligación.

**Files:**
- Modify: `src/services/obligation.service.ts` (`generateObligationsForPeriod` y `syncObligationsForClient`)
- Modify: `src/lib/invoicePeriodMove.ts:220`
- Test: `src/services/obligation.service.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Agregar a `src/services/obligation.service.test.ts`:

```typescript
describe("syncObligationsForClient — rubro y coeficiente", () => {
  it("copia la etiqueta del gasto fijo al vincular retroactivamente", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "per1", consortiumId: "c1" }],
      fixedExpenses: [
        { id: "fx1", consortiumId: "c1", providerId: "p1", lspServiceId: null, rubroId: "r5", coeficienteId: "cB" } as any,
      ],
      invoices: [{ id: "inv1", periodId: "per1", providerId: "p1", lspServiceId: null }],
    });
    await syncObligationsForClient("cl1", fake.client);
    expect(fake.invoiceUpdates ?? []).toContainEqual(
      expect.objectContaining({ where: { id: "inv1" }, data: expect.objectContaining({ rubroId: "r5", coeficienteId: "cB" }) })
    );
  });
});
```

Si `makeFakeSyncPrisma` todavía no registra `invoice.update`, agregarle al objeto que devuelve:

```typescript
      invoice: {
        findMany: async () => opts.invoices ?? [],
        update: async ({ where, data }: any) => { invoiceUpdates.push({ where, data }); return {}; },
      },
```

y declarar `const invoiceUpdates: any[] = [];` arriba, devolviéndolo junto a lo demás.

- [ ] **Step 2: Correr el test y verificar que falla**

Ejecutar: `npx vitest run src/services/obligation.service.test.ts -t "syncObligationsForClient — rubro"`
Esperado: FAIL.

- [ ] **Step 3: Implementar en `syncObligationsForClient` y `generateObligationsForPeriod`**

En los dos, el `findMany` de gastos fijos tiene que traer `rubroId` y `coeficienteId`, y donde hoy
marcan la obligación `RECEIVED` con su `invoiceId`, agregar el mismo `prisma.invoice.update`
condicional del Task 6.

Para no repetir la lógica en tres lugares, extraer un helper privado en el mismo archivo y usarlo en
los tres — **incluido `linkInvoiceToObligation`, cuyo bloque inline del Task 6 se reemplaza por una
llamada a este helper**:

```typescript
/**
 * Copia la etiqueta del gasto fijo a la boleta recién vinculada. No pisa con null:
 * un gasto fijo sin rubro no borra el rubro que la boleta pueda tener cargado a mano.
 */
async function copyLabelsToInvoice(
  prisma: PrismaClient,
  invoiceId: string,
  fx: { rubroId: string | null; coeficienteId: string | null }
): Promise<void> {
  if (!fx.rubroId && !fx.coeficienteId) return;
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      ...(fx.rubroId && { rubroId: fx.rubroId }),
      ...(fx.coeficienteId && { coeficienteId: fx.coeficienteId }),
    },
  });
}
```

- [ ] **Step 4: Implementar en `invoicePeriodMove`**

En `src/lib/invoicePeriodMove.ts`, después de la llamada a `linkInvoiceToObligation` (línea ~220), no
hace falta nada: el copiado ya vive adentro de esa función. Verificarlo leyendo el archivo y, si el
move usa otro camino que no pasa por ahí, agregar la llamada al helper.

- [ ] **Step 5: Correr los tests**

Ejecutar: `npx vitest run src/services/obligation.service.test.ts src/lib/invoicePeriodMove.test.ts`
Esperado: PASS.

- [ ] **Step 6: Verificar y avisar**

Ejecutar: `npm run typecheck`, `npm run lint` y `npm run build:jobs`
Avisar: "Task 7 lista para commitear".

---

### Task 8: ABM de rubros y coeficientes en el panel

**Files:**
- Create: `src/app/admin/consortiums/hooks/useCatalogos.ts`
- Create: `src/app/admin/consortiums/components/CatalogosModal.tsx`
- Create: `src/app/admin/consortiums/components/CatalogosModal.test.tsx`
- Modify: `src/app/admin/consortiums/page.tsx` (botón en el sidebar, junto a Bancos)

- [ ] **Step 1: Ampliar los tipos del panel**

En `src/app/admin/consortiums/lib/types.ts`, los dos tipos actuales están incompletos para esta
pantalla (`Rubro` no tiene `order`, `Coeficiente` no tiene `code` y declara `value` como obligatorio
cuando en la base es nullable). Reemplazarlos por:

```typescript
export type Coeficiente = { id: string; name: string; code: string; value: number | null };
export type Rubro = { id: string; name: string; order: number | null; description: string | null };
```

Ejecutar después: `npm run typecheck`. Si algún consumidor viejo se rompe por `value`, ajustarlo ahí
mismo — el tipo nuevo es el que refleja el schema.

- [ ] **Step 2: Escribir el hook**

Crear `src/app/admin/consortiums/hooks/useCatalogos.ts`, con la misma forma que `useBanks.ts` pero
para las dos entidades. El hook expone `rubros`, `coeficientes`, `reload`, `isOpen`, `open`, `close`,
`error`, y `createRubro / updateRubro / removeRubro / createCoeficiente / updateCoeficiente /
removeCoeficiente`, cada uno pegándole a `/api/client/rubros` y `/api/client/coeficientes` con
`guardedFetch`, exactamente como `useBanks` hace con `/api/client/banks`.

Formularios:

```typescript
export type RubroFormValues = { name: string; order: string };
export type CoeficienteFormValues = { code: string; name: string };
```

`order` viaja como string en el formulario y se convierte con `Number(order) || undefined` antes del
fetch: un input vacío no tiene que mandar `0`.

- [ ] **Step 3: Escribir el test del modal que falla**

Crear `src/app/admin/consortiums/components/CatalogosModal.test.tsx`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CatalogosModal } from "./CatalogosModal";

const props = {
  rubros: [
    { id: "r3", name: "SERVICIOS PÚBLICOS", order: 3, description: null },
    { id: "rz", name: "SIN NUMERO", order: null, description: null },
  ],
  coeficientes: [{ id: "cA", code: "A", name: "GASTO A", value: null }],
  rubroForm: { name: "", order: "" },
  coeficienteForm: { code: "", name: "" },
  error: null,
  onChangeRubroForm: vi.fn(),
  onChangeCoeficienteForm: vi.fn(),
  onCreateRubro: vi.fn(),
  onCreateCoeficiente: vi.fn(),
  onRemoveRubro: vi.fn(),
  onRemoveCoeficiente: vi.fn(),
  onClose: vi.fn(),
};

describe("CatalogosModal", () => {
  it("muestra el número del rubro delante del nombre", () => {
    render(<CatalogosModal {...props} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("SERVICIOS PÚBLICOS")).toBeInTheDocument();
  });

  it("un rubro sin número no inventa uno", () => {
    render(<CatalogosModal {...props} />);
    const fila = screen.getByText("SIN NUMERO").closest("tr");
    expect(fila).not.toBeNull();
    expect(fila!.textContent).not.toMatch(/\d/);
  });

  it("lista los coeficientes por código", () => {
    render(<CatalogosModal {...props} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("GASTO A")).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Correr el test y verificar que falla**

Ejecutar: `npx vitest run src/app/admin/consortiums/components/CatalogosModal.test.tsx`
Esperado: FAIL — no existe el módulo.

- [ ] **Step 5: Escribir el modal**

Crear `src/app/admin/consortiums/components/CatalogosModal.tsx` copiando la estructura de
`BanksModal.tsx`: `modalOverlay` → `modalLarge` → título → dos tablas (`lspTableWrap` / `lspTable`),
una de rubros con columnas `#`, `Rubro`, `Acciones`, otra de coeficientes con `Código`, `Nombre`,
`Acciones`; cada una con su `lspAddForm` debajo y su `AsyncButton` de alta. El borrado usa el patrón
de confirmación en línea de `BankRow` (`lspConfirmDelete` / `lspConfirmYes` / `lspConfirmNo`).

El número del rubro se muestra tal cual viene: si `order` es `null`, la celda va vacía.

- [ ] **Step 6: Correr el test y verificar que pasa**

Ejecutar: `npx vitest run src/app/admin/consortiums/components/CatalogosModal.test.tsx`
Esperado: PASS, 3 tests.

- [ ] **Step 7: Colgar el modal del sidebar**

En `src/app/admin/consortiums/page.tsx`, junto al botón **Bancos**, agregar uno **Rubros y
coeficientes** que llame a `catalogos.open()`, y montar `<CatalogosModal … />` donde está montado
`<BanksModal … />`.

- [ ] **Step 8: Verificar en el navegador**

Levantar el server (`preview_start` con `web`), entrar a `/admin/consortiums`, abrir el modal, dar de
alta un rubro con número y uno sin número, y un coeficiente. Confirmar que la lista los ordena por
número con los sin número al final.

- [ ] **Step 9: Verificar y avisar**

Ejecutar: `npm run typecheck`, `npm run lint` y `npx vitest run src/app/admin/consortiums`
Avisar: "Task 8 lista para commitear".

---

### Task 9: Asignar rubros y coeficientes al edificio

**Files:**
- Modify: `src/app/admin/consortiums/components/ConfigModal.tsx`
- Modify: `src/app/admin/consortiums/components/ConfigModal.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

Agregar a `src/app/admin/consortiums/components/ConfigModal.test.tsx`. El helper de ese archivo se
llama **`setup`** (no `renderModal`) y arma el objeto completo de props; hay que sumarle `catalogos`
al objeto base de `setup` además de pasarlo como override, o TypeScript se queja de la prop faltante:

```typescript
describe("sección Rubros y coeficientes", () => {
  it("marca las casillas de lo que el edificio ya tiene asignado", async () => {
    setup({
      openSection: "catalogos",
      catalogos: {
        rubros: [{ id: "r3", name: "SERVICIOS PÚBLICOS", order: 3 }],
        coeficientes: [{ id: "cA", code: "A", name: "GASTO A" }],
        rubroIds: ["r3"],
        coeficienteIds: [],
        onToggleRubro: vi.fn(),
        onToggleCoeficiente: vi.fn(),
        onSave: vi.fn(),
      },
    });
    expect(screen.getByRole("checkbox", { name: /SERVICIOS PÚBLICOS/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /GASTO A/ })).not.toBeChecked();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Ejecutar: `npx vitest run src/app/admin/consortiums/components/ConfigModal.test.tsx -t "Rubros y coeficientes"`
Esperado: FAIL.

- [ ] **Step 3: Agregar la sección**

En `ConfigModal.tsx`, después del bloque `openSection === "bank"` (línea ~99), agregar una sección con
la misma forma (`configSection` → `lspToggle` → `lspContent`), clave `"catalogos"`, título
**Rubros y coeficientes**, descripción *"Del catálogo del cliente, cuáles usa este edificio. Un
edificio sin empleado propio no tiene el rubro 1."*, y dos listas de casillas:

```tsx
<div className={styles.checkboxList}>
  {catalogos.rubros.map((r) => (
    <label key={r.id} className={styles.checkboxRow}>
      <input
        type="checkbox"
        checked={catalogos.rubroIds.includes(r.id)}
        onChange={() => catalogos.onToggleRubro(r.id)}
      />
      <span>{r.order != null ? `${r.order} ` : ""}{r.name}</span>
    </label>
  ))}
</div>
```

y la equivalente para coeficientes, mostrando `${c.code} — ${c.name}`. Debajo, un `AsyncButton`
"Guardar" que llame a `catalogos.onSave()` (PUT a `/api/client/consortiums/[id]/catalogos` con los dos
arrays completos) y que muestre lo que devuelva `rubrosHuerfanos` / `coefsHuerfanos` si vienen en más
de cero: *"N gastos fijos quedaron sin rubro"*.

Si `styles.checkboxList` / `styles.checkboxRow` no existen en `page.module.css`, agregarlos: lista en
columna con `gap: 6px` y filas con `display: flex; align-items: center; gap: 8px`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Ejecutar: `npx vitest run src/app/admin/consortiums/components/ConfigModal.test.tsx`
Esperado: PASS, incluidos los tests viejos.

- [ ] **Step 5: Verificar en el navegador**

Abrir la Configuración de un consorcio, tildar dos rubros y un coeficiente, guardar, recargar y
confirmar que quedaron tildados.

- [ ] **Step 6: Verificar y avisar**

Ejecutar: `npm run typecheck`, `npm run lint` y `npx vitest run src/app/admin/consortiums`
Avisar: "Task 9 lista para commitear".

---

### Task 10: Script de carga inicial del padrón

**Files:**
- Create: `scripts/seed-rubros.ts`

- [ ] **Step 1: Armar el mapeo desde las liquidaciones**

Volcar las liquidaciones a texto con el script que ya existe:

```bash
npx tsx scripts/dump-pdf-text.ts "<ruta del PDF>"
```

De cada archivo salen las secciones `N NOMBRE DEL RUBRO` seguidas de sus líneas de proveedor. El
mapeo que hay que armar es, por edificio, una lista de pares *(texto del proveedor o nro. de cliente,
número de rubro)*.

- [ ] **Step 2: Escribir el script**

Crear `scripts/seed-rubros.ts`:

```typescript
/**
 * Carga inicial de rubros en los gastos fijos, desde lo que dicen las liquidaciones.
 *
 * Idempotente y conservador: sólo escribe donde `rubroId` es null, así que una
 * corrección hecha a mano desde el panel nunca se pisa. No toca el coeficiente:
 * cuando un rubro tiene monto en más de una columna, el texto plano del PDF no dice
 * cuál importe cayó en cuál.
 *
 * Uso:  npx tsx scripts/seed-rubros.ts            (reporta sin escribir)
 *       npx tsx scripts/seed-rubros.ts --apply    (escribe)
 */
import { getPrismaClient } from "../src/lib/prisma";

/** (canonicalName del edificio) → [(nro. de cliente del LSP o canonicalName del proveedor, número de rubro)] */
const MAPEO: Record<string, Array<[string, number]>> = {
  // Se completa en el Step 1 con lo leído de las liquidaciones. Ejemplo real de
  // Bartolomé Mitre 1225, agosto 2026:
  "BARTOLOME MITRE 1225": [
    ["3540951", 3],            // AYSA
    ["182521", 3],             // Edesur
    ["80013706", 3],           // Edesur
    ["664688", 3],             // IPLAN
    ["ASCENSORES BELGRANO", 4],
    ["GESTION CONTINUA S.A.", 4],
  ],
};

async function main() {
  const apply = process.argv.includes("--apply");
  const prisma = getPrismaClient();

  let escritos = 0;
  const sinGastoFijo: string[] = [];
  const sinRubro: string[] = [];

  for (const [consortiumName, pares] of Object.entries(MAPEO)) {
    const consortium = await prisma.consortium.findFirst({
      where: { canonicalName: consortiumName },
      select: { id: true, clientId: true },
    });
    if (!consortium) { sinGastoFijo.push(`${consortiumName}: no existe el consorcio`); continue; }

    const rubros = await prisma.rubro.findMany({
      where: { clientId: consortium.clientId },
      select: { id: true, order: true },
    });
    const rubroPorNumero = new Map(rubros.filter((r) => r.order != null).map((r) => [r.order!, r.id]));

    const fixedExpenses = await prisma.fixedExpense.findMany({
      where: { consortiumId: consortium.id, active: true },
      select: {
        id: true, rubroId: true,
        provider: { select: { canonicalName: true } },
        lspService: { select: { clientNumber: true } },
      },
    });

    for (const [clave, numero] of pares) {
      const rubroId = rubroPorNumero.get(numero);
      if (!rubroId) { sinRubro.push(`${consortiumName}: no hay rubro con número ${numero}`); continue; }

      const fx = fixedExpenses.find(
        (f) => f.lspService?.clientNumber === clave || f.provider?.canonicalName === clave
      );
      if (!fx) { sinGastoFijo.push(`${consortiumName}: "${clave}" no tiene gasto fijo`); continue; }
      if (fx.rubroId) continue; // ya etiquetado: no se pisa

      if (apply) {
        await prisma.fixedExpense.update({ where: { id: fx.id }, data: { rubroId } });
      }
      escritos++;
    }
  }

  console.log(apply ? `Escritos: ${escritos}` : `A escribir: ${escritos} (corré con --apply)`);
  if (sinGastoFijo.length > 0) {
    console.log(`\nLíneas del papel sin gasto fijo (${sinGastoFijo.length}):`);
    for (const s of sinGastoFijo) console.log(`  - ${s}`);
  }
  if (sinRubro.length > 0) {
    console.log(`\nNúmeros de rubro que el catálogo no tiene (${sinRubro.length}):`);
    for (const s of sinRubro) console.log(`  - ${s}`);
  }
}

main();
```

- [ ] **Step 3: Correr en seco**

Ejecutar: `npx tsx scripts/seed-rubros.ts`
Esperado: imprime cuántos escribiría y las dos listas de no-matcheados. **No escribe nada.**

- [ ] **Step 4: Revisar las listas con el owner**

Las dos listas son hallazgos de padrón, como la auditoría de la sesión 68. Antes de aplicar, que el
owner mire qué falta dar de alta.

- [ ] **Step 5: Aplicar**

El owner ejecuta: `npx tsx scripts/seed-rubros.ts --apply`
Esperado: `Escritos: N`. Correrlo dos veces seguidas tiene que dar `Escritos: 0` la segunda.

- [ ] **Step 6: Verificar y avisar**

Ejecutar: `npm run typecheck` y `npm run lint`
Avisar: "Task 10 lista para commitear".

---

### Task 11: Documentación

**Files:**
- Modify: `docs/progreso.md`
- Modify: `docs/decisiones.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: `docs/progreso.md`**

Sección nueva arriba de todo: qué se implementó, qué queda (la Parte 2), y el resultado del script de
carga (cuántos gastos fijos quedaron etiquetados y cuántos no matchearon). Actualizar la línea
"Actualizado al" y la lista de sesiones.

- [ ] **Step 2: `docs/decisiones.md`**

Entrada con fecha 2026-09-24: el problema (rubro y coeficiente existían en el schema y nadie los
llenaba), la decisión (el gasto fijo como unidad que lleva la etiqueta, con la evidencia de Metrogas
caldera/portería), las alternativas descartadas (por proveedor, por oficio, por IA) y el impacto.

- [ ] **Step 3: `CHANGELOG.md`**

Entrada en `[Unreleased] → Added` con el resumen y la mención de la migración.

- [ ] **Step 4: `CLAUDE.md`**

En el schema de base de datos, agregar `ConsortiumRubro` y `ConsortiumCoeficiente` y las dos columnas
de `FixedExpense`. En "Pendientes conocidos", marcar como hecha la línea *"UI para asignar Rubro y
Coeficiente a invoices individuales desde el panel (Stage 2)"* y dejar anotada la Parte 2.

- [ ] **Step 5: Anotar la deuda de tests de endpoint**

El spec pide, en su sección de Testing, que los endpoints se prueben ("que rechacen un rubro o
coeficiente ajeno al edificio"). Este repo **no tiene tests de rutas API** — los únicos son
`routeAuthGuard.test.ts` y `apiHandler.test.ts`, que prueban el plumbing, no los handlers. Este plan
cubre esa exigencia probando la decisión en `checkAssignable` (Task 2), que es donde vive la lógica;
el handler queda sin test propio.

Dejarlo anotado en `docs/progreso.md` como pendiente conocido, para que no se pierda.

- [ ] **Step 6: Verificación final y aviso**

Ejecutar: `npm test`, `npm run typecheck`, `npm run lint` y `npm run build:jobs`
Esperado: todo verde.
Avisar al owner: el trabajo está listo para commitear, con la migración pendiente de aplicar si
todavía no lo hizo.

---

## Parte 2 (plan aparte, después de este)

La hoja de obligaciones agrupada por rubro. Cuatro piezas:

1. `/api/client/obligations/overview` suma el rubro y el coeficiente de cada gasto fijo y de cada
   boleta, más los que el edificio tiene asignados (para armar las columnas).
2. `sheetModel` pasa de devolver una lista de filas a devolver secciones por rubro; se elimina
   `compareRows` y su `GROUP_RANK`.
3. `SheetCard` dibuja los grupos, las columnas de coeficiente con el encabezado de dos niveles, el
   bloque `Sin rubro` al final y la edición inline que escribe la boleta y el gasto fijo de un click.
   **Falta el endpoint de la boleta**: hoy el único `PATCH` sobre una `Invoice` es
   `/api/client/invoices/[id]/late-amount`, así que la Parte 2 tiene que crear
   `/api/client/invoices/[id]/labels` (o equivalente) para el `rubroId` / `coeficienteId` de una
   boleta suelta. El `PATCH` del gasto fijo ya queda listo en el Task 5 de este plan.
4. `sheetPdf` sigue el mismo modelo, con los anchos calculados según cuántos coeficientes tenga cada
   edificio.

Depende de este plan: sin las columnas en `FixedExpense` no hay nada que mostrar.
