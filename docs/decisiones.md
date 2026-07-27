# Decisiones técnicas — drive-doc-processor

Registro de decisiones tomadas ante problemas reales encontrados en producción.

---

## 2026-07-16 — Tanda 2 del refactor: costura fan-out para extraer un dominio acoplado

**Problema:** el "núcleo de detalle" de `consortiums/page.tsx` (cascada selección→períodos→boletas +
obligaciones + cierre) está acoplado con estado que pertenece a otro dominio aún sin extraer (config del
modal de Configuración = Tanda 3): `handleSelectConsortium` reseteaba y recargaba, en una sola función,
estado de detalle, de config y de obligaciones. Extraer el detalle sin arrastrar el estado de Tanda 3 exige
una costura.

**Decisión:** `useConsortiumDetail` expone un callback **`onConsortiumSelected(c, activePeriodId)`** que
`page.tsx` implementa para disparar los resets/fetches del estado que sigue viviendo ahí (config de Tanda 3
+ obligaciones). El hook se adueña solo de su cascada; el fan-out es el único punto de contacto. Es
**temporal y decreciente**: cuando la Tanda 3 extraiga el modal de Configuración a su propio hook, el bloque
de config del callback se reduce a un `config.load(c.id)`. Además, `useClosePeriod` resetea sus mensajes
(`error`/`success`) por **efecto sobre `consortiumId`** en vez de por callback desde el detalle — evita una
dependencia circular (el hook de cierre se crea después del detalle porque depende de su `selectedId`).

**Alternativas descartadas:** que `useConsortiumDetail` se adueñara del estado de config/referencia —
recrea el god-component en versión hook, rompe la frontera, y obliga a sacarle ese estado de nuevo en la
Tanda 3 (churn + riesgo). Hooks granulares para la cascada — la cadena select→periods→invoices habría que
recablearla entre hooks vía callbacks, reintroduciendo el acoplamiento por la puerta de atrás.

**Impacto:** Tanda 2 completa. Nuevos `useConsortiumDetail`/`useObligations`/`useClosePeriod` +
`ClosePeriodModal`; eliminado el hack `handleSelectConsortiumRef`. `page.tsx` 2418→2297 líneas, 79→65
useState, +16 tests. Diferencia benigna documentada: el fan-out corre tras el `await` de períodos (transitorio
~100ms). Spec/plan: `docs/superpowers/{specs,plans}/2026-07-16-refactor-consortiums-tanda2*`.

---

## 2026-07-16 — Refactor de `consortiums/page.tsx`: hooks por dominio + verificación por tiers + infra de tests de UI

**Problema:** `src/app/admin/consortiums/page.tsx` es un god-component de 3105 líneas con **91 `useState`**
en un solo scope y ~9 modales inline. El problema real no son las líneas sino el estado concentrado:
cualquier feature nueva lo engorda y cualquier edición es riesgosa. No tenía tests de UI (Vitest corría
solo en entorno `node`, `*.test.ts`, lógica pura).

**Decisión A — arquitectura de extracción incremental (hooks por dominio):** cada dominio se extrae a
un **hook `useX()`** (encapsula su estado + efectos + handlers, cero JSX; los efectos cross-dominio se
inyectan como callback `onCreated`) + un **componente presentacional** (recibe props explícitas). La
lógica pura va a `lib/*.ts`. `page.tsx` queda como orquestador. Contrato **"mover, no reescribir"** +
verificación por paso atómico (typecheck + lint + build + tests + smoke visual), un commit por paso.

**Alternativas descartadas (A):** Context+Provider central (riesgo de re-render storms, más invasivo,
difícil de extraer incrementalmente sin cambiar comportamiento); `useReducer` por dominio (verboso para
UI con muchos forms, no parte el archivo por sí solo).

**Decisión B — infra de tests de UI (jsdom) con verificación por tiers:** se montó jsdom +
`@testing-library/react`/`user-event`/`jest-dom` y `vitest.config.ts` pasó a `test.projects`: proyecto
`node` para `*.test.ts` (los 299 previos, intactos) y proyecto `jsdom` para `*.test.tsx` (hooks y
componentes). **Split por extensión** para aislar entornos sin tocar los tests existentes. Tiers por ROI:
0 = lógica pura (node), 1 = hooks (`renderHook`), 2 = componentes (`render` + `user-event`); tier 3
(flujos full-page) se omite por frágil y bajo ROI. El **smoke visual** cubre el instante de la extracción
(el test nace post-extracción); el **test** cubre el futuro — es la red que el proyecto no tenía.

**Alternativas descartadas (B):** seguir sin tests de UI (deja hooks y JSX sin red — el mayor riesgo de
un refactor sin comportamiento cambiando); `happy-dom` en vez de jsdom (se eligió jsdom por máxima
compatibilidad/documentación con testing-library; happy-dom es un swap posterior de una línea si molesta
la velocidad). Nota: no existía una decisión formal previa de "no testear React" — era el estado de-facto
del `vitest.config.ts` (entorno node).

**Impacto:** Tanda 1 completa — `page.tsx` 3105 → 2417 líneas (−688); nuevos `lib/`, `hooks/`,
`components/`; `vitest.config.ts` con 2 proyectos + `vitest.setup.ts`; +40 tests (299 → 339). Spec/plan:
`docs/superpowers/{specs,plans}/2026-07-16-refactor-consortiums-page*`. Detalle de tandas pendientes en
`docs/progreso.md`.

---

## 2026-07-15 — Revocación de sesión con cache 60s + bulk-delete a prueba de 524 + hardening

**Problema (hallazgos de un análisis de seguridad/arquitectura de la lógica de negocio):**
1. El JWT dura 24h y ningún endpoint re-verificaba `isActive`/rol contra la DB (solo `/api/auth/me`,
   que protege la UI): un cliente desactivado retenía acceso completo a la API hasta 24h.
2. `bulk-delete` aceptaba 200 boletas con ~5 llamadas externas secuenciales cada una y re-leía la
   hoja entera de Sheets POR boleta — el patrón exacto de los 524 de close-all (2026-07-12) y
   bulk-move (2026-07-13), sin mitigar.
3. `apiError` devolvía `error.message` crudo en los 500 (los errores de Prisma/Google filtran
   nombres de tablas, queries, IDs); el login confirmaba la existencia de emails ("User is
   inactive" 403) y comparaba la firma JWT con `!==` (no constant-time).
4. El guard de auth es opt-in por ruta (el middleware solo cubre páginas `/admin`): una ruta API
   nueva sin wrapper queda pública en silencio.

**Decisiones:**
- **Revocación:** re-chequeo de `isActive`/rol en `requireAuthenticatedSession` vía
  `src/lib/sessionRevocation.ts` — cache en memoria por clientId con TTL **60s**, inyectable para
  tests. Fail-closed (cliente nunca visto + DB caída → 401) pero tolerante a blips (usa el cache
  vencido si la DB falla). El rol se toma de la DB (un downgrade también aplica en ≤60s). Los guards
  pasaron a async (~40 rutas con `await`, cambio mecánico verificado por typecheck).
  *Alternativas descartadas:* query por request sin cache (1 query extra en TODOS los endpoints);
  `sessionVersion` en el token (migración de DB + igual paga la query, más complejidad por lo mismo).
  *Nota:* cache por proceso — válido porque prod corre 1 solo contenedor `web`; anotado en
  CLAUDE.md como punto a revisar si se escala horizontal.
- **bulk-delete:** tope **10** por tanda (mismo criterio medido de bulk-move: ~8.5s/boleta dominado
  por Drive) + **1 lectura de Sheets por lote**: `deleteInvoicesWithIndex` carga `loadRowIndex` una
  vez y `deleteOneInvoice` busca con `findRowInIndex` + borra con `deleteRowAtNumber`. Como
  `deleteDimension` corre las filas hacia arriba, la función pura nueva `adjustIndexAfterDelete`
  (testeada) decrementa los rowNumbers mayores al borrado tras cada delete. El borrado individual
  (`deleteInvoiceById`) usa el mismo camino con un índice de 1 uso — sin rama especial.
  *Riesgo aceptado:* escritura concurrente del worker entre el load del índice y el delete
  (preexistente — la ventana de `findInvoiceRow`→delete ya existía; no se amplía con lotes de 10).
- **Sanitización de errores:** regla que preserva todos los call sites — ZodError → 400 igual;
  status explícito <500 (error de negocio) → mensaje visible igual; **500 → "Error interno" en
  producción** + `console.error` del detalle (en dev se muestra el mensaje real). Mismo criterio en
  el catch del login (que además devolvía 400 para errores de DB → ahora 500).
- **Login:** inactivo → "Invalid credentials" 401 (motivo real al log). Firma JWT →
  `timingSafeEqual` con guard de longitud.
- **Red de regresión:** test `routeAuthGuard.test.ts` que recorre `src/app/api/**/route.ts` y exige
  un guard por contenido, con allowlist explícita de las 5 rutas públicas (login/logout/register/
  health/openapi). Verificado que detecta el negativo (quitar openapi de la allowlist → falla).
- **DRY del mapping:** `DEFAULT_SHEETS_MAPPING` (A–U) estaba copiado **6 veces** idéntico
  (pipeline, invoiceDeletion, pagos ×2, setup-sheet-protection, syncInvoicePayments). Fuente única
  en `clientProcessingConfig.ts` (donde vive `resolveMapping`, que es lo que todos combinan con
  `?? DEFAULT`); `invoiceDeletion` re-exporta para los importadores existentes.

**Impacto:** `sessionRevocation.ts` (+6 tests), `adminAuth.ts`/`clientAuth.ts`/`apiHandler.ts`
(async + sanitización, +4 tests), `authSession.ts`, `login/route.ts`, `googleSheets.service.ts`
(`deleteRowAtNumber` + `adjustIndexAfterDelete`, +2 tests), `invoiceDeletion.ts`
(`deleteInvoicesWithIndex`, +3 tests), `bulk-delete/route.ts`, `boletas/page.tsx`,
`routeAuthGuard.test.ts` (+46 asserts), 6 archivos del mapping, ~40 rutas con `await`. 299 tests.
Sin migración.

---

## 2026-07-13 — bulk-move-period: idempotencia por destino explícito + Sheets 1 lectura/lote

**Problema:** mover ~20 boletas superaba los 100s → 524 de Cloudflare (HTML parseado como JSON en el
front). Además el move no era idempotente (reintentar avanzaba +1 otra vez) y quedaba un riesgo de estado
parcial si el proceso moría a la mitad.

**Decisión:** (1) **Sheets set-based en la lectura**: leer la hoja una vez por lote (`loadRowIndex`) y
escribir celda por celda (`updatePeriodCellAtRow`), en vez de re-leer la hoja entera por boleta. (2)
**Idempotencia por destino explícito**: el execute recibe `targetPeriodId` por boleta; el move "asegura X
en P" y saltea si ya está (`ya_en_destino`), validando destino ACTIVE + mismo consorcio + mes siguiente
(`destino_invalido`). Reintentar la misma lista nunca avanza de más y reconcilia parciales (DB last =
fuente de verdad, pasos idempotentes). (3) **Frontend**: timeout ≠ error crudo → paso "unknown" +
Reintentar. (4) Tope 10 (ver nota de medición abajo). (5) `moveLog` estructurado (paso que falló, duración,
`reverted`).

**Medición en prod (2026-07-13):** un lote de 20 tardó **169s** (~8.5s/boleta) → cruzó los 100s → 524, pero
se movió **completo y consistente** (idempotencia + DB last hicieron su trabajo; sin corrupción, sin crash de
UI). El cuello de botella resultó ser **Drive** (~3 llamadas/boleta a ~1.5-2s), no Sheets — por eso la
optimización de lectura de Sheets ayudó poco. Se bajó el tope a **10** (~85s) para que sea single-shot bajo
100s. Pendiente si el volumen crece: paralelizar Drive (con cuidado de carreras al crear carpetas) o job en
background (opción 3).

**Alternativas descartadas:** cola/worker en background (opción 3) — correcto a largo plazo pero más
trabajo; se dejó anotado. Paralelizar llamadas a Google — riesgo de carreras al crear carpetas.

**Impacto:** `googleSheets.service.ts` (índice `SheetRowIndex`/`findRowInIndex` + `updatePeriodCellAtRow`),
`invoicePeriodMove.ts` (contrato por destino: `moveOneInvoiceToTarget`/`moveInvoicesToTargets` +
`validateTarget`), `logger.ts` (`moveLog`), endpoints `bulk-move-period`, UI `boletas/page.tsx`. Sin
migración.

---

## 2026-07-12 — `close-all`: reescritura set-based + idempotente (fix de 524 / runaway)

**Problema (incidente en producción):** al apretar "Cerrar Periodo General" con **47 consorcios**,
el endpoint `POST /api/client/periods/close-all` recorría los 47 períodos haciendo, por cada uno,
una `$transaction` (cerrar + crear siguiente) **+** `closeObligationsForPeriod` **+**
`generateObligationsForPeriod` — O(N) round-trips secuenciales al pooler de Supabase. Superó los
**100s** → Cloudflare (túnel) cortó con **524** y devolvió su página HTML de error, que el frontend
intentó parsear como JSON (`Unexpected token '<', "<!DOCTYPE"`). Peor: el 524 corta en el edge pero
**el server siguió procesando y commiteando de a uno**, y como el endpoint **no era idempotente**,
los reintentos del usuario empujaron el estado de más (junio→julio→**agosto** en 12→25→35→47
consorcios). Diagnóstico con evidencia: status 524 en consola + consultas a la DB mostrando el
`updatedAt` de los períodos avanzando en vivo mientras se investigaba (**runaway** aún corriendo).

**Contención:** se reinició el contenedor `web` (mata el proceso; cada cierre ya estaba commiteado
en su propia transacción → sin corrupción) y se reparó el estado por SQL (reabrir junio, borrar los
julios/agostos vacíos — 0 boletas / 0 obligaciones verificadas).

**Decisión (fix de raíz):** reescribir `close-all` **set-based e idempotente** en
`src/services/closePeriods.service.ts` (`executeCloseAll`), con la planificación pura extraída a
`src/lib/closeAllPlan.ts` (`planCloseAll`, testeada) y **reusada también por el preview** (antes el
cálculo del mes mayoritario estaba duplicado):
- Una sola transacción: `updateMany` (cerrar los del mes mayoritario, filtrando por `status: ACTIVE`)
  + `createMany({ skipDuplicates: true })` (crear los siguientes). ~4 queries totales (<1s), muy por
  debajo del límite de 100s.
- **Idempotente:** un reintento matchea 0 en el `updateMany` (ya cerrados) y saltea en el `createMany`
  (unique `consortiumId_year_month`) → no-op seguro. Elimina la clase de bug del runaway.
- Obligaciones de gastos fijos ajustadas **set-based y best-effort** (updateMany NOT_RECEIVED con
  avisos por consorcio + createMany de las del período nuevo), sin loop por consorcio.

**Alternativas descartadas:** subir el timeout de Cloudflare (el plan free tope 100s, no configurable);
job en background con polling (YAGNI para una operación que set-based tarda <1s).

**Riesgo gemelo (mitigado):** `bulk-move-period` tiene el mismo patrón O(N) llamadas externas por
request (Drive+Sheets por boleta). Se acotó a **tope de 40 boletas por tanda** (guardrail `.max(40)` en
los endpoints + aviso en la UI; el resto se hace en la siguiente tanda).

**Impacto:** `src/lib/closeAllPlan.ts` (+ test, 7), `src/services/closePeriods.service.ts` (+ test, 2),
`close-all/route.ts` y `close-all/preview/route.ts` (thin, reusan la lógica). Sin migración.

---

## 2026-07-10 — Migración de período: orden Drive → Sheets → DB con compensación

**Problema:** al olvidar cerrar un período, entran boletas que quedan en el mes equivocado. El
workaround era borrar + cerrar período + reprocesar. Se quiere mover las boletas directo, tocando
tres sistemas sin transacción común (Drive, Sheets, DB) sin dejar estados inconsistentes.

**Decisión:** por boleta, ejecutar Drive → Sheets → DB con una pila de compensación (LIFO). La DB va
**última** y es transaccional, así su propio rollback cubre `periodId` + obligaciones sin inversión
manual; las únicas compensaciones son las de los pasos externos (una llamada inversa cada uno). Drive
mueve+renombra en **una sola llamada atómica** (`GoogleDriveService.moveAndRenameFile`). Si algún paso
falla, se revierte lo hecho y la boleta queda como estaba; el lote continúa y se reporta al final (con
`reverted: false` marcado aparte si la propia reversión falla). Sólo se mueve a períodos existentes y
ACTIVE (no se crean períodos ni se cierran: eso es "Cerrar Periodo General"). La subcarpeta de período
creada en Drive no se borra al revertir (es válida e inofensiva; se reutiliza al reintentar).

**Alternativas descartadas:** (a) crear el período destino si falta → rompe la invariante de un solo
período ACTIVE por consorcio (`findActivePeriod`, `resolveMajorityMonth`, tarjetas, close-all);
(b) saga/reintentos distribuidos → YAGNI a esta frecuencia.

**Impacto:** nuevo `src/lib/invoicePeriodMove.ts` (+ `invoicePeriodMove.test.ts`, 13 tests),
`moveAndRenameFile` en `googleDrive.service.ts`, `DEFAULT_SHEETS_MAPPING` exportado de
`invoiceDeletion.ts` (DRY), endpoints `POST /api/client/invoices/bulk-move-period` (+ `/preview`), UI
(botón + modal de 2 pasos) en `admin/boletas/page.tsx`. Reusa `resolveStatementsFolders`,
`buildInvoiceFileName` y `linkInvoiceToObligation`. Sin migración.
Spec/plan: `docs/superpowers/{specs,plans}/2026-07-10-migrar-boleta-periodo*`.

**Ajustes durante la implementación (posteriores al spec/plan):**
- **Tope de 40 por tanda** (el spec/plan decían 200) — ver "Riesgo gemelo" arriba.
- La celda PERIODO en Sheets se escribe con un método dedicado **`updateInvoicePeriodCell`**
  (`valueInputOption: "USER_ENTERED"`), no con `updateInvoicePaymentInfo` (que va en RAW para los
  montos): así Sheets muestra el período con el mismo formato que el resto de la hoja (ej. "julio-2026")
  en vez del literal "07/2026".

---

## 2026-07-09 — `AsyncButton` para feedback de carga (en vez de repetir estado `saving`)

**Problema:** el botón "Agregar gasto fijo" no daba feedback → doble click → alta duplicada. El resto del
panel ya resolvía esto con un estado `saving` por acción (deshabilita + "Guardando…"), pero repetido a
mano en cada botón (boilerplate).

**Decisión:** componente reutilizable `AsyncButton` (patrón DRY) que encapsula el estado de carga: recibe
un `onClick` async, se deshabilita + muestra spinner mientras corre, y **corta el doble click** con un
guard por `ref` (antes de que React re-renderice el `disabled`). En **2 fases**: (1) aplicarlo a los
botones sin feedback (los nuevos de gastos fijos/obligaciones); (2) migrar incrementalmente los que ya
tienen `saving` manual, borrando el boilerplate. Se descartó un overlay/toast global (menos preciso, no
bloquea el botón) y migrar todo de una (refactor grande y riesgoso en un archivo de ~2.900 líneas).

**Fase 2 (misma sesión):** se auditaron TODAS las requests disparadas por botones y se clasificaron en 3
categorías, porque forzar `AsyncButton` en todas rompía coordinación:
- **Standalone / por fila** (borrar boleta/LSP/pago) → `AsyncButton` (elimina los `deleting*Id`).
- **Submit de modal** (crear consorcio/proveedor/boleta, match names, pago, cerrar período, guardar pagos)
  → se extrajo el hook `useAsyncAction` (`{ pending, run }`) y se reemplazó cada `useState(saving)` por
  `const { pending: savingX, run } = useAsyncAction()` (mismo nombre → los hermanos `disabled={savingX}` no
  se tocan). `AsyncButton` pasa a usar el hook por dentro (una sola fuente de la lógica).
- **Sidebar con `busyAction` global** (sincronizar, proteger/desproteger, scheduler, close-all/unassigned)
  → **intacto**: `AsyncButton` (pending por botón) rompería la coordinación "una acción a la vez" entre
  todos los botones del sidebar.

**Impacto:** `src/lib/useAsyncAction.ts` (nuevo), `src/components/AsyncButton.tsx` (usa el hook),
`.asyncSpinner` en `globals.css`, y ~13 botones de `consortiums/page.tsx` migrados (borrando ~7
`useState(saving/deleting)`). Spec: `docs/superpowers/specs/2026-07-09-async-button-feedback-design.md`.
Verificado: typecheck + lint (0 errores) + 204 tests + build:jobs OK.

---

## 2026-07-05 — Gastos fijos + obligaciones de pago (2 modelos, materializado por período)

**Problema/pedido:** el administrador no tiene visibilidad de los gastos que **sí o sí** se pagan cada mes en
cada consorcio (luz, encargado, telefonía). El sistema solo registraba la boleta cuando llegaba; no había forma
de saber, al inicio del período, qué se espera ni de detectar que **faltó** una boleta.

**Decisión (ver spec/plan `2026-07-05-gastos-fijos-obligaciones`):**
- **Dos modelos** en vez de uno: `FixedExpense` (definición recurrente por consorcio, apunta a un `Provider` o un
  `LspService` ya cargado) y `ExpenseObligation` (instancia por período, con `status` y `invoiceId?`). La
  definición se reusa cada mes; la obligación es la instancia materializada.
- **Materializado, no calculado al vuelo:** permite marcar/omitir a mano y llevar historial de cumplimiento.
- **Vinculado a Provider/LspService** (no texto libre): así la boleta entrante se asocia sola por el matching que
  ya usa el pipeline (`obligationMatchesInvoice`: LSP por `lspServiceId`, proveedor por `providerId`).
- **Sin monto esperado:** la obligación solo espera la boleta (el monto lo trae la boleta).
- **Solo panel/DB, no Sheets:** la hoja sigue teniendo solo boletas reales.
- **Estado = "llegó la boleta"** (Pendiente/Recibida/No recibida/Omitida); el pago se lee de la `Invoice`
  vinculada (una obligación puede estar Recibida e impaga).
- **Generación automática** al abrir el período (creación manual + `close-all`) + botón para períodos ya abiertos.
- **Al cerrar:** las `PENDING` pasan a `NOT_RECEIVED` con aviso; no se arrastran (el mes nuevo genera las suyas).

**Alternativas descartadas:** un solo modelo con `periodId` (mezcla definición e instancia); cálculo al vuelo (sin
omitir/historial); etiquetas de texto libre (sin matching automático); monto esperado; placeholders en Sheets.

**Impacto:** enum `ObligationStatus` + tablas `FixedExpense`/`ExpenseObligation` (migración
`20260705000200_add_fixed_expenses`); `src/lib/fixedExpense.ts` (+9 tests); `src/services/obligation.service.ts`
(+2 tests); `consortium.repository`, `close-all` (route + preview), `processPendingDocuments.job` (seam +
`persistStep`), `invoice.repository` (`saveProcessedInvoice` devuelve la Invoice), `invoiceDeletion`; endpoints
`fixed-expenses`/`obligations`; UI (`consortiums/page.tsx`: sección Gastos fijos + pestaña Obligaciones).
Verificado: typecheck + lint (0 errores) + 204 tests + build:jobs OK.

---

## 2026-07-08 — Etiquetas de motivo en el nombre para casos sin asignar

**Problema/pedido:** cuando una boleta no se procesa (no matchea proveedor, consorcio, etc.) va a la
carpeta Sin Asignar **sin ninguna marca**: el operador tiene que abrir cada PDF para saber por qué. Ya
existía `SIN MONTO` (renombrado en `missingAmountGate`); se pidió el mismo tratamiento para el resto.

**Decisión:** renombrar el archivo con una etiqueta de sufijo según `reasonCategory` (que el pipeline
ya calculaba pero no reflejaba en el nombre). 6 etiquetas:

| Etiqueta | `reasonCategory` | Acción que sugiere |
|---|---|---|
| `SIN PROVEEDOR` | `provider_not_found` | no hay CUIT de proveedor extraíble → revisar PDF |
| `PROVEEDOR SIN REGISTRAR` | `provider_not_registered` | hay CUIT de proveedor en el papel, no en DB → alta |
| `SIN CONSORCIO` | `consortium_not_found` | no se extrajo el consorcio → revisar PDF |
| `CONSORCIO SIN REGISTRAR` | `consortium_not_registered` | se leyó el consorcio, no está en DB → alta |
| `SIN PERÍODO` | `no_active_period` | consorcio OK sin período activo → abrir período |
| `LSP SIN REGISTRAR` | `lsp_clientnumber_not_registered` | nº de cliente LSP no cargado → cargar LspService |

**Distinción clave `*_not_found` vs `*_not_registered`** (pedido explícito del owner): no es lo mismo
"no pude identificarlo" que "lo identifiqué pero no está cargado". Para proveedor, el gate mira si hay
un CUIT de proveedor (≠ CUIT del consorcio, 11 dígitos) entre `allTaxIds` — que para ese momento ya
incluye los **CUITs reales del texto** (los re-agrega `cuitSanitizeStep` antes del assignment), así que
detecta el CUIT aunque la IA no lo haya puesto en `providerTaxId`. Para consorcio, se usa la rama
existente: nombre leído del papel → `not_registered`; nada extraíble → `not_found`.

**Idempotencia (decisión del owner):** nuevo helper puro `appendTag(fileName, tag)` que **limpia
cualquier etiqueta conocida previa** (misma u otra) antes de agregar la actual. Evita el apilado
`- SIN MONTO - SIN MONTO` que se veía al reprocesar (visto en el fix AFIP del 2026-07-07) y hace que el
nombre muestre siempre el **motivo actual**. `appendNoAmountTag` ahora delega en `appendTag`, con lo que
`SIN MONTO` también quedó idempotente. Difiere del comportamiento anterior (que apilaba) — mejora
buscada, no regresión.

**Alcance:** el destino de cada archivo no cambia (Sin Asignar / Revisión como antes); la etiqueta es
solo informativa. `[NO BOLETA]` (prefijo) queda fuera del set idempotente de sufijos.

**Impacto / archivos:** `src/lib/documentValidation.ts` (`appendTag` + `KNOWN_SUFFIX_TAGS`),
`src/jobs/processPendingDocuments.job.ts` (refinado `reasonCategory` de proveedor/consorcio + renombrado
en `unassignedGate` y `noPeriodGate` + `UNASSIGNED_TAG_BY_CATEGORY`). Tests: `documentValidation.test.ts`
(+7) y `processPendingDocuments.job.test.ts` (+3 caminos: PROVEEDOR SIN REGISTRAR, SIN PROVEEDOR, SIN
PERÍODO; y assert de CONSORCIO SIN REGISTRAR en el test de unassigned). 192 tests verdes, typecheck +
lint 0 errores + build:jobs OK.

---

## 2026-07-07 — Reflow de totales AFIP (boletas con monto caían a "SIN MONTO")

**Problema:** 13 facturas electrónicas AFIP ("Comprobante en línea"), simples y con monto, fueron a
Revisión con el tag `SIN MONTO`. El gate `missingAmountGate` funcionaba bien; el fallo era aguas arriba,
en la extracción.

**Investigación (causa raíz, 2 capas):**
1. **Layout roto de pdf-parse.** En los comprobantes AFIP, `pdf-parse` emite la **columna de importes
   separada de la columna de rótulos**. El texto que ve la IA queda así:
   ```
   0,00
   85000,00
   85000,00
   Subtotal: $
   Importe Otros Tributos: $
   Importe Total: $      ← rótulo vacío, sin número al lado
   ```
   El monto sí está en el texto, pero flotando 3-4 líneas arriba de un `Importe Total: $` vacío.
2. **Modelo primario débil.** Los `[metrics]` mostraron que hoy la extracción corre con **Cerebras
   `gpt-oss-120b`** (proveedor gratis agregado el 2026-06-24, primero en la cadena
   `Cerebras → Groq → Gemini → OpenAI → Claude`). Ese modelo no reasocia el número flotante con el
   rótulo → devuelve `amount: null`. La cadena (`aiExtraction.ts`) solo escala al siguiente proveedor
   ante **excepción**; un `null` "exitoso" no escala, así que nunca llega a Gemini. Evidencia: boletas
   AFIP casi idénticas SÍ funcionaron (CALLAO 684676; AV.CNEL DIAZ 571338.36) → debilidad del modelo,
   no fallo duro.

**Decisión:** **Reflow determinista del texto ANTES de la IA** (opción elegida por el owner sobre
"recuperación post-IA" y "escalar a Gemini"). Nuevo helper puro `src/lib/afipTotalsReflow.ts`:
`reflowAfipTotals(text)` reescribe el rótulo `Importe Total: $` pegándole su número. **Regla confiable
validada con boletas reales:** el Importe Total es el número suelto **inmediatamente anterior** a la
línea `Subtotal: $`. Se aplica a `ctx.docText` en `textExtractStep` (ambas ramas PDF), antes de
`aiExtractStep`.

**Por qué reflow y no las alternativas:**
- Es **model-agnóstico**: sirve igual con Cerebras gratis (no gasta cuota paga de Gemini) y con
  cualquier proveedor futuro.
- Ataca la **causa raíz** (texto roto) en vez del síntoma (null de la IA).
- **No toca el camino feliz**: si el `Importe Total: $` ya trae número, o no hay número válido arriba
  de `Subtotal: $`, es no-op (no inventa montos).

**Alternativas descartadas:**
- *Recuperación post-IA* (leer el total solo cuando la IA devuelve null): más acotada pero deja el
  texto roto para el modelo y no ayuda a otros campos.
- *Escalar a Gemini ante null*: gasta cuota paga y depende de que Gemini acierte (no verificado).
- *Extracción posicional con pdfjs-dist*: el arreglo "correcto" a largo plazo (reordena por coordenadas
  y sirve para todo tipo de doc), pero mucho mayor superficie/riesgo. Queda como mejora futura.

**Impacto / archivos:** `src/lib/afipTotalsReflow.ts` (nuevo) + `afipTotalsReflow.test.ts` (6 tests);
2 líneas en `src/jobs/processPendingDocuments.job.ts` (import + 2 asignaciones de `ctx.docText`).
Verificado contra los 13 PDFs reales (los 13 recuperan el total), 20 tests verdes, typecheck + lint 0
errores + build:jobs OK. **Descubrimiento colateral:** CLAUDE.md documenta la cadena como
"Gemini → OpenAI" pero producción corre Cerebras primero (drift de documentación, ver progreso.md).
Las boletas afectadas hay que moverlas de Revisión → Pendientes para reprocesar.

---

## 2026-07-05 — Tipo de pago explícito (Total/Libre/Cuota) + fecha −1 día

**Problemas (encontrados probando la feature de pagos por primera vez):**
1. **Fecha −1 día:** al cargar un pago con fecha "hoy" (día 5), el historial lo mostraba el día 4.
   Causa: la fecha es *date-only*; el backend hace `new Date("2026-07-05")` → se guarda a **medianoche
   UTC**, y `formatDate` la mostraba con `toLocaleDateString("es-AR")` (UTC-3) → 21:00 del día anterior.
   El dato guardado siempre fue correcto; el bug era solo de visualización.
2. **Pago total inline rotulado "Libre":** el input inline "IMPORTE PAGO" (pensado para pago total)
   mandaba el monto sin `totalInstallments` → el backend lo trataba en "modo libre" → el historial
   rotulaba "Libre" todo lo que no fuera cuota. Pero la lógica de negocio del owner distingue tres cosas:
   **Total** (paga todo), **Libre** (parcial de monto imprevisible) y **Cuota** (cuotas pactadas).

**Decisión:**
- **Fecha:** `formatDate` formatea las fechas *date-only* en **UTC** (`timeZone: "UTC"`) y
  `todayInputDate()` usa la **fecha local** (no `toISOString`, que en la madrugada AR devolvía el día
  anterior). Sin tocar datos: los pagos ya cargados se ven bien al instante.
- **Tipo de pago:** campo explícito `paymentType` (enum `PaymentType { TOTAL, LIBRE, CUOTA }`) en
  `Payment`, en vez de derivarlo por monto. Se descartó derivar porque un pago que salda el resto tras
  un parcial se etiquetaría mal (monto < total del papel). Cada camino de UI declara su intención:
  inline → `TOTAL`, modal "Pago libre" → `LIBRE`, cuotas → `CUOTA`. Helper puro `resolvePaymentType`
  (testeable) centraliza la regla: con cuotas siempre CUOTA; sin cuotas gana lo pedido por el caller;
  **salvaguarda**: un `TOTAL` que no saldó la boleta se degrada a `LIBRE`.
- **Inline = pago total:** el input **sugiere** el saldo completo mediante un `datalist` nativo —se
  carga solo al elegir la sugerencia, no al hacer foco— y se valida que el monto coincida con el saldo
  (tolerancia 0,50). Los pagos parciales van por el modal → "Pago libre".
  - *Iteración (mismo día):* la primera versión autocargaba el saldo en el `onFocus`, lo que (a) rellenaba
    al primer click en vez de sugerir y (b) creaba una fila pendiente solo por enfocar, inflando el
    contador "N pago(s) sin guardar" aun con el input vacío. Se cambió a `datalist` y el contador/guardado
    ahora solo consideran filas con **pago real** (`isRowPayable`: monto > 0, o empleado con medio/comprobante).

**Alternativas descartadas:** derivar el tipo por monto/resultado sin columna nueva (evita migración
pero es ambiguo en el caso "salda el resto tras un parcial"). Se prefirió el campo explícito.

**Impacto:** `prisma/schema.prisma` (enum + campo) + migración `20260705000100_add_payment_type`
(enum + columna + backfill: cuotas→CUOTA, pago único que cubre el total→TOTAL, resto→LIBRE);
`src/repositories/payment.repository.ts` (`resolvePaymentType` + uso en `createPayment`);
`src/repositories/paymentType.test.ts` (7 tests nuevos); `src/app/api/client/invoices/[id]/payments/route.ts`
(acepta/propaga `paymentType`); `src/app/admin/consortiums/page.tsx` (fecha, prefill inline, validación
inline=total, historial distingue Total/Libre/Cuota, modal libre manda `LIBRE`). Verificado: typecheck +
lint (0 errores) + 177 tests + build:jobs OK.

**Addendum (mismo día) — encabezados de pagos en la hoja Datos:** al probar el pago, las columnas O–U
(BANCO, SALDO PENDIENTE, MONTO PAGADO, CANT CUOTAS, FECHA PAGO, URL COMPROBANTE, MEDIO PAGO) tenían
datos pero **sin encabezado**. Causa: `ensureHeaderRow` era todo-o-nada (si la fila 1 tenía cualquier
celda, no escribía) → en hojas creadas antes de las columnas de pagos, las nuevas nunca recibieron
label. Decisión: `ensureHeaders` ahora **completa solo las celdas vacías** de las columnas mapeadas, sin
pisar labels custom del usuario (que en la práctica coinciden con los default). Se auto-cura en el
próximo append; para forzarlo en una hoja existente: `scripts/ensure-sheet-headers.ts <cliente>`.
Se descartó reescribir toda la fila de encabezados (pisaría cualquier label editado a mano).

---

## 2026-07-04 — Scheduler: un blip transitorio de DB (P1001) crasheaba el proceso

**Problema (visto en logs de prod):** el contenedor `scheduler` se reinició una vez
(`RestartCount=1`, banner "SCHEDULER INICIADO" 2×: 16:25 y 01:00). Stack trace:
`Can't reach database server ... :6543` (**P1001**) →
`ClientRepository.listActiveClients` → `discover`. Un blip momentáneo de conexión al pooler de
Supabase saltó dentro de `discover()`, que **no tenía try/catch** → *unhandled promise rejection* →
Node **mató el proceso** del scheduler. Docker lo reinició y se recuperó, pero el crash es evitable.

**Causa:** regresión del refactor del scheduler (loop por cliente, 2026-07-02). Dos puntos tocan la
DB **fuera** de un try/catch: `discover()` (`listActiveClients`) y el inicio de `tick()`
(`findActiveById`). El worker sí tiene reintentos de DB; el scheduler no tenía nada.

**Decisión (blindaje en 3 capas):**
1. **`discover()`** envuelto en try/catch: si `listActiveClients` falla, se loguea (recuperable) y se
   reintenta en el próximo tick de discovery (cada 5 min). No crashea.
2. **`tick()`**: `findActiveById` movido dentro de try/catch que **reprograma igual** el loop del
   cliente (con el intervalo global como fallback) → un blip no mata el loop ni el proceso.
3. **Red de seguridad a nivel proceso**: `process.on("unhandledRejection")` y
   `process.on("uncaughtException")` que **loguean sin salir** → ninguna excepción suelta que se
   escape vuelve a tumbar el scheduler (proceso long-running).

Nuevo log `schedulerLog.recoverableError(where, msg)` (nivel warn, "⚠️ Error transitorio en … (se
reintenta)") — distinto de `fatalError`, porque justamente NO es fatal.

**Impacto:** `src/jobs/scheduler.ts` (try/catch en discover + tick, handlers de proceso),
`src/lib/logger.ts` (`recoverableError`). Sin migración. Verificado: typecheck + build:jobs + lint (0
errores) + 170 tests + script de timing OK. Efecto: un P1001 transitorio pasa a ser una línea de log
+ reintento automático, en vez de crash + reinicio de contenedor.

---

## 2026-07-03 — Heartbeat del worker configurable (menos ruido en logs)

**Problema:** el worker logueaba "Cola vacía — esperando jobs (heartbeat)" **cada 5 min** (constante
hardcodeada `IDLE_HEARTBEAT_MS = 5 * 60_000`), aun sin trabajo. El owner lo vio como ruido innecesario
en la terminal de Docker.

**Contexto:** ese log es solo una **señal de vida** (el worker hace polling silencioso cada 2s; el
latido cada varios minutos confirma que el proceso está vivo/ocioso vs. colgado). No es funcional.

**Decisión:** hacer el intervalo del heartbeat **configurable por env** con default más silencioso.
Nueva variable **opcional** `WORKER_HEARTBEAT_MINUTES` (default **30**, piso de 1 min). Se descartó
atarlo al `intervalMinutes` del scheduler porque ese valor es **por-cliente** y el worker es un proceso
**global** (sirve a todos los clientes) → acoplarlo a un campo por-cliente es conceptualmente
incorrecto y se rompe con multi-cliente. Un env dedicado con default es lo más limpio: sin
acoplamiento, ajustable sin tocar código.

**Impacto:** `src/config/env.ts` (declara la env opcional), `src/jobs/jobWorkerMain.ts`
(`IDLE_HEARTBEAT_MS` pasa a leer `env.WORKER_HEARTBEAT_MINUTES` con default 30 y piso 1), `.env.example`
+ `CLAUDE.md` (doc). **Solo afecta la frecuencia del log**: el polling de 2s y el procesamiento de jobs
no cambian; el scheduler tampoco. Como el default es 30, apenas se deploya el heartbeat baja de 5 a 30
min **sin tocar el secret `PROD_ENV_FILE`**; para otro valor se agrega `WORKER_HEARTBEAT_MINUTES=X` al
secret (manteniéndolo completo). typecheck + build:jobs + lint (0 errores) OK. Es cambio en el proceso
worker → toma efecto con el rebuild/redeploy del CI.

---

## 2026-07-02 — Vista general de consorcios: tarjetas con deuda (período + total)

**Problema / pedido:** la vista `/admin/consortiums` tenía una lista lateral angosta de los 47
consorcios (nombre + período + total histórico de boletas). El owner quería verlos como **tarjetas**
con más info de un vistazo: cantidad de boletas y **deuda** (saldo pendiente) del consorcio.

**Decisión (UI):** se elimina la columna-lista lateral y los consorcios se muestran como un **grid de
tarjetas** en el área principal (con buscador + contador). Cada tarjeta: nombre, período activo,
boletas del período, **Deuda mes** y **Deuda total**. Al hacer click se abre el detalle de siempre;
un botón "← Volver a consorcios" regresa al grid. Estilos con los tokens existentes (dark/light).

**Decisión clave (deuda y cierre de período):** la deuda por boleta se calcula como
`isPaid ? 0 : coalesce(remainingBalance, amount, 0)` (las pagas no suman). Al preguntarse qué pasa al
**cerrar un período** (`closePeriodAndCreateNext`: el período ACTIVO pasa a CLOSED y se crea uno nuevo
ACTIVO **vacío**; las boletas impagas quedan en el período cerrado, **sin arrastre**), se decidió con
el owner mostrar **dos deudas** en la tarjeta:
- **Deuda mes** = deuda del período ACTIVO. Al cerrar, vuelve a $0 (período nuevo vacío).
- **Deuda total** = deuda impaga de TODOS los períodos (activo + cerrados). Al cerrar un período, la
  deuda impaga **sigue contando** acá → refleja lo que realmente debe el consorcio.

**Alternativas descartadas:** mostrar solo la deuda del período activo (se perdía de vista la deuda
arrastrada de períodos cerrados); mostrar solo la total (se perdía el foco del mes en curso).

**Backend:** `ConsortiumRepository.listByClient` agrega, además de `periods` + `_count.invoices`, tres
campos por consorcio vía **2 queries raw** (`$queryRaw` + `Prisma.join` para el `IN`): (1) período
activo → cantidad de boletas + deuda del mes (filtra por los ids de período ACTIVE); (2) total →
deuda impaga de todas las boletas del consorcio (filtra por `clientId`, agrupa por `consortiumId`).
El endpoint `GET /api/client/consortiums` no cambió (pasa el resultado tal cual). El `Decimal` de
Prisma se parsea con `Number(String(...))` (el driver puede devolver bigint/Decimal/string).

**Impacto:** `src/repositories/consortium.repository.ts` (agregación), `src/app/admin/consortiums/page.tsx`
(grid de tarjetas + buscador + botón volver, se saca la lista lateral), `page.module.css` (estilos de
tarjetas). Solo lectura, sin migración. Verificado contra la DB real (MorinigoAdm, 47 consorcios):
`deudaTotal ≥ deudaMes` en todos, y los saldos coinciden con los del detalle por consorcio. typecheck
+ lint (0 errores) OK. **Nota:** el contador de boletas de la tarjeta es del **período activo** (no
el total histórico que mostraba la lista vieja), para ser coherente con "Deuda mes".

**Deep-link del consorcio seleccionado (URL híbrida) + loader.** Antes, recargar (F5) estando en un
consorcio te devolvía al grid (la selección vivía solo en estado React). Se persiste ahora en la URL
como query param, **sin endpoint nuevo** (los endpoints por-id ya existen). Formato **híbrido**:
`?c=<slug-del-nombre>-<id>` (ej. `?c=pueyrredon-2418-cmmuvg0hl0000kxl4ks5nrgxn`). El slug es cosmético
(legible/compartible); el matching usa el **id (cuid) embebido al final** — el cuid no tiene guiones,
así que se extrae con `lastIndexOf("-")`. Decisión clave: se eligió híbrido sobre nombre-puro porque
`canonicalName` **puede cambiar** al re-sincronizar el ALTA → un link nombre-puro guardado antes del
renombre quedaría roto de forma **permanente** (recargar no lo recupera, el slug viejo ya no matchea);
con el id embebido el link sigue andando aunque se renombre. Rendimiento/escala: **indistinto** —
el match es un `.find` client-side sobre la lista ya cargada, y `canonicalName` está indexado por el
`@@unique([clientId, canonicalName])` si alguna vez fuera server-side. Implementación (solo frontend,
`window.history.replaceState`, sin navegación ni Suspense de `useSearchParams`): al seleccionar se
setea la URL; al montar se lee `?c=` y, tras cargar la lista, se restaura por id (una sola vez, ref
`didRestoreRef`); si el id no existe (consorcio borrado) limpia la URL y cae al grid. **Loader**
(`.restoreLoader` con spinner) mientras se resuelve la restauración, para no ver el grid parpadear
antes del detalle. Helpers puros `slugifyName`/`consortiumUrlKey`/`idFromUrlKey` en `page.tsx`.

---

## 2026-07-02 — CUIT del membrete en imagen: fallback de visión Gemini reforzado

**Problema:** con el matching de proveedor ahora **solo por CUIT** (entrada anterior), las boletas
cuyo CUIT del emisor está en el **membrete como imagen/logo** (que `pdf-parse` no lee — caso
ASCENSORES POTENZA) irían a Sin Asignar aunque el proveedor esté cargado. Necesitábamos recuperar el
CUIT desde la imagen. Cerebras (`gpt-oss-120b`, proveedor principal) es **texto puro, no ve
imágenes**, así que la visión tiene que ser vía Gemini (multimodal, free tier).

**Contexto:** ya existía un fallback de visión con Gemini (`extractProviderFromImage`), pero (a) solo
corría si `assignment.unassigned && consortiumId && !hasEmitterBlock` — y en el bug viejo el
proveedor matcheaba MAL por nombre → `unassigned=false` → nunca se disparaba; (b) mandaba la **página
completa a 200 DPI** (CUIT chico ilegible); (c) no cubría boletas 100% imagen (exigía `consortiumId`
previo); (d) el gate `!hasEmitterBlock` es una heurística por palabras clave poco confiable.

**Decisión (elegida con el owner):**
- **Trigger preciso por CUIT faltante:** el fallback corre SOLO si
  `reasonCategory ∈ {provider_not_found, consortium_not_found}` (falta el CUIT del proveedor y/o del
  consorcio). Si ya matchearon ambos por CUIT → NO se dispara (**ahorro de tokens**, pedido del
  owner). Tampoco corre por `no_amount`, `no_period`, `lsp_clientnumber_not_registered`, etc.
- **Recorte del membrete a alta DPI:** `OcrService.renderTopRegionPng` renderiza la franja superior
  (~40%) de la página 1 a **300 DPI** (pdftoppm + recorte con `@napi-rs/canvas`) y le manda ESO a
  Gemini Vision — mucho más legible que la página completa a 200 DPI. Si falla, cae al PNG de página
  completa que ya dejaba el OCR.
- **Recupera ambas partes:** `extractPartiesFromImage` devuelve emisor **y** receptor (proveedor +
  consorcio con sus CUITs). Los CUITs de la visión se suman a `allTaxIds` y se re-corre
  `resolveAssignment` → sirve tanto para el proveedor como para el **consorcio en boletas 100%
  imagen** (donde no hay texto para matchear el edificio).
- **Tolerancia 0 (sin fuzzy):** el CUIT que devuelve Gemini debe matchear **exacto** contra la DB.
  Sin corrección por distancia de edición — Gemini devuelve el CUIT limpio (no es ruido carácter a
  carácter como tesseract), así que el fuzzy aportaba poco y sí sumaba riesgo. Si aparece un caso
  real de lectura a 1 dígito, se evalúa agregar fuzzy conservador con datos.

**Alternativas descartadas:** tesseract dedicado al membrete (whitelist de dígitos + preprocesado) —
lee peor los logos estilizados que un modelo de visión; queda como opción futura para clientes sin
Gemini. Corrección difusa de CUIT contra la DB (distancia ≤1/≤2) — descartada por ahora (tolerancia
0). Hacer multimodal la cadena principal — overkill; Gemini como fallback puntual alcanza.

**Impacto:** `src/services/ocr.service.ts` (`renderTopRegionPng` + `@napi-rs/canvas`),
`src/services/pdfTextExtractor.service.ts` (`extractMembreteImage`),
`src/services/geminiExtractor.service.ts` (`extractProviderFromImage` → `extractPartiesFromImage`,
ahora emisor + receptor), `src/jobs/processPendingDocuments.job.ts` (reescrito el bloque de fallback
visual: trigger por `reasonCategory`, recorte alta DPI, merge de CUITs a `allTaxIds`). Tests: 4
casos nuevos de caracterización (recupera CUIT del emisor → OK; no dispara con ambos CUITs; no
dispara por no_amount; CUIT del membrete no en DB → Sin Asignar). 170 tests + typecheck + lint (0
errores) + build:jobs OK. Sin migración. Depende de que el cliente tenga Gemini configurado (ya lo
tiene); sin Gemini, la boleta-imagen va a Sin Asignar.

---

## 2026-07-02 — Matching de proveedor: SOLO por CUIT (se elimina el fallback por nombre)

**Problema:** una factura de **ASCENSORES POTENZA S.R.L.** (CASTRO BARROS 1310) se asignó a un
proveedor **equivocado** que sí estaba en la DB. ASCENSORES POTENZA no estaba cargado. Root cause
confirmado extrayendo el texto real del PDF: el único CUIT en el texto es el del **consorcio**
(`30-71741718-2`); el CUIT del emisor (ASCENSORES POTENZA) no aparece — está en el membrete/logo
(imagen), que `pdf-parse` no lee. Sin CUIT de proveedor, `matchProvider` caía al **Intento 3
"nombre parcial"** (`src/lib/assignmentMatching.ts`), que compara con
`normOcrName.includes(normName(p.canonicalName).slice(0, 5))`: `"ascensores potenza"` contiene
`"ascen"` (los primeros 5 chars de cualquier otro *"ASCENSORES ..."* de la DB) → **falso match** al
primer ascensores cargado. El `slice(0,5)` hace colisionar a cualquier par de proveedores con
prefijo común.

**Decisión:** el proveedor se matchea **SOLO por CUIT** (Intentos 0 y 1: `allTaxIds` y
`providerTaxId`, ambos excluyendo el CUIT del consorcio). Si no hay CUIT de proveedor en la boleta
(o no está en la DB) → `null` → **Sin Asignar**. Se agrega el parámetro `allowNameMatch` (default
`false`) a `matchProvider`; los Intentos 2 y 3 (nombre exacto / matchNames / parcial) solo corren si
`allowNameMatch=true`. El caller lo activa **únicamente** para el conjunto cerrado de proveedores
"CUIT del papel = consorcio" (**sindicales SUTERH/FATERYH/SERACARH y ARCA**), que no tienen CUIT
propio y por diseño se identifican por nombre — vía `usesConsortiumCuit(lspProvider)`. Modelo de
boleta válida (no-sindical): **2 CUITs presentes** — el del emisor (proveedor, en DB) y el del
consorcio (en DB). Anti-alucinación ya vigente: el pipeline descarta CUITs que no aparecen en el
texto, así que un CUIT de proveedor inexistente en el papel no puede colarse.

`pickByName` (desambiguación cuando varios proveedores comparten el MISMO CUIT, ej. sindicales que
usan el CUIT recaudador) sigue activa siempre: no asigna por nombre, solo elige entre candidatos
que ya matchearon por CUIT.

**Alternativas descartadas:**
- Endurecer también el **consorcio** a solo-CUIT (el usuario lo mencionó): descartado — muchas
  boletas de servicios (Edesur/AySA/Metrogas) y facturas normales NO imprimen el CUIT del consorcio
  y se matchean por dirección/nombre. Requerirlo mandaría a Sin Asignar a todo ese volumen. El
  consorcio queda igual (CUIT primero, fallback nombre/fuzzy/alias). Decisión del owner.
- Aplicar solo-CUIT también a sindicales/ARCA: descartado — no tienen CUIT propio, irían todas a
  Sin Asignar. Se conserva su match por nombre (conjunto cerrado y con nombres distintivos).
- Tunear el prompt de Cerebras para que extraiga mejor el CUIT: no aplica a este caso — el CUIT del
  proveedor no está en la capa de texto del PDF (está en el logo), así que ningún prompt lo saca; se
  necesitaría OCR. La regla determinística (solo-CUIT) es la protección correcta y robusta.

**Impacto:** `src/lib/assignmentMatching.ts` (`matchProvider` + `allowNameMatch`),
`src/jobs/processPendingDocuments.job.ts` (pasa `isSindicalLsp`), `src/lib/testbench.ts` y
`scripts/diag-boleta.ts` (pasan `usesConsortiumCuit(lspProvider)`). Tests:
`src/lib/assignmentMatching.test.ts` (regresión del bug ASCENSORES POTENZA + gating por
`allowNameMatch`) y `src/jobs/processPendingDocuments.job.test.ts` (fixtures del camino feliz ahora
llevan los 2 CUITs, presentes en el texto mock). Verificado: 166 tests OK, typecheck + lint (0
errores) + build:jobs OK. Sin migración.

---

## 2026-07-02 — Scheduler: loop independiente por cliente en vez de tick global fijo

**Problema:** el usuario cambió `intervalMinutes` de un cliente a 20 min y, viendo los logs, tuvo
la impresión de que "no se tomó" — el log `CICLO DE ESCANEO` seguía apareciendo cada 5 min. Con el
modelo anterior (`setInterval` global cada `SCHEDULER_TICK_MS` = 5 min sobre TODOS los clientes +
`shouldEvaluateClient` salteando en silencio los clientes cuyo intervalo aún no venció) el intervalo
SÍ se respetaba en la práctica, pero no había ninguna evidencia de eso en los logs: el tick externo
(fijo en 5 min, el piso de polling) imprimía igual aunque no se escaneara nada. El usuario pidió
explícitamente que el log de "inicio de escaneo" coincida con el intervalo configurado, sin ruido
de logs de relleno.

**Decisión:** reemplazar el tick global fijo por **un `setTimeout` independiente por cliente**
(`src/jobs/scheduler.ts`), que se reprograma solo leyendo su `intervalMinutes` fresco de la DB en
cada vuelta (`tick()` → `runClientCycle()` → `scheduleNext()`, agenda el siguiente ciclo a
`resolveClientIntervalMs(client.intervalMinutes, ...)` ms). Un loop de "discovery" separado
(`discover()`, cada `CLIENT_DISCOVERY_INTERVAL_MS` = 5 min — piso mínimo, no es el intervalo de
ningún cliente) arranca el timer de un cliente activo nuevo (primer ciclo inmediato) o detiene el
de uno desactivado/borrado; es silencioso salvo que haya una alta o baja real.

Con esto `schedulerLog.clientScanning` y su resultado (`clientNoPdfs`/`jobsQueued`) aparecen
**exactamente** cada `intervalMinutes` de ese cliente. Se sacaron los logs del tick global que ya
no tenían sentido (`cycleStart`, `cycleEmpty`, `cycleEnd`, `cycleSummary` agregado multi-cliente);
se agregaron `clientDiscovered`/`clientRemoved` (solo en altas/bajas). `skippedBusy` pasó a ser
por-cliente (antes era global).

**Alternativas descartadas:**
- Agregar un log explícito de "esperando intervalo, faltan N min" en cada tick salteado: hubiera
  resuelto la confusión sin refactor, pero el usuario pidió explícitamente evitar logs
  innecesarios — con múltiples ticks salteados por cada ciclo real (ej. 4 ticks salteados por cada
  cliente de 20 min), esto genera más ruido, no menos.
- Bajar `SCHEDULER_TICK_MS` a la cadencia del cliente más chico: es el bug histórico que ya
  documentaba `schedulerTiming.ts` (un tick grueso hace que TODOS los clientes corran a esa
  cadencia, sin importar su propio `intervalMinutes`) — no es multi-tenant seguro.

**Impacto:** `src/jobs/scheduler.ts` (reescrito), `src/jobs/schedulerTiming.ts` (se sacó
`shouldEvaluateClient`/`SCHEDULER_TICK_MS`, se agregó `CLIENT_DISCOVERY_INTERVAL_MS`),
`src/lib/logger.ts` (`schedulerLog`: nuevos `clientDiscovered`/`clientRemoved`, se sacaron los
métodos del tick global), `src/repositories/client.repository.ts` (nuevo `findActiveById`),
`scripts/test-scheduler-interval.ts` (reescrito para el modelo nuevo). Comportamiento: al cambiar
`intervalMinutes` desde el panel, el cambio toma efecto al terminar el ciclo en curso de ESE
cliente (no instantáneo, pero sin reiniciar el proceso). Verificado con `npm run typecheck`,
`npm run lint`, `npm run build:jobs`, `npx vitest run` (tests de caracterización del pipeline) y
`npx tsx scripts/test-scheduler-interval.ts` — todo OK.

---

## 2026-06-25 — Fix deploy CI: `docker login` en runner Windows (credsStore)

**Problema:** el job `deploy` (self-hosted Windows) fallaba en "Login to GHCR" con
`error storing credentials - A specified logon session does not exist. It may already have been
terminated.`. Causa: `docker login` usa el credential helper de Docker Desktop
(`credsStore: "desktop"` en `~/.docker/config.json`), que guarda en el **Windows Credential
Manager** y requiere una sesión de logon **interactiva** que el runner no tiene. Quitar `credsStore`
del config global a mano **no alcanza**: Docker Desktop lo re-agrega al arrancar.

**Decisión (approach final):** **no usar `docker login` en absoluto** en el job `deploy`. Un step
escribe el `auth` (base64 de `usuario:token`) directamente en un `config.json` propio del job
(`DOCKER_CONFIG = ${{ github.workspace }}/.docker-ci`); `docker pull`/`compose` autentican leyendo
ese config. Así no se invoca ningún credential helper ni el comando `docker login`. El job `build`
(ubuntu) sigue con `docker/login-action` normal (en Linux no hay problema). Camino recorrido:
(1) quitar `credsStore` del config global → Docker Desktop lo re-pone; (2) `DOCKER_CONFIG` limpio +
`docker/login-action` → el action no esquiva el helper igual (runner-images #11211); (3) **auth
manual en el config** → definitivo. Ojo extra: `runner.temp` **no** está disponible en `env` a nivel
de job (rompe la validación del workflow, duración 0s) → se usa `github.workspace`. Así
`docker login`/`pull`/`compose` guardan las credenciales en base64 en ese config temporal, **sin
invocar el helper de Windows** → independiente del config global que gestiona Docker Desktop. El
`env` a nivel de job aplica a todos los steps (login + build/restart).

**Alternativas descartadas:** quitar `credsStore` del config global (Docker Desktop lo re-pone);
instalar otro credential helper (no hay uno headless confiable en Windows); correr el runner como
servicio con sesión persistente (frágil).

**Impacto:** `.github/workflows/ci.yml` (job `deploy`: `env.DOCKER_CONFIG` + step "Prepare Docker
config with GHCR auth"; se eliminó el step "Login to GHCR" que usaba `docker/login-action`). Sin
cambios en el código de la app. **Commiteado y deployado** (HEAD `bcff5c3`).

---

## 2026-06-25 — Banco de pruebas local de LLMs (testbench)

**Problema:** para mejorar la extracción (iterar prompts, comparar modelos) hace falta procesar
boletas reales de forma repetible sin tocar la producción del cliente. `compare-extractors` solo
compara la extracción cruda; falta el resto del flujo (triage, matching, canonización, resultado).

**Decisión (enfoque A — reusar funciones puras):** un módulo `src/lib/testbench.ts`
(`runLogicalPipeline`) que replica la secuencia del pipeline llamando a las mismas funciones puras
(`identifyLSPProvider`, `classifyDocumentType`, `isMissingAmount`, `extractCuitsFromText`,
`matchConsortium`/`matchProvider`, `annotateSindicalProvider`) sin side-effects, y un CLI
`scripts/llm-testbench.ts` que lee una carpeta, carga el directorio del cliente (DB **read-only**) y
escribe reportes. Decisiones del brainstorming: (a) **destino = archivos locales** (dry run, no
escribe DB/Sheets; el reporte muestra qué se registraría); (b) **alcance = pipeline completo** con
matching read-only; (c) **ground truth opcional** (`<nombre>.expected.json` → aciertos por campo,
montos por valor con `normalizeBusinessAmount` y CUITs por dígitos con `cuitsEqual`).

**Alternativas descartadas:** correr `runPipeline` real con ~8 deps mockeadas (mucha maquinaria; y
la cadena real corta en el primer modelo OK, lo que choca con "comparar modelos"); volcar a un
sandbox de DB/Sheets (se prefirió cero escritura); fine-tuning de modelos (otro proyecto).

**Impacto:** nuevos `src/lib/testbench.ts` (+test, 6 tests) y `scripts/llm-testbench.ts`;
`.gitignore` ignora `pruebas de LLMs/` (datos reales del cliente). 161 tests; typecheck + lint OK.
Sin migración. **Commiteado.** Caveat: el OCR no corre local (solo Docker) → boletas-imagen en el
pipeline real. Spec/plan: `docs/superpowers/{specs,plans}/2026-06-25-banco-pruebas-llms*`.

---

## 2026-06-24 — Más cuota de IA gratis: Cerebras + Groq en la cadena de extracción

**Problema:** el throughput cayó a menos de la mitad del histórico (~80-100/día). Causa externa:
Google recortó el free tier de Gemini, cuya cuota es **diaria por modelo**
(`GenerateRequestsPerDayPerProjectPerModel-FreeTier`); el barrido de 5 modelos ya no suma
suficiente para una jornada. Restricción del owner: la solución debe ser **100% gratis** (sin
tier pago ni crédito).

**Por qué no batchSize/frecuencia:** con tope **diario**, `batchSize`/`intervalMinutes` controlan
el *ritmo*, no el *total* — procesar más rápido solo adelanta el agotamiento. El cuello de botella
es la cuota diaria total de IA.

**Decisión:** sumar **oferta** de IA gratuita de otros proveedores (cada uno su propio balde,
legítimo). Como predominan **facturas variadas** (no sistemáticas), se descartó el parser
determinístico (rinde poco). Cambios:
- Nuevo `OpenAICompatibleExtractorService` (`src/services/openAICompatibleExtractor.service.ts`):
  Cerebras y Groq hablan la **Chat Completions API de OpenAI**, así que se reutiliza el SDK
  `openai` cambiando `baseURL` + el mismo prompt/parseo/refinamiento. El llamado al modelo se
  inyecta como seam `complete` (testeable sin red). Es genérico → a futuro Mistral/OpenRouter
  son otra instancia, sin código nuevo.
- Cadena reordenada **capacidad primero** en `createAiExtractionChain`:
  `Cerebras → Groq → Gemini → OpenAI → Claude` (se gastan primero los baldes grandes). Nuevo
  getter `providerOrder` para test/diagnóstico. Solo en el **pipeline automático**; el scan
  manual NO se tocó (carga puntual, bajo volumen — decisión del owner).
  **[Actualización 25/06]** Groq se sacó del wiring del pipeline (pedido del owner: no le dio
  confianza tras desacertar datos críticos en una factura variada). La cadena de producción queda
  `Cerebras → Gemini → OpenAI → Claude`; Groq se evaluará con más detalle en el banco de pruebas.
  `createAiExtractionChain` y `OpenAICompatibleExtractorService` siguen soportando Groq (reactivar
  = volver a pasar `groq` en `createProcessingContext`); el banco lo usa por separado.
- `isRateLimitError` reconoce el `status === 429` (y `code` `rate_limit_exceeded`/
  `insufficient_quota`) del `APIError` del SDK de OpenAI: Cerebras/Groq pueden no incluir "429"
  en el mensaje, y sin esto un 429 suyo degradaría la boleta a OCR_ONLY → Revisión en vez de
  volver a Pendientes (rompería el circuit breaker `aiPausedUntil`).
- Keys por **env global** (`CEREBRAS_API_KEY`/`GROQ_API_KEY` + `*_MODEL`): son del operador y hay
  1 cliente → sin migración, sin UI, sin encriptación. `docker-compose.yml` intacto (`env_file`).
- Gate de validación previo a confiar el 1er lugar a Llama: `scripts/compare-extractors.ts`
  corre cada proveedor sobre el mismo texto de PDFs reales y muestra los campos lado a lado.

**Alternativas descartadas:** tier pago de Gemini / crédito OpenAI (el owner exige gratis);
parser determinístico para LSPs (predominan variadas); rotación de keys/proyectos de Gemini
(contra los ToS de Google); OpenRouter (requiere cargar US$10 para el tier útil → no es gratis
puro); keys por cliente (env global alcanza).

**Free tiers (verificados 06/2026):** Cerebras **1.000.000 tokens/día** (~300+ boletas, sin
tarjeta, context cap 8.192 tokens → ARCA de 2 páginas podría exceder y caer al fallback), Groq
1.000 req/día (Llama 70B) o 14.400 (Llama 8B). El techo gratuito pasa de ~100/día a varios
cientos/día.

**Impacto:** 9 tests nuevos (4 extractor genérico + 3 isRateLimitError + 2 orden de cadena),
155 totales; typecheck + lint (0 errores) + build:jobs OK. Sin migración. Archivos: nuevos
`openAICompatibleExtractor.service.ts` (+test) y `scripts/compare-extractors.ts`; modificados
`aiUsage.types.ts`, `aiErrors.ts`, `aiExtraction.ts`, `env.ts`, `processPendingDocuments.job.ts`,
`logger.ts`. **Commiteado y deployado.** Spec/plan:
`docs/superpowers/{specs,plans}/2026-06-24-cuota-ia-gratis-cerebras-groq*`.

**Validación + ajuste de modelo (25/06):** prueba real con `compare-extractors.ts` sobre un F931
de ARCA (BELGRANO 2458). Resultado: Cerebras y Groq extraen idéntico y ambos sacan el **monto
correcto del VEP** (453.493,06 — el dato difícil del ARCA). El `consortium` salió con ruido
idéntico en los dos (viene del texto del PDF, no del modelo; ARCA matchea por CUIT igual). **El
default de Cerebras cambió de `llama-3.3-70b` a `gpt-oss-120b`**: Cerebras retiró los modelos Llama
de su catálogo free (solo quedan `gpt-oss-120b` y `zai-glm-4.7`), por eso `llama-3.3-70b` daba 404.
Groq mantiene `llama-3.3-70b-versatile`. Cambios: `aiExtraction.ts`, `compare-extractors.ts`,
`.env.example`. (Nota operativa: el comparador local no hace OCR — poppler/tesseract solo están en
la imagen Docker — así que las boletas-imagen se prueban dentro del pipeline, no con el script.)
**2º caso (factura común variada, CALLAO 1441 / ALETEC SRL):** Cerebras acertó todo —distinguió el
CUIT del **emisor** (`30-66115265-2`, ALETEC) del **receptor** (`30-70200241-5`, el consorcio), el
N° de comprobante con sus ceros (`00002-00003876`) y el **monto correcto (109.400)**—, mientras
Groq tomó el CUIT del consorcio receptor como proveedor (y malformado) y erró el monto
(128.786,78). Confirma **con datos reales** el orden **Cerebras primero**: `gpt-oss-120b` es
netamente más confiable que Llama en las facturas variadas, que son la mayoría del volumen. (La
boleta había ido a Sin Asignar solo porque ALETEC no estaba en el directorio, no por la IA: el
pipeline saca el CUIT del texto con `extractCuitsFromText`, así que basta cargar el proveedor.)

**Confirmación en producción (02/07/2026):** `PROD_ENV_FILE` se completó con `CEREBRAS_API_KEY` +
`DIRECT_URL` y se re-deployó. Verificado revisando `docker logs` del contenedor worker en vivo:
boletas reales procesadas con `"provider":"cerebras","model":"gpt-oss-120b"` de forma consistente
en las últimas horas — Cerebras es el proveedor principal en producción, ya no pendiente.

---

## 2026-06-22 — UI Boletas entrantes: filtros por consorcio/proveedor/periodo (server-side) + N° boleta

**Problema:** la vista `/admin/boletas` lista 700+ boletas paginadas de a 50 sin forma de
filtrar, y no mostraba el número de boleta.

**Decisión:** filtrado **server-side** (no client-side sobre la página visible). La API
`/api/client/invoices` acepta `consortiumId`/`providerId`/`period` y filtra todo el dataset; el
contador y la paginación reflejan el filtro (y se vuelve a página 1 al cambiar). Las opciones de
los dropdowns vienen de `facets` que la API calcula con `distinct` sobre las boletas del cliente
(solo consorcios/proveedores/periodos que realmente tienen boletas; consorcios/proveedores
alfabético, periodos del más reciente al más viejo) — así no se llenan de opciones vacías y
quedan estables al aplicar un filtro. Se agregó `boletaNumber` a la respuesta y una columna que
muestra sus últimos 4 dígitos.

**Gotcha del período (Period es por consorcio):** cada consorcio tiene su propio `Period`, así
que un mismo "06/2026" corresponde a **muchos `periodId` distintos**. El primer intento filtraba
por `periodId` → el dropdown repetía "06/2026" N veces y al elegir uno traía **un solo consorcio**.
Corregido: el período se filtra por **etiqueta MM/YYYY** (`where: { periodRef: { is: { month, year } } }`,
matchea en todos los consorcios) y el dropdown se **deduplica por etiqueta** (`parsePeriodLabel`).

**Alternativas descartadas:** filtrar client-side (solo filtraría la página de 50, no las 700+);
poblar los dropdowns desde las tablas Consortium/Provider/Period completas (mostraría opciones sin
boletas).

**Impacto:** `api/client/invoices/route.ts` (campo + params + facets) y `admin/boletas/page.tsx`
(columna + 3 dropdowns + estado de filtros). typecheck + lint + next build OK. Sin migración.
PENDIENTE: commit + push.

---

## 2026-06-15 — Soporte ARCA F931 (SUSS): impuestos de seguridad social del consorcio

**Problema:** casi todo consorcio con empleados paga mensualmente el F931 de ARCA/AFIP (aportes
y contribuciones de seguridad social). Es recurrente y muy sistemático, pero el sistema no lo
reconocía: el documento NO tiene un emisor con CUIT (el único CUIT es el del CONSORCIO
contribuyente) y el total a pagar no está en la DJ (página 1) sino en el VEP (página 2). Con el
prompt de facturas normales caería en Sin Asignar (busca un emisor con CUIT).

**Decisión:** tratar ARCA como un tipo del router con el **mismo modelo que los sindicales**
(CUIT del papel = consorcio, proveedor por nombre, sin CUIT propio):
- `identifyLSPProvider` detecta ARCA por el formulario `931` + `S.U.S.S.`/`Organismo Recaudador`
  (robusto al rebrand AFIP→ARCA), antes del gate `isUtilityBill`.
- Nuevo helper `usesConsortiumCuit(lspProvider)` que agrupa SUTERH/FATERYH/SERACARH **+ ARCA**
  y reemplaza los `=== "SUTERH" || …` hardcodeados (los excluye del fast-path LSP que resuelve
  proveedor por CUIT). Deja el intent explícito.
- `buildArcaPrompt`: total del **VEP** (`Importe total a pagar`, no los subtotales de la DJ),
  `dueDate` = `Día de Expiración`, `boletaNumber` = `Nro. VEP`, consorcio por Razón Social,
  CUIT del consorcio → `allTaxIds`, `provider = "ARCA"`.
- El total está en la página 2 (VEP) → ARCA re-extrae 2 páginas en vez de la 1 del flujo LSP.

**El "ARCA no tiene CUIT" no requirió cambios de schema:** el sistema ya soporta proveedores
sin CUIT (matchProvider por nombre, igual que los sindicales). ARCA se registra como una fila
en `_Proveedores` (ALTA) con CUIT vacío y **sin matchNames** (no hace falta: el prompt fija
`provider="ARCA"`, que matchea el nombre canónico directo; un rebrand se corrige en el prompt).

**Alternativas descartadas:** tratarlo como factura común (no hay emisor con CUIT → Sin
Asignar); como LSP de servicio público (ahí el CUIT sería del proveedor, lo opuesto a ARCA).

**Fix (prueba en prod, 22/06):** la 1ª corrida real dio un monto **inventado** (294.499,11 =
suma de aportes de la DJ, cifra que NO está impresa) en vez del total del VEP (453.493,06).
Causa raíz: la DJ es larga y el "Importe total a pagar" del VEP cae ~línea 88, pero el prompt se
cortaba a 80 líneas (`extractRelevantLines`) → la IA no veía el total y lo fabricaba sumando la
DJ. Fix: para ARCA se pasa el texto completo (2 páginas, sin truncar) y `buildArcaPrompt` exige
copiar literal el "Importe total a pagar", prohíbe sumar/calcular y devuelve null si no aparece.

**Impacto:** 8 tests de ARCA (`extraction.test.ts`: router + `usesConsortiumCuit` + ruteo +
total más allá de la línea 80 + anti-suma); 146 tests totales; typecheck + lint + build:jobs OK.
Sin migración. Analizado contra un F931 real (BELGRANO 2458, período 05/2026). PENDIENTE: commit
+ push (el proveedor ARCA ya está cargado/sincronizado en la DB).

---

## 2026-06-15 — Distinción SERACARH vs FATERYH en el nombre del proveedor

**Problema:** un consorcio con empleados recibe **2 boletas FATERYH** por período (verificado
con PDFs reales de RIVADAVIA 4243): F0101 (FMVDD aporte/contribución, OS CCT, ART 27 bis) y
F0106 (SERACARH Contribución), mismo emisor y CUIT. El router (`identifyLSPProvider`) ya las
distingue (`lspProvider` = `"SERACARH"` vs `"FATERYH"`), pero el matching las resuelve al
**mismo proveedor canónico "FATERYH"** (SERACARH es anexo, alias en `matchNames`), así que
ambas quedaban con nombre/proveedor idéntico → mala UX para el administrador.

**Decisión:** anotar `"(SERACARH)"` en el **texto** del proveedor cuando la boleta es SERACARH,
sin tocar el `providerId` (FK). Nuevo helper puro `annotateSindicalProvider(provider, lspProvider)`
en `lib/extraction.ts` (idempotente: no duplica el sufijo). Se aplica **una sola vez** en
`canonizeStep`, justo después de asignar el proveedor canónico → como Sheets, el nombre del
archivo en Drive y la DB se arman todos desde `extracted.provider`, la distinción aparece en
los tres lados de forma consistente. No afecta dedup (la business key usa taxId/boleta/fecha/monto,
no el nombre) ni el matching (re-extrae en cada corrida).

**Alternativas descartadas:** anotar solo en el nombre del archivo (no cubría Sheets, pedido del
owner); mantener Sheets distinto de la DB (requeriría dos versiones de `extracted`, más complejo
e inconsistente).

**Impacto:** 5 tests nuevos (`extraction.test.ts`); typecheck + lint + build:jobs OK; 138 tests
totales. Sin migración. **Deployado en `efe83b8` (CI #83).**

---

## 2026-06-15 — Triage de documentos: clasificar boleta vs no-boleta

**Problema:** la carpeta Pendientes recibe documentos que NO son boletas (planos de edificio,
certificados de desinfección/fumigación, obleas de rúbrica de libros, disposiciones). Hoy
todos pasaban por la IA y terminaban en "sin monto" → Revisión o en Sin Asignar, gastando
tokens y ensuciando esas carpetas. Además hay boletas genuinas pero atípicas ("particulares"
tipo MAYO) que no deben rechazarse por error.

**Decisión:** capa de triage **híbrida en dos capas** sobre el pipeline (refactor H2), con
**sesgo conservador** (ante la duda → es boleta; perder una boleta genuina es peor que mover
un no-boleta a Revisión):
- **Capa 1 — heurística (0 tokens):** `src/lib/documentClassifier.ts` (`classifyDocumentType`,
  función pura). Devuelve `"not_boleta"` SOLO si hay señal negativa fuerte (oblea, rúbrica,
  certificado de fumigación/desinfección/etc., plano, disposición…) **Y** ninguna señal de
  boleta (`$`, total a pagar, importe, vencimiento, factura/recibo/comprobante, CAE, o un CUIT
  válido). Corre en `documentTriageGate`, **antes** de la IA → corta lo evidente sin gastar
  tokens. Resuelve el caso clave: certificado de fumigación SIN monto → no-boleta; pero
  factura de la empresa de fumigación (con monto/CUIT) → boleta.
- **Capa 2 — IA:** campo `isBoleta` en `EXTRACTED_DOCUMENT_SCHEMA` (default conservador `true`)
  + instrucción en `buildInvoicePrompt`; `isBoletaGate` desvía solo ante un `false` explícito.
- **Destino del no-boleta:** renombrar `[NO BOLETA] <nombre>` + mover a Revisión
  (`driveFailedFolderId`), sin Sheets ni DB. Nuevo contador `summary.notBoleta` y
  `m.result = "not_boleta"` (`reason`: `heuristic`/`ai`).

Para esto se separó `extractStep` en `textExtractStep` (pdf-parse, sin tokens) + `aiExtractStep`
(la IA), e insertaron los dos gates en el medio/después — habilitado por el pipeline Pipe &
Filter del H2.

**Alternativas descartadas:** triage solo post-IA (no ahorra tokens), solo heurístico (frágil),
clasificar en el scheduler (lee el PDF dos veces), tipo específico del no-boleta y carpeta/archivo
por edificio (YAGNI).

**Impacto / verificación:** 133 tests (clasificador + helper + 2 de caracterización nuevos:
not_boleta heurística e IA); typecheck + lint (0 errores) + build:jobs OK. Imágenes (sin texto)
sólo pasan por capa 2. Sin migración (isBoleta vive en el JSON de extracción). Spec/plan:
`docs/superpowers/{specs,plans}/2026-06-15-triage-clasificacion-documentos*`. **Deployado en
`efe83b8` (CI #82/#83).**

---

## 2026-06-15 — Refactor H2: `processDriveFile` descompuesto en un Pipeline de pasos

**Problema:** `processDriveFile` era la "God function" del proyecto (~630 líneas, ~13
dependencias, estado mutable compartido, 7 caminos de salida con side-effects en cada paso:
Drive, Sheets, DB). Es el código más crítico de producción y el más caro de tocar: cada
cambio futuro de reglas de extracción/matching/organización obligaba a razonar sobre toda
la función, con alto riesgo de regresión **silenciosa** (no rompe el build, rompe el
procesamiento de boletas). No existía ningún test del pipeline completo.

**Decisión (TDD + extracción incremental; refactor estructural SIN cambio de
comportamiento):** patrón **Pipe & Filter**.
- **Red de seguridad primero (innegociable):** nuevo `processPendingDocuments.job.test.ts`
  con 8 tests de caracterización que ejercitan `processDriveFile` con todas las deps
  mockeadas, cubriendo los 7 caminos (`ok`, `duplicate` por hash y por business key,
  `unassigned`, `no_amount`, `no_period`, `rate_limited`, `failed`) y verificando que la
  línea `[metrics]` se emite en cada uno. Pasan idénticos antes y después del refactor.
- **Seams testeables (Task 0):** los 2 `await import()` dinámicos
  (`resolveStatementsFolders`, `buildInvoiceFileName`) pasaron a deps **opcionales** del
  `ProcessingContext`, con default al import real → en prod el comportamiento es idéntico
  (mismo import lazy, mismo timing); en tests se inyectan mocks sin tocar Drive real.
- **Runner + contexto (Task 2):** nuevos `src/jobs/pipeline/context.ts` (tipos
  `PipelineContext`/`PipelineStep`/`StepResult` + `createPipelineContext`) y `runner.ts`
  (`runPipeline`: itera los pasos, corta al primer `halt` y **centraliza** el manejo de
  errores —`RateLimitError` → Pendientes / error genérico → Revisión— y la emisión **única**
  de `[metrics]` en su `finally`). Antes esa orquestación vivía dentro de `processDriveFile`.
- **14 pasos discretos (Task 3):** el cuerpo se partió en funciones
  `(ctx) => StepResult` (download+lock, dedup hash, extracción, gate sin-monto, saneo CUIT,
  dedup business key, limpieza clientNumber, assignment + fallback visual, canonización,
  gate unassigned, gate sin-período, Sheets, organización de archivo, persistencia). El
  estado que cruza pasos (buffer, extracted, isDuplicate, lspProvider, docText, assignment,
  fileHash, etc.) vive en el `PipelineContext`. `processDriveFile` quedó como **thin
  wrapper** que arma el contexto y llama al runner con la lista ordenada de pasos.

**Alternativas descartadas:** pasos como clases con estado propio (más ceremonia; se
prefirieron funciones, consistente con el estilo de `consortiumNormalizer.ts`); contexto
inmutable por paso (YAGNI: el pipeline es secuencial y de un solo hilo); refactorizar sin
tests (inaceptable para el camino crítico). Los pasos viven en el mismo módulo que
`resolveAssignment` (no en archivos sueltos) para no exportar helpers internos ni arriesgar
ciclos de import; `context.ts` solo hace `import type` del job (sin ciclo en runtime).

**Impacto / verificación:** `processDriveFile` pasó de ~630 líneas a un wrapper de ~20;
cada paso es ahora testeable por separado y los cambios futuros de reglas se acotan a un
paso. Sin cambio de comportamiento observable: **121 tests verdes** (8 de caracterización +
113 previos), typecheck + lint (0 errores; warnings pre-existentes) + build:jobs OK. Sin
migración. Archivos nuevos: `src/jobs/pipeline/{context,runner}.ts`,
`src/jobs/processPendingDocuments.job.test.ts`. Spec/plan:
`docs/superpowers/{specs,plans}/2026-06-14-refactor-h2-pipeline*`. **Deployado en `efe83b8`
(CI #79).** Validación e2e opcional del owner: `diag-boleta.ts` sobre boletas reales
(la lógica de matching/`resolveAssignment` no se tocó).

---

## 2026-06-14 — Robustez del worker ante cortes del pooler de Supabase (P1017): retry acotado

**Problema:** la DB (Supabase) se accede vía el pooler (PgBouncer, :6543), que cierra
conexiones idle y se reinicia → Prisma lanza `P1017 "Server has closed the connection"`. El
blindaje del 11/06 cubría solo `claimNextJob`; las queries dentro de `handleJob` —sobre todo
`finalizeJob`— no tenían retry. Un P1017 ahí dejaba el job en `PROCESSING` (zombie) hasta el
reaper (>30 min); si pegaba **tras** procesar OK, el reaper lo re-encolaba → **reproceso que
gasta cuota IA**.

**Decisión (TDD, 13 tests):** nuevo `src/lib/dbRetry.ts` que espeja el patrón
`callWithRetry` de `aiErrors.ts`:
- `isTransientDbError()`: matcher **acotado** a conexión transitoria (P1017/P1001/"server
  has closed the connection"/ECONNRESET/pool-timeout). **NO** reusa `isPrismaConnectionError`
  (demasiado amplio: matchea "database"/schema → reintentaría errores no transitorios e
  inútiles).
- `withDbRetry(fn, {retries:3, backoffMs:500, onRetry, sleep})`: reintenta solo ante
  transitorio; propaga los demás de inmediato; al agotar relanza el **error original**.

Aplicado en el worker (`jobWorkerMain.ts`) a `claimNextJob`, `client.findUnique` y
**`finalizeJob`** (el punto crítico: cierra la ventana de zombie). El scheduler NO se tocó
(ya es resiliente: try/catch por cliente + idempotente + intervalos). Nuevo log
`workerLog.dbRetry`.

**Alternativas descartadas:** keep-alive proactivo (YAGNI; el retry reactivo basta) y
`DIRECT_URL` para el worker (límite de conexiones directas de Supabase + no cubre eventos del
pooler). Reconsiderar keep-alive si el P1017 sigue frecuente post-deploy.

**Verificación:** 113 tests (13 nuevos); typecheck + build:jobs + lint OK. No se puede forzar
un P1017 real local → los unit tests del helper cubren la lógica y typecheck/build confirman
la integración. Sin migración. Spec:
`docs/superpowers/specs/2026-06-14-robustez-pooler-p1017-design.md`. Deploy: push (CI) +
rebuild del worker.

---

## 2026-06-14 — Factura común: el consorcio receptor se ancla en "CONSORCIO DE PROPIETARIOS", no en "Razón Social:"

**Problema (caso real "MAYO 2026.pdf", fue a Sin Asignar):** factura C de un
proveedor de desinsectación (SEBASTIAN ISMAEL CABRERA, CUIT 20-31791625-7) para el
CONSORCIO DE PROPIETARIOS de CORONEL DIAZ 1714. El proveedor matcheaba bien por
CUIT, pero el consorcio caía en `consortium_not_found`: la IA tomó la razón social
del EMISOR ("SEBASTIAN ISMAEL CABRERA") como consorcio. En facturas tipo C a
consumidor final el receptor no tiene CUIT real (figura `00-00000000-0`) → el match
SOLO puede ser por nombre, y el nombre extraído estaba mal.

**Causa raíz (doble):**
1. El prompt de facturas comunes (`buildInvoicePrompt`) le decía a la IA buscar el
   consorcio en etiquetas "Cliente:"/"Señores:"/"A nombre de:", pero NO mencionaba
   el marcador real de estas facturas: **"CONSORCIO DE PROPIETARIOS" + dirección**,
   que aparece SIN etiqueta. La única "Razón Social:" rotulada es la del emisor → la
   IA la tomaba como consorcio.
2. El refinamiento determinístico (`inferConsortiumFromText`) anclaba justamente en
   la primera línea "...social...:" del texto, que en una factura AFIP es SIEMPRE el
   **EMISOR**. Lejos de corregir, reforzaba el error. **Bug latente confirmado con
   test:** como `shouldReplace` reemplaza cuando el inferido es más largo que el
   actual, el refinamiento podía **DEGRADAR un consorcio bien extraído por la IA al
   nombre del emisor** (mandando otras facturas a Sin Asignar de forma silenciosa).

**Decisión (TDD, 5 tests nuevos con el texto real):**
- **Refinamiento:** `inferConsortiumFromText` ahora ancla en el marcador
  `CONSORCIO DE PROPIETARIOS` (y variantes "CONS. PROP.", "CONS DE PROP") en vez de
  "Razón Social:". Extrae la dirección que sigue (misma línea o las siguientes),
  limpiando el ruido del bloque receptor (condición IVA / "Consumidor Final", CUIT
  placeholder, localidad "C.A.B.A."). Si NO hay marcador de consorcio → devuelve
  `null` y **NO toca** lo que extrajo la IA (cierra el bug latente: nunca más
  devuelve el emisor). Se elimina el helper `normalizeConsortiumValue` (huérfano).
- **Prompt (`buildInvoicePrompt`):** se le enseña a la IA que el receptor suele
  figurar como "CONSORCIO DE PROPIETARIOS" + dirección (muchas veces sin etiqueta
  "Cliente:" y con `00-00000000-0` / "Consumidor Final"), y que esa dirección es el
  nombre del consorcio — nunca la "Razón Social:" del emisor.

**Alternativa descartada:** resolver solo vía prompt (depende de que la IA acierte,
sin red de seguridad). Se optó por la doble capa: prompt + refinamiento
determinístico, que resuelve el caso **aun si la IA se equivoca**.

**Verificación end-to-end:** se extendió `scripts/diag-boleta.ts` para inferir el
consorcio con el mismo refinamiento (sin IA) y correr el matching real contra la DB.
Con el PDF real: consorcio inferido `"CONSORCIO DE PROPIETARIOS CORONEL DIAZ 1714"`
→ MATCH **exacto** `"CORONEL DIAZ 1714"`; proveedor → MATCH por CUIT. 100 tests,
typecheck, build:jobs y lint OK. Sin migración.

**Acción del owner:** push (CI deploya) + recuperar "MAYO 2026.pdf" de Sin Asignar →
Pendientes para reproceso.

---

## 2026-06-13 — Falso positivo del router: "PERSONAL" suelto mandaba facturas a Telecom

**Problema (caso real, factura de IPLAN/NSS SA):** fue a Sin Asignar. El router
la detectó como **PERSONAL (Telecom)** por la frase `CÓDIGO DE GESTIÓN PERSONAL`
→ la trató como LSP, buscó el nro de cliente en LspServices, no lo encontró →
Sin Asignar. El emisor real es NSS SA (CUIT 30-70265297-5); el consorcio (Bme
Mitre 1225) matcheaba bien por CUIT.

**Causa raíz:** `identifyLSPProvider`/`isUtilityBill` detectaban Personal con
`includes("PERSONAL")` — palabra demasiado común (gestión personal, datos
personales, etc.).

**Decisión:** `isPersonalTelecom()` por **marcadores positivos** de la empresa
(TELECOM ARGENTINA — su razón social, siempre presente —, "Mi Personal",
"Personal Flow", "Personal.com", "Personal S.A."), no por la palabra suelta. Así
IPLAN cae como **factura común** → matchea consorcio + proveedor por CUIT.

**Nota:** se descartó la variante "excluir frases" (`/gestión\s+personal/`) porque
el `\b` de la regex se rompía con la `Ó` acentuada (no es word-char ASCII).

**Verificación:** 95 tests (3 nuevos, incl. el texto real de IPLAN); diag-boleta:
IPLAN ahora "factura común" + consorcio por CUIT. typecheck + build:jobs + lint OK.

**Acción del owner:** registrar NSS SA (hecho en el ALTA, falta **Sincronizar
directorio** para que entre a la DB) + push del fix del router.

---

## 2026-06-13 — Vista global de "Boletas entrantes" + borrado masivo

**Necesidad (owner):** una vista única de todas las boletas del cliente en orden
de entrada (como el Sheet), sin separar por edificio, para revisar y borrar las
últimas entradas sin ir consorcio por consorcio (caso inmediato: borrar las
boletas mal procesadas para reprocesarlas).

**Decisiones (con el owner):**
- **Selección múltiple** (checkbox por fila + "Borrar seleccionadas").
- **Al borrar → el PDF vuelve a Pendientes** (no a Revisión como el borrado por
  consorcio): al borrar la Invoice + la fila del Sheet no queda duplicado, así
  que el worker la reprocesa limpia. Ideal para corregir boletas mal procesadas.
- Columnas: Entrada · Consorcio · Proveedor · Monto · Período · Vto · Dup · PDF
  (sin tokens/IA, que son de monitoreo admin).

**Reutilización:** se extrajo el flujo de borrado a `lib/invoiceDeletion.ts`
(`resolveDeletionContext` + `deleteOneInvoice`) con **destino configurable**
(`pending` | `failed`). El endpoint DELETE por-consorcio ahora lo usa (destino
`failed`, comportamiento idéntico) y el borrado masivo también (destino
`pending`), resolviendo la config de Google **una sola vez** para todo el lote.

**Nuevo:** `GET /api/client/invoices` (lista global del cliente, orden de
entrada, paginada — equivalente cliente de `/api/admin/invoices`),
`POST /api/client/invoices/bulk-delete`, página `/admin/boletas` (reusa el CSS de
`admin/invoices`) e ítem "Boletas entrantes" en el sidebar del panel cliente.

**Verificación:** 92 tests; typecheck + build:jobs + next build + lint OK. Sin
migración. Deploy: push (CI).

---

## 2026-06-13 — CORRECCIÓN del modelo sindical: el CUIT del documento es del CONSORCIO, no del sindicato

**Error corregido (de la entrada del 12/06):** se asumió mal que las 3 boletas
sindicales compartían "el CUIT recaudador 30-54675623-4". **Falso.** Con más
muestras (BROWN) se ve que el CUIT cambia por edificio:
BOEDO 414 = 30-54675623-4, ALMIRANTE BROWN 706 = 30-52063978-7, etc. → **el CUIT
de la boleta es del CONSORCIO contribuyente** (a quien se imputa el gasto), no del
sindicato. Consecuencias del error: (a) el prompt **hardcodeaba**
`providerTaxId='30-54675623-4'` → toda boleta no-BOEDO matchearía el consorcio
equivocado; (b) se cargaron 3 proveedores (SUTERH/FATERYH/SERACARH) con el CUIT
de BOEDO 414 → 3 proveedores con el mismo CUIT (inválido) y además el CUIT de un
edificio.

**Modelo correcto (confirmado 6/6 contra PDFs reales + DB):**
- **Consorcio** → se matchea por el CUIT de la boleta (cada edificio el suyo) o
  por la dirección del campo `CONSORCIO:`.
- **Proveedor sindical** → se identifica por **NOMBRE** (SUTERH/FATERYH/SERACARH,
  del encabezado / formulario); **no tiene CUIT propio**.

**Cambios:**
1. `buildSindicalPrompt`: `providerTaxId: null` (ya no hardcodea CUIT); el CUIT
   del papel va a `allTaxIds` etiquetado como del consorcio.
2. Pipeline: `extractCuitsFromText` corre también para sindicales (CUIT del
   consorcio determinístico desde el papel).
3. `resolveAssignment`: sindicales **excluidas del fast-path LSP** (no resolver
   proveedor por CUIT — su CUIT es del edificio). Van al matching normal:
   consorcio por CUIT, proveedor por nombre.

**Acción de datos requerida (owner):** limpiar el CUIT mal cargado de los 3
proveedores (sino la columna providerTaxId del Sheet mostraría el CUIT de BOEDO en
todas las sindicales):
```sql
UPDATE "Provider" SET cuit = NULL
WHERE "clientId" = 'cmmuvg0hl0000kxl4ks5nrgxn'
  AND "canonicalName" IN ('SUTERH','FATERYH','SERACARH');
```

**Verificación:** 88 tests; diag-boleta 6/6 (cada edificio a su consorcio por
CUIT, cada proveedor por nombre exacto); typecheck + build:jobs + lint OK.

---

## 2026-06-12 — Regresión: boletas con cuota agotada caían a "SIN MONTO → Revisión" (clasificación de rate-limit por texto)

**Problema (reportado por el owner con el log exacto):** con la cuota agotada,
la boleta "eva peron manuel depto 32.pdf" cayó a OCR_ONLY → gate "SIN MONTO" →
movida a Revisión, en vez de volver a Pendientes. 2 boletas afectadas
(FB-158366.pdf y esa). Además el bug **anulaba el circuit breaker** (la señal
rate_limited nunca se emitía).

**Causa raíz:** al restaurar el barrido de modelos, su RateLimitError dice
**"sin cuota en los N modelo(s)"** (español). La cadena de IA pasa al pipeline el
**mensaje** (string) — el `instanceof` se pierde — y `isRateLimitError()` buscaba
"quota"/"429"/"too many requests": **"cuota" ≠ "quota"** → el `every()` fallaba →
OCR_ONLY. (El día anterior funcionaba porque el mensaje era el original de Google,
que contiene "429".)

**Fix (doble, TDD):**
1. **De fondo:** `AiExtractionChain` ahora clasifica el error **sobre el objeto**
   (instanceof) y pasa un flag `rateLimited` en el callback. El pipeline usa ese
   flag y NO re-parsea mensajes. Inmune a cambios de redacción/idioma.
2. **Defensa:** `isRateLimitError()` también reconoce "sin cuota"/"cuota agotada"
   (mensajes propios).

**Etiquetas de log corregidas (lo que disparó el reporte):**
- "📁 Movido a Fallidos" → "📁 Movido a Revisión (carpeta failed)" — la carpeta
  `failed` se llama Revisión para el negocio.
- "Resultado: SIN ASIGNAR" genérico → ahora `fileCompleted` acepta etiqueta real:
  "SIN MONTO → Revisión", "SIN PERÍODO ACTIVO → Revisión". (El contador
  `unassigned` sigue agrupando todo lo que va a revisión manual — sin cambio
  contable, solo claridad de logs.)

**Recuperación de las 2 afectadas:** mover en Drive de Revisión a Pendientes
(no se guardó Invoice → reproceso limpio). Tienen el sufijo " - SIN MONTO" en el
nombre (cosmético).

**Verificación:** 87 tests (2 nuevos reproduciendo el caso real); typecheck +
build:jobs + lint OK. Deploy: push (CI).

---

## 2026-06-12 — Circuit breaker de cuota IA: pausa automática del encolado hasta el reset

**Problema:** cuando se agotan TODOS los baldes diarios de IA (visto el 12/06 a
las 13:39: 5 modelos Gemini en 429 + OpenAI sin crédito), las boletas rebotan a
Pendientes y el scheduler las re-encola cada `intervalMinutes` → churn inútil
(descarga + parse + 6 llamadas 429 por rebote) hasta el reset de cuota.

**Decisión (pedido del owner, con un ajuste de diseño):** pausa automática con
vencimiento, **separada del toggle manual `enabled`** — apagar/encender el mismo
switch que usa el usuario mezclaría intenciones (¿lo apagó él o el sistema?).
- Nuevo campo `SchedulerState.aiPausedUntil` (migración
  `20260612000100_add_scheduler_ai_paused_until`).
- **Worker**: si una boleta termina `rate_limited` (429 en todos los proveedores
  → nuevo `summary.rateLimited`), setea `aiPausedUntil = próximo reset` y loguea.
- **Scheduler**: si `aiPausedUntil > now`, saltea el cliente SIN escanear Drive ni
  encolar (log `⏸️ Pausa por cuota IA...`). Al vencer, se reanuda solo — no hay
  que "encender" nada.
- **`lib/quotaReset.ts`** (TDD, 4 tests): próximo reset = medianoche
  America/Los_Angeles + 5 min de buffer, calculado con Intl (**DST-safe**: 07:00
  UTC en PDT, 08:00 UTC en PST — un offset hardcodeado estaría mal medio año).

**Fallback seguro:** si el update de la pausa falla, queda el comportamiento
anterior (rebote suave 1/intervalo). Si el 429 fuera transitorio (RPM, no RPD),
el costo del falso positivo es diferir hasta el reset — aceptable dado que la
señal exige TODOS los proveedores agotados.

**Verificación:** 85 tests; typecheck + build:jobs + next build + lint OK.
**Pendiente owner:** ejecutar la migración (procedimiento completo) + rebuild.

---

## 2026-06-12 — Soporte de boletas sindicales: SUTERH / FATERYH / SERACARH

**Problema:** el cliente recibe 3 tipos nuevos de boletas (aportes del sindicato
de encargados): SUTERH (F0201), FATERYH (F0101) y SERACARH (F0106, emitida por
FATERYH). Texto plano perfecto, campos rotulados, pero: las TRES comparten el
**mismo CUIT recaudador (30-54675623-4)** y el nombre del consorcio viene como
dirección con formato propio ("AVDA BOEDO 00410 /14-CIUDAD DE...").

**Patrón único identificado** (verificado contra 12 PDFs reales, 12/12):
- Familia: "TRABAJADORES DE EDIFICIOS DE RENTA Y HORIZONTAL" / FATERYH / SUTERH.
- Tipo: **código de formulario + razón social** — F0201/"SINDICATO UNICO"→SUTERH;
  F0106/"SERACARH"→SERACARH; F0101/"FEDERACION"→FATERYH. El CUIT NO distingue
  el tipo (es compartido), por eso NO se usa como discriminador.
- Campos rotulados fijos: `CONSORCIO:`, `PERIODO: MM/YYYY`, `Nº BOLETA:`,
  `VENCIMIENTO:`, `TOTAL A PAGAR:`; débito automático.

**Decisión (reusa el patrón LSP existente, sin schema nuevo):**
1. `identifyLSPProvider`: detección sindical ANTES del gate `isUtilityBill` (no
   son servicios públicos). 3 valores nuevos en `LSPProvider`.
2. `buildSindicalPrompt(tipo)`: prompt único para los 3 (solo varía la entidad):
   provider y providerTaxId fijos, dueDate de `VENCIMIENTO:`, amount de
   `TOTAL A PAGAR:`, observation = `PERIODO:`, clientNumber=null (→ NO entra al
   fast-path LspService), paymentMethod=DEBITO_AUTOMATICO.
3. **`matchProvider`: desambiguación por nombre ante CUIT compartido** (mejora
   GENERAL): si varios proveedores tienen el mismo CUIT, se elige el que coincida
   por nombre/matchNames; sin coincidencia → primero (estable). TDD (5 tests).

**Carga de directorio requerida (owner):** 3 proveedores con el mismo CUIT
30-54675623-4: SUTERH, FATERYH y SERACARH. Y `matchNames` en consorcios cuya
dirección sindical no normalice igual (verificado: BROWN/CALLAO/PUEYRREDON
matchean directo; **BOEDO 414 necesita matchNames `BOEDO 410`** porque la boleta
dice "AVDA BOEDO 00410 /14").

**Verificación:** 81 tests (8 extracción + 5 desambiguación nuevos); detección
12/12 en los PDFs reales; typecheck + build:jobs + next build + lint OK.

---

## 2026-06-12 — Normalización canónica de CUIT en TODO el sistema (lib/cuit.ts)

**Problema:** a raíz del caso Riobamba (ver entrada anterior), el owner pidió una
solución general, no puntual: los CUITs vienen en cualquier formato según el
origen (boleta sin guiones, DB con guiones, ALTA/Excel variable) y el sistema
tenía **6 copias** de normalizadores locales (`normCuit` en job, matching, scan,
panel, extraction, validación) + **3 puntos de entrada que guardaban el CUIT "como
venga"** (alta manual, import Excel, sync ALTA). El dedup del import usaba
`contains` con dígitos → no matcheaba contra CUITs guardados con guiones (bug).

**Decisión: fuente única `src/lib/cuit.ts`** (TDD, 13 tests):
- `cuitDigits()` → comparar SIEMPRE por dígitos.
- `formatCuit()` → guardar/mostrar SIEMPRE canónico `XX-XXXXXXXX-X`.
- `cuitsEqual()` → igualdad insensible al formato.
- `isValidCuit()` + `extractCuitsFromText()` (regex + checksum mod-11, movida acá).

**Aplicación sistémica:**
- Consolidadas las 6 copias → todas importan de lib/cuit.
- `extraction.ts`: providerTaxId Y `allTaxIds` (antes pasaba crudo) de la IA se
  normalizan a canónico en el schema Zod.
- Escrituras canónicas: alta manual de proveedores (dedup por dígitos en memoria),
  sync-directory (consorcios+proveedores), import Excel (dedup `contains` roto →
  `cuitsEqual`).
- Pipeline: merge IA+regex deduplica en formato canónico.
- `scripts/normalize-cuits-db.ts`: normaliza el stock existente (dry-run por
  defecto, `--apply` para ejecutar — lo corre el owner cuando quiera; no es
  urgente porque las comparaciones ya son por dígitos).

**Verificación:** 68 tests; e2e con el PDF real de Riobamba → MATCH por
`CUIT allTaxIds`; typecheck + build:jobs + next build + lint OK.

---

## 2026-06-12 — CUITs extraídos por regex+checksum del texto (no depender solo de la IA)

**Problema (caso real "Riobamba 1261 piso 1701.pdf"):** boleta clara, proveedor
correctamente cargado (LUZARDO JAVIEL JOSE EMILIO, 20-94037036-2) → terminó en
Sin Asignar. Cadena del fallo: la factura muestra el nombre de fantasía
("DESTAPACIONES RECOLETA") que no coincide con la razón social cargada → el único
puente es el CUIT → la IA listó UN solo CUIT en `allTaxIds`: el del consorcio y
**malformado** (12 dígitos, duplicó el verificador) → el saneo anti-alucinación lo
descartó → `allTaxIds` vacío → match por nombre imposible → Sin Asignar. Una
segunda boleta del mismo proveedor (JUFRE 37) cayó igual el mismo día.

**Causa raíz:** depender 100% de que la IA liste bien los CUITs, cuando los CUITs
están en texto plano extraíble de forma determinística.

**Decisión:** nueva función pura `extractCuitsFromText()` en
`lib/documentValidation.ts` (TDD, 8 tests): regex de candidatos (prefijos válidos
20/23/24/25/26/27/30/33/34 + 8 dígitos + verificador, separadores opcionales,
`\b` contra números más largos) + **verificación mod-11 del dígito verificador**
(elimina falsos positivos: números de comprobante, CAE, teléfonos). En el
pipeline (solo no-LSP, junto al saneo anti-alucinación) se unen los CUITs del
texto a los de la IA. Es seguro: el matching ya excluye el CUIT del consorcio.

**Verificación:** prueba end-to-end con el PDF real → `extractCuitsFromText`
devuelve ambos CUITs y `matchProvider` resuelve LUZARDO por
`CUIT allTaxIds (20940370362)`. Suite 63 tests + typecheck + build:jobs + lint OK.

**Impacto:** `documentValidation.ts` (+test), `processPendingDocuments.job.ts`
(merge + log). Deploy: rebuild del worker. Las boletas afectadas se recuperan con
"Reprocesar Sin Asignar". El script one-off del diagnóstico se generalizó en
`scripts/diag-boleta.ts` (ver entrada de normalización de CUIT).

---

## 2026-06-11 — Causa raíz REAL del throughput: cuota diaria por modelo del free tier. Se restaura el barrido de modelos

**Problema:** tras el fix del 10/06 (1 solo modelo), prod procesó 35 boletas a la
mañana y se frenó: 429 en flash-lite por el resto del día. El log de prod dio la
evidencia definitiva:
`Quota exceeded ... limit: 20, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier`.
**El free tier de Gemini tiene cuota DIARIA POR MODELO (20/día para
gemini-2.5-flash-lite).** Google la recortó — esa es la causa externa de la
regresión original ("antes 80/día, ahora ni la mitad").

**Corrección del análisis del 10/06:** el "barrido de 6 modelos = 6× consumo"
era INCORRECTO: un request rechazado con 429 **no consume cuota**. El barrido en
realidad **sumaba los baldes diarios independientes de ~6 modelos** (~6×20),
y por eso el sistema histórico llegaba a ~80/día. Al unificar a 1 modelo quedó
un solo balde de 20/día → el freno de hoy. Lo que SÍ era un bug real (y quedó
arreglado): las boletas con 429 se perdían en Sin Asignar y el mismo job
reintentaba en loop quemando tiempo.

**Decisión:** restaurar el barrido de modelos en `GeminiExtractorService`
(flash-lite → 2.5-flash → flash-latest → 2.0-flash → 2.0-flash-lite; se quita
2.5-pro, que suele tener free tier 0) **conservando el comportamiento anti-pérdida**:
si TODOS los modelos están sin cuota → `RateLimitError` → la boleta vuelve a
Pendientes. Se restaura también `workingModelName` (estática) para arrancar el
barrido en el último modelo que funcionó (evita re-pegar contra baldes agotados).
Se quita `callWithRetry` del servicio (el barrido lo reemplaza; la utilidad y sus
tests quedan en `lib/aiErrors`).

**Sobre frecuencia/batchSize:** con tope DIARIO, bajar el ritmo no suma cuota
(1 boleta/5min ≈ 80/día ya coincide con el techo de baldes agotables). No se
tocó la config. **Solución definitiva recomendada:** tier pago de Gemini (a este
volumen ~USD 1-2/mes con flash-lite) o crédito en OpenAI — el barrido es un
paliativo que depende de cuánta cuota gratis deje Google.

**Impacto:** `geminiExtractor.service.ts`. Verificación: typecheck, 55 tests,
build:jobs, lint OK. Deploy: rebuild del worker.

---

## 2026-06-11 — Boletas trabadas en Pendientes + jobs zombie + crash del worker por DB

**Problema (3 causas distintas confirmadas con logs + DB):**
1. **14 PDFs loopeando en Pendientes:** el scheduler saltea archivos que ya tienen
   Invoice (`if (existingInvoice) continue`) pero **no los saca de la carpeta** →
   loop infinito. Nunca entran al pipeline, así que tampoco van a Duplicados.
   Verificado en DB: esas Invoice son cargas válidas (603/603 con consorcio).
2. **2 jobs PROCESSING zombie** (11/05 y 20/05): el worker crasheó a mitad del job
   y el registro quedó PROCESSING para siempre, bloqueando el re-encolado. Sin
   Invoice → 2 boletas perdidas.
3. **Worker crasheaba ante cortes del pooler de Supabase** (P1017 "Server has
   closed the connection"): los cortes afectan a web+worker+scheduler en el mismo
   minuto (evento del lado de Supabase), pero solo el worker moría porque
   `claimNextJob()` estaba fuera del try/catch del loop.

**Decisiones:**
- **Scheduler mueve (no saltea) los ya-cargados:** archivo en Pendientes con
  Invoice existente → move a `duplicates` (o `scanned`) + log. Se eligió mover en
  el scheduler y NO encolarlo para que el pipeline lo deduplique: encolar
  implicaría descarga+extracción por archivo y cambiar la semántica del skip
  (riesgo de carreras). El move es directo, visible y barato.
- **Reaper de zombies en el scheduler:** PROCESSING con startedAt > 30 min →
  PENDING (attempts+1) o FAILED si attempts ≥ maxAttempts-1 (constante 3 espejo
  del schema; Prisma updateMany no compara columnas entre sí). 30 min es ~10× el
  peor caso real de una boleta. Corre por cliente en cada ciclo (updateMany barato).
- **Blindaje del worker:** try/catch + sleep alrededor de `claimNextJob` (Prisma
  reconecta solo en el siguiente poll). No se tocó el pooler/connection string.
- **Datos:** el UPDATE manual de los 2 zombies fue bloqueado por permisos del
  entorno; se descartó por innecesario — el reaper los recupera al deployar.

**Verificación previa (lectura DB):** el fix 429 del 10/06 quedó confirmado en
prod: 35 Invoice el 11/06, todas `gemini-2.5-flash-lite`, sin barrido de modelos.

**Impacto:** `scheduler.ts` (move-out + reaper + constantes), `logger.ts`
(`alreadyLoadedMoved`, `staleJobsRecovered`), `jobWorkerMain.ts` (blindaje).
Sin migración. **Deploy:** rebuild de scheduler y worker (owner).

---

## 2026-06-10 — Regresión 429 (rate-limit IA): 1 modelo + backoff + re-encolar

**Problema:** throughput cayó a la mitad por errores 429 (cuota) de Gemini.
Evidencia en `logs/2026-06-08_15-43_worker.txt`: cada fallo lista los **6 modelos
candidatos, todos con HTTP 429** ("failed for all candidate models"), y el mismo
job se reintenta por minutos. OpenAI también en 429.

**Causa raíz (confirmada por código + logs):** `GeminiExtractorService` barría una
lista de 6 modelos y, ante **cualquier** error, pasaba al siguiente. Un 429 es
rate-limit del **proyecto/cuota** → reintentar con otro modelo no ayuda y
**multiplica ×6** el consumo, agotando la cuota en pocas boletas. Las boletas con
429 caían a `OCR_ONLY` → Sin Asignar (se perdían).

**Hipótesis descartada:** el usuario atribuía la regresión a un "cambio de orden
del pipeline" (IA antes que OCR). Verificado con git: el orden texto→IA es el mismo
desde el seed inicial; la IA de texto siempre estructuró los campos (no hubo nunca
un parser de reglas que la reemplazara). Lo que el usuario recordaba como "IA solo
para imágenes" es la IA-Vision, que sigue reservada al fallback visual.

**Decisión:**
1. **1 modelo configurable** (no barrer 6). Default `gemini-2.5-flash-lite`,
   override por `GEMINI_MODEL`. Un modelo deprecado da 404 (no 429) → se propaga y
   la cadena cae a OpenAI/Claude.
2. **`callWithRetry`** (función pura, testeada): reintenta SOLO ante rate-limit con
   backoff acotado (1 reintento, 3s); al agotarse lanza `RateLimitError`. Errores
   normales se propagan sin reintentar.
3. **Re-encolar, no perder:** ante 429 de todos los proveedores, el pipeline lanza
   `RateLimitError`; el catch devuelve el archivo a Pendientes (desde Procesando) y
   completa el job OK (skipped, no failed). El **scheduler** lo re-encola en un
   ciclo posterior (no hay job PENDING/PROCESSING ni Invoice → crea uno nuevo).

**Por qué re-encolar vía scheduler y no worker-retry:** el worker reintenta de
inmediato (se vio el loop rápido en los logs), que vuelve a pegar 429 y quema
cuota. Dejar la boleta en Pendientes + job COMPLETED hace que el reintento sea
espaciado por `intervalMinutes` del cliente, dando tiempo a recuperar cuota. No
requiere tocar worker ni scheduler.

**Alternativas descartadas:** (a) "no usar IA cuando hay texto extraíble" (lo
pedido) — inviable: la IA es la que estructura los campos, no hay parser. (b)
worker-retry inmediato — causa el loop que quema cuota.

**Verificación:** 16 tests nuevos (TDD) + suite total 55; typecheck, lint (0
errores), build:jobs y next build OK.

**Impacto:** nuevo `src/lib/aiErrors.ts`; reescrito `geminiExtractor.service.ts`
(1 modelo + retry); `processPendingDocuments.job.ts` (detección 429 en flujo texto
e imagen + manejo en el catch). Sin migración de DB. **Deploy:** rebuild del worker
(lo hace el owner).

---

## 2026-06-10 — Refactor de patrones de diseño, Fase 3 parcial (tests + MatchStrategy)

**Problema:** (según `docs/reporte-patrones-diseno.md`) el proyecto no tenía
**ningún test runner**, lo que impedía refactorizar el núcleo con red de seguridad.
Además la lógica de matching (consorcio/proveedor) vivía inline en
`resolveAssignment`, sin tests y mezclada con acceso a datos y logging.

**Decisión:**
- **Test runner: Vitest 4** (no Jest). Razón: el proyecto es Vite-friendly/ESM +
  TypeScript; Vitest no necesita transpilación extra y resuelve los path aliases
  vía `vite-tsconfig-paths`. Se consultó la doc actual (Context7) para la config.
- **Caracterización antes de refactorizar:** se escribieron tests que documentan el
  comportamiento **real** (no el deseado). Esto reveló que el ejemplo
  `"BROWN ALMTE AV 708" → "ALMIRANTE BROWN 708"` del JSDoc/CLAUDE.md es aspiracional
  (el real es `"BROWN ALMIRANTE AV 708"`); el sistema funciona igual vía
  `matchNames`/fuzzy. Se documentó en el test en vez de "arreglar" el normalizer
  (habría cambiado comportamiento en una fase que debe preservarlo).
- **H3 — MatchStrategy:** extraer la lógica de matching a `lib/assignmentMatching.ts`
  (funciones puras). Se mantuvieron en el caller el logging y los mensajes de
  unassigned. El log puntual `providerCuitMatchesConsortium` se replicó con la
  condición exacta (`cuit OCR == consorcio` salvo match por allTaxIds) para
  preservar el comportamiento observable.

**TDD:** H3 se hizo test-first (RED con el módulo inexistente → GREEN extrayendo →
REFACTOR conectando `resolveAssignment`). Un caso de prueba inicial estaba mal
diseñado (matcheaba por "exacto" en vez de "fuzzy") — se corrigió el caso, no el
código.

**Pendiente — H2:** descomponer `processDriveFile` en pasos (Pipeline) NO se hizo:
requiere tests de caracterización del pipeline completo (mockear ~8 dependencias +
imports dinámicos), de alcance/riesgo alto. Se deja para una sesión dedicada. La DI
(H6) y H3 ya prepararon el terreno.

**Alternativas descartadas:** Jest (más setup en ESM/TS); migrar a la resolución
nativa de paths de Vite (el plugin funciona; evitar el riesgo de romper el runner
recién montado).

**Impacto (archivos):** nuevos `vitest.config.ts`, `src/lib/assignmentMatching.ts`
y 3 archivos `*.test.ts`; `package.json` (devDeps vitest/vite-tsconfig-paths +
scripts test); `processPendingDocuments.job.ts` (resolveAssignment usa el módulo de
matching).

---

## 2026-06-10 — Refactor de patrones de diseño, Fase 2 (capas + observabilidad)

**Problema:** (según `docs/reporte-patrones-diseno.md`)
1. El pipeline (`resolveAssignment`) accedía a Prisma **directo**
   (`prisma.provider/consortium/lspService.*`) aunque recibía repositorios como
   parámetros — violando la arquitectura por capas que el propio CLAUDE.md
   declara, y haciendo el pipeline imposible de testear sin DB real.
2. Cada método de repo hacía `const prisma = getPrismaClient()` (no inyectable).
3. 89 `console.*` conviviendo con un logger estructurado; los del
   `invoice.repository` escribían `clientId`/hash sin pasar por el Facade
   (riesgo de PII / formato inconsistente).

**Decisión:**
- **H6a — Inyección de Prisma:** constructor `(injectedPrisma?: PrismaClient)` +
  getter lazy `this.prisma`. Se eligió el getter lazy (en vez de evaluar
  `getPrismaClient()` en el default param del constructor) para **preservar
  exactamente** el comportamiento previo: la conexión se resuelve al usar el repo,
  no al instanciarlo (importa porque los repos se construyen en rutas/contexto que
  podrían no tener DB al import-time). Permite `new XRepository(mockPrisma)` en tests.
- **H6b — Mover queries a repos:** se creó `LspServiceRepository` (entidad propia)
  y métodos `findAllForMatching` en consortium/provider. `resolveAssignment` recibe
  ahora `lspServiceRepository` como parámetro. Se mantuvo el `.catch(() => {})` del
  `setProviderId` (no-fatal) en el caller. TypeScript valida que los `select`/
  `include` movidos devuelvan exactamente los campos que el pipeline usa.
- **H8 — Logging:** `repoLog`/`apiLog` en el Facade. Migración representativa
  (invoice.repository + scan); el resto es incremental. Los scripts de diagnóstico
  y el bootstrap conservan `console.*` a propósito (no son dominio).

**Alternativas descartadas:** poner los métodos de LspService dentro de
`ConsortiumRepository` (LspService es su propia entidad → repo propio). Migrar los
89 `console.*` de una (bajo valor/alto ruido → incremental).

**Verificación:** typecheck, lint (0 errores; 13 warnings pre-existentes),
build:jobs y next build (Compiled successfully) — OK. (El warning `EINVAL copyfile`
del output `standalone` es un issue conocido de Windows, ajeno a estos cambios.)

**Impacto (archivos):** nuevo `src/repositories/lspService.repository.ts`;
modificados los 5 repos (DI), `processPendingDocuments.job.ts` (resolveAssignment
sin Prisma directo), `lib/logger.ts` (repoLog/apiLog/shortLogId),
`invoice.repository.ts` y scan route (logging).

---

## 2026-06-10 — Refactor de patrones de diseño, Fase 1 (extractores IA, rutas, carga de cliente)

**Problema:** auditoría de patrones (`docs/reporte-patrones-diseno.md`) detectó
inconsistencias de diseño que generan deuda:
1. El fallback de extractores IA Gemini→OpenAI→Claude estaba **copiado** en el
   pipeline (`processPendingDocuments.job.ts`) y en la ruta de scan manual
   (`.../invoices/scan/route.ts`), y **ya había divergido** (uno logueaba con
   `pipelineLog`, el otro con `console.warn`): un bug latente, no solo estética.
2. Boilerplate de rutas API duplicado: auth-guard en 28 archivos, bloque
   `ZodError` literal en 12, respuestas de error ad-hoc con status a ojo.
3. El armado de `ProcessingClient` desde la DB (`findUnique({ select })` + mapeo)
   estaba duplicado en 8 lugares, varios con valores hardcodeados inconsistentes
   (`name: ""`, `batchSize: 10`, `intervalMinutes: 60`).

**Decisión:**
- **H1 (Strategy + Chain of Responsibility):** contrato `AiExtractor` +
  `AiExtractionChain` + `createAiExtractionChain()` en `src/services/aiExtraction.ts`.
  Los 3 servicios lo implementan. El logging por intento se inyecta vía callback
  `onAttempt` para que cada caller use el suyo sin duplicar la cadena. Se mantiene
  el módulo Gemini aparte para Vision/fallback visual (no son parte del fallback
  de texto).
- **H4 (HOF/Decorator):** `apiOk()`/`apiError()`/`withAuth()`/`withClientAuth()`
  en `src/lib/apiHandler.ts`. Migración incremental (pilotos: rubros, coeficientes).
- **H5 (Factory):** `loadProcessingClient(clientId)` en `clientProcessingConfig.ts`,
  que trae los valores reales del cliente (corrige los hardcodeos).

**Cambio de comportamiento deliberado (menor):** con `apiError`, los errores
**no-Zod** en los POST migrados ahora responden **500** (antes 400 indiscriminado).
Es más correcto (500 = error de servidor) y el shape `{ ok:false, error }` se
preserva, por lo que el frontend (que muestra el `error`) no se ve afectado.

**Alternativas descartadas:** (a) inyectar `params` en los HOF ya — se pospone;
los pilotos son rutas sin `params`. (b) Mover ya las queries del pipeline a los
repositorios (H6) — es Fase 2, requiere más cuidado.

**Verificación:** `npm run typecheck`, `npm run lint` (0 errores; 13 warnings
pre-existentes), `npm run build:jobs` y `npm run build` (next) — todos OK.

**Impacto (archivos):** nuevos `src/services/aiExtraction.ts`,
`src/lib/apiHandler.ts`; modificados los 3 extractores, el pipeline, la ruta de
scan, `clientProcessingConfig.ts`, rubros, coeficientes, y 7 rutas/libs migradas
a `loadProcessingClient`.

---

## 2026-06-08 — Logs de métricas del pipeline (instrumentación)

**Problema:** los logs sirven para leer una boleta pero no para analizar de forma
agregada (latencia IA, %OCR, costo, aciertos). Ej: una boleta tardó 2m41s en Gemini
vs 5s otra, solo visible restando timestamps a mano.

**Decisión:** una línea estructurada `[metrics] {JSON}` por boleta (additiva, no
reemplaza los logs legibles). Núcleo siempre **sin PII**; el bloque `values`
(extraído vs canónico) solo con `debugMode`. **Solo logging, sin migración.**
Emisión en `finally` → una sola línea por boleta en todos los caminos.

**Descartado:** persistir métricas en una tabla DB (requiere migración; YAGNI).
Diseño: `docs/superpowers/specs/2026-06-08-logs-metricas-pipeline-design.md`.

---

## 2026-06-07 — Rendiciones por edificio (statements): organización en Drive + llave anti-tokens

### Problema
Los inquilinos de cada consorcio necesitan ver qué se pagó y cuándo. Las boletas
OK terminaban todas mezcladas en "Escaneados", sin estructura navegable ni un
acceso público por edificio para rendir cuentas.

### Decisión
Organizar cada boleta y recibo en un **árbol invertido** en Drive:
`Rendiciones/[Edificio]/[Período]/`. La carpeta raíz (`statements`) la crea el
owner una vez; la app crea las subcarpetas. La carpeta de cada **edificio** se
comparte **pública** (anyone/reader) una sola vez y su link se guarda en
`Consortium.statementsFolderUrl` (el QR lo genera el usuario desde el panel).
Aplica al pipeline y a la carga manual; los recibos van junto a su boleta.

Decisiones puntuales:
- **Naming** legible y sin colisiones: boleta
  `PROVEEDOR - CONSORCIO - P06-2026 - NNNN.pdf`; sin N° → `SN + 6 del hash`.
  Recibo según tipo de pago (único / cuota X de N / parcial libre + monto).
- **Llave anti-tokens en el SCHEDULER** (no en el worker): el worker es el único
  que consume IA, así que la validación (carpeta `statements` + al menos un
  período ACTIVE a nivel cliente) se hace **antes de encolar**. Si falla → no se
  encola → **cero tokens**; los PDFs quedan en Pendientes y el próximo ciclo
  reintenta. La validación de carpetas reusa `validateClientProcessingConfig`
  (que ahora exige `statements`); el período se chequea con un `count` directo.
- **Caso puntual sin período** (un consorcio sin período, con el resto del
  cliente con período): el worker manda esa boleta a Revisión (`failed`) + aviso.
- **Duplicados**: sin cambios — siguen yendo a la carpeta Duplicados.
- **Cache en memoria** por proceso de los folderIds (edificio/período) para no
  repetir llamadas a Drive por cada boleta del mismo edificio en un ciclo.

### Alternativas descartadas
- **Validar el período en el worker**: gastaría tokens antes de descubrir que no
  hay período. Se cortó en el scheduler (0 tokens).
- **Compartir pública la carpeta raíz `statements`**: expondría todos los
  edificios juntos. Solo se comparte la carpeta de cada edificio (el período
  hereda el acceso al estar dentro).
- **Migrar boletas históricas**: fuera de alcance; aplica de ahora en más.
  "Escaneados" queda como histórico de boletas viejas.

### Impacto
Migración `20260607000100_add_consortium_statements_folder`
(`Consortium.statementsFolderId/Url`). Nuevos: `src/lib/statementsNaming.ts`,
`src/services/statementsFolders.service.ts`, `scripts/test-statements-naming.ts`.
Modificados: schema, `client.types.ts`, `clientProcessingConfig.ts`,
`googleDrive.service.ts` (`renameFile` + `shareFolderPublic`),
`processPendingDocuments.job.ts` (+ `runProcessingCycle.ts`, `jobWorkerMain.ts`),
`scheduler.ts` + `logger.ts`, carga manual (`invoices/route.ts`), recibo
(`invoices/[invoiceId]/receipt/route.ts`), purga (`clients/[id]/purge/route.ts`)
y el panel (`admin/consortiums/page.tsx`). Spec completo en
`docs/superpowers/specs/2026-06-05-rendiciones-por-edificio-design.md`.

---

## 2026-06-04 — Duplicados: consistencia DB↔Sheets (no persistir en DB)

### Problema
El usuario reportó que la boleta RIVADAVIA 4243 (`0002-00330905`) estaba en la
DB pero no en Sheets, y pidió "ajustar la consistencia entre DB y Sheets".

### Investigación (systematic-debugging, read-only)
Se creó `scripts/diag-sheets-consistency.ts` para comparar la hoja contra la
DB. Hallazgos:
- **No había bug de inserción:** RIVADAVIA SÍ estaba en Sheets (última fila,
  523). El reporte fue un falso negativo (no se scrolleó hasta el fondo).
- `insertRow` sano: 0 gaps, 0 filas fantasma.
- La diferencia real: Sheets 522 filas de datos vs DB 499 = **23 de más**, que
  corresponden a **22 boletas duplicadas** (`isDuplicate=YES`) que el pipeline
  escribe en Sheets pero NO en DB (comportamiento documentado), + 1 fila
  huérfana suelta.

### Decisión
A pedido del usuario: **los duplicados ya no se escriben en Sheets** (de ahora
en más), para mantener la planilla 1:1 con la DB. Además, carpeta opcional
`driveFoldersJson.duplicates`: si está, el PDF duplicado se mueve ahí; si no,
sigue yendo a Escaneados. **Lo ya registrado en Sheets no se toca.**

### Alternativas descartadas
- **Persistir los duplicados en la DB** (para que DB tenga lo mismo que
  Sheets): se descartó por dos razones de peso:
  1. Choca con el unique `uq_invoice_business_key` (boleta+CUIT+vto+monto) →
     requeriría una migración que **elimina esa salvaguarda de integridad**.
  2. Inflaría el "TOTAL PERÍODO" (suma de invoices) con las repetidas →
     liquidaciones incorrectas, salvo filtrar `isDuplicate` en todos los
     cálculos (más superficie de error).
- **Limpiar los 22 duplicados actuales:** el usuario prefirió dejarlos; el
  cambio aplica solo hacia adelante.

### Impacto
- `processPendingDocuments.job.ts`: `insertRow` solo si `!isDuplicate`;
  movimiento a `driveDuplicatesFolderId` (fallback Escaneados); nuevo campo en
  `ProcessJobConfig`.
- `clientProcessingConfig.ts` (`ResolvedFolders` + `resolveFolders`) y
  `client.types.ts` (`ClientDriveFolders.duplicates`).
- `runProcessingCycle.ts` y `jobWorkerMain.ts`: propagan `driveDuplicatesFolderId`.
- Sin migración de schema. `scripts/diag-sheets-consistency.ts` queda como
  herramienta de diagnóstico read-only.

---

## 2026-06-05 — Carga manual: deduplicación (hash real + bloqueo)

### Problema
En producción, la misma boleta cargada manualmente dos veces entró dos veces
(DB + Sheets). Diagnóstico con datos reales (cliente MorinigoAdm,
boleta MATAFUEGOS):
- Registro 1: `0005-00009460`, hash `cab4d2f5…`
- Registro 2: `00005-00009460`, hash `f087a0da…`

Dos candados de la DB fallaron:
1. **Hash:** el endpoint manual generaba `documentHash` con `Date.now()` → único
   en cada carga, aunque el PDF fuera idéntico. El unique `uq_invoice_document_hash`
   nunca lo frenaba.
2. **Business key:** la IA leyó el N° distinto (`0005` vs `00005`, un cero a la
   izquierda) → `boletaNumberNorm` distinto → el unique `uq_invoice_business_key`
   tampoco lo frenó. Además, la carga manual no verificaba duplicados (a
   diferencia del pipeline).

### Decisión
La carga manual ahora deduplica como el pipeline, **antes** de subir a Drive o
guardar:
1. **Hash real del binario** del PDF (`repo.computeDocumentHash(buffer)`), no un
   hash con timestamp. Sin PDF, hash determinístico de los datos de negocio (sin
   `Date.now()`). Así el mismo archivo da el mismo hash aunque la IA varíe los
   datos extraídos.
2. Verificación por **hash** (`findDuplicateByHash`) y por **business key**
   (`findDuplicateByBusinessKey`). Si existe → **409** con mensaje claro
   ("Esta boleta ya fue cargada" / "Ya existe una boleta con el mismo N°, CUIT,
   vencimiento y monto"). NO se guarda ni se sube a Drive.

### Alternativas descartadas
- **Normalizar ceros a la izquierda en `boletaNumberNorm`** (para que `0005` y
  `00005` se consideren iguales): se descartó por ahora — modifica la
  deduplicación global (pipeline) y los datos históricos. El hash real del
  binario ya cubre el caso real (mismo PDF). Queda como mejora futura.
- **Marcar como duplicado en vez de bloquear** (como el pipeline): se prefirió
  bloquear con error, porque la carga manual es una acción explícita del usuario
  y el feedback inmediato es más claro.

### Impacto
- `src/app/api/client/consortiums/[id]/invoices/route.ts`: hash real, dedup por
  hash + business key, respuesta 409, lectura del PDF reordenada (una sola vez,
  antes de dedup/upload). Se eliminó `import { createHash }` (ya no se usa).
- Sin migración.

---

## 2026-06-05 — Inserción en Sheets: `values.update` → `append` + INSERT_ROWS

### Problema
El usuario aplicaba un filtro en la hoja (rango fijo, ej. A1:U523). Al cargar
una boleta nueva, la fila aparecía en la hoja (fila 524) pero el **filtro no la
mostraba** ni al refrescar. Causa: `insertRow` escribía con `values.update` en
una celda calculada (`length+1`) — una celda **fuera del rango del filtro**, no
una inserción de fila. Los filtros básicos no se autoexpanden ante escrituras
fuera de su rango.

### Decisión
Reescribir `GoogleSheetsService.insertRow` para usar
`spreadsheets.values.append` con `insertDataOption: INSERT_ROWS`
(confirmado en la doc oficial de la API v4). `append` detecta la "tabla" lógica
en el rango y agrega después de la última fila; `INSERT_ROWS` **inserta una fila
física** dentro de la tabla, por lo que los rangos asociados (filtro básico,
etc.) se expanden automáticamente.

Beneficios colaterales (también resuelven riesgos detectados en el debugging
del 2026-06-04):
- **Atómico:** Google maneja la posición de la fila → sin race conditions entre
  worker y carga manual (antes ambos podían leer el mismo `length` y pisarse).
- **Inmune a filas fantasma:** ya no se cuenta `values.length`.

### Alternativas descartadas
- **Tabla nativa de Sheets** (del lado del usuario): se autoexpande siempre,
  pero es config manual por hoja/cliente. Queda como respaldo si algún filtro
  básico tuviera un caso límite.

### Impacto
- `services/googleSheets.service.ts`: cuerpo de `insertRow` (de get+update a
  append). Afecta pipeline (`processPendingDocuments`) y carga manual. Sin
  cambio de firma ni de contrato (`InsertRowResult` igual). Sin migración.

---

## 2026-06-04 — Crear archivos en Drive con service account (Unidad Compartida)

### Problema
Al guardar el PDF de la carga manual, Drive devolvía:
`Service Accounts do not have storage quota`. Las service accounts **no tienen
cuota propia** → no pueden CREAR archivos en "Mi unidad". El pipeline
automático nunca lo sufrió porque **solo mueve/lee** archivos que el usuario
sube a `pending` (mover no consume cuota); nunca crea. La carga manual sí crea
(sube el PDF desde la PC) → choca con el límite. El feature de recibos tiene la
misma limitación latente.

### Decisión
**Usar una Unidad Compartida (Shared Drive).** Las carpetas del cliente viven
en una unidad compartida y la SA es miembro (rol Administrador de contenido) →
puede crear archivos ahí (la cuota es de la organización). El código ya
soportaba Shared Drives (`supportsAllDrives` + `includeItemsFromAllDrives` en
todos los métodos de `GoogleDriveService`), así que **no requirió cambios** —
solo mover las carpetas a la unidad. **Los IDs de carpeta no cambian al mover**,
así que `driveFoldersJson` siguió válido. MorinigoAdm: unidad "Control de
Boletas y Pagos".

Además se agregó **soporte opcional de domain-wide delegation**
(`impersonateEmail` en `googleConfigJson` o env `GOOGLE_IMPERSONATE_EMAIL` →
`subject` en el JWT de Drive), por si algún cliente prefiere delegación en vez
de Unidad Compartida. Retrocompatible: sin valor, comportamiento idéntico al
anterior.

### Alternativas descartadas
- **Delegación de dominio como única vía:** requiere super admin del Workspace
  del cliente (no se tenía en `contacto@morinigoadm.com`) y otorga a la SA el
  poder de impersonar a **cualquier** usuario del dominio — fricción y riesgo
  altos, sobre todo para vender a terceros. Queda como opción, no como default.

### Impacto
- `services/googleDrive.service.ts`: `subject` opcional en el JWT.
- `types/client.types.ts`: `ClientGoogleConfig.impersonateEmail`.
- `lib/clientProcessingConfig.ts`: `resolveGoogleConfig` propaga el campo.
- `config/env.ts`: `GOOGLE_IMPERSONATE_EMAIL` opcional.
- Sin migración. Config operativa: mover carpetas a la Unidad Compartida +
  agregar la SA como miembro.

---

## 2026-06-02 — Carga asistida: guardar el PDF en Drive + warnings visibles

### Problema
Al cargar una boleta desde el modal "Cargar boleta", el PDF que se sube se
usaba **solo para escanear datos con IA y luego se descartaba**. La boleta se
creaba en la DB sin `sourceFileUrl` ni `driveFileId`: la columna ARCHIVO
quedaba en "—" y la celda de URL (columna K) en Google Sheets vacía. El
usuario reportó "cargué la boleta pero no veo la URL de la imagen".

Además, el insert a Google Sheets en la carga manual estaba envuelto en un
`try/catch` que **solo hacía `console.warn`**: si fallaba, la boleta quedaba
en la DB pero no en la planilla, sin ninguna señal para el usuario (fallo
silencioso).

### Decisión
1. **Subir el PDF a Drive en la carga asistida.** El endpoint
   `POST /api/client/consortiums/[id]/invoices` ahora acepta
   `multipart/form-data` además de JSON. Si viene el campo `pdf`:
   - Valida tamaño (≤15MB) y magic bytes (`isPdf`).
   - Lo sube a `folders.scanned` (fallback `folders.receipts`) con
     `GoogleDriveService.uploadFile` — carpeta plana, igual que donde el
     pipeline deja las boletas procesadas, para que "Ver PDF" funcione igual.
   - Guarda `driveFileId` + `sourceFileUrl` en la Invoice y escribe la URL en
     la columna K de Sheets (antes era `null`).
   - El front (`page.tsx`) manda FormData solo si hay archivo; si no, sigue
     mandando JSON (sin cambios para cargas sin PDF).
2. **Hacer visibles los fallos de Drive y Sheets.** La boleta se guarda en la
   DB aunque Drive o Sheets fallen (sería peor perderla), pero ahora el
   endpoint devuelve `driveWarning` y `sheetsWarning`, y la UI los muestra
   como toast. Si todo va bien, confirma "Boleta cargada y enviada a Google
   Sheets".

### Alternativas descartadas
- **Endpoint separado para subir el PDF tras crear la boleta** (2 requests):
  requeriría re-buscar la fila recién insertada en Sheets para completar la
  columna K. Integrar el upload en el endpoint principal inserta la fila con
  la URL de una sola pasada — más simple y sin búsqueda posterior.
- **Abortar la creación si Drive/Sheets fallan**: se descartó; es peor perder
  la boleta que tenerla sin PDF/fila. Se prefiere guardar + avisar.

### Impacto
- `src/app/api/client/consortiums/[id]/invoices/route.ts`: parsing
  multipart+JSON, resolución de config una sola vez, upload a Drive,
  `driveWarning`/`sheetsWarning` en la respuesta.
- `src/app/admin/consortiums/page.tsx`: envío FormData con PDF, manejo de
  warnings en toast.
- Sin cambios de schema (campos `driveFileId`/`sourceFileUrl` ya existían).

---

## 2026-06-02 — Columna "Estado" → "Origen" en la tabla de boletas

### Problema
La columna "Estado" de la tabla de boletas mezclaba conceptos heterogéneos:
"Manual" (origen de carga), "Duplicado" (validación) y "OK" (procesada por el
pipeline). El "OK" no aportaba información clara y el conjunto era confuso.

### Decisión
Renombrar la columna a **"Origen"** y mostrar solo el medio de carga:
**Manual** (cargada a mano desde la UI) o **Automática** (procesada por el
pipeline desde Drive). El flag de duplicado ya se ve en la stat card
"Duplicados" del header; las boletas duplicadas además no se persisten en DB,
así que la etiqueta casi nunca aparecía en la tabla.

### Impacto
- `src/app/admin/consortiums/page.tsx`: header `<th>` y celda de la columna.

---

## 2026-06-02 — Validación robusta de pertenencia al consorcio en carga manual (scan)

### Problema
Al cargar una boleta desde la UI del consorcio ("Cargar boleta" → scan con
IA), el endpoint `POST /api/client/consortiums/[id]/invoices/scan` validaba
si la boleta pertenecía al consorcio seleccionado. **Disparaba falsos
positivos** ("esta boleta no pertenece al consorcio elegido") cuando la
boleta SÍ era del consorcio correcto.

Causa raíz: la validación era mucho más débil que el matching del pipeline
principal. Solo hacía **igualdad exacta del nombre normalizado** del campo
`consortium` extraído por la IA contra el seleccionado:

```ts
const extractedNorm = normalizeConsortiumName(extractedConsortiumRaw);
const selectedNorm  = normalizeConsortiumName(selectedConsortium.canonicalName);
if (extractedNorm !== selectedNorm) consortiumMismatch = true;
```

Esto fallaba en varios escenarios reales:
- La IA ponía el **nombre del proveedor** en el campo `consortium` →
  `extractedNorm` ≠ `selectedNorm` → falso aviso (el caso reportado).
- Diferencias por abreviaturas / ceros a la izquierda / sufijos numéricos
  de LSP que el fuzzy match sí resuelve.
- No usaba el **CUIT** (`allTaxIds`) — la señal más fuerte y la que el
  pipeline usa como Intento 0.
- No usaba **alias/matchNames**.

El pipeline (`processPendingDocuments.job.ts`) ya resolvía esto con 4
niveles (CUIT → exacto → fuzzy → alias), pero el scan no compartía esa
lógica.

### Decisión
Reescribir la validación del scan para **reutilizar el mismo matching de 4
niveles** del pipeline, con una filosofía de **minimizar falsos positivos**:

- Se agregó `findMatchingConsortium(allTaxIds, rawConsortium, consortiums)`
  en `scan/route.ts` que replica el orden CUIT → exacto → fuzzy → alias y
  devuelve el consorcio que matchea (o null).
- **Solo se declara mismatch si la boleta matchea claramente con OTRO
  consorcio del cliente.** Tres casos:
  - Match al consorcio seleccionado → pertenece, no se avisa.
  - Match `null` (indeterminado: IA confundió campos / OCR pobre) → **no se
    bloquea** (el usuario eligió el consorcio a propósito).
  - Match a otro consorcio → error de carga real, se avisa con su `rawName`.

### Alternativas descartadas
- **Extraer el matching a un módulo compartido** entre pipeline y scan: más
  limpio a largo plazo, pero el pipeline tiene efectos colaterales (logging,
  retorno de `unassignedReason`, etc.) acoplados. Se optó por replicar solo
  la parte pura de matching en el scan para no arriesgar el pipeline en
  producción. Candidato a refactor futuro.
- **Mantener el aviso cuando no se puede determinar**: se descartó porque es
  exactamente la fuente de los falsos positivos reportados.

### Impacto
- `src/app/api/client/consortiums/[id]/invoices/scan/route.ts`:
  - Nuevos helpers `normCuit` y `findMatchingConsortium`.
  - Imports `consortiumFuzzyMatch`, `consortiumAliasMatch`.
  - `select` del consorcio seleccionado ampliado con `cuit` + `matchNames`.
  - Bloque de validación reescrito.
- Sin cambios de schema ni migraciones. La respuesta del endpoint mantiene
  el mismo contrato (`consortiumMismatch`, `foundConsortium`).

---

## 2026-05-25 — Eliminación de boletas y pagos desde la UI

### Problema
La UI permitía cargar boletas y pagos pero no había forma de eliminar
errores desde el panel: ni una boleta cargada con datos incorrectos, ni
un pago registrado por equivocación. La única alternativa era pedir
acceso directo a Supabase. Con la operación a escala (varios consorcios
× varios meses) esto se volvió bloqueante.

Cualquier "eliminar" toca 3 sistemas que pueden divergir:
- DB (Prisma): `Invoice`, `Receipt`, `Payment`.
- Google Drive: PDF de la boleta + PDF del recibo (si hay) +
  comprobante del pago (si hay).
- Google Sheets: fila de la boleta + columnas Q/R/S/T/U que reflejan el
  estado del pago.

### Decisión
**Dos endpoints DELETE con flujo Drive → Sheets → DB** (las APIs externas
primero; si fallan, se aborta antes de tocar DB para evitar inconsistencias).

#### Eliminar boleta — `DELETE /api/client/consortiums/[id]/invoices/[invoiceId]`
- **Validaciones**:
  - Pertenencia: boleta del cliente y del consorcio (404 si no).
  - **Bloqueo si tiene pagos** (`_count.payments > 0`): responde 409 con
    "Eliminá los pagos primero". Evita borrados accidentales con
    historial de pagos.
- **Efectos** (orden):
  1. Mueve el PDF en Drive de `scanned` → `pending`. Si no estaba en
     scanned, intenta desde `unassigned`. Si no estaba en ninguna,
     usa la primera carpeta padre que devuelva `getFileParents`. Si el
     archivo no tiene padre conocido (raro), no se mueve. El archivo
     **no se borra** — vuelve a la cola para reprocesar.
  2. Si la boleta tiene un `Receipt` asociado (recibo manual subido
     desde la UI hace tiempo), manda el PDF del receipt a la papelera
     de Drive (no es parte del pipeline, no hay carpeta a la que
     "mover", así que se trashea).
  3. Borra la fila completa en Sheets con `deleteDimension`
     (`spreadsheets.batchUpdate`). NO la blanquea — la fila desaparece
     y las de abajo suben.
  4. Borra `Invoice` + `Receipt` de DB en una transacción Prisma.
- **Atomicidad**: si Drive o Sheets fallan, se responde 502 sin tocar
  DB. La única ventana de inconsistencia es si Sheets falla DESPUÉS de
  Drive (el archivo ya se movió pero la fila sigue) — aceptable porque
  la fila queda con datos válidos y el user puede reintentar.

#### Eliminar pago — `DELETE /api/client/invoices/[id]/payments/[paymentId]`
- **Validaciones**:
  - Pertenencia: payment del cliente y de la invoice (404/403/400).
  - **Solo el último pago**: si no es el `[0]` de
    `orderBy: { createdAt: desc }`, responde 409. Esto es restricción
    heredada del `PaymentRepository.deletePayment` original — borrar
    cuotas intermedias rompería el orden de installmentNumber y
    requeriría reordenar todo. Mantener simple.
- **Efectos** (orden):
  1. Si el pago tenía comprobante (`driveFileId`), lo trashea en Drive.
  2. Calcula sin tocar DB: `newRemaining = invoiceAmount - sum(otros pagos)`
     y si quedan otros pagos `prevPayment = allPayments[1]`.
  3. Actualiza Sheets cols N/P/Q/R/S/T/U:
     - Si `willStillHavePayments`: escribe el resumen del `prevPayment`
       (fecha, importe acumulado, medio, comprobante URL, installmentNumber).
     - Si no quedan pagos: limpia las 5 celdas y deja estado "Impago".
  4. Borra `Payment` + actualiza `Invoice.isPaid` / `remainingBalance`
     en transacción Prisma.
- **NO se revierte `periodId`** si la boleta había sido reasignada al
  mes siguiente por pago parcial. Esto evita complicar la lógica con
  un "deshacer" del bookkeeping; el usuario puede ajustar manualmente
  si necesita.

#### UI
- **Botón 🗑 + confirm inline** (mismo patrón visual que LSP services
  para consistencia). Estados locales `confirmDeleteInvoiceId` y
  `confirmDeletePaymentInvoiceId` se resetean al cambiar de consorcio.
- **Boletas**: nueva columna ACCIONES al final (no se reúsa la columna
  PAGO porque esa es estado visual).
- **Pagos**: el 🗑 va al lado de Cuotas/Ver pagos en la columna
  ACCIONES existente. Solo aparece si la invoice tiene `isPaid` o
  `remainingBalance < amount` (= tiene al menos un pago).
- Feedback via toasts (`toolbarInfo` / `toolbarError`).

### Alternativas descartadas
- **Borrar archivo de Drive en vez de trashear** (`files.delete`):
  irreversible. Trash es recuperable desde la UI de Drive. Aceptamos
  el costo de cuota de storage temporal a cambio de seguridad.
- **Permitir borrar cuotas intermedias del medio**: rompería el orden
  de `installmentNumber` y requeriría reordenar los siguientes. Mucho
  código por un caso de uso marginal.
- **Cascade delete de boleta con pagos**: tentador pero peligroso —
  un click accidental borraría boletas con historial completo. Forzar
  al user a borrar pagos primero es un speed bump deliberado.
- **Borrar fila de Sheets blanqueándola en vez de `deleteDimension`**:
  dejaría filas vacías intermedias rompiendo el orden visual y
  confundiendo cualquier consumer downstream (sync, reportes).
- **DELETE atómico con rollback de Drive**: requeriría un "untrashFile"
  si la DB falla después de trashear. Posible (`trashed: false`) pero
  complejidad alta para un edge case raro.
- **Permitir a ADMIN además de CLIENT**: ampliaría la superficie de
  error. Si un cliente necesita ayuda, contacta soporte y se opera
  por DB directa.

### Impacto
- `src/services/googleDrive.service.ts`: `trashFile()`, `getFileParents()`.
- `src/services/googleSheets.service.ts`: `findInvoiceRow()` (helper
  extraído del lookup que ya tenía `updateInvoicePaymentInfo`),
  `deleteInvoiceRow()` (usa `getSheetId` + `deleteDimension`).
- `src/app/api/client/consortiums/[id]/invoices/[invoiceId]/route.ts`:
  nuevo (DELETE).
- `src/app/api/client/invoices/[id]/payments/[paymentId]/route.ts`:
  reescrito (antes solo llamaba al repo; ahora orquesta Drive + Sheets
  + DB).
- `src/app/admin/consortiums/page.tsx`: states
  `confirmDeleteInvoiceId` / `deletingInvoiceId`, handler
  `handleDeleteInvoice`, columna ACCIONES en tabla Boletas, prop nueva
  `onEliminarUltimoPago` para PagosView con confirm inline.
- Mejora: el cliente puede recuperarse de errores sin pedir acceso a DB.
- Riesgo residual: si el usuario borra una boleta + pago + comprobante y
  10 segundos después se arrepiente, el archivo está en trash de Drive
  pero la fila de Sheets ya se eliminó. La fila no se restaura — hay
  que recargar el PDF.

---

## 2026-05-25 — Stats inline + buscador en pestaña Pagos

### Problema
1. Las 4 stat cards de la pestaña Boletas (Boletas, Total período,
   Duplicados, Rubros) estaban en un grid 4×1 con cada card en formato
   "label arriba, valor abajo" (font-size 22px para el valor) — ocupaban
   ~80px de altura aún cuando la info es densamente expresable en una
   línea.
2. La pestaña Pagos no tenía buscador. Si el usuario tenía 30 boletas
   en el período y quería pagar la de un proveedor específico, tenía
   que scrollear toda la tabla a mano.

### Decisión
1. **Stats Strip horizontal**: `.statsStrip` pasó de `display: grid;
   grid-template-columns: repeat(4, ...)` a `display: flex; flex-wrap:
   wrap; gap: 8px 22px`. Cada `.statCard` ahora es `inline-flex` con
   `align-items: baseline; gap: 8px`, mostrando label y valor en la
   misma línea. Valor reducido de 22px a 15px (más coherente con el
   tamaño inline). Padding del container reducido (10px 16px). En mobile
   (`<768px`) el gap y padding bajan; el `flex-wrap` ya maneja el
   reflow sin necesidad de media queries con `grid-template-columns`.
   Resultado: ~50px menos de altura para una info que era 100% lineal.

2. **Buscador en PagosView**: state local nuevo `search` (separado del
   `search` de Boletas — cada pestaña tiene su propio contexto). Filtra
   `allVisible` por `provider.includes(q) || boletaNumber.includes(q)`,
   case-insensitive. Reusa las clases CSS del buscador de Boletas
   (`.searchRow`, `.searchInput`, `.clearSearch`) — cero duplicación de
   estilos. Empty state diferencia "no resultados de búsqueda" vs "no
   hay boletas en el período". **Los totales del header se calculan
   sobre el subset filtrado**, decisión deliberada: al buscar un
   proveedor, el header muestra cuánto pagaste y cuánto debés a ese
   proveedor específico (más útil que mantener los totales del período
   completo cuando estás filtrando).

### Alternativas descartadas
- **State `search` compartido entre Boletas y Pagos**: tentador
  (escribir en una y pasar a la otra), pero confunde — el usuario
  filtra "Edesur" en Boletas para ver las facturas, cambia a Pagos
  esperando ver todos los pagos, y de repente está pre-filtrado. Cada
  pestaña tiene su contexto.
- **Stats como una línea sin background**: descartado, perdía la
  diferenciación visual del bloque.
- **Stats con separadores `·` entre items**: probado mental — queda
  menos legible que items separados por gap horizontal.

### Impacto
- `src/app/admin/consortiums/page.module.css`:
  - `.statsStrip` reescrita a flex.
  - `.statCard` reescrita a inline-flex baseline.
  - `.statLabel` letter-spacing reducido (0.12em → 0.08em) para que se
    lea mejor a tamaño inline.
  - `.statValue` font-size 22px → 15px.
  - Media queries antiguas con `grid-template-columns` reemplazadas.
- `src/app/admin/consortiums/page.tsx`:
  - PagosView: nuevo state `search`, filtro local `visibleInvoices`
    derivado de `allVisible`. JSX del buscador antes del header.
    Empty state condicional.
- Mejora UX: layout más compacto en Boletas, búsqueda funcional en
  Pagos, mismo widget y look-and-feel cross-pestaña.

---

## 2026-05-25 — Reorganización del detail header: período inline + LSP colapsable

### Problema
La vista de un consorcio en `/admin/consortiums` tenía dos problemas de
organización visual:
1. El **navegador de período** (`‹ Mes Año ›`) vivía debajo de la sección
   LSP, lo cual obligaba a hacer scroll cada vez que el usuario quería
   cambiar de mes — interacción frecuente que no merecía estar tan abajo.
2. La sección **Servicios públicos (LSP)** ocupaba ~5 renglones fijos
   (título + tabla con servicios + formulario de alta), aún cuando el
   usuario nunca interactúa con ella en sesiones normales (los servicios
   ya vienen cargados desde el archivo ALTA).

### Decisión
1. **Mover el navegador de período al `detailHeader`**, inline al lado del
   nombre del consorcio. Para esto se introdujo una nueva fila
   `.detailTitleRow` con `display: flex; gap: 18px; flex-wrap: wrap;`
   que contiene `<h2>` y `.periodNav`. El `CUIT:` queda debajo en la
   meta-línea como antes. En mobile el `flex-wrap` permite que el
   navegador caiga abajo si no entra al lado.
2. **Sección LSP colapsable** con estado local `lspCollapsed` (default
   `true` = cerrada). El `<h3>` se transformó en un `<button>`
   (`.lspToggle`) con:
   - Chevron `▸` (cerrado) / `▾` (abierto).
   - Título "Servicios públicos (LSP)".
   - Badge contador (`.lspToggleCount`) con la cantidad de servicios,
     solo visible si hay alguno. Permite ver de un vistazo si hay LSPs
     sin tener que expandir.
   - `aria-expanded` y `aria-controls` apuntando al div de contenido
     para a11y.
   El contenido (tabla + formulario) se renderiza condicionalmente con
   `{!lspCollapsed && ...}` — no se montan los inputs hasta que la
   sección esté abierta. Estado session-only (no persiste).

### Alternativas descartadas
- **Default LSP abierto**: descartado porque no resuelve el problema
  visual. Si el user lo quiere ver, expande en 1 click.
- **Default LSP abierto si hay servicios, cerrado si no**: lógica
  condicional con `useEffect` agrega complejidad sin un beneficio claro.
  Default cerrado uniforme es más predecible.
- **Periodo en su propia fila debajo del header (sin moverlo a inline)**:
  ahorraba algo de scroll pero seguía consumiendo altura vertical fija.
  Inline al lado del título reutiliza espacio horizontal disponible.
- **Animación de altura para el colapsado**: omitida por ahora — el
  contenido del LSP es variable (tabla + form) y animar `max-height`
  con valor desconocido es feo. Si el user pide animación, se evalúa.

### Impacto
- `src/app/admin/consortiums/page.tsx`:
  - Nuevo state `lspCollapsed` con default `true`.
  - JSX del `detailHeader`: nuevo wrapper `.detailTitleRow` con título +
    periodNav inline.
  - JSX del `lspSection`: `<h3>` → `<button .lspToggle>` con chevron,
    título y badge contador. Contenido envuelto en `<div .lspContent>`
    con render condicional `{!lspCollapsed && ...}`.
  - Eliminado el `<div .periodNav>` viejo que estaba abajo del LSP.
- `src/app/admin/consortiums/page.module.css`:
  - Nueva clase `.detailTitleRow`.
  - Nuevas clases `.lspToggle`, `.lspToggleChevron`, `.lspToggleCount`,
    `.lspContent`. `.lspTitle` simplificado (sin `margin-bottom`,
    ahora vive dentro del botón). `.lspSection` con `padding-top` y
    `padding-bottom` reducidos a 10px (menos aire vertical en
    estado colapsado).
- Mejora UX: menos scroll, menos ruido visual por default,
  cambio de período en 1 click sin perder contexto.

---

## 2026-05-25 — Eliminación del toolbar superior en /admin/consortiums

### Problema
La franja `<div className={styles.toolbar}>` arriba del contenido principal
de `/admin/consortiums` ocupaba ~50px de altura constantes en todas las
resoluciones, empujando hacia abajo la tabla de boletas/pagos. Después
de las iteraciones previas (botones del scheduler movidos al sidebar),
el toolbar quedó casi vacío: solo hamburger mobile + mensajes de feedback
+ toggle de tema. El usuario pidió eliminarlo para recuperar esa altura
para el contenido.

Restricciones a respetar:
1. El hamburger sigue siendo necesario en mobile/tablet (≤1024px) para
   abrir el sidebar lateral.
2. Los mensajes `toolbarInfo` / `toolbarError` se siguen seteando desde
   los handlers (Sincronizar, Proteger, etc.) y hay que mostrarlos en
   algún lado.
3. El toggle de tema ya existe en el panel principal (`/admin`).

### Decisión
1. **Eliminar el `<div className={styles.toolbar}>` completo**, incluidos
   `.toolbarLeft`, `.toolbarRight` y los wrappers internos. Las clases
   CSS del toolbar viejo (`.toolbar`, `.toolbarBtn`, `.themeToggle`,
   etc.) se dejan en `page.module.css` por si se reutilizan más adelante
   — no rompen nada y mantienen historial visible.
2. **Hamburger → botón flotante** (`.fabHamburger`): `position: fixed`
   top-left, `z-index: 48` (debajo del overlay del sidebar en z=49),
   `display: none` por default, `display: flex` con media query
   `max-width: 1024px`. Tamaño 40x40, sombra suave, icono ☰.
3. **Feedback → toast flotante** (`.toastContainer` + `.toastItem`):
   `position: fixed` top-right, `z-index: 60`, max-width 360px. Animación
   `toastSlideIn` (0.18s). Variantes `.toastInfoItem` (verde) y
   `.toastErrorItem` (rojo). En mobile (≤560px) el container ocupa el
   ancho completo. **Autodismiss** vía `useEffect` con `setTimeout`:
   4s info, 5s error. Antes los mensajes quedaban hasta la próxima
   acción y se acumulaba contexto stale.
4. **Toggle de tema → solo en /admin**. Eliminado el handler
   `handleToggleTheme`. El state `theme` se mantiene (sirve para
   aplicar `data-theme` al `<html>`) y se inicializa leyendo el
   atributo `data-theme` que haya dejado el panel principal al
   navegar:

   ```ts
   useEffect(() => {
     const current = document.documentElement.getAttribute("data-theme");
     if (current === "light" || current === "dark") setTheme(current);
   }, []);
   ```

   Esto fixea un bug latente: antes el theme se hardcodeaba a "dark" al
   montar `/admin/consortiums`, sobreescribiendo cualquier cosa que
   hubiera dejado `/admin`. Ahora respeta la preferencia del usuario.

### Alternativas descartadas
- **Mover hamburger al header "Edificios"**: descartado porque ocuparía
  ancho horizontal dentro del contenido (peor que el toolbar para mobile).
  El botón flotante es invisible en desktop (`display: none`) y no roba
  espacio del layout.
- **Mantener el toolbar solo para feedback**: descartado porque mantenía
  altura constante (~50px) aún cuando no hay mensajes — el toast solo
  toma espacio cuando hay algo que mostrar.
- **Persistir theme en localStorage**: tentador pero fuera del scope.
  El user solo pidió sacar el toggle local; el approach actual (leer
  data-theme al mount) cubre el caso real sin agregar storage handling.

### Impacto
- `src/app/admin/consortiums/page.tsx`:
  - Eliminado `handleToggleTheme` y todo el JSX del toolbar.
  - Nuevo `useEffect` para leer `data-theme` inicial.
  - Nuevos `useEffect` para autodismiss de `toolbarInfo` y `toolbarError`.
  - JSX del botón flotante y del toast container montados al inicio del
    page (afuera del contentCol para que `position: fixed` funcione bien).
- `src/app/admin/consortiums/page.module.css`:
  - Nuevas clases `.fabHamburger`, `.toastContainer`, `.toastItem`,
    `.toastInfoItem`, `.toastErrorItem`, keyframe `toastSlideIn`.
- Mejora UX: ~50px más de altura útil para la tabla, mensajes con
  autodismiss más modernos, theme respetado cross-page.

---

## 2026-05-25 — Fix NaN en totales de Pagos + consolidación de header

### Problema
En la pestaña Pagos, el header mostraba `Total del período: $ NaN`,
`Pagos del mes actual: $ 0,00` y `Gastos con saldo impago: $ NaN` aún
con boletas reales cargadas en el período. Causa raíz: Prisma serializa
`Decimal` como **string** en el JSON de respuesta del endpoint
`/api/client/consortiums/:id/invoices`. El `reduce` de los totales hacía
`sum + (inv.amount ?? 0)` — JavaScript evalúa `0 + "65000.26"` = `"065000.26"`
(string concat), y la siguiente iteración da `"065000.2665000.08"`, que
al pasar por `Intl.NumberFormat.format(...)` no parsea → `NaN`.

Por qué la columna IMPORTE de la misma tabla se veía bien: porque ahí
se llamaba `formatAmount(totalAmount)` con un valor único (string parseable
"65000.26"), no con el resultado de un reduce contaminado.

### Decisión
1. **Helper `toNum(v)`** dentro de `PagosView` que convierte string/number/null
   a número con guarda `Number.isFinite` (devuelve 0 si no es finito). Se
   aplica a todos los `inv.amount` y `inv.remainingBalance` antes de sumar.
2. **Recalcular "Pagos registrados"** con semántica correcta:
   `amount - remainingBalance` por boleta. El cálculo anterior sumaba
   `inv.amount` solo de las marcadas `isPaid` → ignoraba pagos parciales
   en cuotas (no se reflejaban hasta que la boleta estaba 100% pagada).
3. **Eliminar "Total del período"** del header de Pagos: ya está visible
   como stat card en la pestaña Boletas (mismo número, dos lugares =
   ruido). El usuario alterna pestañas para verlo si lo necesita.
4. **Renombrar "Pagos del mes actual" → "Pagos registrados"**: era confuso
   porque "mes actual" sugería mes calendario, pero el cálculo era sobre
   el período seleccionado (que puede no ser el mes corriente).

### Alternativas descartadas
- **Serializar Decimal como Number en el endpoint**: tentador pero
  arriesgado — perdés precisión para montos grandes y hay otros consumidores
  (sync-payments, repositories) que asumen string. Mejor convertir en el
  consumer puntual.
- **`Number(v) || 0` en vez del helper con `isFinite`**: `Number("")` da
  `0`, pero `Number(null)` también da `0` — funcionaría, pero no captura
  el caso `Number("abc")` → `NaN || 0` = `0` que sí funciona en realidad.
  Igual el helper es más explícito y reutilizable.

### Impacto
- `src/app/admin/consortiums/page.tsx`:
  - `PagosView`: helper `toNum`, recálculo de `totalPagado` y `totalImpago`,
    `totalPendiente` también usa `toNum` para consistencia.
  - Header `pagosSummary`: dos métricas en vez de tres.
- Mejora: el usuario ve totales correctos al cargar la pestaña Pagos.

---

## 2026-05-25 — Botones del scheduler movidos del toolbar al sidebar

### Problema
El toolbar superior de la pestaña principal tenía los botones "Pausar
scheduler" (o "Encender scheduler") y "Ejecutar ahora" del lado izquierdo,
ocupando espacio visual horizontal arriba de la tabla principal de
boletas/pagos. En pantallas medianas esto comía altura y empujaba la
tabla hacia abajo. Además, conceptualmente esos controles pertenecen al
chrome de la app (igual que "Cerrar sesión"), no al contenido de la
vista actual.

### Decisión
Mover ambos botones al sidebar colapsable izquierdo, agrupados en el
footer del sidebar (arriba de "Cerrar sesión") y separados por un
`<div className={styles.navSidebarDivider} />`. Mantienen exactamente
los mismos handlers (`handleToggleScheduler`, `handleRunNow`) y reaccionan
al mismo estado (`paused`, `schedulerEnabled`, `busyAction`) — solo
cambia el contenedor.

Iconos elegidos:
- ⏸️ cuando el scheduler está corriendo (acción: pausar).
- ▶️ cuando está pausado (acción: encender).
- ⚡ para "Ejecutar ahora" (acción manual instantánea).

El toolbar superior queda minimal: hamburger menu (mobile) y mensajes de
feedback (`toolbarInfo` / `toolbarError`).

### Impacto
- `src/app/admin/consortiums/page.tsx`: dos bloques de `<button>` movidos
  de `<div className={styles.toolbarLeft}>` a antes del botón "Cerrar
  sesión" en el sidebar. Toolbar simplificado.
- Mejora: más altura útil para la tabla principal, sidebar agrupa todas
  las acciones de control de sesión/scheduler en un solo lugar.

---

## 2026-05-25 — Separación UI Boletas / Pagos (single responsibility por pestaña)

### Problema
La tabla de la pestaña **Boletas** mostraba en la columna PAGO los botones
"Pagar" (que abre el modal de cuotas/libre) y "Ver pagos" (historial). La
pestaña **Pagos** tenía además su propio flujo inline de carga rápida
(inputs fecha/importe/medio en cada fila + GUARDAR al pie). Resultado:
dos entry points distintos para la misma acción, con dos UIs distintas,
en dos pestañas distintas. El usuario no sabía cuál usar y los datos del
mismo flujo se cargaban desde lugares inconsistentes.

### Decisión
Dejar cada pestaña con una sola responsabilidad:
- **Boletas**: solo datos de boletas. La columna PAGO conserva el indicador
  visual (`Pagada` / `Resta $X` / `—`) porque sirve para tener contexto de
  estado al revisar la lista, pero **sin botones de acción**.
- **Pagos**: única superficie para gestionar pagos. Conserva el flujo inline
  rápido (sirve para el 80% de los casos: pago simple a fecha de hoy) y suma
  una nueva columna **ACCIONES** al final de cada fila con los botones
  "Pagar" (modal cuotas/libre, para el 20% con casos complejos) y "Ver pagos"
  cuando `isPaid` (modal de historial read-only).

Los modales (`payModalInvoice` y `viewPaymentsInvoice`) y sus handlers
(`handleOpenPayModal`, `handleOpenViewPayments`) siguen viviendo en el
componente padre `AdminConsortiumsPage`. PagosView los recibe vía props
nuevas `onPagar(inv)` y `onVerPagos(inv)`. Esto evita duplicar estado
en PagosView y mantiene los modales montados a nivel página.

### Alternativas descartadas
- **Eliminar la columna PAGO entera de Boletas**: descartado porque el
  estado de pago es info útil al revisar boletas (sin tener que cambiar
  de pestaña).
- **Eliminar el flujo inline de Pagos y dejar solo los modales**:
  descartado porque el inline es más rápido para el caso simple (cargar
  un pago único sin cuotas) y ya está implementado.
- **Eliminar el código de los modales**: descartado porque "Pagar en
  cuotas" y "Ver historial detallado" requieren modal — no se pueden
  resolver inline.

### Impacto
- `src/app/admin/consortiums/page.tsx`:
  - Tabla Boletas, columna PAGO: ahora solo span con badge de estado.
  - `PagosViewProps`: agregadas props `onPagar` y `onVerPagos`.
  - Tabla PagosView: nueva columna `<th>ACCIONES</th>` con botón Pagar / Ver pagos según `isPaid`.
  - Render del padre: pasa `handleOpenPayModal` y `handleOpenViewPayments` a PagosView.
- Mejora UX: cero ambigüedad sobre dónde cargar pagos.

---

## 2026-05-25 — Healthcheck real con verificación de DB + límites de recursos

### Problema 1 — Healthcheck con falso positivo

`docker-compose.yml` testeaba `/login` para considerar al container web
como healthy:

```yaml
test: ["CMD", "node", "-e", "fetch('http://localhost:3000/login')..."]
```

`/login` es una página estática del Next.js que renderea un form. Pasa
status 200 aunque Prisma no pueda conectar a la DB (la página no toca
DB en su render). Escenario real:

- Supabase tiene un blip de disponibilidad (5 min).
- El pool de conexiones se cae o se agota.
- El servidor Next sigue arriba respondiendo `/login` con 200.
- **Docker marca el container "healthy"** → `restart: unless-stopped`
  no se dispara.
- Scheduler y worker siguen corriendo (dependen del web healthy), pero
  todas sus queries fallan.
- Tunnel sigue exponiendo el endpoint.
- Te enterás cuando un usuario reporta que la app no funciona.

### Problema 2 — Sin límites de recursos

`docker-compose.yml` no declaraba `deploy.resources.limits` para ningún
servicio. Escenario real:

- Worker procesa un PDF grande (50 MB). OCR (tesseract + canvas) +
  extracción IA acumulan buffers.
- Si hay leak en `@napi-rs/canvas`, `pdf-parse` o tesseract, el proceso
  crece sin tope.
- Consume toda la RAM del host → kernel OOM killer mata procesos al azar.
- **Riesgo crítico:** el host también corre el self-hosted runner de GHA.
  Si el OOM killer lo mata, **no podés deployar el fix** hasta reiniciar
  físicamente la máquina.

### Decisión

**Fix 1 — endpoint `/api/health` que ejecuta SELECT 1:**

```typescript
await Promise.race([
  prisma.$queryRaw`SELECT 1`,
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("DB ping timeout (5s)")), 5000)
  ),
]);
```

Si la query falla o el timeout dispara, devuelve 503 con detalle del
error. Si pasa, devuelve 200 con `{ status, db, uptime, timestamp }`.
El timeout corto (5s) garantiza que un Supabase degradado se detecte
rápido en vez de hacer crash al worker que está esperando una respuesta
que nunca llega.

Healthcheck del compose actualizado a apuntar a `/api/health`.
Resultado: si la DB cae, Docker marca el container unhealthy en 30s y
dispara el `restart: unless-stopped`. Si el problema es del lado de
Supabase, los reintentos eventualmente reconectan. Si el problema es
local, el restart limpia el pool.

**Endpoint público (sin auth):** el middleware solo matchea `/admin*` y
`/login`, así que `/api/health` queda accesible sin token. Es lo
correcto — el healthcheck de Docker no puede mandar JWT, y exponer
metadata de salud no es secreto (status, uptime, error genérico).

**Fix 2 — límites de memoria y CPU:**

Agregadas declaraciones `deploy.resources.limits` y `reservations` a
los 4 servicios. Valores derivados del rol y carga esperada:

| Servicio | Memory limit | CPU limit | Reservation memory | Razón |
|---|---|---|---|---|
| **web** | 1024M | 1.0 | 256M | SSR Next.js, picos en endpoints pesados (sync, scan manual) |
| **scheduler** | 256M | 0.5 | 64M | Liviano, solo lista Drive y crea ProcessingJobs |
| **worker** | 1536M | 2.0 | 512M | El más pesado: OCR + IA + pdf-parse, picos altos |
| **tunnel** | 128M | 0.25 | — | cloudflared, daemon liviano |

Total reservation: ~832 MB / ~0.85 CPU baseline. Total limit: ~2944 MB /
~3.75 CPU. Si el host tiene 4 GB RAM y 4 vCPU, queda holgado.

### Alternativas descartadas

**Para healthcheck:**
- **Healthcheck pinged `/login` pero validar contenido HTML.** Frágil —
  cambios al template del login romperían el healthcheck.
- **Healthcheck a un endpoint dummy `/api/ping` sin DB.** Mismo problema
  que `/login` actual: no detecta DB caída.
- **Healthcheck que verifica DB + Google Drive + AI providers.** Excesivo
  y lento — un blip de Gemini no debería marcar al container unhealthy.
  Lo correcto es: web es healthy si puede servir y tiene DB. Los
  providers externos los maneja el pipeline con su propio fallback.

**Para límites de recursos:**
- **Sin límites, monitoreo de RAM externo (Prometheus/Grafana).** Mejor
  observability pero el daño ya está hecho cuando llega la alerta. Los
  límites preventivos son baratos y matan el problema en origen.
- **Límites en el host (cgroups manual).** Más invasivo, requiere
  mantenimiento por separado del compose.
- **mem_limit / cpus top-level legacy** (Compose v1). Funciona en
  standalone pero deprecated en v2. `deploy.resources.limits` es el
  formato actual y se aplica en standalone desde Compose v2.16+.

### Impacto

- `src/app/api/health/route.ts`: endpoint nuevo, ~70 líneas. Sin auth,
  rápido (<1s típico), tolerante a fallos (timeout 5s).
- `docker-compose.yml`: healthcheck del web actualizado + 4 bloques
  `deploy.resources` (~50 líneas nuevas).
- Sin migración de DB ni cambios al pipeline. Riesgo de regresión: bajo.
- **Beneficio observable inmediato:** si en el próximo deploy hay un
  blip de Supabase, los containers se reiniciarán solos en vez de
  quedar zombies con DB caída.
- **Beneficio observable bajo carga:** un worker con leak se kileará
  por OOM dentro de su límite de 1.5 GB en vez de tirar el host.

---

## 2026-05-25 — `.dockerignore` ampliado para reducir contexto y prevenir leaks

### Problema

Review de seguridad/eficiencia del setup Docker detectó que el
`.dockerignore` tenía solo 8 patrones:

```
node_modules
.next
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.git
.gitignore
.env*
```

Cubría lo más crítico (node_modules, .next, .env, .git) pero dejaba
entrar al contexto del build varios paths que no aportan al runtime y
algunos que son sensibles:

| Path | Tamaño | Razón para excluir |
|---|---|---|
| `dist/` | 399 KB | Se regenera en el builder con `npm run build:jobs` |
| `logs/` | 680 KB | Logs locales de desarrollo, datos del cliente |
| `docs/` | 180 KB | Documentación interna, decisiones técnicas |
| `*.tsbuildinfo` | ~700 KB | Caches incrementales de TS, se regeneran |
| `.claude/` | 4 KB | Config local de Claude Code |
| `.vscode/` | 1 KB | Config local del IDE |
| `CHANGELOG.md`, `README.md`, `CLAUDE.md` | ~100 KB | Docs internas |
| `*.pdf` | 42 KB | `PDF_DOC_PROCESSOR_Presentacion.pdf` (assets de venta) |
| `.github/` | — | Workflows de CI (no van adentro del container) |

**El runner stage del Dockerfile** solo hace `COPY --from=builder` de
paths específicos (`.next/standalone`, `public`, `dist`, `prisma`,
node_modules), así que los archivos extra NO terminan en la imagen
final de runtime. Pero igualmente:

1. **Aumentan el contexto** que Docker envía al daemon al inicio del
   build (~2.1 MB extra medido con `du`), ralentizando builds.
2. **Quedan en stages intermedias** (`builder`). Si alguien hace `docker
   run -it imagen:builder sh` para debug, ve toda la docs interna.
3. **Riesgo de leak por cambio futuro** — si mañana alguien agrega
   `COPY --from=builder /app/CHANGELOG.md` por error, queda en la
   imagen final sin que nadie se entere.

### Decisión

Reescribir `.dockerignore` con **41 patrones organizados por
categoría** (build outputs, env, VCS, logs, IDE, OS, docs, CI, tests,
backups). Defensa en profundidad: aunque el Dockerfile actual no
copie estos paths al runner, el `.dockerignore` los mantiene fuera
del contexto desde el inicio.

`scripts/` queda **incluido** porque puede ser útil ejecutar comandos
admin con `docker exec` (ej. `create-admin.ts`, `fix-client-folders.ts`,
`rotate-encrypted-secrets.ts`). Trade-off aceptado: ~10 KB extra a
cambio de poder hacer mantenimiento sin reconstruir imagen.

### Verificación

Antes de aplicar, verifiqué que el `COPY . .` del builder (línea 27 del
Dockerfile) sigue recibiendo todos los paths necesarios:

- ✅ `package.json`, `package-lock.json` — para `npm ci`
- ✅ `tsconfig.json`, `tsconfig.jobs.json` — para tsc
- ✅ `next.config.ts`, `middleware.ts`, `next-env.d.ts` — para Next
- ✅ `src/`, `public/` — código y assets
- ✅ `prisma/` — para `npx prisma generate`
- ✅ `scripts/` — para admin commands

Ningún path requerido por el build quedó accidentalmente excluido.

### Alternativas descartadas

- **Refactor del Dockerfile para usar `COPY` selectivos** (`COPY src/
  ./src`, `COPY public/ ./public`, etc.) en vez de `COPY . .`. Sería
  más explícito pero requiere mantener la lista sincronizada cada vez
  que se agrega un archivo top-level (`middleware.ts`, `next.config.ts`,
  etc.). El `.dockerignore` con whitelist negativa es más mantenible.
- **Volverse paranoico con `*` y whitelist explícita** (todo excluido
  excepto lo listado con `!path`). Excesivo para este nivel de
  proyecto, alto costo de mantenimiento.

### Impacto

- `.dockerignore`: de 8 a 41 patrones efectivos, organizados por
  categoría con comentarios.
- Build context reducido en ~2.1 MB adicionales medidos con `du` (sin
  contar `node_modules` 1.2 GB + `.next/` 322 MB que ya estaban excluidos).
- Sin cambios en la imagen final (los stages del runner no copiaban
  esos paths igual). Beneficio principal: defensa en profundidad y
  builds marginalmente más rápidos.

---

## 2026-05-21 — Fix: docker login con action oficial (CRLF de PowerShell rompe --password-stdin)

### Problema

Después de migrar los scripts a PowerShell (entrada abajo), el CI run #53
falló en el step "Build and restart" con:

```
==> docker login
Error response from daemon: Get "https://ghcr.io/v2/": denied: denied
docker login failed with exit code 1
```

Lo confuso era que el mismo `GITHUB_TOKEN` funcionaba en el job `build`
(que pushea imágenes a GHCR vía `docker/login-action@v3`) y antes con
bash `-p $TOKEN` también funcionaba. Solo fallaba con
`$env:GHCR_TOKEN | docker login --password-stdin` en PowerShell.

### Causa raíz

PowerShell 5.1 (Windows PowerShell) tiene un comportamiento por defecto
del pipeline donde **siempre agrega CRLF al final** del string pipeado a
un native command. `Write-Output` (y por extensión `$x | cmd`) termina
con line ending del sistema.

`docker login --password-stdin` lee stdin hasta EOF, sin interpretar
newlines. Entonces:

- Pipe esperado: `<token>` (40 chars del GITHUB_TOKEN)
- Pipe real recibido por Docker: `<token>\r\n` (42 chars)

Docker manda esos 42 bytes como password al endpoint de GHCR. GHCR
compara contra el token real (40 chars) y rechaza con `denied: denied`.

`denied: denied` (en vez de `unauthorized`) es la respuesta de GHCR
cuando recibe credenciales con formato válido pero que no matchean a
ningún token activo — exactamente el caso de un token con bytes extra.

### Decisión

Reemplazar el `docker login` manual por la action oficial
`docker/login-action@v3` (misma que ya usaba el job `build`):

```yaml
- name: Login to GHCR
  uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: johnydeev
    password: ${{ secrets.GITHUB_TOKEN }}
```

La action está implementada en TypeScript (no shell) y llama directamente
a la CLI de Docker con un buffer binario controlado, evitando el
problema de CRLF por completo. Funciona uniforme en Linux, macOS y
Windows (cmd, PowerShell 5.1, PowerShell Core 7).

Como efecto adicional, la action también es la solución oficial al
problema más general: cada shell tiene quirks distintos con stdin
(bash agrega newline si usás `echo`, pero no con `printf '%s'`; cmd
tiene `echo|set /p=` para no agregar; PowerShell 5.1 siempre agrega
CRLF; etc.). Delegar a una action mantiene el código portable y libre
de estos detalles.

### Beneficio mantenido de Crítica #2

El propósito original de Crítica #2 era que el token **no apareciera
como argumento de proceso visible** (`ps aux`, `/proc/<pid>/cmdline`,
warnings de Docker). La action oficial cumple eso — internamente usa
`--password-stdin` con un Buffer Node.js sin shell intermedio. El token
viaja por stdin del proceso `docker`, no por argumentos.

### Alternativas descartadas

- **`cmd /c "echo|set /p=$env:GHCR_TOKEN | docker login --password-stdin"`**
  Mezcla cmd dentro de PowerShell con escaping anidado. Frágil y
  difícil de debuggear si algo cambia.
- **Escribir el token a un archivo temporal y `Get-Content -Raw`.**
  Funciona pero crea archivo en disco con secret (aunque temporal),
  riesgo si crashea el script antes del `Remove-Item`.
- **Volver a `-p $TOKEN`** sacrificando Crítica #2. Funciona pero
  pierde el hardening de seguridad sin razón técnica.
- **PowerShell Core 7 (`pwsh`)** que maneja mejor los pipes con
  `$PSNativeCommandArgumentPassing = 'Standard'`. Requiere asumir PS7
  instalado en el runner; PS 5.1 viene built-in.

### Impacto

- `.github/workflows/ci.yml`, job `deploy`:
  - Nuevo step "Login to GHCR" usando `docker/login-action@v3` antes de
    "Build and restart".
  - "Build and restart" pierde el `Invoke-Step "docker login"` y la env
    var `GHCR_TOKEN`.
- **Lección operativa:** para autenticación contra registries en CI,
  preferir actions oficiales (`docker/login-action`, `aws-actions/configure-aws-credentials`, etc.) en vez de scripts shell que dependen del
  comportamiento exacto del intérprete. El esfuerzo de mantener cross-shell
  es alto y los bugs son sutiles.

---

## 2026-05-21 — Fix: scripts del deploy reescritos en PowerShell

### Problema

El commit anterior (Hardening del workflow, ver entrada abajo) aplicó los
3 fixes críticos usando `shell: bash`. En la primera ejecución real (CI
run #52), el step "Write env file from GitHub Secret" falló inmediatamente
con:

```
<3>WSL (10 - Relay) ERROR: CreateProcessCommon:818:
execvpe(/bin/bash) failed: No such file or directory
Error: Process completed with exit code 1.
```

El runner self-hosted está en Windows y **no tiene `/bin/bash` instalado**
(ni Git for Windows con su `bash.exe` en PATH, ni WSL configurado para
ejecución). Asumir bash disponible fue un error — el resto del workflow
ya tenía pistas: el step `Wait for healthy (Windows)` usa
`shell: powershell` justamente por esta razón.

### Decisión

Reescribir ambos steps en `shell: powershell` (Windows PowerShell 5.1,
no PS Core 7). Razones:

- **Windows PowerShell 5.1** está siempre disponible en cualquier Windows
  reciente sin instalación adicional.
- **PowerShell Core 7 (`pwsh`)** sería preferible (mejor manejo de
  exit codes con `$PSNativeCommandUseErrorActionPreference`), pero
  asumir su presencia es lo mismo que asumir bash. Mantengo
  compatibilidad con lo que ya hay.

**Traducción funcional de `set -euo pipefail`:**

Bash con `set -e` aborta si cualquier comando devuelve exit ≠ 0.
PowerShell con `$ErrorActionPreference = 'Stop'` aborta solo en
cmdlets (`Get-Content`, `Write-Host`, etc.) — los **native commands**
(`docker`, `npx`, `git`) NO disparan terminating errors; solo setean
`$LASTEXITCODE`. Esto es el equivalente de bash sin `-e`: el script
sigue corriendo aunque el comando falle.

Solución: helper local `Invoke-Step` que envuelve cada native command:

```powershell
function Invoke-Step {
  param([string]$Name, [scriptblock]$Body)
  Write-Host "==> $Name"
  & $Body
  if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}
```

Cada paso del deploy se ejecuta así:

```powershell
Invoke-Step "prisma migrate deploy" {
  docker compose -p ia-drive-doc-processor run --rm web npx prisma migrate deploy
}
```

Si `migrate deploy` falla con exit 1, el `throw` interrumpe el script y
el job de GHA reporta ❌. Beneficio adicional: en los logs aparece
`==> prisma migrate deploy` antes de la salida del comando, lo que
facilita identificar dónde murió el script si falla.

**Crítica #2 — `--password-stdin`** en PowerShell:

```powershell
$env:GHCR_TOKEN | docker login ghcr.io -u johnydeev --password-stdin
```

PowerShell pipea naturalmente strings a stdin de native commands.
Idéntico al patrón `echo "$X" | docker login` de bash.

**Crítica #3 — `.env` desde Secret** en PowerShell:

```powershell
[System.IO.File]::WriteAllText("$PWD\.env", $env:PROD_ENV)
```

Razón de usar `WriteAllText` en vez de `Out-File` / `Set-Content`:
Windows PowerShell 5.1 escribe **UTF-16 LE con BOM** por defecto. El
parser de `env_file` de docker compose espera UTF-8 sin BOM — un BOM
en la primera línea hace que la primera variable se lea como
`﻿DATABASE_URL` (no la encuentra) y el container arranca sin DB.
`WriteAllText` con un solo parámetro string usa UTF-8 sin BOM por
defecto. Validado en docs de .NET Framework.

`chmod 600 .env` se eliminó — NTFS no respeta permisos POSIX, el
comando no haría nada relevante en este runner.

### Alternativas descartadas

- **Instalar Git for Windows en el runner para tener bash.** Mantiene
  los scripts originales bash pero agrega dependencia al setup del
  runner. Si la máquina se reinstala o se agrega un segundo runner,
  hay que recordar instalar Git for Windows. PowerShell viene preinstalado
  en Windows — cero setup adicional.
- **Migrar el runner a Linux (WSL2 o Docker Linux).** Habilita bash
  nativo pero requiere reconfigurar todo el ambiente del runner. Fuera
  de alcance de este fix.
- **Usar `shell: 'C:\Program Files\Git\bin\bash.exe -e {0}'`** apuntando
  al bash de Git for Windows. Sigue dependiendo de Git for Windows
  instalado y el path puede variar (32 vs 64 bits, ubicación custom).
- **Usar `pwsh` (PS Core 7)** en vez de `powershell` (5.1). Mejor manejo
  de native commands con `$PSNativeCommandUseErrorActionPreference`,
  pero asume que PS7 está instalado. PS 5.1 viene built-in en Windows
  10/11/Server 2016+.

### Impacto

- `.github/workflows/ci.yml`: dos steps del job `deploy` reescritos. Mismo
  comportamiento funcional, sintaxis PowerShell.
- **Lección operativa:** revisar qué shells están disponibles en el runner
  antes de usar `shell: bash` en workflows. Para self-hosted runners
  Windows, asumir solo `powershell`/`cmd` por defecto.

---

## 2026-05-21 — Hardening del workflow de deploy (3 fixes críticos)

### Problema

Revisión del workflow `.github/workflows/ci.yml` (job `deploy`) detectó
tres riesgos operativos / de seguridad:

1. **Silent deploy failure.** El bloque `run: |` del step "Build and
   restart" no tenía `set -e`. Bash por defecto **no aborta** si un
   comando falla — solo el último comando determina el exit code del
   script. Concretamente, si `prisma migrate deploy` fallaba (ej.
   migración con conflicto, DB inaccesible, schema corrupto), los
   comandos siguientes (`docker compose up -d --force-recreate`) se
   ejecutaban igual. El resultado era:
   - Containers nuevos corriendo código que esperaba schema nuevo.
   - DB con schema viejo.
   - Job de GitHub Actions reportando ✅ (porque `docker image prune -f`
     al final salía con 0).
   - Cualquier query a las columnas nuevas explotaba con `column "X"
     does not exist`.
   - Producción rota silenciosamente hasta que un usuario reportaba el
     bug, o hasta el siguiente deploy si las migraciones eran
     acumulativas.

2. **Token expuesto en argumento de comando.** El step usaba
   `docker login ghcr.io -u johnydeev -p ${{ secrets.GITHUB_TOKEN }}`.
   GitHub Actions enmascara el valor del secret en los logs visibles,
   pero el token como argumento de comando queda accesible en:
   - `ps aux` / `/proc/<pid>/cmdline` para otros procesos del host
     (relevante porque el runner es self-hosted en una máquina que
     puede correr otros procesos).
   - Warnings del propio Docker: `WARNING! Using --password via the CLI
     is insecure. Use --password-stdin.`
   - Screenshots / screen-shares accidentales durante debugging.
   - Security scanners (Snyk, GitGuardian, Trivy) lo flagean como
     CWE-214 (Invocation of Process Using Visible Sensitive Information).

3. **Path hardcodeado del `.env`.** El step "Copy env file" usaba
   `copy "C:\Users\jony\Desktop\Proyectos Para vender\pdf-drive-procesor\drive-doc-processor\.env" .env`.
   Tres fragilidades acumuladas:
   - El path dice `drive-doc-processor` (proyecto anterior), no
     `ia-drive-doc-processor` (proyecto actual). Posiblemente el `.env`
     estaba siendo reciclado de un fork.
   - Acoplado a una única máquina (la del usuario `jony`). Imposible
     correr el runner en una segunda máquina sin reconfigurar.
   - El `cmd` `copy` falla silenciosamente si el destino tiene
     problemas → potencialmente deployando con `.env` desactualizado o
     inexistente sin alerta.

### Decisión

**Fix 1 — `set -euo pipefail`** al inicio de ambos scripts `run: |`
(steps "Write env file" y "Build and restart"). Flags:
- `-e` (errexit): aborta si cualquier comando devuelve exit ≠ 0.
- `-u` (nounset): aborta si se referencia variable no definida (atrapa
  typos en `$IMAGE_TGA` etc.).
- `-o pipefail`: en pipes, el exit code refleja el primer fallo (no solo
  el último comando).

Adicionalmente, agregar `shell: bash` explícito porque los runners
self-hosted en Windows pueden defaultear a `pwsh` o `cmd` donde
`set -euo pipefail` no aplica.

**Fix 2 — `docker login --password-stdin`**. El token llega vía pipe
desde una env var:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u johnydeev --password-stdin
```

El token solo existe en memoria del proceso por los milisegundos que
Docker lo lee del pipe. Ya no aparece en `ps aux` ni warnings de Docker.

**Fix 3 — `.env` desde GitHub Secret `PROD_ENV_FILE`**. Step nuevo que
escribe el `.env` decodificando un secret del repositorio:

```bash
printf '%s' "$PROD_ENV" > .env
```

Validación previa: si el secret no está configurado, el script aborta
con `::error::` y mensaje accionable indicando dónde configurarlo.
Beneficios:
- Sin path frágil.
- Funciona desde cualquier runner.
- Cambiar variables = editar secret en GitHub UI.
- GitHub trackea quién modifica secrets y cuándo.
- Cifrado at rest, enmascarado en logs.

### Alternativas descartadas

- **Quick fix sin GH UI (Opción A):** dejar el archivo en disco pero
  hacer el path configurable vía variable de entorno del runner con
  verificación de existencia. Resuelve la fragilidad de path absoluto
  pero mantiene el `.env` en disco plano y sigue acoplado a la máquina.
  Rechazada por ser solo parcialmente correcta.
- **Secret manager externo (Opción C):** Doppler / Vault / AWS Secrets
  Manager. Útil si hubiera múltiples entornos (dev/staging/prod) o
  varios proyectos compartiendo secrets. Overkill para este proyecto
  con un único entorno.
- **Conservar el `-p $TOKEN`** porque "GHA enmascara los logs":
  insuficiente — el masking solo aplica a los logs visibles de GHA web,
  no a `ps aux` del host self-hosted, ni a screenshots, ni evita el
  warning de Docker en los logs.

### Impacto

- `.github/workflows/ci.yml`:
  - Step "Copy env file" eliminado, reemplazado por "Write env file from
    GitHub Secret".
  - Step "Build and restart" ahora con `shell: bash`, `set -euo pipefail`
    y `--password-stdin`.
- **Acción manual requerida una vez:** crear el secret
  `PROD_ENV_FILE` en `Settings → Secrets and variables → Actions` con
  el contenido completo del `.env` de producción.
- **El archivo viejo** `C:\...\drive-doc-processor\.env` queda
  desacoplado del CI — puede eliminarse del disco después de verificar
  el primer deploy exitoso.

---

## 2026-05-21 — Sistema de pagos: modal UI + sincronización Sheets→DB sobre la misma fila

### Problema

Necesitábamos un flujo para registrar pagos de boletas que cumpliera tres
condiciones simultáneas:

1. **Pago visible y editable en Sheets** — el cliente trabaja en Sheets
   habitualmente y quería ver el estado de pago en la misma fila de la
   boleta (no en una hoja separada ni en una UI aparte).
2. **Comprobante PDF adjunto** — al pagar, el cliente sube el PDF del
   recibo a Drive y queda linkeado desde la fila.
3. **Soporte para cuotas y pagos parciales** — boletas grandes se pagan
   en varias cuotas; los saldos residuales deben quedar visibles en el
   período siguiente (mes+1) sin perder trazabilidad.

Internamente, esto implicaba dos decisiones de diseño:

- **Camino de entrada**: ¿el cliente carga el pago desde Sheets o desde
  un modal en la UI? Sheets es cómodo en bulk pero no permite subir el PDF
  desde la misma celda. La UI es más completa pero el cliente prefiere
  Sheets para revisiones rápidas.
- **Idempotencia**: si el cliente edita una fila y vuelve a sincronizar,
  no podemos crear `Payment` duplicados en DB.

### Decisión

**1. Doble camino sobre la misma fuente de verdad (columnas Q/R/S/T/U).**
Las columnas P=SALDO PENDIENTE, Q=MONTO PAGADO, R=CANT CUOTAS, S=FECHA
PAGO, T=URL COMPROBANTE en la hoja de boletas son la representación
canónica del pago. Los dos caminos escriben sobre ellas:

- **Camino A — Modal en UI:** botón "Pagar" en cada fila → modal con
  inputs + upload PDF → `POST /api/client/invoices/[id]/payments` con
  `multipart/form-data` → sube PDF a Drive + crea Payment en DB +
  actualiza Q/R/S/T + recalcula P/N + mueve M si hay saldo.
- **Camino B — Sincronización Sheets→DB:** cliente edita Q/R/S/T en
  Sheets manualmente → botón "Sincronizar pagos" en sidebar →
  `POST /api/client/sync-payments` lee esas columnas, hace upsert
  idempotente en `Payment`, recalcula P/N y mueve M.

Decartamos una hoja PAGOS separada (estuvo en la primera iteración del
diseño): generaba ambigüedad sobre la fuente de verdad y obligaba al
cliente a saltar entre hojas para entender el estado de una boleta.

**2. Clave natural de idempotencia para `Payment`.** Identificamos cada
pago por la combinación `invoiceId + isoDayKey(paymentDate) +
amount.toFixed(2)`. Si esa clave ya existe en `Payment` para la invoice,
el sync actualiza campos secundarios (driveFileUrl); si no, crea. El
cliente puede editar/duplicar/borrar filas sin generar basura. Sin
columnas extra en la hoja.

**3. Reasignación de `periodId` al mes siguiente para pagos parciales.**
Tras recalcular saldos, si `remainingBalance > 0` y la invoice tiene
período asignado, se busca (o crea ACTIVE) el período del mes siguiente
del mismo consorcio y se reasigna `Invoice.periodId`. La fila en Sheets
refleja el cambio actualizando M (PERIODO) en el mismo batch que N/P/Q/R/S/T/U.
Guardas: si la boleta ya está en el mes destino, no se mueve de nuevo
(evita saltos repetidos en re-syncs).

**4. Multipart con archivo opcional en el endpoint de pagos.** El endpoint
`POST /api/client/invoices/[id]/payments` detecta el content-type:
`application/json` mantiene el contrato legacy (la PagosView inline existente
sigue funcionando); `multipart/form-data` activa el nuevo flujo con PDF.
Reusa el `PaymentRepository` para la lógica de cuotas/saldo y delega la
subida a Drive al `GoogleDriveService` (carpeta `receipts/consorcio/período`,
mismo patrón que el endpoint legacy `/receipt`).

**5. Protección de columnas A:U con `addProtectedRange` (toggleable).**
Endpoints:

- `POST /api/client/setup-sheet-protection`: aplica protección. La service
  account queda como único editor (`editors.users = [clientEmail]`),
  `warningOnly: false`. Idempotente — limpia rangos previos con descripción
  `dpp:invoices-lock`. **Antes de proteger ejecuta el auto-sync** (ver punto 7).
- `DELETE /api/client/setup-sheet-protection`: quita los rangos
  `dpp:invoices-lock` para permitir ediciones manuales en casos puntuales.
  Solo rol CLIENT — el cliente es dueño de su propia hoja.

Decidimos que sea **toggle manual** (en vez de timer con auto-relock) por
simpleza: el cliente desbloquea, edita en Sheets, vuelve a la app y aprieta
"Proteger hoja". La UI muestra una confirmación al desbloquear recordando
que hay que re-bloquear cuando se termine. Trade-off aceptado: si el
cliente se olvida, la hoja queda desprotegida hasta que vuelva a apretar
"Proteger hoja". No agregamos cron/timer porque incrementa complejidad
operativa sin ganancia clara (las ediciones puntuales son raras).

**7. Auto-sync al re-proteger.** Cuando el cliente aprieta "Proteger hoja",
el endpoint POST ejecuta `syncInvoicePaymentsFromSheets(clientId)` antes
del `addProtectedRange`. Esto vuelca a la DB cualquier edición manual de las
columnas Q/R/S/T/U mientras la hoja estaba desbloqueada. Si el sync falla,
**NO** se aplica la protección — devuelve error con detalle para que el
cliente pueda corregir y reintentar. Beneficio: el cliente no tiene que
acordarse de apretar "Sincronizar pagos" después de editar; un solo click
("Proteger hoja") hace ambas cosas.

Para evitar duplicar código, la lógica del sync se extrajo a
`src/lib/syncInvoicePayments.ts::syncInvoicePaymentsFromSheets`. Tanto
`/sync-payments` (botón "Sincronizar pagos") como `/setup-sheet-protection`
(POST, antes de proteger) la invocan.

**6. `updateInvoicePaymentInfo` con campos opcionales.** El método recibe
`values: { paymentStatus?, remainingBalance?, period?, paidAmount?,
installmentsCount?, paymentDate?, receiptUrl? }` y arma un `batchUpdate`
solo con los rangos presentes. Permite que cada endpoint controle qué
columnas tocar (ej: el sync no escribe Q/R/S/T porque ya están bien — solo
recalcula derivados).

### Alternativas descartadas

- **Hoja PAGOS separada** (primer diseño). Generaba doble fuente de verdad
  y rompía la unicidad visual "una boleta = una fila". Rechazada.
- **Columna PAYMENT_ID auto-generada en la hoja para idempotencia.** Más
  explícita pero invade el formato visible. Rechazada por fricción.
- **Borrar y recrear todos los Payment del cliente en cada sync.** Pierde
  `createdAt` histórico, dificulta auditoría, rompe FKs futuras.
- **Crear un Invoice nuevo por el saldo restante.** Genera registros
  fantasma sin PDF asociado, rompe la reconciliación 1:1 Invoice/PDF.
- **Proteger solo las columnas A:O (sin P-T).** Las columnas nuevas las
  escribe la app — si el cliente puede editarlas en Google, rompe la
  reconciliación al siguiente sync.
- **Persistir `Invoice.paidAmount` como columna en DB.** Es un derivado
  trivial (`amount - remainingBalance`, o `SUM(payments.amount)`).
  Persistirlo crea tercera fuente de verdad que puede desincronizarse.
  Regla aplicada: no persistimos derivados salvo razón de performance
  medida que lo justifique.

### Impacto

- **Schema**: `SchedulerState.lastPaymentsSyncAt DateTime?`. Migración
  `20260521000100_add_payment_sync_fields`.
- **GoogleSheetsService**: nuevos métodos `readInvoicePaymentRows`
  (lectura para sync), `updateInvoicePaymentInfo` (escritura batch
  opcional sobre N/P/M/Q/R/S/T), `protectInvoiceColumns`, `getSheetId`.
- **Mapping** (`SheetsRowMapping`): 5 columnas nuevas — `paidAmount: "Q"`,
  `installmentsCount: "R"`, `paymentDate: "S"`, `receiptUrl: "T"`,
  `paidWith: "U"` con headers MONTO PAGADO, CANT CUOTAS, FECHA PAGO,
  URL COMPROBANTE, MEDIO PAGO. Default actualizado en los 5 lugares
  (`processPendingDocuments.job.ts`, `consortiums/[id]/invoices/route.ts`,
  `invoices/[id]/payments/route.ts`, `setup-sheet-protection/route.ts`,
  `sync-payments/route.ts`) y en `requiredKeys` de
  `clientProcessingConfig.resolveMapping`. La key `paidWith` evita
  colisionar con `Invoice.paymentMethod` (enum LSP extraído por la IA al
  procesar la factura), que NO se escribe en Sheets.
- **Endpoints nuevos**: `/api/client/sync-payments`,
  `/api/client/setup-sheet-protection` (POST proteger + DELETE desproteger).
- **Helper compartido**: `src/lib/syncInvoicePayments.ts` con
  `syncInvoicePaymentsFromSheets(clientId)`. Reusado por `/sync-payments` y
  por POST de `/setup-sheet-protection` (auto-sync antes de re-proteger).
- **Endpoint modificado**: `/api/client/invoices/[id]/payments` ahora
  acepta multipart con PDF opcional, reasigna periodId al mes+1, y
  actualiza N/P/M/Q/R/S/T en Sheets.
- **UI**: botón "Pagar" en cada fila de la tabla de Boletas + modal nuevo
  con form + upload. Botones "Sincronizar pagos", "Proteger hoja" y
  "Desproteger hoja" en el sidebar (solo CLIENT). El de desproteger pide
  confirmación.

### Modal de pago con detección automática de modo (8 — agregado en iteración)

El `PaymentRepository.createPayment` ya soportaba desde antes dos modos
(cuotas pactadas vs libre), pero el modal de UI inicial pedía siempre el
monto editable y el campo de cuotas, sin reflejar el modo activo. Esto
generaba dos confusiones:

1. En modo cuotas, el usuario podía escribir un monto que el backend
   silenciosamente reemplazaba por `amount/totalInstallments` (sorpresa).
2. Al hacer el segundo pago de una boleta en cuotas, el modal volvía a
   pedir `totalInstallments` cuando ya estaba fijado — el backend tiraba
   error 409 pero recién al guardar.

**Decisión:** el modal hace `GET /api/client/invoices/[id]/payments` al
abrir y deriva el modo activo desde `payments[0].totalInstallments`:
`null` → modo libre, no-null → modo cuotas. Render condicional según el
estado:

- **Primer pago** (sin payments previos): toggle "Pago libre / Cuotas".
  En cuotas, input `totalInstallments` visible + monto autocalculado
  readonly.
- **Modo cuotas en curso**: banner azul con "Cuota N de M",
  `totalInstallments` ya fijado por el repo, monto autocalculado readonly.
  Cuando es la última cuota, mostramos un aviso explicando que absorbe el
  redondeo (porque ahí el backend usa `currentRemaining` directo en vez de
  `amount/totalInstallments`).
- **Modo libre en curso**: banner naranja, input cuotas oculto (no se
  puede agregar cuotas a una serie libre), monto editable con default =
  `remainingBalance`.

El backend sigue siendo la **única fuente de verdad** sobre el monto
efectivo (en modo cuotas calcula `amount/totalInstallments` ignorando lo
que mande el cliente). El modal solo replica ese cálculo localmente para
mostrar la cifra correcta y evitar la sorpresa visual.

**Botón "Ver pagos"** (cuando `inv.isPaid`): reemplaza el botón "Pagar"
que ya no aplica. Abre un modal read-only con la tabla de pagos: tipo
(Cuota N/M o Libre), fecha, monto, medio, link a comprobante PDF y
observación. Útil para auditar boletas ya saldadas sin tener que ir a la
DB ni a Sheets.

---

## 2026-05-18 — Pin de imagen Docker por SHA en deploy (en vez de `:latest`)

### Problema
Después de mergear el commit `d33ff62` (soporte Claude), el job `deploy` del
CI corrió a éxito (Lint+Build+Deploy todos verdes en 14m 19s) y el step
`Build and restart` aparentemente ejecutó `docker pull ...:latest` +
`docker compose up -d --force-recreate`. Sin embargo, en producción el
contenedor `web-1` siguió corriendo la imagen `sha256:c8cc3d4b...` creada
el **7 de mayo**, con bundle de Next que **no contenía** el JSX nuevo del
input "Anthropic API Key". `docker image inspect ghcr.io/.../...:latest`
en el host también mostraba el SHA viejo con `Created: 2026-05-07`,
pese a que en GHCR el tag `:latest` apuntaba correctamente al digest nuevo
publicado hacía 1 hora.

Causa raíz: el `docker pull ...:latest` no actualizó realmente la imagen
local. El daemon mantuvo el manifest cacheado de `:latest` y el
`compose up --force-recreate` recreó los contenedores con la imagen vieja.
El job no falló porque el pull retornó exit 0 (pull "exitoso" sin descarga).
La fix manual fue: `docker logout ghcr.io && docker pull ...:<sha_largo>`,
retageo a `:latest` y `compose up --force-recreate`.

### Decisión
Eliminar `:latest` del path crítico del deploy. Cambios:

1. **`docker-compose.yml`**: los tres servicios (`web`, `scheduler`, `worker`)
   pasan a usar:
   ```yaml
   image: ghcr.io/johnydeev/ia-drive-doc-processor:${IMAGE_TAG:-latest}
   ```
   El default sigue siendo `:latest` para que `docker compose up` manual
   ad-hoc no se rompa.

2. **`.github/workflows/ci.yml`** (job `deploy`, step `Build and restart`):
   - Setear `IMAGE_TAG: ${{ github.sha }}` en el `env:` del step.
   - `docker pull ghcr.io/...:${{ github.sha }}` en vez de `:latest`.
     Si la imagen del SHA no existe en GHCR (build fallido silencioso,
     push denegado, etc.), el pull falla con error explícito → el job
     aborta → no se queda corriendo la imagen vieja.
   - `docker tag ...:${{ github.sha }} ...:latest` después del pull para
     mantener el alias local actualizado (preserva el flujo manual).
   - `compose run --rm web npx prisma migrate deploy` y
     `compose up -d --force-recreate` heredan `IMAGE_TAG` del step y
     usan la imagen pineada.

Beneficio adicional: el rollback manual ante un deploy malo queda trivial.
Hay que reapuntar `IMAGE_TAG` al SHA de la última versión buena y correr
`compose up`. No depende de moverse contra un tag mutable.

### Alternativas descartadas
- **Solo validar el digest después del pull y abortar si no cambió.**
  Funciona pero es frágil: requiere parsing y comparación de strings, y no
  soluciona el problema de que `:latest` siga siendo un tag mutable. Pinear
  por SHA elimina la categoría entera de problemas.
- **`docker pull --platform` o variantes de force-pull.** No existe un flag
  de `docker pull` que ignore el manifest cacheado. La única forma robusta
  es cambiar el tag.
- **Usar digest inmutable (`@sha256:...`) en lugar del SHA del commit.**
  Es la opción más estricta pero requiere capturar el digest del push en
  el build job y pasarlo al deploy. Más complejo sin un beneficio práctico
  significativo sobre pinear por SHA del commit (que ya es inmutable porque
  cada commit produce su propio tag).
- **Rollback automático ante deploy fallido.** Fuera de alcance — la
  detección ya existe vía el step "Wait for healthy"; un rollback
  automático merece su propia decisión.

### Impacto
- Archivos modificados:
  - `docker-compose.yml` — los tres servicios usan `${IMAGE_TAG:-latest}`.
  - `.github/workflows/ci.yml` — job `deploy` pin por SHA + retageo local.
- Sin cambios de schema, sin migración.
- Próximo push a master ejercita el nuevo flujo. Si el `docker pull
  :<sha>` falla, el deploy aborta antes de tocar contenedores en
  producción.

---

## 2026-05-18 — Claude (Anthropic) como tercer proveedor de IA en la cadena de extracción

### Problema
La extracción IA dependía de dos proveedores (Gemini → OpenAI). Cuando ambos
fallaban (rate limit simultáneo, error 5xx del lado del proveedor, key inválida
o quota agotada), el pipeline caía a `buildOcrOnlyPayload()` y la boleta
terminaba en "Sin Asignar". Sin un tercer proveedor independiente, cada
incidente en Gemini u OpenAI se traducía 1-a-1 en boletas no procesadas que
había que reintentar manualmente.

### Decisión
Sumar **Claude (Anthropic)** como tercer eslabón de fallback, manteniendo el
orden por costo/latencia: **Gemini → OpenAI → Claude → OCR_ONLY**. Anthropic
es independiente de Google (Gemini) y Microsoft/OpenAI, lo que reduce la
probabilidad de fallo simultáneo de los tres.

Patrón de implementación: espejar exactamente `AiExtractorService` (OpenAI).
Mismo prompt (`buildExtractionPrompt`), mismo refinamiento posterior
(`refineExtractionWithRawText`), mismo tracking de tokens
(`AiUsageMetrics`/`accumulateTokenUsage`) — solo cambia el SDK
(`@anthropic-ai/sdk` con `messages.create`) y el provider tag
(`"anthropic"`). Esto garantiza que la salida sea intercambiable con los
otros dos proveedores y que la deduplicación, canonización y matching
posteriores no necesiten ramas especiales por proveedor.

La key se configura por cliente vía `extractionConfigJson.anthropicApiKey`
(encriptada con `encrypt()`, igual que `geminiApiKey`/`openaiApiKey`), con
fallback a `env.ANTHROPIC_API_KEY` para el modo legacy. El modelo default
es `claude-haiku-4-5-20251001` (haiku 4.5, el más barato y rápido de la
familia Claude 4.x, alineado al uso "extracción simple, latencia baja").

### Alternativas descartadas
- **Anthropic primero, OpenAI último.** Descartado: Gemini sigue siendo el
  más barato por token y el primer eslabón natural. Reordenar habría
  encarecido el costo promedio sin ganancia funcional clara.
- **Wrapper genérico tipo "LLM router" (LiteLLM, Vercel AI SDK, etc.).**
  Descartado: agrega una abstracción extra que no resuelve un problema
  real en este pipeline (solo tres proveedores, mismo prompt, misma
  respuesta JSON). El patrón actual de tres servicios espejo es trivial
  de mantener y deja explícito qué SDK se usa en cada eslabón.
- **Reintentar Gemini/OpenAI con backoff antes de saltar al siguiente.**
  Descartado por ahora: cuando un proveedor responde con quota exceeded o
  con auth fail, reintentar no ayuda. El backoff se podría agregar más
  adelante si en producción aparecen errores transitorios recuperables.

### Impacto
- Archivos nuevos:
  - `src/services/claudeExtractor.service.ts` (servicio espejo de
    `AiExtractorService`).
- Archivos modificados:
  - `src/config/env.ts` — `ANTHROPIC_API_KEY` y `ANTHROPIC_MODEL` opcionales.
  - `src/types/client.types.ts` — `ClientExtractionConfig.anthropicApiKey`
    y `anthropicModel`.
  - `src/types/aiUsage.types.ts` — `AiProvider` extendido a `"anthropic"`.
  - `src/lib/clientProcessingConfig.ts` — `resolveAiConfig` desencripta
    y retorna la key/modelo de Anthropic.
  - `src/lib/logger.ts` — `pipelineLog.aiExtraction` admite `"anthropic"`.
  - `src/jobs/processPendingDocuments.job.ts` — tercer eslabón de fallback
    en el flujo PDF; `ProcessJobConfig.aiConfig` y `ProcessingContext`
    extendidos con `anthropicApiKey`/`anthropicModel`/`claudeModule`.
  - `src/app/api/client/consortiums/[id]/invoices/scan/route.ts` —
    tercer fallback en el scan manual.
  - `src/app/api/admin/clients/route.ts` (POST alta) y
    `src/app/api/admin/clients/[id]/route.ts` (GET/PATCH edición) —
    validación, encriptación y flag `hasAnthropicApiKey`.
  - `src/app/admin/clients/[id]/page.tsx` y `src/app/admin/page.tsx` —
    inputs nuevos en la UI.
- Sin cambios de schema Prisma: `extractionConfigJson` es JSON libre.
- Verificado con `npx tsc --noEmit` y `npm run build:jobs` en limpio.

---

## 2026-05-17 — Tag de imagen Docker con SHA del commit para rollbacks

### Problema
El step "Build and push image" en `.github/workflows/ci.yml` publicaba la imagen
únicamente como `ghcr.io/johnydeev/ia-drive-doc-processor:latest`. Cada push a
master sobreescribía el tag `:latest` en GHCR y se perdía la referencia
direccionable a la versión anterior. Si una release rompía algo en producción,
no había forma trivial de hacer rollback: no existía un tag estable apuntando al
build previo, y reproducirlo localmente no es práctico (depende del estado del
caché de Buildx, secretos y entorno del runner).

### Decisión
Pasar de un tag único a una lista YAML con dos tags por build:

```yaml
tags: |
  ghcr.io/johnydeev/ia-drive-doc-processor:latest
  ghcr.io/johnydeev/ia-drive-doc-processor:${{ github.sha }}
```

`docker/build-push-action@v6` empuja ambos tags en un único push (capas
compartidas, sin overhead de almacenamiento ni de tiempo). `:latest` sigue
siendo el tag mutable que consume el job `deploy`; el SHA es un tag inmutable
que queda para siempre asociado a ese commit específico.

Rollback manual ante un deploy malo:
```
docker pull ghcr.io/johnydeev/ia-drive-doc-processor:<sha_estable>
docker tag  ghcr.io/johnydeev/ia-drive-doc-processor:<sha_estable> \
            ghcr.io/johnydeev/ia-drive-doc-processor:latest
docker compose -p ia-drive-doc-processor up -d --force-recreate
```

### Alternativas descartadas
- **Tag por timestamp** (`:20260517-1830`): legible pero no trazable al commit;
  hay que cruzar con `git log` para saber qué cambió. El SHA es la única
  referencia que ya es canónica en GitHub.
- **Tag por número de run** (`${{ github.run_number }}`): se resetea si se
  recrea el workflow o se mueve a otro repo, y no tiene vínculo con el árbol
  de git.
- **Tag por versión semántica desde `package.json`**: requeriría disciplina de
  bump manual o release-please; hoy no hay versionado semántico en el repo.
- **Modificar el job `deploy` para usar SHA en vez de `:latest`**: el owner
  quiere mantener el deploy automático apuntando a `:latest`. El SHA queda
  disponible solo para rollback intencional.

### Impacto
- `.github/workflows/ci.yml`: único cambio (step "Build and push image" del job `build`).
- No afecta `deploy`, ni `docker-compose.yml`, ni los servicios `web/scheduler/worker`.
- A partir del próximo push a master habrá tags `:${{ sha }}` disponibles en GHCR.

---

## 2026-05-11 — Resumen agregado en el worker al vaciarse la cola

### Problema
El worker (`src/jobs/jobWorkerMain.ts`) corre un loop infinito de polling cada 2s y procesa jobs uno por uno. No tenía noción de "ciclo": cuando drenaba la cola, simplemente dormía 2s y volvía a buscar, sin emitir ningún resumen agregado. Operativamente no había forma de saber, de un vistazo en los logs, cuántos archivos terminó procesando en una tanda (procesados / sin asignar / duplicados / fallidos) — solo los logs individuales por job (`jobCompleted` / `jobFailed`).

### Decisión
Aprovechar la transición natural "tenía jobs → ahora cola vacía" como delimitador de ciclo. Cambios:

1. **`workerLog.cycleSummary()`** nuevo en `src/lib/logger.ts` con cuatro contadores: procesados, sin asignar, duplicados, fallidos (mismo orden y formato que `pipelineLog.batchSummary` y `schedulerLog.cycleSummary` para consistencia visual entre procesos).
2. **`handleJob()` retorna `ProcessJobSummary | null`** en lugar de `void`, para que el loop pueda acumular los contadores reales del summary del pipeline (no inferirlos a partir de success/failure del job).
3. **`runWorker()` mantiene 4 acumuladores** vivos entre iteraciones del `while (true)`. Solo se acumulan cuando `summary !== null` (es decir, el archivo llegó al pipeline). Los casos `clientNotFound` / `clientInactive` retornan null y no contaminan los contadores del ciclo.
4. **Gate `cycleProcessed + cycleFailed + cycleUnassigned > 0`**: evita imprimir resumen vacío en el caso degenerado donde solo hubo jobs con summary null (cliente eliminado/inactivo). Los duplicados solos no disparan el resumen porque siempre vienen acompañados de un `processed`.
5. **Reset post-emisión**: los 4 acumuladores vuelven a 0 antes del `sleep`, listos para el próximo ciclo.

### Alternativas descartadas
- **Contar jobs (no archivos)**: si un job representara N archivos, perderíamos granularidad. Como cada job procesa exactamente un archivo (`processSingleDriveFileJob`), los números coinciden, pero usar los contadores del `ProcessJobSummary` mantiene la semántica correcta si el pipeline cambia.
- **Emisión periódica (cada N segundos)**: rompe la lectura del log — un ciclo activo de 3 minutos podría imprimir varios resúmenes parciales del mismo lote.
- **Persistir el resumen en DB**: ya existe `ProcessingLog` por cliente vía `recordClientRun`. El requerimiento era visibilidad operativa en consola, no un nuevo registro de auditoría.
- **Contar el caso `summary === null` por excepción**: ese fallo no llegó al pipeline (cliente eliminado/inactivo), no es comparable a un fallo de procesamiento, y contaminaría el contador `failed`.

### Impacto
- Modificado: `src/lib/logger.ts` — método nuevo `workerLog.cycleSummary`
- Modificado: `src/jobs/jobWorkerMain.ts` — firma de `handleJob` retorna summary; acumuladores y emisión condicional en `runWorker`
- No se tocó: `src/jobs/scheduler.ts` ni `src/jobs/runProcessingCycle.ts`

---

## 2026-05-11 — Resumen del ciclo automático del scheduler

### Problema
El scheduler automático (`src/jobs/scheduler.ts`) encola jobs directamente sin pasar por `runProcessingCycle`, por lo que nunca emitía el "RESUMEN TOTAL DEL CICLO" que sí se imprime en los flujos manuales (`/api/process` y `/api/admin/scheduler/run`). Operativamente no había forma rápida de saber, mirando los logs, cuántos archivos se encontraron, cuántos se encolaron y cuántos ya estaban en cola en un ciclo dado.

### Decisión
Agregar un resumen específico para el scheduler automático sin tocar `runProcessingCycle` (cuya semántica de "ciclo de procesamiento manual" es distinta). Cambios:

1. **`schedulerLog.cycleSummary()`** nuevo método en `src/lib/logger.ts` con tres contadores: `totalFound`, `totalQueued`, `totalSkipped`.
2. **`runOnce()` en `src/jobs/scheduler.ts`** acumula los contadores:
   - `totalFound += files.length` por cada cliente con archivos pendientes.
   - `totalQueued += 1` al crear un nuevo `ProcessingJob`.
   - `totalSkipped += 1` cuando el archivo ya tiene un job `PENDING`/`PROCESSING` (no se cuenta el caso `existingInvoice` porque no es "ya en cola" sino "ya procesado").
3. **Gate `totalFound >= 1`**: si no se encontró ningún archivo, no se imprime nada — evita ruido en ciclos vacíos que ya tienen su propio log `clientNoPdfs`.

### Alternativas descartadas
- **Refactorizar el scheduler para reusar `runProcessingCycle`**: cambiaría la arquitectura scheduler-encola → worker-procesa, que es intencional (desacople).
- **Imprimir el resumen siempre**: ruido innecesario cuando no hay archivos.
- **Contar `existingInvoice` en `totalSkipped`**: confundiría "ya procesado" (estado terminal) con "ya en cola" (en progreso).

### Impacto
- Modificado: `src/lib/logger.ts` — método nuevo `schedulerLog.cycleSummary`
- Modificado: `src/jobs/scheduler.ts` — contadores + emisión condicional en `runOnce`
- No se tocó: `src/jobs/runProcessingCycle.ts` ni los endpoints `/api/process` ni `/api/admin/scheduler/run`

---

## 2026-04-15 — Fix lógica de deduplicación

### Problema
El pipeline marcaba como duplicados boletas con **distinto `boletaNumber`** pero **mismo monto y vencimiento**. Caso testigo: dos facturas mensuales de RANKO S.R.L. (0003-00154753 y 0003-00155282) con mismo monto y vencimiento idéntico se marcaban como duplicado, perdiendo la segunda. Además, los duplicados se persistían en DB con `isDuplicate=true` aunque el requerimiento era no guardarlos (solo registro en Sheets para auditoría).

El root cause estaba en `invoice.repository.ts::findDuplicateByBusinessKey`: el `WHERE` de Prisma usaba los 4 campos de la business key como condición obligatoria, pero cuando algún campo venía vacío ("") el query matcheaba contra filas que también tuvieran ese campo vacío, reduciendo el match efectivamente a los 2-3 campos poblados.

### Decisión
El `boletaNumber` es el identificador primario de una factura — si dos boletas tienen distinto `boletaNumber` son documentos distintos, sin excepción. Cambios:

1. **`WHERE` dinámico**: `findDuplicateByBusinessKey` ahora arma el `WHERE` incluyendo únicamente los campos no vacíos. Si `boletaNumber` está presente queda como condición obligatoria del match.
2. **Mínimo 2 campos**: para considerar un posible duplicado se requieren ≥ 2 campos presentes en la business key. Con solo 1 campo la heurística es demasiado débil.
3. **Nueva función `isDuplicateByPriority`** en `src/lib/businessKey.ts` para validar en memoria (dos `BusinessKeyParts`) con la misma regla: boletaNumber distinto → nunca duplicado.
4. **Duplicados no se persisten**: cuando `isDuplicate === true` el pipeline salta `saveProcessedInvoice`. Se mantiene la inserción en Sheets (columna L = "YES") y el move a Escaneados para auditoría, pero no se crea registro en DB.

### Alternativas descartadas
- **Mantener el `WHERE` estático y filtrar en código**: menos eficiente y duplicaría la lógica de comparación.
- **Usar la unique constraint `uq_invoice_business_key` de la DB**: no aplica porque el problema es detectar duplicados *antes* de insertar, no después.
- **Guardar duplicados con flag `isDuplicate=true`**: descartado por pedido explícito — los duplicados ensucian la DB y las queries de reporte tienen que filtrar el flag en todos lados.

### Impacto
- Modificado: `src/lib/businessKey.ts` — nueva función `isDuplicateByPriority`
- Modificado: `src/repositories/invoice.repository.ts` — `findDuplicateByBusinessKey` con `WHERE` dinámico y mínimo 2 condiciones
- Modificado: `src/jobs/processPendingDocuments.job.ts` — `saveProcessedInvoice` solo para no-duplicados
- Sin cambios de schema ni migraciones

---

## 2026-04-15 — Solapa Pagos en vista de consorcio

### Problema
La UI tenía una sola tabla que mezclaba visualización de boletas con estado de pago en una columna chica. Registrar pagos requería subir un recibo (endpoint `/receipt`) y no había forma de registrar pagos masivos ni sin PDF. Además, los medios de pago no eran consistentes ni tenían el banco del consorcio como contexto.

### Decisión
Separar la vista del consorcio en dos solapas: **Boletas** (sin cambios) y **Pagos** (nueva, inline editable). Los gastos no se pueden modificar desde Pagos y viceversa. El pago se registra inline en la tabla (no modal) y se confirma con GUARDAR en lote. 

Reglas:
- **Empleados** (`providerType = EMPLEADO`): solo editan fecha de pago — el importe siempre es el monto total (no se permiten pagos parciales a empleados).
- **Proveedores**: editan fecha + importe (vacío = saldo pendiente completo) + medio de pago (dropdown).
- **Medios de pago**: `Transferencia [BANCO]`, `Cheque propio [BANCO]` (cuando el consorcio tiene banco configurado), `Descuento`, `Efectivo`. Guardados como texto libre en `Payment.paymentMethod`.

Al guardar, la ruta `POST /api/client/invoices/:id/payments` crea el `Payment`, recalcula `isPaid`/`remainingBalance` y — si la boleta quedó totalmente pagada — actualiza la columna N ("ESTADO PAGO") en Google Sheets a "Pagado". La búsqueda de fila en Sheets usa `sourceFileUrl` como clave primaria, con fallback a `boletaNumber + providerTaxId`.

### Migración expand-contract
`Payment.driveFileId` y `Payment.driveFileUrl` pasan a opcionales (`String?`) porque los pagos desde la solapa Pagos no requieren adjuntar comprobante. Se agrega `Payment.paymentMethod String?` como texto libre.

### Alternativas descartadas
- **Enum `PaymentMethod`**: el set de opciones depende del banco del consorcio (dinámico) y textos como "Transferencia [GALICIA]" no caben en un enum. Texto libre con dropdown controlado en UI es más flexible.
- **Modal por pago**: lento para cargar pagos masivos del mes. La tabla editable + GUARDAR en lote es más eficiente.
- **Pago parcial a empleados**: descartado por pedido explícito del owner (los sueldos se pagan completos).

### Impacto
- Migración: `prisma/migrations/20260415000200_payment_optional_drive_add_payment_method`
- Modificado: `prisma/schema.prisma` — `Payment.driveFileId?`, `driveFileUrl?`, nuevo `paymentMethod`
- Modificado: `src/repositories/payment.repository.ts` — `CreatePaymentInput` con campos opcionales + `paymentMethod`
- Modificado: `src/app/api/client/invoices/[id]/payments/route.ts` — schema Zod, sync con Sheets
- Modificado: `src/app/api/client/consortiums/[id]/invoices/route.ts` — agrega `providerType` al response
- Modificado: `src/services/googleSheets.service.ts` — nuevo `updatePaymentStatus()`
- Modificado: `src/app/admin/consortiums/page.tsx` — tabs + componente `PagosView`
- Modificado: `src/app/admin/consortiums/page.module.css` — estilos tabs + pagos

---

## 2026-04-15 — Soporte de imágenes JPG/PNG en pipeline

### Problema
El scheduler solo detectaba PDFs. Imágenes JPG/PNG en la carpeta Pendientes eran ignoradas completamente. Algunos proveedores envían fotos de facturas en lugar de PDFs.

### Decisión
Extender el filtro de mimeType en GoogleDriveService para incluir image/jpeg e image/png. En el pipeline, cuando el archivo es una imagen, saltear pdf-parse y OCR y usar Gemini Vision directamente con el buffer de la imagen. El flujo de matching, deduplicación y movimiento de archivos permanece igual. `lspProvider` queda como `null` para imágenes (no tiene sentido correr el router LSP sin texto).

### Alternativas descartadas
- **Convertir imagen a PDF primero**: agrega complejidad y dependencia (ImageMagick), sin beneficio real ya que Gemini Vision procesa imágenes nativamente.
- **OCR con Tesseract sobre la imagen**: peor calidad que Gemini Vision directo.

### Impacto
- Modificado: `src/services/googleDrive.service.ts` — query mimeType ampliado
- Modificado: `src/services/geminiExtractor.service.ts` — `extractStructuredDataFromImage()`
- Modificado: `src/jobs/processPendingDocuments.job.ts` — detección `isImage`, rama visual
- Modificado: `ProcessDriveFileInput` — nuevo campo `mimeType`

---

## 2026-04-15 — Empleados de consorcio como tipo de proveedor

### Problema
Los consorcios tienen empleados (encargados) cuyos recibos de haberes necesitan ser trackeados igual que las facturas de proveedores. Los recibos tienen estructura diferente: CUIL en lugar de CUIT, neto a cobrar en lugar de importe total, período de liquidación.

### Decisión
Extender la tabla Provider con un campo `providerType` (enum PROVEEDOR/EMPLEADO) en lugar de crear una tabla Employee separada. Los empleados se dan de alta en la misma hoja `_Proveedores` del archivo ALTA con una columna TIPO. El pipeline detecta recibos de haberes por keywords (`isReciboHaberes()`) y usa un prompt dedicado que extrae CUIL y neto a cobrar correctamente.

### Alternativas descartadas
- **Tabla Employee separada**: requiere migración más compleja, duplica infraestructura de matching y Sheets. El modelo de datos es el mismo.
- **Campo libre en matchNames**: poco explícito y no permite filtrar en UI.

### Impacto
- Migración: `20260415000100_add_provider_type`
- Modificado: `src/services/googleSheets.service.ts` (DirectoryData, readDirectory, header TIPO)
- Modificado: `src/app/api/client/sync-directory/route.ts` (providerType en upsert)
- Modificado: `src/lib/extraction.ts` (isReciboHaberes, buildReciboHaberesPrompt)
- Modificado: `src/app/admin/consortiums/page.tsx` (badge EMPLEADO, label CUIL)

---

## 2026-04-14 — Fallback visual Gemini Vision para emisor en imagen

### Problema
Facturas generadas con GESTIONPRO tienen el bloque del emisor (nombre, CUIT) en imagen vectorial no seleccionable. pdf-parse y Tesseract no capturan ese texto. El pipeline terminaba en Sin Asignar aunque el consorcio sí matcheaba.

### Decisión
Agregar un paso de fallback visual como ÚLTIMA instancia antes de Sin Asignar. Condiciones estrictas para activarlo: proveedor no encontrado (unassigned=true), consorcio sí encontrado (consortiumId!=null), bloque emisor no detectado (hasEmitterBlock=false), PNG disponible del OCR, y geminiModule configurado. Gemini recibe el PNG y un prompt focalizado solo en identificar el emisor. Si retorna datos, se reintenta resolveAssignment. Si falla por cualquier razón, fallo silencioso y el flujo continúa normal.

### Alternativas descartadas
- **Siempre enviar imagen a Gemini**: desperdicio de tokens y latencia en facturas que ya se procesan bien con texto.
- **OCR más agresivo (Tesseract con configuración especial)**: el bloque es una imagen vectorial embebida, Tesseract la captura parcialmente pero no de forma confiable.

### Impacto
- Modificado: `src/services/pdfTextExtractor.service.ts` — `getLastOcrPng()`, `getLastHasEmitterBlock()`
- Modificado: `src/services/ocr.service.ts` — `getLastFirstPagePng()`
- Modificado: `src/services/geminiExtractor.service.ts` — `extractProviderFromImage()`
- Modificado: `src/jobs/processPendingDocuments.job.ts` — bloque fallback visual
- Sin cambios de schema ni migraciones
- Opt-in automático: solo se activa cuando las condiciones lo justifican

---

## 2026-04-13 — Modo Debug por cliente usando extractionConfigJson

### Problema
Diagnosticar problemas de extracción (OCR confuso, Gemini confundiendo emisor/receptor, etc.) requería agregar logs temporales al pipeline, deployar, y luego removerlos. Sin un mecanismo de debug on-demand, cada incidente requería un ciclo de deploy.

### Decisión
Agregar un flag `debugMode` dentro de `extractionConfigJson` (campo JSON flexible existente en Client). Cuando está activo, el pipeline logea:
1. El texto completo post-OCR (después de la re-extracción de página 1 para LSPs)
2. La respuesta raw de la extracción IA (Gemini/OpenAI)

Se controla desde el panel admin con un toggle por cliente (botón en la tabla de métricas). El endpoint `PATCH /api/admin/clients/[id]/debug-mode` solo requiere rol ADMIN.

### Alternativas descartadas
- **Variable de entorno global**: afectaría todos los clientes, no se puede activar selectivamente.
- **Campo dedicado en schema**: requiere migración innecesaria — el JSON flexible ya existe.

### Impacto
- Nuevo: `src/app/api/admin/clients/[id]/debug-mode/route.ts`
- Modificado: `src/jobs/processPendingDocuments.job.ts` — campo `debugMode` en `ProcessJobConfig`, logs condicionales
- Modificado: `src/jobs/runProcessingCycle.ts` y `src/jobs/jobWorkerMain.ts` — propagan `debugMode`
- Modificado: `src/app/api/admin/audit/clients/route.ts` — incluye `debugMode` en respuesta
- Modificado: `src/app/admin/page.tsx` — toggle en tabla de clientes

---

## 2026-04-09 — Lock de archivo vía carpeta Procesando en Drive

### Problema
Race condition entre ciclos concurrentes: un run manual y el scheduler podían empezar al mismo tiempo, listar Pendientes, y tomar el mismo PDF antes de que el primero lo moviera a Escaneados. Resultado: doble procesamiento, doble inserción en Sheets (con la dedup por hash/business key como único colchón — no siempre suficiente si el segundo ciclo llega antes de guardar el Invoice).

### Decisión
Usar una carpeta intermedia "Procesando" como lock atómico a nivel Drive:

1. Nuevo campo opcional `processing` en `driveFoldersJson` (sin migración — el JSON es flexible).
2. Tras descargar el PDF, el pipeline lo mueve inmediatamente a `processing` con `moveFileToFolder`. La operación de Drive es atómica: si dos ciclos intentan moverlo, solo uno gana.
3. Los movimientos finales (Escaneados / Sin Asignar / Fallidos) usan `processingFolderId ?? drivePendingFolderId` como carpeta origen. Cuando el lock está activo, vienen desde Procesando; si no hay lock configurado, cae al comportamiento legacy desde Pendientes.
4. El move al lock está en try/catch: si falla (permisos, carpeta inexistente), se loguea warning y el procesamiento continúa desde Pendientes. Esto hace el feature opt-in y no bloqueante para clientes existentes.

### Alternativas descartadas
- **Lock en DB (flag `processing` en un registro)**: requiere migración, agrega dependencia transaccional y no protege contra crashes del worker (lock huérfano).
- **Lista de IDs in-memory en cada ciclo**: no protege contra múltiples procesos (scheduler + worker son containers separados).
- **Advisory lock de PostgreSQL**: añade acoplamiento y no es visible desde Drive (más difícil de diagnosticar).

### Impacto
- Modificado: `src/types/client.types.ts` — campo `processing?: string | null` en `ClientDriveFolders`
- Modificado: `src/lib/clientProcessingConfig.ts` — `ResolvedFolders.processing` + `resolveFolders()`
- Modificado: `src/jobs/processPendingDocuments.job.ts` — `ProcessJobConfig.driveProcessingFolderId`, move al lock post-download, origen de movimientos finales
- Modificado: `src/jobs/runProcessingCycle.ts` y `src/jobs/jobWorkerMain.ts` — pasan `folders.processing` al config
- Sin cambios de schema ni migraciones
- Opt-in: clientes existentes siguen funcionando sin configurar `processing`

---

## 2026-04-09 — Fix providerId/providerTaxId en LSP fast path

### Problema
El LSP fast path resolvía correctamente consortiumId y lspServiceId pero no asignaba providerId ni providerTaxId al Invoice. Quedaban NULL aunque el LspService ya tuviera su FK a Provider resuelta.

### Decisión
En el fast path, después de encontrar el LspService, incluir `providerRef` en el query para obtener id, cuit y paymentAlias del Provider. Usar cascada: primero el CUIT lookup (ya existente), luego la FK del LspService como fallback. Sin campos nuevos en AssignmentResult — el campo `providerId` existente ya servía, solo no se estaba poblando correctamente.

### Impacto
- Modificado: `processPendingDocuments.job.ts`
- Sin cambios de schema ni migraciones

---

## 2026-04-09 — Mapa router→canonicalName para LspService lookup

### Problema
El router `identifyLSPProvider()` usa nombres cortos ("PERSONAL", "EDESUR") mientras que en LspService los proveedores se cargan con razón social completa ("TELECOM ARGENTINA S.A.", "EDESUR S.A."). El lookup por `providerName` fallaba silenciosamente.

### Decisión
Constante `LSP_ROUTER_TO_CANONICAL` que mapea cada nombre del router a su razón social canónica. Se aplica antes del fallback lookup por nombre en LspService. El lookup por `providerId` (FK) no cambia — es más robusto y no necesita el mapa.

### Impacto
- Modificado: `processPendingDocuments.job.ts`
- Sin cambios de schema ni migraciones

---

## 2026-04-09 — Rename LspService.provider → providerName

### Problema
El campo `provider` en LspService era ambiguo — mismo nombre que la tabla Provider. Con la adición de `providerId` como FK, tener `provider` (texto) y `providerId` (FK) era confuso. `providerName` clarifica que es el nombre en texto.

### Decisión
Rename provider→providerName. Expand-contract para zero-downtime. La tabla Provider no se toca — es un rename de columna solamente.

### Impacto
- Migración: `20260409000200_rename_lspservice_provider`
- Modificados: schema.prisma, processPendingDocuments.job.ts, sync-directory/route.ts, lsp-services/route.ts, consortiums/page.tsx

---

## 2026-04-09 — Fix resolución providerId en sync-directory LspServices

### Problema
Al sincronizar la hoja _LspServices desde el archivo ALTA, el campo providerId quedaba NULL aunque el proveedor existiera en la tabla Provider con el mismo canonicalName. No había warning visible cuando el match fallaba.

### Decisión
Mantener ambos campos en LspService: provider (texto, para el pipeline) y providerId (FK, para integridad referencial). Agregar warning cuando providerId no se resuelve. Incluir paso retroactivo al final del bloque que resuelve providerId NULL en registros históricos en cada sync.

### Impacto
- Modificado: src/app/api/client/sync-directory/route.ts
- Sin cambios de schema ni migraciones

---

## 2026-04-09 — Fix normalización clientNumber con espacios internos

### Problema
La normalización de clientNumber solo eliminaba ceros a la izquierda. Edenor formatea el número de cuenta con espacios (ej: "8 620 004 726") mientras la DB lo guarda sin espacios. El lookup de LspService fallaba silenciosamente y lspServiceId quedaba NULL.

### Decisión
Normalización en dos pasos: primero `.replace(/\s+/g, "")` para eliminar todos los espacios, luego `.replace(/^0+/, "")` para eliminar ceros. Aplicado en los 3 puntos donde se procesa clientNumber: pipeline, sync-directory y endpoint UI.

### Impacto
- Modificados: `processPendingDocuments.job.ts`, `sync-directory/route.ts`, `lsp-services/route.ts`
- Sin cambios de schema ni migraciones

---

## 2026-04-09 — Bloqueo de boletas LSP con clientNumber no registrado

### Problema
El pipeline procesaba boletas LSP aunque el clientNumber extraído no existiera en la tabla LspService. Esto generaba boletas en Sheets sin vínculo al servicio correcto.

### Decisión
Si se detecta lspProvider y el lookup de LspService falla → `unassigned: true` con razón descriptiva. El archivo se mueve a Sin Asignar en Drive. No se guarda Invoice ni se escribe en Sheets. El administrador debe cargar el LspService correspondiente y luego usar "Reprocesar Sin Asignar".

### Impacto
- Modificados: `processPendingDocuments.job.ts`, `logger.ts`
- Sin cambios de schema ni migraciones

---

## 2026-04-09 — Convención de nombres de campos en inglés

### Problema
Los campos `banco` y `claveSuterh` se crearon en español, inconsistente con el resto del schema (`canonicalName`, `matchNames`, `paymentAlias`, etc.).

### Decisión
Todos los campos nuevos del schema usan camelCase en inglés. Rename `banco`→`bank`, `claveSuterh`→`suterhKey`. El header visible en Sheets ("BANCO") no cambia — es presentación, no schema.

### Impacto
- Migración: `20260409000100_rename_consortium_banco_suterh`
- Modificados: `schema.prisma` + todos los archivos que referenciaban `banco`/`claveSuterh`

---

## 2026-04-07 — Campos banco y claveSuterh en Consortium

### Problema
Los consorcios necesitan registrar el banco asociado (visible en Sheets) y la clave SUTERH (dato interno).

### Decisión
Dos campos nullable en Consortium. Solo `banco` va a Sheets (columna O). `claveSuterh` es dato interno sin UI por ahora. Sin UI de edición en esta iteración.

### Impacto
- Migración: `20260407000100_add_consortium_banco_suterh`
- Modificados: `schema.prisma`, `googleSheets.service.ts`, `clientProcessingConfig.ts`, `processPendingDocuments.job.ts`, `invoices/route.ts`, `extractedDocument.types.ts`

---

## 2026-04-04 — Refactor layout 3 columnas + modal configuracion

### Problema
El layout fusionaba navSidebar y lista de consorcios en un solo `<aside>`, lo que hacía que colapsar el nav también ocultara la lista. Además, la edicion de matchNames estaba inline ocupando espacio permanente en el área de contenido.

### Decision
Separar en 3 columnas independientes: navSidebar (colapsable, 220px/56px) | sidebar de consorcios (fija 220px) | contenido. La lista de consorcios ya no depende del estado colapsado del nav. La edicion de matchNames se movió a un modal de configuración accesible via botón "Configuración" en detailActions. El botón "Cerrar sesión" se reubicó al fondo del navSidebar con un spacer flex. En mobile (≤1024px) el sidebar de consorcios se oculta (los consorcios se acceden via el nav mobile).

### Impacto
- Modificados: `page.tsx`, `page.module.css`
- Nuevas clases CSS: `.sidebar`, `.contentCol`, `.configBtn`, `.configSection`, `.configSectionTitle`, `.configSectionDesc`
- Nuevo estado: `showConfigModal`
- Sin cambios de schema ni migraciones

---

## 2026-04-04 — Correcciones UX consorcios + fix build CSS Modules

### Problema
5 bugs en page.tsx de consorcios: sidebar duplicado, boletas sin renderizar (page flex-direction:column rompia el layout row), monto total concatenado (Prisma Decimal + number = string), tabla LSP sin badge identificador, toggle de tema sin efecto en DOM. Ademas, build roto por selectores globales `[data-theme]` en CSS Modules.

### Decision
Correccion de reduce() para sumar Decimals con `Number()`. Badge visual "LSP" en la columna proveedor. useEffect para aplicar `data-theme` al `document.documentElement`. Variables de tema movidas a globals.css (CSS Modules no permite selectores globales).

### Impacto
- Modificados: `page.tsx`, `page.module.css`, `globals.css`
- Sin cambios de schema ni migraciones

---

## 2026-04-02 — Sistema de pagos parciales: tabla Payment separada

### Problema
Las boletas (Invoice) podían tener un único comprobante de pago (`receiptDriveFileId`/`receiptDriveFileUrl`) pero no soportaban pagos parciales ni cuotas.

### Decisión
Tabla `Payment` separada (one-to-many con Invoice) en lugar de agregar campos de pago directamente a Invoice. Dos modos: cuotas pactadas (monto total / N cuotas, autoincremento) y pagos libres (monto manual). El modo se define en el primer pago y es inmutable. `isPaid` y `remainingBalance` en Invoice se actualizan automáticamente en cada transacción. El último pago de cuotas ajusta el monto para absorber redondeos.

### Alternativas descartadas
- Campos de pago directo en Invoice: no soporta múltiples pagos.
- Tabla Payment + tabla Installment separada: overengineering; `installmentNumber`/`totalInstallments` en Payment es suficiente.

### Impacto
- Migración: `20260402000200_add_payment_tracking`
- Nuevos archivos: `payment.repository.ts`, `invoices/[id]/payments/route.ts`, `invoices/[id]/payments/[paymentId]/route.ts`
- Modificados: `schema.prisma`, `page.tsx` (consortiums), `receipt/route.ts`
- Eliminados de Invoice: `receiptDriveFileId`, `receiptDriveFileUrl`

---

## 2026-04-02 — CUITs alternativos de consorcio en matchNames

### Problema
Algunos consorcios tienen más de un CUIT (ej: re-inscripción en AFIP). El schema solo soporta un campo `cuit` por consorcio. Cuando una factura usa el CUIT alternativo, el matching por CUIT falla y el archivo va a Sin Asignar.

### Decisión
Reutilizar el campo `matchNames` para almacenar CUITs alternativos (pipe-separated junto con aliases de nombre). El pipeline detecta si un valor en `matchNames` tiene formato CUIT (10+ dígitos numéricos tras normalización) y lo incluye en el matching por CUIT de allTaxIds. Sin migración — reutiliza infraestructura existente.

### Uso
En el archivo ALTA de Google Sheets, agregar el CUIT alternativo en la columna Aliases del consorcio: "30-71893736-8" (se guarda en matchNames).

### Alternativas descartadas
- Campo `cuitAlt` en schema: más limpio semánticamente pero requiere migración y cambios en sync-directory.
- Actualizar el CUIT principal: no aplica cuando ambos CUITs son válidos simultáneamente.

### Impacto
- Modificado: `src/jobs/processPendingDocuments.job.ts` (matching CUIT consorcio)
- Sin cambios en schema ni migraciones

---

## 2026-04-02 — OCR híbrido para PDFs con bloque emisor en imagen

### Problema
PDFs como Ikarus Seguridad tienen el bloque del emisor (nombre, CUIT) renderizado como imagen dentro del PDF. pdf-parse extrae el texto del cuerpo pero omite la imagen. El resultado no está vacío, por lo que el fallback a Tesseract no se activaba. La IA recibía texto sin CUIT del emisor y extraía proveedor=null.

### Decisión
Implementar detección semántica del bloque emisor AFIP en `pdfTextExtractor.service.ts`: si el texto extraído no contiene etiquetas exclusivas del emisor ("ING. BRUTOS", "INICIO DE ACTIVIDADES", "RESPONSABLE INSCRIPTO", "MONOTRIBUTO"), se activa OCR con pdftoppm + Tesseract. Los textos se combinan con separador `--- OCR ---`. OcrService reescrito para usar pdftoppm (poppler-utils) en lugar de pdfjs-dist + @napi-rs/canvas. Fallo silencioso: si OCR falla, el pipeline continúa con texto de pdf-parse.

### Impacto
- Reescrito: `src/services/ocr.service.ts` (pdftoppm en lugar de pdfjs-dist)
- Modificado: `src/services/pdfTextExtractor.service.ts` (detección bloque emisor + try/catch)
- Modificado: `Dockerfile` (agregado `poppler-utils`)

---

## 2026-04-02 — OCR migrado de pdfjs-dist a pdftoppm

### Problema
El servicio OCR usaba `pdfjs-dist` + `@napi-rs/canvas` para renderizar páginas de PDF a imagen y luego pasarlas a Tesseract. Esto requería dependencias nativas pesadas (`@napi-rs/canvas`) y era frágil en el container Docker.

### Decisión
Reescribir `ocr.service.ts` para usar `pdftoppm` (del paquete `poppler-utils`) en lugar de `pdfjs-dist`. pdftoppm convierte el PDF a imágenes PNG en disco (200 DPI), y luego Tesseract las procesa. Se eliminaron los imports de `pdfjs-dist` y `@napi-rs/canvas`.

Además, la llamada al OCR desde `pdfTextExtractor.service.ts` se envolvió en try/catch para que si OCR falla, el pipeline continúe con el texto de pdf-parse.

### Impacto
- Reescrito: `src/services/ocr.service.ts`
- Modificado: `src/services/pdfTextExtractor.service.ts` (try/catch)
- Modificado: `Dockerfile` (agregado `poppler-utils`)

---

## 2026-04-02 — Upsert de Proveedores en sync-directory con constraint único

### Problema
El loop de upsert de proveedores en sync-directory usaba `findFirst` + `update`/`create` — 2 queries por proveedor, lo que generaba overhead innecesario en la transacción.

### Decisión
Agregar `@@unique([clientId, canonicalName])` a Provider y usar `upsert` directo de Prisma con el compound key. Reduce a 1 query por proveedor.

### Alternativas descartadas
Mantener `findFirst` + `update`/`create` para evitar migración. Se descartó porque el `upsert` es más performante y el constraint único es correcto semánticamente (no debería haber 2 proveedores con el mismo nombre canónico por cliente).

### Impacto
- Modificado: `prisma/schema.prisma` (nuevo `@@unique`)
- Modificado: `src/app/api/client/sync-directory/route.ts` (upsert)
- Migración: `20260402000100_provider_unique_client_canonical`

---

## 2026-03-30 — Mejora fallback OCR para PDFs con bloques en imagen

### Problema
PDFs como Ikarus Seguridad tienen el bloque del emisor (nombre, CUIT) renderizado
como imagen dentro del PDF. pdf-parse extrae el texto del cuerpo pero omite la
imagen. El resultado no está vacío, por lo que el fallback a Tesseract no se
activaba. La IA recibía texto sin CUIT del emisor y extraía proveedor=null.

### Decisión
Cambiar el umbral de activación del OCR en PdfTextExtractorService:
- Antes: activar solo si directText.length === 0
- Ahora: activar si directText < 100 chars O si no contiene secuencia de 10+
  dígitos consecutivos (indicador de ausencia de CUIT/CAE en el texto)
Cuando OCR produce más texto que pdf-parse, combinar ambos con separador
`--- OCR ---` para que la IA tenga toda la información disponible.

### Impacto
- Modificado: `src/services/pdfTextExtractor.service.ts`
- Sin cambios en pipeline, schema ni prompts
- Mejora automática para cualquier PDF con bloques en imagen, no solo Ikarus

---

## 2026-03-30 — Fix: scheduler no reprocesaba archivos con job COMPLETED/FAILED

### Problema
El scheduler chequeaba existingJob sin filtrar por status. Archivos que volvían a Pendientes (ej: via requeue desde Sin Asignar) eran salteados si tenían un ProcessingJob previo en cualquier estado, incluyendo COMPLETED y FAILED.

### Decisión
Agregar `status: { in: ["PENDING", "PROCESSING"] }` al findFirst de existingJob en scheduler.ts. Solo se saltea si hay un job activo en curso. Jobs terminados (COMPLETED/FAILED) no bloquean el reprocesamiento. El check de existingInvoice sigue siendo el guard principal contra duplicados reales.

### Impacto
- Modificado: `src/jobs/scheduler.ts`
- Sin cambios en schema ni migraciones

---

## 2026-03-30 — Feature: Reprocesar Sin Asignar desde el panel (Opción C)

### Problema
Los archivos que van a Sin Asignar (proveedor no encontrado en DB) quedaban bloqueados hasta que el usuario los movía manualmente en Drive a Pendientes. No había forma de reencolarlos desde el panel.

### Decisión
- Endpoint GET /api/client/unassigned/preview: lista PDFs en carpeta Sin Asignar.
- Endpoint POST /api/client/unassigned/requeue: mueve archivos de Sin Asignar a Pendientes usando moveFileToFolder de GoogleDriveService. Tolerancia a fallos por archivo.
- El scheduler detecta los archivos en Pendientes en el próximo ciclo y los encola como ProcessingJob normalmente — reutiliza toda la infraestructura existente.
- No hay race condition: el check existingJob del scheduler previene duplicados.
- No hay timeout HTTP: el endpoint solo mueve archivos (operación liviana).
- UI: botón en sidebar, modal de 2 pasos (preview con lista → resultado con conteo).

### Alternativas descartadas
- Opción A (mover + procesar sincrónicamente): timeout HTTP con muchos archivos.
- Opción B (procesar directo desde Sin Asignar): requería cambios en el pipeline y tenía el mismo problema de timeout HTTP.

### Impacto
- Nuevos: `src/app/api/client/unassigned/preview/route.ts`, `src/app/api/client/unassigned/requeue/route.ts`
- Modificado: `src/app/admin/consortiums/page.tsx` (botón sidebar + modal)
- Sin cambios en schema, migraciones ni pipeline

---

## 2026-03-30 — Mejora de extracción allTaxIds y providerTaxId en facturas normales

### Problema
Tres casos reales mostraron fallas en la extracción de CUITs: (1) BSS con dos labels C.U.I.T. en el mismo documento, (2) Ferretería Serrano con el consorcio bajo label `DNI: 30714787256` (11 dígitos = CUIT) que el prompt anterior excluía, (3) Ikarus Seguridad con el CUIT del emisor en imagen no copiable. En todos los casos allTaxIds no capturaba los CUITs suficientes para el CUIT-first matching del pipeline.

### Decisión
Mejorar ALL_TAX_IDS_RULES: incluir valores bajo label `DNI:` si tienen exactamente 11 dígitos (CUIT mal etiquetado), excluir si tienen menos (DNI real). Agregar Ingresos Brutos como señal del CUIT del emisor. Excluir explícitamente CAE (14 dígitos) y número de comprobante. Mejorar buildInvoicePrompt con descripción estructural del layout AFIP estándar para que la IA distinga bloque emisor de bloque receptor y sepa que providerTaxId puede ser null sin romper el matching.

### Alternativas descartadas
- Validar el dígito verificador del CUIT en el prompt: demasiado complejo para instrucción de IA, mejor hacerlo en el pipeline si fuera necesario.
- Modificar el pipeline para intentar parsing de DNI: innecesario, la solución en el prompt es más limpia.

### Impacto
- Modificado: `src/lib/extraction.ts` (ALL_TAX_IDS_RULES + buildInvoicePrompt)
- Sin cambios en pipeline, schema ni migraciones

---

## 2026-03-30 — LspServices: delete + create en lugar de PUT/PATCH

### Problema
Se necesitaba un CRUD de LspServices por consorcio en la UI. ¿Implementar edición (PUT/PATCH) o solo crear y eliminar?

### Decisión
No se implementa endpoint de edición (PUT/PATCH). Con delete + create es suficiente dado que LspService tiene solo 3 campos editables (provider, clientNumber, description) y el unique constraint es sobre `(consortiumId, provider, clientNumber)`, que son los campos clave. Editar implica cambiar la identidad del registro. Es más simple y menos propenso a errores eliminar y recrear.

### Alternativas descartadas
- **PUT/PATCH endpoint**: agrega complejidad innecesaria. Si se cambia provider o clientNumber hay que validar el nuevo unique constraint y manejar el caso de que el nuevo combo ya exista, que es lo mismo que crear uno nuevo.

### Impacto
- Menos código de backend (un endpoint menos)
- UI más simple (no requiere modal de edición, solo tabla + formulario inline + botón eliminar)

---

## 2026-03-30 — matchNames y LspServices integrados en vista de detalle de consorcio

### Problema
¿Dónde ubicar la edición de matchNames y la gestión de LspServices en la UI?

### Decisión
Ambas features se integran directamente en la vista de detalle del consorcio seleccionado (`page.tsx`), entre el header y la navegación de períodos. No se crean modales ni páginas separadas. matchNames usa un campo inline con toggle editar/ver. LspServices usa una tabla + formulario inline dentro de una sección colapsada visualmente.

### Alternativas descartadas
- **Modal separado para cada feature**: agrega más estado y complejidad modal (ya hay 5+ modales en la página).
- **Página dedicada `/admin/consortiums/[id]/settings`**: overengineering para 2 campos simples.

### Impacto
- Archivos modificados: `page.tsx`, `page.module.css`, `consortiums/[id]/route.ts` (PATCH), nuevos `lsp-services/route.ts` y `lsp-services/[lspId]/route.ts`

---

## 2026-03-27 — Intervalo del scheduler configurable por cliente

### Problema
El intervalo del scheduler era global (`PROCESS_INTERVAL_MINUTES` en `.env`), igual para todos los clientes. Cambiar el intervalo requería modificar el `.env` y hacer rebuild del contenedor, afectando a todos los clientes por igual.

### Decisión
Nuevo campo `intervalMinutes` (Int, default 60) en el modelo Client. El scheduler mantiene un `Map<clientId, lastRunTimestamp>` y antes de procesar cada cliente verifica si pasó su intervalo individual. El `setInterval` global sigue usando el valor del `.env` como tick base (frecuencia mínima de chequeo). Si `client.intervalMinutes` es 0 o no está definido, se usa el fallback global.

### Alternativas descartadas
- **Un scheduler independiente por cliente**: excesiva complejidad, múltiples timers, difícil de monitorear.
- **Cron expressions por cliente**: overengineering para un caso simple de intervalo en minutos.

### Impacto
- Migración: `20260327000200_add_interval_minutes`
- Archivos modificados: `schema.prisma`, `client.types.ts`, `client.repository.ts`, `scheduler.ts`, `jobWorkerMain.ts`, `admin/clients/[id]/route.ts`, `admin/clients/[id]/page.tsx`, `receipt/route.ts`, `invoices/route.ts`, `scan/route.ts`

---

## 2026-03-27 — Boletas sin asignar no se guardan en DB

### Problema
El pipeline guardaba un Invoice en la DB incluso cuando la boleta iba a "Sin Asignar" (sin consorcio o proveedor matcheado). Esto contaminaba la DB con registros incompletos que no tenían consorcio/proveedor asignado y complicaba las métricas y la purga.

### Decisión
Eliminar el paso `saveProcessedInvoice` del bloque `assignment.unassigned`. El archivo se sigue moviendo a la carpeta Sin Asignar en Drive, pero no se crea Invoice en la DB. El hash tampoco se persiste, por lo que si el usuario corrige el directorio y vuelve a procesar el mismo PDF, pasará como nuevo.

### Alternativas descartadas
- Guardar con un status especial (UNASSIGNED): agrega complejidad al schema y a las queries sin beneficio claro.

### Impacto
- Modificado: `src/jobs/processPendingDocuments.job.ts` (bloque unassigned)

---

## 2026-03-27 — Sync-directory: transacción única dividida en 5 por entidad

### Problema
La sincronización de directorio ALTA usaba una sola transacción Prisma para procesar todas las entidades (Rubros, Coeficientes, Consorcios, Proveedores, LspServices). Con muchos registros, la transacción excedía el timeout y fallaba con "Transaction not found".

### Decisión
Dividir en 5 transacciones independientes ejecutadas en secuencia, una por entidad. Cada una con timeout de 30s. La lógica interna de cada bloque es idéntica a la anterior. LspServices va última porque depende de Consorcios y Proveedores ya sincronizados.

### Alternativas descartadas
- Aumentar el timeout a 60s: solo patea el problema, no lo resuelve para datasets grandes.

### Impacto
- Modificado: `src/app/api/client/sync-directory/route.ts`

---

## 2026-03-27 — Aclaración CUIT emisor vs receptor en facturas B/C

### Problema
En facturas tipo B/C, la IA confundía el CUIT del receptor (consorcio) con el del emisor (proveedor) porque el receptor tiene etiqueta 'CUIT:' explícita en el cuerpo, mientras que el emisor tiene el CUIT en el encabezado superior derecho sin etiqueta tan prominente.

### Decisión
Agregar aclaración en `buildInvoicePrompt` advirtiendo sobre esta trampa y orientando a identificar el bloque del emisor (encabezado superior derecho, junto a número de factura, ingresos brutos e inicio de actividades).

### Impacto
- Modificado: `src/lib/extraction.ts` (solo prompt facturas normales)

---

## 2026-03-27 — Constante LSP_LATERAL_CUIT_RULES para CUIT en margen lateral

### Problema
En facturas de Edesur y Edenor el CUIT de la empresa no aparece en el encabezado sino en el margen lateral izquierdo, impreso de forma vertical/rotada. La instrucción genérica `LSP_PROVIDER_TAX_ID_RULES` solo indicaba buscar en el encabezado, lo que hacía que la IA no lo encontrara.

### Decisión
Crear constante compartida `LSP_LATERAL_CUIT_RULES` e incluirla en `buildEdesurPrompt` y `buildEdenorPrompt` después de `LSP_PROVIDER_TAX_ID_RULES`. Reemplaza la aclaración inline que existía solo en Edesur.

### Impacto
- Modificado: `src/lib/extraction.ts` (nueva constante + incluida en 2 prompts)

---

## 2026-03-27 — Proveedor LSP resuelto por CUIT desde tabla Provider

### Problema
Los prompts LSP (Edesur, Edenor, AySA, etc.) tenían CUITs hardcodeados en el código fuente. Esto significaba que agregar un nuevo proveedor LSP requería un cambio de código. Además, el pipeline LSP no resolvía `providerId` — la invoice quedaba sin vínculo al Provider, y el nombre del proveedor venía del router en vez de la DB.

### Decisión
- Eliminar CUITs hardcodeados de todos los prompts LSP. Reemplazar por `LSP_PROVIDER_TAX_ID_RULES` genérico que instruye a la IA a extraer el CUIT del encabezado.
- El pipeline ahora busca el proveedor LSP por CUIT (via `allTaxIds`) contra la tabla Provider. Si lo encuentra, usa el nombre canónico de la DB y setea `providerId`.
- El lookup de LspService intenta primero por `providerId` (FK) y luego por campo texto `provider` (backward compatible).
- Si un LspService matchea y no tiene `providerId`, se actualiza automáticamente (migración progresiva de datos).
- Sync-directory resuelve `providerId` al crear LspServices, buscando por nombre canónico en la tabla Provider.
- Si el proveedor no está en la DB, se usa `LSP_FALLBACK_NAMES` como fallback (nombres hardcodeados del router) y se loguea un warning.

### Alternativas descartadas
- Mantener CUITs hardcodeados y solo agregar `providerId`: no resuelve el problema de mantenibilidad — cada nuevo proveedor LSP seguiría requiriendo cambio de código.
- Eliminar el campo texto `provider` de LspService: prematuro, rompe backward compatibility con datos existentes.

### Impacto
- Migración: `20260327000100_lspservice_add_provider_fk`
- Modificados: `prisma/schema.prisma`, `src/lib/extraction.ts`, `src/jobs/processPendingDocuments.job.ts`, `src/app/api/client/sync-directory/route.ts`, `src/lib/logger.ts`

---

## 2026-03-26 — Normalización de clientNumber para LspService lookup

### Problema
Los números de cliente en la DB se guardan sin ceros a la izquierda (ej: `366037`), pero la IA extrae el clientNumber tal como aparece en el PDF, que frecuentemente incluye ceros (ej: `00366037`). El lookup de `LspService.findFirst({ clientNumber })` fallaba porque comparaba `"00366037"` con `"366037"`.

### Decisión
- Normalizar `extracted.clientNumber` con `.replace(/^0+/, "")` antes de usarlo en el `findFirst` de LspService en el pipeline.
- Aplicar la misma normalización al guardar `clientNumber` durante la sincronización de `_LspServices` desde el archivo ALTA (`sync-directory`), para que la DB siempre tenga el valor sin ceros.
- No modificar prompts ni schema — la normalización se hace en el pipeline y en la ingesta.

### Impacto
- Modificados: `src/jobs/processPendingDocuments.job.ts`, `src/app/api/client/sync-directory/route.ts`

---

## 2026-03-26 — CUIT como identificador primario en matching (allTaxIds)

### Problema
El matching de consorcio y proveedor dependía casi exclusivamente del nombre extraído por la IA, que a veces venía con errores de OCR, variantes de escritura o normalizaciones imprecisas. El campo `providerTaxId` solo contenía un CUIT (el que la IA clasificaba como del proveedor), pero en documentos de servicios públicos frecuentemente confundía el CUIT del consorcio con el del proveedor.

### Decisión
- La IA ahora extrae **todos** los CUITs que encuentra en el documento como lista plana (`allTaxIds`), sin clasificarlos.
- El pipeline busca cada CUIT de `allTaxIds` contra las tablas `Consortium` y `Provider` en la DB, usando la función `normCuit()` (solo dígitos) para comparar.
- Matching de consorcio: CUIT-first (allTaxIds) → exacto (canonicalName) → fuzzy → alias.
- Matching de proveedor: CUIT allTaxIds (excluyendo CUIT del consorcio ya matcheado) → CUIT providerTaxId legacy → nombre exacto → nombre parcial.
- Si ningún CUIT matchea, se cae al flujo existente por nombre sin romper nada.
- Se usa `normCuit()` (ya existente en el pipeline, strip a solo dígitos) para normalizar ambos lados de la comparación.
- Schema Zod cambiado de `.strict()` a `.passthrough()` para robustez ante campos extra de la IA.

### Alternativas descartadas
- Crear función `normalizeTaxId` nueva: no necesaria, `normCuit()` ya existía y hace exactamente lo mismo (strip non-digits).
- Hacer queries por CUIT a la DB (N+1): descartado porque el pipeline ya carga todos los consorcios y proveedores en memoria.

### Impacto
- Modificados: `src/types/extractedDocument.types.ts`, `src/lib/extraction.ts`, `src/jobs/processPendingDocuments.job.ts`, `src/lib/logger.ts`
- Backward-compatible: invoices viejas sin `allTaxIds` siguen funcionando (campo opcional, default null/[])

---

## 2026-03-26 — Conservar razón social en nombre de proveedor (PROVIDER_NAME_RULES)

### Problema
La extracción IA a veces devolvía el nombre del proveedor sin la razón social (ej: "ASCENSORES POTENZA" en lugar de "ASCENSORES POTENZA S.R.L."). Esto generaba inconsistencias entre el nombre extraído y los datos registrados en DB/Sheets, dificultando el matching y la identificación visual del proveedor.

### Decisión
- Nueva constante `PROVIDER_NAME_RULES` en `src/lib/extraction.ts` con la instrucción de conservar S.R.L., S.A., S.A.S., S.C., S.H., COOP., LTDA., etc.
- Se incluyó en los 7 prompts de extracción (facturas normales + 6 LSP) siguiendo el patrón existente de reglas compartidas (`CONSORTIUM_ADDRESS_RULES`, `INVALID_DATE_RULES`, `PAYMENT_METHOD_RULES`).
- No se modificó la lógica de matching ni normalización. El matching existente funciona con el nombre completo incluyendo razón social.

### Impacto
- Modificado: `src/lib/extraction.ts` (nueva constante + inclusión en 7 prompts)

---

## 2026-03-26 — Límite de PDFs por lote configurable (batchSize)

### Problema
El scheduler agarraba todos los PDFs pendientes de un cliente en un solo ciclo. Con clientes que suben muchos PDFs a la vez, esto generaba lotes muy grandes que podían sobrecargar el worker y consumir tokens IA desproporcionadamente.

### Decisión
- Campo `batchSize Int @default(10)` en modelo Client, configurable desde el panel admin.
- El scheduler respeta el límite: si encuentra 50 PDFs pero `batchSize=10`, encola 10 y loguea que el resto se procesará en el próximo ciclo.
- Validación: entero entre 1 y 500 (Zod en API).
- El campo se agrega a `ProcessingClient` para que el scheduler lo lea directamente.

### Impacto
- Migración: `20260326000100_add_batch_size_and_invoice_tokens`
- Modificados: `schema.prisma`, `scheduler.ts`, `client.types.ts`, `client.repository.ts`, `jobWorkerMain.ts`, admin client API y UI

---

## 2026-03-26 — Registro de tokens por factura individual

### Problema
Los tokens se registraban solo a nivel de corrida/scheduler (tabla `TokenUsage`). No había forma de analizar el costo por boleta individual ni identificar qué tipo de documentos consumían más tokens.

### Decisión
- Campos nullable en Invoice: `tokensInput`, `tokensOutput`, `tokensTotal` (Int?), `aiProvider` (String?), `aiModel` (String?).
- El pipeline captura `extractor.getLastUsage()` después de cada extracción exitosa (Gemini o OpenAI) y lo pasa a `saveProcessedInvoice`.
- Los duplicados por hash (que reusan extracción anterior) quedan con tokens null — correcto, no consumieron IA.
- Nueva página `/admin/invoices` accesible solo para ADMIN, con filtro por cliente y paginación server-side.

### Alternativas descartadas
- Tabla separada `InvoiceTokenUsage` (1:1) — overhead innecesario, los campos directamente en Invoice son más simples y eficientes para consultas.

### Impacto
- Misma migración que batchSize
- Modificados: `schema.prisma`, `invoice.repository.ts`, `processPendingDocuments.job.ts`
- Nuevos: `src/app/api/admin/invoices/route.ts`, `src/app/admin/invoices/page.tsx`, `src/app/admin/invoices/page.module.css`
- Modificado: `src/app/admin/page.tsx` (botón Invoices para ADMIN)

---

## 2026-03-24 — Purga completa de boletas por cliente (Admin)

### Problema
No existía forma de revertir el pipeline completo para un cliente. Si se necesitaba reprocesar todas las boletas (por cambios en prompts, configuración incorrecta, etc.), había que limpiar manualmente la DB, Sheets y mover archivos en Drive.

### Decisión
- Endpoint `DELETE /api/admin/clients/[id]/purge` con flujo tolerante a fallos: Drive → Sheets → DB.
- Los archivos de Drive se mueven (no borran) de vuelta a `pending` intentando primero desde `scanned`, luego `unassigned`.
- La carpeta `failed` no se toca.
- Sheets se limpia con `clearAllDataRows()` (borra fila 2+, preserva headers).
- Solo se borran Invoices y ProcessingJobs. NO se tocan Consorcios, Proveedores, Períodos, Rubros, Coeficientes ni LspServices.
- Si Drive o Sheets fallan, se loguea warning y se continúa. El borrado de DB se ejecuta siempre.
- Modal de 3 pasos en la UI (preview → confirmación → resultado) para prevenir purgas accidentales.

### Impacto
- Nuevo archivo: `src/app/api/admin/clients/[id]/purge/route.ts`
- Nuevo método: `GoogleSheetsService.clearAllDataRows()`
- Modificado: `src/app/admin/page.tsx` (botón Purgar + modal)
- Modificado: `src/app/admin/page.module.css` (estilos purge)

---

## 2026-03-24 — Sidebar colapsable + menú hamburguesa en panel cliente

### Problema
El panel cliente (`/admin/consortiums`) tenía todos los controles (scheduler, tema, sync directorio, cerrar sesión) dentro de la misma página como botones sueltos. No había navegación global ni estructura visual clara. En mobile no había menú responsive.

### Decisión
- Sidebar global con: placeholder logo, nombre del cliente (obtenido de `/api/auth/me`), separadores, y botones de navegación.
- En desktop: sidebar colapsable entre modo expandido (iconos + labels) y modo compacto (solo iconos).
- En tablet/mobile (≤1024px): sidebar oculto con menú hamburguesa en la toolbar superior.
- Toolbar superior: controles de scheduler (Pausar/Ejecutar) a la izquierda, toggle de tema a la derecha.
- Toggle dark/light reemplazado por switch tipo interruptor con iconos sol/luna (sin texto). Estado solo de sesión (no persiste en localStorage).
- Botón "Cerrar Periodo General" solo visible para rol CLIENT.
- Botón "Consorcios" deshabilitado con badge "Premium" si `consortiumsEnabled` es false.

### Alternativas descartadas
- **Librería de componentes UI (Radix, Headless UI)**: over-engineering para un sidebar simple. CSS Modules alcanza.
- **lucide-react para iconos**: no estaba instalado y agregar dependencias no era deseado. Se usaron caracteres Unicode (☀️, 🌙, ☰, ◀, ▶).
- **Persistir tema en localStorage**: el usuario pidió explícitamente estado solo de sesión.

### Impacto
- Archivos modificados: `src/app/admin/consortiums/page.tsx`, `src/app/admin/consortiums/page.module.css`
- Sin archivos nuevos ni dependencias nuevas

---

## 2026-03-24 — Cerrar Periodo General con lógica de mes mayoritario

### Problema
No había forma de cerrar todos los períodos activos de un cliente de una sola vez. El cierre individual por consorcio era tedioso para administradores con decenas de consorcios. Además, se necesitaba una lógica inteligente para determinar qué mes cerrar cuando no todos los consorcios están en el mismo período.

### Decisión
- **Lógica de mes mayoritario**: se cuentan las frecuencias de `(year, month)` entre todos los períodos ACTIVE del cliente. Se elige el más frecuente. Esto evita cerrar accidentalmente períodos que están adelantados o atrasados.
- **Dos endpoints separados** (preview + execute):
  - `GET /api/client/periods/close-all/preview`: calcula mes mayoritario, retorna lista de consorcios a cerrar (`toClose`) y a saltear (`toSkip` con razón).
  - `POST /api/client/periods/close-all`: recalcula internamente el mes mayoritario (no confía en el body del cliente), cierra los períodos del mes mayoritario y crea el siguiente como ACTIVE.
- **Modal de 2 pasos** en la UI: primero preview con lista de consorcios (cerrar vs saltear), luego resultado con contadores.
- El POST recalcula el mes mayoritario en vez de recibir `year/month` del frontend, evitando race conditions si otro usuario cierra períodos entre preview y execute.
- La misma lógica de mes mayoritario se reutiliza en: `ConsortiumRepository.resolveMajorityMonth()`, `import/route.ts`, `sync-directory/route.ts`.

### Alternativas descartadas
- **Enviar year/month desde el frontend**: vulnerable a race conditions. Mejor recalcular server-side.
- **Cerrar TODOS los períodos activos sin importar el mes**: peligroso si algunos consorcios tienen meses distintos por error o por estar adelantados.
- **Un solo endpoint POST sin preview**: sin preview el usuario no sabe qué se va a cerrar ni qué se va a saltear.

### Impacto
- Archivos creados: `src/app/api/client/periods/close-all/preview/route.ts`, `src/app/api/client/periods/close-all/route.ts`
- Archivos modificados: `src/repositories/consortium.repository.ts` (nuevo método `resolveMajorityMonth()`), `src/app/api/client/import/route.ts`, `src/app/api/client/sync-directory/route.ts`, `src/app/admin/consortiums/page.tsx`

---

## 2026-03-24 — Período por defecto con mes mayoritario al crear consorcios

### Problema
Al crear consorcios (manual, import Excel, sync-directory), el período inicial se creaba con el mes actual (`new Date()`). Si un cliente ya tenía 30 consorcios en abril 2026 y creaba uno nuevo en mayo 2026, el nuevo quedaba en mayo mientras el resto estaba en abril. Esto generaba inconsistencias al cerrar períodos y en la operación diaria.

### Decisión
- `ConsortiumRepository.resolveMajorityMonth()`: si hay períodos activos existentes, retorna el mes más frecuente. Si no hay ninguno, retorna el mes actual.
- Se aplica en: `createManual()`, import Excel (`import/route.ts`), y sync-directory (`sync-directory/route.ts`).
- En sync-directory la lógica se resuelve inline dentro de la transacción Prisma para no romper el contexto transaccional.

### Alternativas descartadas
- **Siempre usar mes actual**: genera inconsistencias con el resto de consorcios.
- **Pedir al usuario que elija el mes**: agrega fricción innecesaria cuando la respuesta correcta es casi siempre "el mismo mes que los demás".

### Impacto
- Archivos modificados: `src/repositories/consortium.repository.ts`, `src/app/api/client/import/route.ts`, `src/app/api/client/sync-directory/route.ts`

---

## 2026-03-23 — Asignación automática de período activo a invoices

### Problema
Las boletas procesadas no quedaban asociadas a ningún período, lo que impedía filtrar y generar reportes por mes/año. El campo `periodId` ya existía en el schema de Invoice pero no se estaba populando durante el pipeline automático.

### Decisión
- Se busca el período ACTIVE del consorcio matcheado en `resolveAssignment()` (tanto en el path normal como en el LSP fast path).
- Se asigna `periodId` al Invoice al guardarlo en DB.
- Se agrega columna `period` (formato `MM/YYYY`) a Google Sheets en posición M (nueva columna al final).
- Las columnas existentes (A–L incluyendo `clientNumber` en J) no se modificaron.
- Si no hay período activo (caso defensivo), se loguea un warning y `periodId` queda null — el pipeline no falla.

### Alternativas descartadas
- Crear el período automáticamente si no existe: descartado porque eso podría generar períodos con mes/año incorrectos si el consorcio nunca tuvo uno.
- Usar la fecha del documento para inferir el período: complejo y propenso a errores — mejor confiar en el período ACTIVE del consorcio.

### Impacto
- `src/jobs/processPendingDocuments.job.ts` — `resolveAssignment()` ahora devuelve `periodLabel`, `processDriveFile()` lo asigna a `extracted.period`, `DEFAULT_MAPPING` agrega `period: "M"`
- `src/services/googleSheets.service.ts` — `SheetsRowMapping` agrega campo `period` al final (sin remover `clientNumber`)
- `src/lib/clientProcessingConfig.ts` — `requiredKeys` agrega `"period"` al final
- `src/app/api/client/consortiums/[id]/invoices/route.ts` — invoice manual incluye período en Sheets
- `src/types/extractedDocument.types.ts` — campo `period` agregado

---

## 2026-03-23 — Feature consortiumsEnabled (Premium) para control de acceso a consorcios

### Problema
Todos los clientes tenían acceso a la funcionalidad de gestión de consorcios. Se necesitaba un mecanismo para habilitar/deshabilitar esta feature por cliente, permitiendo ofrecer planes diferenciados (free vs premium).

### Decisión
- Nuevo campo `consortiumsEnabled Boolean @default(false)` en el modelo Client.
- El panel admin muestra un toggle "Premium" por cliente con actualización optimista (PATCH a `/api/admin/clients/[id]`).
- El panel cliente condiciona el botón "Consorcios": deshabilitado con badge dorado "Premium" si `consortiumsEnabled` es false.
- La página `/admin/consortiums` verifica acceso via `/api/auth/me` al montar y redirige a `/admin` si no está habilitado.
- Se removió la columna ClientId de la tabla de métricas (innecesaria para el admin) y se reemplazó por la columna Premium.

### Alternativas descartadas
- **Middleware de Next.js para bloquear `/admin/consortiums`**: requiere acceso a DB desde Edge Runtime, más complejo y no compatible con el patrón actual de autenticación.
- **Campo `plan` con enum**: over-engineering para una sola feature gate. Si en el futuro se necesitan más features, se puede migrar a un sistema de plans.

### Impacto
- Migración: `20260323000300_add_consortiums_enabled`
- Archivos modificados: `schema.prisma`, `admin/page.tsx`, `admin/page.module.css`, `admin/consortiums/page.tsx`, `api/admin/clients/[id]/route.ts`, `api/admin/audit/clients/route.ts`, `api/auth/me/route.ts`

---

## 2026-03-23 — Modelo LspService para lookup automático de servicios públicos

### Problema
El pipeline extraía datos de facturas LSP (Edesur, AySA, etc.) pero no tenía forma de vincular la factura a un servicio específico dentro de un consorcio. Un consorcio puede tener múltiples servicios del mismo proveedor (ej: dos medidores Edesur con distintos números de cliente). Sin esta relación, no se podía identificar a qué servicio corresponde cada factura.

### Decisión
- Nueva tabla `LspService` con campos: clientId, consortiumId, provider (normalizado), clientNumber, description.
- Unique constraint: `(consortiumId, provider, clientNumber)` — un consorcio no puede tener el mismo nro de cliente duplicado para el mismo proveedor.
- El pipeline busca en `LspService` después de extraer `clientNumber` con IA, usando `clientId + provider + clientNumber`.
- Si encuentra match → setea `lspServiceId` en Invoice. Si no → loguea warning y continúa.
- Nueva columna NRO CLIENTE en Sheets (columna J) para registrar el número de cliente extraído.
- Nuevo enum `PaymentMethod` (DEBITO_AUTOMATICO, TRANSFERENCIA, EFECTIVO) como campo nullable en Invoice.
- Todos los prompts LSP actualizados para extraer `clientNumber` y `paymentMethod`.
- Extracción limitada a página 1 para documentos LSP (reduce ruido en la extracción IA).
- Nueva hoja `_LspServices` en archivo ALTA para cargar los servicios desde Sheets.

### Alternativas descartadas
- **Lookup por dirección del consorcio**: impreciso porque las LSPs formatean direcciones de maneras distintas.
- **Campo clientNumber suelto en Invoice sin tabla**: no permite validar ni vincular a un consorcio específico.
- **Crear LspService automáticamente desde el pipeline**: podría generar duplicados y datos incorrectos sin supervisión humana.

### Impacto
- Migración: `20260323000200_add_lspservice_paymentmethod`
- Archivos modificados: `schema.prisma`, `extraction.ts`, `processPendingDocuments.job.ts`, `googleSheets.service.ts`, `sync-directory/route.ts`, `clientProcessingConfig.ts`, `pdfTextExtractor.service.ts`, `invoice.repository.ts`, `extractedDocument.types.ts`, `invoices/route.ts`
- Columnas de Sheets desplazadas: sourceFileUrl J→K, isDuplicate K→L
- Nuevo prompt: `buildPersonalPrompt` con keywords PERSONAL/TELECOM

---

## 2026-03-23 — Separar matchNames (interno) de paymentAlias (visible)

### Problema
El campo `alias` en Provider y `aliases` en Consortium cumplía dos funciones distintas:
1. **Matching interno**: nombres alternativos para que el pipeline identifique la entidad en PDFs (ej: "BROWN ALMTE AV 708" para matchear con "ALMIRANTE BROWN 706").
2. **Alias de pago**: nombre corto visible en la UI y en la columna "ALIAS" de Google Sheets.

Mezclar ambos usos genera confusión: si un admin carga un alias de pago como "TIGRE", el pipeline lo usa para matching de nombre, lo cual puede generar falsos positivos. Y si se cargan nombres técnicos de matching (como direcciones alternativas), aparecen en la UI sin sentido para el usuario.

### Decisión
- Renombrar `Provider.alias` → `Provider.matchNames` y `Consortium.aliases` → `Consortium.matchNames`.
- Agregar `paymentAlias` (String?, opcional) en ambos modelos.
- `matchNames`: campo interno, separado por `|`, usado exclusivamente por el pipeline de matching. No se muestra en la UI.
- `paymentAlias`: campo visible en la UI (label "Alias") y escrito en la columna "ALIAS" de Google Sheets. Si no tiene valor, la celda queda vacía.
- En el pipeline, `extracted.alias` (columna I de Sheets) ahora se setea con `provider.paymentAlias` en vez de `provider.canonicalName`.
- Migración por rename de columna (preserva datos existentes).

### Alternativas descartadas
- **Dos campos en la UI**: mostrar ambos campos al usuario. Descartado porque `matchNames` es un concepto técnico que el usuario no necesita ver ni gestionar directamente (se carga via Sheets ALTA o import Excel).
- **Campo único con separador especial**: usar un prefijo o formato especial para distinguir matching de pago dentro del mismo campo. Frágil y propenso a errores.

### Impacto
- Migración: `20260323000100_rename_alias_to_matchnames_add_paymentalias`
- Archivos modificados: `schema.prisma`, `processPendingDocuments.job.ts`, `googleSheets.service.ts`, `sync-directory/route.ts`, `import/route.ts`, `import/template/route.ts`, `providers/route.ts`, `consortiums/page.tsx`
- Sync ALTA: hojas `_Consorcios` y `_Proveedores` ampliadas de 3 a 4 columnas
- Import Excel: nueva columna "Alias de pago" en ambas hojas
- Compatible con datos existentes: rename preserva valores, `paymentAlias` empieza como NULL

---

## 2026-03-23 — Optimización docker-compose: imagen compartida entre servicios

### Problema
Los 3 servicios (web, scheduler, worker) en `docker-compose.yml` tenían cada uno su propio bloque `build:`, lo que causaba que `docker compose up --build` construyera la misma imagen 3 veces. Esto triplicaba el tiempo de build sin ningún beneficio — los 3 servicios usan exactamente el mismo Dockerfile y la misma imagen final.

### Decisión
- Agregar `image: drive-doc-processor:latest` al servicio `web` (que mantiene el `build:`).
- Reemplazar los bloques `build:` de `scheduler` y `worker` por `image: drive-doc-processor:latest`.
- Resultado: `docker compose up --build` construye **una sola vez** y los 3 servicios reusan la misma imagen.

### Alternativas descartadas
- **docker compose build + referencia cruzada con `depends_on`**: Docker Compose no cachea automáticamente entre servicios con `build:` independiente — sigue intentando buildear cada uno.
- **Script wrapper que hace `docker build` primero y luego `compose up`**: agrega complejidad innecesaria cuando el tag de imagen resuelve el problema nativamente.

### Impacto
- Archivo modificado: `docker-compose.yml`
- Tiempo de build reducido ~66% (1 build en vez de 3)

---

## 2026-03-23 — Auditoría de .env.example para producción Docker

### Problema
El `.env.example` tenía 15 variables sin comentarios ni agrupación. Faltaba `GOOGLE_CREDENTIALS_ENCRYPTION_KEY` (usada en `encryption.util.ts` con fallback a `SESSION_SECRET`). Al preparar Docker para producción, un operador no sabría qué variables son requeridas vs opcionales ni qué hace cada una.

### Decisión
Reescribir `.env.example` con:
- Variables agrupadas por categoría (DB, Auth, Google Cloud, Drive, Sheets, Scheduler, IA)
- Comentarios descriptivos en cada variable
- `GOOGLE_CREDENTIALS_ENCRYPTION_KEY` agregada como opcional

### Impacto
- Archivo modificado: `.env.example`

---

## 2026-03-21 — Dockerización con 3 servicios separados y CI/CD

### Problema
El docker-compose original tenía 2 servicios: web (con scheduler como proceso background vía `&`) y worker. El scheduler no se reiniciaba si crasheaba. El worker apuntaba a un archivo incorrecto (`jobWorker.js` vs `jobWorkerMain.js`). Los path aliases `@/` no se resolvían en los archivos compilados de `dist/`, haciendo que el worker no pudiera arrancar en Docker.

### Decisión
- **3 servicios separados** (web, scheduler, worker) para que Docker reinicie cada uno independientemente.
- **`tsc-alias`** como post-procesador de `tsc` para reemplazar `@/` por paths relativos en `dist/`. Más simple que configurar `tsconfig-paths/register` o cambiar la estrategia de módulos.
- **`output: "standalone"`** en Next.js para generar una imagen más liviana (solo `server.js` + deps mínimas embebidas).
- **Production deps copiadas aparte** (`npm ci --omit=dev`) porque los jobs necesitan `googleapis`, `dotenv`, etc. que standalone no incluye.
- **Cloudflare Tunnel** como 4to servicio en el compose, configurado con `CLOUDFLARE_TUNNEL_TOKEN` en el `.env`.
- **ESLint** con `typescript-eslint` + `@next/eslint-plugin-next` como gate de CI.
- **GitHub Actions** con 3 jobs: check (lint+types), build (Docker), deploy (self-hosted runner).

### Alternativas descartadas
- Copiar solo paquetes específicos al runtime (google, openai, etc.): frágil por dependencias transitivas faltantes.
- Usar `tsx` en producción para los jobs: agrega overhead innecesario y dependencia de dev.
- Coolify/Dokku: más infraestructura de la necesaria para un deploy local con tunneling.

### Impacto
- Archivos creados: `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`, `eslint.config.mjs`, `src/lib/clientAuth.ts`, `src/types/canvas-shim.d.ts`
- Archivos modificados: `package.json` (scripts build:jobs, lint, check), `next.config.ts` (standalone), `tsconfig.jobs.json` (excludes)
- Fixes: encoding UTF-8 en close-period/route.ts, async params en receipt/route.ts, type cast en scan/route.ts

---

## 2026-03-21 — Sistema de logging centralizado para scheduler y worker

### Problema
Los logs del scheduler, worker y pipeline eran planos (`console.log` con strings concatenados), sin timestamps, sin separación visual entre ciclos, y silenciosos cuando no había trabajo. Cuando ocurría un error, era difícil correlacionar entre las 3 terminales y entender qué pasó en qué momento.

### Decisión
Crear `src/lib/logger.ts` como módulo centralizado con:
- **Timestamps ISO** en cada línea para correlacionar entre terminales
- **Tags de proceso** (`[SCHEDULER]`, `[WORKER]`, `[JOB]`, `[RUN-CYCLE]`) para filtrar
- **Emojis** como indicadores visuales instantáneos (✅ éxito, ❌ error, ⚠️ warning, 📄 archivo, 📊 resumen)
- **Separadores visuales** (`divider`, `miniDivider`) para marcar inicio/fin de ciclos y lotes
- **Logs específicos por contexto**: `schedulerLog`, `workerLog`, `pipelineLog`, `cycleLog`
- **Datos estructurados**: cada paso del pipeline muestra el dato extraído (consorcio, proveedor, CUIT, monto, vto)
- **Método de matching visible**: cuando se encuentra un consorcio/proveedor, se muestra si fue exacto, fuzzy o alias
- **Detección LSP visible**: se loguea qué tipo de LSP se detectó (EDESUR, AYSA, etc.)

### Alternativas descartadas
- **Winston/Pino**: librerías de logging profesionales. Descartado porque agregan dependencia, y el output estructurado en JSON no es legible en PowerShell sin herramientas extra. Los logs van a terminales locales, no a un servicio de monitoreo.
- **Log levels con env var**: configurar niveles (DEBUG/INFO/WARN). Descartado por ahora — se puede agregar después si el volumen de logs molesta.

### Impacto
- Archivo nuevo: `src/lib/logger.ts`
- Archivos modificados: `scheduler.ts`, `jobWorkerMain.ts`, `processPendingDocuments.job.ts`, `runProcessingCycle.ts`
- Sin cambios en interfaces exportadas (backward compatible)

---

## 2026-03-21 — Prompts LSP por empresa con CUIT hardcodeado

### Problema
La extracción IA de facturas de servicios públicos (LSP) tenía 3 errores recurrentes:
1. **CUIT confundido**: en LSPs el CUIT del consorcio (cliente/receptor) aparece prominente en el documento, y la IA lo tomaba como providerTaxId. En AySA el CUIT del cliente aparece al final con "IVA RESPONSABLE INSCRIPTO - CUIT No. XX-XXXXXXXX-X".
2. **Fecha CESP/CAE como dueDate**: en facturas de AySA aparece "C.E.S.P: XXXXX | Fecha Vto: DD/MM" donde "Fecha Vto" es del código electrónico de servicio público, no de pago. La IA lo tomaba como fecha de vencimiento de pago.
3. **Consorcio no matchea**: las LSPs formatean direcciones con ceros a la izquierda (00706), sufijos numéricos extras (706 018), código postal (C1414AWF) y localidad (CAPITAL FEDERAL). El normalizer no los limpiaba.

### Decisión
Refactorizar `extraction.ts` con un router `identifyLSPProvider()` que detecta la empresa y despacha a un prompt específico:
- `buildEdesurPrompt()` — CUIT 30-71079642-7 hardcodeado, regla de primer vencimiento
- `buildAysaPrompt()` — CUIT 30-70956507-5, advertencia explícita de trampa CESP y CUIT del cliente al final
- `buildEdenorPrompt()` — CUIT 30-65651651-4
- `buildGasPrompt()` — Metrogas, Naturgy, Camuzzi, Litoral Gas con CUITs respectivos
- `buildGenericUtilityBillPrompt()` — fallback para LSPs no identificadas

En `consortiumNormalizer.ts` se agregaron 4 funciones de limpieza: `stripLeadingZeros`, `stripTrailingNumericSuffix`, `stripPostalAndLocality`, `stripFloorUnit`.

### Alternativas descartadas
- **Prompt único mega-detallado**: no funcionaba porque las instrucciones genéricas no eran lo suficientemente específicas para cada formato de empresa.
- **Post-procesamiento del CUIT**: validar contra lista conocida después de la extracción. No resuelve el problema de raíz.

### Impacto
- Archivos modificados: `src/lib/extraction.ts`, `src/lib/consortiumNormalizer.ts`
- Interfaces exportadas: sin cambios (backward compatible)

---

## 2026-03-21 — Regla obligatoria de documentación en docs/

### Problema
El progreso y las decisiones no se documentaban consistentemente. Al retomar contexto se perdía tiempo redescubriendo qué se hizo y por qué.

### Decisión
Regla obligatoria: todo cambio significativo actualiza `docs/progreso.md`, `docs/decisiones.md` y `CHANGELOG.md`. Documentado en CLAUDE.md como sección prioritaria.

### Impacto
- Aplica a todas las sesiones futuras de desarrollo

---

## 2026-03-20 — Private key encriptada pasada directamente a GoogleSheetsService

### Problema
Al implementar la sincronización del archivo ALTA, se pasaba `client.googleConfigJson.privateKey` directamente. Estaba encriptada → error `error:1E08010C:DECODER routines::unsupported`.

### Decisión
Usar siempre `resolveGoogleConfig(client)` que desencripta antes de construir servicios Google.

### Impacto
- Archivo modificado: `src/app/api/client/sync-directory/route.ts`
- Regla: nunca acceder a `client.googleConfigJson.privateKey` directamente
