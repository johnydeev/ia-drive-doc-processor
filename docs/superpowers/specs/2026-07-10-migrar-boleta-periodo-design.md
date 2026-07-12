# Spec — Migrar boleta al período siguiente

**Fecha:** 2026-07-10
**Estado:** Diseño aprobado — pendiente de plan de implementación.

## Problema

Cuando el administrador se olvida de cerrar el período de un consorcio (ej: junio sigue
`ACTIVE`) y entran boletas que en realidad corresponden al mes siguiente, el pipeline las
asigna al período actual (junio). Hoy la única forma de corregirlo es un flujo manual y
tedioso: **borrar** cada boleta (el PDF vuelve a Pendientes), **cerrar el período** y
**reprocesar** todo. Se quiere una acción directa: desde la vista de **boletas entrantes**,
seleccionar varias boletas y **moverlas al período siguiente**, con todo lo que eso implica
(DB + Google Sheets + archivo en Drive + obligaciones de gastos fijos).

## Objetivo

Agregar una acción de **migración masiva de período** en `/admin/boletas` que mueva cada
boleta seleccionada al **mes siguiente del período actual de su propio consorcio**,
manteniendo consistentes los tres sistemas (Drive, Sheets, DB) y las obligaciones de gastos
fijos, con **reversión por boleta ante cualquier fallo**.

## Alcance y decisiones tomadas

1. **Destino = +1 mes del período actual de cada boleta**, resuelto por consorcio (cada
   consorcio tiene su propio `Period`). Sin selector de destino: es un botón único.
2. **No se crean períodos.** La migración solo mueve a un período destino que **ya existe**.
   Si el `+1` no existe, la boleta se **saltea** con aviso ("cerrá el período de X primero").
   El flujo esperado del usuario: primero "Cerrar Periodo General" (crea el mes siguiente
   `ACTIVE`), después migrar las boletas mal ubicadas.
3. **Destino debe estar `ACTIVE`.** Si el `+1` existe pero está `CLOSED`, se **saltea** con
   aviso. No se permite ensuciar períodos ya cerrados/liquidados.
4. **El PDF de Drive también se mueve** a la subcarpeta del período nuevo dentro de
   `Rendiciones/[Edificio]/`, **renombrándolo** (el nombre embebe el período, `P06-2026` →
   `P07-2026`). Si la subcarpeta destino no existe, se crea.
5. **Reversión por boleta:** si cualquier paso falla, se deshace lo ya hecho de esa boleta
   (queda como estaba), se marca como fallida y el lote **continúa** con las demás. El
   reporte se muestra al final.
6. **Boletas con pagos: se pueden mover.** A diferencia del borrado (que las bloquea), mover
   solo re-categoriza el período; los pagos siguen atados a la boleta y las celdas de pago en
   Sheets no se tocan.
7. **Boletas sin período actual** (`periodId = null`, ej: Sin Asignar): se **saltean** (no
   hay "mes actual" desde el cual avanzar).
8. **Sin migración de base de datos.** Solo se reasigna `Invoice.periodId` y se reajustan
   obligaciones existentes. No hay cambios de schema.

### Motivos de skip (una boleta no se mueve, no es un error)

| Motivo | Condición |
|---|---|
| `sin_periodo` | La boleta no tiene `periodId`. |
| `destino_inexistente` | No existe el `Period` `+1 mes` de ese consorcio. |
| `destino_cerrado` | El `Period` `+1 mes` existe pero está `CLOSED`. |

## No-objetivos (YAGNI)

- No se crea el período destino ni se cierra el período origen (eso es "Cerrar Periodo
  General", que ya existe).
- No hay selector de período arbitrario ni migración hacia atrás.
- No hay sistema de reintentos/saga distribuida. La consistencia se logra con compensación
  por boleta (ver abajo), no con transaccionalidad distribuida.
- No se borran subcarpetas de Drive vacías creadas durante una migración que luego se
  revirtió (son carpetas de período válidas e inofensivas; se reutilizan al reintentar).

## Arquitectura

Espeja el patrón ya probado del **borrado masivo** (`lib/invoiceDeletion.ts` +
`api/client/invoices/bulk-delete` + acción en `/admin/boletas`).

### 1. Lógica compartida — `src/lib/invoicePeriodMove.ts` (nuevo)

- `resolveMoveContext(clientId)` → resuelve **una vez** por lote:
  `{ driveService, sheetsService, folders, statementsRootId, sheetName, mapping }`.
  Reusa `loadProcessingClient` / `resolveGoogleConfig` / `resolveFolders` /
  `resolveSheetName` / `resolveMapping` de `clientProcessingConfig` (igual que
  `resolveDeletionContext`). `statementsRootId` sale de `driveFoldersJson.statements`.

- `moveOneInvoiceToNextPeriod(ctx, clientId, invoiceId)` →
  `{ ok: true, fromLabel, toLabel } | { ok: false, reason } | { ok: false, error, reverted }`.

  **Preparación (sin efectos):**
  1. Carga la boleta con `periodRef`, `consortiumRef` (id, rawName, statementsFolderId),
     `driveFileId`, `sourceFileUrl`, `boletaNumber`, `providerTaxId`, `provider`,
     `consortium`, `documentHash`.
  2. Si `periodId == null` → `{ ok:false, reason:"sin_periodo" }`.
  3. Calcula `(año, mes) + 1` (wrap dic→ene). Busca el `Period` destino:
     `prisma.period.findUnique({ consortiumId_year_month })`.
     - No existe → `{ ok:false, reason:"destino_inexistente" }`.
     - Existe pero `status != ACTIVE` → `{ ok:false, reason:"destino_cerrado" }`.
  4. Captura estado previo: `prevPeriodLabel` (`MM/YYYY`), `oldFileName`, `newFileName`
     (`buildInvoiceFileName` con mes/año nuevos), `oldParentFolderId`
     (`drive.getFileParents(fileId)` → primer parent real), `newPeriodFolderId`
     (`resolveStatementsFolders` con mes/año destino; crea subcarpeta si falta).

  **Ejecución (orden: Drive → Sheets → DB, con pila de compensación):**
  1. **Drive** — mover + renombrar en **una sola llamada atómica** `files.update`
     (`addParents: newPeriodFolderId`, `removeParents: oldParentFolderId`,
     `requestBody: { name: newFileName }`). Nuevo método
     `GoogleDriveService.moveAndRenameFile(fileId, fromFolderId, toFolderId, newName)`.
     Compensación registrada: `moveAndRenameFile(fileId, newPeriodFolderId, oldParentFolderId, oldFileName)`.
     *(Si el archivo no está bajo Rendiciones —legado— igual se mueve desde su parent real
     a la subcarpeta del período destino; efecto colateral benigno: lo normaliza a
     Rendiciones.)*
  2. **Sheets** — actualizar celda PERIODO (M) a `MM/YYYY` destino. Reusa
     `updateInvoicePaymentInfo(sheetName, mapping, keys, { period: newLabel })` (busca la
     fila por `sourceFileUrl`, que **no cambia** al mover/renombrar en Drive — el `fileId`
     y el `webViewLink` se preservan). Compensación registrada: reescribir `period:
     prevPeriodLabel`.
  3. **DB (transacción)** — `invoice.periodId = destino`; la obligación de gasto fijo del
     período origen vinculada a esta boleta (si hay) → `PENDING`, `invoiceId = null`; luego
     `linkInvoiceToObligation(invoice)` sobre el período nuevo (vincula si hay una
     obligación `PENDING` que matchee). Al ser transacción, se confirma o se revierte sola;
     **las obligaciones nunca se deshacen a mano.**

  **Manejo de fallo:** si cualquier paso lanza (incluida la transacción de DB), se ejecuta
  la pila de compensación en **orden inverso** (LIFO: Sheets→Drive) → la boleta queda
  **exactamente como estaba** → `{ ok:false, error, reverted:true }`. Si una compensación
  **también** falla → `{ ok:false, error, reverted:false, detail }` (reportado aparte como
  "revisar manualmente"). El lote **nunca aborta** por una boleta.

**Por qué DB va última:** es el único paso transaccional; ubicándolo al final, su propio
rollback cubre `periodId` + obligaciones sin lógica de inversión manual. Las únicas
compensaciones son las de los dos pasos externos (Drive, Sheets), cada una una sola llamada
inversa.

### 2. Endpoints

- `POST /api/client/invoices/bulk-move-period/preview` `{ invoiceIds: string[] }`
  → **sin efectos**. Para cada boleta calcula `{ invoiceId, consortium, fromLabel, toLabel }`
  (movibles) o `{ invoiceId, consortium, reason }` (skip). Alimenta el paso 1 del modal.
- `POST /api/client/invoices/bulk-move-period` `{ invoiceIds: string[] }`
  → resuelve el contexto una vez, recorre y devuelve
  `{ moved, skipped: [{invoiceId, reason}], failed: [{invoiceId, error, reverted}], total }`.

Ambos con `withClientAuth`, límite `max(200)` como `bulk-delete`.

### 3. UI — `src/app/admin/boletas/page.tsx`

- Junto a "Borrar seleccionadas", nuevo botón **"Mover al período siguiente"**
  (`AsyncButton` / `useAsyncAction`), habilitado con ≥1 boleta seleccionada.
- **Modal de 2 pasos** (estilo "Cerrar Periodo General"):
  - **Paso 1 — Preview:** llama a `/preview`. Lista "Se moverán" (`consorcio: 06/2026 →
    07/2026`) y "Se saltearán" con el motivo legible por skip. Botón "Confirmar migración".
  - **Paso 2 — Resultado:** llama al endpoint de ejecución. Muestra contadores
    (`N movidas · M salteadas · K fallaron`) y el detalle de fallidas / no revertidas.
- Al cerrar, refresca la lista de boletas.

**Etiquetas de motivo (skip) para la UI:**
`sin_periodo` → "sin período asignado"; `destino_inexistente` → "el período siguiente no
existe todavía (cerrá el período primero)"; `destino_cerrado` → "el período siguiente está
cerrado".

## Flujo de datos (una boleta, camino feliz)

```
Invoice(periodId=Jun) --preparación--> destino=Period(Jul, ACTIVE)
  1. Drive:  Rendiciones/[Ed]/2026-06 Junio/…P06-2026….pdf
             → Rendiciones/[Ed]/2026-07 Julio/…P07-2026….pdf   (1 files.update)
  2. Sheets: fila (por sourceFileUrl) → celda M "06/2026" → "07/2026"
  3. DB txn: invoice.periodId=Jul; obligación Jun → PENDING/null; link a obligación Jul
Resultado: { ok, fromLabel:"06/2026", toLabel:"07/2026" }
```

## Manejo de errores

- **Por boleta:** compensación LIFO ante cualquier fallo (ver arriba). Reversión → la boleta
  queda como estaba. Compensación fallida → reporte "revisar manualmente".
- **Por lote:** una boleta fallida/salteada no aborta el resto; todo se reporta al final.
- **Contexto Google no resoluble** (sin credenciales / sin cliente): el endpoint falla
  entero con 4xx antes de tocar nada (igual que `bulk-delete`).

## Testing

- `src/lib/invoicePeriodMove.test.ts` (Vitest, servicios mockeados):
  - Cálculo de período destino: `+1` normal y wrap dic→ene.
  - Ramas de skip: `sin_periodo`, `destino_inexistente`, `destino_cerrado`.
  - Camino feliz: orden de llamadas Drive→Sheets→DB.
  - **Reversión:** fallo en Sheets ⇒ se ejecuta la compensación de Drive; fallo en la txn de
    DB ⇒ se ejecutan las compensaciones de Sheets y Drive; el estado queda revertido.
  - Compensación fallida ⇒ `reverted:false`.
- Verificación completa: `npm run typecheck` + `npm run lint` + `npm test` + `npm run build:jobs`.

## Archivos afectados

| Archivo | Cambio |
|---|---|
| `src/lib/invoicePeriodMove.ts` | **Nuevo.** Contexto + `moveOneInvoiceToNextPeriod` + compensación. |
| `src/lib/invoicePeriodMove.test.ts` | **Nuevo.** Tests de la lógica y la reversión. |
| `src/services/googleDrive.service.ts` | **Nuevo** método `moveAndRenameFile` (move+rename atómico). |
| `src/app/api/client/invoices/bulk-move-period/route.ts` | **Nuevo.** POST ejecución. |
| `src/app/api/client/invoices/bulk-move-period/preview/route.ts` | **Nuevo.** POST preview. |
| `src/app/admin/boletas/page.tsx` | Botón + modal de 2 pasos. |
| `docs/{progreso,decisiones}.md`, `CHANGELOG.md` | Documentación obligatoria. |

## Reutilización (no reinventar)

- `resolveStatementsFolders` (edificio + subcarpeta de período, crea si falta).
- `buildInvoiceFileName` / `buildStatementPeriodFolderName` (naming con período embebido).
- `updateInvoicePaymentInfo` (actualiza celda PERIODO por fila).
- `linkInvoiceToObligation` (vínculo boleta↔obligación del período nuevo).
- `loadProcessingClient` / `resolveGoogleConfig` / `resolveFolders` / `resolveSheetName` /
  `resolveMapping` (contexto Google, igual que `invoiceDeletion`).
- `AsyncButton` / `useAsyncAction` (feedback de carga, patrón estándar del panel).
