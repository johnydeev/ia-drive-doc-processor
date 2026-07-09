# Spec — Gastos fijos mensuales por consorcio + obligaciones de pago

- **Fecha:** 2026-07-05
- **Estado:** Draft (aprobación pendiente del owner)
- **Feature:** obligaciones de pago recurrentes por consorcio, materializadas por período.

---

## 1. Contexto y motivación

Cada consorcio tiene **gastos fijos** que se pagan todos los meses sí o sí: la luz (EDESUR), el
sueldo del encargado (empleado), telefonía, etc. Hoy el sistema solo registra la boleta **cuando
llega**; no hay forma de saber, al inicio del período, **qué se espera pagar** ni de detectar que
**faltó** una boleta que debería haber llegado.

El administrador maneja muchos consorcios y no tiene contexto de qué falta en cada uno. Esta feature
hace que, al inicio de cada período, aparezca una lista de **obligaciones pendientes** (una por gasto
fijo), a la espera de la boleta. Cuando la boleta llega, la obligación se marca **Recibida** y se
vincula a la boleta. Al cerrar el período, las que no llegaron se reportan como **No recibida**.

## 2. Alcance

### Incluido
- Definir gastos fijos por consorcio, vinculados a un `Provider` o un `LspService` ya cargado.
- Materializar obligaciones por período (generación automática al abrir el período + botón de arranque
  para períodos ya abiertos).
- Vincular automáticamente la boleta entrante a su obligación en el pipeline.
- Vista de obligaciones del período en el panel + aviso de faltantes al cerrar el período.

### Fuera de alcance (otras features)
- Escribir placeholders de obligaciones pendientes en Google Sheets (decidido: viven solo en panel/DB).
- Monto esperado / estimado por gasto fijo (decidido: la obligación solo espera la boleta; el monto lo
  trae la boleta).
- El aviso de **cuotas** ("qué cuota va este mes vs. la del mes anterior") — es una feature aparte, del
  lado de pagos.

## 3. Modelo de datos

Se separan **definición recurrente** (el gasto fijo) e **instancia por período** (la obligación).

### 3.1 `FixedExpense` (definición, por consorcio)

| Campo | Tipo | Notas |
|---|---|---|
| `id` | String cuid | PK |
| `clientId` | String | FK Client (cascade) |
| `consortiumId` | String | FK Consortium (cascade) |
| `providerId` | String? | FK Provider (cascade). Objetivo si el gasto es por proveedor (ej. encargado) |
| `lspServiceId` | String? | FK LspService (cascade). Objetivo si es una cuenta de servicio (ej. EDESUR + N° cliente) |
| `description` | String? | Opcional; si es null se muestra el nombre del proveedor/servicio |
| `active` | Boolean | Default `true`. Desactivar sin borrar |
| `createdAt` / `updatedAt` | DateTime | |

- **Regla:** exactamente **uno** de `providerId` / `lspServiceId` debe estar seteado (se valida en la
  capa de aplicación; ambos son nullable en el schema).
- **Único:** `(consortiumId, providerId, lspServiceId)` para no duplicar el mismo gasto fijo.
- Un gasto fijo apuntando a un `LspService` es específico de esa cuenta → dos cuentas de EDESUR en el
  mismo consorcio son **dos** `FixedExpense` distintos.

### 3.2 `ExpenseObligation` (instancia, por período)

| Campo | Tipo | Notas |
|---|---|---|
| `id` | String cuid | PK |
| `clientId` | String | FK Client (cascade) |
| `consortiumId` | String | FK Consortium (cascade) |
| `periodId` | String | FK Period (cascade) |
| `fixedExpenseId` | String | FK FixedExpense (cascade) |
| `status` | `ObligationStatus` | Default `PENDING` |
| `invoiceId` | String? | FK Invoice (SetNull), **`@unique`**. Se llena al recibir la boleta (1:1) |
| `createdAt` / `updatedAt` | DateTime | |

- **Único:** `(periodId, fixedExpenseId)` → una obligación por gasto fijo por período.
- **Único:** `invoiceId` → una boleta cumple a lo sumo una obligación (relación 1:1 con `Invoice`).
- **Enum** `ObligationStatus { PENDING, RECEIVED, SKIPPED, NOT_RECEIVED }`.

### 3.3 Enum y etiquetas de UI

| Valor | Etiqueta UI | Significado |
|---|---|---|
| `PENDING` | Pendiente | Generada, esperando la boleta |
| `RECEIVED` | Recibida | Llegó la boleta y se vinculó (`invoiceId` seteado) |
| `NOT_RECEIVED` | No recibida | Al cerrar el período no había llegado |
| `SKIPPED` | Omitida | El admin la marcó como "no aplica este mes" |

> **Importante:** el `status` refleja **solo si llegó la boleta**, no el pago. El estado de pago se lee
> de la `Invoice` vinculada (`isPaid` / `remainingBalance`) y se muestra aparte. Una obligación puede
> estar **Recibida** e **impaga** a la vez.

### 3.4 Relaciones a agregar
- `Client`: `fixedExpenses FixedExpense[]`, `obligations ExpenseObligation[]`.
- `Consortium`: `fixedExpenses FixedExpense[]`, `obligations ExpenseObligation[]`.
- `Period`: `obligations ExpenseObligation[]`.
- `Provider`: `fixedExpenses FixedExpense[]` (onDelete Cascade — si se borra el proveedor, el gasto fijo
  pierde su objetivo).
- `LspService`: `fixedExpenses FixedExpense[]` (onDelete Cascade).
- `Invoice`: `obligation ExpenseObligation?` (1:1 opcional; onDelete SetNull sobre `invoiceId`).

## 4. Ciclo de vida

### 4.1 Generación de obligaciones
`generateObligationsForPeriod(periodId)`:
1. Carga los `FixedExpense` **activos** del consorcio del período.
2. Por cada uno, hace `upsert` de la `ExpenseObligation` `(periodId, fixedExpenseId)` en `PENDING` si no
   existe (idempotente).
3. **Vinculación retroactiva:** por cada obligación recién generada, si ya hay una `Invoice` en ese
   período que matchea (ver 4.2), la marca `RECEIVED` + `invoiceId`.

Se dispara:
- Al **crear un período** (`ConsortiumRepository.createManual` y cualquier alta de período).
- Al **"Cerrar período general"** (`/api/client/periods/close-all`), para cada período nuevo creado.
- Manual, con un botón **"Generar obligaciones"** por consorcio/período (endpoint dedicado), para los
  períodos ya abiertos antes de esta feature.

### 4.2 Cumplimiento (boleta → obligación) en el pipeline
Al persistir una `Invoice` (consorcio C, período P, con `providerId` y opcional `lspServiceId`):
- Buscar una `ExpenseObligation` en P con `status = PENDING` cuyo `FixedExpense` matchee:
  - si el gasto fijo es LSP → `fixedExpense.lspServiceId === invoice.lspServiceId`;
  - si el gasto fijo es por proveedor → `fixedExpense.providerId === invoice.providerId`.
- Si matchea: `status = RECEIVED`, `invoiceId = invoice.id`.
- Si hay varias candidatas (no debería, por el único), se toma la primera de forma determinística.
- Es un update de **DB solamente** (no toca Sheets). Se implementa como paso del pipeline
  (`linkFixedExpenseObligationStep`) o hook tras la persistencia, después de asignar consorcio+período.

**Nota — borrado/reproceso de boleta:** cuando una boleta se borra o se manda a reprocesar
(`lib/invoiceDeletion`), la FK `invoiceId` queda en null (SetNull). En ese caso la obligación debe
**volver a `PENDING`**. Se maneja explícitamente en el flujo de borrado (no solo por la FK).

### 4.3 Cierre de período
En `/api/client/periods/close-all` (y su preview):
- **Preview:** además de lo actual, listar por consorcio las obligaciones `PENDING` (las que faltarían
  si se cierra ahora).
- **Execute:** al cerrar cada período, las obligaciones `PENDING` pasan a `NOT_RECEIVED`. Se incluye en
  el resumen del cierre un contador + detalle ("Faltaron N boletas de gastos fijos: CALLAO 1441 →
  EDESUR, …").
- No se arrastran: el período nuevo genera sus propias obligaciones frescas (4.1).

## 5. UI

### 5.1 Gestión de gastos fijos (por consorcio)
Sección colapsable en el detalle del consorcio, al estilo de **"Servicios públicos (LSP)"**:
- Lista de gastos fijos del consorcio con su objetivo (proveedor o servicio) y toggle **activo**.
- Agregar: elegir el objetivo entre los `Provider` del cliente (opcionalmente filtrados a los asociados
  al consorcio vía `ConsortiumProvider`) o los `LspService` del consorcio; `description` opcional.
  *(Nota: `Provider` es a nivel cliente; `LspService` es por consorcio.)*
- Quitar (borra el `FixedExpense`; las obligaciones históricas quedan por la relación, ver cascada).

### 5.2 Obligaciones del período
**Pestaña propia "Obligaciones"**, junto a *Boletas* y *Pagos*, en la vista del período:
- El título de la pestaña lleva un **badge con el contador de faltantes** (obligaciones `PENDING`), para
  que el admin vea de una que algo falta sin entrar.
- Una fila por obligación: objetivo (proveedor/servicio), **estado** (badge: Pendiente ámbar / Recibida
  verde / No recibida rojo / Omitida gris), y —si Recibida— link a la boleta + su estado de pago.
- Encabezado con el resumen: "Faltan N boletas de gastos fijos".
- Acción por fila: **Omitir** (marca `SKIPPED`) / reactivar.
- Botón **"Generar obligaciones"** visible si el período no tiene obligaciones generadas (arranque).

## 6. Endpoints / API
- `GET/POST /api/client/consortiums/[id]/fixed-expenses` — listar / crear gasto fijo.
- `PATCH/DELETE /api/client/consortiums/[id]/fixed-expenses/[fxId]` — editar (active/description) /
  borrar.
- `POST /api/client/periods/[id]/obligations/generate` — generar obligaciones del período (arranque).
- `GET /api/client/periods/[id]/obligations` — listar obligaciones del período (o incluirlas en el
  fetch de la vista del período).
- `PATCH /api/client/obligations/[id]` — cambiar estado (ej. `SKIPPED`).

Todos con `requireClientSession`.

## 7. Migración
- Nuevo enum `ObligationStatus` + tablas `FixedExpense` y `ExpenseObligation` + FKs.
- Migración `prisma/migrations/20260705000200_add_fixed_expenses/migration.sql` (la crea Claude, la
  aplica el owner con `migrate deploy` → `generate`). Sin backfill de datos (arranca vacío; el owner
  carga los gastos fijos por UI y usa "Generar obligaciones" en los períodos abiertos).

## 8. Testing
- Funciones puras testeables (Vitest):
  - Generación: idempotencia + vinculación retroactiva.
  - Matcher de cumplimiento: LSP por `lspServiceId`, proveedor por `providerId`, sin match.
  - Transición de cierre (`PENDING` → `NOT_RECEIVED`) + armado del resumen de faltantes.
- Verificación completa: `typecheck` + `lint` + `test` + `build:jobs`.

## 9. Decisiones tomadas (brainstorming 2026-07-05)
1. Gasto fijo **vinculado a un Provider/LspService** ya cargado (no texto libre ni auto-detección).
2. Obligaciones **materializadas por período** (registros, no cálculo al vuelo).
3. **Sin monto esperado**: la obligación solo espera la boleta.
4. Definición de gastos fijos por **UI del panel** (por consorcio).
5. Obligaciones pendientes **solo en panel/DB** (no se escriben en Sheets).
6. Generación **automática al abrir el período** + botón de arranque para los ya abiertos.
7. Sin boleta al cierre → **No recibida** + aviso en el cierre; no se arrastra.
