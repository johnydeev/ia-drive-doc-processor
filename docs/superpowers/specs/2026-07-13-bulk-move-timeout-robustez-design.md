# Spec — Robustez de `bulk-move-period` ante el timeout de Cloudflare (524)

**Fecha:** 2026-07-13
**Estado:** Diseño aprobado — pendiente de plan de implementación.

## Problema

La feature "Mover boletas al período siguiente" (bulk, en `/admin/boletas`) mueve cada boleta al mes
siguiente de su consorcio tocando **Drive → Sheets → DB** por boleta. Con lotes grandes (~20) el
request supera los **~100s** y el **túnel de Cloudflare corta con 524**, devolviendo una página HTML.
El frontend hace `res.json()` sobre ese HTML → revienta con `Unexpected token '<', "<!DOCTYPE"`. El
server, en cambio, sigue procesando hasta terminar (Cloudflare solo cierra la conexión con el cliente).

Evidencia (incidente 2026-07-13): 20 boletas 06→07/2026, `updatedAt` de 14:50:35 a 14:53:33 (~178s).
Las 20 se movieron **correctamente** (deltas exactos, ninguna a medias) — porque la DB es el último
paso y es transaccional. Pero:

1. **La UX muestra un error crudo** aunque la operación haya sido exitosa (el timeout ≠ fallo).
2. **No es idempotente:** un reintento recalcula "mes siguiente del período **actual**", así que una
   boleta ya movida se movería +1 otra vez. Hoy zafa solo porque el destino+1 no existe; si existiera
   ACTIVE, se duplicaría el avance.
3. **Riesgo latente de estado parcial:** si el **proceso** muere a la mitad (no Cloudflare, sino el
   container/proceso), pueden quedar boletas con Drive/Sheets movidos pero DB sin actualizar.

Es el patrón conocido del proyecto (memoria `cloudflare-100s-timeout-batch-endpoints`).

## Objetivos

- Que un lote de **hasta 20 boletas** complete **bajo los 100s** (sin 524).
- Que **reintentar sea siempre seguro** (idempotente): no mueve dos veces, reconcilia estados parciales.
- Que el **frontend nunca muestre el error crudo**: ante timeout/respuesta inválida, informa el estado
  real y ofrece **reintentar**. Un timeout no se presenta como fallo.
- **Observabilidad:** logs estructurados en el server para diagnosticar a futuro (humano o asistente IA).

## No-objetivos (fuera de alcance)

- **Procesamiento en background / cola (opción 3 del handoff).** No se hace ahora. Consecuencia asumida:
  si el proceso muere a la mitad, el estado parcial **existe hasta que el usuario reintente** — no hay
  reconciliación automática.
- **Paralelizar las llamadas a Google por boleta** (riesgo de carreras al crear carpetas de Drive). Se
  descarta: con la optimización de Sheets ya se entra cómodo en <100s.
- Subir el límite del túnel (el plan free de Cloudflare topa en 100s, no configurable).

## Diseño

### Pieza 1 — Tope de 20 por tanda

- `bodySchema` de execute y preview: `max(40)` → **`max(20)`**.
- UI: el guard existente pasa a `MAX_MOVE_BATCH = 20`, con el aviso "hasta 20 por tanda; el resto en la
  siguiente".

### Pieza 2 — Idempotencia por período destino explícito

Hoy execute recibe `invoiceIds` y recalcula el destino como "mes siguiente del actual". Se cambia a que
la operación sea **"asegurá que la boleta X quede en el período P"** (P explícito):

- **Contrato del preview** (sin cambios de request): además de `movable`/`fromLabel`/`toLabel`, devuelve
  **`targetPeriodId`** por boleta (ya lo resuelve `classifyTarget`).
- **Contrato del execute** (cambia): recibe `{ moves: Array<{ invoiceId, targetPeriodId }> }` (max 20),
  no `invoiceIds`. La UI arma `moves` con los ítems `movable` del preview.
- **Idempotencia en el server**, por boleta:
  - Si `invoice.periodId === targetPeriodId` → **skip `ya_en_destino`** (no hace nada).
  - Si no, **validar** el destino (existe, `ACTIVE`, mismo consorcio que la boleta, y es el mes
    inmediatamente siguiente al período actual de la boleta) → si no valida, skip `destino_invalido`.
  - Si valida → ejecuta el move hacia P.
- **Clave:** como P es fijo (no "actual+1"), reintentar con la **misma lista `moves`** nunca avanza de
  más — las ya movidas caen en `ya_en_destino`.

### Pieza 3 — Sheets: una sola lectura por lote (preserva la compensación)

El costo redundante actual: `updateInvoicePeriodCell` hace un `values.get` de **toda la hoja por cada
boleta** para ubicar la fila. Se cambia a:

- Al inicio del lote, **una** lectura de la hoja → `Map(clave → nº de fila)` (clave = `sourceFileUrl`,
  con fallback `boletaNumber`+`providerTaxId`). Nuevo método `GoogleSheetsService.loadRowIndex(...)`.
- Cada boleta usa ese mapa (sin re-leer) y hace **solo la escritura** de su celda PERIODO
  (`USER_ENTERED`, para mantener el formato "julio-2026"). Nuevo método
  `updatePeriodCellAtRow(sheetName, mapping, rowNumber, label)`.
- La compensación sigue siendo por boleta (reescribir la celda con el valor viejo) → **el modelo de
  reversión LIFO no cambia**. Los índices de fila son estables durante el lote (se actualizan celdas,
  no se insertan/borran filas).
- Efecto: Sheets pasa de ~2 llamadas/boleta a **1 lectura/lote + 1 escritura/boleta**. Estimado: de
  ~9s/boleta a ~2-3s/boleta → 20 boletas ≈ 40-60s.

### Pieza 4 — Resiliencia a "el proceso muere a la mitad" (backend)

No se puede *evitar* el estado parcial sin cola. Se lo hace **seguro y auto-reparable** vía reintento:

- **La DB queda como último paso y fuente de verdad.** DB en período viejo = "no se hizo" → reintentar
  rehace todo. DB en destino = "hecho" → skip. (Si la DB fuera primero, un skip dejaría Drive/Sheets sin
  reconciliar → peor. Por eso DB last.)
- **Cada paso es idempotente/reconciliador** al reintentar:
  - Drive: si el archivo ya está en la carpeta destino → rama "renombrar solo" (nombre ya correcto →
    no-op). Si no → mover+renombrar.
  - Sheets: reescribir la celda al mismo valor → no-op.
  - DB: `periodId = destino`.
- Resultado: reintentar la misma lista `moves` reconcilia las que quedaron a medias, sin tocar las
  completas.

### Pieza 5 — Frontend robusto + UX de reintento

- `confirmMove(moves)`:
  - Respuesta **OK y JSON válido** → modal de resultado (movidas / salteadas / fallidas) + refetch.
  - Respuesta **no-ok / no-JSON / error de red** (timeout 524) → **no romper**: guardar la lista `moves`
    original, refetch de la lista, y mostrar mensaje claro + botón **Reintentar**:
    > "No pude confirmar el resultado. Revisé el estado: **N ya están en [destino], M siguen en
    > [origen].** [Reintentar]"
  - El conteo "N ya / M pendientes" se calcula **client-side, sin endpoint nuevo**: el front ya tiene la
    selección original con su `fromLabel`/`toLabel` (del preview del paso 1); tras el refetch de la lista,
    cuenta cuántas de las originalmente seleccionadas ya muestran `toLabel` (hechas) vs. siguen en
    `fromLabel` (pendientes).
  - **Reintentar** = `confirmMove(mismaListaMoves)`. Es seguro (idempotente) y cada vez tarda menos (las
    hechas son skips rápidos); su propio resultado (si vuelve JSON) confirma "N ya_en_destino, M movidas".
- Detección de "no-JSON": `!res.ok` o `content-type` no-JSON o `res.json()` que lanza → rama
  "resultado desconocido".

### Pieza 6 — Logs estructurados en el server

Nuevo namespace de log (estilo `pipelineLog`/`repoLog`), en `moveOneInvoiceToNextPeriod` y
`moveInvoicesToNextPeriod`:

- Por boleta: inicio (`invoiceId` corto, `de→a`), **duración** total, resultado (`ok`/`skip:<motivo>`/
  `failed`), y en fallo: **en qué paso** (drive/sheets/db) + error + si se **revirtió** (`reverted`).
- Por lote: línea resumen (`total`, `moved`, `skipped`, `failed`, duración total).
- Objetivo: que ante un incidente futuro haya traza suficiente para diagnosticar sin adivinar.

## Modelo de reintento (flujo completo del usuario)

1. Selecciona ≤20 boletas → "Mover al período siguiente" → preview (paso 1) muestra qué se mueve.
2. Confirma → execute(`moves`).
3. **Termina < 100s:** modal "20 movidas". Fin.
4. **Timeout (>100s):** el front muestra "No pude confirmar — N ya en julio, M siguen en junio
   [Reintentar]" (casi siempre M=0 porque el server terminó igual).
   - Si **M=0** → ya está, cierra.
   - Si **M>0** → Reintentar → completa las M que faltaban (rápido). Repite hasta M=0.
5. **El único evento que el usuario mira:** "¿quedaron boletas en el período viejo?". Un timeout **no**
   es fallo.

## Manejo de errores / consistencia

- Fallo de Drive/Sheets/DB en **una** boleta → esa boleta se revierte (compensación LIFO existente) y se
  reporta `failed` con el paso; el lote sigue. Igual que hoy.
- Reintentar siempre es seguro (idempotente por destino explícito).
- Estado parcial por muerte del proceso → se reconcilia en el próximo reintento (no automático).

## Testing (Vitest, lógica pura + fakes)

- Idempotencia: `moveOne` con `invoice.periodId === targetPeriodId` → skip `ya_en_destino`, sin tocar
  Drive/Sheets/DB.
- Validación de destino: destino inexistente / no-ACTIVE / de otro consorcio / no-siguiente → skip
  `destino_invalido`.
- Reconciliación: archivo ya en carpeta destino → rama "renombrar solo" (no-op de move).
- Sheets read-once: `loadRowIndex` + `updatePeriodCellAtRow` con fake, y que la compensación reescribe
  el valor viejo.
- Los tests existentes de `invoicePeriodMove` se adaptan al nuevo contrato (moves/targetPeriodId).
- Verificación: `npm run typecheck` + `lint` + `vitest run` + `build:jobs`.

## Archivos afectados

- `src/lib/invoicePeriodMove.ts` — contrato por destino explícito, idempotencia, uso del row-index, logs.
- `src/services/googleSheets.service.ts` — `loadRowIndex` + `updatePeriodCellAtRow`.
- `src/lib/logger.ts` — namespace de logs del move.
- `src/app/api/client/invoices/bulk-move-period/route.ts` — contrato `moves`, `max(20)`.
- `src/app/api/client/invoices/bulk-move-period/preview/route.ts` — devuelve `targetPeriodId`, `max(20)`.
- `src/app/admin/boletas/page.tsx` — `MAX_MOVE_BATCH=20`, UX de reintento (mensaje + botón), manejo de
  respuesta no-JSON.
- `src/lib/invoicePeriodMove.test.ts` — adaptación + casos nuevos.
- Docs: `progreso.md`, `decisiones.md`, `CHANGELOG.md`.

Sin migración de DB.
