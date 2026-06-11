# Progreso del proyecto — drive-doc-processor

Actualizado al 11/06/2026 (sesión 31).

---

## Hallazgo: el throughput está limitado por config, no por bug (11/06/2026)

**El "1 boleta cada 5 minutos" NO es un problema oculto:** el cliente tiene
`batchSize=1` + `intervalMinutes=5` en la DB → el scheduler encola 1 PDF por
ciclo de 5 min. Techo teórico: 12/hora ≈ **80/jornada** (exactamente el
throughput histórico "bueno"). Con el fix 429 el sistema volvió a pegarse a ese
techo. **Para superar 80/día: subir `batchSize` desde el panel admin**
(Admin → Clientes → editar; acepta 1-500, el scheduler lo relee cada ciclo, sin
deploy). Con el fix 429 (1 llamada IA por boleta en vez de 6) hay margen para
batchSize 5-10 sin riesgo de rate-limit (el worker procesa secuencial).

**Mejoras de logs para diagnóstico (pendientes de deploy):**
- Worker: `queueDepth` al reclamar un job ("En cola: N detrás") — distingue al
  instante worker hambriento (límite=scheduler/batchSize) de cola atascada
  (límite=worker). Es la métrica que faltó para ver esto de entrada.
- Worker: heartbeat "cola vacía" cada 5 min (proceso vivo visible).
- Scheduler: contador "Ya cargadas" en el resumen del ciclo.

---

## Verificación en prod del fix 429 + destrabe de Pendientes + robustez (11/06/2026)

**Estado: código implementado y verificado. PENDIENTE: rebuild de scheduler y
worker por el owner (los fixes de hoy no corren hasta el deploy).**

### Verificación del fix 429 en producción (DB Supabase, solo lectura) ✅
- **35 Invoice creadas el 11/06**, todas con `aiProvider=gemini`,
  `aiModel=gemini-2.5-flash-lite` (el modelo único nuevo), ~2.4-3.5k tokens c/u,
  una cada ~5 min. **Cero** rastros del barrido de 6 modelos. El fix funciona.
- 603 Invoice totales del cliente: **603 con consorcio**, 600 con proveedor y
  monto → las Invoice del sistema son cargas válidas (no residuos de fallos).

### Diagnóstico de los archivos trabados en Pendientes
- Los **14 PDFs** que loopeaban en Pendientes **ya tienen Invoice** → boletas ya
  cargadas cuyo archivo nunca salió de la carpeta. El scheduler los salteaba pero
  no los movía → loop infinito (nunca llegaban al pipeline, así que tampoco se
  evaluaban como duplicados).
- **2 jobs PROCESSING zombie** (desde 11/05 y 20/05, crashes del worker) **sin
  Invoice** → 2 boletas perdidas, recuperables.

### Fixes implementados (pendientes de deploy)
1. **Scheduler — destrabe de boletas ya cargadas:** si un archivo de Pendientes
   ya tiene Invoice, se **mueve a Duplicados** (o Escaneados) en vez de saltearlo
   eternamente. Auto-destraba los 14 al primer ciclo post-deploy.
2. **Scheduler — reaper de jobs zombie:** PROCESSING con `startedAt` > 30 min se
   considera muerto → vuelve a PENDING (o FAILED si agotó intentos). Recupera
   las 2 boletas perdidas automáticamente y previene recurrencia.
3. **Worker — blindaje de conexión DB:** `claimNextJob` dentro de try/catch con
   espera y reintento. Antes, un corte del pooler de Supabase (P1017, visto 2
   veces el 11/06 afectando a web+worker+scheduler a la vez) crasheaba el proceso.
4. (Intento de UPDATE manual de los 2 zombies en Supabase: bloqueado por
   permisos — innecesario, el reaper lo hace solo al deployar.)

---

## Fix regresión 429 (rate-limit IA) — throughput de boletas (10/06/2026)

**Estado: implementado y verificado (test + typecheck + lint + build:jobs + next build OK).
Pendiente: deploy del worker por el owner + observar throughput real.**

**Problema:** caída de throughput (~80 boletas/jornada → menos de la mitad) por
errores 429 (cuota) de Gemini. Confirmado en `logs/2026-06-08_15-43_worker.txt`
(54 ocurrencias). **Causa raíz:** el `GeminiExtractorService` barría **6 modelos**
candidatos y, ante un 429, reintentaba con cada uno → **6× consumo de cuota por
boleta** (un 429 es del proyecto/cuota, no del modelo: probar otro no ayuda).
Además, la boleta con 429 caía a `OCR_ONLY` → **Sin Asignar** (se "perdía").
(La hipótesis del "cambio de orden del pipeline" se descartó con git: el orden
texto→IA es el mismo desde el seed; la IA de texto siempre fue necesaria.)

**Fix (causa raíz, no síntoma):**
- **1 modelo configurable** en vez de 6 (`geminiExtractor.service.ts`). Elimina el
  ×6. Modelo por `GEMINI_MODEL`/`options.model` o default `gemini-2.5-flash-lite`.
- **Backoff acotado ante 429** (`callWithRetry` en `lib/aiErrors.ts`): 1 reintento
  con espera; si persiste, lo convierte en `RateLimitError`.
- **No perder la boleta:** ante 429 de todos los proveedores, el pipeline lanza
  `RateLimitError` → el catch **devuelve el archivo a Pendientes** (desde
  Procesando) y completa el job OK (no failed). El **scheduler la re-encola** en un
  ciclo posterior, cuando la cuota se recuperó. Sin loops de reintento inmediato.
  No toca worker ni scheduler (solo el pipeline).

**Nuevos módulos/tests:** `src/lib/aiErrors.ts` (`isRateLimitError`, `RateLimitError`,
`callWithRetry`) con 16 tests (TDD).

**Eficacia esperada:** ~6× menos consumo de cuota por boleta → muchas más boletas
antes del límite; y las que igual peguen 429 ya **no se pierden** (se reintentan).
Si Google recortó la cuota **diaria**, esto mitiga mucho pero no es infinito —
opciones no-código: cuota real en OpenAI/Claude (la cadena ya hace fallback),
`GEMINI_MODEL` con mejor cuota, o tier pago.

---

## Refactor de patrones de diseño — Fase 3 (parcial) (10/06/2026)

**Estado: runner de tests + red de seguridad + H3 implementados y verificados
(test + typecheck + lint + build:jobs + next build OK). H2 pendiente (ver abajo).**

- **Runner de tests (vitest).** Se montó **Vitest 4** + `vite-tsconfig-paths`
  (resuelve el alias `@/`). Config en `vitest.config.ts` (entorno node, include
  `src/**/*.test.ts`). Scripts: `npm test` (`vitest run`) y `npm run test:watch`.
  Es el **primer test runner del proyecto**.
- **Red de seguridad (39 tests, 3 archivos):**
  - `consortiumNormalizer.test.ts` — caracteriza la normalización + fuzzy/alias.
  - `aiExtraction.test.ts` — caracteriza `AiExtractionChain` (orden de fallback,
    callback `onAttempt`, caso null) con un fake real del contrato `AiExtractor`.
  - `assignmentMatching.test.ts` — cubre los 4 niveles de match de consorcio y
    proveedor (ver H3).
  - **Hallazgo de caracterización:** el JSDoc del normalizer (y el CLAUDE.md)
    muestran `"BROWN ALMTE AV 708"` → `"ALMIRANTE BROWN 708"`, pero el
    comportamiento **real** es `"BROWN ALMIRANTE AV 708"` (expande la abreviatura,
    no reordena ni quita "AV"). Ese caso se resuelve vía `matchNames`/fuzzy. El
    ejemplo del comentario es aspiracional; el test documenta lo real.
- **H3 — MatchStrategy (Chain of Responsibility).** Se extrajo la lógica de
  matching de `resolveAssignment` a un módulo puro y testeable
  `lib/assignmentMatching.ts` (`matchConsortium`, `matchProvider` + helpers
  `normCuit`/`normName`). El pipeline ahora delega en estas funciones; el logging y
  los mensajes de "no encontrado" quedan en el caller. Comportamiento preservado
  (incluido el log puntual `providerCuitMatchesConsortium`). `resolveAssignment`
  quedó notablemente más corto.

### Pendiente — H2 (descomposición del pipeline)
`processDriveFile` (~595 líneas, 6 caminos de salida) **no se descompuso todavía**.
Hacerlo con seguridad exige primero tests de caracterización del pipeline completo,
que requieren mockear ~8 dependencias (Drive, PDF/OCR, Sheets, 4 repos, cadena IA)
+ los `await import()` dinámicos. Es un esfuerzo de su propia sesión y el cambio
más riesgoso del proyecto. Se recomienda abordarlo aparte. La inyección de
dependencias (Fase 2 · H6) y la extracción del matching (H3) ya dejaron el terreno
preparado.

---

## Refactor de patrones de diseño — Fase 2 (10/06/2026)

**Estado: implementado y verificado (typecheck + lint + build:jobs + next build OK).**

Consistencia de capas y observabilidad (prerrequisito para los tests de Fase 3):

- **H6 — Repository + Inyección de dependencias.**
  - **H6a:** los 5 repositorios (`consortium`, `invoice`, `provider`, `payment`,
    `client`) ahora reciben `PrismaClient` por constructor (opcional) con un getter
    lazy `injectedPrisma ?? getPrismaClient()`. Preserva el comportamiento (la
    conexión se resuelve al usar, no al construir) y habilita mockear Prisma en
    tests.
  - **H6b:** `resolveAssignment` (en `processPendingDocuments.job.ts`) ya **no
    accede a Prisma directo**. Las 6 queries se movieron a métodos de repo:
    `ConsortiumRepository.findAllForMatching`, `ProviderRepository.findAllForMatching`
    y un **nuevo `LspServiceRepository`** (`findByProviderId`, `findByProviderName`,
    `setProviderId`). El pipeline ahora respeta las capas que el CLAUDE.md declara.
- **H8 — Consolidación de logging.** El logger (`lib/logger.ts`) se extendió con
  los tags `repo`/`api` y los namespaces `repoLog`/`apiLog` (+ `shortLogId`
  exportado). Migrados: `invoice.repository.ts` (4 `console.*` con `clientId`/hash
  → `repoLog`, cerrando el riesgo de PII en la capa de datos) y los `console.warn`
  de la ruta de scan → `apiLog`. El resto de `console.*` de dominio queda como
  migración incremental; los scripts `jobs/diagnose-*.ts` y el bootstrap
  (`prisma.ts`, `env.ts`) mantienen `console.*` a propósito.

Pendiente (Fase 3): tests de caracterización de `processDriveFile` (6 caminos) →
H3 (MatchStrategy) → H2 (descomponer el pipeline en pasos). Fase 4: H7 (UI).

---

## Refactor de patrones de diseño — Fase 1 (10/06/2026)

**Estado: implementado y verificado (typecheck + lint + build:jobs + next build OK).**

A partir del reporte `docs/reporte-patrones-diseno.md` (auditoría de patrones y
deuda), se ejecutó la **Fase 1** (quick wins de bajo riesgo, comportamiento
preservado):

- **H1 — Extractores IA (Strategy + Chain of Responsibility).** Nuevo
  `src/services/aiExtraction.ts`: interfaz `AiExtractor`, clase
  `AiExtractionChain` y factory `createAiExtractionChain()`. Los 3 servicios
  (`GeminiExtractorService`, `AiExtractorService`, `ClaudeExtractorService`)
  ahora `implements AiExtractor` (campo `provider`). Se eliminó el fallback
  Gemini→OpenAI→Claude **duplicado** entre `processPendingDocuments.job.ts` y
  `consortiums/[id]/invoices/scan/route.ts` (que además ya había divergido en el
  logging). El timing `ms.ai` y el logging por intento (`pipelineLog` vs
  `console.warn`) se preservan vía callback `onAttempt`.
- **H4 — Boilerplate de rutas (HOF/Decorator).** Nuevo `src/lib/apiHandler.ts`:
  `apiOk()`, `apiError()` (ZodError→400, resto→500), `withAuth()` y
  `withClientAuth()` (guard + try/catch). Migradas como piloto: `rubros/route.ts`
  y `coeficientes/route.ts`. Resto de rutas: migración incremental (Fase 1 dejó
  la infraestructura lista).
- **H5 — `loadProcessingClient()` (Factory).** En `clientProcessingConfig.ts`.
  Colapsa el `findUnique({ select })` + mapeo manual a `ProcessingClient` que
  estaba duplicado en 8 lugares (varios con `name: ""`, `batchSize: 10`,
  `intervalMinutes: 60` hardcodeados → ahora trae los valores reales del
  cliente). Migrados: scan, invoices, invoices/[invoiceId], receipt,
  payments, payments/[paymentId], setup-sheet-protection, syncInvoicePayments.

Pendiente (siguientes fases del reporte): H8/H6 (Fase 2), tests de
caracterización + H3/H2 (Fase 3), H7 UI (Fase 4).

---

## Logs de métricas del pipeline (08/06/2026)

**Estado: implementado, pendiente de verificación en prod.**

Línea `[metrics] {JSON}` por boleta en el worker (additiva): tiempos por paso,
tokens+modelo, fuente de texto (direct/ocr/merged/image), método de match,
`result`/`reason`. Núcleo sin PII; `values` (extraído vs canónico) solo con
`debugMode`. Sin migración. Para analizar: exportar logs y `grep '[metrics]'`.
`tsc` limpio + `scripts/test-metrics-payload.ts` 8/8. Diseño:
`docs/superpowers/specs/2026-06-08-logs-metricas-pipeline-design.md`.

---

## Rendiciones por edificio — statements (07/06/2026)

**Estado: implementado, pendiente de verificación funcional en prod tras deploy.**

Feature para organizar boletas y recibos en `Rendiciones/[Edificio]/[Período]` en
Drive, con la carpeta del edificio compartida pública (para QR). Diseño:
`docs/superpowers/specs/2026-06-05-rendiciones-por-edificio-design.md`. Plan:
`docs/superpowers/plans/2026-06-07-rendiciones-por-edificio.md`.

Completado (Tasks 0–11):
- Migración `Consortium.statementsFolderId/Url` (`20260607000100`) — aplicada por el owner.
- Config `driveFoldersJson.statements` con validación obligatoria en `validateClientProcessingConfig`.
- Helpers de naming puros + `scripts/test-statements-naming.ts` (8/8 ✓).
- `GoogleDriveService.renameFile` + `shareFolderPublic`.
- Orquestador `resolveStatementsFolders` (crea/comparte edificio + crea período, cache en memoria).
- Pipeline: boleta OK → renombra + mueve a Rendiciones (reemplaza Escaneados). Consorcio sin período → Revisión.
- Carga manual y recibos → misma carpeta de Rendiciones (recibo renombrado según tipo de pago).
- Scheduler: llave anti-tokens (sin `statements` o sin período ACTIVE → no encola, 0 tokens).
- Purga: mueve desde el parent real (Rendiciones), no asume Escaneados. Delete ya estaba OK (usa `getFileParents`).
- Panel: link `statementsFolderUrl` por consorcio con botón Copiar.

Verificación: `npx tsc --noEmit` limpio tras cada tarea. Pendiente: prueba funcional en prod
(boleta pipeline + manual, recibo, duplicado, llave del scheduler, delete/purga).

Notas operativas:
- Cada cliente necesita `driveFoldersJson.statements` configurado y un período ACTIVE, o el
  scheduler lo saltea (con aviso). Es el comportamiento buscado.
- La Unidad Compartida debe permitir "compartir fuera de la organización" para que el link público funcione.

---

## Infra (07/06/2026)

**Runner self-hosted (RED-DRAGON) auto-gestionado vía Tarea Programada:**
- Problema recurrente: el runner (`run.cmd` interactivo en `C:\actions-runner`)
  se colgaba/apagaba y había que revivirlo a mano en cada deploy.
- `svc.cmd` NO existe en Windows (es de Linux/Mac). Instalarlo como servicio
  real choca con Docker Desktop (corre en la sesión del usuario).
- Solución: Tarea Programada de Windows "GitHubActionsRunner" → lanza
  `run.cmd` al iniciar sesión (LogonType Interactive → acceso a Docker),
  reinicio automático cada 1 min, sin límite de ejecución. Creada con
  `Register-ScheduledTask` (requiere admin). Comando de baja:
  `Unregister-ScheduledTask -TaskName "GitHubActionsRunner" -Confirm:$false`.
- Requiere que el usuario esté logueado (ya era requisito por Docker Desktop).

## Última sesión (05/06/2026)

**Fix CRÍTICO — carga manual deduplica (no más boletas repetidas):**
- En prod, la misma boleta cargada manual 2 veces entró 2 veces (DB+Sheets).
  Causa: hash con `Date.now()` (nunca detectaba el mismo PDF) + sin verificación
  de business key + N° leído distinto por la IA (`0005` vs `00005`).
- Fix: hash REAL del binario + dedup por hash y business key ANTES de guardar;
  si existe → 409 con mensaje claro.
- **Verificado en producción (deploy #61):** cargar el mismo PDF 2 veces ahora
  devuelve "Esta boleta ya fue cargada (el mismo archivo ya existe)". Nota de
  transición: los registros cargados ANTES del fix tienen hash artificial
  (Date.now), así que el dedup por hash no los reconoce — hay que comparar con
  registros nuevos. Limitación conocida: dos PDFs distintos de la misma boleta
  con N° leído distinto por la IA (ceros) no se detectan (fix de ceros descartado).

> **Verificado en producción (05/06):** deploy #60 OK (tras revivir el runner
> self-hosted que quedó offline). Carga manual confirmada: el campo
> `consortium` se llena y la fila se actualiza en Sheets. Pendiente de probar
> en prod: comportamiento de duplicados (requiere una boleta repetida).

**Fix — inserción en Sheets con `append`+INSERT_ROWS (filtros se expanden):**
- Problema: con un filtro aplicado en la hoja, las boletas nuevas no aparecían
  en el filtro (quedaban fuera de su rango). Causa: `insertRow` usaba
  `values.update` en una fila calculada (escribe en celda, no inserta fila).
- Fix: `insertRow` ahora usa `spreadsheets.values.append` +
  `insertDataOption: INSERT_ROWS` → inserta fila física, el filtro se expande.
  Bonus: atómico (sin race conditions) e inmune a filas fantasma. Afecta
  pipeline + carga manual. Sin migración. Confirmado contra doc oficial v4.

**Fix — carga manual dejaba `consortium` (texto) en NULL:**
- En producción, una boleta cargada manualmente (MATAFUEGOS, JUNIN 1222)
  quedó con `consortium`=NULL en la DB. Causa: el endpoint manual seteaba
  `consortiumId` (FK, correcto) pero no copiaba el nombre al campo texto.
  Fix: `consortium: consortium.rawName` en el create. Registro histórico
  corregido con UPDATE puntual.
- Confirmado con `diag-sheets-consistency.ts`: el PDF SÍ se subió a Drive
  (Shared Drive andando en prod) y la fila SÍ está en Sheets (fila 524, era
  un falso negativo por no scrollear). La boleta estaba bien ligada a JUNIN
  1222 vía consortiumId.

## Sesión 04/06/2026

**Feature — crear archivos en Drive con la service account (Unidad Compartida):**
- La carga manual del PDF fallaba: `Service Accounts do not have storage quota`
  (las SA no pueden crear archivos en "Mi unidad"; el pipeline no lo sufría
  porque solo mueve archivos pre-existentes).
- Solución: Unidad Compartida "Control de Boletas y Pagos" con la SA como
  miembro (Administrador de contenido). El código ya soportaba Shared Drives →
  sin cambios de código, sin migración (los IDs no cambian al mover carpetas).
- Soporte opcional extra: domain-wide delegation vía `impersonateEmail` /
  `GOOGLE_IMPERSONATE_EMAIL` (descartado como default: requiere super admin).
- Config: `driveFoldersJson.duplicates` del cliente MorinigoAdm seteado a la
  carpeta "Duplicados" de la unidad.

**Feature — duplicados: consistencia DB↔Sheets + carpeta opcional:**
- Diagnóstico (read-only, `scripts/diag-sheets-consistency.ts`) confirmó que
  NO había bug: la boleta "faltante" estaba en la última fila de Sheets. La
  diferencia DB(499) vs Sheets(522) eran los 22 duplicados que el pipeline
  escribía en Sheets pero no en DB.
- Cambio (Opción B): los duplicados **ya no se escriben en Sheets** → planilla
  1:1 con la DB de ahora en más. Si hay `driveFoldersJson.duplicates`, el PDF
  duplicado se mueve a esa carpeta; si no, a Escaneados.
- Lo ya registrado en Sheets NO se toca. Sin migración.
- Se descartó persistir duplicados en DB (choca con unique
  `uq_invoice_business_key` + inflaría totales). Ver `docs/decisiones.md`.

## Sesión 02/06/2026

**Feature — carga asistida guarda el PDF en Drive:**
- El PDF subido al modal "Cargar boleta" antes solo se escaneaba y se
  descartaba (boleta sin `sourceFileUrl` → ARCHIVO "—", celda URL vacía en
  Sheets). Ahora se sube a la carpeta `scanned` (fallback `receipts`), se
  guardan `driveFileId` + `sourceFileUrl` en la Invoice y la URL va a la
  columna K de Sheets.
- El endpoint `POST .../invoices` ahora acepta `multipart/form-data` (con PDF)
  además de JSON. El front manda FormData solo si hay archivo.

**Fix — fallo silencioso de Sheets en carga manual + warnings visibles:**
- El insert a Sheets estaba en un `try/catch` que solo logueaba. Ahora el
  endpoint devuelve `sheetsWarning` / `driveWarning` y la UI los muestra como
  toast (o confirma el éxito). Se acabó el "se guardó pero no aparece y no sé
  por qué".

**UI — columna "Estado" → "Origen" (Manual / Automática):**
- La columna mezclaba Manual / Duplicado / OK. Ahora indica solo el medio de
  carga: Manual (a mano) o Automática (pipeline desde Drive).

**UI — modal "Cargar boleta": monto con miles + consorcio destacado:**
- Input de Monto: `type="number"` → `type="text"` + `inputMode="decimal"`.
  Formatea es-AR con separador de miles al perder foco (`721.571,37`). El
  monto autocompletado por el scan se muestra ya formateado; al guardar se
  parsea con `parseAmountInput`.
- Nombre del consorcio en el header del modal ahora grande, centrado y en
  mayúscula (clase `.modalConsortiumName`); período centrado debajo.

**Fix — falsos positivos al cargar boleta manualmente (validación de consorcio):**
- Síntoma: al cargar una boleta desde el consorcio, el aviso "esta boleta no
  pertenece al consorcio elegido" saltaba aunque la boleta sí fuera correcta.
  Pasaba sobre todo cuando la IA tomaba al **proveedor** como consorcio.
- Causa: la validación del endpoint scan solo hacía igualdad exacta del nombre
  normalizado, mucho más débil que el matching de 4 niveles del pipeline.
- Fix: `scan/route.ts` ahora reutiliza el matching robusto del pipeline
  (**CUIT → exacto → fuzzy → alias/matchNames**) vía nuevo helper
  `findMatchingConsortium`. Solo declara mismatch si la boleta matchea
  **claramente con otro consorcio** del cliente; si no se puede determinar,
  no bloquea (el usuario eligió el consorcio a propósito).
- Sin cambios de schema, migración ni contrato del endpoint.
- Detalle en `docs/decisiones.md` y `CHANGELOG.md` (entradas 2026-06-02).

---

## Sesión anterior (25/05/2026)

**UI urgente — separación de Boletas y Pagos:**
- Quitados los botones "Pagar" / "Ver pagos" de la columna PAGO en la tabla
  de Boletas. La columna ahora muestra solo el estado (`Pagada` / `Resta $X` / `—`).
- Agregada columna **ACCIONES** al final de la tabla de PagosView con los
  botones "Pagar" (modal cuotas/libre) y "Ver pagos" (historial), que conviven
  con el flujo inline de carga rápida.
- PagosView recibe los handlers vía props nuevas `onPagar` y `onVerPagos`.

**UI urgente — fix NaN en header de Pagos:**
- Bug: los totales del header mostraban `$ NaN` por concatenación de strings
  (Prisma serializa Decimal como string, `reduce` armaba `"065000.2665000.08…"`).
- Fix: helper `toNum()` con guarda `isFinite` aplicado a todos los sumandos.
- Header simplificado a 2 métricas: **Pagos registrados** (suma `amount - remainingBalance`,
  refleja cuotas parciales) y **Saldo impago del período**. Se eliminó
  "Total del período" (redundante con la stat card de Boletas).

**UI urgente — botones del scheduler al sidebar:**
- "Pausar/Encender scheduler" y "Ejecutar ahora" salieron del toolbar superior.
- Se ubicaron en el sidebar colapsable, arriba de "Cerrar sesión", con divisor.
- Toolbar más limpio → más altura útil para la tabla principal.

**UI urgente — eliminación del toolbar superior:**
- Sacada la franja entera (`.toolbar` con themeToggle + hamburger + feedback).
- Hamburger reubicado como **botón flotante** top-left (`.fabHamburger`),
  visible solo en ≤1024px.
- Feedback convertido en **toast flotante** top-right (`.toastContainer`)
  con autodismiss (4s info / 5s error) y animación slide-in.
- Toggle de tema eliminado — vive solo en `/admin`. Se respeta el
  `data-theme` que haya dejado el panel principal al navegar.
- Recuperados ~50px de altura útil para la tabla principal.

**UI urgente — reorganización del detail header:**
- **Navegador de período** (`‹ Mes Año ›`) movido al lado del nombre del
  consorcio (nueva fila `.detailTitleRow` con flex inline). Ya no hay que
  scrollear para cambiar de mes.
- **Sección Servicios públicos (LSP)** ahora colapsable. `<h3>` → toggle
  button con chevron `▸/▾`, título y badge contador. Default cerrado para
  ahorrar espacio. Contenido (tabla + form) se monta on-demand.

**CI — export de logs antes del rebuild:**
- Step nuevo en `deploy` que llama `scripts/export-logs.ps1` antes del
  `docker compose up --force-recreate`. Genera `logs/<timestamp>_<svc>.txt`.
- Step subsiguiente sube los .txt como artifact (`upload-artifact@v4`)
  con retención 14d. Best-effort (`continue-on-error: true`).

**Corrección — destino al eliminar boleta:**
- Carpeta destino: `failed` (en Drive se muestra como "Revisión"). NO
  `pending` — evita re-proceso del scheduler que duplicaría la boleta.
- Si `folders.failed` no está configurada, el archivo se queda donde
  estaba y la respuesta incluye `warning`.

**Feature — eliminar boletas y pagos desde UI:**
- `DELETE /api/client/consortiums/[id]/invoices/[invoiceId]`: bloquea
  si tiene pagos, mueve PDF Drive scanned→pending, trashea Receipt
  asociado, borra fila de Sheets (`deleteDimension`), borra Invoice+Receipt
  en transacción. Atómico (aborta si Drive o Sheets fallan).
- `DELETE /api/client/invoices/[id]/payments/[paymentId]`: solo último
  pago; trashea comprobante, actualiza Sheets cols N/P/Q/R/S/T/U,
  recalcula isPaid/remainingBalance. No revierte periodId.
- Services nuevos: `Drive.trashFile`, `Drive.getFileParents`,
  `Sheets.findInvoiceRow`, `Sheets.deleteInvoiceRow`.
- UI: 🗑 + confirm inline (patrón LSP). Boletas → nueva columna ACCIONES.
  Pagos → al lado de Cuotas/Ver pagos, solo si invoice tiene pagos.
- Detalle completo en `docs/decisiones.md` (entrada 2026-05-25 — Eliminación).

**UI urgente — refinamientos validación + importe es-AR:**
- Mensaje de error incluye `Proveedor – N°comprobante`.
- Input importe: `type=text` + `inputMode=decimal` + placeholder es-AR
  ("85.000,16"). Helpers `parseAmountInput` (acepta coma o punto) y
  `formatAmountPlain` (sin "$").

**UI urgente — validación de campos requeridos al pagar:**
- Inline + modal: fecha + importe + medio + comprobante son obligatorios.
- Mensaje específico indicando qué falta. Inline acumula errores por fila.

**UI urgente — columna COMPROBANTE inline en Pagos:**
- Nueva columna con botón "📎 Adjuntar" para subir PDF de comprobante
  junto al pago inline (antes solo desde el modal de Cuotas).
- `PendingPaymentInput.file: File | null` + handler arma FormData si hay archivo.

**UI urgente — espaciado de Pagos consistente:**
- Removidos `marginBottom: 12` inline del statsStrip y searchRow de
  PagosView; ahora usa el `gap: 16px` natural del `.main`.

**UI urgente — header de Pagos con stat cards:**
- Reemplazado `.pagosSummary` por `.statsStrip` + `.statCard` (mismo look que Boletas).
- "Pagos registrados" muestra `{pagadas} de {total}` (cantidad de boletas).
- "Saldo impago" mantiene el color naranja vía `.statWarn` cuando > 0.

**UI urgente — totales fijos + stats con recuadro individual:**
- Métricas del header (Boletas, Total período, Duplicados, Pagos
  registrados, Saldo impago) ahora se calculan sobre el período completo,
  no sobre el subset filtrado.
- Cada `.statCard` con su propio border + background, todos inline.

**UI urgente — microcopy + dropdown en modal de pago:**
- Toggle "Pagar en cuotas" → "Cuotas fijas".
- Campo "Medio de pago" del modal pasó de input libre a select con las
  mismas 3 opciones que el inline.

**UI urgente — medios de pago + botón Cuotas:**
- Dropdown Medio de Pago: solo Débito automático, Transferencia, Efectivo.
- Botón "Pagar" → "Cuotas" (clarifica que el modal es para cuotas; el pago
  único se carga inline).
- Prop `consortiumBank` removida de PagosView.

**UI urgente — buscadores unificados:**
- Boletas y Pagos filtran por `provider + boletaNumber + CUIT`, mismo placeholder.
- Se sacó el matching por `detail` (ruidoso, poco usado).

**UI urgente — scroll en tablas largas:**
- `.tableWrap` con `max-height: 65vh` + `overflow: auto` y `<thead>` sticky.
  Aplica a Boletas, Pagos y modal "Ver pagos".

**UI urgente — stats inline + buscador en Pagos:**
- **Stats Strip** (Boletas / Total período / Duplicados / Rubros) pasó de
  4 cards grandes en grid a una sola línea horizontal con label + valor
  inline (`display: flex` con wrap). ~50px menos de altura.
- **Buscador en pestaña Pagos** con misma UI que Boletas. Filtra por
  proveedor y N° de comprobante; los totales del header se recalculan
  sobre el subset filtrado (útil para ver saldo por proveedor).

Detalle completo en `docs/decisiones.md` y `CHANGELOG.md` (entradas 2026-05-25).

---

## Estado general

El sistema core está funcionando en producción. Pipeline de PDFs, extracción IA, matching y envío a Sheets completo. Se dockerizó el proyecto con 3 servicios separados (web, scheduler, worker), CI/CD con GitHub Actions, y Cloudflare Tunnel integrado.

La cadena de extracción IA ahora soporta tres proveedores: **Gemini → OpenAI → Claude**, con fallback final a OCR_ONLY.

---

## Completado ✅

- **Healthcheck real con verificación de DB + límites de recursos** (25/05/2026)
  - **Nuevo endpoint `GET /api/health`**: ejecuta `prisma.$queryRaw SELECT 1`
    con timeout de 5s. Devuelve 200 con `{status, db, uptime, timestamp}`
    si la DB responde, 503 si falla. Público (sin auth). Reemplaza al
    healthcheck anterior que apuntaba a `/login` (falso positivo si la DB
    estaba caída pero el server Next respondía).
  - **`docker-compose.yml` healthcheck**: actualizado para usar
    `/api/health` en vez de `/login`. Ahora un fallo de DB dispara
    `restart: unless-stopped`.
  - **Límites de memoria y CPU** en los 4 servicios:
    - `web`: 1024M / 1.0 CPU
    - `scheduler`: 256M / 0.5 CPU
    - `worker`: 1536M / 2.0 CPU (el más pesado)
    - `tunnel`: 128M / 0.25 CPU
  - Previene que un memory leak en el worker tire el host completo
    (escenario crítico porque el host también corre el runner de GHA —
    OOM bloquearía futuros deploys).
  - Total reservation baseline: ~832 MB / ~0.85 CPU. Total limits:
    ~2944 MB / ~3.75 CPU. Holgado para un host de 4 GB RAM y 4 vCPU.

- **`.dockerignore` ampliado** (25/05/2026)
  - De 8 a 41 patrones organizados por categoría (build outputs, env, VCS,
    logs, IDE, OS, docs, CI, tests, backups).
  - Excluye `dist/`, `logs/`, `docs/`, `*.tsbuildinfo`, `.claude/`,
    `.vscode/`, `CHANGELOG.md`, `README.md`, `CLAUDE.md`, `*.pdf`,
    `.github/`, entre otros.
  - `scripts/` queda incluido (útil para `docker exec` con admin commands).
  - Verificado contra el Dockerfile: todos los paths requeridos por
    `COPY . .` del builder siguen entrando al contexto.
  - Impacto: ~2.1 MB menos de contexto (medido con `du`), defensa en
    profundidad contra leak de docs internas en stages intermedias.

- **Fix: docker login con action oficial (CRLF en PowerShell)** (21/05/2026)
  - El intento anterior con `$env:GHCR_TOKEN | docker login --password-stdin`
    falló en CI #53 con `denied: denied`. Causa: PowerShell 5.1 agrega CRLF
    al final del string pipeado, lo cual hace que Docker envíe `<token>\r\n`
    como password — GHCR lo rechaza.
  - Reemplazado por la action oficial `docker/login-action@v3` (misma que
    usa el job `build`), que maneja `--password-stdin` cross-platform en
    código TypeScript sin pasar por shell.
  - Mantiene el beneficio de Crítica #2 (token nunca como argumento visible).
  - **Lección:** para auth contra registries en CI usar actions oficiales,
    no scripts shell que dependen del comportamiento del intérprete.

- **Fix: scripts del deploy reescritos en PowerShell** (21/05/2026)
  - Primer intento del hardening usaba `shell: bash` y falló en CI run #52
    porque el runner self-hosted Windows no tiene `/bin/bash`. Reescritos
    en `shell: powershell` (PS 5.1, mismo que ya usa "Wait for healthy").
  - Helper `Invoke-Step "<name>" { <body> }` que envuelve cada native
    command y hace `throw` si `$LASTEXITCODE -ne 0`. Equivalente
    funcional a `set -e` para comandos como `docker` y `npx`.
  - `.env` se escribe con `[System.IO.File]::WriteAllText` para evitar el
    BOM UTF-16 que `Out-File`/`Set-Content` agregan por defecto en
    Windows PowerShell 5.1 (rompe el parser de `env_file` de docker compose).
  - `chmod 600` eliminado — NTFS no respeta permisos POSIX.

- **Hardening del workflow de deploy (CI/CD)** (21/05/2026)
  - **Crítica #1 — `set -euo pipefail`:** agregado al inicio de ambos
    scripts `run: |` del job `deploy` (steps "Write env file" y "Build and
    restart"). Antes, un `prisma migrate deploy` fallido no abortaba el
    script — los containers nuevos se levantaban contra DB vieja y el job
    reportaba ✅. Ahora cualquier falla en el script aborta inmediatamente
    y el job reporta ❌ explícitamente; los containers viejos siguen
    corriendo con la versión anterior (sin sorpresas en producción).
  - **Crítica #2 — `docker login --password-stdin`:** el token GHCR ya no
    aparece como argumento de comando (`ps aux`, `/proc/<pid>/cmdline`,
    warnings de Docker). Llega vía pipe desde la env var `GHCR_TOKEN`.
  - **Crítica #3 — `.env` desde GitHub Secret `PROD_ENV_FILE`:** el step
    "Copy env file" con path hardcodeado
    (`C:\Users\jony\...\drive-doc-processor\.env`) fue reemplazado por
    un step que lee `secrets.PROD_ENV_FILE` y lo escribe con `printf`.
    Validación previa: si el secret no está configurado, aborta con
    `::error::` accionable. Funciona desde cualquier runner.
  - **Acción manual hecha:** secret `PROD_ENV_FILE` configurado en GitHub
    `Settings → Secrets and variables → Actions` con el contenido del
    `.env` de producción.
  - Ambos steps ahora declaran `shell: bash` explícito (necesario para
    `set -euo pipefail` en self-hosted Windows runner).

- **Sistema de pagos: modal UI + sync Sheets→DB sobre la misma fila** (21/05/2026)
  - **6 columnas nuevas** en la hoja de boletas (auto-cubiertas por el header
    del pipeline y por el endpoint de pagos):
    - **P = SALDO PENDIENTE** — formato `$ X.XXX,XX` es-AR.
    - **Q = MONTO PAGADO** — total acumulado pagado (derivado `amount - remainingBalance`).
    - **R = CANT CUOTAS** — solo si es pago en cuotas.
    - **S = FECHA PAGO** — fecha del último pago en DD/MM/YYYY.
    - **T = URL COMPROBANTE** — link al PDF del recibo en Drive.
    - **U = MEDIO PAGO** — texto libre (Transferencia BBVA, Cheque 1234,
      Efectivo, etc.). Key del mapping: `paidWith` para no chocar con el
      enum `Invoice.paymentMethod` extraído por la IA.
  - **Camino A — Modal en UI con detección automática de modo:**
    - Botón **Pagar** en cada fila de la tabla de Boletas
      (`/admin/consortiums`, solapa "Boletas"). Si `inv.isPaid`, el botón
      cambia a **Ver pagos** y abre modal read-only con el historial.
    - Modal soporta los dos modos del `PaymentRepository` con render
      condicional:
      - **Primer pago:** toggle "Pago libre / Pagar en cuotas".
      - **Cuotas en curso:** banner "Cuota N de M", monto autocalculado
        readonly, aviso especial en la última cuota (absorbe redondeo).
      - **Libre en curso:** banner "Modo pago libre", input cuotas oculto,
        monto editable.
    - El modal hace `GET /api/client/invoices/[id]/payments` al abrir para
      detectar el modo activo desde `payments[0].totalInstallments`.
    - Backend sigue siendo única fuente de verdad — el modal solo replica
      el cálculo localmente para evitar sorpresas visuales.
    - Campos comunes: fecha, medio de pago (texto libre), observación,
      upload PDF (opcional, 20MB máx).
    - `POST /api/client/invoices/[id]/payments` acepta ahora
      `multipart/form-data` además de JSON (compat con UI legacy). Si
      viene PDF: lo sube a Drive en `receipts/consorcio/período`. Luego
      crea Payment vía `PaymentRepository`, reasigna `periodId` al mes
      siguiente si queda saldo, y actualiza N/P/Q/R/S/T (+ M si cambió)
      en la fila de Sheets en una sola pasada.
  - **Camino B — Sincronización Sheets→DB:**
    - `POST /api/client/sync-payments` reescrito: lee las columnas Q/R/S/T
      de cada fila de la hoja de boletas (no usa hoja PAGOS separada).
    - Upsert idempotente de `Payment` con clave natural
      `invoiceId + día de pago + monto.toFixed(2)`.
    - Recalcula `isPaid` y `remainingBalance`. Si queda saldo y la boleta
      tiene período, reasigna `periodId` al mes siguiente (crea período
      ACTIVE si no existe).
    - Refleja derivados (N, P, M) en la fila vía batch update.
    - Persiste `SchedulerState.lastPaymentsSyncAt`.
    - Tolerante a errores — devuelve warnings por fila.
    - Botón **💵 Sincronizar pagos** en sidebar (solo CLIENT).
  - **Protección de hoja (toggle bloqueo/desbloqueo):**
    - `POST /api/client/setup-sheet-protection`: `addProtectedRange` sobre
      A:U (calculado dinámicamente desde el mapping). La service account
      es el único editor. Idempotente. **Antes de proteger ejecuta
      auto-sync** vía `syncInvoicePaymentsFromSheets` para volcar a la DB
      las ediciones manuales hechas mientras estuvo desbloqueada. Si el
      sync falla, no se aplica la protección.
    - `DELETE /api/client/setup-sheet-protection`: quita los rangos
      `dpp:invoices-lock` para permitir ediciones manuales puntuales.
      Solo CLIENT (dueño de la hoja). Idempotente.
    - Botones **🔒 Proteger hoja** y **🔓 Desproteger hoja** en sidebar
      (solo CLIENT). El de desproteger pide confirmación.
    - Lógica del sync extraída a `src/lib/syncInvoicePayments.ts` para
      ser reusable entre `/sync-payments` y `/setup-sheet-protection`.
  - **Schema**: `SchedulerState.lastPaymentsSyncAt DateTime?`. No se persiste
    `paidAmount` en Invoice — es derivado de `amount - remainingBalance`.
    Migración: `20260521000100_add_payment_sync_fields` (pendiente de deploy).
  - `/admin` muestra "Última sync pagos" junto a "Última sync directorio".
  - `GoogleSheetsService` extendido con `readInvoicePaymentRows`,
    `updateInvoicePaymentInfo` (escritura batch opcional sobre N/P/M/Q/R/S/T),
    `protectInvoiceColumns`, `getSheetId`.

- **Deploy pineado por SHA en CI** (18/05/2026)
  - `docker-compose.yml`: los servicios `web`/`scheduler`/`worker` ahora
    usan `image: ghcr.io/johnydeev/ia-drive-doc-processor:${IMAGE_TAG:-latest}`.
    Default sigue siendo `:latest` para uso manual.
  - `.github/workflows/ci.yml` (job `deploy`, step `Build and restart`):
    - `env: IMAGE_TAG: ${{ github.sha }}` para el step entero.
    - `docker pull ...:${{ github.sha }}` en vez de `:latest` (falla rápido
      si la imagen del SHA no existe).
    - `docker tag ...:${{ github.sha }} ...:latest` después del pull para
      mantener el alias local actualizado para `compose up` manual.
    - `compose run` (migrate) y `compose up` heredan `IMAGE_TAG` del step.
  - Contexto: el 18/05/2026 el host quedó corriendo la imagen de mayo 7
    porque `docker pull :latest` del job Deploy resolvió el manifest
    cacheado sin actualizar al digest nuevo. Pinear por SHA elimina ese
    modo de falla.

- **Claude (Anthropic) como tercer proveedor de IA** (18/05/2026)
  - Dependencia: `@anthropic-ai/sdk` instalada.
  - Nuevo servicio `ClaudeExtractorService` en `src/services/claudeExtractor.service.ts`
    espejo de `AiExtractorService` (OpenAI). Usa `messages.create` con
    `max_tokens: 1024`, `temperature: 0`, comparte `buildExtractionPrompt` y
    `refineExtractionWithRawText`.
  - Cadena de fallback en `processPendingDocuments.job.ts`: Gemini → OpenAI →
    **Claude** → OCR_ONLY. Mismo patrón replicado en
    `/api/client/consortiums/[id]/invoices/scan/route.ts` para el flujo manual.
  - `env.ts`: agregadas `ANTHROPIC_API_KEY` y `ANTHROPIC_MODEL` opcionales
    (default `claude-haiku-4-5-20251001`).
  - `ClientExtractionConfig` admite `anthropicApiKey` y `anthropicModel`
    (sin cambios de schema — `extractionConfigJson` es JSON libre).
  - `resolveAiConfig` desencripta la key igual que Gemini/OpenAI y la
    retorna junto con su modelo. La guarda de retorno null considera los
    seis campos (Gemini, OpenAI, Anthropic — key + modelo cada uno).
  - `AiProvider` extendido a `"gemini" | "openai" | "anthropic"`;
    `pipelineLog.aiExtraction` acepta el nuevo provider.
  - `ProcessingContext` propaga `claudeModule`, `anthropicApiKey` y
    `anthropicModel`.

- **`anthropicApiKey` configurable desde la UI admin** (18/05/2026)
  - `GET /api/admin/clients/[id]` retorna `hasAnthropicApiKey: boolean` para
    indicar si la key ya está configurada (sin exponer el valor).
  - `PATCH /api/admin/clients/[id]`: `patchSchema` valida con
    `z.string().min(10).optional().nullable()`; el bloque de merge encripta
    con `encrypt()` si viene valor, o `delete extraction.anthropicApiKey`
    si es null/empty.
  - `POST /api/admin/clients` (alta): `bodySchema` admite `anthropicApiKey`
    con el mismo refine de longitud ≥ 10; se encripta al armar
    `extractionConfigJson`.
  - `/admin/clients/[id]/page.tsx`: nuevo input en sección "Claves de IA"
    con placeholder dinámico ("Configurado — dejalo vacío para no cambiar"
    si `hasAnthropicApiKey`).
  - `/admin/page.tsx`: nuevo input "Anthropic API Key" en el formulario de
    alta de cliente, junto a Gemini y OpenAI.

- **CI: tag de imagen Docker con SHA del commit** (17/05/2026)
  - `.github/workflows/ci.yml` (step "Build and push image") ahora produce dos
    tags simultáneos: `:latest` y `:${{ github.sha }}`
  - Permite rollbacks puntuales en el deploy haciendo `docker pull` del SHA
    correspondiente a una versión estable anterior
  - Sin cambios en el resto del pipeline (deploy sigue usando `:latest`)

- **Resumen del ciclo automático del scheduler** (11/05/2026)
  - `schedulerLog.cycleSummary()` nuevo en `src/lib/logger.ts` con Encontrados / Encolados / Ya en cola
  - `src/jobs/scheduler.ts::runOnce()` acumula `totalFound`, `totalQueued` y `totalSkipped`
    a lo largo del ciclo y emite el resumen antes de `cycleEnd()` solo cuando `totalFound >= 1`
  - No afecta al flujo manual (`runProcessingCycle`) ni al log existente "RESUMEN TOTAL DEL CICLO"

- **Resumen agregado en el worker al vaciarse la cola** (11/05/2026)
  - `workerLog.cycleSummary()` nuevo en `src/lib/logger.ts` con Procesados / Sin asignar / Duplicados / Fallidos
  - `handleJob()` ahora retorna `ProcessJobSummary | null` para que el loop pueda acumular
  - `runWorker()` mantiene contadores entre jobs (`cycleProcessed`, `cycleFailed`, `cycleUnassigned`,
    `cycleSkipped`) y los emite cuando `claimNextJob()` retorna null tras haber procesado ≥ 1 job,
    reseteando los contadores antes del próximo ciclo

- **Hardening de seguridad** (15/04/2026)
  - /api/process protegido con autenticación admin (+ alineación OpenAPI)
  - VIEWER bloqueado en endpoints de escritura y en scan (consume IA/OCR)
  - Límites de tamaño, MIME y magic bytes en todos los uploads
  - Cifrado versionado v2: nuevos secretos con GOOGLE_CREDENTIALS_ENCRYPTION_KEY,
    legado `enc:...` legible probando ambas claves candidatas (GCEK y SESSION_SECRET)
  - Script idempotente `scripts/rotate-encrypted-secrets.ts` para migración
  - Sanitización (CUIT/importes/emails/CBU) + truncado en logs de debug mode
  - Logs normales: PII redactada en extractionResult (CUIT/monto). Diagnóstico
    de pdf-extractor ya no vuelca los primeros 500 chars del texto
  - Scan: imágenes JPG/PNG van a Gemini Vision (no a pdf-parse)
- **Fix lógica de deduplicación** (15/04/2026)
  - `boletaNumber` es campo primario: si es distinto → no es duplicado (aunque monto y vencimiento coincidan)
  - `findDuplicateByBusinessKey` ahora arma `WHERE` dinámico solo con campos presentes y requiere ≥ 2 condiciones
  - Nueva función `isDuplicateByPriority` en `src/lib/businessKey.ts` para validar en memoria
  - Duplicados detectados **no se persisten en DB** — solo se escriben en Sheets (columna L = "YES") y se mueven a Escaneados
- **Solapa Pagos en vista de consorcio** (15/04/2026)
  - Tabs Boletas/Pagos en el header del consorcio
  - `PagosView` inline con tabla editable (fecha, importe, medio de pago)
  - Empleados: pagan monto total (readonly); proveedores: pueden pagar parcial
  - Medios de pago dinámicos con banco del consorcio (Transferencia/Cheque propio [BANCO]), Descuento, Efectivo
  - Botón GUARDAR sincroniza DB + Google Sheets (columna N "ESTADO PAGO" → "Pagado")
  - Migración `20260415000200`: `Payment.driveFileId`/`driveFileUrl` opcionales + nuevo `paymentMethod` (texto libre)
  - Nuevo método `GoogleSheetsService.updatePaymentStatus()` busca fila por URL o boletaNumber+CUIT
- **Soporte imágenes JPG/PNG en pipeline** (15/04/2026)
  - Scheduler detecta image/jpeg e image/png además de application/pdf
  - Pipeline detecta tipo de archivo y usa Gemini Vision directamente
  - Sin OCR ni pdf-parse para imágenes — extracción 100% visual
  - Nuevo método `extractStructuredDataFromImage()` en GeminiExtractorService
- **Soporte empleados de consorcio** (15/04/2026)
  - ProviderType enum: PROVEEDOR / EMPLEADO en tabla Provider
  - Prompt dedicado para recibos de haberes (`buildReciboHaberesPrompt`)
  - Router `isReciboHaberes()` detecta recibos antes del router LSP
  - Sync-directory con columna TIPO en `_Proveedores`
  - UI: badge EMPLEADO en select, label CUIL/CUIT según tipo
  - Migración: `20260415000100_add_provider_type`
- **Fallback visual Gemini Vision** (14/04/2026)
  - Última instancia cuando proveedor no matchea y emisor está en imagen
  - Gemini recibe el PNG de pdftoppm y extrae nombre y CUIT del emisor visualmente
  - Fallo silencioso: si Vision falla el flujo continúa a Sin Asignar normalmente
  - Condiciones: unassigned=true AND consortiumId!=null AND hasEmitterBlock=false AND PNG disponible
- **Toggle Modo Debug por cliente** (13/04/2026)
  - Botón en panel admin para activar/desactivar debug por cliente
  - Cuando está activo, el pipeline logea texto completo post-OCR y respuesta raw de IA
  - Usa `extractionConfigJson.debugMode` — sin migración
  - Endpoint: `PATCH /api/admin/clients/[id]/debug-mode`
- **Lock de archivo vía carpeta Procesando** (09/04/2026)
  - Nuevo campo opcional `processing` en `driveFoldersJson`
  - Tras descargar el PDF, el pipeline lo mueve a la carpeta Procesando como lock atómico a nivel Drive
  - Los movimientos finales (Escaneados / Sin Asignar / Fallidos) usan Procesando como origen cuando el lock está activo
  - Soluciona race condition: manual + scheduler tomando el mismo archivo de Pendientes
  - Sin migración: solo requiere agregar el ID de carpeta en `driveFoldersJson.processing` del cliente
- Pipeline de procesamiento de PDFs (download → dedup → extracción → match → Sheets → mover)
- Extracción IA con Gemini + fallback OpenAI
- **Prompts LSP por empresa** — `identifyLSPProvider()` como router con prompts para Edesur, Edenor, AySA, Metrogas, Naturgy, Camuzzi, Litoral Gas (21/03/2026)
- **Normalización de direcciones LSP** — limpieza de ceros, sufijos numéricos, CP, piso/depto (21/03/2026)
- **CUIT hardcodeado por empresa LSP** — elimina confusión proveedor vs consorcio (21/03/2026)
- **Reglas dueDate específicas** — CESP, CAE y fechas inválidas por empresa (21/03/2026)
- **Logging estructurado** — módulo `src/lib/logger.ts` con timestamps, emojis, separadores, logs por proceso (21/03/2026)
- Matching de consorcios (exacto + fuzzy + alias) con expansión de abreviaturas
- Matching de proveedores (CUIT + nombre + parcial)
- Deduplicación por hash SHA256 y business key
- Sistema multi-tenant con roles ADMIN / CLIENT / VIEWER
- Autenticación con JWT + cookie httpOnly
- CRUD de consorcios, proveedores y períodos
- Importación masiva desde Excel (edificios + proveedores)
- Recibo de pago: subida a Drive + guardado en Invoice
- Scheduler + Worker como procesos separados
- Sincronización directorio ALTA (Sheets → DB) con 4 hojas
- Panel admin con métricas, alta de clientes, edición de configuración
- **Fix LSP fast path: asigna providerId y providerTaxId** (09/04/2026)
  - Cuando el pipeline resuelve por LspService, ahora busca el Provider via LspService.providerId FK
  - Asigna providerId y providerTaxId al Invoice correctamente
  - Antes: ambos campos quedaban NULL en boletas LSP resueltas por fast path
- **Mapa router→canonicalName para lookup LspService** (09/04/2026)
  - `LSP_ROUTER_TO_CANONICAL` traduce "PERSONAL"→"TELECOM ARGENTINA S.A.", etc.
  - El lookup de LspService ahora usa el nombre canónico de DB en lugar del nombre del router
  - Antes: providerName="PERSONAL" no matcheaba con providerName="TELECOM ARGENTINA S.A."
- **Rename LspService.provider → providerName** (09/04/2026)
  - Convención camelCase inglés + mayor claridad (providerName vs providerId)
  - Migración expand-contract: add → copy → drop
  - Migración: `20260409000200_rename_lspservice_provider`
- **Fix providerId en LspService al sincronizar directorio** (09/04/2026)
  - sync-directory ahora resuelve y guarda providerId al crear/actualizar LspServices
  - Campo providerName (texto) se mantiene — providerId es complementario
  - Paso retroactivo: resuelve providerId NULL en registros históricos en cada sync
  - Antes: providerId quedaba NULL aunque el Provider existiera en DB
- **Fix normalización clientNumber LSP** (09/04/2026)
  - Extendida normalización para eliminar espacios internos además de ceros a la izquierda
  - Afecta: pipeline lookup, sync-directory, endpoint UI de LspServices
  - Antes: "8 620 004 726" no matcheaba con "8620004726" → lspServiceId quedaba NULL
- **Logging persistente en Docker** (09/04/2026)
  - Configuración json-file con rotación (50MB x 10 archivos por servicio)
  - Script `export-logs.ps1` para exportar logs a `/logs/` con fecha
  - Carpeta `/logs/` excluida de git
- **Bloqueo LSP sin clientNumber registrado** (09/04/2026)
  - Si una boleta LSP llega con un clientNumber que no existe en LspService → Sin Asignar
  - Nuevo log: `lspClientNumberNotRegistered` con provider y clientNumber
  - Antes: la boleta se procesaba igual sin lspServiceId
- **Rename banco→bank, claveSuterh→suterhKey en Consortium** (09/04/2026)
  - Convención establecida: todos los campos nuevos en camelCase inglés
  - Migración con expand-contract: add new → copy data → drop old
  - Migración: `20260409000100_rename_consortium_banco_suterh`
- Campo `aliases` en Consortium (migración aplicada)
- Tablas Rubro y Coeficiente a nivel cliente (migración aplicada)
- Regla de documentación obligatoria en `docs/` establecida (21/03/2026)
- **Dockerización completa** — Dockerfile multi-stage con standalone, 3 servicios separados en docker-compose (21/03/2026)
- **CI/CD con GitHub Actions** — lint + typecheck + build jobs + Docker build + deploy automático (21/03/2026)
- **ESLint configurado** — typescript-eslint + @next/eslint-plugin-next (21/03/2026)
- **Cloudflare Tunnel** integrado en docker-compose (21/03/2026)
- **Fixes de build**: encoding UTF-8 en close-period/route.ts, async params en receipt/route.ts, clientAuth.ts creado, type cast en scan/route.ts (21/03/2026)
- **Campos banco y claveSuterh en Consortium** (07/04/2026) — Nuevos campos nullable: `banco` y `claveSuterh`. `banco` incluido como columna O en Google Sheets con header "BANCO". `claveSuterh` solo en DB, sin UI por ahora. Migración: `20260407000100_add_consortium_banco_suterh`
- **Columna ESTADO PAGO en Google Sheets** (07/04/2026) — Nuevo campo `paymentStatus` en `SheetsRowMapping`, `HEADER_BY_FIELD`, `DEFAULT_MAPPING` y `ExtractedDocumentData`. Columna N en Sheets con header "ESTADO PAGO". Valor inicial "Sin pagar" al procesar/cargar boleta. Actualización retroactiva de pagos existentes: pendiente (mejora futura)
- **Auditoría de producción Docker** — revisión completa de dependencias, env vars, migraciones y Docker setup (23/03/2026)
  - TypeScript compila sin errores, ESLint solo 8 warnings menores (variables no usadas)
  - `build:jobs` compila correctamente
  - `@napi-rs/canvas` confirmado en uso en `ocr.service.ts` (necesario para OCR via canvas)
  - 14 migraciones aplicadas, schema up to date, sin pendientes
- **Optimización docker-compose** — eliminado triple build redundante (23/03/2026)
  - Antes: los 3 servicios (web, scheduler, worker) tenían `build:` propio → imagen se construía 3 veces
  - Ahora: solo `web` tiene `build:`, los 3 comparten `image: drive-doc-processor:latest`
  - `docker compose up --build` construye una sola vez y los 3 servicios reusan la misma imagen
- **`.env.example` actualizado** — agregada `GOOGLE_CREDENTIALS_ENCRYPTION_KEY`, comentarios descriptivos por sección, variables agrupadas por categoría (23/03/2026)
- **Renombrado alias/aliases → matchNames + nuevo campo paymentAlias** (23/03/2026)
  - Provider: `alias` → `matchNames` (interno, matching múltiple separado por `|`) + `paymentAlias` (visible en UI y Sheets)
  - Consortium: `aliases` → `matchNames` (interno, matching) + `paymentAlias` (visible en UI y Sheets)
  - Migración: `20260323000100_rename_alias_to_matchnames_add_paymentalias` (aplicada)
  - Pipeline: columna "ALIAS" de Sheets ahora escribe `provider.paymentAlias` (vacío si no tiene)
  - Sync ALTA: hojas `_Consorcios` y `_Proveedores` ampliadas a 4 columnas (A:D)
  - Import Excel: nueva columna "Alias de pago" en ambas hojas
  - UI: provider muestra `paymentAlias` como "Alias", `matchNames` es invisible
- **Modelo LspService + PaymentMethod** (23/03/2026)
  - Nueva tabla `LspService`: clientId, consortiumId, provider (normalizado), clientNumber, description
  - Nuevo enum `PaymentMethod`: DEBITO_AUTOMATICO, TRANSFERENCIA, EFECTIVO
  - Invoice: nuevos campos `lspServiceId` (FK nullable) y `paymentMethod` (nullable)
  - Prompts LSP actualizados: todos extraen `clientNumber` y `paymentMethod`
  - Nuevo prompt `buildPersonalPrompt` con keywords PERSONAL/TELECOM en router
  - Pipeline: extracción limitada a página 1 para LSP + lookup en LspService por clientNumber
  - Sheets: nueva columna NRO CLIENTE (J), sourceFileUrl→K, isDuplicate→L
  - Hoja `_LspServices` en archivo ALTA (4 columnas: NOMBRE CANÓNICO, PROVEEDOR, NRO CLIENTE, DESCRIPCIÓN)
  - Sync directory: reemplazo total de LspServices por cliente
  - Migración: `20260323000200_add_lspservice_paymentmethod` (aplicada)
  - Eliminado campo `isAutoCreated` (ya no existía en schema)
- **Feature `consortiumsEnabled` (Premium)** (23/03/2026)
  - Nuevo campo `consortiumsEnabled Boolean @default(false)` en Client
  - Panel admin: columna "Premium" con toggle ON/OFF optimista (reemplaza columna ClientId)
  - Panel cliente: botón "Consorcios" deshabilitado con badge "Premium" si `consortiumsEnabled` es false
  - Página `/admin/consortiums`: guard que verifica acceso y redirige si no está habilitado
  - Endpoints actualizados: `/api/auth/me`, `/api/admin/clients/[id]`, `/api/admin/audit/clients`
  - Migración: `20260323000300_add_consortiums_enabled` (aplicada)
- **Asignación automática de período a invoices** (23/03/2026)
  - Pipeline: al matchear consorcio, busca su período ACTIVE y asigna `periodId` al Invoice
  - Google Sheets: nueva columna `period` (formato `MM/YYYY`) agregada en posición M (después de isDuplicate)
  - Columnas existentes (A–L) sin cambios, `clientNumber` permanece en J
  - Invoices manuales: también escriben el período en Sheets
  - Si no hay período activo: warning en logs, `periodId` queda null (no rompe el pipeline)
- **Sidebar colapsable + menú hamburguesa en panel cliente** (24/03/2026)
  - Sidebar global con: placeholder logo, nombre del cliente, botones (Sincronizar directorio, Consorcios con badge Premium, Cerrar Periodo General, Cerrar sesión)
  - Colapsable en desktop (iconos / iconos + labels), menú hamburguesa para tablet/mobile
  - Toolbar superior: Pausar/Ejecutar scheduler a la izquierda, toggle de tema a la derecha
- **Toggle dark/light con iconos sol/luna** (24/03/2026)
  - Reemplazado botón de texto por switch tipo interruptor con iconos
  - Estado solo de sesión (no persiste en localStorage)
- **Cerrar Periodo General** (24/03/2026)
  - Botón solo visible para rol CLIENT en el sidebar
  - `GET /api/client/periods/close-all/preview`: calcula mes mayoritario, retorna toClose + toSkip
  - `POST /api/client/periods/close-all`: cierra períodos del mes mayoritario, crea siguiente
  - Modal de 2 pasos: preview con lista de consorcios salteados → resultado con contadores
- **Período por defecto con mes mayoritario** (24/03/2026)
  - `ConsortiumRepository.resolveMajorityMonth()`: usa mes mayoritario o mes actual si no hay consorcios
  - `createManual()`, import Excel, sync-directory usan la misma lógica
  - Sync-directory ahora crea período activo para consorcios nuevos que no tenían uno
- **Purga completa de boletas por cliente (Admin)** (24/03/2026)
  - `GET /api/admin/clients/[id]/purge`: preview con count de boletas
  - `DELETE /api/admin/clients/[id]/purge`: purga completa (Drive → Sheets → DB)
  - Flujo: mueve archivos Drive a pendientes (scanned/unassigned → pending), limpia Sheets (fila 2+), borra Invoices + ProcessingJobs en transacción
  - Tolerancia a fallos: Drive/Sheets fallan → warning, DB se borra igual
  - UI: botón "Purgar" en tabla de métricas admin, modal de 3 pasos (preview → confirm → result)
  - Método `clearAllDataRows(sheetName)` en GoogleSheetsService
- **Tracking de tokens con desglose input/output por provider y modelo** (24/03/2026)
  - `TokenUsageBreakdown` nuevo tipo: `{ inputTokens, outputTokens, totalTokens }`
  - `TokenUsageSummary.byProvider` y `byModel` cambiados de `Record<string, number>` a `Record<string, TokenUsageBreakdown>`
  - `accumulateTokenUsage()` ahora acumula input/output/total dentro de cada provider y modelo
  - `processingPersistence.service.ts`: filas por provider/model ahora graban input/output reales (antes eran 0)
  - `schedulerControl.service.ts`: `loadTokenBreakdown()` suma input/output/total desde DB; `toSummary()` compatible con formato viejo (number) y nuevo (object)
  - UI: sección "Tokens usados" muestra In/Out/Total por Gemini y OpenAI
- **Validación en producción** (26/03/2026)
  - Deploy Docker completo funcionando: Docker Desktop + Cloudflare Tunnel + dominio propio
  - Los 3 servicios (web, scheduler, worker) operativos en producción
  - Prompts LSP validados con PDFs reales: Edesur y AySA extracción correcta
- **Aclaración flujo matchNames** (26/03/2026)
  - matchNames de consorcios y proveedores se cargan/editan desde hojas `_Consorcios` y `_Proveedores` del archivo ALTA en Google Sheets
  - Se sincronizan a la DB desde el panel con botón "Sincronizar directorio"
  - No requiere UI adicional de edición de matchNames
- **Procedimiento de deploy documentado** (26/03/2026)
  - Deploy estándar: `docker compose up --build -d`
  - Deploy con migraciones: `down → prisma migrate deploy → prisma generate → up --build -d`
- **Límite de PDFs por lote configurable (batchSize)** (26/03/2026)
  - Nuevo campo `batchSize Int @default(10)` en modelo Client
  - Scheduler respeta `batchSize` del cliente: si hay más PDFs pendientes que el límite, los deja para el próximo ciclo
  - UI: campo "Tamaño de lote" en la página de edición de cliente admin
  - API: endpoint PATCH `/api/admin/clients/[id]` acepta `batchSize` (int, 1-500)
  - Migración: `20260326000100_add_batch_size_and_invoice_tokens`
- **Boletas sin asignar no se guardan en DB** (27/03/2026)
  - Pipeline: cuando `assignment.unassigned === true`, el archivo se mueve a Sin Asignar pero ya NO se guarda como Invoice en la DB
  - Eliminado `saveProcessedInvoice` y `pipelineLog.invoiceSaved` del bloque unassigned
  - El hash tampoco se persiste (solo se persistía via `saveProcessedInvoice`)
  - Beneficio: la DB solo contiene boletas efectivamente procesadas y asignadas
- **Sync-directory: transacción única dividida en 5 transacciones por entidad** (27/03/2026)
  - Rubros, Coeficientes, Consorcios+Períodos, Proveedores y LspServices en transacciones separadas
  - Cada transacción con timeout de 30s (antes: una sola de 60s que podía excederse)
  - Misma lógica interna, solo separada en bloques independientes
- **Aclaración CUIT emisor vs receptor en facturas B/C** (27/03/2026)
  - Prompt `buildInvoicePrompt`: agregada trampa común donde el CUIT del receptor tiene etiqueta 'CUIT:' prominente y el del emisor está en el encabezado sin etiqueta explícita
- **Constante compartida LSP_LATERAL_CUIT_RULES para CUIT en margen lateral** (27/03/2026)
  - Nueva constante `LSP_LATERAL_CUIT_RULES` en reglas compartidas de `extraction.ts`
  - Reemplaza la aclaración inline de Edesur y se incluye también en Edenor
  - Indica que el CUIT aparece en el margen lateral izquierdo rotado/vertical
- **Proveedor LSP resuelto por CUIT desde tabla Provider (elimina CUITs hardcodeados)** (27/03/2026)
  - Nuevo campo `providerId String?` en modelo LspService con FK a Provider
  - Relación inversa `lspServices LspService[]` en modelo Provider
  - Migración: `20260327000100_lspservice_add_provider_fk`
  - Eliminados CUITs hardcodeados de todos los prompts LSP (Edesur, Edenor, AySA, Gas, Personal)
  - Nueva constante `LSP_PROVIDER_TAX_ID_RULES` reemplaza instrucciones de CUIT específicas por empresa
  - Exportado `LSP_FALLBACK_NAMES` como mapa LSP → nombre para fallback cuando el proveedor no está en DB
  - Pipeline: busca proveedor LSP por CUIT en `allTaxIds` contra tabla Provider antes del lookup de LspService
  - LspService lookup: primero por `providerId` (FK), luego fallback a campo texto `provider` (backward compatible)
  - Actualización progresiva: si LspService no tiene `providerId` pero se resuelve, se actualiza automáticamente
  - Sync-directory: resuelve `providerId` al sincronizar `_LspServices` buscando por nombre canónico en Provider
  - Logger: nuevos métodos `lspProviderResolvedFromDB` y `lspProviderNotInDB`
  - Si el proveedor LSP no está cargado en Provider → warning + fallback al nombre del router (no rompe pipeline)
- **Normalización de clientNumber para LspService lookup** (26/03/2026)
  - Pipeline: `extracted.clientNumber` se normaliza con `.replace(/^0+/, "")` antes del lookup de LspService (ej: `00366037` → `366037`)
  - Sync-directory: al sincronizar `_LspServices` desde Sheets, el `clientNumber` se guarda sin ceros a la izquierda
  - Sin cambios en schema, migraciones ni prompts
- **CUIT como identificador primario en matching (allTaxIds)** (26/03/2026)
  - Nuevo campo `allTaxIds: string[]` en `ExtractedDocumentData` — la IA extrae todos los CUITs del documento como lista plana
  - Nueva constante `ALL_TAX_IDS_RULES` en `src/lib/extraction.ts`, incluida en los 7 prompts
  - Schema Zod actualizado con campo `allTaxIds` (array de strings, nullable, default null)
  - `OUTPUT_JSON_TEMPLATE` actualizado con el nuevo campo
  - Matching de consorcio refactorizado: CUIT-first → exacto → fuzzy → alias
  - Matching de proveedor refactorizado: CUIT allTaxIds → CUIT providerTaxId (legacy) → nombre exacto → nombre parcial
  - CUITs del consorcio excluidos automáticamente al buscar proveedor
  - Logger actualizado: `extractionResult` muestra allTaxIds; nuevos métodos `consortiumMatchedByCuit` y `providerMatchedByCuit`
  - Backward-compatible: si `allTaxIds` viene vacío o null, el flujo de matching por nombre funciona igual que antes
- **Razón social en nombre de proveedor (PROVIDER_NAME_RULES)** (26/03/2026)
  - Nueva constante compartida `PROVIDER_NAME_RULES` en `src/lib/extraction.ts`
  - Instruye a la IA a conservar la razón social (S.R.L., S.A., S.A.S., S.C., S.H., COOP., LTDA., etc.) como parte del nombre del proveedor
  - Incluida en todos los prompts: `buildInvoicePrompt`, `buildEdesurPrompt`, `buildEdenorPrompt`, `buildAysaPrompt`, `buildGasPrompt`, `buildPersonalPrompt`, `buildGenericUtilityBillPrompt`
  - No modifica lógica de matching ni normalización — solo la instrucción de extracción IA
- **Registro de tokens por factura individual** (26/03/2026)
  - Nuevos campos en Invoice: `tokensInput`, `tokensOutput`, `tokensTotal`, `aiProvider`, `aiModel`
  - Pipeline: al completar la extracción IA guarda los tokens consumidos y el proveedor/modelo usado en cada Invoice
  - Nueva página `/admin/invoices` (solo ADMIN): tabla paginada con filtro por cliente
  - Columnas: Cliente, Consorcio, Proveedor, Período, Monto, Tokens In/Out/Total, Provider IA, Modelo IA, Fecha
  - Endpoint `GET /api/admin/invoices` protegido con `requireAdminSession`
  - Botón "Invoices" en el panel admin (solo visible para ADMIN)
  - Migración: misma que batchSize (`20260326000100_add_batch_size_and_invoice_tokens`)
- **Intervalo del scheduler configurable por cliente (`intervalMinutes`)** (27/03/2026)
  - Nuevo campo `intervalMinutes Int @default(60)` en modelo Client
  - Scheduler respeta intervalo individual: mantiene `Map<clientId, lastRunTimestamp>` y salta clientes cuyo intervalo no se cumplió
  - `touchHeartbeat` y `getState` usan el intervalo del cliente (con fallback al global del `.env`)
  - UI: campo "Intervalo del scheduler" en la página de edición de cliente admin (1-1440 min)
  - API: endpoint PATCH `/api/admin/clients/[id]` acepta `intervalMinutes` (int, 1-1440)
  - Migración: `20260327000200_add_interval_minutes`
- **UI de edición de matchNames de consorcio** (30/03/2026)
  - Nuevo campo editable en la vista de detalle de consorcio para `matchNames`
  - Nuevo endpoint `PATCH /api/client/consortiums/[id]` con `requireClientSession`
  - Muestra valor actual con botón "Editar", campo de texto con ayuda, botón guardar/cancelar
- **UI de gestión de LspServices desde el panel** (30/03/2026)
  - Sección "Servicios públicos (LSP)" en detalle de consorcio con tabla y formulario inline
  - Endpoints: `GET/POST /api/client/consortiums/[id]/lsp-services`, `DELETE .../[lspId]`
  - Tabla con Empresa, Nro. Cliente, Descripción y botón Eliminar con confirmación inline
  - Formulario inline: dropdown de 8 proveedores, nro. de cliente (normalizado sin ceros), descripción opcional
  - Manejo de 409 (duplicado) con mensaje específico
- **Mejora de `ALL_TAX_IDS_RULES`** (30/03/2026)
  - Instrucción más precisa para extraer todos los CUITs con formato normalizado con guiones (`XX-XXXXXXXX-X`)
  - Regla explícita: DNI con exactamente 11 dígitos se trata como CUIT del consorcio y se incluye en allTaxIds
  - DNI con menos de 11 dígitos se ignora (DNI real de persona física)
  - CAE (14 dígitos) y número de comprobante excluidos explícitamente
  - Ingresos Brutos incluido como señal del CUIT del emisor
- **Mejora de `buildInvoicePrompt`** (30/03/2026)
  - Nueva descripción estructural del layout AFIP estándar (bloque emisor / comprobante / receptor)
  - Orientación explícita para distinguir el CUIT del emisor del receptor
  - `providerTaxId` puede ser null sin romper el matching (allTaxIds como fallback)
- **Tunnel estabilizado** (02/04/2026)
  - Versión fija `cloudflare/cloudflared:2025.2.0` en docker-compose.yml
  - Agregado `--no-autoupdate` y `--url http://web:3000` al comando
  - Zona horaria corregida en logs: UTC-3 Buenos Aires usando `toLocaleString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" })`
- **Mejoras de logging** (02/04/2026)
  - Separadores visuales entre archivos procesados (divider en fileStart/fileCompleted)
  - Separadores en ciclos del scheduler (═ para fin, ─ para inicio)
  - Separador en worker al reclamar job
  - Timestamp con zona horaria correcta UTC-3
  - Log de cantidad de archivos encontrados en jobsQueued con indicador de límite de lote
- **Fix scheduler: jobs COMPLETED/FAILED no bloquean reprocesamiento** (02/04/2026)
  - scheduler.ts: filtro `status: { in: ["PENDING", "PROCESSING"] }` en existingJob
  - Permite reprocesar archivos que volvieron a Pendientes desde Sin Asignar
- **OCR híbrido para PDFs con bloque emisor en imagen** (02/04/2026)
  - Detección semántica del bloque emisor AFIP en pdfTextExtractor.service.ts buscando etiquetas exclusivas: "ING. BRUTOS", "INICIO DE ACTIVIDADES", "RESPONSABLE INSCRIPTO", "MONOTRIBUTO"
  - Si el bloque no está en texto → activa OCR con pdftoppm + Tesseract
  - OcrService reescrito: usa pdftoppm (poppler-utils) en lugar de pdfjs-dist
  - Textos combinados con separador --- OCR --- para máxima información a la IA
  - Fallo silencioso: si OCR falla → continúa con texto de pdf-parse → Sin Asignar
  - poppler-utils agregado al Dockerfile
  - Validado con facturas de emisor en imagen: primera extracción exitosa automática
- **CUITs alternativos de consorcio en matchNames** (02/04/2026)
  - El pipeline verifica CUITs en matchNames al hacer matching por CUIT de allTaxIds
  - Permite consorcios con múltiples CUITs sin cambios de schema
  - Uso: agregar CUIT alternativo en columna Aliases del archivo ALTA
- **Sync-directory: upsert de Proveedores optimizado** (02/04/2026)
  - Reemplazado `findFirst` + `update`/`create` por `upsert` directo con compound key `clientId_canonicalName`
  - Reduce de 2 queries a 1 por proveedor (menos overhead en la transacción)
  - Nuevo constraint `@@unique([clientId, canonicalName])` en Provider
  - Migración: `20260402000100_provider_unique_client_canonical`
  - Logs de timing por etapa: Rubros, Coeficientes, Consorcios, Proveedores, LspServices
- **Feature "Reprocesar Sin Asignar"** (30/03/2026)
  - Botón "♻️ Sin Asignar" en sidebar del panel cliente (solo rol CLIENT)
  - Lista archivos en carpeta Sin Asignar de Drive via preview endpoint
  - Los mueve a Pendientes con un click, el scheduler los procesa en el próximo ciclo
  - Sin cambios en pipeline ni schema
  - Endpoints: `GET /api/client/unassigned/preview`, `POST /api/client/unassigned/requeue`

- **Sistema de pagos parciales (Payment tracking)** (02/04/2026)
  - Nueva tabla `Payment`: amount, paymentDate, installmentNumber, totalInstallments, driveFileId, driveFileUrl, observation
  - Campos nuevos en Invoice: `isPaid` (Boolean), `remainingBalance` (Decimal)
  - Eliminados campos Invoice: `receiptDriveFileId`, `receiptDriveFileUrl` (movidos a Payment)
  - Dos modos: cuotas pactadas (monto fijo auto-calculado) y pagos libres (monto manual)
  - Modo fijado en el primer pago, no se puede cambiar
  - `isPaid` se activa automáticamente al llegar `remainingBalance` a 0
  - Último pago en modo cuotas absorbe diferencias de redondeo
  - Endpoints: GET/POST `/api/client/invoices/[id]/payments`, DELETE `.../[paymentId]`
  - Endpoint legacy `receipt/route.ts` adaptado para crear Payment (pago total)
  - UI: columna "Recibo" reemplazada por columna "Pago" con estado (Pagada / Resta $X / —)
  - Migración: `20260402000200_add_payment_tracking`
- **Fix UX pagina de consorcios** (04/04/2026)
  - Sidebar unificado: navSidebar + lista de consorcios en columna izquierda unica, botones colapsan a icono
  - Fix render de boletas: filas de invoices ahora se muestran correctamente (layout page flex-direction: row)
  - Fix total periodo: suma correcta de montos Decimal con `Number()` en lugar de concatenacion
  - Badge "LSP" en columna proveedor para boletas con `lspServiceId`
  - Fix toggle de tema: aplica `data-theme` a `document.documentElement` via useEffect
  - CSS migrado a variables CSS (`--bg`, `--text`, `--border`, etc.) para soporte dark/light
  - Fix build: variables CSS movidas a `globals.css` (CSS Modules no permite selectores globales)
- **Refactor layout 3 columnas + modal de configuracion** (04/04/2026)
  - Layout separado en 3 columnas independientes: navSidebar (colapsable) | lista consorcios (fija 220px) | contenido
  - Lista de consorcios ya no se oculta al colapsar el nav
  - Edicion de matchNames movida de inline a modal de configuracion
  - Boton "Configuracion" en detailActions abre el modal
  - Boton "Cerrar sesion" reubicado al fondo del navSidebar con spacer flex
  - En mobile (≤1024px) sidebar de consorcios se oculta (acceso via nav mobile)
  - Nuevas clases CSS: `.sidebar`, `.contentCol`, `.configBtn`, `.configSection`, `.configSectionTitle`, `.configSectionDesc`

---

## En progreso 🔄

- **Configurar self-hosted GitHub Actions runner** en la máquina local para deploy automático

---

## Pendiente ❌

### Alta prioridad
- [ ] Configurar self-hosted runner de GitHub Actions en la máquina local
- [ ] Validar prompts LSP restantes con PDFs reales (Metrogas, Naturgy, Camuzzi, Litoral Gas, Personal)

### Media prioridad
- [ ] UI de gestión de carpetas Drive por cliente desde el panel admin
- [ ] Agregar URL de recibo a columna de Google Sheets
- [ ] Resincronización automática con Sheets cuando Google falla

### Baja prioridad
- [ ] UI para asignar Rubro y Coeficiente a invoices individuales desde el panel (Stage 2)

---

## Próximos pasos sugeridos

1. Configurar self-hosted runner de GitHub Actions
2. Validar prompts LSP restantes (Metrogas, Naturgy, Camuzzi, Litoral Gas, Personal)
3. UI de gestión de carpetas Drive por cliente
4. Agregar URL de recibo a columna de Google Sheets

---

## Problemas conocidos

- En Windows, `npx prisma generate` puede fallar si los 3 procesos están corriendo (el `.dll` queda bloqueado). Parar todo antes de migrar.
- PowerShell no soporta `&&`. Siempre correr comandos por separado.
- Números de calle distintos entre factura y DB (ej: Edesur 708 vs DB 706) no se resuelven automáticamente → registrar alias manualmente.
