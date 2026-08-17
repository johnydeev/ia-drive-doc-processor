# Sync de directorio sin borrado + rendimiento — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: `superpowers:executing-plans` (ejecución inline) o
> `superpowers:subagent-driven-development`. Los pasos usan checkboxes (`- [ ]`).

> **⚠️ NO COMMITEAR** — lo hace el owner con GitLens. Donde un plan normal diría "commit", acá dice
> "avisar". **Sin migración**: este plan no toca `prisma/schema.prisma`.

**Goal:** Que sincronizar el directorio no pueda destruir períodos, boletas ni vínculos, que un
renombre en el ALTA se resuelva con confirmación desde la UI, y que el sync baje de ~120 s a segundos.

**Architecture:** Se extrae la decisión a una función pura (`lib/directorySyncPlan.ts`) que recibe la
lectura del ALTA más una foto de la base y devuelve qué crear, qué actualizar, qué renombrar y qué
sobra. Un servicio aplica ese plan con `createMany` + un único `UPDATE ... FROM (VALUES ...)` por
entidad, sin ningún `deleteMany`. La ruta queda fina y aparece una segunda ruta que aplica los
renombres confirmados.

**Tech Stack:** Next.js 16, TypeScript, Prisma 6 + PostgreSQL, Vitest (proyectos `node` y `jsdom`).

**Spec:** `docs/superpowers/specs/2026-08-17-sync-directory-sin-borrado-y-rendimiento-design.md`

---

## Contexto que el implementador necesita saber

**Qué hace hoy el endpoint** (`src/app/api/client/sync-directory/route.ts`, ~350 líneas, sin tests):
lee el archivo ALTA con `altaService.readDirectory()` y corre cinco transacciones. Rubros,
coeficientes y LspServices son `deleteMany` + `createMany`. Consorcios y proveedores son upsert a
mano (mapa en memoria, `createMany` para los nuevos, `Promise.all` de `tx.update` para los
existentes) y después borran los que no están en la hoja.

**Los tres defectos** (medidos, ver spec):
1. el `deleteMany` de huérfanos nunca lanza — las relaciones hijas son `Cascade` — así que borra
   períodos, gastos fijos, obligaciones y servicios en silencio y deja las boletas en null;
2. el reemplazo total de `LspService` cambia el `id` en cada sync, y por `onDelete: SetNull` las
   boletas pierden `lspServiceId` (hoy: 70 boletas de servicios, todas en null);
3. los `Promise.all` de `tx.update` son N round-trips en serie (~500 ms cada uno): 176 proveedores =
   85 s, total 119,9 s contra los 100 s del túnel.

**Uniques que ya existen y habilitan el upsert** (verificados en `prisma/schema.prisma`):
`Consortium(clientId, canonicalName)`, `Provider(clientId, canonicalName)`, `Rubro(clientId, name)`,
`Coeficiente(clientId, code)`, `LspService(consortiumId, providerName, clientNumber)`.

**Tipo de la lectura del ALTA** (`DirectoryData`, `googleSheets.service.ts:127`): `consortiums`
(canonicalName, cuit, matchNames), `providers` (+ paymentAlias, providerType), `rubros` (name,
description), `coeficientes` (code, name), `lspServices` (consortiumName, provider, clientNumber,
description) y `warnings`.

**Convenciones que aplican:** CUIT siempre por `src/lib/cuit.ts` (`cuitDigits` para comparar,
`formatCuit` para guardar) — nunca comparar CUITs con igualdad literal. PowerShell sin `&&`. Tests
puros `.test.ts`, UI `.test.tsx`. Toda acción async en la UI con `AsyncButton`. Textos en castellano.
`requireClientSession` en endpoints de cliente. CSS Modules en modo `pure`: todo selector necesita
una clase local.

**`routeAuthGuard.test.ts` se actualiza solo:** escanea el árbol de `src/app/api` buscando rutas sin
guard. La ruta nueva queda cubierta con sólo usar `requireClientSession`.

**Baseline:** 591 tests verdes, typecheck limpio.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/lib/directorySyncPlan.ts` **(crear)** | Tier 0 puro: hoja + foto de la base → plan (creates / updates / renames / orphans / ambiguous) |
| `src/lib/directorySyncPlan.test.ts` **(crear)** | Tests del plan, incluida la regresión del `id` de LspService |
| `src/lib/bulkUpdate.ts` **(crear)** | Arma el `UPDATE ... FROM (VALUES ...)` parametrizado |
| `src/lib/bulkUpdate.test.ts` **(crear)** | SQL y parámetros generados |
| `src/services/directorySync.service.ts` **(crear)** | Aplica el plan; arma el reporte; aplica renombres confirmados |
| `src/services/directorySync.service.test.ts` **(crear)** | Con un Prisma falso: verifica que no existe ningún `deleteMany` |
| `src/app/api/client/sync-directory/route.ts` **(reescribir)** | Queda fino: auth, config de Google, llamar al servicio |
| `src/app/api/client/sync-directory/renames/route.ts` **(crear)** | `POST` con la lista confirmada |
| `src/app/admin/consortiums/lib/types.ts` **(modificar)** | Tipos del reporte para la UI |
| `src/app/admin/consortiums/hooks/useScheduler.ts` **(modificar)** | Guarda el reporte en vez de descartarlo |
| `src/app/admin/consortiums/hooks/useScheduler.test.tsx` **(crear)** | Tier 1 del handler de sync |
| `src/app/admin/consortiums/components/DirectorySyncModal.tsx` **(crear)** | Reporte + confirmación de renombres |
| `src/app/admin/consortiums/components/DirectorySyncModal.test.tsx` **(crear)** | Tier 2 |
| `src/app/admin/consortiums/page.tsx` **(modificar)** | Monta el modal |

---

## Task 1: El plan puro — entidades con CUIT

**Files:** `src/lib/directorySyncPlan.ts`, `src/lib/directorySyncPlan.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/lib/directorySyncPlan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planCuitEntity } from "./directorySyncPlan";

const CAMPOS = ["cuit", "matchNames"] as const;

function existente(over: Partial<{ id: string; canonicalName: string; cuit: string | null; matchNames: string | null }> = {}) {
  return { id: "c1", canonicalName: "FRIAS 320", cuit: "30-11111111-1", matchNames: null, ...over };
}

describe("planCuitEntity", () => {
  it("sin cambios no produce ningún update", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 320", cuit: "30-11111111-1", matchNames: null }],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.orphans).toEqual([]);
    expect(plan.renames).toEqual([]);
  });

  it("compara el CUIT por dígitos, no por formato", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 320", cuit: "30111111111", matchNames: null }],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.updates).toEqual([]);
  });

  // El update lleva SIEMPRE el valor final de todas las columnas comparables, no
  // sólo el de la que cambió: se escriben todas juntas en un único UPDATE, y una
  // columna ausente se escribiría como null (ver Task 4).
  it("un campo cambiado produce un update con el valor final de todos los campos", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 320", cuit: "30-11111111-1", matchNames: "FRIAS 324" }],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.updates).toEqual([
      { id: "c1", values: { cuit: "30-11111111-1", matchNames: "FRIAS 324" } },
    ]);
  });

  // Blindaje del riesgo #1: dos filas del mismo lote cambian columnas distintas.
  // Si el update de cada una no trajera TODAS las columnas, el UPDATE conjunto
  // escribiría null sobre el dato bueno de la otra.
  it("en un lote mixto, cada update conserva el valor de la columna que no cambió", () => {
    const plan = planCuitEntity({
      sheetRows: [
        { canonicalName: "A", cuit: "30-22222222-2", matchNames: "ALIAS A" },
        { canonicalName: "B", cuit: "30-33333333-3", matchNames: "ALIAS B NUEVO" },
      ],
      existing: [
        { id: "a1", canonicalName: "A", cuit: "30-99999999-9", matchNames: "ALIAS A" },
        { id: "b1", canonicalName: "B", cuit: "30-33333333-3", matchNames: "ALIAS B" },
      ],
      compareFields: CAMPOS,
    });
    expect(plan.updates).toEqual([
      { id: "a1", values: { cuit: "30-22222222-2", matchNames: "ALIAS A" } },
      { id: "b1", values: { cuit: "30-33333333-3", matchNames: "ALIAS B NUEVO" } },
    ]);
  });

  it("una fila que no existe se crea", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "NUEVA 100", cuit: "30-22222222-2", matchNames: null }],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].canonicalName).toBe("NUEVA 100");
  });

  it("lo que está en la base y no en la hoja se reporta, nunca se borra", () => {
    const plan = planCuitEntity({
      sheetRows: [],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.orphans).toEqual([{ id: "c1", name: "FRIAS 320" }]);
    expect(plan).not.toHaveProperty("deletes");
  });

  it("nombre nuevo con el CUIT de uno existente ausente de la hoja = renombre, sin alta", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 324", cuit: "30-11111111-1", matchNames: null }],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.renames).toEqual([
      { id: "c1", from: "FRIAS 320", to: "FRIAS 324", cuit: "30-11111111-1" },
    ]);
    expect(plan.creates).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });

  it("guarda 1: sin CUIT no hay renombre, es un alta", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 324", cuit: null, matchNames: null }],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.renames).toEqual([]);
    expect(plan.creates).toHaveLength(1);
  });

  it("guarda 2: CUIT que matchea a dos es ambiguo, no crea ni renombra", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 324", cuit: "30-11111111-1", matchNames: null }],
      existing: [existente(), existente({ id: "c2", canonicalName: "OTRO 500" })],
      compareFields: CAMPOS,
    });
    expect(plan.renames).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.ambiguous).toEqual(["FRIAS 324"]);
  });

  it("guarda 3: si el CUIT apunta a alguien que la hoja ya nombra, es un alta", () => {
    const plan = planCuitEntity({
      sheetRows: [
        { canonicalName: "FRIAS 320", cuit: "30-11111111-1", matchNames: null },
        { canonicalName: "FRIAS 324", cuit: "30-11111111-1", matchNames: null },
      ],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.renames).toEqual([]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].canonicalName).toBe("FRIAS 324");
  });

  it("el renombrado no aparece además como sobrante", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 324", cuit: "30-11111111-1", matchNames: null }],
      existing: [existente(), existente({ id: "c9", canonicalName: "VIEJO 1", cuit: "30-99999999-9" })],
      compareFields: CAMPOS,
    });
    expect(plan.orphans).toEqual([{ id: "c9", name: "VIEJO 1" }]);
  });

  it("compara los campos extra de proveedor", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "TIGRE", cuit: null, matchNames: null, paymentAlias: "tigre.pago", providerType: "PROVEEDOR" }],
      existing: [{ id: "p1", canonicalName: "TIGRE", cuit: null, matchNames: null, paymentAlias: null, providerType: "PROVEEDOR" }],
      compareFields: ["cuit", "matchNames", "paymentAlias", "providerType"] as const,
    });
    expect(plan.updates).toEqual([
      { id: "p1", values: { cuit: null, matchNames: null, paymentAlias: "tigre.pago", providerType: "PROVEEDOR" } },
    ]);
  });
});
```

- [ ] **Step 2: Correr y ver el fallo**

```bash
npx vitest run src/lib/directorySyncPlan.test.ts
```

Esperado: falla con "Failed to resolve import ./directorySyncPlan".

- [ ] **Step 3: Implementar**

Crear `src/lib/directorySyncPlan.ts`:

```ts
import { cuitDigits, formatCuit } from "./cuit";

/**
 * Decisión pura del sync de directorio: qué crear, qué actualizar, qué renombrar
 * y qué sobra. Sin Prisma y sin red, para poder probar con objetos en memoria.
 *
 * Principio: el ALTA manda sobre el directorio, no sobre los datos operativos.
 * Este módulo NO produce borrados — lo que está en la base y no en la hoja se
 * reporta en `orphans` y se queda.
 */

/** Fila de la hoja para una entidad con CUIT (consorcio o proveedor). */
export type CuitSheetRow = {
  canonicalName: string;
  cuit: string | null;
  matchNames: string | null;
  paymentAlias?: string | null;
  providerType?: string;
};

/** Fila de la base para esas mismas entidades. */
export type CuitExistingRow = CuitSheetRow & { id: string };

/**
 * Un update lleva el valor final de TODAS las columnas comparables, no sólo el de
 * las que cambiaron: el servicio las escribe juntas en un único
 * `UPDATE ... FROM (VALUES ...)`, y una columna que faltara se escribiría como null.
 */
export type EntityUpdate = { id: string; values: Record<string, unknown> };
export type EntityRename = { id: string; from: string; to: string; cuit: string };
export type EntityOrphan = { id: string; name: string };

export type CuitEntityPlan<TRow> = {
  creates: TRow[];
  updates: EntityUpdate[];
  renames: EntityRename[];
  orphans: EntityOrphan[];
  /** Nombres de la hoja cuyo CUIT matchea a más de un registro: no se tocan. */
  ambiguous: string[];
};

/**
 * El CUIT se normaliza al formato canónico antes de comparar y de guardar, igual
 * que hacía el endpoint viejo: las planillas lo traen sin guiones y la base con.
 */
function normalizedValue(field: string, value: unknown): unknown {
  if (field === "cuit") return formatCuit(value as string | null) ?? (value ?? null);
  return value ?? null;
}

export function planCuitEntity<TRow extends CuitSheetRow>({
  sheetRows,
  existing,
  compareFields,
}: {
  sheetRows: TRow[];
  existing: CuitExistingRow[];
  compareFields: readonly string[];
}): CuitEntityPlan<TRow> {
  const byName = new Map(existing.map((e) => [e.canonicalName, e]));
  const namesInSheet = new Set(sheetRows.map((r) => r.canonicalName));

  const byCuit = new Map<string, CuitExistingRow[]>();
  for (const e of existing) {
    const digits = cuitDigits(e.cuit);
    if (!digits) continue;
    const list = byCuit.get(digits) ?? [];
    list.push(e);
    byCuit.set(digits, list);
  }

  const creates: TRow[] = [];
  const updates: EntityUpdate[] = [];
  const renames: EntityRename[] = [];
  const ambiguous: string[] = [];
  const renamedIds = new Set<string>();

  for (const row of sheetRows) {
    const hit = byName.get(row.canonicalName);

    if (hit) {
      const values: Record<string, unknown> = {};
      let dirty = false;
      for (const field of compareFields) {
        const next = normalizedValue(field, (row as Record<string, unknown>)[field]);
        const current = normalizedValue(field, (hit as Record<string, unknown>)[field]);
        values[field] = next;
        if (next !== current) dirty = true;
      }
      if (dirty) updates.push({ id: hit.id, values });
      continue;
    }

    // Candidato a renombre: las tres guardas del spec. El CUIT tiene que existir,
    // apuntar a exactamente un registro, y ese registro no puede estar ya
    // representado por otra fila de la hoja (si lo está, esto es un alta).
    const digits = cuitDigits(row.cuit);
    const candidates = digits
      ? (byCuit.get(digits) ?? []).filter((e) => !namesInSheet.has(e.canonicalName))
      : [];

    if (candidates.length === 1) {
      const target = candidates[0];
      renames.push({
        id: target.id,
        from: target.canonicalName,
        to: row.canonicalName,
        cuit: formatCuit(row.cuit) ?? (row.cuit as string),
      });
      renamedIds.add(target.id);
      continue;
    }

    if (candidates.length > 1) {
      ambiguous.push(row.canonicalName);
      continue;
    }

    creates.push(row);
  }

  const orphans = existing
    .filter((e) => !namesInSheet.has(e.canonicalName) && !renamedIds.has(e.id))
    .map((e) => ({ id: e.id, name: e.canonicalName }));

  return { creates, updates, renames, orphans, ambiguous };
}
```

- [ ] **Step 4: Verde**

```bash
npx vitest run src/lib/directorySyncPlan.test.ts
```

Esperado: 12 tests en verde.

---

## Task 2: El plan puro — entidades por clave natural

**Files:** `src/lib/directorySyncPlan.ts`, `src/lib/directorySyncPlan.test.ts` (ambos: agregar)

- [ ] **Step 1: Tests que fallan**

Agregar al final de `directorySyncPlan.test.ts`:

```ts
import { planKeyedEntity, normalizeLspClientNumber } from "./directorySyncPlan";

describe("planKeyedEntity", () => {
  it("sin cambios no produce updates (rubros)", () => {
    const plan = planKeyedEntity({
      sheetRows: [{ name: "LIMPIEZA", description: null }],
      existing: [{ id: "r1", name: "LIMPIEZA", description: null }],
      keyOf: (r: { name: string }) => r.name,
      compareFields: ["description"],
    });
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
  });

  it("cambia la descripción y conserva el id", () => {
    const plan = planKeyedEntity({
      sheetRows: [{ name: "LIMPIEZA", description: "mensual" }],
      existing: [{ id: "r1", name: "LIMPIEZA", description: null }],
      keyOf: (r: { name: string }) => r.name,
      compareFields: ["description"],
    });
    expect(plan.updates).toEqual([{ id: "r1", values: { description: "mensual" } }]);
  });

  it("lo que falta en la hoja se reporta, no se borra", () => {
    const plan = planKeyedEntity({
      sheetRows: [],
      existing: [{ id: "r1", name: "LIMPIEZA", description: null }],
      keyOf: (r: { name: string }) => r.name,
      compareFields: ["description"],
    });
    expect(plan.orphans).toEqual([{ id: "r1", name: "LIMPIEZA" }]);
  });

  // REGRESIÓN del bug que desvinculó 70 boletas: el servicio que ya existe
  // NO se recrea, así que su id sobrevive y las boletas lo siguen apuntando.
  it("un LspService que no cambió no se crea de nuevo: conserva su id", () => {
    const plan = planKeyedEntity({
      sheetRows: [{ consortiumId: "c1", providerName: "EDESUR", clientNumber: "1061158", description: null }],
      existing: [{ id: "l1", consortiumId: "c1", providerName: "EDESUR", clientNumber: "1061158", description: null }],
      keyOf: (r: { consortiumId: string; providerName: string; clientNumber: string }) =>
        `${r.consortiumId}|${r.providerName}|${r.clientNumber}`,
      compareFields: ["description"],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });
});

describe("normalizeLspClientNumber", () => {
  it("saca espacios y ceros a la izquierda", () => {
    expect(normalizeLspClientNumber(" 00 1061158 ")).toBe("1061158");
  });

  it("si queda vacío devuelve el original", () => {
    expect(normalizeLspClientNumber("000")).toBe("000");
  });
});
```

- [ ] **Step 2: Ver el fallo**

```bash
npx vitest run src/lib/directorySyncPlan.test.ts
```

Esperado: falla, `planKeyedEntity` no está exportado.

- [ ] **Step 3: Implementar**

Agregar al final de `src/lib/directorySyncPlan.ts`:

```ts
export type KeyedEntityPlan<TRow> = {
  creates: TRow[];
  updates: EntityUpdate[];
  orphans: EntityOrphan[];
};

/**
 * Plan para las entidades sin CUIT (rubros, coeficientes, servicios LSP), que se
 * identifican por su clave natural. Reemplaza al viejo `deleteMany` + `createMany`:
 * el registro que ya existe se conserva con su `id`, y por lo tanto conserva
 * también todo lo que lo apunta (boletas, gastos fijos).
 *
 * `nameOf` es sólo para el reporte: qué mostrarle al usuario como sobrante.
 */
export function planKeyedEntity<TRow extends object, TExisting extends TRow & { id: string }>({
  sheetRows,
  existing,
  keyOf,
  compareFields,
  nameOf,
}: {
  sheetRows: TRow[];
  existing: TExisting[];
  keyOf: (row: TRow) => string;
  compareFields: readonly string[];
  nameOf?: (row: TExisting) => string;
}): KeyedEntityPlan<TRow> {
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));
  const keysInSheet = new Set(sheetRows.map(keyOf));

  const creates: TRow[] = [];
  const updates: EntityUpdate[] = [];

  for (const row of sheetRows) {
    const hit = byKey.get(keyOf(row));
    if (!hit) {
      creates.push(row);
      continue;
    }
    const values: Record<string, unknown> = {};
    let dirty = false;
    for (const field of compareFields) {
      const next = (row as Record<string, unknown>)[field] ?? null;
      const current = (hit as Record<string, unknown>)[field] ?? null;
      values[field] = next;
      if (next !== current) dirty = true;
    }
    if (dirty) updates.push({ id: hit.id, values });
  }

  const orphans = existing
    .filter((e) => !keysInSheet.has(keyOf(e)))
    .map((e) => ({ id: e.id, name: nameOf ? nameOf(e) : keyOf(e) }));

  return { creates, updates, orphans };
}

/**
 * Normalización del número de cliente de un LspService. Se preserva literal del
 * endpoint viejo porque forma parte de la clave natural: cambiarla convertiría
 * todos los servicios existentes en registros nuevos.
 */
export function normalizeLspClientNumber(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/^0+/, "") || raw;
}
```

- [ ] **Step 4: Verde**

```bash
npx vitest run src/lib/directorySyncPlan.test.ts
```

Esperado: 18 tests en verde.

---

## Task 3: El helper de update masivo

**Files:** `src/lib/bulkUpdate.ts`, `src/lib/bulkUpdate.test.ts`

- [ ] **Step 1: Test que falla**

Crear `src/lib/bulkUpdate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildBulkUpdate } from "./bulkUpdate";

describe("buildBulkUpdate", () => {
  it("arma un solo UPDATE ... FROM (VALUES ...) con los valores parametrizados", () => {
    const sql = buildBulkUpdate({
      table: "Provider",
      columns: [
        { name: "cuit", cast: "text" },
        { name: "matchNames", cast: "text" },
      ],
      rows: [
        { id: "p1", values: ["30-11111111-1", null] },
        { id: "p2", values: [null, "ALIAS"] },
      ],
    })!;

    expect(sql.sql).toContain('UPDATE "Provider"');
    expect(sql.sql).toContain('"cuit" = v."cuit"::text');
    expect(sql.sql).toContain('"matchNames" = v."matchNames"::text');
    expect(sql.sql).toContain('FROM (VALUES');
    expect(sql.sql).toContain('AS v("id","cuit","matchNames")');
    expect(sql.values).toEqual(["p1", "30-11111111-1", null, "p2", null, "ALIAS"]);
  });

  it("castea el enum con su tipo de Postgres", () => {
    const sql = buildBulkUpdate({
      table: "Provider",
      columns: [{ name: "providerType", cast: '"ProviderType"' }],
      rows: [{ id: "p1", values: ["EMPLEADO"] }],
    })!;
    expect(sql.sql).toContain('"providerType" = v."providerType"::"ProviderType"');
  });

  it("sin filas devuelve null: no hay nada que ejecutar", () => {
    expect(buildBulkUpdate({ table: "Provider", columns: [{ name: "cuit", cast: "text" }], rows: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: Ver el fallo**

```bash
npx vitest run src/lib/bulkUpdate.test.ts
```

- [ ] **Step 3: Implementar**

Crear `src/lib/bulkUpdate.ts`:

```ts
import { Prisma } from "@prisma/client";

export type BulkColumn = {
  /** Nombre de la columna tal cual está en la base. */
  name: string;
  /** Cast de Postgres para el valor parametrizado (`text`, `"ProviderType"`, …). */
  cast: string;
};

export type BulkRow = { id: string; values: unknown[] };

/**
 * Arma un único `UPDATE ... FROM (VALUES ...)` para escribir N filas en una sola
 * query. Reemplaza a los N `tx.update` del sync, que eran N round-trips en serie
 * (~500 ms cada uno) y llevaban el endpoint a 120 s contra los 100 s del túnel.
 *
 * Los VALORES van siempre parametrizados. Los identificadores (tabla y columnas)
 * se interpolan con `Prisma.raw` y por eso deben venir de constantes del código,
 * nunca de entrada del usuario.
 *
 * Devuelve `null` cuando no hay filas: no hay query que correr.
 */
export function buildBulkUpdate({
  table,
  columns,
  rows,
}: {
  table: string;
  columns: BulkColumn[];
  rows: BulkRow[];
}): Prisma.Sql | null {
  if (rows.length === 0 || columns.length === 0) return null;

  const setClause = Prisma.join(
    columns.map((c) => Prisma.raw(`"${c.name}" = v."${c.name}"::${c.cast}`)),
    ", "
  );

  const tuples = Prisma.join(
    rows.map((r) => Prisma.sql`(${Prisma.join([r.id, ...r.values])})`),
    ", "
  );

  const columnList = Prisma.raw(
    ['"id"', ...columns.map((c) => `"${c.name}"`)].join(",")
  );

  return Prisma.sql`
    UPDATE ${Prisma.raw(`"${table}"`)} AS t
    SET ${setClause}
    FROM (VALUES ${tuples}) AS v(${columnList})
    WHERE t."id" = v."id"::text
  `;
}
```

- [ ] **Step 4: Verde**

```bash
npx vitest run src/lib/bulkUpdate.test.ts
```

Esperado: 3 tests en verde.

---

## Task 4: El servicio que aplica el plan

**Files:** `src/services/directorySync.service.ts`, `src/services/directorySync.service.test.ts`

- [ ] **Step 1: Implementar el servicio**

Crear `src/services/directorySync.service.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import { formatCuit } from "@/lib/cuit";
import { buildBulkUpdate, type BulkColumn, type BulkRow } from "@/lib/bulkUpdate";
import {
  normalizeLspClientNumber,
  planCuitEntity,
  planKeyedEntity,
  type EntityOrphan,
  type EntityRename,
  type EntityUpdate,
} from "@/lib/directorySyncPlan";
import type { DirectoryData } from "./googleSheets.service";

export type EntityReport = {
  created: number;
  updated: number;
  orphans: Array<{ id: string; name: string; invoices?: number }>;
};

export type DirectorySyncReport = {
  consortiums: EntityReport;
  providers: EntityReport;
  rubros: EntityReport;
  coeficientes: EntityReport;
  lspServices: EntityReport;
  /** Renombres detectados, pendientes de confirmación del usuario. */
  pendingRenames: Array<EntityRename & { entity: "consortium" | "provider"; invoices: number; periods: number }>;
  ambiguous: string[];
  warnings: string[];
};

const TX_OPTS = { maxWait: 10000, timeout: 120000 };

/**
 * Aplica los updates de una entidad en una sola query.
 *
 * Cada update trae el valor final de todas las columnas comparables (ver
 * `EntityUpdate`), así que la query escribe siempre el mismo juego de columnas y
 * ninguna fila puede quedar con un `null` por no haber estado en el diff.
 */
async function applyUpdates(
  tx: { $executeRaw: (sql: never) => Promise<number> },
  table: string,
  columns: BulkColumn[],
  updates: EntityUpdate[]
): Promise<void> {
  if (updates.length === 0) return;

  const rows: BulkRow[] = updates.map((u) => ({
    id: u.id,
    values: columns.map((c) => u.values[c.name] ?? null),
  }));

  const sql = buildBulkUpdate({ table, columns, rows });
  if (!sql) return;
  await tx.$executeRaw(sql as never);
}

export async function syncDirectory(
  prisma: PrismaClient,
  clientId: string,
  directory: DirectoryData
): Promise<DirectorySyncReport> {
  const warnings = [...directory.warnings];
  const ambiguous: string[] = [];
  const pendingRenames: DirectorySyncReport["pendingRenames"] = [];

  // ---- Consorcios ----
  const existingConsortiums = await prisma.consortium.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true, cuit: true, matchNames: true },
  });

  const consortiumPlan = planCuitEntity({
    sheetRows: directory.consortiums,
    existing: existingConsortiums,
    compareFields: ["cuit", "matchNames"],
  });
  ambiguous.push(...consortiumPlan.ambiguous);

  await prisma.$transaction(async (tx) => {
    if (consortiumPlan.creates.length > 0) {
      await tx.consortium.createMany({
        data: consortiumPlan.creates.map((c) => ({
          clientId,
          canonicalName: c.canonicalName,
          rawName: c.canonicalName,
          cuit: formatCuit(c.cuit) ?? c.cuit,
          matchNames: c.matchNames,
        })),
      });
    }
    await applyUpdates(
      tx as never,
      "Consortium",
      [
        { name: "cuit", cast: "text" },
        { name: "matchNames", cast: "text" },
      ],
      consortiumPlan.updates
    );
  }, TX_OPTS);

  // ---- Proveedores ----
  const existingProviders = await prisma.provider.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true, cuit: true, matchNames: true, paymentAlias: true, providerType: true },
  });

  const providerPlan = planCuitEntity({
    sheetRows: directory.providers,
    existing: existingProviders,
    compareFields: ["cuit", "matchNames", "paymentAlias", "providerType"],
  });
  ambiguous.push(...providerPlan.ambiguous);

  await prisma.$transaction(async (tx) => {
    if (providerPlan.creates.length > 0) {
      await tx.provider.createMany({
        data: providerPlan.creates.map((p) => ({
          clientId,
          canonicalName: p.canonicalName,
          cuit: formatCuit(p.cuit) ?? p.cuit,
          matchNames: p.matchNames,
          paymentAlias: p.paymentAlias ?? null,
          providerType: (p.providerType ?? "PROVEEDOR") as "PROVEEDOR" | "EMPLEADO",
        })),
      });
    }
    await applyUpdates(
      tx as never,
      "Provider",
      [
        { name: "cuit", cast: "text" },
        { name: "matchNames", cast: "text" },
        { name: "paymentAlias", cast: "text" },
        { name: "providerType", cast: '"ProviderType"' },
      ],
      providerPlan.updates
    );
  }, TX_OPTS);

  // ---- Rubros ----
  const existingRubros = await prisma.rubro.findMany({
    where: { clientId },
    select: { id: true, name: true, description: true },
  });
  const rubroPlan = planKeyedEntity({
    sheetRows: directory.rubros,
    existing: existingRubros,
    keyOf: (r) => r.name,
    compareFields: ["description"],
    nameOf: (r) => r.name,
  });

  await prisma.$transaction(async (tx) => {
    if (rubroPlan.creates.length > 0) {
      await tx.rubro.createMany({
        data: rubroPlan.creates.map((r) => ({ clientId, name: r.name, description: r.description })),
      });
    }
    await applyUpdates(tx as never, "Rubro", [{ name: "description", cast: "text" }], rubroPlan.updates);
  }, TX_OPTS);

  // ---- Coeficientes ----
  const existingCoeficientes = await prisma.coeficiente.findMany({
    where: { clientId },
    select: { id: true, code: true, name: true },
  });
  const coeficientePlan = planKeyedEntity({
    sheetRows: directory.coeficientes,
    existing: existingCoeficientes,
    keyOf: (c) => c.code,
    compareFields: ["name"],
    nameOf: (c) => `${c.code} — ${c.name}`,
  });

  await prisma.$transaction(async (tx) => {
    if (coeficientePlan.creates.length > 0) {
      await tx.coeficiente.createMany({
        data: coeficientePlan.creates.map((c) => ({ clientId, code: c.code, name: c.name })),
      });
    }
    await applyUpdates(tx as never, "Coeficiente", [{ name: "name", cast: "text" }], coeficientePlan.updates);
  }, TX_OPTS);

  // ---- LspServices ----
  // Se resuelven DESPUÉS de los consorcios porque necesitan el id de los recién
  // creados. Los que ya existen conservan su id: eso es lo que impide que las
  // boletas pierdan `lspServiceId` (ver spec §1.2).
  const consortiumsNow = await prisma.consortium.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true },
  });
  const consortiumIdByName = new Map(consortiumsNow.map((c) => [c.canonicalName, c.id]));

  const providersNow = await prisma.provider.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true },
  });
  const providerIdByName = new Map(providersNow.map((p) => [p.canonicalName.toUpperCase(), p.id]));

  const lspSheetRows: Array<{ consortiumId: string; providerName: string; clientNumber: string; description: string | null; providerId: string | null }> = [];
  for (const ls of directory.lspServices) {
    const consortiumId = consortiumIdByName.get(ls.consortiumName);
    if (!consortiumId) {
      warnings.push(
        `Servicio ignorado: el consorcio "${ls.consortiumName}" no está en la base (proveedor ${ls.provider}, nro ${ls.clientNumber})`
      );
      continue;
    }
    lspSheetRows.push({
      consortiumId,
      providerName: ls.provider,
      clientNumber: normalizeLspClientNumber(ls.clientNumber),
      description: ls.description,
      providerId: providerIdByName.get(ls.provider.toUpperCase()) ?? null,
    });
  }

  const existingLsp = await prisma.lspService.findMany({
    where: { clientId },
    select: { id: true, consortiumId: true, providerName: true, clientNumber: true, description: true, providerId: true },
  });

  const lspKey = (r: { consortiumId: string; providerName: string; clientNumber: string }) =>
    `${r.consortiumId}|${r.providerName}|${r.clientNumber}`;

  const lspPlan = planKeyedEntity({
    sheetRows: lspSheetRows,
    existing: existingLsp,
    keyOf: lspKey,
    compareFields: ["description", "providerId"],
    nameOf: (l) => `${l.providerName} ${l.clientNumber}`,
  });

  await prisma.$transaction(async (tx) => {
    if (lspPlan.creates.length > 0) {
      await tx.lspService.createMany({
        data: lspPlan.creates.map((l) => ({
          clientId,
          consortiumId: l.consortiumId,
          providerName: l.providerName,
          providerId: l.providerId,
          clientNumber: l.clientNumber,
          description: l.description,
        })),
      });
    }
    await applyUpdates(
      tx as never,
      "LspService",
      [
        { name: "description", cast: "text" },
        { name: "providerId", cast: "text" },
      ],
      lspPlan.updates
    );
  }, TX_OPTS);

  // ---- Conteos para el reporte (una query por entidad, agrupada) ----
  const orphanConsortiumIds = consortiumPlan.orphans.map((o) => o.id);
  const renameConsortiumIds = consortiumPlan.renames.map((r) => r.id);
  const invoiceCounts = await prisma.invoice.groupBy({
    by: ["consortiumId"],
    where: { clientId, consortiumId: { in: [...orphanConsortiumIds, ...renameConsortiumIds] } },
    _count: { _all: true },
  });
  const invoicesByConsortium = new Map(
    invoiceCounts.map((c) => [c.consortiumId, c._count._all])
  );

  const periodCounts = await prisma.period.groupBy({
    by: ["consortiumId"],
    where: { consortiumId: { in: renameConsortiumIds } },
    _count: { _all: true },
  });
  const periodsByConsortium = new Map(periodCounts.map((p) => [p.consortiumId, p._count._all]));

  const providerInvoiceCounts = await prisma.invoice.groupBy({
    by: ["providerId"],
    where: { clientId, providerId: { in: providerPlan.orphans.map((o) => o.id) } },
    _count: { _all: true },
  });
  const invoicesByProvider = new Map(providerInvoiceCounts.map((c) => [c.providerId, c._count._all]));

  for (const r of consortiumPlan.renames) {
    pendingRenames.push({
      ...r,
      entity: "consortium",
      invoices: invoicesByConsortium.get(r.id) ?? 0,
      periods: periodsByConsortium.get(r.id) ?? 0,
    });
  }
  for (const r of providerPlan.renames) {
    pendingRenames.push({ ...r, entity: "provider", invoices: 0, periods: 0 });
  }

  const withCounts = (orphans: EntityOrphan[], counts: Map<string | null, number>) =>
    orphans.map((o) => ({ ...o, invoices: counts.get(o.id) ?? 0 }));

  return {
    consortiums: {
      created: consortiumPlan.creates.length,
      updated: consortiumPlan.updates.length,
      orphans: withCounts(consortiumPlan.orphans, invoicesByConsortium),
    },
    providers: {
      created: providerPlan.creates.length,
      updated: providerPlan.updates.length,
      orphans: withCounts(providerPlan.orphans, invoicesByProvider),
    },
    rubros: { created: rubroPlan.creates.length, updated: rubroPlan.updates.length, orphans: rubroPlan.orphans },
    coeficientes: {
      created: coeficientePlan.creates.length,
      updated: coeficientePlan.updates.length,
      orphans: coeficientePlan.orphans,
    },
    lspServices: {
      created: lspPlan.creates.length,
      updated: lspPlan.updates.length,
      orphans: lspPlan.orphans,
    },
    pendingRenames,
    ambiguous,
    warnings,
  };
}

export type ApplyRenamesResult = { applied: number; skipped: Array<{ id: string; reason: string }> };

/**
 * Aplica los renombres que el usuario confirmó en la UI. Recibe la lista exacta
 * — no vuelve a deducir nada de la hoja — así que es idempotente y no puede
 * tocar nada que el usuario no haya visto en pantalla.
 *
 * Además del nombre, suma el nombre viejo a `matchNames` para que las boletas que
 * traigan impreso el anterior sigan matcheando.
 */
export async function applyRenames(
  prisma: PrismaClient,
  clientId: string,
  renames: Array<{ entity: "consortium" | "provider"; id: string; to: string }>
): Promise<ApplyRenamesResult> {
  let applied = 0;
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const rename of renames) {
    if (rename.entity === "consortium") {
      const current = await prisma.consortium.findFirst({
        where: { id: rename.id, clientId },
        select: { id: true, canonicalName: true, matchNames: true },
      });
      if (!current) { skipped.push({ id: rename.id, reason: "no encontrado" }); continue; }
      if (current.canonicalName === rename.to) { skipped.push({ id: rename.id, reason: "ya tenía ese nombre" }); continue; }

      const clash = await prisma.consortium.findFirst({
        where: { clientId, canonicalName: rename.to },
        select: { id: true },
      });
      if (clash) { skipped.push({ id: rename.id, reason: "el nombre destino ya existe" }); continue; }

      await prisma.consortium.update({
        where: { id: current.id },
        data: {
          canonicalName: rename.to,
          rawName: rename.to,
          matchNames: appendMatchName(current.matchNames, current.canonicalName),
        },
      });
      applied++;
      continue;
    }

    const current = await prisma.provider.findFirst({
      where: { id: rename.id, clientId },
      select: { id: true, canonicalName: true, matchNames: true },
    });
    if (!current) { skipped.push({ id: rename.id, reason: "no encontrado" }); continue; }
    if (current.canonicalName === rename.to) { skipped.push({ id: rename.id, reason: "ya tenía ese nombre" }); continue; }

    const clash = await prisma.provider.findFirst({
      where: { clientId, canonicalName: rename.to },
      select: { id: true },
    });
    if (clash) { skipped.push({ id: rename.id, reason: "el nombre destino ya existe" }); continue; }

    await prisma.provider.update({
      where: { id: current.id },
      data: {
        canonicalName: rename.to,
        matchNames: appendMatchName(current.matchNames, current.canonicalName),
      },
    });
    applied++;
  }

  return { applied, skipped };
}

/** Suma un alias a `matchNames` sin duplicarlo. Separador `|`, como el resto del sistema. */
export function appendMatchName(current: string | null, name: string): string {
  const parts = (current ?? "").split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p.toUpperCase() === name.toUpperCase())) return parts.join(" | ");
  return [...parts, name].join(" | ");
}
```

- [ ] **Step 2: Test del servicio con un Prisma falso**

Crear `src/services/directorySync.service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { appendMatchName } from "./directorySync.service";

describe("appendMatchName", () => {
  it("agrega el nombre viejo cuando no estaba", () => {
    expect(appendMatchName("FRIAS 320/24", "FRIAS 320")).toBe("FRIAS 320/24 | FRIAS 320");
  });

  it("no duplica si ya estaba, sin importar mayúsculas", () => {
    expect(appendMatchName("Frias 320 | Otro", "FRIAS 320")).toBe("Frias 320 | Otro");
  });

  it("desde vacío deja sólo el nombre", () => {
    expect(appendMatchName(null, "FRIAS 320")).toBe("FRIAS 320");
  });
});

describe("syncDirectory", () => {
  it("no ejecuta ningún deleteMany en ninguna entidad", async () => {
    const { syncDirectory } = await import("./directorySync.service");

    const deleteMany = vi.fn();
    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    const findMany = vi.fn().mockResolvedValue([]);
    const groupBy = vi.fn().mockResolvedValue([]);
    const entity = { findMany, createMany, deleteMany, groupBy, findFirst: vi.fn(), update: vi.fn() };

    const prisma: any = {
      consortium: entity,
      provider: entity,
      rubro: entity,
      coeficiente: entity,
      lspService: entity,
      invoice: { groupBy },
      period: { groupBy },
      $transaction: async (fn: any) => fn({ ...prisma, $executeRaw: vi.fn() }),
    };

    const report = await syncDirectory(prisma, "cli1", {
      consortiums: [], providers: [], rubros: [], coeficientes: [], lspServices: [], warnings: [],
    });

    expect(deleteMany).not.toHaveBeenCalled();
    expect(report.consortiums.created).toBe(0);
    expect(report.pendingRenames).toEqual([]);
  });
});
```

- [ ] **Step 3: Verde**

```bash
npx vitest run src/services/directorySync.service.test.ts
```

Esperado: 4 tests en verde.

---

## Task 5: Las rutas

**Files:** `src/app/api/client/sync-directory/route.ts` (reescribir), `src/app/api/client/sync-directory/renames/route.ts` (crear)

- [ ] **Step 1: Adelgazar `sync-directory/route.ts`**

Reemplazar el contenido completo por:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { GoogleSheetsService } from "@/services/googleSheets.service";
import { resolveGoogleConfig } from "@/lib/clientProcessingConfig";
import { syncDirectory } from "@/services/directorySync.service";

export async function POST(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;

  try {
    const startTime = Date.now();
    console.log(`[sync-directory] Iniciando sincronización — clientId=${clientId}`);

    const prisma = getPrismaClient();
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
    }

    const rawConfig = client.googleConfigJson as Record<string, unknown> | null;
    const altaSheetsId = rawConfig?.altaSheetsId as string | undefined;
    if (!altaSheetsId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Configurá el ID del archivo ALTA de Google Sheets antes de sincronizar. " +
            "Creá un archivo llamado 'ALTA' compartido con la cuenta de servicio y pegá su ID en la configuración.",
        },
        { status: 400 }
      );
    }

    // resolveGoogleConfig desencripta la private key. Nunca usar la del JSON crudo.
    const googleConfig = resolveGoogleConfig(client as never);
    if (!googleConfig) {
      return NextResponse.json({ ok: false, error: "Credenciales de Google incompletas" }, { status: 400 });
    }

    const altaService = new GoogleSheetsService({ ...googleConfig, sheetsId: altaSheetsId });
    const directory = await altaService.readDirectory();
    console.log(
      `[sync-directory] Directorio leído — consorcios=${directory.consortiums.length} proveedores=${directory.providers.length} rubros=${directory.rubros.length} coeficientes=${directory.coeficientes.length} lspServices=${directory.lspServices.length}`
    );

    const report = await syncDirectory(prisma, clientId, directory);

    const syncedAt = new Date();
    await prisma.schedulerState.upsert({
      where: { clientId },
      update: { lastDirectorySyncAt: syncedAt },
      create: { clientId, lastDirectorySyncAt: syncedAt },
    });

    console.log(`[sync-directory] ✅ Completado en ${Date.now() - startTime}ms`);
    if (report.warnings.length > 0) {
      console.warn(`[sync-directory] ⚠️ Warnings: ${report.warnings.join(" | ")}`);
    }

    return NextResponse.json({
      ok: true,
      report,
      syncedAt,
      consortiumsCount: directory.consortiums.length,
      providersCount: directory.providers.length,
      rubrosCount: directory.rubros.length,
      coeficientesCount: directory.coeficientes.length,
      lspServicesCount: directory.lspServices.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error al sincronizar";
    if (message.includes("403") || message.includes("PERMISSION_DENIED")) {
      return NextResponse.json(
        {
          ok: false,
          error: "Sin permisos de lectura en el archivo ALTA. Compartilo con la cuenta de servicio de Google.",
        },
        { status: 403 }
      );
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: La ruta de renombres**

Crear `src/app/api/client/sync-directory/renames/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { applyRenames } from "@/services/directorySync.service";

const schema = z.object({
  renames: z
    .array(
      z.object({
        entity: z.enum(["consortium", "provider"]),
        id: z.string().min(1),
        to: z.string().min(1),
      })
    )
    .min(1),
});

/**
 * Aplica los renombres confirmados por el usuario en el modal. Recibe la lista
 * exacta que se mostró en pantalla: no re-deriva nada del archivo ALTA.
 */
export async function POST(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
  }

  const prisma = getPrismaClient();
  const result = await applyRenames(prisma, auth.session.clientId, parsed.data.renames);

  return NextResponse.json({ ok: true, ...result });
}
```

- [ ] **Step 3: Verificar guards y tipos**

```bash
npx vitest run src/app/api/routeAuthGuard.test.ts
```

```bash
npm run typecheck
```

Esperado: guards en verde (la ruta nueva se detecta sola por usar `requireClientSession`) y typecheck sin errores.

---

## Task 6: La UI — el reporte y la confirmación

**Files:** `lib/types.ts`, `hooks/useScheduler.ts` + test, `components/DirectorySyncModal.tsx` + test, `page.tsx`, `page.module.css`

- [ ] **Step 1: Tipos**

Agregar al final de `src/app/admin/consortiums/lib/types.ts`:

```ts
export type SyncOrphan = { id: string; name: string; invoices?: number };
export type SyncEntityReport = { created: number; updated: number; orphans: SyncOrphan[] };
export type SyncPendingRename = {
  entity: "consortium" | "provider";
  id: string;
  from: string;
  to: string;
  cuit: string;
  invoices: number;
  periods: number;
};
export type DirectorySyncReport = {
  consortiums: SyncEntityReport;
  providers: SyncEntityReport;
  rubros: SyncEntityReport;
  coeficientes: SyncEntityReport;
  lspServices: SyncEntityReport;
  pendingRenames: SyncPendingRename[];
  ambiguous: string[];
  warnings: string[];
};
```

- [ ] **Step 2: El hook guarda el reporte**

En `src/app/admin/consortiums/hooks/useScheduler.ts`:

Agregar el import del tipo y el estado, arriba de `handleToggleScheduler`:

```ts
import type { DirectorySyncReport } from "../lib/types";
```

```ts
  const [syncReport, setSyncReport] = useState<DirectorySyncReport | null>(null);
```

Reemplazar el cuerpo de `handleSyncDirectory` por:

```ts
  const handleSyncDirectory = async () => {
    setBusyAction("sync"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/sync-directory", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      // El reporte deja de descartarse: lo consume el modal. Antes sólo se
      // mostraban los contadores en el toast y los avisos se perdían.
      setSyncReport(data.report ?? null);
      const counts = `C: ${data.consortiumsCount ?? 0} | P: ${data.providersCount ?? 0} | R: ${data.rubrosCount ?? 0}`;
      setToolbarInfo(`Directorio sincronizado. ${counts}`);
      onDirectorySynced();
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const applyRenames = async (renames: Array<{ entity: "consortium" | "provider"; id: string; to: string }>) => {
    const res = await guardedFetch("/api/client/sync-directory/renames", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ renames }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setToolbarInfo(`${data.applied} renombre(s) aplicado(s).`);
    setSyncReport(null);
    onDirectorySynced();
  };
```

Y agregar al `return`: `syncReport, closeSyncReport: () => setSyncReport(null), applyRenames,`.

- [ ] **Step 3: Test del hook**

Crear `src/app/admin/consortiums/hooks/useScheduler.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useScheduler } from "./useScheduler";

vi.mock("@/lib/useAuthGuard", () => ({
  useAuthGuard: () => ({ guardedFetch: (...args: unknown[]) => (globalThis.fetch as never)(...(args as [])) }),
}));

const props = {
  accessChecked: false,
  setToolbarInfo: vi.fn(),
  setToolbarError: vi.fn(),
  onDirectorySynced: vi.fn(),
  onInvoicesReload: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

describe("useScheduler — sync de directorio", () => {
  it("guarda el reporte que devuelve el endpoint", async () => {
    const report = {
      consortiums: { created: 1, updated: 2, orphans: [{ id: "c1", name: "FRIAS 320", invoices: 37 }] },
      providers: { created: 0, updated: 0, orphans: [] },
      rubros: { created: 0, updated: 0, orphans: [] },
      coeficientes: { created: 0, updated: 0, orphans: [] },
      lspServices: { created: 0, updated: 0, orphans: [] },
      pendingRenames: [],
      ambiguous: [],
      warnings: [],
    };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, report }) }) as never;

    const { result } = renderHook(() => useScheduler(props));
    await act(async () => { await result.current.handleSyncDirectory(); });

    await waitFor(() => expect(result.current.syncReport).toEqual(report));
    expect(props.onDirectorySynced).toHaveBeenCalled();
  });

  it("applyRenames manda la lista exacta y limpia el reporte", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, applied: 1, skipped: [] }) });
    globalThis.fetch = fetchMock as never;

    const { result } = renderHook(() => useScheduler(props));
    await act(async () => {
      await result.current.applyRenames([{ entity: "consortium", id: "c1", to: "FRIAS 324" }]);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/client/sync-directory/renames",
      expect.objectContaining({
        body: JSON.stringify({ renames: [{ entity: "consortium", id: "c1", to: "FRIAS 324" }] }),
      })
    );
    expect(result.current.syncReport).toBeNull();
  });
});
```

- [ ] **Step 4: El modal**

Crear `src/app/admin/consortiums/components/DirectorySyncModal.tsx`:

```tsx
"use client";

import { useState } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import type { DirectorySyncReport, SyncEntityReport } from "../lib/types";

type Props = {
  report: DirectorySyncReport;
  onClose: () => void;
  onApplyRenames: (renames: Array<{ entity: "consortium" | "provider"; id: string; to: string }>) => Promise<void>;
};

const ETIQUETAS: Array<[keyof DirectorySyncReport, string]> = [
  ["consortiums", "Edificios"],
  ["providers", "Proveedores"],
  ["rubros", "Rubros"],
  ["coeficientes", "Coeficientes"],
  ["lspServices", "Servicios"],
];

export function DirectorySyncModal({ report, onClose, onApplyRenames }: Props) {
  const [seleccionados, setSeleccionados] = useState<Set<string>>(
    () => new Set(report.pendingRenames.map((r) => r.id))
  );

  const toggle = (id: string) =>
    setSeleccionados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const aAplicar = report.pendingRenames.filter((r) => seleccionados.has(r.id));

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Sincronización de directorio</h3>

        <ul className={styles.syncSummary}>
          {ETIQUETAS.map(([clave, etiqueta]) => {
            const r = report[clave] as SyncEntityReport;
            return (
              <li key={clave}>
                <strong>{etiqueta}</strong>: {r.created} nuevos, {r.updated} actualizados
                {r.orphans.length > 0 && ` · ${r.orphans.length} en la base que no están en el ALTA`}
              </li>
            );
          })}
        </ul>

        {report.pendingRenames.length > 0 && (
          <>
            <p className={styles.modalBody}>
              Se detectaron cambios de nombre por CUIT. Ninguno se aplicó todavía.
            </p>
            <ul className={styles.closeAllList}>
              {report.pendingRenames.map((r) => (
                <li key={r.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={seleccionados.has(r.id)}
                      onChange={() => toggle(r.id)}
                    />{" "}
                    <strong>{r.from}</strong> → <strong>{r.to}</strong>
                  </label>
                  <span className={styles.closeAllSkipReason}>
                    CUIT {r.cuit} · {r.invoices} boleta(s) · {r.periods} período(s)
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {report.ambiguous.length > 0 && (
          <p className={styles.modalBody}>
            Sin tocar por ambigüedad de CUIT: {report.ambiguous.join(", ")}
          </p>
        )}

        {report.warnings.length > 0 && (
          <ul className={styles.closeAllList}>
            {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}

        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
          {report.pendingRenames.length > 0 && (
            <AsyncButton
              className={styles.closePeriodConfirmBtn}
              disabled={aAplicar.length === 0}
              pendingLabel="Aplicando…"
              onClick={() => onApplyRenames(aAplicar.map((r) => ({ entity: r.entity, id: r.id, to: r.to })))}
            >
              Aplicar {aAplicar.length} renombre(s)
            </AsyncButton>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Estilo del resumen**

Agregar al final de `src/app/admin/consortiums/page.module.css`:

```css
.syncSummary {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  font-size: 13px;
  line-height: 1.7;
}
```

- [ ] **Step 6: Test del modal**

Crear `src/app/admin/consortiums/components/DirectorySyncModal.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DirectorySyncModal } from "./DirectorySyncModal";
import type { DirectorySyncReport } from "../lib/types";

const vacio = { created: 0, updated: 0, orphans: [] };

const base: DirectorySyncReport = {
  consortiums: { created: 1, updated: 2, orphans: [{ id: "c9", name: "VIEJO 1", invoices: 5 }] },
  providers: vacio, rubros: vacio, coeficientes: vacio, lspServices: vacio,
  pendingRenames: [],
  ambiguous: [],
  warnings: [],
};

const conRenombre: DirectorySyncReport = {
  ...base,
  pendingRenames: [
    { entity: "consortium", id: "c1", from: "FRIAS 320", to: "FRIAS 324", cuit: "30-11111111-1", invoices: 37, periods: 6 },
  ],
};

describe("DirectorySyncModal", () => {
  it("muestra el resumen por entidad y los sobrantes", () => {
    render(<DirectorySyncModal report={base} onClose={vi.fn()} onApplyRenames={vi.fn()} />);
    expect(screen.getByText(/1 nuevos, 2 actualizados/)).toBeInTheDocument();
    expect(screen.getByText(/1 en la base que no están en el ALTA/)).toBeInTheDocument();
  });

  it("sin renombres no ofrece el botón de aplicar", () => {
    render(<DirectorySyncModal report={base} onClose={vi.fn()} onApplyRenames={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /renombre/i })).not.toBeInTheDocument();
  });

  it("muestra el renombre con sus conteos y lo manda al confirmar", async () => {
    const onApplyRenames = vi.fn().mockResolvedValue(undefined);
    render(<DirectorySyncModal report={conRenombre} onClose={vi.fn()} onApplyRenames={onApplyRenames} />);

    expect(screen.getByText(/37 boleta\(s\) · 6 período\(s\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Aplicar 1 renombre/ }));

    expect(onApplyRenames).toHaveBeenCalledWith([{ entity: "consortium", id: "c1", to: "FRIAS 324" }]);
  });

  it("destildar el único renombre deshabilita el botón", async () => {
    render(<DirectorySyncModal report={conRenombre} onClose={vi.fn()} onApplyRenames={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: /Aplicar 0 renombre/ })).toBeDisabled();
  });

  it("cerrar no aplica nada", async () => {
    const onApplyRenames = vi.fn();
    const onClose = vi.fn();
    render(<DirectorySyncModal report={conRenombre} onClose={onClose} onApplyRenames={onApplyRenames} />);
    await userEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(onClose).toHaveBeenCalled();
    expect(onApplyRenames).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Montar el modal en `page.tsx`**

Importar el componente y, donde se renderizan los demás modales, agregar:

```tsx
      {scheduler.syncReport && (
        <DirectorySyncModal
          report={scheduler.syncReport}
          onClose={scheduler.closeSyncReport}
          onApplyRenames={scheduler.applyRenames}
        />
      )}
```

Ubicar el nombre real del objeto del hook con:

```bash
grep -n "useScheduler(" src/app/admin/consortiums/page.tsx
```

- [ ] **Step 8: Verde**

```bash
npx vitest run src/app/admin/consortiums
```

---

## Task 7: Verificación final y documentación

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

Esperado: 0 errores y ~620 tests en verde (591 de base + los ~29 nuevos).

- [ ] **Step 2: Documentación**

`docs/decisiones.md` — entrada del 2026-08-17 con: por qué el `try/catch` de huérfanos no protegía
(relaciones `Cascade`, el `deleteMany` nunca lanza), por qué el reemplazo total desvinculaba boletas
(`id` nuevo + `SetNull`), por qué el renombre se detecta por CUIT y se confirma en la UI en vez de
aplicarse solo, y la aritmética del timeout (~500 ms por registro × 176 = 85 s).

`docs/progreso.md` — estado, sin migración, y el pendiente del owner: smoke visual del modal.

`CHANGELOG.md` — entrada en `[Unreleased]`.

`CLAUDE.md` — la sección "Estrategia de sync por entidad" describe hoy el reemplazo total y el borrado
de huérfanos: reescribirla con el comportamiento nuevo.

- [ ] **Step 3: Avisar**

Decir "listo para commitear" y frenar. **No commitear.**

---

## Notas de riesgo

1. **Todas las columnas en cada update.** `EntityUpdate.values` lleva el valor final de todas las
   columnas comparables, no sólo el de las que cambiaron. Es deliberado: un único
   `UPDATE ... FROM (VALUES ...)` escribe el mismo juego de columnas para todas las filas del lote, y
   si una fila no aportara valor para alguna, se escribiría `null` encima del dato bueno. No
   "optimizar" esto emitiendo sólo las columnas modificadas.
2. **`Prisma.raw` con identificadores.** Tabla y columnas vienen de constantes del código. No aceptar
   nunca nombres de columna derivados de la hoja.
3. **El renombre no crea el registro nuevo.** Si el usuario cancela, el edificio "nuevo" no existe
   hasta que confirme o cambie el CUIT en la hoja. Es intencional (evita el duplicado), pero conviene
   verlo en el smoke.
4. **Verificar antes de afirmar.** Correr los comandos y leer la salida.
