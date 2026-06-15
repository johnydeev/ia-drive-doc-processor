# Plan de implementación — Refactor H2: Pipeline de pasos en `processDriveFile`

Fecha: 2026-06-14
Spec: `docs/superpowers/specs/2026-06-14-refactor-h2-pipeline-design.md`
Estado: Listo para ejecutar en sesión dedicada.

> **Para la sesión que ejecute esto:** leé primero el spec y la § "Pipeline de
> procesamiento" del `CLAUDE.md`. El cambio es estructural y debe **preservar el
> comportamiento exacto**. Disciplina obligatoria: **TDD** y extracción **incremental**
> (un paso por vez, suite verde tras cada uno). No empezar a mover lógica sin la red de
> tests de caracterización (Task 1) en verde.

---

## Estrategia general

Refactor en 4 fases, cada una deja la suite verde:

- **A. Red de seguridad** — tests de caracterización del `processDriveFile` actual.
- **B. Andamiaje** — `PipelineContext` + `runner`, con el cuerpo actual movido a un único
  "paso monolítico" (sin cambiar lógica). Suite sigue verde.
- **C. Extracción incremental** — sacar un paso por vez del monolítico a su función, correr
  la suite tras cada extracción.
- **D. Limpieza** — `runStep`/métricas como responsabilidad del runner; borrar el monolítico.

---

## Task 0 — Preparación (seams para testear)

Antes de los tests, hacer testeable lo que hoy no lo es:
- **Inyectar los `await import` dinámicos** (`resolveStatementsFolders`,
  `buildInvoiceFileName`) en `ProcessingContext` (o pasarlos como deps opcionales con
  default al import real). Hoy están inline en
  [processPendingDocuments.job.ts:964-965](../../../src/jobs/processPendingDocuments.job.ts).
- Revisar `createProcessingContext` para ver cómo se arma el `ProcessingContext` y dónde
  enchufar los nuevos seams.

Verificación: `npm run typecheck` + `npx vitest run` (sin cambios de comportamiento).

## Task 1 — Tests de caracterización (RED → GREEN sobre el código ACTUAL) 🔴 prerrequisito

Nuevo `src/jobs/processPendingDocuments.job.test.ts`. Helper `makeContext()` que arma un
`ProcessingContext` con todas las deps como `vi.fn()`. Un test por camino de salida:

| Test | Setup | Asserts clave |
|------|-------|---------------|
| `ok` | hash no dup, IA devuelve datos, assignment matchea con período | `sheetsService.insertRow` llamado; `invoiceRepository.saveProcessedInvoice` llamado; move a Rendiciones; `summary.processed === 1`; `m.result === "ok"` |
| `duplicate` (hash) | `findDuplicateByHash` devuelve algo | NO insertRow, NO save; move a Duplicados; `summary.duplicatesDetected === 1` |
| `duplicate` (business key) | hash no dup, `findDuplicateByBusinessKey` devuelve algo | idem anterior |
| `unassigned` | assignment `.unassigned = true` | move a Sin Asignar; NO sheets/save; `summary.unassigned === 1` |
| `no_amount` | `extracted.amount == null` | rename SIN MONTO + move a Revisión; `summary.unassigned += 1`; `m.result === "no_amount"` |
| `no_period` | assignment OK pero `periodId == null` + `statements` configurada | move a Revisión; `m.result === "no_period"` |
| `rate_limited` | `aiChain.run` hace que todos los proveedores devuelvan 429 | move Procesando→Pendientes; `summary.rateLimited === 1`; NO failed |
| `failed` | una dep lanza error genérico | move a Revisión; `summary.failed === 1` |

Además: **verificar que `pipelineLog.metrics` se llamó en CADA camino** (la garantía del
`finally`). Usar `sleep`/timing fake donde aplique. Mockear `vi.mock()` para los dos imports
dinámicos (o usar los seams de Task 0).

Verificación: `npx vitest run src/jobs/processPendingDocuments.job.test.ts` — todos verdes
**contra el código actual** (caracterización: documentan lo que hay, no lo deseado).

## Task 2 — Andamiaje: `PipelineContext` + runner (sin cambiar lógica)

- Nuevo `src/jobs/pipeline/context.ts`: tipos `PipelineContext`, `StepResult`,
  `PipelineStep` (ver spec § 3).
- Nuevo `src/jobs/pipeline/runner.ts`: `runPipeline(steps, ctx)` que itera los pasos, corta
  al primer `halt`, envuelve en try/catch (RateLimitError / error) y emite `[metrics]` en
  `finally`. Conserva `runStep`.
- `processDriveFile` arma el `PipelineContext` y llama a `runPipeline([monolithStep], ctx)`,
  donde `monolithStep` es **el cuerpo actual movido tal cual** (un solo paso). 

Verificación: suite completa verde (los tests de Task 1 no cambian).

## Task 3 — Extracción incremental de pasos (un commit por paso)

Sacar del `monolithStep`, uno por vez y corriendo la suite tras cada extracción, en este
orden (de los extremos hacia el centro, que es lo más seguro):

1. `downloadAndLockStep`
2. `dedupHashStep`
3. `extractStep` (los 3 flujos de extracción + el `RateLimitError`)
4. `missingAmountGate`
5. `cuitSanitizeStep` (saneo + CUITs del texto)
6. `businessKeyDedupStep`
7. `cleanClientNumberStep`
8. `assignmentStep` (incluye el fallback visual)
9. `canonizeStep`
10. `unassignedGate`
11. `noPeriodGate`
12. `sheetsStep`
13. `fileOrganizationStep` (Duplicados / Rendiciones / Escaneados — usa los seams de Task 0)
14. `persistStep` (saveInvoice + summary + `m.result` final)

Cada paso escribe en `ctx` y devuelve `continue`/`halt`. **Suite verde tras cada extracción**
(si un test rompe, el paso recién extraído cambió comportamiento → corregir el paso, no el
test).

## Task 4 — Limpieza

- El `monolithStep` queda vacío → borrarlo.
- Confirmar que `[metrics]` se emite solo en el `finally` del runner (no duplicado).
- Revisar nombres/orden, sin agregar comportamiento.

---

## Verificación final (obligatoria)

1. `npx vitest run` — 100% verde (los de caracterización + helper existentes).
2. `npm run typecheck` + `npm run lint` (0 errores nuevos) + `npm run build:jobs`.
3. **End-to-end con PDFs reales**: `npx tsx scripts/diag-boleta.ts <pdf> MorinigoAdm` sobre
   2-3 boletas de distinto tipo (común, LSP, sindical) → mismo veredicto que antes del
   refactor. Idealmente correr el worker contra unas boletas de prueba y comparar la línea
   `[metrics]`.
4. **Docs** (obligatorio CLAUDE.md): `docs/decisiones.md` (entrada del refactor),
   `docs/progreso.md` (marcar H2 hecho) y `CHANGELOG.md`.

## Riesgos y mitigaciones
- **Camino crítico de prod** → tests de caracterización primero (Task 1) son innegociables.
- **Imports dinámicos difíciles de mockear** → resueltos en Task 0 (seams en el context).
- **Regresión silenciosa en un camino** → extracción incremental + suite tras cada paso; si
  un test de caracterización se "ajusta", es señal de que se cambió comportamiento (parar).
- **Esfuerzo** → es una sesión completa dedicada. No mezclar con otras features.

## Archivos
- Nuevos: `src/jobs/pipeline/context.ts`, `src/jobs/pipeline/runner.ts`, un archivo por paso
  (o `src/jobs/pipeline/steps/*.ts`), `src/jobs/processPendingDocuments.job.test.ts`.
- Modificados: `src/jobs/processPendingDocuments.job.ts` (thin wrapper), posiblemente
  `ProcessingContext` (seams de Task 0).
- Sin migración.
