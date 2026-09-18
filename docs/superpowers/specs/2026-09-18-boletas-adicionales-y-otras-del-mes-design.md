# Boletas adicionales y "Otras boletas del mes" en la hoja de obligaciones

**Fecha:** 2026-09-18
**Estado:** implementado el 2026-09-18 (plan `docs/superpowers/plans/2026-09-18-boletas-adicionales-y-otras-del-mes.md`)
**Antecedentes:** `2026-09-17-gasto-fijo-retencion-design.md` (una obligación acepta sólo boletas de
su `kind`); sección "Padrón de gastos fijos armado desde las rendiciones" de `docs/progreso.md`
(sesión 68).

---

## 1. Problema

Una obligación tiene **una sola boleta** (`ExpenseObligation.invoiceId` unique) y la vinculación
(`linkInvoiceToObligation`, `src/services/obligation.service.ts:81`) sólo toma obligaciones `PENDING`.
Cuando en el mes entran dos boletas del mismo proveedor para el mismo edificio, la primera se lleva
la obligación y la segunda se guarda en DB y en Sheets pero **no aparece en Obligaciones ni en el PDF
del banco**. Casos reales del barrido de rendiciones: QBICAR, OLIVERI, CIMEX facturan dos veces en un
mes en varios edificios.

Lo mismo le pasa a toda boleta de un proveedor que **no** es gasto fijo del edificio (ticket de
supermercado, plomero eventual, trabajo extraordinario): está en Consorcios y en Boletas entrantes,
pero la hoja del edificio —que es lo que el administrador usa para pedir y rendir los pagos— no la
lista.

### 1.1 Decisión del owner

- Cada boleta se paga por separado y tiene su propio recibo: la 2ª boleta de QBICAR es **otro gasto
  a pagar**, no "más comprobantes del mismo gasto". No se suma en la fila; se lista aparte, con su
  monto, su PDF y su arrastre.
- Hay que diferenciar bien dos cosas: boletas de un proveedor que **ya es gasto fijo** del edificio
  (van pegadas a su fila) y boletas **eventuales** de un proveedor sin gasto fijo (van en un bloque
  aparte). "El administrador debe ver todas las boletas entrantes sí o sí al final del período, pero
  al iniciar debe saber qué hay que pagar y pedirlo."
- Nada de eso tiene estado propio: existe porque llegó la boleta. Lo que se hace, se hace sobre la
  boleta (pagar, arrastrar, borrar).
- Lo que se **pide** al inicio del mes siguen siendo los gastos fijos `PENDING`; las adicionales y
  las otras no se piden, se pagan cuando llegan. Por eso no entran en el cierre (`NOT_RECEIVED`) ni
  en "Sincronizar obligaciones" como faltantes.

## 2. Enfoque elegido: derivado, sin tocar el modelo

La 2ª boleta ya existe en `Invoice` con `periodId`, `providerId`/`lspServiceId` y `docKind`. Lo único
que falta es que la vista la busque. El overview trae las boletas del período que no están vinculadas
a ninguna obligación y `sheetModel` las cruza contra los gastos fijos del edificio con el mismo
criterio que usa el pipeline para vincular.

**Sin cambios:** schema, migraciones, `linkInvoiceToObligation`, `generateObligationsForPeriod`,
`closeObligationsForPeriod`, omitir/reactivar, pipeline, Sheets, arrastre (`invoiceCarryOver.ts`),
borrado (`invoiceDeletion.ts`), move de período. Arrastre y borrado hacen `updateMany where
invoiceId` sobre la obligación: con una boleta sin obligación no tocan nada y no rompen.

### 2.1 Alternativas descartadas

- **Una obligación por boleta extra** (relajar el unique `(periodId, fixedExpenseId)` + flag
  `isExtra`): migración, y hay que blindar cierre (una extra nunca es `NOT_RECEIVED`), sync (no debe
  crear extras) y omitir/reactivar. Más estado para algo que no tiene ciclo de vida.
- **Tabla puente `ObligationInvoice`** (obligación → N boletas): migración, backfill, y reescribir
  todo lo que lee `obligation.invoiceId`. Encajaba con "varios comprobantes del mismo gasto", que no
  es el caso.

### 2.2 Regla "cuál es la principal"

La principal es **la vinculada a la obligación**: la primera que llegó (`linkInvoiceToObligation`
vincula la primera; las siguientes no encuentran `PENDING`). Las extras se ordenan por `createdAt`.

Si la principal se borra, la obligación vuelve a `PENDING` y la siguiente extra **no sube sola** (el
pipeline no la reprocesa). Para eso, **Sincronizar obligaciones** (`syncObligationsForClient`) pasa a
hacer el vínculo retroactivo en **todos** los períodos activos, no sólo en los que creó obligaciones
nuevas. Es el único cambio en `obligation.service.ts`. En régimen normal sigue siendo 0 updates.

## 3. Datos: overview

`src/app/api/client/obligations/overview/route.ts`, dos queries nuevas junto a `carried`:

```ts
// Boletas del mes que no ocupan ninguna obligación.
const loose = await prisma.invoice.findMany({
  where: { clientId, periodId: { in: periodIds }, carriedFromPeriodId: null, obligation: null },
  select: {
    id: true, consortiumId: true, periodId: true, providerId: true, lspServiceId: true,
    docKind: true, amount: true, sourceFileUrl: true, carryOverRequestedAt: true, createdAt: true,
    provider: true,
    providerRef: { select: { canonicalName: true, paymentAlias: true, matchNames: true } },
    lspServiceRef: { select: { clientNumber: true } },
  },
});

// Boletas que NACIERON en este mes y el owner empujó al siguiente: el mes de
// origen las sigue mostrando (rendición ante los inquilinos), sin acciones.
const carriedOut = await prisma.invoice.findMany({
  // `obligation: null` también acá: la boleta PRINCIPAL arrastrada conserva su
  // obligación (que queda CARRIED_OVER y ya se muestra en su fila); sin el filtro
  // saldría dos veces.
  where: { clientId, carriedFromPeriodId: { in: periodIds }, obligation: null },
  select: { /* los mismos campos que `loose` */ carriedFromPeriodId: true, period: { select: { year: true, month: true } } },
});
```

`Invoice.obligation ExpenseObligation?` existe en el schema (`prisma/schema.prisma:214`), así que
`obligation: null` se resuelve como `NOT EXISTS`.

Viajan por consorcio como `looseInvoices: OverviewLooseInvoice[]`:

```ts
type OverviewLooseInvoice = {
  invoiceId: string;
  providerId: string | null;
  lspServiceId: string | null;
  docKind: "FACTURA" | "RETENCION";
  concepto: string;            // providerRef.canonicalName ?? provider ?? "—"
  fantasia: string | null;     // firstMatchName(providerRef.matchNames)
  facturas: string | null;     // lspServiceRef.clientNumber
  aliasCbu: string | null;     // providerRef.paymentAlias (crudo; se parsea en sheetModel)
  amount: number | null;
  invoiceUrl: string | null;
  carryOverRequested: boolean;
  createdAt: string;
  /** "octubre 2026" si el owner la empujó al mes siguiente; null si vive acá. */
  carriedOutTo: string | null;
};
```

Para las de `carriedOut`, `consortiumId` sale de la boleta y el período de origen es
`carriedFromPeriodId`; `carriedOutTo` = `periodLabel(period.year, period.month)` del período donde
vive ahora. `carryOverRequested` de una `carriedOut` no se usa (no tiene acciones en origen).

Arrastre encadenado (julio → agosto → septiembre): `carriedFromPeriodId` sigue diciendo julio, así
que julio la muestra con `carriedOutTo: "septiembre 2026"`, agosto no la muestra (no nació ahí ni
vive ahí) y septiembre la tiene en "Vienen del mes anterior". Mismo comportamiento que hoy tiene una
principal encadenada.

## 4. Modelo puro: `sheetModel.buildSheets`

Para cada `looseInvoice` del edificio se busca el gasto fijo **activo** que matchee con
`obligationMatchesInvoice(fx, invoice)` (`src/lib/fixedExpense.ts`): proveedor o LSP + `kind` ===
`docKind`. Es el mismo criterio del pipeline, así que una retención nunca cuelga de la fila de la
factura y viceversa. Un gasto fijo desactivado no cuenta como gasto fijo para esto: su boleta va a
"Otras boletas del mes", donde se ve (la tabla de desactivados está plegada y no se imprime).

- **Match → `row.extras[]`** de esa fila:
  ```ts
  type ExtraRow = {
    invoiceId: string;
    ordinal: number;                 // 2, 3, … (la principal es la 1ª)
    monto: number | null;
    invoiceUrl: string | null;
    carryOverRequested: boolean;
    carriedOutTo: string | null;
  };
  ```
  Concepto y alias se heredan de la fila madre. Orden por `createdAt`; `ordinal` = posición + 2.
  Si la obligación de la madre está `SKIPPED` (o `PENDING` porque la principal se borró), las extras
  se muestran igual y van al papel: llegó una boleta, hay que pagarla.
- **Sin match → `sheet.others[]`**:
  ```ts
  type OtherRow = {
    invoiceId: string;
    facturas: string | null;
    concepto: string;
    fantasia: string | null;
    monto: number | null;
    aliasCbu: string[];              // parsePaymentAliases
    invoiceUrl: string | null;
    carryOverRequested: boolean;
    carriedOutTo: string | null;
  };
  ```
  Alfabético por concepto. Acá caen también las razones sociales hermanas de un proveedor que sí es
  gasto fijo (Fumigaciones Miguel, CORTES BRUNO con dos CUITs) hasta que exista el agrupamiento de
  proveedores (pendiente aparte).

`SheetRow` suma `extras: ExtraRow[]`; `SheetData` suma `others: OtherRow[]`.

Funciones auxiliares:

- `printableExtras(row)` → extras sin `carriedOutTo`. `isPrintableRow` no cambia (decide por la
  madre); el PDF y la pantalla imprimen `printableExtras` de **toda** fila madre, imprimible o no.
- `hasPrintableRows(sheet)` → `rows.some(isPrintableRow) || rows.some(r => printableExtras(r).length)
  || carried.length > 0 || others.some(o => !o.carriedOutTo)`.
- `toPrintableSheets` → `rows` se filtra con `isPrintableRow(row) || printableExtras(row).length > 0`
  (una madre no imprimible con extras queda, y el PDF decide con `isPrintableRow` si imprime la línea
  de la madre o sólo sus extras); en cada fila `extras` se reduce a `printableExtras`; `others` se
  queda sin las `carriedOutTo`. Un edificio que sólo tiene `others` **sí** se imprime.
- `filterSheets` → busca también por `concepto` en `others`.

## 5. Pantalla: `SheetCard`

- **Subfilas de extras**, inmediatamente debajo de su fila madre (sólo en la tabla de activos: una
  madre desactivada no tiene extras por §4): clase `rowExtra` (indentada, fondo suave). Celdas: ojo del PDF · FACTURAS vacío ·
  `↳ 2ª boleta` (+ badge gris `pasó a octubre 2026` si `carriedOutTo`) · monto · alias heredado ·
  TÉCNICO y TEL. vacíos · acciones: sólo **Pasar al mes siguiente** (`onToggleCarryOver(invoiceId)`),
  ninguna si `carriedOutTo`. Sin Saltear / Desactivar / estado: son de la obligación y del gasto
  fijo, no de la boleta.
- **Bloque "Otras boletas del mes"** (`othersBlock`, mismo layout que "Vienen del mes anterior"),
  entre la tabla del mes y el bloque de arrastradas. Filas: ojo · nro. cliente si LSP · razón social
  con fantasía chica debajo (+ badge `pasó a…`) · monto · alias · acciones: **Pasar al mes siguiente**.
  Sin "Cargar monto vencido" ni "Devolver": eso es de arrastradas.
- Nota vacía del edificio: si no hay gastos fijos activos pero sí `others`, no decir "no se va a
  imprimir".
- `data-printable` ya sale de `hasPrintableRows`.
- CSS (`page.module.css`): `rowExtra`, `extraLabel`, `othersBlock`, `othersTitle`; `@media print`
  esconde las filas con `carriedOutTo`.

## 6. PDF: `sheetPdf.ts`

- `body`: tras cada fila madre, sus `printableExtras`: `["", "   ↳ 2ª boleta", monto, alias, "", ""]`.
  Si la madre no es imprimible pero tiene extras, se imprimen sólo las extras, con el concepto
  completo en la primera: `"QBICAR S.A. — 2ª boleta"` (sin la fila madre no hay a qué indentarse).
- `PdfTable.others: string[][]` y `OTHERS_TITLE = "OTRAS BOLETAS DEL MES"`, renderizado igual que el
  bloque `carried`, **antes** de él. Filas: `[facturas, concepto (+ fantasía entre paréntesis),
  monto, alias, "", ""]`.
- Nada con `carriedOutTo` va al papel.

## 7. Tests

Se extienden los existentes; no hay archivos nuevos salvo el del service.

- `sheetModel.test.ts`: extra matchea por proveedor; por LSP; una RETENCION no cuelga de la fila
  FACTURA del mismo proveedor (va a `others` si no hay gasto fijo de retención); orden por
  `createdAt` y `ordinal` 2, 3; sin match → `others`; boleta de un gasto fijo desactivado → `others`;
  `carriedOutTo` se propaga; madre `SKIPPED` conserva extras; `hasPrintableRows`/`toPrintableSheets` con edificio que sólo
  tiene `others`; `toPrintableSheets` saca `carriedOutTo`; `filterSheets` encuentra por concepto en
  `others`.
- `sheetPdf.test.ts`: extra debajo de su madre; madre no imprimible con extra imprime sólo la extra
  con concepto completo; bloque `others` con título; nada con `carriedOutTo`.
- `SheetCard.test.tsx`: subfila `↳ 2ª boleta` renderiza con su monto; su botón llama
  `onToggleCarryOver(invoiceId, true)`; sin botón si `carriedOutTo`; bloque "Otras boletas del mes"
  renderiza; nota vacía correcta cuando sólo hay `others`.
- `obligation.service.test.ts` (existe): `syncObligationsForClient` vincula una boleta suelta a una
  obligación `PENDING` en un período donde no creó nada; sigue sin tocar boletas arrastradas.
- `overview/route.ts` no tiene test: se verifica con `npm run typecheck` y smoke en el navegador con
  **Edificio de Prueba** (dos boletas del mismo proveedor + una de un proveedor sin gasto fijo +
  arrastre de una extra y vista del mes de origen).

## 8. Fuera de scope

- Agrupar proveedores que son la misma empresa (CUITs hermanos): hoy caen en "Otras boletas del
  mes". Pendiente propio.
- Estado propio de las extras / otras (omitir, vencido). Si una boleta no corresponde, se borra a
  Pendientes desde Boletas entrantes.
- Reflejar extras/otras en Google Sheets: ya están ahí como filas normales.

## 9. Archivos

| Archivo | Cambio |
|---|---|
| `src/app/api/client/obligations/overview/route.ts` | queries `loose` + `carriedOut`, campo `looseInvoices` por consorcio |
| `src/app/admin/obligaciones/lib/sheetModel.ts` | tipos `ExtraRow`/`OtherRow`, cruce en `buildSheets`, `printableExtras`, `hasPrintableRows`, `toPrintableSheets`, `filterSheets` |
| `src/app/admin/obligaciones/lib/sheetPdf.ts` | extras en `body`, `others` + `OTHERS_TITLE`, render del bloque |
| `src/app/admin/obligaciones/components/SheetCard.tsx` | subfilas `rowExtra`, bloque `othersBlock`, nota vacía |
| `src/app/admin/obligaciones/page.module.css` | estilos nuevos + `@media print` |
| `src/services/obligation.service.ts` | `syncObligationsForClient`: vínculo retroactivo en todos los períodos activos |
| tests listados en §7 | |
| `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`, `CLAUDE.md` (modelo: una obligación = una boleta principal; las demás se derivan) | documentación |
