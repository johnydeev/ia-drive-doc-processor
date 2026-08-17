# `SERVICIO` en `ProviderType` — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: `superpowers:executing-plans` (inline) o
> `superpowers:subagent-driven-development`. Los pasos usan checkboxes (`- [ ]`).

> **⚠️ NO COMMITEAR** — lo hace el owner con GitLens. **⚠️ NO MIGRAR** — Claude crea los `.sql`; el
> owner corre `migrate deploy` + `generate`.

**Goal:** Que el catálogo distinga a las empresas de servicios (Edesur, AySA, Metrogas…) de los
proveedores comunes y de los empleados, y que el sync avise cuando un `LspService` apunta a un
proveedor que no está marcado como tal.

**Architecture:** Un tercer valor del enum `ProviderType`, cargado desde la columna E de la hoja
`_Proveedores`. El parseo de esa columna sale de `readDirectory` a una función pura testeable. La
validación vive donde el sync arma los servicios y sólo agrega un aviso al reporte: no bloquea.

**Tech Stack:** Next.js 16, TypeScript, Prisma 6 + PostgreSQL, Vitest (`node` y `jsdom`).

**Spec:** `docs/superpowers/specs/2026-08-17-provider-type-servicio-design.md`

---

## Contexto que el implementador necesita saber

**Qué existe hoy.** `ProviderType` tiene `PROVEEDOR` y `EMPLEADO`. La hoja `_Proveedores` ya se lee de
`A:E` y la columna E ("TIPO") se parsea inline en `googleSheets.service.ts:422-428`: todo lo que no
sea `EMPLEADO` cae a `PROVEEDOR`. El campo no es inerte — `EMPLEADO` cambia comportamiento real:

- `PagosView.tsx`: un empleado se paga por el total (no hay input de monto parcial) y suma distinto
  en las métricas — 4 comparaciones contra `"EMPLEADO"`.
- `InvoiceModal.tsx`: muestra "CUIL emisor" en vez de "CUIT emisor" y un badge `[EMPLEADO]`.

Como todas preguntan por `EMPLEADO`, `SERVICIO` cae solo en la rama de proveedor común. Eso es lo
correcto, y la Task 4 lo fija con un test.

**Por qué dos migraciones.** Postgres rechaza usar un valor de enum dentro de la misma transacción
que lo agregó (`unsafe use of new value of enum type`), y Prisma corre cada migración en una
transacción. Entonces: una migración agrega el valor, otra hace el backfill.

**Fuente de verdad.** La hoja manda, igual que el resto del directorio. El backfill deja el estado
correcto desde el arranque, pero si el owner no escribe `SERVICIO` en la columna E, el próximo sync
los devuelve a `PROVEEDOR`. Es el comportamiento decidido, no un bug.

**Convenciones:** PowerShell sin `&&`. Tests puros `.test.ts`, UI `.test.tsx`. Textos en castellano.

**Baseline:** 627 tests verdes, typecheck y lint limpios.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `prisma/schema.prisma` **(modificar)** | `SERVICIO` en el enum |
| `prisma/migrations/20260817000000_provider_type_servicio/migration.sql` **(crear)** | Sólo el `ADD VALUE` |
| `prisma/migrations/20260817000100_backfill_provider_type_servicio/migration.sql` **(crear)** | El backfill |
| `src/lib/providerType.ts` **(crear)** | `parseProviderType`: texto de la hoja → valor del enum |
| `src/lib/providerType.test.ts` **(crear)** | Los cuatro casos |
| `src/services/googleSheets.service.ts` **(modificar)** | Usa la función pura; el tipo de `DirectoryData` |
| `src/services/directorySync.service.ts` **(modificar)** | Aviso cuando el servicio apunta a un no-SERVICIO |
| `src/services/directorySync.service.test.ts` **(modificar)** | Test del aviso |
| `src/app/admin/consortiums/lib/types.ts` **(modificar)** | Dos uniones escritas a mano |
| `src/app/admin/consortiums/components/PagosView.test.tsx` **(modificar)** | Regresión: SERVICIO ≠ EMPLEADO |

---

## Task 1: El enum y las dos migraciones

**Files:** `prisma/schema.prisma`, las dos carpetas de `prisma/migrations/`

- [ ] **Step 1: Schema**

En `prisma/schema.prisma`, el enum queda así:

```prisma
enum ProviderType {
  PROVEEDOR
  EMPLEADO
  /// Empresa de servicios (Edesur, AySA, Metrogas…). Es la que puede tener
  /// LspService con número de cliente por consorcio.
  SERVICIO
}
```

- [ ] **Step 2: Migración 1 — sólo el valor**

Crear `prisma/migrations/20260817000000_provider_type_servicio/migration.sql`:

```sql
-- Tercer tipo de proveedor: empresa de servicios (Edesur, AySA, Metrogas…).
-- Va SOLO en esta migración: Postgres no permite usar un valor de enum dentro de
-- la misma transacción que lo agregó, y Prisma corre cada migración en una.
-- El backfill va en la migración siguiente.
ALTER TYPE "ProviderType" ADD VALUE 'SERVICIO';
```

- [ ] **Step 3: Migración 2 — el backfill**

Crear `prisma/migrations/20260817000100_backfill_provider_type_servicio/migration.sql`:

```sql
-- Marca como SERVICIO a los proveedores que ya tienen al menos un LspService.
-- Deja el estado correcto desde el arranque, sin depender de que la hoja ALTA se
-- actualice primero. La fuente de verdad sigue siendo la columna E del ALTA: si
-- no dice SERVICIO, el próximo sync los devuelve a PROVEEDOR.
UPDATE "Provider" SET "providerType" = 'SERVICIO'
WHERE id IN (SELECT DISTINCT "providerId" FROM "LspService" WHERE "providerId" IS NOT NULL);
```

- [ ] **Step 4: Validar el schema**

```bash
npx prisma validate
```

Esperado: "The schema at prisma\schema.prisma is valid".

> **El owner corre `migrate deploy` + `generate`.** Hasta que lo haga, el cliente Prisma no conoce
> `SERVICIO` y el typecheck de las tareas siguientes va a fallar donde se use el literal. Es esperado:
> avisar y correr la verificación completa después de la migración.

---

## Task 2: `parseProviderType` puro

**Files:** `src/lib/providerType.ts`, `src/lib/providerType.test.ts`, `src/services/googleSheets.service.ts`

- [ ] **Step 1: Test que falla**

Crear `src/lib/providerType.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseProviderType } from "./providerType";

describe("parseProviderType", () => {
  it("reconoce SERVICIO", () => {
    expect(parseProviderType("SERVICIO")).toBe("SERVICIO");
  });

  it("reconoce EMPLEADO", () => {
    expect(parseProviderType("EMPLEADO")).toBe("EMPLEADO");
  });

  it("ignora mayúsculas y espacios de la celda", () => {
    expect(parseProviderType("  servicio ")).toBe("SERVICIO");
    expect(parseProviderType(" Empleado")).toBe("EMPLEADO");
  });

  it("celda vacía o ausente cae a PROVEEDOR", () => {
    expect(parseProviderType("")).toBe("PROVEEDOR");
    expect(parseProviderType(undefined)).toBe("PROVEEDOR");
    expect(parseProviderType(null)).toBe("PROVEEDOR");
  });

  // Sesgo conservador: un valor que no entendemos NO convierte al proveedor en
  // otra cosa. PROVEEDOR es el default de la columna en la base.
  it("texto no reconocido cae a PROVEEDOR", () => {
    expect(parseProviderType("PRESTADOR")).toBe("PROVEEDOR");
  });
});
```

- [ ] **Step 2: Correr y ver el fallo**

```bash
npx vitest run src/lib/providerType.test.ts
```

Esperado: falla con "Failed to resolve import ./providerType".

- [ ] **Step 3: Implementar**

Crear `src/lib/providerType.ts`:

```ts
/** Los tres tipos de proveedor del catálogo. Espeja `enum ProviderType` de Prisma. */
export type ProviderTypeValue = "PROVEEDOR" | "EMPLEADO" | "SERVICIO";

/**
 * Traduce la columna "TIPO" (E) de la hoja `_Proveedores` a un valor del enum.
 *
 * Ante una celda vacía o un texto que no reconocemos devuelve `PROVEEDOR`, que es
 * el default de la columna en la base: un dato mal escrito no convierte a un
 * proveedor en empleado ni en empresa de servicios.
 */
export function parseProviderType(raw: string | null | undefined): ProviderTypeValue {
  const value = raw?.trim().toUpperCase();
  if (value === "EMPLEADO") return "EMPLEADO";
  if (value === "SERVICIO") return "SERVICIO";
  return "PROVEEDOR";
}
```

- [ ] **Step 4: Verde**

```bash
npx vitest run src/lib/providerType.test.ts
```

Esperado: 6 tests en verde.

- [ ] **Step 5: Cablearlo en `readDirectory`**

En `src/services/googleSheets.service.ts`, agregar el import arriba con los demás:

```ts
import { parseProviderType, type ProviderTypeValue } from "@/lib/providerType";
```

En el tipo `DirectoryData` (línea ~131), cambiar el campo de `providers`:

```ts
  providers: { canonicalName: string; cuit: string | null; matchNames: string | null; paymentAlias: string | null; providerType: ProviderTypeValue }[];
```

Y reemplazar el bloque del `.map` de `providers` (líneas ~420-430) por:

```ts
      providers: providerRows
        .map((row) => ({
          canonicalName: row[0]?.toString().trim().toUpperCase() ?? "",
          cuit: row[1]?.toString().trim() || null,
          matchNames: row[2]?.toString().trim() || null,
          paymentAlias: row[3]?.toString().trim() || null,
          providerType: parseProviderType(row[4] as string | undefined),
        }))
        .filter((p) => p.canonicalName),
```

- [ ] **Step 6: Verificar**

```bash
npm run typecheck
```

Esperado: sin errores **si el owner ya migró**. Si todavía no migró, el único error admisible es que
el cliente Prisma no conoce `SERVICIO`.

---

## Task 3: El aviso en el sync

**Files:** `src/services/directorySync.service.ts`, `src/services/directorySync.service.test.ts`

- [ ] **Step 1: Ampliar la foto de proveedores**

En `syncDirectory`, la query que arma `providerIdByName` (busca por `providersNow`) hoy trae sólo
`id` y `canonicalName`. Reemplazarla por:

```ts
  const providersNow = await prisma.provider.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true, providerType: true },
  });
  const providerByName = new Map(providersNow.map((p) => [p.canonicalName.toUpperCase(), p]));
```

- [ ] **Step 2: Usar el mapa nuevo y avisar**

En el `for (const ls of directory.lspServices)`, reemplazar la resolución del proveedor por:

```ts
    const provider = providerByName.get(ls.provider.toUpperCase()) ?? null;

    // El tipo no condiciona el vínculo con la boleta (eso lo resuelve el pipeline
    // por número de cliente), así que esto avisa y sigue: bloquear dejaría
    // servicios sin cargar por un dato de catalogación.
    if (provider && provider.providerType !== "SERVICIO") {
      warnings.push(
        `El proveedor "${ls.provider}" tiene servicios cargados pero no está marcado como SERVICIO en el ALTA (columna TIPO).`
      );
    }

    lspSheetRows.push({
      consortiumId,
      providerName: ls.provider,
      clientNumber: normalizeLspClientNumber(ls.clientNumber),
      description: ls.description,
      providerId: provider?.id ?? null,
    });
```

- [ ] **Step 3: Tests del aviso**

Agregar a `src/services/directorySync.service.test.ts`, dentro del `describe("syncDirectory")`:

```ts
  it("avisa cuando un servicio apunta a un proveedor que no es SERVICIO, pero lo crea igual", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const consortiumRows = [{ id: "c1", canonicalName: "FRIAS 324", cuit: null, matchNames: null }];
    const providerRows = [
      { id: "p1", canonicalName: "EDESUR S.A.", cuit: null, matchNames: null, paymentAlias: null, providerType: "PROVEEDOR" },
    ];

    const entity = {
      findMany: vi.fn().mockResolvedValue([]),
      createMany,
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    };

    const prisma: any = {
      consortium: { ...entity, findMany: vi.fn().mockResolvedValue(consortiumRows) },
      provider: { ...entity, findMany: vi.fn().mockResolvedValue(providerRows) },
      rubro: entity,
      coeficiente: entity,
      lspService: { ...entity, findMany: vi.fn().mockResolvedValue([]) },
      invoice: { groupBy: vi.fn().mockResolvedValue([]) },
      period: { groupBy: vi.fn().mockResolvedValue([]) },
      $transaction: async (fn: any) => fn({ ...prisma, $executeRaw: vi.fn() }),
    };

    const report = await syncDirectory(prisma, "cli1", {
      consortiums: [{ canonicalName: "FRIAS 324", cuit: null, matchNames: null }],
      providers: [],
      rubros: [],
      coeficientes: [],
      lspServices: [
        { consortiumName: "FRIAS 324", provider: "EDESUR S.A.", clientNumber: "1061158", description: null },
      ],
      warnings: [],
    });

    expect(report.warnings.some((w) => w.includes("no está marcado como SERVICIO"))).toBe(true);
    expect(report.lspServices.created).toBe(1);
  });

  it("un proveedor marcado SERVICIO no genera aviso", async () => {
    const consortiumRows = [{ id: "c1", canonicalName: "FRIAS 324", cuit: null, matchNames: null }];
    const providerRows = [
      { id: "p1", canonicalName: "EDESUR S.A.", cuit: null, matchNames: null, paymentAlias: null, providerType: "SERVICIO" },
    ];

    const entity = {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    };

    const prisma: any = {
      consortium: { ...entity, findMany: vi.fn().mockResolvedValue(consortiumRows) },
      provider: { ...entity, findMany: vi.fn().mockResolvedValue(providerRows) },
      rubro: entity,
      coeficiente: entity,
      lspService: { ...entity, findMany: vi.fn().mockResolvedValue([]) },
      invoice: { groupBy: vi.fn().mockResolvedValue([]) },
      period: { groupBy: vi.fn().mockResolvedValue([]) },
      $transaction: async (fn: any) => fn({ ...prisma, $executeRaw: vi.fn() }),
    };

    const report = await syncDirectory(prisma, "cli1", {
      consortiums: [{ canonicalName: "FRIAS 324", cuit: null, matchNames: null }],
      providers: [],
      rubros: [],
      coeficientes: [],
      lspServices: [
        { consortiumName: "FRIAS 324", provider: "EDESUR S.A.", clientNumber: "1061158", description: null },
      ],
      warnings: [],
    });

    expect(report.warnings).toEqual([]);
  });
```

- [ ] **Step 4: Verde**

```bash
npx vitest run src/services/directorySync.service.test.ts
```

Esperado: 7 tests en verde (5 previos + 2 nuevos).

---

## Task 4: Los tipos de la UI y la regresión

**Files:** `src/app/admin/consortiums/lib/types.ts`, `src/app/admin/consortiums/components/PagosView.test.tsx`

- [ ] **Step 1: Las dos uniones**

En `src/app/admin/consortiums/lib/types.ts` hay dos uniones escritas a mano (líneas ~30 y ~42, en
`Provider` e `Invoice`). Cambiar ambas por:

```ts
  providerType?: "PROVEEDOR" | "EMPLEADO" | "SERVICIO";
```

- [ ] **Step 2: El cast del servicio**

En `src/services/directorySync.service.ts`, el `createMany` de proveedores tiene:

```ts
          providerType: (p.providerType ?? "PROVEEDOR") as "PROVEEDOR" | "EMPLEADO",
```

Reemplazarlo por:

```ts
          providerType: (p.providerType ?? "PROVEEDOR") as ProviderTypeValue,
```

Y agregar el import arriba:

```ts
import type { ProviderTypeValue } from "@/lib/providerType";
```

- [ ] **Step 3: Test de regresión en `PagosView`**

Agregar a `src/app/admin/consortiums/components/PagosView.test.tsx`, dentro del `describe`:

```ts
  // SERVICIO es un proveedor común a los fines del pago: se paga parcial y tiene
  // input de monto. Sólo EMPLEADO se paga por el total.
  it("una boleta de un proveedor SERVICIO se paga como proveedor, no como empleado", () => {
    render(
      <PagosView
        invoices={[baseInvoice({ id: "i3", provider: "EDESUR", providerType: "SERVICIO", amount: 1000 })]}
        {...noop}
      />
    );
    expect(screen.getByPlaceholderText("1.000,00")).toBeInTheDocument();
  });

  it("una boleta de un EMPLEADO no ofrece input de monto parcial", () => {
    render(
      <PagosView
        invoices={[baseInvoice({ id: "i4", provider: "JUAN PEREZ", providerType: "EMPLEADO", amount: 1000 })]}
        {...noop}
      />
    );
    expect(screen.queryByPlaceholderText("1.000,00")).not.toBeInTheDocument();
  });
```

> El placeholder sale de `formatAmountPlain` (`lib/format.ts:15`), que usa `Intl.NumberFormat` en
> `es-AR` con dos decimales: para `amount: 1000` es exactamente `"1.000,00"`.

- [ ] **Step 4: Verde**

```bash
npx vitest run src/app/admin/consortiums/components/PagosView.test.tsx
```

---

## Task 5: Verificación final y documentación

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

Esperado: 0 errores y ~637 tests (627 de base + los 10 nuevos).

- [ ] **Step 2: Documentación**

`docs/decisiones.md` — entrada del 2026-08-17: por qué un tercer valor del enum y no un booleano
paralelo; por qué la hoja es la fuente de verdad y qué implica (el sync revierte lo que la hoja no
diga); por qué van dos migraciones; y por qué la validación avisa en vez de bloquear.

`docs/progreso.md` — estado, las dos migraciones pendientes y el pendiente del owner (cargar
`SERVICIO` en la columna E).

`CHANGELOG.md` — entrada en `[Unreleased]`.

`CLAUDE.md` — la tabla de la hoja `_Proveedores` describe la columna E; agregar el valor nuevo y la
regla de que un `LspService` debería apuntar a un proveedor `SERVICIO`.

- [ ] **Step 3: Avisar**

Decir "listo para commitear", nombrar **las dos migraciones pendientes** y recordar la carga de la
columna E. **No commitear.**

---

## Notas de riesgo

1. **El typecheck falla hasta que el owner migre.** El cliente Prisma no conoce `SERVICIO`, así que
   cualquier uso del literal contra un tipo de Prisma da error. Es esperado; la verificación completa
   se corre después de `migrate deploy` + `generate`.
2. **El backfill se pisa si la hoja no dice `SERVICIO`.** Es la decisión tomada (la hoja manda), pero
   conviene que el owner cargue la columna E **antes** del próximo sync para no ver 8-10 avisos.
3. **No convertir el aviso en bloqueo.** Un `LspService` que no se crea deja boletas sin vincular, que
   es peor que un dato de catálogo desactualizado.
4. **Verificar antes de afirmar.** Correr los comandos y leer la salida.
