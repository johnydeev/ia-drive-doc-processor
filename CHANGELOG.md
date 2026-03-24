# Changelog

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
