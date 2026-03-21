# Changelog

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
- Establecida regla obligatoria de documentación: `docs/progreso.md`, `docs/decisiones.md` y `CHANGELOG.md` deben actualizarse con cada cambio significativo.
- Actualizado CLAUDE.md con sección de router LSP, tabla de prompts por empresa, y regla de documentación.
- Inicializado `docs/decisiones.md` con las primeras 3 decisiones técnicas documentadas.
- Actualizado `docs/progreso.md` al estado actual (prompts LSP completados, migraciones aplicadas).

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
