# Instrumentación de requests y cuota de IA por boleta

**Fecha:** 2026-08-31
**Estado:** spec aprobado, sin implementar
**Origen:** el owner preguntó si la reforma de matching por CUIT (2026-08-26) bajó el consumo de
tokens y aflojó la presión sobre el free tier de Gemini. El análisis del 2026-08-30 mostró que la
pregunta no se puede responder con los datos que hay: **no se registra ni una sola request**.

---

## 1. Qué se puede medir hoy, y qué no

`TokenUsage` guarda **una fila por corrida**, no por llamada: un `aggregate` con el total, uno por
proveedor y uno por modelo (`processingPersistence.service.ts`). `Invoice` guarda tokens **por
boleta que entró**. Las que rebotan no dejan `Invoice`, así que su gasto sólo existe dentro del
agregado de la corrida.

Consecuencia: se puede calcular el desperdicio en bloque, pero no atribuirlo.

| Ventana | Boletas | Tokens totales | En boletas | Overhead | % |
|---|---|---|---|---|---|
| Julio → 26/08 | 376 | 2.133.247 | 1.490.492 | 642.755 | **30,1%** |

5.674 tokens por boleta cargada, contra 3.964 de la extracción sola. **El 30% no termina en
ninguna boleta** y hoy no hay forma de saber qué fracción es rebotes, reprocesos, no-boletas o
barrido de modelos agotados.

Lo que falta, concretamente:

- **Requests HTTP reales.** `onAttempt` cuenta intentos **por proveedor**; el barrido de 3 modelos
  vive adentro de `GeminiExtractorService`, así que un "intento" son entre 1 y 6 requests. La cuota
  free se gasta por request y **por modelo** (~20/día cada uno), así que un total agregado no dice
  cuál de los tres baldes se vació.
- **Si hubo visión.** `extractPartiesFromImage` registra tokens desde el 2026-08-24, pero no queda
  marcado a qué boleta correspondió.
- **Por qué rebotó.** La `reasonCategory` sólo vive en el nombre del archivo en Drive.

### Techo de referencia

3 modelos × ~20 requests/día ≈ **60 requests/día**. Contra el volumen medido (17,7 boletas/día
promedio, p95 53,8, pico 72), y con Gemini ahora primero en la cadena y Cerebras devolviendo 402,
el margen dejó de ser holgado. Ese número es el puntapié del análisis, no una constante del código.

## 2. Decisiones tomadas

| Decisión | Elegido | Por qué |
|---|---|---|
| Dónde persistir | Columnas en `ProcessingJob` + SQL | Es la única tabla con **una fila por archivo procesado**, entre o no entre como boleta. Sin UI: primero datos, después pantalla |
| Granularidad | Total + desglose por modelo | La cuota es por modelo; un total no explica un 429 |
| Alcance | Sólo instrumentación | Atacar el 30% sin saber su composición es adivinar |

## 3. Diseño

### 3.1 Migración

Cinco columnas nullable en `ProcessingJob`. Nullable porque las filas viejas no las tienen y
porque un job que muere antes del pipeline nunca las escribe.

| Columna | Tipo | Contenido |
|---|---|---|
| `outcome` | `String?` | `ok` · `unassigned` · `duplicate` · `not_boleta` · `no_amount` · `no_period` · `rate_limited` · `failed` |
| `reasonCategory` | `String?` | Sale de `m.reason`. En `unassigned` **es** la `reasonCategory` del assignment (`processPendingDocuments.job.ts:1285`), incluidas las 4 de CUIT del 2026-08-26; en el resto de los caminos es el motivo del corte (`rate_limit`, `error`, …). Se guarda tal cual: filtrar por `outcome = 'unassigned'` cuando se la quiera leer como categoría |
| `aiRequests` | `Int?` | Requests HTTP reales: barrido de modelos y visión incluidos |
| `usedVision` | `Boolean?` | Si se gastó Gemini Vision |
| `aiRequestsJson` | `Json?` | `{"gemini:gemini-2.5-flash-lite":3,"gemini:gemini-2.5-flash":1}` |

**Los tokens no se agregan acá.** `Invoice` ya los tiene para las que entran y `TokenUsage` para el
total de la corrida; duplicarlos crea una tercera fuente que puede contradecir a las otras dos.

### 3.2 Seam `onOutcome`

`runPipeline` ya tiene un `finally` por el que salen **todos** los caminos, y ahí ya arma
`[metrics]` y llama a `deps.onDiagnostics?.(...)`. Se agrega al lado:

```ts
deps.onOutcome?.({
  fileId: file.id,
  outcome: m.result,
  reasonCategory: m.reason,
  aiRequests: ctx.aiRequests?.total() ?? null,
  aiRequestsByModel: ctx.aiRequests?.snapshot() ?? null,
  usedVision: ctx.usedVision,
});
```

Diferencia con `onDiagnostics`, que es lo que hay que tener presente al implementarlo:
`onDiagnostics` se inyecta **sólo en la corrida selectiva**; `onOutcome` lo inyecta **siempre** el
worker. Sin colector el pipeline se comporta idéntico a hoy, igual que el otro seam.

El worker lo conecta al `ProcessingJob` que tiene tomado y escribe las columnas en el mismo
`finalizeJob`. Si el outcome llega sin job asociado (camino de scan manual), se descarta sin ruido:
la métrica es best-effort y **nunca** puede hacer fallar el procesamiento de una boleta.

### 3.3 `AiRequestCounter`

Módulo nuevo `src/lib/aiRequestCounter.ts`, puro:

```ts
record(provider: string, model: string): void
total(): number
snapshot(): Record<string, number>   // "provider:model" → n
```

Se crea **uno por boleta** en `processDriveFile` y se guarda en el `PipelineContext`.

**Regla de oro: incrementa quien hace la llamada HTTP, nunca el orquestador.** La cadena no cuenta
por su cuenta — si contara los intentos de `run`, subcontaría el barrido de Gemini (3 requests, 1
intento) y habría que acordarse de arreglarlo el día que otro servicio agregue un retry interno.

Cómo viaja: la cadena se construye **una vez por corrida**, no por boleta, así que el contador no
puede ir en el constructor. Va como parámetro de la llamada:

- `AiExtractionChain.run(text, onAttempt?, counter?)`
- `AiExtractor.extractStructuredData(text, counter?)` — cuatro servicios, un `counter?.record(...)`
  cada uno, salvo Gemini que lo llama **una vez por modelo probado**.
- La instancia de visión de `assignmentStep` recibe el mismo contador; ahí también se marca
  `ctx.usedVision = true`.

### 3.4 Consultas

Un archivo `scripts/metrics-cuota.sql` con las tres preguntas que motivaron todo:

1. **Requests por día contra el techo de ~60**, abierto por modelo.
2. **Rebotes por `reasonCategory`**, para saber cuáles son "falta el alta" (irrecuperables sin
   acción del owner) y cuáles "el papel no lo trae" (candidatos a fallback).
3. **Overhead por día**: tokens de la corrida menos tokens que terminaron en boleta, ahora
   atribuible por `outcome`.

Sin UI. El pendiente viejo de mostrar `ProcessingLog` en el panel queda donde estaba.

## 4. Casos borde

- **Job que falla antes del pipeline** (descarga de Drive, lock): las columnas quedan `null`. Es
  correcto: no hubo llamada a la IA.
- **`rate_limited`**: la boleta vuelve a Pendientes y el job se cierra OK. Las requests **ya
  gastadas** se registran igual — son justamente las que explican el 429.
- **Reproceso**: cada pasada es un `ProcessingJob` nuevo. El mismo `driveFileId` con dos filas es
  el dato que mide cuánto cuestan los reprocesos, no un duplicado a deduplicar.
- **Duplicado por hash**: `dedupHashStep` corre **antes** de la IA, así que esas filas quedan con
  `aiRequests = 0`. Sirve como control de que el contador no miente.

## 5. Tests

| Qué | Dónde |
|---|---|
| `record` / `total` / `snapshot`, incluido el caso de dos modelos del mismo proveedor | `aiRequestCounter.test.ts` |
| El seam se dispara en cada camino de salida | `processPendingDocuments.job.test.ts` (mismo patrón que los 3 tests de `onDiagnostics`) |
| Un barrido de 3 modelos de Gemini cuenta 3 requests | `geminiExtractor.service.test.ts` (ya tiene el `sleep` inyectable y `resetWorkingModel`) |
| Sin colector, el pipeline se comporta idéntico | `processPendingDocuments.job.test.ts` |
| El fallo al escribir la métrica no rompe el job | `jobWorkerMain` |

## 6. Alternativas descartadas

- **Contador estático en el servicio, reseteado por boleta.** Menos plumbing, pero es el patrón que
  ya causó el bug del 2026-08-24: `workingModelName` es `static` y dejaba al worker fijado al modelo
  caro hasta el reinicio. Mismo mecanismo, mismo riesgo, y encima el contador es más fácil de
  corromper porque lo tocan varios caminos.
- **Tabla nueva de eventos de IA**, una fila por request. Máxima resolución, pero crece ~10× más
  rápido que `ProcessingJob` y pide una política de retención antes de servir para algo. Si las
  columnas se quedan cortas, esta es la evolución natural.
- **Parsear los logs `[metrics]` y `[gemini]`.** Cero cambios en los servicios, pero los logs no se
  persisten: el análisis quedaría atado al stdout del contenedor y se pierde en cada deploy.
- **Guardar tokens también en `ProcessingJob`.** Tercera fuente para un dato que ya tienen dos
  tablas.

## 7. Fuera de alcance

Retención/purga de `ProcessingJob` (~250 filas/mes: no es un problema todavía), pantalla en el
panel, y la **pieza 3** — atacar el 30% de overhead —, que se diseña cuando estos datos existan y
con la idea de ahorro que el owner todavía no puso sobre la mesa.

## 8. Verificación

`npm run typecheck` + `npx vitest run` + `npm run lint` + `npm run build:jobs`, y la migración la
aplica el owner. Verificación real: después de un día de producción, la consulta 1 tiene que
devolver un número de requests coherente con la cantidad de boletas del día — si da menos requests
que boletas, el contador se está perdiendo llamadas.
