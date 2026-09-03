# LSD: un libro, N empleados — Plan de implementación

> **Nota del proyecto:** este plan **no lleva pasos de commit**. En este repo Claude nunca commitea ni
> hace staging: el owner maneja los commits con GitLens. Cada tarea termina en "verificar".

**Goal:** que una Liquidación de Sueldos Digital genere una `Invoice` por empleado (sueldo neto), imputadas al consorcio del encabezado, con una sola llamada a la IA por archivo.

**Architecture:** el pipeline gana una lista `ctx.invoices` que por defecto tiene un elemento —la boleta de siempre— y para un LSD tiene N. Sólo `sheetsStep` y `persistStep` aprenden a iterarla; los otros 14 pasos no se enteran. La validación de completitud (todos los CUIL dados de alta + todos los gastos fijos cubiertos) es una función pura que corre antes de persistir nada.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Vitest (proyecto `node`).

**Spec:** `docs/superpowers/specs/2026-09-01-lsd-un-libro-n-empleados-design.md`

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/lib/lsdExtraction.ts` **(nuevo)** | Tipo `LsdEmployee`, prompt del LSD y parseo de su salida. Puro |
| `src/lib/lsdValidation.ts` **(nuevo)** | Decide si el libro entra completo. Puro: recibe empleados + directorio + gastos fijos, devuelve OK o el motivo |
| `src/lib/extraction.ts` | Router: reconocer el LSD y devolver su prompt |
| `src/lib/documentClassifier.ts` | Sacar `LSD` de los marcadores decisivos (deja de ser no-boleta) |
| `src/repositories/fixedExpense.repository.ts` **(nuevo)** | Traer los gastos fijos de empleado activos de un consorcio |
| `src/repositories/invoice.repository.ts` | Hash derivado por empleado + búsqueda por `driveFileId` |
| `src/jobs/pipeline/context.ts` | `ctx.invoices` |
| `src/jobs/processPendingDocuments.job.ts` | Paso de fan-out; `sheetsStep` y `persistStep` iteran |

---

### Task 1: Extracción del LSD (puro)

**Files:**
- Create: `src/lib/lsdExtraction.ts`
- Test: `src/lib/lsdExtraction.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
import { describe, expect, it } from "vitest";
import { parseLsdOutput, buildLsdPrompt, type LsdExtraction } from "./lsdExtraction";

describe("buildLsdPrompt", () => {
  it("pide los campos del libro y la lista de empleados", () => {
    const prompt = buildLsdPrompt("EMPRESA DOMICILIO FISCAL ...");
    expect(prompt).toContain("empleados");
    expect(prompt).toContain("cuil");
    expect(prompt).toContain("sueldoNeto");
    // El total del libro NO se registra como gasto.
    expect(prompt).toContain("NO");
  });
});

describe("parseLsdOutput", () => {
  it("parsea el JSON del modelo", () => {
    const out = parseLsdOutput(JSON.stringify({
      consortiumTaxId: "30-52063978-7",
      libroId: "000000045900718",
      periodo: "202607",
      empleados: [
        { cuil: "27-18116846-9", apellidoNombre: "BRITEZ, PAULA ADELA", sueldoNeto: 1318092 },
        { cuil: "27-29427364-1", apellidoNombre: "BUSTOS MUNIZAGA, ANDREA", sueldoNeto: 366772.8 },
      ],
    }));
    expect(out.consortiumTaxId).toBe("30-52063978-7");
    expect(out.libroId).toBe("000000045900718");
    expect(out.empleados).toHaveLength(2);
    expect(out.empleados[1].sueldoNeto).toBe(366772.8);
  });

  it("tolera el JSON envuelto en ```json", () => {
    const out = parseLsdOutput("```json\n{\"empleados\":[],\"libroId\":\"1\"}\n```");
    expect(out.libroId).toBe("1");
    expect(out.empleados).toEqual([]);
  });

  it("descarta empleados sin CUIL o sin sueldo", () => {
    const out = parseLsdOutput(JSON.stringify({
      libroId: "1",
      empleados: [
        { cuil: "27-18116846-9", apellidoNombre: "OK", sueldoNeto: 100 },
        { cuil: null, apellidoNombre: "SIN CUIL", sueldoNeto: 100 },
        { cuil: "20-24883768-4", apellidoNombre: "SIN SUELDO", sueldoNeto: null },
      ],
    }));
    expect(out.empleados).toHaveLength(1);
  });

  it("normaliza montos en formato es-AR", () => {
    const out = parseLsdOutput(JSON.stringify({
      libroId: "1",
      empleados: [{ cuil: "27-18116846-9", apellidoNombre: "X", sueldoNeto: "$ 1.318.092,00" }],
    }));
    expect(out.empleados[0].sueldoNeto).toBe(1318092);
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/lib/lsdExtraction.test.ts`
Expected: FAIL — `Failed to resolve import "./lsdExtraction"`

- [ ] **Step 3: Implementar**

```ts
import { normalizeBusinessAmount } from "@/lib/businessKey";

export interface LsdEmployee {
  cuil: string;
  apellidoNombre: string;
  sueldoNeto: number;
}

export interface LsdExtraction {
  consortiumTaxId: string | null;
  libroId: string | null;
  periodo: string | null;
  empleados: LsdEmployee[];
}

export function buildLsdPrompt(text: string): string {
  return [
    "Sos un extractor de datos de un LIQUIDACIÓN DE SUELDOS DIGITAL (LSD) argentino.",
    "Devolvé SOLO JSON con esta forma:",
    '{ "consortiumTaxId": "XX-XXXXXXXX-X|null", "libroId": "...|null", "periodo": "AAAAMM|null",',
    '  "empleados": [ { "cuil": "XX-XXXXXXXX-X", "apellidoNombre": "...", "sueldoNeto": 0 } ] }',
    "",
    "- consortiumTaxId: el CUIT que aparece en el ENCABEZADO junto al nombre del consorcio.",
    "- libroId: el valor de 'IDENTIFICADOR ÚNICO DEL LIBRO'.",
    "- periodo: el PERIODO del encabezado, formato AAAAMM.",
    "- empleados: UNO POR CADA persona listada en el libro, con su CUIL, su apellido y nombre",
    "  y su SUELDO NETO (lo que cobra de bolsillo).",
    "- NO devuelvas el total del libro ni las cargas sociales: sólo el neto de cada empleado.",
    "- Si una persona aparece más de una vez, devolvela UNA sola vez.",
    "",
    "Texto del libro:",
    text,
  ].join("\n");
}

export function parseLsdOutput(raw: string): LsdExtraction {
  const clean = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean) as Record<string, unknown>;

  const empleadosRaw = Array.isArray(parsed.empleados) ? parsed.empleados : [];
  const empleados: LsdEmployee[] = [];

  for (const item of empleadosRaw as Record<string, unknown>[]) {
    const cuil = typeof item?.cuil === "string" ? item.cuil.trim() : "";
    const monto = normalizeBusinessAmount(item?.sueldoNeto as string | number | null | undefined);
    if (!cuil || !monto) continue;
    empleados.push({
      cuil,
      apellidoNombre: typeof item?.apellidoNombre === "string" ? item.apellidoNombre.trim() : "",
      sueldoNeto: Number(monto),
    });
  }

  return {
    consortiumTaxId: typeof parsed.consortiumTaxId === "string" ? parsed.consortiumTaxId : null,
    libroId: typeof parsed.libroId === "string" ? parsed.libroId : null,
    periodo: typeof parsed.periodo === "string" ? parsed.periodo : null,
    empleados,
  };
}
```

- [ ] **Step 4: Correr y ver pasar**

Run: `npx vitest run src/lib/lsdExtraction.test.ts`
Expected: PASS

---

### Task 2: El LSD deja de ser "no boleta" y pasa a tener prompt

**Files:**
- Modify: `src/lib/documentClassifier.ts` (sacar `LSD` de los decisivos)
- Modify: `src/lib/documentClassifier.test.ts`
- Modify: `src/lib/extraction.ts` (router)
- Test: `src/lib/extraction.test.ts`

- [ ] **Step 1: Escribir el test del router**

En `extraction.test.ts`:

```ts
it("identifica un LSD por el encabezado del libro", () => {
  const texto = `EMPRESA DOMICILIO FISCAL
PERIODO PROVINCIA
NRO.LIQUIDACIÓN
ACTIVIDAD PPAL
30-52063978-7 - CONSORCIO COPROPIETARIOS
IDENTIFICADOR ÚNICO DEL LIBRO 000000045900718`;
  expect(identifyLSPProvider(texto)).toBe("LSD");
});

it("un F931 de ARCA NO se identifica como LSD", () => {
  const texto = "ARCA F. 931 SEGURIDAD SOCIAL CUIT 30-52063978-7 Total contribuciones $ 1.200.000";
  expect(identifyLSPProvider(texto)).not.toBe("LSD");
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/lib/extraction.test.ts`
Expected: FAIL — devuelve `null`, no `"LSD"`

- [ ] **Step 3: Sacar LSD del triage decisivo**

En `documentClassifier.ts`, `NotBoletaKind` pasa a ser sólo `"VEP"`, y se borran
`LSD_MARKERS` / `LSD_MIN_MARKERS` y su rama en `detectDecisiveNotBoleta`. En
`documentClassifier.test.ts` se borran los dos tests de LSD (`LSD real → LSD` y el
de `LSD_REAL`), porque el LSD ya no es un no-boleta: ahora se procesa.

- [ ] **Step 4: Agregar LSD al router**

En `extraction.ts`: `"LSD"` se suma a `LSPProvider`, y `identifyLSPProvider` lo
detecta **antes** que el resto (igual que ABL, que va antes del gate `isUtilityBill`),
exigiendo 2 de estos marcadores sobre el texto normalizado sin acentos y en
mayúsculas: `EMPRESA DOMICILIO FISCAL`, `NRO.LIQUIDACION`, `ACTIVIDAD PPAL`,
`IDENTIFICADOR UNICO DEL LIBRO`, `IDENTIFICADOR UNICO DE HOJA MOVIL`,
`LEGAJO CUIL APELLIDO Y NOMBRE`.

- [ ] **Step 5: Rutear el prompt y tipar la salida**

`buildExtractionPrompt` (`extraction.ts:319`) ya rutea por `identifyLSPProvider`, así
que alcanza con sumar el case:

```ts
    case "LSD":
      return buildLsdPrompt(relevantText);
```

La salida del modelo la valida `EXTRACTED_DOCUMENT_SCHEMA` (`extraction.ts:36`), que
tiene `.passthrough()` y todos los campos con `.default(null)`. Se le suma el bloque
del LSD para que quede validado y tipado:

```ts
    lsd: z
      .object({
        consortiumTaxId: z.string().nullable().default(null),
        libroId: z.string().nullable().default(null),
        periodo: z.string().nullable().default(null),
        empleados: z
          .array(
            z.object({
              cuil: z.string(),
              apellidoNombre: z.string().nullable().default(""),
              sueldoNeto: z.union([z.number(), z.string()]).nullable().default(null),
            })
          )
          .default([]),
      })
      .nullable()
      .default(null),
```

Y en `ExtractedDocumentData` (`src/types/extractedDocument.types.ts`):

```ts
  /** Sólo en una Liquidación de Sueldos Digital: el libro y su lista de empleados. */
  lsd?: LsdExtraction | null;
```

> El prompt del LSD devuelve **sólo** el bloque `lsd`; el resto de los campos los
> completa el schema con `null`, que es lo correcto: un libro no tiene número de
> factura ni monto único.

- [ ] **Step 6: Correr y ver pasar**

Run: `npx vitest run src/lib/extraction.test.ts src/lib/documentClassifier.test.ts`
Expected: PASS

---

### Task 3: Validación de completitud (puro)

**Files:**
- Create: `src/lib/lsdValidation.ts`
- Test: `src/lib/lsdValidation.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
import { describe, expect, it } from "vitest";
import { validateLsdRoster } from "./lsdValidation";

const empleados = [
  { cuil: "27-18116846-9", apellidoNombre: "BRITEZ", sueldoNeto: 100 },
  { cuil: "20-24883768-4", apellidoNombre: "CRUZ", sueldoNeto: 200 },
];
const directorio = [
  { id: "p1", cuit: "27-18116846-9" },
  { id: "p2", cuit: "20-24883768-4" },
];

describe("validateLsdRoster", () => {
  it("OK cuando todos están de alta y cubren los gastos fijos", () => {
    const r = validateLsdRoster(empleados, directorio, ["p1", "p2"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matched.map((m) => m.providerId)).toEqual(["p1", "p2"]);
  });

  it("falla si un CUIL no está en el directorio", () => {
    const r = validateLsdRoster(
      [...empleados, { cuil: "20-95678503-1", apellidoNombre: "SUPLENTE", sueldoNeto: 50 }],
      directorio,
      ["p1", "p2"]
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasonCategory).toBe("lsd_empleado_no_registrado");
      expect(r.detail).toContain("20-95678503-1");
    }
  });

  it("falla si queda un gasto fijo sin cubrir", () => {
    const r = validateLsdRoster(empleados, directorio, ["p1", "p2", "p3"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCategory).toBe("lsd_empleado_faltante");
  });

  it("compara CUIL por dígitos, no por formato", () => {
    const r = validateLsdRoster(
      [{ cuil: "27188168469", apellidoNombre: "BRITEZ", sueldoNeto: 100 }],
      [{ id: "p1", cuit: "27-18116846-9" }],
      ["p1"]
    );
    expect(r.ok).toBe(true);
  });

  it("falla si el libro no trae ningún empleado", () => {
    const r = validateLsdRoster([], directorio, ["p1"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCategory).toBe("lsd_sin_empleados");
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/lib/lsdValidation.test.ts`
Expected: FAIL — no existe el módulo

- [ ] **Step 3: Implementar**

```ts
import { cuitDigits } from "@/lib/cuit";
import type { LsdEmployee } from "@/lib/lsdExtraction";

export type LsdRosterResult =
  | { ok: true; matched: Array<{ employee: LsdEmployee; providerId: string }> }
  | { ok: false; reasonCategory: string; detail: string };

/**
 * El libro entra completo o no entra (spec 2026-09-01 §3.5).
 *
 * Dos condiciones, ambas obligatorias:
 *  1. todos los CUIL del libro están dados de alta como proveedor EMPLEADO;
 *  2. los empleados del libro cubren TODOS los gastos fijos de empleado activos
 *     del consorcio — si la IA se saltea a alguien, queda un gasto sin cubrir y
 *     el libro no entra.
 *
 * `fixedExpenseProviderIds` es el padrón del edificio: la única fuente exacta de
 * cuántos empleados tiene, porque el papel no lo declara.
 */
export function validateLsdRoster(
  empleados: LsdEmployee[],
  directorio: Array<{ id: string; cuit: string | null }>,
  fixedExpenseProviderIds: string[]
): LsdRosterResult {
  if (empleados.length === 0) {
    return { ok: false, reasonCategory: "lsd_sin_empleados", detail: "el libro no trae empleados" };
  }

  const byCuil = new Map<string, string>();
  for (const p of directorio) {
    const digits = cuitDigits(p.cuit ?? "");
    if (digits) byCuil.set(digits, p.id);
  }

  const matched: Array<{ employee: LsdEmployee; providerId: string }> = [];
  const desconocidos: string[] = [];

  for (const employee of empleados) {
    const providerId = byCuil.get(cuitDigits(employee.cuil));
    if (providerId) matched.push({ employee, providerId });
    else desconocidos.push(employee.cuil);
  }

  if (desconocidos.length > 0) {
    return {
      ok: false,
      reasonCategory: "lsd_empleado_no_registrado",
      detail: `CUIL sin alta: ${desconocidos.join(", ")}`,
    };
  }

  const cubiertos = new Set(matched.map((m) => m.providerId));
  const faltantes = fixedExpenseProviderIds.filter((id) => !cubiertos.has(id));
  if (faltantes.length > 0) {
    return {
      ok: false,
      reasonCategory: "lsd_empleado_faltante",
      detail: `gastos fijos sin cubrir: ${faltantes.length}`,
    };
  }

  return { ok: true, matched };
}
```

- [ ] **Step 4: Correr y ver pasar**

Run: `npx vitest run src/lib/lsdValidation.test.ts`
Expected: PASS (5 tests)

---

### Task 4: Padrón del consorcio desde la base

**Files:**
- Create: `src/repositories/fixedExpense.repository.ts`

- [ ] **Step 1: Implementar el repositorio**

No lleva test propio: es una query sin lógica, y el pipeline la inyecta como seam
para poder mockearla (mismo patrón que `linkInvoiceToObligation`).

```ts
import { getPrismaClient } from "@/lib/prisma";

/**
 * IDs de proveedor de los gastos fijos de EMPLEADO activos de un consorcio.
 * Es el padrón del edificio: la fuente contra la que se valida que un LSD venga
 * completo (el papel no declara cuántos empleados tiene).
 */
export async function findActiveEmployeeFixedExpenseProviderIds(
  consortiumId: string
): Promise<string[]> {
  const rows = await getPrismaClient().fixedExpense.findMany({
    where: {
      consortiumId,
      active: true,
      providerId: { not: null },
      provider: { providerType: "EMPLEADO" },
    },
    select: { providerId: true },
  });
  return rows.map((r) => r.providerId!).filter(Boolean);
}
```

- [ ] **Step 2: Verificar que compila**

Run: `npm run typecheck`
Expected: 0 errores

---

### Task 5: Hash derivado y corte por `driveFileId`

**Files:**
- Modify: `src/repositories/invoice.repository.ts`
- Test: `src/repositories/invoice.repository.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
import { InvoiceRepository } from "@/repositories/invoice.repository";

describe("deriveDocumentHash", () => {
  const repo = new InvoiceRepository();

  it("deriva un hash distinto por CUIL", () => {
    const a = repo.deriveDocumentHash("abc123", "27-18116846-9");
    const b = repo.deriveDocumentHash("abc123", "20-24883768-4");
    expect(a).not.toBe(b);
  });

  it("es estable entre corridas", () => {
    expect(repo.deriveDocumentHash("abc123", "27-18116846-9"))
      .toBe(repo.deriveDocumentHash("abc123", "27-18116846-9"));
  });

  it("ignora el formato del CUIL", () => {
    expect(repo.deriveDocumentHash("abc123", "27-18116846-9"))
      .toBe(repo.deriveDocumentHash("abc123", "27188168469"));
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/repositories/invoice.repository.test.ts`
Expected: FAIL — `deriveDocumentHash is not a function`

- [ ] **Step 3: Implementar en `InvoiceRepository`**

```ts
  /**
   * Hash de documento por empleado, para las N boletas de un mismo LSD.
   *
   * `Invoice` tiene unique (clientId, documentHash), así que N boletas del mismo
   * PDF lo violarían. Derivar del CUIL las hace únicas sin migración y sin perder
   * la garantía a nivel base.
   */
  deriveDocumentHash(fileHash: string, cuil: string): string {
    return createHash("sha256").update(`${fileHash}:${cuitDigits(cuil)}`).digest("hex");
  }

  /** ¿Ya existe una boleta para este archivo de Drive? Corta el reproceso sin gastar IA. */
  async findAnyByDriveFileId(clientId: string, driveFileId: string) {
    return this.prisma.invoice.findFirst({
      where: { clientId, driveFileId },
      select: { id: true },
    });
  }
```

Con los imports `createHash` de `crypto` y `cuitDigits` de `@/lib/cuit` si no están.

- [ ] **Step 4: Correr y ver pasar**

Run: `npx vitest run src/repositories/invoice.repository.test.ts`
Expected: PASS

---

### Task 6: `ctx.invoices` — el pipeline admite N boletas

**Files:**
- Modify: `src/jobs/pipeline/context.ts`
- Modify: `src/jobs/processPendingDocuments.job.ts` (`sheetsStep`, `persistStep`)
- Test: `src/jobs/processPendingDocuments.job.test.ts`

- [ ] **Step 1: Agregar el campo al contexto**

En `PipelineContext`, junto a `extracted`:

```ts
  /**
   * Boletas a escribir. Vacío = una sola, la de `extracted` (el caso de siempre).
   * Con contenido = fan-out: un LSD produce una por empleado, todas con el mismo
   * archivo de Drive detrás.
   */
  invoices: Array<{ extraction: ExtractedDocumentData; providerId: string; documentHash: string }>;
```

Y en `createPipelineContext`: `invoices: [],`.

> Esta tarea no agrega tests: es un refactor de comportamiento neutro. Con
> `ctx.invoices` vacío —el caso de todos los documentos que no son LSD— los dos
> pasos hacen exactamente lo mismo que hoy, y eso lo fija la red de caracterización
> que ya existe. Los tests del fan-out van en la Task 7, cuando haya quien llene
> la lista.

- [ ] **Step 2: Hacer que `sheetsStep` itere**

```ts
  if (!ctx.isDuplicate) {
    const filas = ctx.invoices.length > 0
      ? ctx.invoices.map((i) => i.extraction)
      : [extracted];

    for (const fila of filas) {
      await ctx.runStep(
        "Insertar en Google Sheets",
        () => sheetsService.insertRow(resolvedConfig.sheetName, fila, resolvedMapping),
        "sheets"
      );
    }
    pipelineLog.sheetsInserted(cid);
  }
```

- [ ] **Step 3: Hacer que `persistStep` itere**

El bloque que hoy guarda una invoice pasa a recorrer la misma lista. Por cada
entrada usa su `documentHash` y su `providerId`; el resto de los campos
(`consortiumId`, `periodId`) sale de `assignment` como hasta ahora, y la vinculación
con la obligación se hace por cada boleta guardada. `ctx.summary.processed` suma
una vez por boleta.

- [ ] **Step 4: Verificar que no rompió nada**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: PASS — con `invoices` vacío el comportamiento es idéntico al de hoy.

---

### Task 7: El paso de fan-out

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.ts`
- Test: `src/jobs/processPendingDocuments.job.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

```ts
describe("LSD — un libro, N empleados", () => {
  function lsdContext() {
    const ctx = makeContext();
    ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(
      `EMPRESA DOMICILIO FISCAL
NRO.LIQUIDACIÓN
ACTIVIDAD PPAL
30-11111111-1 - CONSORCIO THAMES 647
IDENTIFICADOR ÚNICO DEL LIBRO 000000045900718`
    );
    ctx.providerRepository.findAllForMatching.mockResolvedValue([
      { id: "e1", canonicalName: "BRITEZ PAULA", cuit: "27-18116846-9", matchNames: null, paymentAlias: null },
      { id: "e2", canonicalName: "CRUZ RICARDO", cuit: "20-24883768-4", matchNames: null, paymentAlias: null },
    ]);
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", true);
      return {
        data: {
          ...okExtraction(),
          lsd: {
            consortiumTaxId: "30-11111111-1",
            libroId: "000000045900718",
            periodo: "202607",
            empleados: [
              { cuil: "27-18116846-9", apellidoNombre: "BRITEZ, PAULA", sueldoNeto: 1000 },
              { cuil: "20-24883768-4", apellidoNombre: "CRUZ, RICARDO", sueldoNeto: 2000 },
            ],
          },
        },
        usage: null,
        provider: "gemini",
      };
    });
    return ctx;
  }

  it("genera una boleta por empleado con el mismo archivo detrás", async () => {
    const ctx = lsdContext();
    (ctx as unknown as { findEmployeeFixedExpenses: unknown }).findEmployeeFixedExpenses =
      async () => ["e1", "e2"];
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.invoiceRepository.saveProcessedInvoice).toHaveBeenCalledTimes(2);
    expect(ctx.sheetsService.insertRow).toHaveBeenCalledTimes(2);
    expect(summary.processed).toBe(2);
    // Una sola llamada a la IA para todo el libro.
    expect(ctx.aiChain.run).toHaveBeenCalledTimes(1);
  });

  it("el archivo se mueve UNA sola vez", async () => {
    const ctx = lsdContext();
    (ctx as unknown as { findEmployeeFixedExpenses: unknown }).findEmployeeFixedExpenses =
      async () => ["e1", "e2"];
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledTimes(1);
  });

  it("si falta un gasto fijo por cubrir, NO entra ninguna boleta", async () => {
    const ctx = lsdContext();
    (ctx as unknown as { findEmployeeFixedExpenses: unknown }).findEmployeeFixedExpenses =
      async () => ["e1", "e2", "e3"];
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.driveService.moveFileToUnassigned).toHaveBeenCalled();
    expect(metricsCore().result).toBe("unassigned");
  });

  it("si un CUIL no está de alta, NO entra ninguna boleta", async () => {
    const ctx = lsdContext();
    ctx.providerRepository.findAllForMatching.mockResolvedValue([
      { id: "e1", canonicalName: "BRITEZ PAULA", cuit: "27-18116846-9", matchNames: null, paymentAlias: null },
    ]);
    (ctx as unknown as { findEmployeeFixedExpenses: unknown }).findEmployeeFixedExpenses =
      async () => ["e1"];
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(metricsCore().reason).toBe("lsd_empleado_no_registrado");
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: FAIL — no hay fan-out, guarda 1 boleta

- [ ] **Step 3: Implementar `lsdFanOutStep`**

Va **después de `canonizeStep`** (el consorcio ya está resuelto por CUIT) y **antes
de `unassignedGate`**, para que el rebote reuse el movimiento a Sin Asignar que ya
existe. Con `lspProvider !== "LSD"` devuelve `continue` sin hacer nada.

Cuando es LSD:

1. Trae el padrón: `findEmployeeFixedExpenses(assignment.consortiumId)` (seam inyectable,
   por defecto `findActiveEmployeeFixedExpenseProviderIds`).
2. Llama a `validateLsdRoster(empleados, proveedores, padrón)`.
3. Si falla: pisa `ctx.assignment` con `unassigned: true`, la `reasonCategory` del
   resultado y su `detail` como `unassignedReason`, y devuelve `continue` — el
   `unassignedGate` mueve el archivo y corta.
4. Si pasa: llena `ctx.invoices` con una entrada por empleado:
   - `extraction`: copia de `ctx.extracted` con `provider` = apellido y nombre,
     `providerTaxId` = CUIL, `amount` = sueldo neto, `dueDate` = null,
     `boletaNumber` = `<libroId>-<dígitos del CUIL>`;
   - `providerId`: el del match;
   - `documentHash`: `invoiceRepository.deriveDocumentHash(ctx.fileHash, cuil)`.

- [ ] **Step 4: Agregar las etiquetas de Sin Asignar**

En `UNASSIGNED_TAG_BY_CATEGORY`: `lsd_empleado_no_registrado` → `EMPLEADO NO REGISTRADO`,
`lsd_empleado_faltante` → `FALTA UN EMPLEADO EN EL LIBRO`, `lsd_sin_empleados` →
`LIBRO SIN EMPLEADOS`. Las tres van también a `KNOWN_SUFFIX_TAGS` en
`documentValidation.ts`, o se apilan al reprocesar.

- [ ] **Step 5: Correr y ver pasar**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: PASS

---

### Task 8: Corte temprano por `driveFileId`

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.ts` (`dedupHashStep`)
- Test: `src/jobs/processPendingDocuments.job.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
it("un archivo ya procesado corta sin llamar a la IA", async () => {
  const ctx = makeContext();
  ctx.invoiceRepository.findAnyByDriveFileId = vi.fn().mockResolvedValue({ id: "inv-1" });
  const summary = createBaseSummary(1);

  await processDriveFile(makeFile(), asContext(ctx), summary);

  expect(ctx.aiChain.run).not.toHaveBeenCalled();
  expect(metricsCore().result).toBe("duplicate");
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: FAIL — llama a la IA igual

- [ ] **Step 3: Implementar en `dedupHashStep`**

Después de la búsqueda por hash, si no hubo match, consultar por `driveFileId`:
si existe una boleta con ese archivo, marcar `ctx.isDuplicate = true`. El hash
derivado de un LSD no coincide con el del binario, así que sin esto un LSD
reprocesado volvería a gastar la extracción.

- [ ] **Step 4: Correr y ver pasar**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: PASS

---

### Task 9: Verificación y documentación

- [ ] **Step 1: Verificación completa**

Run: `npm run typecheck`
Run: `npx vitest run`
Run: `npm run lint`
Run: `npm run build:jobs`
Expected: 0 errores de typecheck y lint, todos los tests verdes.

- [ ] **Step 2: Documentar**

- `docs/decisiones.md`: entrada del 2026-09-01 con el problema (1 archivo = 1 boleta),
  la decisión (`ctx.invoices` + validación contra el padrón) y las alternativas
  descartadas (recortar el PDF a mano, carga manual, que cada paso itere un array).
- `docs/progreso.md`: estado, y que **el triage de LSD como no-boleta se revirtió**.
- `CHANGELOG.md`: entrada en `[Unreleased]`.
- `CLAUDE.md`: el LSD en la tabla de prompts y la nota de que un archivo puede
  producir N boletas.
