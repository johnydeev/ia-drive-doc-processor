# Corrida selectiva de boletas con diagnóstico — diseño

Fecha: 2026-08-18 · Estado: aprobado por el owner, pendiente de implementar

## Problema

Hoy el botón **Ejecutar ahora** dispara `runProcessingCycle` → `processPendingDocumentsJob`, que
lista **todos** los PDFs de la carpeta Pendientes y los procesa **inline dentro del request HTTP**.
El owner no puede elegir qué boletas probar, y cuando quiere diagnosticar una extracción tiene que
mirar el stdout del contenedor `worker`.

Dos consecuencias:

1. **No hay control**: para probar una boleta puntual hay que procesar todo lo que haya en Pendientes.
2. **El diagnóstico se pierde**: la línea `[metrics]` que el pipeline emite por boleta —fuente del
   texto, bloque emisor, router LSP, modelo, tokens, métodos de match, resultado y motivo— vive solo
   en los logs del contenedor. Los snapshots de lo que extrajo la IA salen **solo con `debugMode`**.

## Decisiones tomadas

### Se encola; no se procesa en el request

El worker **no depende del flag del scheduler**: su bucle claim (`jobWorkerMain.ts:59`) filtra solo
por `status: "PENDING"` y corre cada 2 segundos, en su propio contenedor. Encolar funciona con el
scheduler prendido o apagado, así que el requisito original del owner ("si está apagado las corre, si
está prendido las encola") se cubre con **un solo mecanismo**.

Procesar inline habría metido 10 boletas × ~8,5s ≈ 85s en un request con el túnel de Cloudflare
cortando a los 100s — el mismo patrón del 524 + runaway de `close-all` (ver `decisiones.md`
2026-08-06).

### Sin prioridad: van al final de la cola

Decisión del owner. Con el scheduler apagado la cola suele estar vacía, así que arrancan enseguida.

### Tope de 10, validado en el server

El límite no puede vivir solo en la UI.

### El diagnóstico se guarda en Drive, solo en este modo

Subcarpeta `_diagnosticos` **dentro de Pendientes** (el escáner filtra por PDF/JPG/PNG y además solo
mira `'folder' in parents`, así que ni el `.json` ni la subcarpeta lo afectan). Por corrida:

- un **JSON** con el detalle completo, para analizar
- un **`.md`** corto al lado, para leer de un vistazo

Contenido por boleta: métricas completas + lo extraído por la IA (antes y después de canonizar) + **el
texto exacto que se le mandó al modelo**. Sin ese texto no se puede distinguir un fallo de prompt de
un fallo de extracción de texto.

## Alcance

### Migración

`ProcessingJob` suma dos columnas nullable:

| Columna | Tipo | Para qué |
|---|---|---|
| `diagnosticRunId` | `String?` (indexado) | Agrupa los jobs de una misma corrida selectiva. `null` = job normal del scheduler |
| `diagnosticsJson` | `Json?` | El diagnóstico de esa boleta, que después se consolida en el reporte |

### Captura en el pipeline

`runPipeline` ya arma el objeto `m` (`PipelineMetrics`) y lo emite en su `finally` **en todos los
caminos de salida**. Se agrega un seam opcional en `ProcessingContext`:

```ts
onDiagnostics?: (payload: BoletaDiagnostics) => void;
```

El runner lo invoca en el mismo `finally`, al lado de `pipelineLog.metrics`. Si no está definido, el
pipeline se comporta exactamente como hoy — es la garantía de que las corridas normales no cambian.

### Worker

Al tomar un job con `diagnosticRunId`, inyecta el colector y guarda el resultado en
`diagnosticsJson`. Cuando no quedan jobs de esa corrida en `PENDING`/`PROCESSING`, arma el reporte y
lo sube a Drive.

**El reporte se escribe una sola vez**: el cierre es un `updateMany` condicional sobre la corrida, así
dos workers no pueden duplicarlo.

### Endpoints (rol CLIENT)

| Endpoint | Qué hace |
|---|---|
| `GET /api/client/manual-run/files` | PDFs de Pendientes, marcando cuáles ya tienen job en curso o boleta cargada |
| `POST /api/client/manual-run` | Hasta 10 `driveFileId` → crea los jobs con un `diagnosticRunId` nuevo. Devuelve `runId` |
| `GET /api/client/manual-run/[runId]` | Estado por archivo + link del reporte cuando terminó |

### UI

**Ejecutar ahora** deja de disparar el ciclo y abre un modal: lista con checkboxes (tope 10),
`AsyncButton` para encolar, y después el progreso por archivo (`en espera` → `procesando` → `lista` /
`error`) hasta que aparece el link al reporte.

## Riesgos

- **Cuota de la service account**: crear archivos en Drive requiere Unidad Compartida. MorinigoAdm ya
  la usa ("Control de Boletas y Pagos"), y la app ya crea carpetas ahí (Rendiciones). Si el reporte
  falla al subirse, **no debe romper el procesamiento**: se loguea y sigue.
- **Tamaño del texto**: se guarda el texto que vio la IA, que ya viene acotado
  (`extractRelevantLines`, primeras 80 líneas, o la página 1 en LSP). No es el PDF entero.
- **Datos sensibles**: el reporte incluye CUITs, importes y direcciones. Vive en la misma Unidad
  Compartida que las boletas, con los mismos permisos — no agrega superficie.

## Fuera de alcance

- Prioridad en la cola (decisión explícita del owner).
- Mostrar `ProcessingLog` en la UI: existe hace tiempo, acumula el historial de cada ejecución y
  **ninguna pantalla lo muestra**. Queda anotado como mejora aparte.
- Streaming de los logs del contenedor al navegador.
