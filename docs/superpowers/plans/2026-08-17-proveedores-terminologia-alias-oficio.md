# `_Proveedores`: terminología, alias múltiples y oficio — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: `superpowers:executing-plans` (inline) o
> `superpowers:subagent-driven-development`. Los pasos usan checkboxes (`- [ ]`).

> **⚠️ NO COMMITEAR** — lo hace el owner con GitLens. **⚠️ NO MIGRAR** — Claude crea el `.sql`; el
> owner corre `migrate deploy` + `generate`.

**Goal:** Que la hoja `_Proveedores` hable el idioma del administrador (razón social, nombre fantasía,
alias de pago), admita hasta tres alias por proveedor y sume el oficio de cada uno desde un catálogo
propio.

**Architecture:** La hoja pasa a leerse de `A:F` y aparece `_Oficios` como sexta hoja del ALTA. El
parseo de los alias sale a una función pura con tope de tres. El oficio es un modelo nuevo con la
misma forma que `Rubro`, que se sincroniza **antes** que los proveedores porque la columna F resuelve
un nombre a un id. Los encabezados de `_Proveedores` se corrigen solos cuando difieren.

**Tech Stack:** Next.js 16, TypeScript, Prisma 6 + PostgreSQL, Vitest (`node` y `jsdom`).

**Spec:** `docs/superpowers/specs/2026-08-17-proveedores-terminologia-alias-oficio-design.md`

---

## Contexto que el implementador necesita saber

**Dónde vive cada cosa hoy:**

- `googleSheets.service.ts:343-350` — el array `TABS` con el nombre, los encabezados y el rango de
  cada hoja del ALTA. Los encabezados **sólo se escriben cuando la hoja no existe**.
- `googleSheets.service.ts:405` — `readTab("_Proveedores", "A:E")`, el rango a ampliar.
- `googleSheets.service.ts:420-428` — el `.map` que arma cada proveedor.
- `googleSheets.service.ts:93` — `alias: "ALIAS"` en el mapeo de columnas de la hoja **de boletas**
  (otra hoja, no el ALTA): es la columna I.
- `processPendingDocuments.job.ts:1036` — `extracted.alias = assignment.providerPaymentAlias`, el
  punto único donde el pipeline decide qué texto va a esa celda.
- `sheetModel.ts:155` — `aliasCbu` de la planilla de obligaciones, que se llena con
  `provider.paymentAlias`.
- `sheetPdf.ts:11` y `SheetCard.tsx:84,148` — el encabezado `"ALIAS CBU"` en el PDF y en las dos
  tablas de pantalla.
- `match.ts:41` — el matching por alias de la UI, que se elimina.
- `directorySync.service.ts` — el servicio del sync, con un bloque por entidad.

**Convenciones:** los nombres del ALTA se guardan en mayúsculas (`.trim().toUpperCase()`), como ya
hacen rubros y coeficientes. PowerShell sin `&&`. Tests puros `.test.ts`, UI `.test.tsx`. Textos en
castellano. CSS Modules en modo `pure`.

**Baseline:** 636 tests verdes, typecheck y lint limpios, `c4aa43f` deployado.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/lib/paymentAliases.ts` **(crear)** | `parsePaymentAliases` + los dos formatos de salida |
| `src/lib/paymentAliases.test.ts` **(crear)** | Tope, vacíos, separadores |
| `src/lib/sheetHeaders.ts` **(crear)** | `headersNeedUpdate`: comparar lo que hay con lo esperado |
| `src/lib/sheetHeaders.test.ts` **(crear)** | Igual, distinto, faltante, de más |
| `prisma/schema.prisma` **(modificar)** | Modelo `Oficio` + `Provider.oficioId` |
| `prisma/migrations/20260817000200_oficio/migration.sql` **(crear)** | Tabla + FK |
| `src/services/googleSheets.service.ts` **(modificar)** | Encabezados, `A:F`, `_Oficios`, corrección de headers |
| `src/services/directorySync.service.ts` **(modificar)** | Bloque de oficios + resolución de la columna F |
| `src/jobs/processPendingDocuments.job.ts` **(modificar)** | La celda ALIAS con los tres alias |
| `src/app/admin/obligaciones/lib/sheetModel.ts` **(modificar)** | `aliasCbu` pasa a `string[]` |
| `src/app/admin/obligaciones/lib/sheetPdf.ts` **(modificar)** | Encabezado y celda apilada |
| `src/app/admin/obligaciones/components/SheetCard.tsx` **(modificar)** | Encabezado y celda apilada |
| `src/app/admin/consortiums/lib/match.ts` **(modificar)** | Sale el match por alias |
| `src/app/admin/consortiums/components/InvoiceModal.tsx` **(modificar)** | Primer alias + oficio |
| `src/app/admin/consortiums/lib/types.ts` **(modificar)** | `Provider` gana `oficio` |
| `src/app/api/client/providers/route.ts` **(modificar)** | Devolver el oficio |

---

## Task 1: Los alias de pago

**Files:** `src/lib/paymentAliases.ts`, `src/lib/paymentAliases.test.ts`

- [ ] **Step 1: Test que falla**

Crear `src/lib/paymentAliases.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_PAYMENT_ALIASES, formatAliasesInline, parsePaymentAliases } from "./paymentAliases";

describe("parsePaymentAliases", () => {
  it("uno solo", () => {
    expect(parsePaymentAliases("tigre.pago")).toEqual(["tigre.pago"]);
  });

  it("varios separados por |, sin espacios sobrantes", () => {
    expect(parsePaymentAliases(" tigre.pago | tigre.mp ")).toEqual(["tigre.pago", "tigre.mp"]);
  });

  it("acepta un CBU como valor: no valida el formato", () => {
    expect(parsePaymentAliases("0070999530004012345678")).toEqual(["0070999530004012345678"]);
  });

  it("corta en el tope y no rompe", () => {
    expect(parsePaymentAliases("a|b|c|d|e")).toEqual(["a", "b", "c"]);
    expect(MAX_PAYMENT_ALIASES).toBe(3);
  });

  it("descarta vacíos y separadores consecutivos", () => {
    expect(parsePaymentAliases("a||b|")).toEqual(["a", "b"]);
  });

  it("celda vacía o nula devuelve lista vacía", () => {
    expect(parsePaymentAliases("")).toEqual([]);
    expect(parsePaymentAliases(null)).toEqual([]);
    expect(parsePaymentAliases(undefined)).toEqual([]);
  });
});

describe("formatAliasesInline", () => {
  it("une con separador visible para la celda de Sheets", () => {
    expect(formatAliasesInline("a|b|c")).toBe("a · b · c");
  });

  it("sin alias devuelve string vacío", () => {
    expect(formatAliasesInline(null)).toBe("");
  });
});
```

- [ ] **Step 2: Ver el fallo**

```bash
npx vitest run src/lib/paymentAliases.test.ts
```

- [ ] **Step 3: Implementar**

Crear `src/lib/paymentAliases.ts`:

```ts
/**
 * Alias de pago de un proveedor: hasta 3 valores en un mismo campo, separados
 * por `|` — la misma convención que `matchNames`.
 *
 * Cada valor puede ser un alias o un CBU, indistintamente y sin validar el
 * formato: un CBU se reconoce a simple vista por sus 22 dígitos, así que la
 * columna del papel se titula "ALIAS - CBU" y acepta cualquiera de los dos.
 */
export const MAX_PAYMENT_ALIASES = 3;

/** Separador con el que se muestran juntos en una sola celda. */
export const ALIAS_INLINE_SEPARATOR = " · ";

export function parsePaymentAliases(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split("|")
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, MAX_PAYMENT_ALIASES);
}

/** Para la celda de Google Sheets, que es de una sola línea. */
export function formatAliasesInline(raw: string | null | undefined): string {
  return parsePaymentAliases(raw).join(ALIAS_INLINE_SEPARATOR);
}
```

- [ ] **Step 4: Verde**

```bash
npx vitest run src/lib/paymentAliases.test.ts
```

Esperado: 8 tests en verde.

---

## Task 2: La corrección de encabezados

**Files:** `src/lib/sheetHeaders.ts`, `src/lib/sheetHeaders.test.ts`

- [ ] **Step 1: Test que falla**

Crear `src/lib/sheetHeaders.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { headersNeedUpdate } from "./sheetHeaders";

const ESPERADOS = ["RAZÓN SOCIAL", "CUIT", "NOMBRE FANTASÍA", "ALIAS DE PAGO", "TIPO", "OFICIO"];

describe("headersNeedUpdate", () => {
  it("iguales: no hay nada que escribir", () => {
    expect(headersNeedUpdate(ESPERADOS, ESPERADOS)).toBe(false);
  });

  it("ignora mayúsculas y espacios sobrantes", () => {
    expect(headersNeedUpdate([" razón social ", "cuit", "Nombre Fantasía", "alias de pago", "tipo", "oficio"], ESPERADOS)).toBe(false);
  });

  it("encabezados viejos: hay que corregirlos", () => {
    expect(headersNeedUpdate(["NOMBRE CANÓNICO", "CUIT", "NOMBRES ALTERNATIVOS", "ALIAS", "TIPO"], ESPERADOS)).toBe(true);
  });

  it("falta la columna nueva", () => {
    expect(headersNeedUpdate(["RAZÓN SOCIAL", "CUIT", "NOMBRE FANTASÍA", "ALIAS DE PAGO", "TIPO"], ESPERADOS)).toBe(true);
  });

  it("fila vacía (hoja recién creada a mano)", () => {
    expect(headersNeedUpdate([], ESPERADOS)).toBe(true);
  });

  it("columnas de más a la derecha no importan", () => {
    expect(headersNeedUpdate([...ESPERADOS, "NOTAS"], ESPERADOS)).toBe(false);
  });
});
```

- [ ] **Step 2: Ver el fallo**

```bash
npx vitest run src/lib/sheetHeaders.test.ts
```

- [ ] **Step 3: Implementar**

Crear `src/lib/sheetHeaders.ts`:

```ts
/**
 * Decide si los encabezados de una hoja del ALTA hay que reescribirlos.
 *
 * El sync lee por POSICIÓN, no por nombre de columna, así que los encabezados
 * son informativos: corregirlos no puede romper la lectura. Se comparan sin
 * distinguir mayúsculas ni espacios, y una columna extra a la derecha (algo que
 * el usuario haya agregado por su cuenta) no se considera diferencia.
 */
export function headersNeedUpdate(actual: string[], expected: string[]): boolean {
  const norm = (v: string | undefined) => (v ?? "").trim().toUpperCase();
  return expected.some((exp, i) => norm(actual[i]) !== norm(exp));
}
```

- [ ] **Step 4: Verde**

```bash
npx vitest run src/lib/sheetHeaders.test.ts
```

Esperado: 6 tests en verde.

---

## Task 3: El modelo `Oficio`

**Files:** `prisma/schema.prisma`, `prisma/migrations/20260817000200_oficio/migration.sql`

- [ ] **Step 1: Schema**

Agregar el modelo, al lado de `Rubro`:

```prisma
model Oficio {
  id          String     @id @default(cuid())
  clientId    String
  name        String
  description String?
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
  client      Client     @relation(fields: [clientId], references: [id], onDelete: Cascade)
  providers   Provider[]

  @@unique([clientId, name])
  @@index([clientId])
}
```

En `model Provider`, después de `providerType`:

```prisma
  /// Oficio del proveedor (Pintor, Albañil, Energía…). Etiqueta de catálogo: NO
  /// es el Rubro, que divide las secciones de la liquidación y agrupa oficios.
  oficioId            String?
  oficio              Oficio?              @relation(fields: [oficioId], references: [id], onDelete: SetNull)
```

En `model Client`, junto a las demás colecciones:

```prisma
  oficios       Oficio[]
```

- [ ] **Step 2: `migration.sql`**

Crear `prisma/migrations/20260817000200_oficio/migration.sql`:

```sql
-- Oficio del proveedor: a qué se dedica (Pintor, Albañil, Energía…).
-- NO es el Rubro: el rubro divide las secciones de una liquidación y agrupa
-- varios oficios; el oficio identifica al proveedor uno por uno.
CREATE TABLE "Oficio" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Oficio_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Oficio_clientId_name_key" ON "Oficio"("clientId", "name");
CREATE INDEX "Oficio_clientId_idx" ON "Oficio"("clientId");

ALTER TABLE "Oficio" ADD CONSTRAINT "Oficio_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Borrar un oficio del catálogo deja a sus proveedores sin etiqueta, nunca los borra.
ALTER TABLE "Provider" ADD COLUMN "oficioId" TEXT;
CREATE INDEX "Provider_oficioId_idx" ON "Provider"("oficioId");

ALTER TABLE "Provider" ADD CONSTRAINT "Provider_oficioId_fkey"
  FOREIGN KEY ("oficioId") REFERENCES "Oficio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 3: Validar**

```bash
npx prisma validate
```

Esperado: "The schema at prisma\schema.prisma is valid".

> **El owner corre `migrate deploy` + `generate`.** Hasta entonces el typecheck falla donde se use
> `oficio`/`oficioId`; es esperado.

---

## Task 4: La lectura del ALTA

**Files:** `src/services/googleSheets.service.ts`

- [ ] **Step 1: Los encabezados y la hoja nueva**

En el array `TABS`, reemplazar la línea de `_Proveedores` y sumar `_Oficios`:

```ts
      { name: "_Proveedores", headers: ["RAZÓN SOCIAL", "CUIT", "NOMBRE FANTASÍA", "ALIAS DE PAGO", "TIPO", "OFICIO"], cols: "A:F" },
      { name: "_Oficios",     headers: ["NOMBRE", "DESCRIPCIÓN"],              cols: "A:B" },
```

- [ ] **Step 2: El tipo `DirectoryData`**

En la interfaz, cambiar `providers` y sumar `oficios`:

```ts
  providers: { canonicalName: string; cuit: string | null; matchNames: string | null; paymentAlias: string | null; providerType: ProviderTypeValue; oficioName: string | null }[];
  oficios: { name: string; description: string | null }[];
```

- [ ] **Step 3: Corregir encabezados de `_Proveedores`**

Después del bloque que crea las hojas faltantes, agregar:

```ts
    // Los encabezados sólo se escribían al crear la hoja, así que un ALTA ya
    // existente se quedaba con la terminología vieja. Se corrigen acá: la
    // lectura es por posición, así que reescribirlos no puede romper nada.
    const proveedoresTab = TABS.find((t) => t.name === "_Proveedores")!;
    if (existingTitles.has(proveedoresTab.name)) {
      const headerRow = await this.withRetry(() =>
        this.sheets.spreadsheets.values.get({
          spreadsheetId: this.spreadsheetId,
          range: `${proveedoresTab.name}!1:1`,
        })
      );
      const actual = (headerRow.data.values?.[0] ?? []).map((v) => String(v ?? ""));
      if (headersNeedUpdate(actual, proveedoresTab.headers)) {
        await this.withRetry(() =>
          this.sheets.spreadsheets.values.update({
            spreadsheetId: this.spreadsheetId,
            range: `${proveedoresTab.name}!A1`,
            valueInputOption: "RAW",
            requestBody: { values: [proveedoresTab.headers] },
          })
        );
        console.log("[readDirectory] Encabezados de _Proveedores actualizados a la terminología nueva");
      }
    }
```

Y el import arriba:

```ts
import { headersNeedUpdate } from "@/lib/sheetHeaders";
```

- [ ] **Step 4: Leer las dos hojas**

En el `Promise.all` de `readTab`, cambiar el rango de proveedores y sumar oficios:

```ts
    const [consortiumRows, providerRows, rubroRows, coeficienteRows, lspServiceRows, oficioRows] = await Promise.all([
      readTab("_Consorcios", "A:C"),
      readTab("_Proveedores", "A:F"),
      readTab("_Rubros", "A:B"),
      readTab("_Coeficientes", "A:B"),
      readTab("_LspServices", "A:D"),
      readTab("_Oficios", "A:B"),
    ]);
```

- [ ] **Step 5: Mapear**

En el `return`, el `.map` de proveedores suma el oficio:

```ts
      providers: providerRows
        .map((row) => ({
          canonicalName: row[0]?.toString().trim().toUpperCase() ?? "",
          cuit: row[1]?.toString().trim() || null,
          matchNames: row[2]?.toString().trim() || null,
          paymentAlias: row[3]?.toString().trim() || null,
          providerType: parseProviderType(row[4] as string | undefined),
          oficioName: row[5]?.toString().trim().toUpperCase() || null,
        }))
        .filter((p) => p.canonicalName),
```

Y se agrega el bloque de oficios, con la misma forma que rubros:

```ts
      oficios: oficioRows
        .map((row) => ({
          name: row[0]?.toString().trim().toUpperCase() ?? "",
          description: row[1]?.toString().trim() || null,
        }))
        .filter((o) => o.name),
```

- [ ] **Step 6: Verificar**

```bash
npm run typecheck
```

Esperado: sin errores si el owner ya migró; si no, sólo los de `oficio`.

---

## Task 5: El sync

**Files:** `src/services/directorySync.service.ts`, `src/services/directorySync.service.test.ts`

- [ ] **Step 1: El bloque de oficios**

Antes del bloque `// ---- Proveedores ----`, insertar:

```ts
  // ---- Oficios ----
  // Van ANTES que los proveedores: la columna OFICIO de `_Proveedores` trae un
  // nombre que hay que resolver a un id, y puede referirse a uno recién creado.
  const existingOficios = await prisma.oficio.findMany({
    where: { clientId },
    select: { id: true, name: true, description: true },
  });
  const oficioPlan = planKeyedEntity({
    sheetRows: directory.oficios,
    existing: existingOficios,
    keyOf: (o) => o.name,
    compareFields: ["description"],
    nameOf: (o) => o.name,
  });

  await prisma.$transaction(async (tx) => {
    if (oficioPlan.creates.length > 0) {
      await tx.oficio.createMany({
        data: oficioPlan.creates.map((o) => ({ clientId, name: o.name, description: o.description })),
      });
    }
    await applyUpdates(tx, "Oficio", [{ name: "description", cast: "text" }], oficioPlan.updates);
  }, TX_OPTS);

  const oficiosNow = await prisma.oficio.findMany({
    where: { clientId },
    select: { id: true, name: true },
  });
  const oficioIdByName = new Map(oficiosNow.map((o) => [o.name, o.id]));
```

- [ ] **Step 2: Resolver el oficio de cada proveedor**

Reemplazar la construcción del plan de proveedores por:

```ts
  const existingProviders = await prisma.provider.findMany({
    where: { clientId },
    select: {
      id: true,
      canonicalName: true,
      cuit: true,
      matchNames: true,
      paymentAlias: true,
      providerType: true,
      oficioId: true,
    },
  });

  // La columna OFICIO trae un nombre; acá se convierte en el id que va a la base.
  // Si no está en el catálogo, el proveedor se carga igual y se avisa: un dato de
  // catalogación no puede impedir que se cargue un proveedor.
  const providerSheetRows = directory.providers.map((p) => {
    const oficioId = p.oficioName ? oficioIdByName.get(p.oficioName) ?? null : null;
    if (p.oficioName && !oficioId) {
      warnings.push(
        `El proveedor "${p.canonicalName}" declara el oficio "${p.oficioName}", que no está en la hoja _Oficios.`
      );
    }
    return {
      canonicalName: p.canonicalName,
      cuit: p.cuit,
      matchNames: p.matchNames,
      paymentAlias: p.paymentAlias,
      providerType: p.providerType,
      oficioId,
    };
  });

  const providerPlan = planCuitEntity({
    sheetRows: providerSheetRows,
    existing: existingProviders,
    compareFields: ["cuit", "matchNames", "paymentAlias", "providerType", "oficioId"],
  });
```

En el `createMany` de proveedores, agregar el campo:

```ts
          oficioId: p.oficioId ?? null,
```

Y en la lista de columnas de `applyUpdates` de `Provider`, sumar:

```ts
        { name: "oficioId", cast: "text" },
```

Por último, el reporte suma la entidad. En el tipo `DirectorySyncReport`, después de `lspServices`:

```ts
  oficios: EntityReport;
```

Y en el `return`:

```ts
    oficios: {
      created: oficioPlan.creates.length,
      updated: oficioPlan.updates.length,
      orphans: oficioPlan.orphans,
    },
```

- [ ] **Step 3: Tests**

Agregar a `src/services/directorySync.service.test.ts`, dentro del `describe("syncDirectory")`:

```ts
  it("resuelve el oficio por nombre y avisa cuando no está en el catálogo", async () => {
    const entity = {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    };

    const prisma: any = {
      consortium: entity,
      provider: entity,
      rubro: entity,
      coeficiente: entity,
      lspService: entity,
      oficio: {
        ...entity,
        findMany: vi
          .fn()
          .mockResolvedValueOnce([]) // foto previa: el catálogo está vacío
          .mockResolvedValueOnce([{ id: "of1", name: "PINTOR" }]), // tras crear
      },
      invoice: { groupBy: vi.fn().mockResolvedValue([]) },
      period: { groupBy: vi.fn().mockResolvedValue([]) },
      $transaction: async (fn: any) => fn({ ...prisma, $executeRaw: vi.fn() }),
    };

    const report = await syncDirectory(prisma, "cli1", {
      consortiums: [],
      providers: [
        { canonicalName: "JUAN PINTURAS", cuit: null, matchNames: null, paymentAlias: null, providerType: "PROVEEDOR", oficioName: "PINTOR" },
        { canonicalName: "OTRO", cuit: null, matchNames: null, paymentAlias: null, providerType: "PROVEEDOR", oficioName: "SOLDADOR" },
      ],
      rubros: [],
      coeficientes: [],
      lspServices: [],
      oficios: [{ name: "PINTOR", description: null }],
      warnings: [],
    });

    expect(report.oficios.created).toBe(1);
    expect(report.warnings.some((w) => w.includes('"SOLDADOR"'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('"PINTOR"'))).toBe(false);
  });
```

Los tests existentes de este archivo pasan un `directory` sin `oficios`: agregarles `oficios: []` para
que compile.

- [ ] **Step 4: Verde**

```bash
npx vitest run src/services/directorySync.service.test.ts
```

---

## Task 6: Las tres salidas del alias

**Files:** `processPendingDocuments.job.ts`, `sheetModel.ts`, `sheetPdf.ts`, `SheetCard.tsx` + tests

- [ ] **Step 1: La celda de Google Sheets**

En `src/jobs/processPendingDocuments.job.ts:1036`, reemplazar:

```ts
    extracted.alias = assignment.providerPaymentAlias || null;
```

por:

```ts
    // Un proveedor puede tener hasta 3 alias/CBU; en la celda van todos juntos.
    extracted.alias = formatAliasesInline(assignment.providerPaymentAlias) || null;
```

Y el import arriba del archivo:

```ts
import { formatAliasesInline } from "@/lib/paymentAliases";
```

- [ ] **Step 2: El modelo de la planilla**

En `src/app/admin/obligaciones/lib/sheetModel.ts`, el campo pasa a lista. En las tres declaraciones
de tipo (`SheetRow` y las dos de la API, líneas ~35, ~77 y ~98) cambiar:

```ts
  aliasCbu: string | null;
```

por:

```ts
  /** Hasta 3 alias o CBU del proveedor. Se muestran uno debajo del otro. */
  aliasCbu: string[];
```

En la construcción de la fila del mes (línea ~155):

```ts
        aliasCbu: parsePaymentAliases(lsp ? lspProvider?.paymentAlias : provider?.paymentAlias),
```

En la fila arrastrada (línea ~187):

```ts
        aliasCbu: parsePaymentAliases(inv.aliasCbu),
```

> Ojo: `inv.aliasCbu` viene de la API como `string | null`. El tipo de la API (`OverviewCarried`)
> **no** cambia: sigue siendo el texto crudo con `|`, y se parsea acá.

Import:

```ts
import { parsePaymentAliases } from "@/lib/paymentAliases";
```

- [ ] **Step 3: El PDF**

En `src/app/admin/obligaciones/lib/sheetPdf.ts`, el encabezado:

```ts
  "ALIAS - CBU",
```

Y las dos celdas (líneas ~68 y ~81):

```ts
      row.aliasCbu.join("\n"),
```

- [ ] **Step 4: La tabla en pantalla**

En `src/app/admin/obligaciones/components/SheetCard.tsx`, los dos `<th>`:

```tsx
              <th>ALIAS - CBU</th>
```

Y las dos celdas:

```tsx
                <td>
                  {row.aliasCbu.map((a) => (
                    <div key={a}>{a}</div>
                  ))}
                </td>
```

- [ ] **Step 5: Tests**

Agregar a `src/app/admin/obligaciones/lib/sheetModel.test.ts`:

```ts
  it("parte los alias del proveedor en lista, con tope de 3", () => {
    const conAlias: OverviewPayload = {
      ...payload,
      providers: payload.providers.map((p, i) =>
        i === 0 ? { ...p, paymentAlias: "uno|dos|tres|cuatro" } : p
      ),
    };
    const row = buildSheets(conAlias)[0].rows.find((r) => r.aliasCbu.length > 0)!;
    expect(row.aliasCbu).toEqual(["uno", "dos", "tres"]);
  });

  it("sin alias, la celda queda como lista vacía", () => {
    const row = buildSheets(payload)[0].rows[0];
    expect(Array.isArray(row.aliasCbu)).toBe(true);
  });
```

Y a `src/app/admin/obligaciones/lib/sheetPdf.test.ts`:

```ts
  it("la celda del PDF apila los alias uno debajo del otro", () => {
    const tables = toPdfTables(sheetsConAlias, "Agosto 2026");
    const celda = tables[0].body[0][3];
    expect(celda).toBe("uno\ndos");
  });
```

> Construir `sheetsConAlias` reusando el fixture del propio archivo y seteando
> `aliasCbu: ["uno", "dos"]` en la primera fila.

- [ ] **Step 6: Verde**

```bash
npx vitest run src/app/admin/obligaciones
```

---

## Task 7: La UI de consorcios

**Files:** `match.ts`, `types.ts`, `InvoiceModal.tsx`, `providers/route.ts` + tests

- [ ] **Step 1: Sacar el matching por alias**

En `src/app/admin/consortiums/lib/match.ts:41`, reemplazar:

```ts
      const hit = providers.find((p) => normName(p.canonicalName) === norm || (p.paymentAlias && normName(p.paymentAlias) === norm));
```

por:

```ts
      // Sólo razón social exacta: matchear por alias asignaba la boleta al
      // proveedor equivocado (un alias corto coincide con demasiadas cosas).
      // Mismo criterio que el pipeline, que matchea proveedores sólo por CUIT.
      const hit = providers.find((p) => normName(p.canonicalName) === norm);
```

- [ ] **Step 2: El tipo `Provider` de la UI**

En `src/app/admin/consortiums/lib/types.ts`, el tipo `Provider` suma el oficio:

```ts
export type Provider = {
  id: string; canonicalName: string; cuit: string | null; paymentAlias: string | null;
  providerType?: "PROVEEDOR" | "EMPLEADO" | "SERVICIO";
  oficio?: { name: string } | null;
};
```

- [ ] **Step 3: El endpoint devuelve el oficio**

En `src/app/api/client/providers/route.ts:19`, el `findMany` no usa `select` (devuelve el modelo
entero), así que se le suma un `include`:

```ts
    const providers = await prisma.provider.findMany({
      where: { clientId: auth.session.clientId },
      orderBy: { canonicalName: "asc" },
      include: { oficio: { select: { name: true } } },
    });
```

- [ ] **Step 4: El label del proveedor**

En `src/app/admin/consortiums/components/InvoiceModal.tsx:59`, reemplazar:

```tsx
                  {p.canonicalName}{p.paymentAlias ? ` (${p.paymentAlias})` : ""}{p.providerType === "EMPLEADO" ? " [EMPLEADO]" : ""}
```

por:

```tsx
                  {p.canonicalName}
                  {parsePaymentAliases(p.paymentAlias)[0] ? ` (${parsePaymentAliases(p.paymentAlias)[0]})` : ""}
                  {p.oficio ? ` — ${p.oficio.name}` : ""}
                  {p.providerType === "EMPLEADO" ? " [EMPLEADO]" : ""}
```

Import:

```tsx
import { parsePaymentAliases } from "@/lib/paymentAliases";
```

- [ ] **Step 5: Invertir el test que fijaba el comportamiento viejo**

`src/app/admin/consortiums/lib/match.test.ts:24` tiene hoy un test que verifica **exactamente lo que
se elimina**. Si no se toca, la suite queda en rojo. Reemplazar:

```ts
  it("matchea por alias de pago", () => {
    expect(matchProvider(providers, scanned({ provider: "tigre" }))?.id).toBe("p1");
```

por:

```ts
  // El alias de pago ya NO matchea: es corto y coincide con demasiadas cosas, así
  // que asignaba la boleta al proveedor equivocado. Mismo criterio que el
  // pipeline, que matchea proveedores sólo por CUIT.
  it("NO matchea por alias de pago", () => {
    expect(matchProvider(providers, scanned({ provider: "tigre" }))).toBeUndefined();
```

Y agregar el caso que muestra por qué importa, usando el fixture `providers`/`scanned` que el archivo
ya define arriba:

```ts
  it("ante un alias que es la razón social de otro, gana la razón social", () => {
    const conHomonimo: Provider[] = [
      ...providers,
      { id: "p3", canonicalName: "TIGRE", cuit: null, paymentAlias: null },
    ];
    expect(matchProvider(conHomonimo, scanned({ provider: "tigre" }))?.id).toBe("p3");
  });
```

> Leer el bloque completo antes de editar: el `it` original abarca más de una línea.

- [ ] **Step 6: Verde**

```bash
npx vitest run src/app/admin/consortiums
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

Esperado: 0 errores y ~660 tests.

- [ ] **Step 2: Documentación**

`docs/decisiones.md` — entrada del 2026-08-17: por qué los campos de la base **no** se renombran
(sólo los rótulos de la hoja); por qué los alias van en el mismo campo con `|` y con tope de 3; por
qué el oficio es un catálogo propio y no reusa `Rubro` (el rubro agrupa oficios, es otro nivel); y
por qué se elimina el matching por alias.

`docs/progreso.md` — estado, la migración pendiente y el pendiente del owner (cargar la columna F y
los alias).

`CHANGELOG.md` — entrada en `[Unreleased]`.

`CLAUDE.md` — la tabla del formato ALTA suma la columna F y la hoja `_Oficios`; el schema suma
`Oficio` y `Provider.oficioId`.

- [ ] **Step 3: Avisar**

"Listo para commitear" + la migración pendiente. **No commitear.**

---

## Notas de riesgo

1. **El typecheck falla hasta que el owner migre**: el cliente Prisma no conoce `Oficio` ni
   `oficioId`. Esperado; verificación completa después de `migrate deploy` + `generate`.
2. **`aliasCbu` pasa de `string | null` a `string[]`.** Es un cambio de tipo que toca el modelo, el
   PDF, la tabla y sus tests. El typecheck marca todos los puntos; no dejar ninguno con `?? ""`.
3. **El orden importa en el sync:** oficios antes que proveedores. Invertirlo deja todos los
   `oficioId` en null la primera vez.
4. **No convertir el aviso de oficio inexistente en bloqueo.** El proveedor se carga igual.
5. **Verificar antes de afirmar.** Correr los comandos y leer la salida.
