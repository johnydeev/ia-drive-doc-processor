# Spec — Barra de progreso en tiempo real para las acciones masivas de Boletas entrantes

**Fecha:** 2026-08-06
**Tipo:** Feature de UI (sólo frontend).
**Estado de partida (verificado):** working tree limpio en `379d6f6`, **456 tests** verdes,
`admin/boletas/page.tsx` en **568 líneas**, sin `hooks/` ni `components/` propios.
**NO requiere migración. NO requiere cambios de backend.**

---

## 1. Problema

Las dos acciones masivas de `/admin/boletas` — **Borrar seleccionadas** y **Mover al período
siguiente** — están limitadas a **10 boletas por tanda**, con el tope declarado tanto en el Zod de
los endpoints como en la UI:

- `src/app/api/client/invoices/bulk-delete/route.ts:9` → `.max(10)`
- `src/app/api/client/invoices/bulk-move-period/route.ts:12` → `.max(10)`
- `src/app/api/client/invoices/bulk-move-period/preview/route.ts:7` → `.max(10)`
- `src/app/admin/boletas/page.tsx:12-14` → `MAX_MOVE_BATCH` / `MAX_DELETE_BATCH`

El tope existe por una razón real y medida: cada boleta cuesta **~8,5 s** (dominado por llamadas a
Drive) y el túnel de Cloudflare corta cualquier request a **~100 s**. Diez boletas ≈ 85 s entran
justo por debajo. Ver `docs/decisiones.md` (2026-07-12 y 2026-07-13) para el incidente que originó
el tope.

Consecuencias para el usuario:

1. **Mover 50 boletas son 5 tandas manuales**, cada una exigiendo estar frente a la pantalla ~85 s
   para poder disparar la siguiente.
2. **Durante esos 85 s no hay ninguna señal de avance.** El botón dice "Moviendo..." y nada más. No
   se sabe si va por la primera o por la novena, ni si algo se trabó.

Este spec ataca las dos cosas con un cambio acotado al frontend.

## 2. Alcance

**Dentro:** el bucle de tandas y la UI de progreso de las dos acciones masivas de
`/admin/boletas`, más la limpieza del estado `unknown` que queda sin propósito.

**Fuera (decidido explícitamente):** la cola persistida en background sobre `ProcessingJob` con
worker y polling. Se evaluó y se pospuso — requiere migración, dispatcher por tipo en el worker y
endpoints de estado; es **1 sesión dedicada con spec propio**. Este trabajo no la bloquea ni la
contradice: si algún día se hace, el runner del frontend se conserva y sólo cambia quién ejecuta.

## 3. Hallazgos verificados que condicionan el diseño

Relevados sobre el código antes de diseñar.

### 3.1 El índice de Sheets se carga una vez por request, no por boleta

`src/lib/invoiceDeletion.ts:185` (`deleteInvoicesWithIndex`) hace **una** `loadRowIndex` por lote y
después resuelve cada fila en memoria con `findRowInIndex`, ajustando el corrimiento con
`adjustIndexAfterDelete`. `invoicePeriodMove.ts` tiene la estructura equivalente vía
`ctx.sheetRowIndex` (`invoicePeriodMove.ts:312-317`).

Esa optimización es de 2026-07-13 y bajó la porción de Sheets de **~9 s a ~2-3 s por boleta**. De
ahí se deduce que **la lectura completa de la hoja vale ~6,5 s por sí sola**.

**Consecuencia directa sobre este diseño:** achicar la tanda no elimina esa optimización —la
`loadRowIndex` sigue siendo una sola por request— pero **reduce el denominador** entre el cual se
reparte su costo. Descomponiendo los ~8,5 s actuales: 6,5 ÷ 10 = 0,65 s de lectura amortizada, más
~7,85 s de Drive + escritura + DB.

| Tamaño de tanda | Costo/boleta | 50 boletas | Checkpoint cada | Duración de 1 request |
|---|---|---|---|---|
| 1 | ~14,5 s | ~12,5 min (+70%) | ~15 s | ~15 s |
| **5 (elegido)** | **~9,2 s** | **~7,6 min (+8%)** | **~46 s** | **~46 s** |
| 10 (hoy) | ~8,5 s | ~7,1 min | — (sin avance visible) | ~85 s |

**Decisión del owner: `RUN_CHUNK = 5`.** Da avance visible cada ~46 s a un costo de tiempo total
casi nulo (+8%). La tanda de 1 se evaluó y se descartó: triplica el sobrecosto para ganar
granularidad que a esta escala no cambia la experiencia.

**Nota sobre la aritmética:** los 8,5 s están medidos en producción (lote de 20 → 169 s). Los ~9,2 s
son una derivación de la línea de docs sobre la porción de Sheets, no una medición del camino nuevo.
Rango honesto: **+5% a +20%**. Por eso el tamaño de tanda es una constante (§6.3), no un número
cableado.

### 3.2 Con tandas de 5, el 524 se vuelve improbable pero no imposible

Una request de ~46 s contra un techo de ~100 s deja un margen de **~2,2×** — cómodo, pero no
holgado: una tanda con boletas lentas en Drive podría acercarse. Es el precio de haber elegido 5 en
vez de 1 (que daba 7×).

Igual se elimina el estado dedicado `moveStep === "unknown"` (`page.tsx:539-562`) y su maquinaria de
conteo best-effort (`pendingMoves`, `pendingItems`, `doneCount`, `stillPendingCount`), **porque el
manejo genérico de error por ítem ya lo cubre mejor**: si una tanda devuelve algo no parseable, sus
5 boletas se marcan en rojo con el mensaje *"resultado no confirmado — puede que hayan terminado
igual; reintentar es seguro"*, y el botón Reintentar fallidas las reconcilia (§3.3). La información
que antes daba el modal `unknown` para todo el lote, ahora la da la lista por fila.

### 3.3 Los endpoints ya son idempotentes

`bulk-move-period` recibe destino explícito y "asegura X en P" (si ya está → `ya_en_destino`);
`bulk-delete` reutiliza `deleteInvoicesWithIndex`. Reintentar la misma lista es seguro y no avanza
de más. **Esto es lo que habilita el botón "Reintentar fallidas"** sin ninguna salvaguarda extra.

### 3.4 El preview del move es barato

`bulk-move-period/preview` es read-only: no toca Drive ni Sheets. Su `.max(10)` se sortea mandándolo
en tandas de 10 y concatenando, sin costo perceptible.

### 3.5 `boletas/` no sigue la convención del proyecto

`consortiums/` tiene `hooks/`, `components/` y `lib/`; `boletas/` es un `page.tsx` suelto de 568
líneas. Las piezas nuevas estrenan esa estructura en `boletas/`.

## 4. Los tres desenlaces por boleta

El diseño distingue tres resultados, no dos. Es la base de la UI y del manejo de errores.

| Desenlace | Qué significa | Color |
|---|---|---|
| **OK** | Terminó bien | Verde |
| **Skip** | Razón de negocio, nada se rompió. Sólo en *mover*: `sin_periodo`, `destino_inexistente`, `destino_cerrado`, `ya_en_destino`, `destino_invalido` (`page.tsx:184-190`) | Ámbar |
| **Failed** | Error real | Rojo |

Casos de **failed** en borrado (`src/lib/invoiceDeletion.ts`):

| Caso | Origen | ¿Reintentar sirve? |
|---|---|---|
| 409 — la boleta tiene pagos registrados | `invoiceDeletion.ts:102` | No |
| 404 — boleta no encontrada (lista desactualizada) | `invoiceDeletion.ts:100` | No |
| 502 — Drive al mover el PDF | `invoiceDeletion.ts:127` | Sí |
| 502 — Drive al borrar el recibo | `invoiceDeletion.ts:138` | Sí |
| 502 — Sheets al borrar la fila | `invoiceDeletion.ts:156` | Sí |

En *mover* (`invoicePeriodMove.ts:281-341`) la falla ocurre en uno de tres pasos (`drive`, `sheets`,
`db`) y dispara **compensación LIFO**. El resultado trae `reverted: true` (quedó como estaba) o
**`reverted: false`** — la compensación también falló y la boleta quedó a medias. Ese es el único
caso que exige intervención humana y se destaca aparte.

Causas transversales realistas: blip de red durante una corrida de ~8 min, y **reinicio de los
contenedores por un deploy a `master` en plena corrida** (el CI/CD deploya automático). Con tandas
de 5, un reinicio deja como máximo 5 boletas en rojo, reintentables.

## 5. Decisiones tomadas

| Decisión | Elegido | Razón |
|---|---|---|
| Granularidad | **`RUN_CHUNK = 5`** | Avance visible cada ~46 s por +8% de tiempo total. La tanda de 1 daría avance por boleta pero cuesta +70% (§3.1) |
| Forma del tamaño de tanda | **Constante, no cableada** | La aritmética es una derivación, no una medición (§3.1). Si en producción resulta lento, subirlo a 10 es cambiar un número |
| Ante un fallo | **Seguir siempre y reportar al final** | Una corrida de 12 min no puede quedar colgada esperando por una boleta con pagos. Mantiene el comportamiento del lote server-side |
| Reintento | **Botón "Reintentar fallidas"** al terminar | Habilitado por la idempotencia (§3.3) |
| Cancelación | **Botón Cancelar** durante la corrida | Bandera chequeada entre tanda y tanda (granularidad: ~46 s) |
| Tope de selección | **Se elimina** | El techo natural pasa a ser la página (50 boletas). Antes de confirmar se muestra el tiempo estimado |
| UI de progreso | **Barra + lista de filas con estado** | Al terminar, la misma lista ES el resumen; no hay salto a otra pantalla |
| Refresco de la tabla | **Una sola vez al final** | Refrescar por boleta sería lento y haría parpadear la lista |

## 6. Arquitectura

Runner **genérico** compartido por las dos acciones. Se descartó duplicar la lógica por acción o
dejarla inline en `page.tsx`: el bucle secuencial, la cancelación, el reintento y los contadores son
idénticos, y `page.tsx` ya está grande. Sigue el patrón hook-por-dominio + componente presentacional
validado 15 veces durante el refactor de `consortiums/`.

### 6.1 Tier 0 — `boletas/lib/batchProgress.ts` (puro, sin React)

El estado de la corrida como datos:

```ts
type BatchItemStatus = "pending" | "running" | "done" | "failed" | "skipped";
type BatchItem = { id: string; label: string; status: BatchItemStatus; message?: string };
type BatchItemResult =
  | { status: "done" }
  | { status: "skipped"; message: string }
  | { status: "failed"; message: string; needsReview?: boolean };
```

Funciones puras: `initBatchItems`, `applyItemResult`, `summarizeBatch` (contadores + porcentaje),
`estimateRemaining` (ETA por **promedio medido en vivo**, no una constante — si la conexión va más
rápida, la estimación acompaña) y `formatEta`.

`needsReview` es el `reverted: false` del move.

### 6.2 Tier 0 — adaptadores de respuesta

Dos funciones puras que normalizan la respuesta de cada endpoint a **un resultado por `invoiceId`**
(`Map<string, BatchItemResult>`). Son necesarias porque los endpoints hablan distinto:
`bulk-delete` responde `{ deleted, failed[] }`; `bulk-move-period` responde
`{ moved, skipped[], failed[] }` con motivo de skip y flag `reverted`.

**Detalle que importa con tandas de 5:** en ambos endpoints los conteos de éxito (`deleted`,
`moved`) son **números**, no listas de ids — sólo `skipped[]` y `failed[]` traen `invoiceId`. Por lo
tanto la regla de mapeo es: *todo id enviado que no aparezca en `skipped[]` ni en `failed[]` se marca
`done`*. Si la respuesta entera es no parseable, los 5 ids se marcan `failed` con "resultado no
confirmado" (§3.2).

Al ser puras se testean sin red.

Los motivos de skip se traducen con el `SKIP_LABELS` que hoy vive inline en `page.tsx:184-190`, que
se muda a `boletas/lib/` junto a los adaptadores.

### 6.3 Tier 1 — `boletas/hooks/useBatchRunner.ts`

```ts
const RUN_CHUNK = 5;

useBatchRunner<T>({
  runChunk: (entries: T[]) => Promise<Map<string, BatchItemResult>>,
  chunkSize?: number,   // default RUN_CHUNK
})
  → { items, summary, isRunning, start, cancel, retryFailed }
```

Bucle secuencial: parte las entradas en tandas de `chunkSize` y hace `await` de a una tanda.
Detalles que importan:

- Antes de disparar cada tanda, sus ítems pasan a `running` (los 5 juntos); al volver, cada uno
  toma su estado del `Map`. Es lo que hace avanzar la barra de a 5.
- La bandera de cancelación va en un **`useRef`**, no en `useState`: un `useState` quedaría
  capturado con su valor viejo dentro del bucle y el Cancelar no tendría efecto.
- Guard anti doble-arranque (mismo criterio que `useAsyncAction`).
- `retryFailed` re-corre **sólo** las entradas en `failed`, re-agrupándolas en tandas nuevas y
  reutilizando el mismo `runChunk`.
- `chunkSize` es parámetro para poder testear con tandas de 2 sin depender de la constante de
  producción.

### 6.4 Tier 2 — `boletas/components/BatchProgressModal.tsx`

Presentacional puro. Barra + `"23 de 50"` + ETA, la lista de filas con su estado, y botones según el
momento: **Cancelar** mientras corre; **Reintentar fallidas** + **Cerrar** al terminar.

### 6.5 Cableado en `page.tsx`

- `handleDeleteSelected` conserva su `window.confirm` previo (borrar es destructivo), ahora con la
  cantidad **y el tiempo estimado**; al aceptar arma las entradas desde `selected` y abre el modal.
  `runChunk` = POST a `bulk-delete` con `invoiceIds` de hasta 5 elementos. **Borrar no gana un paso
  de preview** — sigue siendo confirm directo.
- `confirmMove` ídem con `bulk-move-period` y `moves: [{ invoiceId, targetPeriodId }, …]` de hasta 5.
  El move conserva su paso de preview, que suma el tiempo estimado junto al `Confirmar (N)`.
- `openMoveModal` (el preview) manda en tandas de 10 y concatena `items`. Es read-only y barato
  (§3.4), por eso usa un tamaño distinto al de ejecución.
- `MAX_MOVE_BATCH` y `MAX_DELETE_BATCH` se reemplazan por dos constantes con propósito distinto:
  `RUN_CHUNK = 5` (ejecución) y `PREVIEW_CHUNK = 10` (preview). Los guards de tope de selección y
  sus mensajes de error se eliminan.
- Al terminar (o al cancelar), un único `fetchInvoices()`.

**El backend no se toca.** El `.max(10)` de los tres endpoints sigue vigente y se le mandan 5.

### 6.6 Limpieza incluida

Se elimina el paso `moveStep === "unknown"` y su maquinaria (§3.2): `pendingMoves`, `pendingItems`,
`doneCount`, `stillPendingCount` y el bloque JSX (`page.tsx:539-562`). Son ~40 líneas de código
superado por el manejo genérico de error por ítem, en el archivo que este trabajo toca igual.

## 7. Bordes

- Cancelar frena **antes de la tanda siguiente**; la tanda en vuelo (hasta 5 boletas) se deja
  terminar y sus resultados se registran. Lo hecho queda hecho; la lista muestra hasta dónde llegó.
  El botón avisa que puede tardar hasta ~46 s en tomar efecto.
- **El modal no se puede cerrar mientras corre**: no hay botón Cerrar ni cierre por click en el
  overlay hasta que la corrida termina. Para frenar hay que usar Cancelar. Es más simple que un
  diálogo de confirmación y evita de raíz que la corrida siga invisible.
- `reverted: false` se marca aparte y más fuerte que un fallo común: es el único caso que pide
  revisión manual.
- Los skips van en ámbar, no en rojo: no son fallas.
- Cuota de la API de Google: con tandas de 5 se lee la hoja entera una vez cada 5 boletas, muy lejos
  del techo de ~60 requests/min.
- El costo de la lectura de hoja crece de forma lineal con el tamaño de la planilla (hoy ~900
  boletas). Si algún día esa lectura se encarece, `RUN_CHUNK` es la perilla para compensar.

## 8. Testing

- **Tier 0** (`batchProgress.test.ts`, `batchAdapters.test.ts`): transiciones de estado, contadores,
  porcentaje, ETA y formato; normalización de las dos formas de respuesta, incluidos skip con motivo
  y failed con `reverted: false`. **Caso clave:** la regla "todo id enviado que no vuelve en
  `skipped[]`/`failed[]` es `done`" (§6.2), incluida una tanda mixta (2 done + 1 skip + 2 failed) y
  una respuesta no parseable que marca los 5 en rojo.
- **Tier 1** (`useBatchRunner.test.tsx`, con `chunkSize: 2` para no depender de la constante de
  producción): agrupa en tandas del tamaño pedido; corre las tandas en orden; sigue tras una tanda
  con fallos; `cancel` frena antes de la tanda siguiente pero registra la que estaba en vuelo;
  `retryFailed` re-agrupa y re-corre sólo las fallidas; no arranca dos veces.
- **Tier 2** (`BatchProgressModal.test.tsx`): render de los cuatro estados de fila; botones
  habilitados según el momento de la corrida.

Verificación final: `npm run typecheck` + `npm run lint` + `npx vitest run` + `npm run build` +
`npm run build:jobs`.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| La corrida es ~8% más lenta (rango +5% a +20%) | Aceptado (§3.1). Si en producción resulta peor, `RUN_CHUNK` a 10 lo revierte |
| Request de ~46 s contra techo de 100 s: margen 2,2×, menos holgado que con tandas de 1 | Un 524 marca esas 5 en rojo con "resultado no confirmado"; Reintentar fallidas reconcilia (§3.2) |
| Un deploy a mitad de corrida mata la request en vuelo | Hasta 5 boletas quedan rojas y se reintentan |
| El usuario cierra la pestaña a mitad | Lo procesado quedó procesado (cada boleta es una transacción completa); el resto no se tocó |
| `page.tsx` crece en vez de achicarse | Las tres piezas nuevas viven fuera; el archivo además pierde las ~40 líneas del estado `unknown` |

## 10. Fuera de alcance (anotado para el futuro)

Cola persistida en background (`BatchJob` + dispatcher en el worker + endpoints de estado +
polling). Sobrevive a deploys y a la pestaña cerrada, y permitiría volver a topes altos sin costo de
tiempo. Requiere migración. Spec propio pendiente — ver `docs/progreso.md`, pendientes conocidos.
