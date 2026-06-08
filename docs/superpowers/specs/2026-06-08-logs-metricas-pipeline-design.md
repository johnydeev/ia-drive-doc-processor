# Spec — Logs de métricas del pipeline (instrumentación para análisis)

Fecha: 2026-06-08
Estado: Aprobado (diseño). Pendiente de plan de implementación.

---

## 1. Objetivo

Instrumentar el pipeline de procesamiento (`processPendingDocuments.job.ts`) para
generar **datos precisos y agregables** por cada boleta, de modo de poder
analizar los logs del worker y detectar problemas a mejorar. Cuatro ejes de
análisis pedidos:

1. **Latencia/costo de la IA** — por qué algunas boletas tardan 2m+ en la IA y
   otras 5s; tokens y modelo por boleta y por proveedor.
2. **Calidad de extracción** — campos que la IA saca mal (monto, vencimiento,
   CUIT, consorcio, proveedor): requiere comparar extraído vs canónico.
3. **OCR: cuándo y por qué** — cuántas boletas caen a OCR tesseract, por qué
   (poco texto / sin bloque emisor), cuánto tarda.
4. **Asignación / matching** — cuántas caen en Sin Asignar / Revisión y con qué
   método se matcheó consorcio/proveedor.

**Motivación concreta:** en los logs actuales (`logs/2026-05-12_..._worker.txt`)
una boleta de Edesur tardó **2m 56s** (la llamada a Gemini sola: 2m 41s) contra
otra idéntica de **5s**. Hoy esa diferencia solo se ve restando timestamps a
mano y no hay forma de agregar/medir sistemáticamente.

---

## 2. Decisiones de diseño (cerradas)

| Tema | Decisión |
|---|---|
| Formato | **Una línea estructurada `[metrics] {JSON}` por boleta**, en el stdout del worker (cae en el txt exportado). Additiva: los logs legibles actuales quedan intactos. |
| PII | El **núcleo** de la línea es siempre-on y **sin PII**. Los **valores de campos** (monto, CUIT, vto, nombres) se agregan en un bloque `values` **solo con `debugMode` ON**. |
| Persistencia | **Solo logs** (no se persiste en DB, no hay migración). Tokens ya están en `Invoice`/`TokenUsage`. Una tabla de métricas queda como mejora futura (YAGNI). |
| Comportamiento | **Solo logging.** No cambia el procesamiento, ni Sheets/Drive/DB. |
| Una línea por boleta | Se emite en un `finally` de `processDriveFile`: sale **exactamente una** por boleta pase lo que pase (ok / sin-asignar / duplicado / sin-período / error). |

Enfoques descartados:
- **Solo timing inline (sin línea estructurada):** legible pero no agregable —
  habría que parsear prosa con emojis. No sirve para el análisis preciso.
- **Persistir métricas en una tabla DB:** lo más potente (SQL) pero requiere
  migración y más scope; se planteó como "archivos de logs". Mejora futura.

---

## 3. La línea de métricas

Prefijo `[metrics]` + JSON en **una sola línea** (greppable: `grep '\[metrics\]'`).

### 3.1 Núcleo (siempre, sin PII)

```json
[metrics] {
  "ts":"2026-06-08T14:03:42Z",
  "job":"cmp1…sfji",
  "client":"cmmu…rgxn",
  "file":"20260504_E_...pdf",
  "mime":"application/pdf",
  "textSource":"direct",
  "textChars":13813,
  "emitterBlock":true,
  "lsp":"EDESUR",
  "ai":{"provider":"gemini","model":"gemini-2.0-flash","ok":true,"in":1234,"out":210,"total":1444},
  "ms":{"download":2016,"text":225,"textPage1":108,"ocr":0,"dedupHash":1105,"ai":4850,"dedupKey":3320,"assign":1100,"sheets":970,"move":715,"save":1118,"total":18000},
  "match":{"consortium":"lsp","provider":"lsp"},
  "result":"ok",
  "reason":null
}
```

Campos del núcleo:
- `ts` — ISO timestamp del fin del procesamiento.
- `job` / `client` — `shortId` (igual que el resto de los logs). No PII.
- `file` / `mime` — nombre y mime del archivo (ya se loguea en claro hoy).
- `textSource` — `direct | ocr | merged | image`.
  - `image` = JPG/PNG vía Gemini Vision (no hay texto que extraer).
- `textChars` — caracteres del texto extraído (0 para `image`).
- `emitterBlock` — bool: se detectó el bloque emisor AFIP en el texto.
- `lsp` — proveedor LSP detectado por el router (`EDESUR`, `AYSA`, …) o `null`.
- `ai` — `provider` (`gemini|openai|anthropic|ocr_only`), `model`, `ok` (bool),
  `in`/`out`/`total` tokens. Tomado de `fileAiUsage`. Si todos fallaron →
  `provider:"ocr_only"`, `ok:false`, tokens `null`.
- `ms` — duración en milisegundos por paso (ver §4 para las claves estables).
  `total` = duración total del procesamiento de la boleta.
- `match` — `consortium`/`provider`: método usado, **categoría normalizada**
  (sin el detalle entre paréntesis, que puede ser PII como el CUIT):
  - `consortium`: `CUIT | exacto | fuzzy | alias | lsp | none`
  - `provider`: `CUIT | exacto | parcial | lsp | none`
  - `lsp` = resuelto por el camino LSP (LspService/clientNumber). `none` = no
    matcheó (típicamente con `result != ok`). **No es PII.**
- `result` — `ok | unassigned | duplicate | no_period | failed`.
- `reason` — **categoría** del desvío, o `null` si `ok`:
  `consortium_not_found | provider_not_found | lsp_clientnumber_not_registered |
  no_active_period | error`. El texto completo (que puede contener nombres) va en
  `values.reasonText` (solo debug).

### 3.2 Bloque `values` (solo con `debugMode` ON)

Se agrega para medir **calidad de extracción** (extraído vs canónico):

```json
  "values":{
    "extracted":{"consortium":"...","provider":"...","taxId":"...","boleta":"...","due":"...","amount":...,"clientNumber":"..."},
    "canonical":{"consortium":"...","provider":"...","taxId":"...","period":"05/2026"},
    "reasonText":"Consorcio no encontrado: \"...\" → norm: \"...\""
  }
```

- `extracted` — lo que devolvió la IA (antes de canonizar).
- `canonical` — los valores de DB tras el match/canonización (lo que se escribió
  en Sheets/Invoice). Permite comparar acierto del consorcio/proveedor/CUIT.
- `reasonText` — el `unassignedReason` completo.

> Para el eje **calidad**, el lote de análisis se corre con `debugMode` ON en el
> cliente (MorinigoAdm) — `extractionConfigJson.debugMode = true`.

---

## 4. Timing por paso

- El helper local `runStep(label, fn)` de `processDriveFile` se extiende con un
  3er parámetro **opcional** `metricKey`: `runStep(label, fn, "download")`.
  Cuando está presente, mide el elapsed y lo guarda en `metrics.ms[metricKey]`.
  Las claves son **estables** (no dependen del texto en español del label).
- Claves previstas: `download`, `text` (extracción de texto completa),
  `textPage1` (re-extracción pág. 1 LSP), `ai`, `dedupHash`, `dedupKey`,
  `assign`, `sheets`, `move`, `save`. `total` se calcula aparte (inicio→fin).
- El paso de IA **ya** pasa por `runStep` ("Extracción IA (Gemini/OpenAI/…)"),
  así se captura la latencia (la del caso 2m41s).
- **OCR** no es un `runStep` (vive dentro de `extractTextFromPdf`). Se expone
  desde `PdfTextExtractorService`:
  - `getLastTextSource(): "direct" | "ocr" | "merged"`
  - `getLastOcrMs(): number` (0 si no se usó OCR)
  El job los lee tras la extracción y los pone en `textSource` y `ms.ocr`.
  Para imágenes, `textSource = "image"`, `ms.ocr = 0`.

---

## 5. Tokens + modelo

Ya existen en `fileAiUsage` (`inputTokens`/`outputTokens`/`totalTokens` +
`provider` + `model`) tras la extracción IA. Se vuelcan en `ai:{…}`. Sin cambios
en cómo se llama a la IA ni en `accumulateTokenUsage`.

---

## 6. Match methods + emisión garantizada

- `AssignmentResult` suma 3 campos (hoy se loguean pero no se devuelven):
  - `consortiumMatchMethod: string | null` (`CUIT | exacto | fuzzy | alias | lsp`)
  - `providerMatchMethod: string | null` (`CUIT | exacto | parcial | lsp`)
  - `reasonCategory: string | null` (la categoría de §3.1 `reason`)
  Se setean en los dos caminos (LSP y matching normal) y en los early-returns.
- La línea `[metrics]` se emite en un **`finally`** de `processDriveFile`, con el
  objeto `metrics` que se fue completando. Garantiza **una sola línea por
  boleta**, en todos los caminos de salida (incluido el `catch`/`failed`).
- Nueva función `pipelineLog.metrics(payload, { debug })` en `logger.ts`: serializa
  el núcleo siempre y agrega `values` solo si `debug` es true. Emite
  `console.log("[metrics] " + JSON.stringify(payload))` en una sola línea.

---

## 7. Alcance

### Incluido
- `logger.ts` — nueva `pipelineLog.metrics(...)`.
- `processPendingDocuments.job.ts` — objeto `metrics` por archivo, `runStep` con
  `metricKey`, emisión en `finally`, 3 campos nuevos en `AssignmentResult`
  (poblados en ambos caminos + early-returns), armado del núcleo y del bloque
  `values` (gated por `resolvedConfig.debugMode`).
- `pdfTextExtractor.service.ts` — `getLastTextSource()` + `getLastOcrMs()`
  (tracking interno del source y del tiempo de OCR).

### Fuera de alcance (futuro)
- Persistir métricas en una tabla de la DB (análisis vía SQL).
- Cambiar el comportamiento del pipeline (modelos, OCR, prompts): **este spec es
  solo instrumentación**. Las mejoras al pipeline se diseñan aparte, con los
  datos que estos logs generen.
- Dashboard/visualización de las métricas.

---

## 8. Plan de verificación

- `npx tsc --noEmit -p tsconfig.json` limpio tras cada cambio (no hay suite de
  tests; patrón del proyecto).
- Script `tsx` para la función pura de serialización de la línea (núcleo sin PII;
  `values` presente solo con `debug=true`): verifica que sin debug NO aparezca
  ningún valor de campo.
- Verificación funcional (en prod, tras deploy del owner): correr unas boletas
  con `debugMode` ON y confirmar que:
  - Hay **exactamente una** línea `[metrics]` por boleta, en todos los resultados
    (ok / unassigned / duplicate / no_period / failed).
  - El núcleo no contiene PII; el bloque `values` aparece solo con debug.
  - `ms.ai` refleja la latencia real (debería verse el outlier de ~2m41s).
  - `grep '\[metrics\]' worker.txt` produce JSON parseable para agregar.

---

## 9. Cómo se usará para el análisis

Tras la corrida, exportar logs (`scripts/export-logs.ps1`) y, sobre el txt del
worker, filtrar `[metrics]` para calcular de forma agregada: latencia IA p50/p95,
% de boletas por `textSource` (direct/ocr/merged/image), costo/tokens por
proveedor de IA, distribución de `result` y `reason`, y métodos de match por
consorcio/proveedor. Con `debugMode`, además, tasa de acierto extraído-vs-canónico
por campo. Eso alimenta el diseño de las mejoras reales al pipeline (otro spec).
