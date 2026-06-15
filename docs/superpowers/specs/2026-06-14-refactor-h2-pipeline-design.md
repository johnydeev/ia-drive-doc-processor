# Spec — Refactor H2: descomponer `processDriveFile` en un Pipeline de pasos

Fecha: 2026-06-14
Estado: Propuesto (diseño). Pendiente de plan de implementación + ejecución en sesión dedicada.
Origen: `docs/reporte-patrones-diseno.md` § H2 (Prioridad 18). Prerrequisitos H6 (DI en
repos) y H3 (MatchStrategy) **ya hechos** — el terreno está preparado.

---

## 1. Objetivo

Convertir `processDriveFile` (la "God function" del pipeline, ~630 líneas,
[processPendingDocuments.job.ts:473](../../../src/jobs/processPendingDocuments.job.ts))
en una **cadena de pasos discretos** (Pipe & Filter), cada uno testeable por separado, sin
cambiar el comportamiento observable. Es el código más crítico y más caro de tocar del
proyecto; el objetivo es **reducir el riesgo de regresión** de cada cambio futuro de reglas
de extracción/matching/organización.

**No se cambia ninguna regla de negocio.** Es un refactor estructural puro, con red de
tests de caracterización **antes** de mover una sola línea.

---

## 2. Estado actual (lo que hay que preservar)

`processDriveFile(file, context, summary): Promise<void>` — una sola función con:

- **~13 dependencias** inyectadas vía `ProcessingContext`: `resolvedConfig`,
  `resolvedMapping`, `driveService`, `pdfExtractor`, `sheetsService`, `invoiceRepository`,
  `consortiumRepository`, `providerRepository`, `lspServiceRepository`, `geminiModule`,
  `aiChain`, `geminiApiKey`/`geminiModel`, `existingDuplicateKeys`.
- **Estado mutable compartido**: `extracted`, `isDuplicate`, `assignment`, `lspProvider`,
  `docText`, `fileHash`, `fileAiUsage`, `extractionWasCached`, `finalSourceFolderId`,
  `sourceFileUrl`, y el acumulador de métricas `m`.
- **2 `await import()` dinámicos**: `statementsFolders.service` (`resolveStatementsFolders`)
  y `statementsNaming` (`buildInvoiceFileName`), dentro del paso de organización.
- **`runStep(label, fn, metricKey?)`**: helper que loguea, mide elapsed y acumula en `m.ms`.

### Pasos lógicos (en orden) y los 6 puntos de salida

| # | Paso | Side-effects | ¿Corta? (`m.result`) |
|---|------|--------------|----------------------|
| 1 | Download + lock (mover a Procesando) | Drive move | — |
| 2 | Dedup por hash | — | — |
| 3 | Extracción (imagen Vision / PDF cacheado / PDF normal → `aiChain`) | tokens; puede lanzar `RateLimitError` | — |
| 4 | **Gate "sin monto"** (`isMissingAmount`) | rename + move a Revisión | **`no_amount`** |
| 5 | Saneo CUIT inventado + CUITs del texto (regex+checksum) | — | — |
| 6 | Dedup por business key (+ `existingDuplicateKeys`) | — | — |
| 7 | Limpieza `clientNumber` (no-LSP) | — | — |
| 8 | `resolveAssignment` (+ fallback visual Gemini) | tokens | — |
| 9 | Canonización (consortium/provider/taxId/period/bank/alias) | — | — |
| 10 | **Gate unassigned** | move a Sin Asignar | **`unassigned`** |
| 11 | **Gate sin período activo** (con `statements`) | move a Revisión | **`no_period`** |
| 12 | Insert Sheets (solo si `!isDuplicate`) | Sheets write | — |
| 13 | Organización del archivo (Duplicados / Rendiciones / Escaneados) | Drive move/rename; `await import` | — |
| 14 | Guardar Invoice (solo si `!isDuplicate`) + summary | DB write | **`ok` / `duplicate`** |
| — | `catch` `RateLimitError` → devolver a Pendientes | Drive move | **`rate_limited`** |
| — | `catch` error genérico → Revisión | Drive move | **`failed`** |
| — | `finally` → emitir línea `[metrics]` (SIEMPRE, todos los caminos) | log | — |

> Crítico: la línea `[metrics]` se emite en `finally` en **todos** los caminos. El refactor
> debe conservar exactamente esa garantía.

---

## 3. Decisiones de diseño (cerradas)

| Tema | Decisión |
|---|---|
| **Patrón** | Pipe & Filter: un `PipelineContext` mutable que fluye por una lista ordenada de `PipelineStep`. Un `runner` itera los pasos; el primero que devuelve `halt` corta. |
| **Firma del paso** | `type PipelineStep = (ctx: PipelineContext) => Promise<StepResult>` con `StepResult = { kind: "continue" } \| { kind: "halt"; result: string; reason: string \| null }`. El paso hace sus side-effects (mover archivo, sumar a `summary`) y luego decide. |
| **Estado** | `PipelineContext` agrupa la entrada (`file`, `context` con deps, `summary`) + el estado acumulado (buffer, fileHash, extracted, isDuplicate, assignment, lspProvider, docText, métricas `m`). Reemplaza las variables locales sueltas. |
| **Métricas** | El acumulador `m` vive en el `PipelineContext`; el runner emite `[metrics]` en su `finally` (igual que hoy). Cada paso solo escribe en `ctx.m`. |
| **Errores** | El runner envuelve la cadena en try/catch: `RateLimitError` → camino `rate_limited` (devolver a Pendientes), otro error → `failed` (Revisión). Idéntico al actual. |
| **`runStep`** | Se conserva (mover a un helper del runner o del context). Los pasos lo siguen usando para logging + timing. |
| **`await import` dinámicos** | `resolveStatementsFolders` y `buildInvoiceFileName` se **inyectan en `ProcessingContext`** (o vía un seam mockeable) en vez de importarse inline → habilita testear el paso de organización sin tocar Drive real. |
| **Ubicación** | Nuevo dir `src/jobs/pipeline/` con `context.ts` (tipos), `runner.ts` y un archivo por paso (o agrupados por afinidad). `processDriveFile` queda como thin wrapper que arma el `PipelineContext` y llama al runner. |
| **Alcance** | Solo `processDriveFile`. `resolveAssignment` ya está extraído (usa `lib/assignmentMatching.ts`, H3) — no se re-toca. `createProcessingContext` y `processPendingDocumentsJob`/`processSingleDriveFileJob` quedan casi iguales. |

---

## 4. Prerrequisito innegociable: tests de caracterización

**Antes de mover una sola línea**, escribir tests que ejerciten `processDriveFile` completo
con **todas las dependencias mockeadas** (`vi.fn()` por método; `vi.mock()` para los dos
imports dinámicos), cubriendo los **7 caminos de salida**: `ok`, `duplicate` (por hash y por
business key), `unassigned`, `no_amount`, `no_period`, `rate_limited`, `failed`.

Cada test verifica el comportamiento **observable**: qué métodos de `driveService`/
`sheetsService`/`invoiceRepository` se llamaron (y con qué), el `summary` resultante
(`processed`/`unassigned`/`failed`/`duplicatesDetected`/`skipped`/`rateLimited`) y el
`result`/`reason` de la línea `[metrics]`. Estos tests deben pasar **idénticos antes y
después** del refactor — son la red de seguridad.

Es el grueso del esfuerzo (mockear ~13 deps + 2 imports dinámicos). Sin esta red, el
refactor es demasiado riesgoso para el activo más crítico del proyecto.

---

## 5. Alternativas descartadas

- **Refactorizar sin tests primero**: inaceptable para el código más crítico (cualquier
  regresión silenciosa rompe el procesamiento de boletas en prod).
- **Pasos como clases con estado propio**: se prefiere funciones puras `(ctx) => StepResult`
  (más simple, menos ceremonia, consistente con el estilo funcional de
  `consortiumNormalizer.ts`).
- **Inmutabilidad estricta del contexto** (cada paso devuelve un ctx nuevo): YAGNI; el
  pipeline es secuencial y de un solo hilo, un contexto mutable es más simple y fiel al
  código actual.

---

## 6. Fuera de alcance / notas

- **H7** (God Component de la UI) es independiente, Fase 4.
- **Sin migración de DB.** Es refactor de código.
- Riesgo: alto (camino crítico). Por eso: tests de caracterización primero, extracción
  **incremental** (un paso por vez, corriendo la suite tras cada uno), y verificación
  end-to-end con `diag-boleta.ts` sobre PDFs reales al final.
- El **plan de implementación** detallado vive en
  `docs/superpowers/plans/2026-06-14-refactor-h2-pipeline.md`.
