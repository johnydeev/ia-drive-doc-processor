# Changelog

## [Unreleased]

### Changed
- **Scheduler: loop independiente por cliente en vez de tick global fijo (2026-07-02)**. Antes había
  un `setInterval` global cada 5 min sobre todos los clientes, con throttle interno silencioso por
  cliente (`shouldEvaluateClient`) — el log `CICLO DE ESCANEO` aparecía cada 5 min sin importar el
  `intervalMinutes` configurado, dando la impresión de que el cambio no se tomaba. Ahora cada
  cliente corre en su propio `setTimeout` que se reprograma solo con su `intervalMinutes` fresco de
  la DB: el log de "Escaneando Drive" y su resultado aparecen exactamente cada `intervalMinutes` de
  ese cliente, sin logs de relleno. Un loop de discovery aparte (silencioso salvo altas/bajas)
  detecta clientes nuevos o desactivados. Ver decisiones.md.

### Fix
- **Activación de Cerebras en producción confirmada (2026-07-02)**. El secret `PROD_ENV_FILE` se
  completó con `CEREBRAS_API_KEY` + `DIRECT_URL` y se re-deployó. Confirmado revisando `docker logs`
  del worker en vivo: procesa boletas reales con `provider: cerebras`, `model: gpt-oss-120b` de
  forma consistente. Ya no está pendiente.
- **Deploy CI: login a GHCR en runner Windows self-hosted (2026-06-30)**. El job `deploy` fallaba
  en el `docker login` con `A specified logon session does not exist` — el credential helper de
  Docker Desktop (`credsStore: "desktop"`) requiere una sesión de logon interactiva que el runner no
  tiene, y Docker Desktop lo re-agrega al config global. Solución: **no usar `docker login`**; un
  step escribe el `auth` (base64 `usuario:token`) en un `config.json` propio del job
  (`DOCKER_CONFIG = github.workspace/.docker-ci`), y `docker pull`/`compose` autentican leyendo ese
  config. El job `build` (ubuntu) sigue con `docker/login-action` normal (en Linux no hay problema).
- **ARCA F931: monto inventado por truncado de texto (2026-06-22)**. En la primera corrida real,
  ARCA extrajo un monto **fabricado** (294.499,11 = suma de aportes de la DJ, cifra que no está
  impresa en el papel) en vez del total real del VEP (453.493,06). Causa: la DJ es larga y el
  "Importe total a pagar" del VEP cae ~línea 88, pero el prompt se cortaba a 80 líneas
  (`extractRelevantLines`) → la IA no veía el total y lo rellenaba sumando la DJ. Fix: para ARCA
  se pasa el texto completo (2 páginas, sin truncar a 80) y `buildArcaPrompt` exige copiar literal
  el "Importe total a pagar", prohíbe sumar/calcular y devuelve null si no aparece. 2 tests nuevos
  (146 totales).

### Feature
- **Groq fuera de la cadena de producción (2026-06-25)**. A pedido del owner, se sacó Groq del
  wiring del pipeline (`createProcessingContext`): la cadena de producción queda
  `Cerebras → Gemini → OpenAI → Claude`. Cerebras alcanza como principal; Groq se evaluará en el
  banco de pruebas. `createAiExtractionChain` y `OpenAICompatibleExtractorService` lo siguen
  soportando (reactivar = 1 línea). typecheck + 161 tests + build:jobs OK.- **Banco de pruebas local de LLMs (2026-06-25)**. Herramienta de desarrollo para iterar prompts y
  comparar modelos sobre boletas reales sin tocar producción. `src/lib/testbench.ts`
  (`runLogicalPipeline` + `compareToExpected`) replica la lógica del pipeline (extracción + triage +
  matching read-only + canonización) en **dry run** (no escribe DB/Sheets), y el CLI
  `scripts/llm-testbench.ts` lee una carpeta (`pruebas de LLMs/`, gitignored), corre cada boleta por
  cada modelo configurado y escribe `resultados.json` + `reporte.md`. Ground truth opcional
  (`<nombre>.expected.json` → aciertos por campo). 6 tests nuevos (161 totales). Sin migración.- **Más cuota de IA gratis: Cerebras + Groq en la cadena (2026-06-24)**. El throughput cayó a
  <½ del histórico porque Google recortó el free tier de Gemini (cuota diaria por modelo). Como
  predominan facturas variadas, se sumó **oferta** de IA gratuita en vez de tocar batchSize/
  frecuencia (que con tope diario solo cambian el ritmo). Nuevo `OpenAICompatibleExtractorService`
  (Chat Completions API de OpenAI, reutiliza el SDK con `baseURL`) → Cerebras y Groq. Cadena
  reordenada **capacidad primero**: `Cerebras → Groq → Gemini → OpenAI → Claude` (solo el
  pipeline automático; el scan manual no se tocó). `isRateLimitError` ahora reconoce el
  `status === 429` del SDK (el circuit breaker de cuota sigue válido con los nuevos). Env nuevas
  `CEREBRAS_API_KEY`/`GROQ_API_KEY` (+ `*_MODEL`); `docker-compose.yml` intacto (usa `env_file`).
  Script `scripts/compare-extractors.ts` para validar calidad sobre PDFs reales. Free tiers
  (06/2026): Cerebras 1M tokens/día (~300+ boletas, modelo `gpt-oss-120b` — Cerebras retiró Llama
  del free tier), Groq 1.000-14.400 req/día (`llama-3.3-70b-versatile`). Validado el 25/06 con un
  F931 de ARCA real (ambos sacan el monto correcto del VEP). 9 tests nuevos
  (155 totales); typecheck + lint + build:jobs OK. Sin migración.
- **Alta/edición de clientes: campo "Rendiciones" (statements) (2026-06-24)**. El formulario de
  crear/editar cliente (panel admin) ahora incluye la carpeta **Rendiciones**, obligatoria para
  procesar (sin ella el scheduler saltea el cliente). Backend (`POST`/`PATCH`/`GET` de
  `/api/admin/clients`) + UI (`admin/page.tsx` y `admin/clients/[id]/page.tsx`). Permite dar de
  alta un cliente 100% desde el panel sin tocar la DB. typecheck + lint + next build OK.- **UI Boletas entrantes: filtros + N° de boleta (2026-06-22)**. En `/admin/boletas`: nueva
  columna **N° Boleta** (últimos 4 dígitos) y tres **dropdowns combinados** arriba para filtrar
  por **consorcio**, **proveedor** y **periodo**. Filtrado **server-side**: la API
  `/api/client/invoices` acepta `consortiumId`/`providerId`/`period` (filtra todo el dataset,
  no solo la página; vuelve a página 1 al cambiar el filtro) y devuelve `facets`
  (consorcios/proveedores/periodos que realmente tienen boletas; periodos más recientes primero)
  para poblar los dropdowns. El **período se filtra por etiqueta MM/YYYY** y el dropdown se
  deduplica por etiqueta: cada consorcio tiene su propio `Period`, así que un mismo "06/2026" son
  muchos `periodId` distintos (filtrar por `periodId` traía un solo consorcio). Se agregó el campo
  `boletaNumber` a la respuesta. Sin migración.
- **Soporte ARCA F931 / SUSS (2026-06-15)**. El F931 de ARCA/AFIP (seguridad social del
  consorcio empleador) es recurrente y no se reconocía: el único CUIT del papel es el del
  CONSORCIO (no hay emisor con CUIT) y el total está en el VEP (página 2), no en la DJ. Nuevo
  tipo `"ARCA"` en `identifyLSPProvider` (detección por `931` + `S.U.S.S.`/`Organismo
  Recaudador`), helper `usesConsortiumCuit` que agrupa sindicales + ARCA (CUIT = consorcio,
  proveedor por nombre, fuera del fast-path LSP) y `buildArcaPrompt` (total del VEP, dueDate =
  Día de Expiración, boletaNumber = Nro. VEP, provider = "ARCA"). ARCA re-extrae 2 páginas. Sin
  cambios de schema: ARCA se registra en `_Proveedores` con CUIT vacío (ya soportado, como los
  sindicales). 6 tests nuevos (144 totales). PENDIENTE: commit + push + cargar ARCA en ALTA.
- **Distinción SERACARH en el nombre del proveedor (2026-06-15)**. Los consorcios con
  empleados reciben 2 boletas FATERYH (F0101 = aportes FMVDD/OS/ART 27 bis, y F0106 =
  SERACARH), que en el matching resuelven al mismo proveedor canónico "FATERYH" (SERACARH es
  anexo vía `matchNames`) → quedaban con nombre idéntico. Nuevo helper puro
  `annotateSindicalProvider` (`lib/extraction.ts`): cuando `lspProvider === "SERACARH"` anota
  `"FATERYH (SERACARH)"`. Se aplica una vez en `canonizeStep` → la distinción aparece en
  **Google Sheets, el nombre del archivo en Drive y el texto del proveedor en la DB**; el
  `providerId` (FK) no cambia. Idempotente. 5 tests nuevos. Sin migración.
- **Triage de documentos: boleta vs no-boleta (2026-06-15)**. La carpeta Pendientes recibía
  no-boletas (planos, certificados de fumigación, obleas de rúbrica, disposiciones) que igual
  pasaban por la IA y caían en "sin monto"/Sin Asignar. Nueva capa de triage **híbrida** sobre
  el pipeline: **capa 1** heurística (`src/lib/documentClassifier.ts`, 0 tokens) en
  `documentTriageGate` **antes** de la IA, y **capa 2** vía campo `isBoleta` de la IA en
  `isBoletaGate`. **Sesgo conservador**: solo desvía ante señal negativa fuerte + ausencia de
  señales de boleta (capa 1) o `isBoleta=false` explícito (capa 2); ante la duda sigue como
  boleta (una factura de fumigación con monto NO se desvía). El no-boleta se renombra
  `[NO BOLETA]` y va a Revisión, sin Sheets/DB; nuevo contador `summary.notBoleta` y
  `result="not_boleta"` en `[metrics]`. Se separó `extractStep` en `textExtractStep` +
  `aiExtractStep` para insertar el gate de heurística sin gastar tokens. 133 tests (incl. 2 de
  caracterización: heurística e IA). Sin migración. Spec/plan en
  `docs/superpowers/{specs,plans}/2026-06-15-triage-clasificacion-documentos*`. Deployado en
  `efe83b8` (CI #82/#83).

### Refactor
- **H2: `processDriveFile` descompuesto en un Pipeline de pasos (2026-06-15)**. La "God
  function" del pipeline (~630 líneas, ~13 deps, 7 caminos de salida con side-effects en
  Drive/Sheets/DB) pasó a patrón **Pipe & Filter**: un `PipelineContext` mutable fluye por
  14 pasos discretos `(ctx) => StepResult` y un `runner` (`src/jobs/pipeline/runner.ts`)
  los orquesta, corta al primer `halt` y **centraliza** el manejo de errores
  (`RateLimitError` → Pendientes / error → Revisión) + la emisión **única** de `[metrics]`
  en su `finally`. `processDriveFile` quedó como thin wrapper (~20 líneas). Refactor
  estructural **sin cambio de comportamiento**, blindado por 8 tests de caracterización
  nuevos (`processPendingDocuments.job.test.ts`) que cubren los 7 caminos (ok /
  duplicate-hash / duplicate-business-key / unassigned / no_amount / no_period /
  rate_limited / failed) y verifican `[metrics]` en cada uno. Los 2 `await import()`
  dinámicos (`resolveStatementsFolders`, `buildInvoiceFileName`) pasaron a seams
  inyectables del `ProcessingContext`. **121 tests verdes**, typecheck + lint (0 errores) +
  build:jobs OK. Sin migración. Archivos nuevos: `src/jobs/pipeline/{context,runner}.ts`.
  Spec/plan en `docs/superpowers/{specs,plans}/2026-06-14-refactor-h2-pipeline*`. Deployado en
  `efe83b8` (CI #79).

### Fix
- **Robustez del worker ante cortes del pooler de Supabase (P1017) (2026-06-14)**. El
  pooler (PgBouncer) cierra conexiones idle y se reinicia → Prisma lanza P1017. El blindaje
  del 11/06 cubría solo `claimNextJob`; un P1017 dentro de `handleJob` —sobre todo en
  `finalizeJob`— dejaba el job en PROCESSING (zombie) hasta el reaper (>30 min) y, si pegaba
  tras procesar OK, disparaba reproceso que gasta cuota IA. Nuevo `src/lib/dbRetry.ts`
  (`isTransientDbError` acotado a conexión transitoria + `withDbRetry`, espejando
  `callWithRetry` de aiErrors.ts) aplicado a claim/finalize/client lookup del worker (no se
  reusa `isPrismaConnectionError`, demasiado amplio). Scheduler intacto (ya resiliente).
  Nuevo log `workerLog.dbRetry`. 13 tests. Sin migración. Spec en
  `docs/superpowers/specs/2026-06-14-robustez-pooler-p1017-design.md`. Deploy: push +
  rebuild del worker.
- **Factura común: el consorcio receptor se ancla en "CONSORCIO DE PROPIETARIOS"
  (2026-06-14)**. "MAYO 2026.pdf" (factura C de desinsectación a CORONEL DIAZ 1714)
  iba a Sin Asignar: la IA tomaba la "Razón Social:" del EMISOR como consorcio y el
  refinamiento determinístico lo reforzaba (anclaba en esa misma "Razón Social:").
  En facturas tipo C el receptor no tiene CUIT real (`00-00000000-0`) → el match solo
  puede ser por nombre. Fix de doble capa: `buildInvoicePrompt` ahora le enseña a la
  IA que el receptor figura como "CONSORCIO DE PROPIETARIOS" + dirección (muchas
  veces sin etiqueta "Cliente:"), e `inferConsortiumFromText` ancla en ese marcador
  (no en "Razón Social:") limpiando el ruido del bloque receptor (condición IVA,
  CUIT placeholder, localidad). Cierra además un **bug latente**: el refinamiento
  podía DEGRADAR un consorcio bien extraído al nombre del emisor. 5 tests nuevos (con
  el texto real); `diag-boleta.ts` ahora infiere el consorcio del texto y prueba el
  match real → MATCH exacto "CORONEL DIAZ 1714". Sin migración. Recuperar
  "MAYO 2026.pdf" de Sin Asignar → Pendientes tras el deploy.
- **Router: "PERSONAL" suelto mandaba facturas a Telecom (2026-06-13)**. Una
  factura de IPLAN caía en Sin Asignar porque `CÓDIGO DE GESTIÓN PERSONAL` activaba
  la detección de Personal/Telecom (camino LSP por nro de cliente). Ahora
  `isPersonalTelecom` detecta por marcadores positivos (TELECOM ARGENTINA, Mi
  Personal, Personal Flow/SA), no por la palabra suelta → esas facturas van al
  flujo normal y matchean por CUIT. 3 tests nuevos (incl. texto real de IPLAN).

### Features
- **Vista "Boletas entrantes" + borrado masivo (2026-06-13)**. Nueva página
  `/admin/boletas` en el panel cliente: todas las boletas en orden de entrada
  (como el Sheet), sin separar por edificio, con selección múltiple y "Borrar
  seleccionadas". Al borrar, el PDF vuelve a **Pendientes** y se reprocesa (ideal
  para corregir boletas mal procesadas). Endpoints `GET /api/client/invoices` y
  `POST /api/client/invoices/bulk-delete`; el flujo de borrado se extrajo a
  `lib/invoiceDeletion` (destino configurable) y lo comparte el borrado por
  consorcio. Ítem "Boletas entrantes" en el sidebar.

### Fix
- **Boletas sindicales: el CUIT del documento es del consorcio, no del sindicato
  (2026-06-13)**. Corrige el soporte sindical del 12/06, que asumía mal un "CUIT
  recaudador compartido". Cada boleta trae el CUIT del **edificio contribuyente**
  (BOEDO 414 ≠ BROWN 706 ≠ …). Ahora: el consorcio matchea por ese CUIT y el
  **proveedor por NOMBRE** (SUTERH/FATERYH/SERACARH, sin CUIT propio). El prompt
  ya no hardcodea `providerTaxId`; `extractCuitsFromText` corre también en
  sindicales; el fast-path LSP las excluye. Verificado 6/6 contra PDFs+DB reales.
  **Requiere** limpiar el CUIT mal cargado de los 3 proveedores (SQL en
  `docs/decisiones.md`).

### Fix
- **Boletas con cuota agotada caían a "SIN MONTO → Revisión" (2026-06-12)**. El
  RateLimitError del barrido dice "sin cuota" (español) y el clasificador buscaba
  "quota" → con todos los proveedores en 429 la boleta degradaba a OCR_ONLY y
  terminaba en Revisión en vez de volver a Pendientes (también anulaba el circuit
  breaker). Fix de fondo: la cadena de IA clasifica el error sobre el objeto y
  pasa un flag `rateLimited` en el callback (el pipeline ya no parsea mensajes);
  defensa extra en `isRateLimitError` ("sin cuota"/"cuota agotada"). Etiquetas de
  log corregidas: "Movido a Revisión (carpeta failed)" y resultado real
  ("SIN MONTO → Revisión" / "SIN PERÍODO ACTIVO → Revisión") en vez del genérico
  "SIN ASIGNAR". 2 boletas afectadas a recuperar manualmente (Revisión →
  Pendientes): FB-158366.pdf y "eva peron manuel depto 32 - SIN MONTO.pdf".

### Features
- **Circuit breaker de cuota IA (2026-06-12)**. Cuando todos los proveedores de
  IA están en 429 (cuota diaria agotada), el worker pausa automáticamente el
  encolado del cliente (`SchedulerState.aiPausedUntil`, **migración
  `20260612000100`**) hasta el próximo reset de cuota (medianoche del Pacífico,
  DST-safe — nuevo `lib/quotaReset.ts`, 4 tests). El scheduler saltea al cliente
  sin escanear Drive y **se reanuda solo** al vencer la pausa, sin tocar el
  toggle manual. Elimina el churn de rebotes contra baldes vacíos.
- **Boletas sindicales SUTERH / FATERYH / SERACARH (2026-06-12)**. Soporte para
  los 3 formularios del sindicato de encargados (F0201/F0101/F0106) con el patrón
  LSP existente: detección en `identifyLSPProvider` (antes del gate de servicios
  públicos) + `buildSindicalPrompt` (provider y CUIT recaudador fijos, vencimiento,
  total, período, débito automático). Como los 3 comparten el CUIT 30-54675623-4,
  `matchProvider` ahora **desambigua por nombre cuando varios proveedores comparten
  CUIT** (mejora general, 5 tests). Detección verificada 12/12 contra los PDFs
  reales. Requiere cargar en el directorio: SUTERH, FATERYH y SERACARH (mismo
  CUIT) + matchNames `BOEDO 410` en BOEDO 414. `diag-boleta.ts` ahora muestra el
  tipo detectado por el router.

### Refactor
- **Normalización canónica de CUIT en todo el sistema (2026-06-12)**. Nueva fuente
  única `src/lib/cuit.ts` (13 tests TDD): comparar siempre por dígitos
  (`cuitDigits`/`cuitsEqual`), guardar siempre canónico `XX-XXXXXXXX-X`
  (`formatCuit`). Consolidadas 6 copias de normalizadores locales (job, matching,
  scan, panel, extraction, validación). Escrituras normalizadas: alta manual de
  proveedores, sync ALTA, import Excel (cuyo dedup por `contains` no matcheaba
  formatos mixtos — bug). La IA ahora devuelve `providerTaxId` y `allTaxIds`
  canónicos desde el schema Zod. Nuevo `scripts/normalize-cuits-db.ts` (dry-run /
  `--apply`) para unificar el stock existente.

### Fix
- **CUITs extraídos del texto por regex+checksum (2026-06-12)**. Una boleta clara
  con proveedor correctamente cargado caía en Sin Asignar: la IA listó un solo
  CUIT (el del consorcio) malformado → el saneo lo descartó → `allTaxIds` vacío →
  sin puente CUIT entre el nombre de fantasía de la factura y la razón social
  cargada. Nuevo `extractCuitsFromText()` en `lib/documentValidation.ts` (regex
  con prefijos válidos + verificación mod-11; 8 tests TDD): el pipeline une los
  CUITs reales del papel a los de la IA (solo no-LSP). Probado e2e con el PDF
  real: ahora matchea por CUIT. Recuperar las boletas afectadas con "Reprocesar
  Sin Asignar" tras el rebuild del worker.

### Fix
- **Barrido de modelos Gemini restaurado (cuota diaria por modelo) (2026-06-11)**.
  Log de prod reveló que el free tier de Gemini tiene cuota **diaria por modelo**
  (`limit: 20`, `GenerateRequestsPerDayPerProjectPerModel-FreeTier`): el barrido
  original sumaba ~6 baldes (los 429 no consumen cuota) y al unificar a 1 modelo
  quedó 1 balde de 20/día. Se restaura el barrido (5 modelos, sin 2.5-pro, con
  `workingModelName`) conservando el anti-pérdida: todos sin cuota →
  `RateLimitError` → boleta a Pendientes. Corrige el análisis del fix del 10/06.
  Recomendación: tier pago (~USD 1-2/mes a este volumen) como solución definitiva.

### Observabilidad
- **Logs de diagnóstico de throughput (2026-06-11)**. Worker: profundidad de cola
  al reclamar cada job ("En cola: N detrás" — si es 0, el límite es el
  scheduler/batchSize; si crece, el límite es el worker) y heartbeat "cola vacía"
  cada 5 min. Scheduler: contador "Ya cargadas" en el resumen del ciclo.
  Contexto: se detectó que el throughput de 1 boleta/5min era el techo de
  `batchSize=1` + `intervalMinutes=5` (config del cliente, editable desde el
  panel admin), no un bug.

### Fix
- **Destrabe de Pendientes + jobs zombie + robustez del worker (2026-06-11)**.
  Tres fixes tras verificar en prod (DB + logs):
  - **Scheduler:** los PDFs de Pendientes que ya tienen Invoice ahora se **mueven
    a Duplicados** (o Escaneados) en vez de saltearse eternamente — destraba los
    14 archivos que loopeaban. Nuevo log `alreadyLoadedMoved`.
  - **Scheduler:** reaper de **jobs zombie** (PROCESSING > 30 min, de workers
    caídos) → PENDING o FAILED según intentos. Recupera 2 boletas perdidas de
    mayo. Nuevo log `staleJobsRecovered`.
  - **Worker:** `claimNextJob` blindado con try/catch + espera — un corte del
    pooler de Supabase (P1017) ya no crashea el proceso.
  Verificado además en prod que el fix 429 funciona: 35 boletas el 11/06, todas
  con `gemini-2.5-flash-lite`, sin barrido de modelos. Requiere rebuild de
  scheduler y worker.
- **Regresión 429 / throughput de boletas (2026-06-10)**. Se corrige la caída de
  procesamiento por rate-limit (cuota) de Gemini. **Causa raíz:** el extractor
  barría 6 modelos y reintentaba con cada uno ante un 429 → 6× consumo de cuota por
  boleta (confirmado en `logs/2026-06-08_15-43_worker.txt`). **Fix:**
  - `geminiExtractor.service.ts` usa **1 modelo configurable** (`GEMINI_MODEL` o
    default `gemini-2.5-flash-lite`) en vez de barrer 6.
  - Nuevo `src/lib/aiErrors.ts`: `isRateLimitError`, `RateLimitError` y
    `callWithRetry` (backoff acotado que reintenta solo ante 429). 16 tests (TDD).
  - El pipeline ya **no pierde** boletas con 429: las devuelve a Pendientes y el
    scheduler las re-encola en un ciclo posterior (sin loop de reintento inmediato).
  Sin migración de DB; requiere rebuild del worker. La hipótesis del "cambio de
  orden del pipeline" se descartó con git (el orden texto→IA es el de siempre).

### Tests
- **Test runner (Vitest) + red de seguridad (2026-06-10)**. Primer runner de tests
  del proyecto: **Vitest 4** + `vite-tsconfig-paths`, `vitest.config.ts`, scripts
  `test`/`test:watch`. 39 tests en 3 suites: `consortiumNormalizer`,
  `AiExtractionChain` y `assignmentMatching`. Caracterización detectó que el ejemplo
  `"BROWN ALMTE AV 708" → "ALMIRANTE BROWN 708"` del JSDoc/CLAUDE.md es aspiracional
  (real: `"BROWN ALMIRANTE AV 708"`; se resuelve vía matchNames/fuzzy).

### Refactor
- **Patrones de diseño — Fase 3 parcial: H3 MatchStrategy (2026-06-10)**. La lógica
  de matching de consorcio/proveedor se extrajo de `resolveAssignment`
  (`processPendingDocuments.job.ts`) a un módulo puro y testeado
  `src/lib/assignmentMatching.ts` (`matchConsortium`/`matchProvider`, 4 niveles cada
  uno). El pipeline delega en él; logging y mensajes quedan en el caller.
  Comportamiento preservado. **Pendiente:** H2 (descomponer `processDriveFile` en
  pasos) requiere caracterización del pipeline completo (mock de ~8 dependencias) →
  sesión dedicada.
- **Patrones de diseño — Fase 2 (2026-06-10)**. Consistencia de capas y
  observabilidad. Sin cambios de comportamiento. Verificado con typecheck + lint
  + build:jobs + next build.
  - **H6 — Repository + Inyección de dependencias:** los 5 repositorios reciben
    `PrismaClient` por constructor (getter lazy, mockeable en tests). El pipeline
    (`resolveAssignment`) ya no accede a Prisma directo: las queries se movieron a
    `ConsortiumRepository.findAllForMatching`, `ProviderRepository.findAllForMatching`
    y un nuevo `LspServiceRepository`. Respeta la arquitectura por capas.
  - **H8 — Consolidación de logging:** `lib/logger.ts` gana `repoLog`/`apiLog`
    (+ `shortLogId`). Migrados `invoice.repository.ts` (cierra PII de `clientId`/hash
    en la capa de datos) y los `console.warn` de la ruta de scan. Resto incremental;
    scripts de diagnóstico y bootstrap mantienen `console.*` a propósito.
- **Patrones de diseño — Fase 1 (2026-06-10)**. A partir del reporte de auditoría
  `docs/reporte-patrones-diseno.md`. Sin cambios de comportamiento salvo lo
  indicado abajo. Verificado con typecheck + lint + build:jobs + next build.
  - **H1 — Extractores IA (Strategy + Chain of Responsibility):** nuevo
    `src/services/aiExtraction.ts` (interfaz `AiExtractor`, `AiExtractionChain`,
    `createAiExtractionChain()`). Los 3 servicios (`geminiExtractor`,
    `aiExtractor`, `claudeExtractor`) implementan el contrato. Se eliminó el
    fallback Gemini→OpenAI→Claude **duplicado** entre el pipeline
    (`processPendingDocuments.job.ts`) y la ruta de scan manual
    (`consortiums/[id]/invoices/scan/route.ts`), que ya había divergido en el
    logging. El timing y el logging por intento se preservan vía callback.
  - **H4 — Boilerplate de rutas (HOF/Decorator):** nuevo `src/lib/apiHandler.ts`
    (`apiOk`, `apiError`, `withAuth`, `withClientAuth`). Migradas como piloto
    `rubros/route.ts` y `coeficientes/route.ts`. Nota: los POST migrados ahora
    devuelven **500** (no 400) para errores no-Zod — el shape `{ ok, error }` se
    mantiene.
  - **H5 — `loadProcessingClient()` (Factory):** en `clientProcessingConfig.ts`.
    Reemplaza el `findUnique({ select })` + mapeo a `ProcessingClient` duplicado
    en 8 lugares (scan, invoices, invoices/[invoiceId], receipt, payments,
    payments/[paymentId], setup-sheet-protection, syncInvoicePayments); corrige
    los valores hardcodeados (`name`, `batchSize`, `intervalMinutes`).

### Features
- **Logs de métricas del pipeline (instrumentación para análisis) (2026-06-08)**.
  Una línea `[metrics] {JSON}` por boleta en el log del worker (additiva, greppable):
  tiempos por paso (`ms.ai/ocr/text/...`), tokens+modelo, `textSource`
  (direct/ocr/merged/image), método de match, `result` y `reason`. Núcleo siempre
  sin PII; el bloque `values` (extraído vs canónico) solo con `debugMode`. Solo
  logging, sin migración. Archivos: `pdfTextExtractor.service.ts`, `logger.ts`,
  `processPendingDocuments.job.ts`. Nuevo: `scripts/test-metrics-payload.ts`.
  Diseño: `docs/superpowers/specs/2026-06-08-logs-metricas-pipeline-design.md`.
- **Rendiciones por edificio: boletas y recibos organizados en Drive para QR (2026-06-07)**.
  Las boletas OK ya no van a "Escaneados": ahora se organizan en
  `Rendiciones/[Edificio]/[Período]/` dentro de una carpeta raíz pública
  (`driveFoldersJson.statements`) que crea el owner una vez. La app crea la
  subcarpeta de cada edificio, la **comparte pública** (anyone/reader) una sola
  vez y guarda su link en `Consortium.statementsFolderUrl` (visible en el panel,
  con botón **Copiar** → para generar el QR). Dentro, los períodos se agregan mes
  a mes (`2026-06 Junio`). Los PDFs se **renombran** con naming legible
  (`PROVEEDOR - CONSORCIO - P06-2026 - NNNN.pdf`; sin N° → `SN + 6 del hash`;
  recibos según el tipo de pago, junto a su boleta). Aplica al **pipeline** y a
  la **carga manual**. Los **duplicados** siguen yendo a Duplicados (no a
  Rendiciones). **Llave anti-tokens en el scheduler:** si falta la carpeta
  `statements` o no hay ningún período ACTIVE, el cliente se saltea con aviso y
  **no se gasta ningún token** (los PDFs quedan en Pendientes). Caso puntual: un
  consorcio sin período activo → su boleta va a Revisión (`failed`). Delete y
  purga ahora mueven el archivo desde su **parent real** (Rendiciones), no
  asumiendo Escaneados. Migración: `Consortium.statementsFolderId/Url`
  (`20260607000100`). Diseño en
  `docs/superpowers/specs/2026-06-05-rendiciones-por-edificio-design.md` y
  detalle en `docs/decisiones.md`. Archivos: `schema.prisma`, `client.types.ts`,
  `clientProcessingConfig.ts`, `googleDrive.service.ts`,
  `processPendingDocuments.job.ts`, `runProcessingCycle.ts`, `jobWorkerMain.ts`,
  `scheduler.ts`, `logger.ts`, `invoices/route.ts`,
  `invoices/[invoiceId]/receipt/route.ts`, `clients/[id]/purge/route.ts`,
  `admin/consortiums/page.tsx`. Nuevos: `src/lib/statementsNaming.ts`,
  `src/services/statementsFolders.service.ts`, `scripts/test-statements-naming.ts`.
- **Crear archivos en Drive con service account vía Unidad Compartida (2026-06-04)**.
  La carga manual del PDF fallaba con `Service Accounts do not have storage
  quota` (las SA no pueden crear archivos en "Mi unidad"). Solución: mover las
  carpetas del cliente a una **Unidad Compartida** con la SA como miembro
  (Administrador de contenido) — el código ya soportaba Shared Drives, sin
  cambios y sin migración (los IDs de carpeta no cambian al mover). Se agregó
  además **soporte opcional de domain-wide delegation** (`impersonateEmail` en
  `googleConfigJson` / env `GOOGLE_IMPERSONATE_EMAIL` → `subject` en el JWT),
  retrocompatible. MorinigoAdm: unidad "Control de Boletas y Pagos". Detalle en
  `docs/decisiones.md`. Archivos: `googleDrive.service.ts`, `client.types.ts`,
  `clientProcessingConfig.ts`, `config/env.ts`.
- **Duplicados: consistencia DB↔Sheets + carpeta opcional (2026-06-04)**.
  Hasta ahora el pipeline escribía las boletas duplicadas en Google Sheets
  (marcadas `isDuplicate=YES`) pero NO en la DB — por eso Sheets quedaba con
  más filas que la DB (en MorinigoAdm: 522 vs 499, exactamente los 22+1
  duplicados). Diagnóstico read-only confirmó que NO era un bug de inserción
  (la boleta reportada como "faltante" estaba en la última fila). A pedido,
  ahora **los duplicados ya no se escriben en Sheets** → la planilla y la DB
  se mantienen 1:1 hacia adelante. Además, si se configura
  `driveFoldersJson.duplicates`, el PDF duplicado se mueve a esa carpeta
  ("Duplicados") en vez de a Escaneados, para revisión. Lo ya registrado en
  Sheets NO se modifica (solo aplica de ahora en más).
  Se descartó persistir los duplicados en la DB porque choca con el unique
  `uq_invoice_business_key` (requeriría migración que debilita la integridad)
  y porque inflaría los totales del período. Detalle en `docs/decisiones.md`.
  Archivos: `processPendingDocuments.job.ts`, `runProcessingCycle.ts`,
  `jobWorkerMain.ts`, `clientProcessingConfig.ts`, `client.types.ts`.
  Nuevo: `scripts/diag-sheets-consistency.ts` (diagnóstico read-only).

- **Carga asistida: el PDF escaneado ahora se guarda en Drive (2026-06-02)**.
  Antes, el PDF que se sube al modal "Cargar boleta" solo se usaba para
  extraer datos con IA y se descartaba — la boleta quedaba sin `sourceFileUrl`
  (columna ARCHIVO en "—" y celda de URL vacía en Sheets). Ahora, si la carga
  trae PDF, el endpoint `POST /api/client/consortiums/[id]/invoices` lo sube a
  la carpeta `scanned` del cliente (fallback `receipts`), guarda
  `driveFileId` + `sourceFileUrl` en la Invoice y escribe la URL en la
  columna K de Sheets. El endpoint acepta `multipart/form-data` además de
  JSON (compat). Si Drive falla, la boleta se guarda igual y se informa vía
  `driveWarning`. Archivos: `route.ts`, `page.tsx`.

### Fixes
- **Carga manual ahora deduplica (no se pueden cargar boletas repetidas) (2026-06-05)**.
  Bug crítico: el endpoint de carga manual generaba el `documentHash` con
  `Date.now()` (único siempre → el candado de hash nunca detectaba el mismo
  PDF) y no verificaba business key. Resultado: el mismo PDF cargado 2 veces
  entraba 2 veces en DB y Sheets (agravado cuando la IA leía el N° distinto,
  ej. `0005-...` vs `00005-...`, lo que tampoco activaba el unique de business
  key). Fix: se computa el **hash real del binario** (`computeDocumentHash`,
  igual que el pipeline) y se verifica duplicado por **hash** y por **business
  key** ANTES de subir/guardar; si ya existe, corta con **409** y un mensaje
  claro ("Esta boleta ya fue cargada"). Archivo: `route.ts`.
- **Inserción en Sheets con `append`+INSERT_ROWS (filtros se expanden) (2026-06-05)**.
  `GoogleSheetsService.insertRow` calculaba la fila a mano (`values.get` +
  `update` en `length+1`). Eso escribía en una celda **fuera del rango del
  filtro** de la hoja, por lo que un filtro creado por el usuario no mostraba
  las filas nuevas (había que recrearlo). Reescrito con
  `spreadsheets.values.append` + `insertDataOption: INSERT_ROWS`: inserta una
  fila física dentro de la tabla → el filtro/rango se expande solo. Además es
  **atómico** (sin race conditions entre worker y carga manual) e inmune a
  "filas fantasma". Afecta pipeline y carga manual. Sin migración.
  Archivo: `googleSheets.service.ts`.
- **Carga manual: el campo `consortium` (texto) quedaba NULL (2026-06-05)**.
  El endpoint `POST .../invoices` seteaba `consortiumId` (FK, correcto) pero no
  copiaba el nombre al campo desnormalizado `consortium`, que quedaba en NULL
  (se veía como "boleta sin consorcio" en vistas que muestran el texto, aunque
  la relación estaba bien). Se agregó `consortium: consortium.rawName` al
  create. Registro histórico afectado corregido vía UPDATE puntual en DB.
  Nota: confirmado que el PDF SÍ se sube a Drive (Shared Drive) y la fila SÍ
  se escribe en Sheets — el reporte de "no está en Sheets" fue un falso
  negativo (fila al final de la hoja). Archivo: `route.ts`.
- **Fallo silencioso al escribir boleta manual en Sheets (2026-06-02)**. El
  insert a Google Sheets en la carga manual estaba envuelto en un `try/catch`
  que solo hacía `console.warn` — si fallaba, la boleta quedaba en la DB pero
  no en la planilla y el usuario no se enteraba. Ahora el endpoint devuelve
  `sheetsWarning` y la UI lo muestra como toast (o confirma el éxito).
  Archivos: `route.ts`, `page.tsx`.

### UI
- **Columna "Estado" → "Origen" (Manual / Automática) (2026-06-02)**. La
  columna mezclaba conceptos (Manual / Duplicado / OK). Ahora indica solo el
  medio de carga: **Manual** (cargada a mano) o **Automática** (procesada por
  el pipeline desde Drive). Archivo: `src/app/admin/consortiums/page.tsx`.
- **Modal "Cargar boleta": monto con separador de miles + nombre del
  consorcio destacado (2026-06-02)**. El input de Monto pasó de
  `type="number"` (sin separadores) a `type="text"` + `inputMode="decimal"`
  con formateo es-AR al perder foco (`721.571,37`). El valor autocompletado
  por el scan también se muestra ya formateado, y al guardar se parsea con
  `parseAmountInput` (maneja puntos de miles). El nombre del consorcio al
  que se carga la boleta ahora se muestra grande, centrado y en mayúscula
  (nueva clase `.modalConsortiumName`), con el período centrado debajo.
  Archivos: `src/app/admin/consortiums/page.tsx`, `page.module.css`.

### Fixes
- **Falsos positivos en "esta boleta no pertenece al consorcio" al cargar
  manualmente (2026-06-02)**. El endpoint de scan (`POST /api/client/
  consortiums/[id]/invoices/scan`) avisaba que la boleta no pertenecía al
  consorcio seleccionado aunque sí perteneciera — típicamente cuando la IA
  tomaba al **proveedor** como consorcio. La validación solo comparaba
  igualdad exacta del nombre normalizado, mientras que el pipeline real usa
  matching de 4 niveles. Ahora el scan reutiliza esa misma lógica robusta
  (**CUIT → exacto → fuzzy → alias/matchNames**) y solo declara mismatch
  cuando la boleta matchea **claramente con otro consorcio** del cliente; si
  no se puede determinar, no bloquea. Sin cambios de contrato ni migración.
  Detalle en `docs/decisiones.md` (entrada 2026-06-02).
  Archivo: `src/app/api/client/consortiums/[id]/invoices/scan/route.ts`.

### CI / Ops
- **Export de logs antes del rebuild + upload como artifact (2026-05-25)**.
  Nuevo step en el job `deploy` que ejecuta `scripts/export-logs.ps1`
  (ya existente) antes de `docker compose up --force-recreate`. Genera
  `logs/<timestamp>_<service>.txt` para web, worker y scheduler de las
  últimas 72h. El siguiente step usa `actions/upload-artifact@v4` para
  subir esos .txt como artifact (`docker-logs-<sha>`, retención 14d),
  así quedan accesibles desde la pestaña Actions del repo aunque el
  runner se reinicie o pisemos `logs/` en el próximo deploy.
  Best-effort (`continue-on-error: true`) — si no hay containers
  previos, el step pasa sin abortar el deploy.
  Archivo: `.github/workflows/ci.yml`.

### Features
- **Destino del archivo al eliminar boleta: `failed` (Revisión) en vez de
  `pending` (2026-05-25, corrección)**. El PDF iba originalmente a la
  carpeta `pending`, lo cual hacía que el scheduler lo re-procesara y
  creara la misma boleta de nuevo. La carpeta correcta es la que el
  schema llama `failed` y en Drive se muestra como "Revisión" (nombre
  más amigable que ya estaba en uso). Endpoint DELETE invoice ahora
  mueve a `folders.failed`; si el cliente no la tiene configurada, el
  archivo se deja donde estaba y la respuesta incluye `warning`.
  Archivos: `src/types/client.types.ts` (doc del campo `failed`),
  `src/app/api/client/consortiums/[id]/invoices/[invoiceId]/route.ts`.

- **Eliminación de boletas y pagos desde la UI (2026-05-25)**. Dos endpoints
  nuevos y dos controles inline (ícono 🗑 + confirm "¿Borrar? Sí/No"):
  - `DELETE /api/client/consortiums/[id]/invoices/[invoiceId]` — elimina
    una boleta. Validaciones: pertenece al cliente + 0 pagos asociados
    (si tiene → 409, hay que borrar los pagos antes). Efectos:
      - Mueve el PDF en Drive `scanned` → `pending` (fallback: la carpeta
        actual del archivo si no está en scanned ni unassigned). Si el
        archivo no estaba en una carpeta conocida, no se mueve.
      - Si la boleta tenía un `Receipt` asociado (recibo manual), manda
        el PDF a la papelera de Drive y borra la fila de Receipt.
      - Borra la fila completa en Sheets (`deleteDimension` — no la
        blanquea).
      - Borra el Invoice de DB en transacción con el Receipt.
    Atómico: Drive y Sheets se ejecutan antes que DB; si fallan, se aborta
    con HTTP 502 sin tocar DB.
  - `DELETE /api/client/invoices/[id]/payments/[paymentId]` — elimina un
    pago. Restricción: solo el último pago registrado (validación
    heredada del `PaymentRepository`). Efectos:
      - Si el pago tenía comprobante (`driveFileId`), lo manda a la
        papelera de Drive.
      - Actualiza Sheets cols N/P/Q/R/S/T/U: si quedan otros pagos
        escribe el resumen del más reciente, si no limpia las celdas y
        deja estado "Impago".
      - Borra el Payment de DB + recalcula `isPaid` y `remainingBalance`
        de la Invoice (transacción Prisma).
    NO revierte el `periodId` si la boleta fue reasignada al mes
    siguiente por pago parcial.
  - Servicios nuevos: `GoogleDriveService.trashFile(fileId)`,
    `GoogleDriveService.getFileParents(fileId)`,
    `GoogleSheetsService.findInvoiceRow(...)`,
    `GoogleSheetsService.deleteInvoiceRow(...)`.
  - UI: botón 🗑 con confirm inline (mismo patrón que LSP services).
    Boletas: nueva columna ACCIONES al final. Pagos: el 🗑 va al lado
    del botón Cuotas/Ver pagos en la columna ACCIONES existente, y solo
    aparece si la boleta tiene al menos un pago registrado. Toasts
    de feedback (`toolbarInfo` / `toolbarError`).
  Solo CLIENT puede invocar estos endpoints.
  Archivos: `src/services/googleDrive.service.ts`,
  `src/services/googleSheets.service.ts`,
  `src/app/api/client/consortiums/[id]/invoices/[invoiceId]/route.ts`
  (nuevo),
  `src/app/api/client/invoices/[id]/payments/[paymentId]/route.ts`
  (reescrito),
  `src/app/admin/consortiums/page.tsx`.

### UI / UX
- **Mensaje de error incluye N° de comprobante + input importe en formato
  es-AR (2026-05-25)**. El mensaje de validación de pagos inline ahora
  muestra `Proveedor – N°comprobante: falta X` (antes solo el proveedor).
  El input "IMPORTE PAGO" pasó de `type="number"` a `type="text"` con
  `inputMode="decimal"`. Placeholder formateado con `Intl.NumberFormat`
  es-AR (ej: "85.000,16"). Helper `parseAmountInput()` acepta ambos
  formatos al guardar (coma o punto decimal). Helper `formatAmountPlain()`
  para placeholders sin símbolo de moneda.
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Validación de campos requeridos al registrar pago (2026-05-25)**.
  Tanto el flujo inline como el modal exigen ahora fecha de pago, importe
  (salvo empleados, que se autocalcula), medio de pago y comprobante PDF.
  Si falta alguno, mensaje específico ("falta fecha de pago, comprobante
  PDF"). Inline acumula errores por fila ("Proveedor X: falta..."). Modal
  acumula todos los faltantes en un solo mensaje. Label "Comprobante PDF
  (opcional)" → "Comprobante PDF".
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Columna COMPROBANTE inline en Pagos (2026-05-25)**. Nueva columna
  entre MEDIO DE PAGO y ACCIONES con botón "📎 Adjuntar" para subir
  un PDF junto al pago inline (antes solo se podía adjuntar via el
  modal de Cuotas). `PendingPaymentInput` extendido con `file: File | null`
  y `handleGuardarPagos` arma FormData cuando hay archivo (mantiene
  JSON cuando no, para no romper el flujo existente).
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Label del período en mayúsculas (2026-05-25)**. `text-transform:
  uppercase` en `.periodNavLabel` ("Mayo 2026" → "MAYO 2026"). Archivo:
  `src/app/admin/consortiums/page.module.css`.

- **Espaciado de Pagos consistente con Boletas (2026-05-25)**. Removidos
  los `marginBottom: 12` inline del `statsStrip` y `searchRow` de
  PagosView — `.main` ya aporta `gap: 16px` entre hijos. Mismo ritmo
  vertical que Boletas. Archivo: `src/app/admin/consortiums/page.tsx`.

- **Header de Pagos con stat cards y "X de Y" en Pagos registrados
  (2026-05-25)**. El header de la pestaña Pagos pasó de
  `.pagosSummary` (spans inline) a `.statsStrip` + `.statCard` (mismo
  diseño de recuadros que Boletas). "Pagos registrados" ahora muestra
  `{pagadas} de {total}` (cantidad de boletas, no monto) — más
  intuitivo para saber cuántas faltan cobrar. "Saldo impago" mantiene
  el color naranja vía `.statWarn` cuando el valor es > 0.
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Totales del header desacoplados del filtro + cada stat en su propio
  recuadro (2026-05-25)**. Las métricas del header (Boletas, Total
  período, Duplicados en la pestaña Boletas; Pagos registrados y Saldo
  impago en Pagos) ahora se calculan sobre el período completo, no
  sobre el subset filtrado por el buscador. CSS: el `.statsStrip` dejó
  de ser un contenedor único — cada `.statCard` tiene su propio border
  y background, todos en una fila con `gap: 10px`.
  Archivos: `src/app/admin/consortiums/page.tsx`,
  `src/app/admin/consortiums/page.module.css`.

- **Medio de pago del modal: input libre → dropdown (2026-05-25)**.
  El campo "Medio de pago" del modal de cuotas pasó de `<input type=text>`
  a `<select>` con las mismas 3 opciones que el inline (Débito automático,
  Transferencia, Efectivo). Ambos selects usan placeholder "Elija una
  opción" (option vacía `disabled hidden`).
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Toggle del modal: "Pagar en cuotas" → "Cuotas fijas" (2026-05-25)**.
  Más claro respecto al modo (monto auto-calculado por N cuotas).
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Medios de pago simplificados + botón "Cuotas" (2026-05-25)**. En el
  dropdown de Medio de Pago de la pestaña Pagos quedan solo 3 opciones
  genéricas: Débito automático, Transferencia, Efectivo. Se sacaron las
  variantes con banco y "Descuento". El botón "Pagar" de la columna
  Acciones se renombró a "Cuotas" — abre el modal para pagos en cuotas
  (fijas o variables); los pagos únicos se cargan inline en la fila.
  Prop `consortiumBank` removida de PagosView (ya no se usa).
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Buscadores unificados — sin matching por detalle (2026-05-25)**.
  Boletas y Pagos ahora filtran por `provider + boletaNumber + CUIT` con
  el mismo placeholder. Se sacó el match por `detail` (poco usado y
  ruidoso). Archivo: `src/app/admin/consortiums/page.tsx`.

- **Scroll vertical en tablas con header sticky (2026-05-25)**. `.tableWrap`
  ahora tiene `max-height: 65vh` y `overflow: auto`; el `<thead>` queda
  pegado arriba al scrollear. Aplica a Boletas, Pagos y "Ver pagos".
  Archivo: `src/app/admin/consortiums/page.module.css`.

- **Stats inline en una sola línea (2026-05-25)**. Las 4 stat cards de
  la pestaña Boletas (Boletas, Total período, Duplicados, Rubros) estaban
  en un grid 4×1 con cada card grande (label arriba 11px, valor abajo
  22px), ocupando ~80px verticales. Ahora viven en una sola barra
  horizontal compacta (`.statsStrip` pasó de `display: grid` a
  `display: flex; flex-wrap: wrap`) con label y valor inline en baseline.
  Cada item es `.statCard` con `display: inline-flex; gap: 8px` (label +
  valor). El contenedor mantiene `background` y `border-radius`. En
  mobile (`max-width: 768px`) reduce gap y padding; ya no hace falta
  cambiar el grid-template-columns. Total: ~50px menos de altura.
  Archivos: `src/app/admin/consortiums/page.module.css`.

- **Buscador en pestaña Pagos (2026-05-25)**. La pestaña Boletas tenía
  un input de búsqueda (proveedor / N° boleta / detalle), Pagos no. Se
  agregó el mismo widget (`.searchRow` + `.searchInput` + `.clearSearch`)
  en PagosView con state local `search` independiente del de Boletas
  (cada pestaña tiene su contexto de búsqueda). Filtra por nombre de
  proveedor y N° de comprobante. Empty state diferenciado: "No hay
  boletas que coincidan con la búsqueda" vs "No hay boletas para este
  período". Los totales del header (Pagos registrados, Saldo impago)
  se calculan sobre el subset filtrado — útil para ver el saldo que
  debe un proveedor específico al buscarlo.
  Archivos: `src/app/admin/consortiums/page.tsx`.

- **Navegador de período al lado del nombre del consorcio (2026-05-25)**.
  El bloque `‹ Mes Año ›` vivía debajo de la sección de Servicios públicos
  (LSP), forzando un scroll para cambiar de período. Se movió al
  `detailHeader`, inline al lado del título del consorcio, dentro de una
  nueva fila `.detailTitleRow` (flex con gap 18px, wrap habilitado para
  pantallas chicas). Ahora cambiar de mes es 1 click sin scroll.
  Archivos: `src/app/admin/consortiums/page.tsx`,
  `src/app/admin/consortiums/page.module.css`.

- **Sección Servicios públicos (LSP) colapsable (2026-05-25)**. El bloque
  ocupaba ~5 renglones fijos (título + tabla + formulario de alta) en
  todos los consorcios, aunque la mayoría del tiempo no se necesita
  interactuar (los servicios ya están cargados desde el archivo ALTA).
  Ahora el `<h3>` es un botón toggle (`.lspToggle`) con chevron `▸/▾` y
  badge contador con la cantidad de servicios. **Default cerrado** —
  el usuario expande on-demand para ver, agregar o eliminar. El form de
  alta también queda oculto hasta expandir, lo cual evita clicks
  accidentales. Estado local `lspCollapsed` (session-only).
  Archivos: `src/app/admin/consortiums/page.tsx`,
  `src/app/admin/consortiums/page.module.css`.

- **Eliminación del toolbar superior en /admin/consortiums (2026-05-25)**.
  Se quitó por completo el `<div className={styles.toolbar}>` que ocupaba
  una franja horizontal arriba del contenido principal. Antes contenía:
  hamburger (mobile), mensajes de feedback (toolbarInfo/toolbarError) y
  toggle de tema (sol/luna). Tras las iteraciones previas (botones del
  scheduler movidos al sidebar), el toolbar quedó casi vacío y solo
  comía altura útil de la tabla. Lo que se hizo con cada elemento:
  - **Toggle de tema**: eliminado. El cambio de tema vive solo en el
    panel principal (`/admin`), que ya tiene su propio botón "Modo
    claro/oscuro". Al cargar `/admin/consortiums` se respeta el
    `data-theme` que haya dejado el panel principal (lectura del
    atributo en `document.documentElement` al mount).
  - **Hamburger menu** (`☰`): reubicado como **botón flotante**
    (`position: fixed`, top-left) en una nueva clase `.fabHamburger`,
    visible solo en `max-width: 1024px`. En desktop el sidebar
    izquierdo siempre está visible, así que no hace falta.
  - **Mensajes de feedback**: convertidos en **toast flotante**
    arriba-derecha (`.toastContainer` + `.toastItem`) con
    autodismiss (4s info, 5s error) y animación slide-in. Antes los
    mensajes quedaban pegados en el toolbar hasta la próxima acción.
  Archivos: `src/app/admin/consortiums/page.tsx`,
  `src/app/admin/consortiums/page.module.css`.

- **Fix NaN + simplificación de headers en pestaña Pagos (2026-05-25)**.
  Los totales del header (Total del período / Pagos del mes actual /
  Saldo impago) mostraban `$ NaN` porque Prisma serializa `Decimal` como
  string y `string + 0` concatena en vez de sumar — el `reduce` armaba
  `"65000.2665000.08…"` y `Intl.format` no podía parsearlo. Se agregó un
  helper `toNum()` que convierte explícitamente (con guarda `isFinite`)
  y se recalcularon las métricas con semántica correcta:
  - **Pagos registrados** = `amount - remainingBalance` por boleta
    (refleja pagos parciales reales, antes simplemente sumaba `amount`
    de las boletas marcadas `isPaid`, lo cual ignoraba pagos en cuotas).
  - **Saldo impago del período** = suma de `remainingBalance` (o
    `amount` si nunca se pagó nada) de las boletas no pagadas.

  Además se eliminó la métrica "Total del período" porque era redundante
  con la stat card "TOTAL PERÍODO" de la pestaña Boletas. Se renombró
  "Pagos del mes actual" → "Pagos registrados" (más preciso: cuenta
  pagos del período seleccionado, no del mes calendario).
  Archivos: `src/app/admin/consortiums/page.tsx`.

- **Botones del scheduler movidos del toolbar al sidebar (2026-05-25)**.
  Los botones "Pausar scheduler" / "Encender scheduler" y "Ejecutar ahora"
  vivían en el toolbar superior, ocupando espacio visual encima de la
  tabla principal. Se movieron al sidebar colapsable izquierdo, agrupados
  arriba del botón "Cerrar sesión" y separados por un divisor. El toolbar
  ahora solo conserva el hamburger menu (mobile) y los mensajes de
  feedback (toolbarInfo / toolbarError). Mantienen los mismos handlers
  (`handleToggleScheduler`, `handleRunNow`) y reaccionan al mismo estado
  (`paused`, `schedulerEnabled`, `busyAction`). Iconos: ⏸️/▶️ para el
  toggle y ⚡ para ejecutar ahora.
  Archivos: `src/app/admin/consortiums/page.tsx`.

- **Separación de responsabilidades entre pestañas Boletas y Pagos
  (2026-05-25)**. La tabla de la pestaña **Boletas** ya no muestra los
  botones "Pagar" / "Ver pagos" en la columna PAGO — solo conserva el
  indicador visual de estado (`Pagada` / `Resta $X` / `—`). Los botones
  de acción se movieron a una nueva columna **ACCIONES** al final de la
  tabla de la pestaña **Pagos**, donde conviven con el flujo inline
  existente (carga rápida fecha/importe/medio + botón GUARDAR al pie).
  Motivo: el botón duplicado en Boletas generaba confusión sobre dónde
  cargar pagos. Ahora cada pestaña tiene una sola responsabilidad clara:
  Boletas = datos de boletas, Pagos = gestión de pagos. Los modales
  (cuotas/libre y "Ver pagos") siguen activos, solo cambia el entry
  point. Archivos: `src/app/admin/consortiums/page.tsx`.

### Security / CI
- **Healthcheck real con verificación de DB (2026-05-25)**. Nuevo endpoint
  `GET /api/health` que ejecuta `prisma.$queryRaw\`SELECT 1\`` con timeout
  de 5s y devuelve 503 si la DB no responde. El healthcheck de
  `docker-compose.yml` ahora apunta a `/api/health` en vez de `/login`.
  Antes, el healthcheck del container marcaba "healthy" aunque la conexión
  a Supabase estuviera caída (porque `/login` es un form estático que pasa
  igual). Ahora un fallo real de DB → Docker marca unhealthy → restart
  automático según `restart: unless-stopped`. Response incluye `uptime`,
  `timestamp` y `message` con el error si aplica. El endpoint es público
  (sin auth) — el middleware solo matchea `/admin*` y `/login`.
- **Límites de memoria y CPU en docker-compose.yml (2026-05-25)**.
  Agregadas declaraciones `deploy.resources.limits` y `reservations` a los
  4 servicios para prevenir que un memory leak en el worker o spike de
  carga tire el host completo (escenario crítico porque el host también
  corre el self-hosted runner de GHA — un OOM bloqueaba futuros deploys).
  Valores elegidos basados en el rol de cada servicio:
  - **web** (Next.js SSR): limit 1024M / 1 CPU, reservation 256M / 0.25 CPU.
  - **scheduler** (escaneo periódico de Drive): limit 256M / 0.5 CPU,
    reservation 64M / 0.1 CPU. Es el más liviano.
  - **worker** (OCR + IA + pdf-parse): limit 1536M / 2 CPU, reservation
    512M / 0.5 CPU. El más pesado, picos altos con PDFs grandes.
  - **tunnel** (cloudflared): limit 128M / 0.25 CPU. Daemon liviano.

  Las `reservations` se ignoran en Docker Compose standalone (solo aplican
  en Swarm) pero documentan el baseline esperado. Los `limits` sí se
  aplican y previenen OOM del host.

- **`.dockerignore` ampliado (2026-05-25)**. El archivo tenía solo 8
  patrones básicos. Ahora cubre 41 patrones organizados por categoría:
  - **Build outputs:** `dist/`, `*.tsbuildinfo` (se regeneran en el
    builder con `npm run build:jobs`).
  - **Logs locales:** `logs/`, `*.log`, debug logs de npm/yarn/pnpm.
  - **Variables de entorno:** ampliado a `.env` y `.env.*` (antes
    `.env*`, equivalente pero más explícito).
  - **IDEs y herramientas locales:** `.vscode`, `.idea`, `.claude`,
    `.cursor`, `*.swp`/`*.swo`.
  - **Sistema operativo:** `Thumbs.db`, `.DS_Store`.
  - **Documentación interna:** `docs/`, `CHANGELOG.md`, `README.md`,
    `CLAUDE.md`, `*.pdf` — no se necesitan en runtime. No reducen el
    tamaño de la imagen final (el runner stage solo copia
    `.next/standalone`, `public`, `dist`, `prisma` desde el builder),
    pero aceleran el envío del contexto al daemon y evitan filtrar
    docs internas en stages intermedias.
  - **CI/CD:** `.github/` (los workflows no van adentro del container).
  - **Tests y caches:** `coverage/`, `*.test.*`, `*.spec.*`,
    `__tests__`, `.eslintcache`.
  - **Backups:** `*.bak`, `*.orig`, `*.tmp`.

  Verificado contra el Dockerfile: el `COPY . .` del builder sigue
  recibiendo todos los paths necesarios para `npx prisma generate &&
  npm run build && npm run build:jobs` (src, prisma, public,
  package.json, tsconfig*, next.config.ts, middleware.ts,
  next-env.d.ts). `scripts/` queda incluido porque puede usarse con
  `docker exec` para tareas admin (create-admin, fix-folders, etc.).

  Impacto medido del contexto excluido: ~2.1 MB adicionales (logs 680 KB,
  tsbuildinfo ~672 KB, dist 399 KB, docs 180 KB, CHANGELOG/README/CLAUDE.md
  ~110 KB, .pdf 44 KB, .claude/.vscode 5 KB). Los exclusiones preexistentes
  ya cubrían 1.5 GB (`node_modules` 1.2 GB + `.next/` 322 MB). El beneficio
  principal de esta iteración no es el tamaño sino la defensa en profundidad
  contra leak de docs internas en stages intermedias.

- **Fix: `docker login` con action oficial (2026-05-21)**. El intento
  anterior usaba `$env:GHCR_TOKEN | docker login --password-stdin` en
  PowerShell. Falló en CI run #53 con `denied: denied`. Causa: PowerShell
  5.1 con `Write-Output`/`|` agrega CRLF al final del string pipeado;
  `docker login --password-stdin` lee hasta EOF e interpreta el token
  como `<token>\r\n`, que GHCR rechaza. Reemplazado por la action oficial
  `docker/login-action@v3` (misma que ya usa el job `build`) que
  internamente maneja el password-stdin correctamente en
  Linux/macOS/Windows. Mantiene el beneficio de Crítica #2 (token nunca
  como argumento visible).
- **Fix: scripts del job `deploy` reescritos en PowerShell (2026-05-21)**.
  El primer intento de los 3 fixes críticos (commit anterior) usaba
  `shell: bash`, pero el runner self-hosted Windows no tiene
  `/bin/bash` instalado — el step "Write env file" murió con
  `execvpe(/bin/bash) failed: No such file or directory`. Reescritos en
  `shell: powershell` (Windows PowerShell 5.1, mismo que ya usa el step
  "Wait for healthy (Windows)" del workflow):
  - **Crítica #1 — abort on failure:** PowerShell con
    `$ErrorActionPreference = 'Stop'` solo aborta en cmdlets, no en
    native commands (`docker`, `npx`). Para cubrir esos casos se
    definió un helper `Invoke-Step "<name>" { <body> }` que ejecuta el
    bloque y hace `throw` si `$LASTEXITCODE -ne 0`. Equivalente
    funcional a `set -euo pipefail` para native commands. Cada paso
    (login, pull, tag, migrate, up, prune) está envuelto en
    `Invoke-Step` con label legible que aparece en los logs como
    `==> prisma migrate deploy`.
  - **Crítica #2 — `--password-stdin`:** sin cambios funcionales,
    `$env:GHCR_TOKEN | docker login --password-stdin` funciona idéntico
    al pipe de bash.
  - **Crítica #3 — `.env` desde GitHub Secret:** validación con
    `[string]::IsNullOrWhiteSpace($env:PROD_ENV)`. Escritura con
    `[System.IO.File]::WriteAllText("$PWD\.env", $env:PROD_ENV)` para
    evitar el BOM UTF-16 que Windows PowerShell agregaría con
    `Out-File`/`Set-Content` por defecto (docker compose no parsea bien
    `.env` con BOM). `chmod 600` eliminado — no aplica en NTFS.
- **Hardening del workflow de deploy (2026-05-21)**. Tres fixes críticos
  aplicados a `.github/workflows/ci.yml`, job `deploy`:
  - **`set -euo pipefail`** al inicio de los scripts `run: |` (steps
    "Write env file" y "Build and restart"). Sin esto, un `prisma migrate
    deploy` fallido **no abortaba el script** — los pasos siguientes
    (`docker compose up -d --force-recreate`) seguían ejecutándose y los
    containers nuevos arrancaban con código nuevo contra schema viejo de
    DB. Era una falla silenciosa: el job de GHA reportaba ✅ pero
    producción quedaba rota. Con `-e` el script aborta inmediatamente,
    los containers viejos siguen corriendo, y el job reporta ❌
    explícitamente.
  - **`docker login --password-stdin`** en vez de `-p $TOKEN`. El token
    ya no aparece como argumento de proceso (visible en `ps aux`,
    `/proc/<pid>/cmdline`, warnings de Docker). Llega vía pipe desde la
    env var `GHCR_TOKEN`. Defense in depth — los scanners de seguridad
    flagean el patrón `-p` como CWE-214.
  - **`.env` desde GitHub Secret `PROD_ENV_FILE`** en vez de
    `copy` desde un path hardcodeado del runner
    (`C:\Users\jony\...\drive-doc-processor\.env`). El path apuntaba a
    una carpeta de un proyecto distinto al actual y solo funcionaba en
    una máquina. Ahora el contenido del `.env` vive en GitHub Secrets
    (cifrado at rest, enmascarado en logs), es editable desde la UI de
    GitHub, y funciona desde cualquier runner. Si el secret no está
    configurado, el job falla con error explícito en vez de seguir con
    `.env` faltante.

  **Migración manual requerida:** crear el secret `PROD_ENV_FILE` en
  `Settings → Secrets and variables → Actions` con el contenido completo
  del `.env` de producción antes del próximo push a master.

### Added
- **Feature: Pagos vía Sheets + modal UI con upload de PDF (2026-05-21)**.
  Sistema híbrido para registrar pagos sobre la misma fila de la boleta en la
  hoja de Sheets. Dos caminos de entrada complementarios:

  **Camino A — Modal en la UI:**
  - Botón **Pagar** en cada fila de la tabla de Boletas del panel cliente
    (`/admin/consortiums`). Cuando `isPaid === true`, el botón cambia a
    **Ver pagos** y abre un modal read-only con el historial completo
    (tabla con tipo, fecha, monto, medio, link comprobante, observación).
  - Modal con detección automática de **dos modos de pago** (consistente
    con `PaymentRepository`):
    - **Modo A — Cuotas pactadas:** el primer pago define `totalInstallments`.
      El backend calcula `effectiveAmount = invoice.amount / totalInstallments`
      con `installmentNumber` autoincrementando desde 1. El último pago
      absorbe la diferencia de redondeo (`remainingBalance` real).
    - **Modo B — Pago libre:** sin `totalInstallments`. El usuario decide el
      monto cada vez. `installmentNumber = null` siempre.
    - Mezcla bloqueada: si la boleta arrancó libre, no se pueden agregar
      cuotas; si arrancó en cuotas, no se pueden agregar pagos libres.
      `PaymentRepository` lanza 409 si se intenta.
  - Comportamiento del modal:
    - **Primer pago:** muestra un toggle "Pago libre / Pagar en cuotas".
      Si elige cuotas, aparece el input "cantidad de cuotas" y el monto
      se autocalcula y se muestra como readonly.
    - **Pagos siguientes (cuotas pactadas):** banner azul "Modo cuotas
      pactadas · Cuota N de M". Input cuotas oculto, monto autocalculado y
      readonly. Aviso "Última cuota — absorbe diferencias de redondeo" en la
      cuota final.
    - **Pagos siguientes (libre):** banner naranja "Modo pago libre · Ya hay
      N pago(s) registrado(s)". Input cuotas oculto, monto editable con
      default = `remainingBalance`.
  - Resto de campos: fecha, medio de pago (texto libre), observación
    (opcional), archivo PDF (opcional, máx 20MB).
  - El endpoint `POST /api/client/invoices/[id]/payments` ahora acepta
    `multipart/form-data` además de JSON (compatible con la UI legacy):
    sube el PDF a Drive (carpeta `receipts / consorcio / período`), crea el
    Payment vía `PaymentRepository`, reasigna `periodId` al mes siguiente
    si queda saldo (crea período ACTIVE si no existe) y refleja todo en la
    fila de Sheets en una sola pasada (batch update sobre N/P/Q/R/S/T/M).

  **Camino B — Sincronización Sheets → DB:**
  - Endpoint `POST /api/client/sync-payments`: lee las columnas Q/R/S/T de
    cada fila de la hoja de boletas, hace upsert idempotente en `Payment`
    (clave natural: `invoiceId + día de pago + monto.toFixed(2)`), recalcula
    `isPaid` / `remainingBalance`, reasigna `periodId` al mes siguiente
    cuando queda saldo, y refleja los derivados (N/P/M) en la misma fila.
    Tolerante a errores — devuelve warnings por fila.
  - Útil cuando el cliente edita las columnas Q/R/S/T directamente en
    Sheets (sin pasar por el modal). Las dos vías son intercambiables.
  - Botón **Sincronizar pagos** (💵) en el sidebar del panel cliente.

  **Columnas nuevas en la hoja de boletas (escritas por la app):**
  - **P = SALDO PENDIENTE** — saldo restante formateado en es-AR.
  - **Q = MONTO PAGADO** — total acumulado pagado (derivado de
    `amount - remainingBalance`).
  - **R = CANT CUOTAS** — número total de cuotas si es pago en cuotas.
  - **S = FECHA PAGO** — fecha del último pago en formato DD/MM/YYYY.
  - **T = URL COMPROBANTE** — link al PDF subido a Drive.
  - **U = MEDIO PAGO** — texto libre con el medio de pago real usado
    (ej: "Transferencia BBVA", "Cheque 1234", "Efectivo"). Lo escribe el
    modal desde el campo `paymentMethod` del form, o el cliente directamente
    en Sheets. La key del mapping es `paidWith` para no colisionar con
    `Invoice.paymentMethod` (enum LSP extraído por la IA al procesar la
    factura).

  **Protección de la hoja (toggle bloqueo/desbloqueo manual):**
  - `POST /api/client/setup-sheet-protection`: aplica `addProtectedRange`
    sobre A:U de la hoja de boletas (rango calculado dinámicamente desde el
    mapping). La service account queda como único editor explícito.
    Idempotente: limpia rangos previos con descripción `dpp:invoices-lock`
    antes de crear el nuevo. **Antes de proteger ejecuta auto-sync** vía
    `syncInvoicePaymentsFromSheets` para volcar a la DB cualquier edición
    manual hecha mientras la hoja estaba desbloqueada. Si el sync falla, no
    se aplica la protección (devuelve error).
  - `DELETE /api/client/setup-sheet-protection`: quita los rangos
    `dpp:invoices-lock` para permitir ediciones manuales en Sheets en casos
    puntuales. Idempotente (responde ok aunque no hubiera ninguno). Solo
    CLIENT — el cliente es dueño de su propia hoja.
  - UI: botones **🔒 Proteger hoja** y **🔓 Desproteger hoja** en el sidebar
    (solo CLIENT). El de desproteger muestra una confirmación recordando
    que hay que re-bloquear cuando se termine — el re-bloqueo dispara el
    auto-sync.
  - Lógica del sync extraída a
    `src/lib/syncInvoicePayments.ts::syncInvoicePaymentsFromSheets` para
    ser reusable entre `/sync-payments` y `/setup-sheet-protection` (DRY).

  **Schema:**
  - `SchedulerState.lastPaymentsSyncAt DateTime?` — última sincronización.
  - **No se persiste `paidAmount` en Invoice**: es un derivado de
    `amount - remainingBalance` (o `SUM(payments.amount)` directo).
    Persistirlo crearía una tercera fuente de verdad que puede
    desincronizarse si alguien crea/elimina un Payment fuera del camino
    del recálculo.
  - Migración: `20260521000100_add_payment_sync_fields`.

  **Otros:**
  - El panel `/admin` muestra "Última sync pagos" junto a "Última sync
    directorio" en la tarjeta de estado del scheduler.
  - `GoogleSheetsService` extendido con `readInvoicePaymentRows`,
    `updateInvoicePaymentInfo` (escribe N/P/M/Q/R/S/T opcionalmente),
    `protectInvoiceColumns` y `getSheetId`.
  - El método `updatePaymentStatus` legacy se mantiene por compat con
    flujos existentes pero el path nuevo usa `updateInvoicePaymentInfo`.

### Changed
- CI/CD: el job `deploy` ahora pinea la imagen de Docker por `${{ github.sha }}`
  en vez de pullear `:latest`. `docker-compose.yml` lee el tag via
  `${IMAGE_TAG:-latest}`. Esto evita que un manifest local cacheado de `:latest`
  deje al host corriendo una imagen vieja después de un pull silenciosamente
  exitoso pero sin actualizar (caso que ocurrió el 18/05/2026 con el commit
  d33ff62). El step también retagea localmente a `:latest` después del pull
  para preservar el flujo de `docker compose up` manual sin la env var.

### Added
- Feature: soporte para Claude (Anthropic) como tercer proveedor de IA en la
  cadena de extracción. La cascada queda **Gemini → OpenAI → Claude** antes
  del fallback final a OCR_ONLY. Se aplica tanto en el pipeline automático
  (`processPendingDocuments.job.ts`) como en el endpoint de scan manual
  (`/api/client/consortiums/[id]/invoices/scan`).
  - Nuevo `ClaudeExtractorService` (`src/services/claudeExtractor.service.ts`)
    usando `@anthropic-ai/sdk` con `messages.create`, espejo del patrón de
    `AiExtractorService` (OpenAI): mismos prompts via `buildExtractionPrompt`
    y refinamiento posterior con `refineExtractionWithRawText`.
  - Tracking de tokens con `provider: "anthropic"` en `AiUsageMetrics`
    (`AiProvider` extendido a `"gemini" | "openai" | "anthropic"`).
  - Variables de entorno opcionales: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
    (default `claude-haiku-4-5-20251001`).
  - `resolveAiConfig` desencripta `anthropicApiKey` por cliente igual que
    Gemini/OpenAI; `extractionConfigJson` admite `anthropicApiKey`/
    `anthropicModel` sin cambios de schema (JSON libre).
- Feature: `anthropicApiKey` configurable desde la UI admin (alta y edición
  de cliente), siguiendo el mismo patrón que `geminiApiKey`/`openaiApiKey`.
  - `GET /api/admin/clients/[id]` retorna `hasAnthropicApiKey`.
  - `PATCH /api/admin/clients/[id]` y `POST /api/admin/clients` validan y
    encriptan la key con `encrypt()` antes de persistir.
  - Inputs nuevos en `/admin/clients/[id]` (sección "Claves de IA") y en
    `/admin` (formulario de alta de cliente).
- CI: la imagen de Docker en `ghcr.io/johnydeev/ia-drive-doc-processor` ahora
  se tagea con `:latest` y con `${{ github.sha }}` en cada push a master,
  habilitando rollbacks a versiones anteriores por SHA.
- Feature: reporte de resumen al final de cada ciclo automático del
  scheduler, solo cuando se encontró al menos 1 archivo.
  Muestra encontrados, encolados y ya en cola.
- Feature: resumen de ciclo en worker automático — cuando la cola
  se vacía después de procesar al menos 1 archivo, emite totales
  de procesados, sin asignar, duplicados y fallidos.

## [Unreleased] - 2026-04-15

### Security
- Fix crítico: descifrado legacy ahora prueba ambas claves candidatas (GCEK + SESSION_SECRET)
  con AES-GCM auth-tag check, garantizando lectura de secretos viejos sin importar con cuál
  se cifraron originalmente
- Fix alto: removidos logs sin sanitizar — `pdf-extractor` ya no imprime los primeros 500
  chars del texto, y `extractionResult` redacta CUIT/CUITs/monto en logs normales
- Fix alto: scan rutea correctamente imágenes JPG/PNG a Gemini Vision en vez de pdf-parse
- Fix crítico: /api/process ahora requiere sesión de admin autenticada
- Fix alto: endpoints de escritura usan requireClientSession() — VIEWER no puede mutar datos
- Fix alto: scan (`POST /api/client/consortiums/[id]/invoices/scan`) usa requireClientSession — VIEWER no puede consumir IA/OCR
- Fix medio: límites de tamaño en uploads (Excel 10MB, PDF scan 15MB, receipt 20MB) + validación MIME
- Fix medio: validación de magic bytes en uploads (PDF, PNG, JPG, XLSX/ZIP)
- Fix medio: cifrado versionado v2 en `enc:v2:...`. Nuevos secretos usan exclusivamente
  GOOGLE_CREDENTIALS_ENCRYPTION_KEY; el formato legado `enc:...` sigue legible con SESSION_SECRET
  para compatibilidad. Script de migración: `tsx scripts/rotate-encrypted-secrets.ts [--apply]`
- Fix medio: validación en producción que avisa si falta GOOGLE_CREDENTIALS_ENCRYPTION_KEY
- Fix medio: sanitización (CUITs, importes, emails, CBU) + truncado de logs en debug mode
- Fix bajo: warning en logs cuando debug mode está activo con datos sensibles
- Fix bajo: OpenAPI documenta /api/process como protegido (cookieAuth)

### Fixed
- Fix: `clientNumber` se limpia automáticamente para boletas no-LSP si Gemini alucina un valor (campo reservado exclusivamente para boletas LSP)
- Fix deduplicación: `boletaNumber` distinto → nunca duplicado, independiente de monto y vencimiento. Caso testigo: dos facturas RANKO S.R.L. con números 0003-00154753 y 0003-00155282 se marcaban como duplicado por compartir monto/período.
- Fix: los duplicados no se guardan en DB — solo se registran en Sheets (con `ES_DUPLICADO=YES`) y se mueven a Escaneados.

### Added
- Feature: solapa Pagos en vista de consorcio
  - Tabs Boletas / Pagos en el header del consorcio (reset a "boletas" al cambiar de consorcio)
  - Vista Pagos con tabla inline editable (fecha, importe, medio de pago)
  - Empleados: solo fecha de pago (monto siempre total)
  - Proveedores: fecha + importe editable + medio de pago
  - Botón GUARDAR confirma todos los pagos pendientes en un solo click
  - Al guardar: actualiza `isPaid`/`remainingBalance` en DB y reescribe columna N ("ESTADO PAGO") en Sheets
  - Medios de pago: Transferencia/Cheque propio con banco del consorcio, Descuento, Efectivo
- Migración `20260415000200_payment_optional_drive_add_payment_method`: `Payment.driveFileId`/`driveFileUrl` ahora opcionales, nuevo campo `Payment.paymentMethod` (texto libre)
- `GoogleSheetsService.updatePaymentStatus()`: busca fila por `sourceFileUrl` o `boletaNumber+providerTaxId` y actualiza la columna `paymentStatus`
- Feature: soporte para archivos JPG/PNG en carpeta Pendientes de Drive. El scheduler los detecta y el pipeline los procesa directamente con Gemini Vision sin pasar por pdf-parse ni Tesseract OCR.
  - GoogleDriveService: query mimeType ampliado a image/jpeg e image/png
  - GeminiExtractorService: nuevo método `extractStructuredDataFromImage()`
  - Pipeline: detección `isImage` por mimeType/extensión, rama de procesamiento visual
  - ProcessDriveFileInput: nuevo campo `mimeType` opcional
- Feature: soporte para empleados de consorcio como tipo de proveedor
  - Nuevo enum `ProviderType` (PROVEEDOR / EMPLEADO) en tabla Provider
  - Sync-directory lee columna TIPO de hoja `_Proveedores` (5ta columna)
  - Nuevo prompt `buildReciboHaberesPrompt` para recibos de haberes
  - Router `isReciboHaberes()` detecta recibos por keywords antes del router LSP
  - UI: badge `[EMPLEADO]` en select de proveedores, etiqueta CUIL/CUIT según tipo
  - `amount` extrae NETO A COBRAR en recibos de haberes
  - Migración: `20260415000100_add_provider_type`

---

## [Unreleased] - 2026-04-14

### Added
- Feature: fallback visual con Gemini Vision para facturas donde el CUIT del emisor está en imagen. Se activa SOLO como último recurso cuando el proveedor no fue encontrado por CUIT ni nombre y hasEmitterBlock=false.

---

## [Unreleased] - 2026-04-09

### Added
- Feature: toggle "Modo Debug" por cliente en panel admin. Activa logs detallados de OCR e IA en el pipeline para diagnóstico
- Script `export-logs.ps1` para exportar logs de Docker a archivos locales con fecha
- Configuración de rotación de logs en docker-compose.yml (json-file, 50MB x 10)
- Lock de archivo vía carpeta "Procesando" en Drive: tras descargar, el pipeline mueve el archivo a la carpeta `processing` configurada en `driveFoldersJson.processing` (opcional). Si otro ciclo concurrente escanea Pendientes no lo vuelve a tomar. Los movimientos finales (Escaneados / Sin Asignar / Fallidos) usan Procesando como origen cuando el lock está activo.

### Fixed
- Fix buildInvoicePrompt: regla consortium reforzada para evitar confusión emisor/receptor en facturas donde ambos bloques tienen etiquetas similares
- Fix sync-directory: providerId se resuelve automáticamente al sincronizar LspServices (campo providerName texto se mantiene, providerId es complementario)
- Rename `LspService.provider` → `providerName` (claridad vs providerId FK)
- Fix LSP lookup: mapa router→canonicalName resuelve mismatch PERSONAL/TELECOM ARGENTINA S.A.
- Fix LSP fast path: providerId y providerTaxId ahora se asignan correctamente en Invoices de boletas LSP
- Fix race condition entre ciclos concurrentes (manual + scheduler) que causaba doble procesamiento del mismo archivo
- Fix sync-directory: timeout de transacción Prisma aumentado a 120s para evitar expiración con lotes grandes de proveedores/consorcios

### Changed
- Fix clientNumber LSP: normalización extendida elimina espacios internos antes del lookup (resuelve lspServiceId NULL en facturas Edenor y similares)
- Boletas LSP con clientNumber no registrado en LspService ahora van a Sin Asignar en lugar de procesarse sin vínculo
- Rename `Consortium.banco` → `bank`, `claveSuterh` → `suterhKey` (convención camelCase inglés)

---

## [Unreleased] - 2026-04-07

### Added
- Columna "ESTADO PAGO" en Google Sheets (columna N), valor inicial "Sin pagar" al insertar boleta
- Campos `banco` y `claveSuterh` en modelo Consortium
- Columna "BANCO" en Google Sheets (columna O)

---

## [Unreleased] - 2026-04-04

### Changed
- Layout refactorizado a 3 columnas independientes: navSidebar | lista consorcios | contenido
- Edicion de matchNames movida a modal de configuracion (boton "Configuracion" en detailActions)
- Boton "Cerrar sesion" reubicado al fondo del navSidebar con spacer flex

### Fixed
- Sidebar de navegacion y lista de consorcios unificados en columna izquierda unica
- Boletas del periodo ahora se renderizan correctamente en la tabla
- Monto total del periodo corregido (suma en lugar de concatenacion de Decimals)
- Boletas LSP integradas en tabla principal con badge identificador
- Toggle dark/light ahora aplica el tema correctamente al documento
- Fix build CSS Modules: variables de tema movidas a globals.css

---

## [Unreleased] - 2026-04-02

### Added
- Sistema de pagos parciales: tabla `Payment` con soporte para cuotas pactadas y pagos libres
- Campos `isPaid` y `remainingBalance` en Invoice
- Endpoints GET/POST `/api/client/invoices/[id]/payments` y DELETE `.../[paymentId]`

### Removed
- Campos `receiptDriveFileId` y `receiptDriveFileUrl` de Invoice (reemplazados por `Payment.driveFileId`/`driveFileUrl`)

---

## 2026-04-02

Highlights
- **Tunnel estabilizado**: versión fija 2025.2.0, --no-autoupdate, --url http://web:3000.
- **Zona horaria corregida**: logs ahora muestran hora UTC-3 Buenos Aires.
- **Mejoras de logging**: separadores visuales entre archivos, ciclos del scheduler y jobs del worker. Log de archivos encontrados vs límite de lote.
- **Fix scheduler requeue**: jobs COMPLETED/FAILED no bloquean reprocesamiento. Filtro status: { in: ["PENDING", "PROCESSING"] } en existingJob.
- **Feature Reprocesar Sin Asignar**: botón ♻️ en sidebar del panel cliente. Endpoints GET /api/client/unassigned/preview y POST /api/client/unassigned/requeue.
- **OCR híbrido**: detección semántica del bloque emisor AFIP + pdftoppm/Tesseract para PDFs con imagen. Reemplazado pdfjs-dist por pdftoppm. poppler-utils en Dockerfile.
- **CUITs alternativos de consorcio**: pipeline verifica CUITs en matchNames. Permite múltiples CUITs por consorcio sin cambios de schema.
- **Sync-directory optimizado**: upsert de Proveedores con constraint único @@unique([clientId, canonicalName]). Logs de timing por etapa. Migración: 20260402000100_provider_unique_client_canonical.

## 2026-03-30

Highlights
- **UI de edición de matchNames por consorcio**: nuevo campo editable en la vista de detalle para configurar nombres alternativos de matching interno. Endpoint `PATCH /api/client/consortiums/[id]` con soporte para `matchNames`.
- **UI de gestión de LspServices por consorcio**: nueva sección "Servicios públicos (LSP)" con tabla de servicios existentes, formulario inline para agregar (dropdown de 8 proveedores, nro. cliente normalizado, descripción), y eliminación con confirmación inline. Endpoints `GET/POST /api/client/consortiums/[id]/lsp-services` y `DELETE .../[lspId]`.
- **Mejora extracción allTaxIds**: DNI con 11 dígitos ahora se incluye en allTaxIds como CUIT mal etiquetado. Ingresos Brutos agregado como señal del CUIT del emisor. CAE y comprobante explícitamente excluidos. Formato normalizado con guiones.
- **Mejora buildInvoicePrompt**: descripción estructural del layout AFIP para distinguir bloque emisor vs receptor. providerTaxId puede ser null sin romper el CUIT-first matching.
- **Fix scheduler requeue**: el scheduler ahora ignora jobs COMPLETED/FAILED al decidir si encolar un archivo. Permite reprocesar archivos que volvieron a Pendientes desde Sin Asignar u otros flujos.
- **Mejora OCR fallback**: el extractor de texto ahora activa Tesseract OCR cuando pdf-parse produce texto sin CUITs detectables, no solo cuando está vacío. Los textos de pdf-parse y OCR se combinan para maximizar la información disponible para la IA.
- **Feature Reprocesar Sin Asignar**: botón "♻️ Sin Asignar" en sidebar del panel cliente. Lista archivos en carpeta Sin Asignar y los mueve a Pendientes con un click. El scheduler los procesa en el próximo ciclo automáticamente. Endpoints: `GET /api/client/unassigned/preview`, `POST /api/client/unassigned/requeue`.

## 2026-03-28

Highlights
- **Manual de usuario creado** (`docs/manual-usuario.md`): documentación completa para usuarios finales no técnicos. Cubre acceso al sistema, panel principal, configuración inicial, archivo ALTA (con ejemplos de tablas para cada hoja), sincronización de directorio, procesamiento automático de boletas, resolución de boletas sin asignar, cierre de período, recibos de pago, y avisos importantes.

## 2026-03-27 (sesión 20)

Highlights
- **Intervalo del scheduler configurable por cliente (`intervalMinutes`)**: nuevo campo en Client con default 60 minutos. Configurable desde el panel admin (1-1440 min). El scheduler respeta el intervalo individual de cada cliente sin necesidad de tocar `.env` ni hacer rebuild. Migración: `20260327000200_add_interval_minutes`.

## 2026-03-27 (sesión 19)

Highlights
- **Boletas sin asignar ya no se guardan en DB**: el bloque `assignment.unassigned` del pipeline ahora solo mueve el archivo a Sin Asignar en Drive, sin crear Invoice en la DB ni persistir el hash. La DB queda limpia con solo boletas efectivamente asignadas.

## 2026-03-27 (sesión 18)

Highlights
- **Sync-directory refactorizado**: transacción única dividida en 5 transacciones independientes por entidad (Rubros, Coeficientes, Consorcios+Períodos, Proveedores, LspServices). Cada una con timeout de 30s. Resuelve "Transaction not found" con datasets grandes.

## 2026-03-27 (sesión 16)

Highlights
- **Prompt facturas normales**: aclaración sobre trampa CUIT emisor vs receptor en facturas B/C donde el CUIT del receptor tiene etiqueta prominente y el del emisor está en el encabezado sin etiqueta explícita.

## 2026-03-27 (sesión 15)

Highlights
- **LSP_LATERAL_CUIT_RULES**: nueva constante compartida para indicar a la IA que el CUIT aparece en el margen lateral izquierdo rotado/vertical. Incluida en prompts de Edesur y Edenor.

## 2026-03-27 (sesión 14)

Highlights
- **Prompt Edesur**: aclaración sobre ubicación del CUIT en margen lateral izquierdo (rotado/vertical) para mejorar extracción IA.

## 2026-03-27 (sesión 13)

Highlights
- **Proveedor LSP resuelto por CUIT desde tabla Provider**: eliminados CUITs hardcodeados de todos los prompts LSP. El pipeline busca el proveedor por CUIT en `allTaxIds` contra la tabla Provider y usa el nombre canónico de la DB. LspService ahora tiene `providerId` FK a Provider. Lookup de LspService: primero por providerId, luego fallback a campo texto. Si el proveedor no está en DB → fallback al nombre del router + warning.
- **Migración pendiente**: `20260327000100_lspservice_add_provider_fk` — agregar `providerId` FK nullable a LspService.
- **Sync-directory mejorado**: resuelve `providerId` al sincronizar `_LspServices` buscando por nombre canónico en Provider.

## 2026-03-26 (sesión 12)

Highlights
- **Normalización de clientNumber para LspService**: el pipeline ahora normaliza `clientNumber` eliminando ceros a la izquierda antes del lookup de LspService (`00366037` → `366037`). Sync-directory también normaliza al guardar desde Sheets.

## 2026-03-26 (sesión 11)

Highlights
- **CUIT como identificador primario en matching**: nuevo campo `allTaxIds` en la extracción IA — la IA extrae todos los CUITs del documento sin clasificarlos. El pipeline ahora busca por CUIT primero en consorcio y proveedor antes de caer al matching por nombre. Excluye automáticamente el CUIT del consorcio al buscar proveedor. Backward-compatible con extracciones viejas.
- **Logger mejorado**: `extractionResult` muestra los CUITs extraídos. Nuevos métodos `consortiumMatchedByCuit` y `providerMatchedByCuit`.

## 2026-03-26 (sesión 10)

Highlights
- **Razón social en nombre de proveedor**: nueva constante `PROVIDER_NAME_RULES` que instruye a la IA a conservar la razón social (S.R.L., S.A., S.A.S., etc.) en el campo `provider`. Incluida en los 7 prompts de extracción. Sin cambios en matching ni normalización.

## 2026-03-26 (sesión 9)

Highlights
- **Validación en producción**: Deploy Docker completo funcionando (Docker Desktop + Cloudflare Tunnel + dominio propio). Los 3 servicios (web, scheduler, worker) operativos.
- **Prompts LSP validados**: Edesur y AySA probados con PDFs reales en producción. Extracción correcta.
- **Aclaración de flujo matchNames**: los matchNames de consorcios y proveedores se cargan y editan desde las hojas `_Consorcios` y `_Proveedores` del archivo ALTA en Google Sheets, y se sincronizan a la DB desde el panel. No requiere UI adicional.
- **Procedimiento de deploy documentado**: deploy estándar con `docker compose up --build -d` y procedimiento completo para migraciones de DB (down → migrate deploy → generate → up --build -d).
- **Límite de PDFs por lote (batchSize)**: nuevo campo `batchSize` en Client (default 10). Scheduler limita PDFs encolados por ciclo. Configurable desde el panel admin (campo "Tamaño de lote" en edición de cliente).
- **Registro de tokens por factura**: nuevos campos en Invoice (`tokensInput`, `tokensOutput`, `tokensTotal`, `aiProvider`, `aiModel`). Pipeline guarda tokens consumidos por cada extracción IA.
- **Página admin Invoices**: nueva ruta `/admin/invoices` (solo ADMIN) con tabla paginada de todas las invoices, filtro por cliente, y columnas de tokens/IA. Endpoint `GET /api/admin/invoices`.
- Migración: `20260326000100_add_batch_size_and_invoice_tokens`.

## 2026-03-24 (sesión 8)

Highlights
- **Purga completa de boletas por cliente (Admin)**: botón "Purgar" en la tabla de métricas del panel admin con modal de 3 pasos (preview → confirmación → resultado).
- **Endpoint GET /api/admin/clients/[id]/purge**: preview que retorna cantidad de boletas del cliente.
- **Endpoint DELETE /api/admin/clients/[id]/purge**: ejecuta purga completa — mueve archivos de Drive a pendientes, limpia Sheets (fila 2+), borra Invoices y ProcessingJobs de DB.
- **Tolerancia a fallos**: si Drive o Sheets fallan, loguea warning y continúa. El borrado de DB se ejecuta siempre.
- **Tracking de tokens con desglose input/output por provider y modelo**: `TokenUsageSummary.byProvider` y `byModel` ahora son `Record<string, TokenUsageBreakdown>` con `inputTokens`, `outputTokens`, `totalTokens`. Persistencia, carga y UI actualizados. Compatible hacia atrás con registros viejos (ceros se suman como 0).

## 2026-03-24 (sesión 7)

Highlights
- **Sidebar colapsable + menú hamburguesa**: panel cliente con sidebar de navegación global (Sincronizar directorio, Consorcios, Cerrar Periodo General, Cerrar sesión). Colapsable en desktop (solo iconos), menú hamburguesa en tablet/mobile.
- **Toggle dark/light con iconos**: reemplazado el botón de texto por switch tipo interruptor con iconos sol/luna. Estado solo de sesión (no persiste).
- **Toolbar superior**: Pausar scheduler / Ejecutar ahora a la izquierda, toggle de tema a la derecha.
- **Cerrar Periodo General**: botón solo visible para rol CLIENT. Modal de 2 pasos: preview con lista de consorcios a cerrar/saltear, luego resultado.
- **Endpoints nuevos**: `GET /api/client/periods/close-all/preview` y `POST /api/client/periods/close-all` con lógica de mes mayoritario.
- **Período por defecto mejorado**: al crear consorcio (manual, import Excel, sync-directory) usa el mes mayoritario entre los períodos activos existentes del cliente.
- **Sync-directory crea períodos**: los consorcios nuevos creados via archivo ALTA ahora reciben período activo automáticamente.

## 2026-03-23 (sesión 6)

Highlights
- **Asignación automática de período a invoices**: el pipeline ahora busca el período ACTIVE del consorcio matcheado y asigna `periodId` al Invoice en DB.
- **Nueva columna `period` en Google Sheets**: formato `MM/YYYY` en posición M (columna nueva al final, sin mover las existentes).
- **Invoices manuales**: también incluyen el período en Sheets al ser creados desde la UI.

## 2026-03-23 (sesión 5)

Highlights
- **Nuevo campo `consortiumsEnabled`**: booleano en Client (default false) para habilitar/deshabilitar la feature de consorcios por cliente.
- **Toggle Premium en panel admin**: columna "Premium" con toggle ON/OFF optimista en la tabla de métricas por cliente. Reemplaza la columna ClientId.
- **Botón Consorcios condicionado**: en el panel CLIENT, el botón "Consorcios" se deshabilita con badge "Premium" si `consortiumsEnabled` es false.
- **Guard en página Consorcios**: la página `/admin/consortiums` verifica `consortiumsEnabled` via `/api/auth/me` y redirige al panel si no está habilitado.
- **Endpoint `/api/auth/me` ampliado**: ahora retorna `consortiumsEnabled` en el user.
- **Endpoint `/api/admin/clients/[id]` ampliado**: GET retorna y PATCH acepta `consortiumsEnabled`.
- **Endpoint `/api/admin/audit/clients` ampliado**: retorna `consortiumsEnabled` por cliente.
- Migración: `20260323000300_add_consortiums_enabled`.

## 2026-03-23 (sesión 4)

Highlights
- **Nuevo modelo LspService**: tabla para registrar servicios de empresas públicas por consorcio (provider + clientNumber + description). Permite lookup automático en el pipeline.
- **Nuevo enum PaymentMethod**: DEBITO_AUTOMATICO, TRANSFERENCIA, EFECTIVO. Campo nullable en Invoice.
- **Campos lspServiceId y paymentMethod en Invoice**: FK nullable a LspService y método de pago detectado por IA.
- **Prompts LSP actualizados**: todos los prompts LSP ahora extraen `clientNumber` y `paymentMethod` con reglas específicas por empresa.
- **Nuevo prompt buildPersonalPrompt**: soporte para facturas de Personal/Telecom Argentina (CUIT 30-63945373-8, keywords PERSONAL/TELECOM en router).
- **Extracción limitada a página 1 para LSP**: reduce ruido en la extracción IA re-extrayendo solo la primera página cuando se detecta un documento LSP.
- **Lookup LspService en pipeline**: después de extraer clientNumber, busca en la tabla LspService para vincular la factura al servicio correspondiente.
- **Nueva columna NRO CLIENTE en Sheets**: columna J con el número de cliente extraído. Las columnas URL_ARCHIVO e ES_DUPLICADO se desplazaron a K y L.
- **Hoja _LspServices en archivo ALTA**: nueva hoja con 4 columnas (NOMBRE CANÓNICO, PROVEEDOR, NRO CLIENTE, DESCRIPCIÓN) sincronizada con reemplazo total.
- **Eliminación de isAutoCreated**: campo removido de Provider y Consortium (ya no existía en el schema actual).
- Migración: `20260323000200_add_lspservice_paymentmethod`.

## 2026-03-23 (sesión 3)

Highlights
- **Auditoría completa pre-producción Docker**: revisión de dependencias, build, variables de entorno, migraciones y Docker setup.
- **Optimización docker-compose**: eliminado triple build redundante. Solo `web` tiene `build:`, los 3 servicios comparten `image: drive-doc-processor:latest`.
- **`.env.example` mejorado**: agregada `GOOGLE_CREDENTIALS_ENCRYPTION_KEY`, comentarios descriptivos, variables agrupadas por categoría.
- **Smoke test del pipeline**: verificación completa de los 10 pasos del pipeline, router LSP, normalización de consorcios, sync-directory. Todo coincide con la documentación.
- **Resultados de auditoría**: TypeScript 0 errores, ESLint 0 errores (8 warnings menores), `build:jobs` OK, 14 migraciones aplicadas (schema up to date).
- **README.md creado** para GitHub con descripción del proyecto, arquitectura, setup Docker, y desarrollo local.
- **Renombrado `alias`/`aliases` → `matchNames` + nuevo campo `paymentAlias`** en Provider y Consortium.
  - `matchNames`: campo interno para matching de PDFs (separado por `|`), no visible en UI.
  - `paymentAlias`: alias visible en UI y en columna "ALIAS" de Google Sheets.
  - Pipeline: columna ALIAS de Sheets ahora escribe `provider.paymentAlias` (vacío si no tiene).
  - Sync ALTA: hojas ampliadas a 4 columnas (NOMBRE CANÓNICO, CUIT, NOMBRES ALTERNATIVOS, ALIAS).
  - Import Excel: nueva columna "Alias de pago" en ambas hojas.
  - Migración: `20260323000100_rename_alias_to_matchnames_add_paymentalias`.

## 2026-03-21 (sesión 2)

Highlights
- **Dockerización completa**: Dockerfile multi-stage con Next.js standalone output, 3 servicios separados (web, scheduler, worker).
- **docker-compose.yml** reescrito: web con healthcheck, scheduler y worker como servicios independientes, Cloudflare Tunnel integrado.
- **Path aliases resueltos**: `tsc-alias` como post-procesador para que `dist/` use paths relativos en vez de `@/`.
- **tsconfig.jobs.json** arreglado: excluye `useAuthGuard.ts` (DOM) y shim para `CanvasRenderingContext2D`.
- **ESLint** configurado con `typescript-eslint` + `@next/eslint-plugin-next`. 0 errores, 8 warnings.
- **GitHub Actions CI/CD**: workflow con 3 jobs (check → build → deploy a self-hosted runner).
- **Scripts nuevos**: `build:jobs`, `lint`, `typecheck`, `check` (pipeline completo pre-deploy).
- **Fixes de build**: encoding UTF-8 en `close-period/route.ts`, async params en `receipt/route.ts`, creado `clientAuth.ts` faltante, type cast en `scan/route.ts`.

## 2026-03-21

Highlights
- Refactorización completa de `extraction.ts`: nuevo router `identifyLSPProvider()` que detecta la empresa de servicios y despacha a un prompt específico.
- Prompts dedicados para: Edesur (`buildEdesurPrompt`), Edenor (`buildEdenorPrompt`), AySA (`buildAysaPrompt`), Metrogas/Naturgy/Camuzzi/Litoral Gas (`buildGasPrompt`), y genérico LSP (`buildGenericUtilityBillPrompt`).
- CUIT de cada empresa hardcodeado en su prompt → resuelve confusión entre CUIT del proveedor y del consorcio.
- Reglas de dueDate específicas por empresa → resuelve extracción errónea de fecha CESP/CAE como fecha de pago.
- Reglas de dirección unificadas en `CONSORTIUM_ADDRESS_RULES` con instrucciones de limpiar ceros, sufijos, CP, piso.
- `consortiumNormalizer.ts` mejorado: nuevas funciones `stripLeadingZeros`, `stripTrailingNumericSuffix`, `stripPostalAndLocality`, `stripFloorUnit`.
- Fuzzy match ahora limpia ceros a la izquierda en ambos lados antes de comparar tokens.
- Alias match soporta fuzzy inverso (OCR → alias además de alias → OCR).
- Nuevas abreviaturas de calles: SGTO→SARGENTO, CTE→COMANDANTE, INT→INTENDENTE, PROF→PROFESOR.
- Nuevo módulo `src/lib/logger.ts` — sistema de logging centralizado con timestamps, emojis, separadores visuales y logs estructurados por proceso (scheduler, worker, pipeline, run-cycle).
- Scheduler ahora muestra: inicio de ciclo con cantidad de clientes, estado por cliente (pausado/escaneando/sin PDFs/jobs encolados), fin de ciclo, y errores detallados.
- Worker ahora muestra: job reclamado con nombre de archivo y cliente, duración del job, reintentos y fallas permanentes.
- Pipeline ahora muestra: cada paso del procesamiento (descarga, hash, extracción IA, matching, canonización, destino), tipo de LSP detectado, resultado de cada match (método + nombre canónico), y resumen del lote.
- Establecida regla obligatoria de documentación: `docs/progreso.md`, `docs/decisiones.md` y `CHANGELOG.md` deben actualizarse con cada cambio significativo.
- Actualizado CLAUDE.md con sección de router LSP, tabla de prompts por empresa, y regla de documentación.
- Inicializado `docs/decisiones.md` con las primeras decisiones técnicas documentadas.
- Actualizado `docs/progreso.md` al estado actual.

## 2026-03-20

Highlights
- Implementada feature de sincronización de directorio desde archivo Google Sheets ALTA (Sheets → DB).
- Nuevo endpoint `POST /api/client/sync-directory`: lee 4 hojas del archivo ALTA y upserta Consorcios, Proveedores, Rubros y Coeficientes en DB.
- Auto-creación de hojas `_Consorcios`, `_Proveedores`, `_Rubros`, `_Coeficientes` con encabezados si no existen.
- Tablas Rubro y Coeficiente movidas a nivel cliente (no por consorcio).
- Nuevo campo `lastDirectorySyncAt` en `SchedulerState` para registrar la última sincronización.
- Nuevo campo `altaSheetsId` en `googleConfigJson` del cliente para apuntar al archivo ALTA separado.
- UI: botón "Sincronizar directorio" en el panel admin (solo rol CLIENT).
- UI: badge "Última sync directorio" en card de estado del panel.
- UI: botón "Editar" por cliente en tabla de métricas → nueva página `/admin/clients/[id]`.
- Nueva página de edición de configuración de cliente (`/admin/clients/[id]`) con secciones: General, Sheets, Drive, Credenciales Google, Claves IA.
- Nuevo endpoint `GET /PATCH /api/admin/clients/[id]` — campos sensibles enmascarados en GET, encriptados en PATCH.
- CRUD endpoints para Rubros (`/api/client/rubros`) y Coeficientes (`/api/client/coeficientes`).
- Comando `npm run local` como atajo para levantar los 3 procesos con PowerShell.
- Migración `20260320000100_rubro_coeficiente_to_client_level` (pendiente de aplicar).
- Resuelto bug: private key encriptada pasada directamente a GoogleSheetsService → usar siempre `resolveGoogleConfig(client)`.

## 2026-03-16

Highlights
- Added ProcessingJob queue with dedicated worker/scheduler split and env loading helpers.
- Added consortium/provider/period models with normalization, auto-period creation and client endpoints.
- Updated docs/scripts for local run and docker workflow.

PRs
- https://github.com/johnydeev/drive-doc-processor/commit/101fac2553d13c431fcb671d2986a2a358e48991
- https://github.com/johnydeev/drive-doc-processor/commit/6f9359fd15c858bc5be9e8939fcd665d77ed2acf
- https://github.com/johnydeev/drive-doc-processor/commit/73f88a42944cc6eff18b1535a3ea2f64c331c87d

## 2026-03-12

Highlights
- Added VIEWER role to ClientRole and updated related admin/scheduler logic.
- Updated PDF parsing method in PdfTextExtractorService.
- Removed unused Invoice model fields and adjusted business key/repository logic.

PRs
- https://github.com/johnydeev/drive-doc-processor/commit/abf01f8
- https://github.com/johnydeev/drive-doc-processor/commit/17a3b0d
- https://github.com/johnydeev/drive-doc-processor/commit/b44534b
