# Spec: Hardening de seguridad + robustez batch + pasada de docs

**Fecha:** 2026-07-15
**Estado:** aprobado por el owner (diseño validado en sesión)
**Origen:** análisis profundo de lógica de negocio (seguridad, consistencia de docs,
arquitectura/performance) de la sesión 44. Cubre los ítems 1-4 y 6 del informe.
**Fuera de alcance:** job en background para operaciones batch (ítem 5 del informe) —
queda anotado como pendiente con spec propio futuro.

Sin migración de DB. Sin commits (los hace el owner → deploy automático a producción).

---

## 1. `bulk-delete` robusto ante el timeout de 100s del túnel Cloudflare

### Problema
`POST /api/client/invoices/bulk-delete` acepta hasta **200** boletas y por cada una hace
secuencialmente: `getFileParents` + `moveFileToFolder` (+ `trashFile` si hay recibo) +
`deleteInvoiceRow` (que **re-lee la hoja entera** vía `findInvoiceRow`) + transacción DB.
Con la medición de prod de bulk-move (~8.5s/boleta, dominada por Drive), un lote grande
supera con seguridad los 100s del túnel → 524. Es el mismo patrón que causó los incidentes
de `close-all` (2026-07-12) y `bulk-move-period` (2026-07-13).

### Cambios
1. **Tope `.max(10)`** en el `bodySchema` del endpoint (consistente con bulk-move; la misma
   medición aplica porque el costo está dominado por Drive).
2. **Sheets: 1 lectura por lote.** `deleteOneInvoice` deja de llamar `deleteInvoiceRow`
   (lectura full de la hoja por boleta) y pasa a operar contra un **`SheetRowIndex`**
   cargado una sola vez por lote con el `loadRowIndex` existente. La búsqueda usa
   `findRowInIndex` (ya existe, puro).
   - **Compensación de filas:** al borrar una fila, todas las filas siguientes suben una
     posición. Nueva función pura **`adjustIndexAfterDelete(index, deletedRowNumber)`** en
     `googleSheets.service.ts` que decrementa en 1 los rowNumbers mayores al borrado.
     Se aplica sobre el índice del lote después de cada borrado exitoso. Testeable sin red.
   - El servicio de Sheets expone un método de borrado por fila explícita
     (`deleteRowAtNumber` o equivalente) que reutiliza la llamada `batchUpdate` actual de
     `deleteInvoiceRow`; `deleteInvoiceRow` puede quedar como wrapper para otros usos o
     eliminarse si queda huérfano.
3. **`resolveDeletionContext` / contrato de `InvoiceDeletionContext`:** el contexto pasa a
   incluir (o permitir inyectar) el `SheetRowIndex` del lote. El borrado individual
   (`deleteInvoiceById`, usado por el detalle de consorcio) carga un índice de un solo uso —
   mismo camino de código, sin rama especial.
4. **UI `/admin/boletas`:** replicar el patrón de bulk-move — si hay más de 10 boletas
   seleccionadas para borrar, avisar que se procesan de a 10 por tanda (validación en UI +
   guardrail en server).

### Criterio de éxito
- Borrar N≤10 boletas hace **1 sola lectura** de la hoja (verificable por test unitario del
  flujo con mocks: contar llamadas de lectura).
- Un lote de 10 entra holgado bajo los 100s.
- Reintentar un lote parcialmente borrado es seguro (las ya borradas devuelven 404 y se
  reportan como fallidas sin abortar el resto — comportamiento actual que se preserva).

---

## 2. Revocación de sesión: `isActive` re-verificado con cache de 60s

### Problema
El JWT dura 24h y ningún endpoint de API re-verifica `isActive` ni rol contra la DB (solo
`/api/auth/me`, que protege únicamente la UI). Un cliente desactivado —o con rol
degradado— retiene acceso completo a la API hasta que expire el token.

### Cambios
1. **Módulo nuevo `src/lib/sessionRevocation.ts`:**
   - Lógica pura testeable: cache en memoria (`Map<clientId, { isActive, role, fetchedAt }>`)
     con TTL de **60 segundos**, inyectable el reloj (`now()`) para tests.
   - `resolveSessionValidity(clientId)`: si hay entrada fresca en cache la usa; si no,
     consulta `Client` (`select { isActive, role }`) y cachea. Cliente inexistente o
     `isActive === false` → inválido.
2. **`requireAuthenticatedSession` pasa a ser `async`:** tras validar el JWT llama a
   `resolveSessionValidity`. Si es inválido → 401. Si el **rol actual en DB** difiere del
   token, la sesión usa el rol de la DB (un downgrade también aplica en ≤60s).
3. **Propagación async:** `requireClientSession`, `requireAdminSession`, `withAuth` y
   `withClientAuth` se vuelven async-aware; las rutas dinámicas que llaman los guards
   directamente agregan `await`. Cambio mecánico (~20 archivos), sin cambio de
   comportamiento para sesiones válidas.
4. **Fallo de DB en el chequeo:** si la consulta falla (blip del pooler), se usa la entrada
   de cache aunque esté vencida; si no hay ninguna, se rechaza con 401 (fail-closed pero
   tolerante a blips para sesiones ya vistas).
5. Worker y scheduler no se tocan (no usan sesiones; el worker ya filtra `isActive`).

### Notas
- El cache es por proceso. Producción corre **1 solo contenedor web** → no hay problema de
  coherencia entre instancias. Si algún día se escala horizontal, revisar (anotarlo en el
  propio módulo).
- Costo: máx. 1 query por cliente por minuto — despreciable.

### Criterio de éxito
- Desactivar un cliente corta su acceso a la API en ≤60s (test unitario con reloj mockeado).
- Sesiones válidas: cero queries extra dentro de la ventana de cache.

---

## 3. Hardening menor

### 3.1 `apiError` sanitizado (fuga de detalles internos)
Regla que **preserva todos los call sites existentes** de `apiHandler.ts`:
- `ZodError` → 400 con mensajes de validación (sin cambio).
- Status efectivo **< 500** (error de negocio pasado a propósito con status explícito) →
  mensaje visible (sin cambio).
- Status efectivo **500** (error inesperado) → en producción responde `"Error interno"` y
  loguea el mensaje real + stack server-side; en desarrollo (`NODE_ENV !== "production"`)
  muestra el mensaje real.

### 3.2 Comparación de firma JWT constant-time
`verifySessionToken` (`src/lib/authSession.ts`): reemplazar `signature !== expected` por
`timingSafeEqual` sobre Buffers con guard previo de longitudes distintas (que retorna
inválido sin comparar).

### 3.3 Login sin enumeración de usuarios
`POST /api/auth/login`:
- Usuario inactivo → misma respuesta que credenciales inválidas: `"Invalid credentials"`
  con **401** (hoy: `"User is inactive"` con 403, que confirma la existencia del email).
  El motivo real se loguea server-side.
- El `catch` no-Zod deja de devolver `error.message` con 400 → genérico 500 (`"Error
  interno"` en producción, mensaje real en desarrollo), alineado con 3.1.

---

## 4. Test de guard de auth en rutas API

### Problema
El guard de auth es opt-in por ruta (el middleware solo cubre páginas `/admin`). Una ruta
API nueva que olvide el wrapper queda pública en silencio.

### Cambio
Test nuevo `src/app/api/routeAuthGuard.test.ts`:
- Recorre `src/app/api/**/route.ts` (glob sobre el filesystem, sin ejecutar rutas).
- Falla si algún archivo exporta un handler HTTP (`GET`/`POST`/`PATCH`/`PUT`/`DELETE`) y su
  contenido no referencia `withAuth`, `withClientAuth`, `requireClientSession`,
  `requireAdminSession` ni `requireAuthenticatedSession`.
- **Allowlist explícita** (rutas públicas intencionales): `auth/login`, `auth/logout`,
  `auth/register`, `health`, `openapi`.
- Es un chequeo estático por contenido: suficiente para atrapar el olvido; un falso
  negativo elaborado (importar el guard sin usarlo) no es el escenario que se defiende.

---

## 5. Pasada de docs (código ↔ documentación)

### 5.1 CLAUDE.md
1. **Cadena de IA:** documentar la real — `Cerebras → Gemini → OpenAI → Claude` (Groq
   soportado por `createAiExtractionChain` pero fuera de la cadena de producción desde
   2026-06-25). Corregir también el docstring desactualizado dentro de
   `src/services/aiExtraction.ts` (dice "Gemini → OpenAI → Claude").
2. **Columnas de Google Sheets:** A–M actuales + N (paymentStatus) + O–U (banco, saldo
   pendiente, monto pagado, cant. cuotas, fecha pago, URL comprobante, medio pago).
3. **Schema:** agregar al diagrama `Payment`, `FixedExpense`, `ExpenseObligation`,
   `ConsortiumProvider` y los enums `PaymentType` / `ObligationStatus` / `ProviderType`.
4. **Matching de proveedor:** actualizar a solo-CUIT (nombre habilitado únicamente para
   sindicales/ARCA vía `allowNameMatch`), vigente desde 2026-07-02.
5. **Estructura de directorios:** agregar `/admin/boletas` y los endpoints `payments`,
   `obligations`, `fixed-expenses`, `bulk-delete`, `bulk-move-period`, `sync-payments`,
   `setup-sheet-protection`.
6. **Pendientes fantasma:** quitar "Agregar URL de recibo a columna de Sheets" y "Columna
   paymentMethod en Sheets" (ya existen: columnas T y U). Agregar como pendiente el job en
   background para operaciones batch.

### 5.2 CHANGELOG.md / progreso.md / decisiones.md
- Entrada por esta sesión (los 5 ítems de este spec).
- Ponerse al día con los commits de UI sin documentar (deuda anotada en memoria:
  `pending-ui-docs-pass`).
- Documentar el cambio pendiente del working tree en `src/app/admin/boletas/page.tsx`
  (desglose de salteadas por motivo en el modal de resultado de bulk-move).

### 5.3 Duplicación de mapping (DRY, oportunista)
`src/app/api/client/invoices/[id]/payments/route.ts` redefine localmente el mapping
completo de columnas que `invoiceDeletion.ts` ya exporta como `DEFAULT_SHEETS_MAPPING`.
Unificar en una sola fuente para que no diverjan al agregar columnas.

---

## Testing y verificación global

- **TDD** para la lógica nueva pura: cache de revocación (TTL, expiración, fallo de DB),
  `adjustIndexAfterDelete`, regla de sanitización de `apiError`, allowlist del test de
  guards.
- Red existente: los **238 tests** deben seguir verdes antes y después.
- Verificación completa: `npm run typecheck` + `npm run lint` + `npx vitest run` +
  `npm run build:jobs` + `npm run build` (por el cambio async en rutas).
- Sin migración. Sin commits (owner). Sin cambios en docker-compose ni env.

## Riesgos

- **Propagación async de los guards:** es el cambio que más archivos toca (~20). Mitigación:
  es mecánico (`await` + firma), typecheck atrapa cualquier olvido (una Promise usada como
  objeto sesión no compila).
- **Índice de Sheets desincronizado si otro proceso escribe la hoja durante el lote:** el
  borrado usa claves de la fila (sourceFileUrl/boletaNumber) resueltas al armar el índice;
  una escritura concurrente del worker podría desplazar filas. Riesgo preexistente (hoy
  también hay ventana entre `findInvoiceRow` y el delete), no se amplía de forma relevante
  con lotes de 10. Aceptado.
