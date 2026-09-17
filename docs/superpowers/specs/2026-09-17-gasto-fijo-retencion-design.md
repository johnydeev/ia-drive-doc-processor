# La retención como gasto fijo propio

**Fecha:** 2026-09-17
**Estado:** diseño aprobado en conversación, pendiente de plan
**Antecedente:** `2026-09-12-liquidacion-retenciones-design.md` (el paquete de retención entra como
boleta de la empresa, con el Nro. VEP como número)

---

## 1. Problema

Desde el 2026-09-12 el paquete de retención entra como boleta **a nombre de la empresa** (Mayoral,
Aseclim…), aparte de la factura de esa misma empresa. En Boletas se ven las dos. En la vista de
**Obligaciones / gastos fijos** se ve una sola:

- Un gasto fijo = un proveedor por edificio (`unique (consortiumId, providerId)`).
- Una obligación por mes y por gasto fijo, con **una sola boleta** (`ExpenseObligation.invoiceId`
  unique).
- La vinculación (`obligation.service.ts`) toma **la primera boleta del período con ese
  `providerId`**. Factura y retención comparten `providerId`; la que llega primero se lleva la
  obligación y la otra queda sin lugar donde mostrarse.

Caso real, Boedo 414 / Mayoral, septiembre 2026: la factura (`00001-00001848`, $7.404.713,01, 14/09)
ocupó la obligación; la retención (VEP `1679299135`, $1.130.782,14, 16/09) no aparece en la vista ni
en el PDF del banco.

Riesgo peor que la omisión, **ya materializado**: si el paquete llega antes que la factura, la
obligación la toma la retención. Pueyrredón 2418 / Dogo, septiembre 2026: la obligación FACTURA está
`RECEIVED` con el VEP `1679256980` ($711.337,50). Cuando llegue la factura de Dogo (~$8 M) no va a
tener obligación libre, y el PDF del banco dice hoy que "Dogo" cuesta $711 K. La migración (§3.1) lo
corrige.

Además el owner creó un proveedor genérico `RETENCIONES VEPS` como gasto fijo en Boedo: no puede
matchear nunca (las retenciones entran a nombre de la empresa) y queda PENDING para siempre.

### 1.1 Decisión del owner

La retención es una **obligación mensual propia**, con su estado (opción A): si un mes no llega el
paquete, se ve. El owner carga a mano en qué edificios se retiene a qué empresa — "son clarísimas y
son en ciertos edificios, no es un problema cargarlas a mano".

---

## 2. Decisión

**La retención es un gasto fijo propio, del mismo proveedor, con tipo `RETENCION`.** Un gasto fijo ya
significa "algo que espero todos los meses de este proveedor en este edificio"; la retención es
exactamente eso. Se reusa la obligación mensual, sus estados, saltear/desactivar, la vista y el PDF.

Para que factura y retención no se pisen, **las boletas también llevan el tipo**
(`Invoice.docKind`), y una obligación sólo acepta boletas de su mismo tipo.

### 2.1 Alternativas descartadas

- **Tilde "con retención" en el gasto fijo existente que genera dos obligaciones por mes.** Menos
  clicks, pero duplica la lógica de obligaciones: dos estados por fila, saltear una y no la otra,
  dos `invoiceId`. Más código y más casos borde para el mismo resultado.
- **Proveedor aparte "MAYORAL — RETENCIONES".** El matching es por CUIT: la boleta entraría al
  proveedor real, nunca al duplicado. Y contamina el directorio.
- **Línea informativa debajo de la factura, sin estado** (opción B). Descartada por el owner: no
  reclama la que falta.
- **Distinguir la retención sólo por el texto del detalle** (`Retenciones s/fra.%`). Funciona hoy,
  pero es frágil y no sirve para la clave única del gasto fijo. Pasa a ser un dato.

---

## 3. Diseño

### 3.1 Schema (migración)

```prisma
enum DocKind {
  FACTURA
  RETENCION
}

model Invoice {
  …
  docKind DocKind @default(FACTURA)
}

model FixedExpense {
  …
  kind DocKind @default(FACTURA)
  @@unique([consortiumId, providerId, kind])   // reemplaza (consortiumId, providerId)
  @@unique([consortiumId, lspServiceId])        // sin cambios: un LSP es siempre FACTURA
}
```

`prisma/migrations/20260917000000_doc_kind_retencion/migration.sql`:

```sql
CREATE TYPE "DocKind" AS ENUM ('FACTURA', 'RETENCION');

ALTER TABLE "Invoice"      ADD COLUMN "docKind" "DocKind" NOT NULL DEFAULT 'FACTURA';
ALTER TABLE "FixedExpense" ADD COLUMN "kind"    "DocKind" NOT NULL DEFAULT 'FACTURA';

-- Backfill: las retenciones que ya entraron por LIQ_RETENCION (spec 2026-09-12).
UPDATE "Invoice" SET "docKind" = 'RETENCION' WHERE detail LIKE 'Retenciones s/fra.%';

-- Una obligación FACTURA que haya quedado colgada de una retención (el paquete llegó
-- antes que la factura) se libera: vuelve a PENDING y la factura la va a ocupar.
UPDATE "ExpenseObligation" o
SET "invoiceId" = NULL, status = 'PENDING', "updatedAt" = now()
FROM "Invoice" i, "FixedExpense" f
WHERE o."invoiceId" = i.id AND o."fixedExpenseId" = f.id
  AND i."docKind" = 'RETENCION' AND f.kind = 'FACTURA';

DROP INDEX "FixedExpense_consortiumId_providerId_key";
CREATE UNIQUE INDEX "FixedExpense_consortiumId_providerId_kind_key"
  ON "FixedExpense"("consortiumId", "providerId", "kind");
```

Verificar el nombre real del índice viejo con `\d "FixedExpense"` (Prisma lo genera como
`<Tabla>_<col>_<col>_key`); si difiere, ajustar el `DROP`. Postgres trata los `NULL` de `providerId`
como distintos, así que las filas LSP (`providerId NULL`) siguen sin colisionar entre sí.

**Sin migración de datos para `FixedExpense.kind`**: todo lo existente es `FACTURA`, que es el
default.

### 3.2 Pipeline — `docKind` de la boleta

`persistStep` pasa `docKind: ctx.lspProvider === "LIQ_RETENCION" ? "RETENCION" : "FACTURA"` a
`saveProcessedInvoice` (`SaveInvoiceInput` gana el campo). Único lugar donde se decide. El fan-out
del LSD y todo lo demás queda `FACTURA` por default.

### 3.3 Vinculación por tipo — `lib/fixedExpense.ts`

```ts
export interface FixedExpenseTarget {
  providerId: string | null;
  lspServiceId: string | null;
  kind?: DocKind;            // default FACTURA
}

export function obligationMatchesInvoice(
  target: FixedExpenseTarget,
  invoice: { providerId: string | null; lspServiceId: string | null; docKind?: DocKind }
): boolean {
  if ((target.kind ?? "FACTURA") !== (invoice.docKind ?? "FACTURA")) return false;
  … (resto igual)
}
```

Los tres callers de `obligation.service.ts` (`generateObligationsForPeriod`,
`linkInvoiceToObligation`, `syncObligationsForClient`) pasan `kind` del gasto fijo y `docKind` de
la boleta en sus `select`. `validateFixedExpenseTarget` suma una regla: `kind === "RETENCION"` exige
`providerId` (un LSP no tiene retención).

### 3.4 API — alta del gasto fijo

`POST /api/client/consortiums/[id]/fixed-expenses`: `itemSchema` gana
`kind: z.enum(["FACTURA", "RETENCION"]).default("FACTURA")` y lo pasa al repositorio.

`FixedExpenseRepository.create` (`repositories/fixedExpense.repository.ts`): `CreateFixedExpenseInput`
gana `kind?: DocKind` (default `FACTURA`); la validación usa `validateFixedExpenseTarget` con el
`kind`; y **el dedupe a nivel app** (`findFirst` por `consortiumId + providerId + lspServiceId`) suma
`kind` — sin eso, la segunda fila del mismo proveedor daría 409 antes de llegar al unique nuevo. El
409 sigue existiendo: el mismo proveedor puede estar dos veces en el edificio, una por tipo, y no
tres.

`closePeriods.service.ts` (obligaciones del período nuevo al cerrar) y
`findActiveEmployeeFixedExpenseProviderIds` (padrón del LSD) no cambian: el primero tiene que crear
la obligación de retención igual que la de factura, y el segundo sólo mira proveedores `EMPLEADO`,
que nunca tienen `RETENCION`.

`GET /api/client/obligations/overview`: `fixedExpenses[].kind` en el payload. `providers` no cambia.

### 3.5 Modal "Agregar gastos fijos" — `availableTargets.ts`

Cada proveedor produce **dos opciones**, y cada una se oculta si ya está cargada (activa o
desactivada, igual que hoy):

```ts
interface TargetOption {
  kind: "provider" | "lsp";
  id: string;
  label: string;
  expenseKind: "FACTURA" | "RETENCION";   // LSP: siempre FACTURA
}
// MAYORAL SEGURIDAD S.R.L (MAYORAL)
// MAYORAL SEGURIDAD S.R.L (MAYORAL) — Retención
```

Lo usado se calcula por `(providerId, kind)`. El buscador filtra por la etiqueta completa, así que
"retenc" lista sólo las opciones de retención. La clave del `Map` de seleccionados del modal pasa a
`${kind}:${id}:${expenseKind}`. El hook (`useObligationsOverview.ts`) manda
`{ providerId, kind: expenseKind }` para proveedores y `{ lspServiceId }` para LSP.

Orden: la opción de retención va **inmediatamente después** de la factura del mismo proveedor (el
sort por etiqueta ya lo da: `"X"` < `"X — Retención"`).

### 3.6 Vista y PDF — `sheetModel.ts`

`concepto` = `provider.canonicalName + " — Retención"` cuando `fx.kind === "RETENCION"`. La fila
lleva la fantasía, el alias de pago, el monto de la obligación, el estado y el ojo del PDF como
cualquier otra; el PDF del banco y el buscador de la vista usan `concepto`, así que salen solos. El
sort por concepto deja la retención debajo de la factura del mismo proveedor.

### 3.7 Lo que no cambia

- Detección y extracción del paquete (spec 2026-09-12).
- Boletas entrantes y la pestaña Boletas del consorcio: ya muestran las dos boletas; el detalle
  `Retenciones s/fra. …` sigue diciendo de qué factura es.
- Google Sheets: sin columna nueva. `docKind` es un dato interno de obligaciones.
- El pipeline de vinculación al guardar la boleta (`linkInvoiceToObligation`) sigue enganchando en
  el momento; sólo que ahora elige la obligación del tipo correcto.

---

## 4. Operación (owner)

1. **Migración**: procedimiento de siempre (`prisma migrate deploy` → `prisma generate`, con los
   procesos parados). Sin ella, el deploy del código falla en el `select` de `kind`.
2. **Cargar "— Retención"** desde el modal en: Boedo 414 (Mayoral, Aseclim), Pueyrredón 2418
   (Dogo), Rivadavia 4243 (Shomer), Callao 1441 (Libres). Al abrir la vista, la sincronización
   vincula las 5 retenciones de septiembre que ya entraron. **No hay que recargar boletas.**
3. **Borrar** el gasto fijo `RETENCIONES VEPS` de Boedo 414 (y el proveedor genérico, si se creó
   sólo para eso).
4. Las **10 boletas fantasma** de mayo–agosto (spec 2026-09-12 §4.1) siguen pendientes de borrar;
   no interactúan con esto.

---

## 5. Tests

`src/lib/fixedExpense.test.ts`:
- `obligationMatchesInvoice`: FACTURA no acepta RETENCION del mismo proveedor y viceversa;
  sin `kind`/`docKind` (callers viejos) se comporta como FACTURA/FACTURA.
- `validateFixedExpenseTarget`: LSP + RETENCION → error.

`src/services/obligation.service.test.ts`:
- Período con factura y retención del mismo proveedor y dos gastos fijos (uno por tipo): cada
  obligación se vincula a la boleta de su tipo, sin importar el orden de `createdAt`.
- Gasto fijo FACTURA solo + retención en el período → la obligación queda PENDING (no la toma).

`src/app/admin/obligaciones/lib/availableTargets.test.ts`:
- Un proveedor produce dos opciones con etiquetas `X` y `X — Retención`; cargada la FACTURA, queda
  ofrecida sólo la RETENCION; cargadas las dos, ninguna. Un LSP produce una sola.

`src/app/admin/obligaciones/lib/sheetModel.test.ts`: fila RETENCION → concepto `X — Retención`.

`src/app/admin/obligaciones/hooks/useObligationsOverview.test.tsx`: el POST lleva
`{ providerId, kind: "RETENCION" }` para la opción de retención.

`src/jobs/processPendingDocuments.job.test.ts`: el paquete guarda `docKind: "RETENCION"`; una
factura común guarda `FACTURA`.

Endpoint: `kind` inválido → 400; LSP con `kind: RETENCION` → 400.

---

## 6. Fuera de alcance

- Mostrar el `docKind` en Boletas entrantes (hoy alcanza con el detalle).
- Retención sobre un LSP: no existe el caso.
- Vincular la boleta de retención con la factura a la que corresponde (sólo por el número en el
  detalle).
