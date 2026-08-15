# Spec — Vista global de obligaciones + hoja imprimible por edificio

**Fecha:** 2026-08-12
**Tipo:** Feature nueva (UI + endpoints + migración).
**Estado de partida (verificado):** rama `master` en `379d6f6`; sin commitear hay cambios de docs
(evaluación Go) y el spec/plan de `2026-08-06-barra-progreso-batch-boletas` **sin implementar**.
**456 tests** verdes. Este trabajo no toca `admin/boletas/`, así que no colisiona con ese plan.
**Requiere migración** (dos índices únicos). **No toca el pipeline ni Google Sheets.**

---

## 1. Problema

El administrador arranca cada mes pagando desde el home banking un conjunto de gastos que se repiten
en todos los edificios: luz, agua, gas, seguro, honorarios, limpieza, ascensor, fumigación,
internet. Los paga **antes** de que llegue ninguna boleta.

Hoy lleva esa lista en una planilla Excel armada a mano, una hoja por consorcio (ver la muestra de
FRANKLIN 25 en el brainstorming). Quiere el mismo papel, pero salido del sistema y actualizado.

El sistema ya modela el dominio — `FixedExpense` (la definición permanente) y `ExpenseObligation`
(su instancia mensual) — pero:

1. **No hay forma de imprimirlo.** La pestaña Obligaciones vive dentro de cada consorcio y es una
   vista de pantalla.
2. **Administrarlo cuesta 47 pantallas.** Agregar, quitar u omitir un gasto fijo se hace edificio por
   edificio, entrando al consorcio y abriendo el modal de Configuración.
3. **La lista puede estar incompleta sin que se note.** Las obligaciones de un período se generan al
   crearlo; si alguien agrega un gasto fijo a mitad de mes, el período abierto no se entera hasta que
   alguien aprieta el botón "Generar obligaciones" en ese edificio.

El punto 3 es el más peligroso para esta feature: un papel incompleto es peor que no tener papel.

## 2. Alcance

**El trabajo se entrega en dos partes** (decisión del owner, 2026-08-12). Cada una se verifica,
commitea y deploya por separado:

- **Parte 1 — vista y administración.** Migración, sincronización set-based, endpoints, la pantalla
  con las tarjetas-hoja, alta múltiple, omitir/reactivar, desactivar, eliminar, y el recorte de
  `ConfigModal`. Sirve sola: administrar el mes entero deja de costar 47 pantallas.
  Plan: `docs/superpowers/plans/2026-08-12-vista-global-obligaciones-parte1.md`.
- **Parte 2 — PDF e impresión.** `toPrintableSheets`, el generador con jsPDF y la hoja de estilos
  `@media print`, sobre el `SheetData[]` que la Parte 1 deja construido y testeado. Plan propio.

**Dentro:**

- Vista nueva `/admin/obligaciones`: todos los edificios agrupados por banco, con la tabla de cada
  uno con la forma exacta de la hoja impresa.
- Sincronización automática de obligaciones al abrir la vista (set-based).
- Alta múltiple de gastos fijos por edificio (modal con checkboxes, filtrando lo ya cargado),
  desactivar, eliminar, y omitir/reactivar la obligación del mes.
- Descarga de PDF (una hoja por edificio) e impresión directa.
- Renombrar el botón "Generar obligaciones" → **"Sincronizar gastos fijos"**.
- Reducir la sección "Gastos fijos" del modal de Configuración a un atajo de solo lectura.

**Fuera (decidido explícitamente):**

- **Montos esperados / presupuestados.** `FixedExpense` no tiene importe y no se le agrega. El monto
  sale de la boleta cuando llega, y si no llegó la celda va vacía para escribir a mano.
- **Contacto del proveedor.** Las columnas TÉCNICO O GESTOR y TEL. CONTACTO se imprimen **vacías**.
  Agregar `contactName`/`contactPhone` a `Provider` queda anotado para más adelante (§10).
- **Boletas que no son gasto fijo.** El papel es la lista fija de servicios, nada más.
- **Alta de gastos fijos en varios edificios a la vez** (matriz servicios × edificios). §10.
- **Obligaciones de una sola vez** (sin gasto fijo detrás). §10.
- **Guardar el PDF** en Drive o mandarlo por mail. Se genera, se descarga y se olvida.

## 3. Hallazgos verificados

Relevados sobre el código antes de diseñar.

### 3.1 El monto llega con la boleta; el contacto no existe

**El monto sí está en el sistema**, pero no es un campo del gasto fijo: sale de la boleta. Cuando la
factura entra por el pipeline y matchea, la obligación pasa a `RECEIVED` con su `invoiceId`, y de ahí
se lee `Invoice.amount`. Lo que no existe es un importe **propio** del gasto fijo — un esperado o
presupuestado cargado a mano antes de que llegue la factura: `FixedExpense` es
`{ clientId, consortiumId, providerId?, lspServiceId?, description?, active }` y `ExpenseObligation`
es `{ status, invoiceId? }`. Por eso la celda MONTO va vacía hasta que la boleta llega, y por eso no
hay forma de mostrar "cuánto se espera pagar" en un edificio donde todavía no entró nada.

**El contacto, en cambio, no existe en ningún lado.** `Provider` tiene `canonicalName`, `cuit`,
`matchNames`, `paymentAlias` y `providerType` — ningún nombre de técnico ni teléfono.

Mapeo de las seis columnas del papel contra la DB:

| Columna | Fuente | Estado |
|---|---|---|
| Título de la hoja | `Consortium.canonicalName` | Existe |
| FACTURAS | `LspService.clientNumber` | Existe, solo para gastos LSP |
| PROVEEDORES Y SERVICIOS | `Provider.canonicalName` / `LspService.providerName` | Existe |
| MONTO | `Invoice.amount` vía la obligación `RECEIVED` | Existe cuando llegó la boleta |
| ALIAS CBU | `Provider.paymentAlias` | Existe donde esté cargado |
| TÉCNICO O GESTOR | — | **No existe → se imprime vacía** |
| TEL. CONTACTO | — | **No existe → se imprime vacía** |

### 3.2 Una obligación con boleta siempre tiene monto

El pipeline no persiste boletas sin importe: las etiqueta `SIN MONTO` y las manda a Revisión. Por lo
tanto *obligación `RECEIVED` ⟺ hay monto*. Esto es lo que hace **redundante** cualquier tilde de
"llegó" al lado del importe: el número impreso ya es la señal.

### 3.3 `generateObligationsForPeriod` no sirve para 47 edificios

`obligation.service.ts:14` recibe **un** período y hace un `create` por gasto fijo dentro de un
`for`, más un `findMany` de boletas. Llamarlo 47 veces al abrir la vista son cientos de queries
secuenciales: el patrón exacto que produjo el 524 del túnel en `close-all` (ver `docs/decisiones.md`
2026-07-12). La sincronización de esta vista **debe ser set-based**, como `executeCloseAll`.

### 3.4 El duplicado de gasto fijo ya está cubierto a nivel app

`FixedExpenseRepository.create` (`fixedExpense.repository.ts:44`) busca un gasto fijo con el mismo
`(consortiumId, providerId, lspServiceId)` y responde **409** si existe. Es además el **único**
camino que crea gastos fijos: ni el archivo ALTA ni el import Excel los tocan. El índice único de
§6.1 no tapa un agujero abierto — mueve la garantía a la base y cierra la carrera de dos requests
concurrentes.

### 3.5 Borrar un gasto fijo borra historia

`ExpenseObligation.fixedExpense` es `onDelete: Cascade`. Eliminar un `FixedExpense` borra **todas**
sus obligaciones, de todos los períodos, incluidos los cerrados con boleta vinculada. Por eso la UI
mantiene dos acciones distintas: **desactivar** (deja de generarse, la historia queda) y **eliminar**
(con confirmación que dice cuántas obligaciones se van).

### 3.6 Omitir ya existe y tiene un guard

`PATCH /api/client/obligations/[id]` acepta `{ status: "PENDING" | "SKIPPED" }` y responde **409** si
la obligación ya está `RECEIVED` ("no pisar un vínculo real"). La vista nueva reusa ese endpoint tal
cual.

### 3.7 Piezas reutilizables

- `lib/groupByBank.ts` y `lib/bankPalette.ts` (de `consortiums/`) ya resuelven el agrupamiento por
  banco y los colores. Se **mueven** a un lugar compartido o se importan; no se duplican.
- `ConsortiumRepository.resolveMajorityMonth(clientId)` (`consortium.repository.ts:205`) da el mes
  mayoritario entre los períodos activos.
- `obligationMatchesInvoice` (`lib/fixedExpense.ts`) es la regla de match, pura y testeada.
- El patrón `lib/` (puro) + `hooks/` (tier 1) + `components/` (tier 2) está validado 15 veces en
  `consortiums/`. La vista nueva lo sigue.

## 4. Decisiones

| Decisión | Elegido | Razón |
|---|---|---|
| Contenido de la fila | Checklist; MONTO solo si llegó la boleta | El sistema no conoce el importe antes de la factura (§3.1) |
| Marca de "llegó" | **No** | Redundante con el monto impreso (§3.2) |
| Columnas de contacto | Se imprimen vacías | No hay dato en el modelo; agregarlo es otra feature (§10) |
| Boletas que no son gasto fijo | No se incluyen | El papel es la lista fija, como la planilla actual |
| Obligaciones omitidas (`SKIPPED`) | **No se imprimen** | El papel es lo pagable de este mes |
| Edificio sin gastos fijos | **No genera hoja**; en pantalla en gris | No desperdiciar papel; el hueco se ve igual |
| Fuente de las filas | Obligaciones del período, **previa sincronización automática** | Completa siempre, y deja la DB consistente (§3.3) |
| Orden del documento | Por banco, banco en el encabezado; "Sin banco" al final | Sigue cómo paga (plataforma por banco) y reusa `groupByBank` |
| Período | El **ACTIVE de cada edificio**, sin selector | Ver nota abajo |
| Salida | **Descargar PDF** (jsPDF) **+ Imprimir** (`window.print`) | La pantalla es la vista previa: se corrobora antes de gastar papel |
| Administración | La vista global es el lugar de edición | Prepara el mes entero sin entrar a 47 consorcios |
| Alta | Modal con **selección múltiple**, un edificio por vez | Sacar lo ya cargado del listado evita el duplicado en origen |
| Borrado | Desactivar **y** eliminar, separados | Eliminar arrastra historia (§3.5) |
| Config del consorcio | Sección de gastos fijos → resumen de solo lectura + link | Un solo lugar de edición, sin perder el acceso |
| Duplicados | Índice único en la base (**migración**) | Cierra la carrera concurrente (§3.4) |
| Acceso | Botón en el sidebar, rol **CLIENT** | Igual que "Cerrar Periodo General" |

**Nota sobre el período (sin selector).** Cada edificio imprime su propio período `ACTIVE`, y el
encabezado de su hoja lo dice (`FRANKLIN 25 — julio 2026`). No hay selector de mes: un selector
implicaría poder imprimir períodos cerrados, o sea el pasado, que nadie pidió — y con períodos
desalineados entre edificios, "elegir un mes" no tiene una respuesta única. El encabezado del
documento usa el **mes mayoritario** como título general. Un edificio sin período activo se muestra
en pantalla con esa advertencia y **no genera hoja**.

## 5. El documento

El modelo del documento es un dato puro, y es la **única fuente** que consumen la pantalla y el PDF:

```ts
type SheetRow = {
  fixedExpenseId: string;
  obligationId: string | null;      // null si el edificio no tiene período activo
  facturas: string | null;          // LspService.clientNumber
  concepto: string;                 // Provider.canonicalName | LspService.providerName (+ description)
  monto: number | null;             // Invoice.amount si la obligación está RECEIVED
  aliasCbu: string | null;          // Provider.paymentAlias
  status: ObligationStatus | "NO_PERIOD";
  active: boolean;                  // gasto fijo desactivado → se ve en gris, no se imprime
};

type SheetData = {
  consortiumId: string;
  consortiumName: string;
  bankId: string | null;
  bankName: string;                 // "Sin banco"
  bankColor: string | null;
  periodLabel: string | null;       // "julio 2026"
  rows: SheetRow[];
};
```

Reglas de impresión, todas puras y testeables (`toPrintableSheets`):

- Se descartan las filas con `status === "SKIPPED"` y las de gasto fijo `active: false`.
- Se descartan las hojas que quedan sin filas, y los edificios sin período activo.
- El orden es: banco (mismo orden que la vista general, "Sin banco" último) → edificio alfabético →
  filas con los LSP primero (los que tienen número de cliente) y después el resto, alfabético.

Pantalla y PDF parten del mismo `SheetData[]`: la pantalla muestra **todo** (incluidas omitidas,
inactivas y edificios vacíos, en gris); el PDF muestra `toPrintableSheets(data)`. Así el riesgo de
divergencia queda acotado al layout, nunca a los datos.

## 6. Arquitectura

### 6.1 Migración — dos índices únicos

En `prisma/schema.prisma`, sobre `FixedExpense`:

```prisma
@@unique([consortiumId, providerId])
@@unique([consortiumId, lspServiceId])
```

Postgres trata los `NULL` como distintos entre sí, así que un gasto fijo LSP (con `providerId: null`)
no colisiona con otro LSP del mismo consorcio. No hace falta un índice parcial.

Carpeta `prisma/migrations/20260812000000_unique_fixed_expense_target/migration.sql`.

**Antes de aplicarla hay que verificar que no existan duplicados**, o la migración falla:

```sql
SELECT "consortiumId", "providerId", "lspServiceId", COUNT(*)
FROM "FixedExpense"
GROUP BY 1, 2, 3
HAVING COUNT(*) > 1;
```

Esperado: 0 filas (§3.4). Si aparece alguna, se resuelve a mano antes de migrar.

### 6.2 Sincronización set-based

`src/services/obligation.service.ts` suma:

```ts
export async function syncObligationsForClient(
  clientId: string,
  prisma?: PrismaClient
): Promise<{ created: number; linked: number; periods: number }>
```

Pasos, todos sobre conjuntos:

1. Períodos `ACTIVE` del cliente (1 query).
2. Gastos fijos `active: true` de esos consorcios (1 query).
3. Obligaciones existentes de esos períodos → `Set<"periodId:fixedExpenseId">` (1 query).
4. `createMany({ data: faltantes, skipDuplicates: true })` (1 query).
5. Vínculo retroactivo **solo de las recién creadas**: se cargan las boletas de esos períodos (1
   query), se matchean en memoria con `obligationMatchesInvoice` y se actualizan las que dan
   positivo. En régimen normal esto es 0 updates; solo la primera corrida sobre un cliente viejo
   tiene volumen.

Es idempotente: correrla dos veces seguidas no crea nada. `generateObligationsForPeriod` se conserva
sin cambios para el camino de un período suelto (creación de período, cierre general, botón del
consorcio).

### 6.3 Endpoints

| Endpoint | Método | Qué hace |
|---|---|---|
| `/api/client/obligations/overview` | GET | Devuelve el `SheetData[]` completo + los catálogos para el modal de alta |
| `/api/client/obligations/sync` | POST | `syncObligationsForClient`. Lo llama la vista al montar |
| `/api/client/consortiums/[id]/fixed-expenses` | POST | **Se extiende** para aceptar `{ items: [...] }` además de la forma de a uno |
| `/api/client/consortiums/[id]/fixed-expenses/[fxId]` | PATCH / DELETE | Ya existen (desactivar / eliminar) |
| `/api/client/obligations/[id]` | PATCH | Ya existe (omitir / reactivar) |

**`GET /overview`** resuelve todo en ~4 queries: consorcios con banco + período activo + gastos fijos
(con `provider` y `lspService`), obligaciones de esos períodos con `invoice.amount`, y los catálogos
de `Provider` y `LspService` del cliente. Los proveedores viajan **una sola vez** al tope de la
respuesta (son de nivel cliente); los `LspService` van por consorcio. El filtrado de "lo ya cargado"
se calcula en el cliente con una función pura, no se repite el catálogo 47 veces.

**El alta múltiple** extiende el POST existente para recibir un array y responde
`{ ok, created: N, skipped: [{ target, reason }] }`. Es una sola transacción, sin llamadas externas
(nada de Drive ni Sheets), así que no tiene el problema de tiempo de las acciones masivas de Boletas.
Tras crear, el endpoint genera las obligaciones del período activo de ese consorcio para que las
filas nuevas aparezcan en el acto.

### 6.4 Tier 0 — lógica pura

| Archivo | Responsabilidad |
|---|---|
| `src/app/admin/obligaciones/lib/sheetModel.ts` | Tipos `SheetRow`/`SheetData`, `buildSheets` (respuesta del endpoint → modelo), `toPrintableSheets` (filtros y orden de §5) |
| `src/app/admin/obligaciones/lib/availableTargets.ts` | Dado el catálogo y las filas ya cargadas, qué queda disponible para el modal de alta |
| `src/app/admin/obligaciones/lib/sheetPdf.ts` | `SheetData[]` → documento PDF. `import()` dinámico de jsPDF |

`groupByBank` y `bankPalette` se importan de `consortiums/lib/` (o se promueven a `src/lib/` si el
import cruzado entre rutas incomoda; decisión de implementación, no de diseño).

### 6.5 Tier 1 — hooks

| Archivo | Responsabilidad |
|---|---|
| `hooks/useObligationsOverview.ts` | Sincroniza al montar, carga el overview, expone `sheets`, `isLoading`, `error`, `reload`, y las mutaciones (`addFixedExpenses`, `toggleFixedExpense`, `deleteFixedExpense`, `setObligationStatus`) con recarga optimista de la fila afectada |
| `hooks/useAddFixedExpenseModal.ts` | Estado del modal de alta: edificio abierto, búsqueda, selección múltiple, submit |

### 6.6 Tier 2 — componentes

| Archivo | Responsabilidad |
|---|---|
| `components/SheetCard.tsx` | La tarjeta-hoja de un edificio: encabezado, tabla de 6 columnas, acciones por fila, botón `+`. Presentacional |
| `components/AddFixedExpenseModal.tsx` | Lista con checkboxes agrupada (LSP / proveedores), buscador, `Agregar (N)` |
| `components/ObligationsToolbar.tsx` | Título, contadores, buscador, botones Descargar PDF e Imprimir |

### 6.7 Página e impresión

`src/app/admin/obligaciones/page.tsx` cablea las piezas. `page.module.css` define el layout y el
bloque `@media print`, que esconde la barra, el buscador y las acciones de fila, y aplica
`break-after: page` por tarjeta.

**Cuidado con CSS Modules:** corren en modo `pure` — todo selector necesita al menos una clase local.
Un `[data-bank-color="x"]` suelto compila en dev y pasa los tests, pero rompe `npm run build` (ver
`docs/progreso.md`, gotcha de 2026-08-03). Anclar siempre a la clase.

### 6.8 El PDF

`jspdf` + `jspdf-autotable`, cargados con `import()` dinámico dentro de `sheetPdf.ts`, para que no
pesen en el bundle del panel hasta que alguien aprieta Descargar. A4 vertical, una página por
edificio, encabezado con banco + edificio + período, tabla de seis columnas con las dos últimas
vacías, y pie con la fecha de generación. Nombre del archivo:
`obligaciones-YYYY-MM.pdf`.

### 6.9 Cambios en pantallas existentes

- **Sidebar** (`consortiums/page.tsx`): botón **Obligaciones**, visible con rol `CLIENT`, junto a
  Bancos y Consorcios.
- **Pestaña Obligaciones del consorcio**: el botón "Generar obligaciones" pasa a llamarse
  **"Sincronizar gastos fijos"**. Solo cambia el texto.
- **`ConfigModal`**: la sección "Gastos fijos" pierde el alta, el toggle y el borrado, y queda como
  resumen de solo lectura (*"11 gastos fijos activos"*) con un link a `/admin/obligaciones?c=<id>`.
  Los handlers correspondientes salen de `useConsortiumConfig` y sus tests se ajustan.

## 7. Bordes

- **Consorcio sin período activo:** se muestra con la advertencia y sin acciones de obligación (no
  hay obligaciones que omitir). El `+` sigue disponible: se puede cargar el gasto fijo, y la
  obligación aparecerá cuando el período se abra.
- **Cliente con `consortiumsEnabled: false`:** la vista se comporta como el resto del panel ante el
  feature gate (badge Premium, sin acceso).
- **Sincronización al montar que falla:** la vista igual carga el overview y muestra un aviso no
  bloqueante ("no se pudo sincronizar; la lista puede estar incompleta") con botón Reintentar. Nunca
  deja la pantalla en blanco por un fallo de sincronización.
- **Eliminar un gasto fijo con obligaciones cumplidas:** la confirmación dice cuántas obligaciones se
  borran y cuántas tienen boleta vinculada. La alternativa (desactivar) se ofrece en el mismo
  diálogo.
- **Omitir una obligación ya recibida:** el endpoint responde 409; la UI muestra el mensaje del
  servidor y no cambia la fila.
- **Alta múltiple parcialmente rechazada:** si una de las seleccionadas ya existía (carrera con otra
  pestaña), el endpoint la reporta en `skipped[]` y el modal lo muestra sin abortar el resto.
- **Impresión:** el navegador agrega su propio encabezado/pie salvo que el usuario los destilde en el
  diálogo. Es una configuración del navegador, no algo que la app controle.

## 8. Testing

- **Tier 0** (`sheetModel.test.ts`, `availableTargets.test.ts`): construcción del modelo desde una
  respuesta de ejemplo; `toPrintableSheets` descartando omitidas, inactivas, hojas vacías y edificios
  sin período; orden banco → edificio → LSP primero; disponibilidad del modal excluyendo lo ya
  cargado y respetando el corte por consorcio de los `LspService`.
- **Tier 0 del PDF:** se testea el **armado de los datos** que recibe el generador (filas, orden,
  saltos de página esperados), no el binario. El render se valida a ojo en local.
- **Tier 1** (`useObligationsOverview.test.tsx`): sincroniza antes de cargar; si la sincronización
  falla igual carga y expone el aviso; las mutaciones refrescan; el 409 de omitir se propaga como
  mensaje.
- **Tier 2** (`SheetCard.test.tsx`, `AddFixedExpenseModal.test.tsx`): render de los estados de fila
  (esperando / con monto / omitida / inactiva), edificio vacío en gris, confirmación de borrado con
  el conteo; selección múltiple y `Agregar (N)`.
- **Servicio** (`obligation.service.test.ts`): `syncObligationsForClient` crea lo faltante en todos
  los períodos activos, es idempotente en la segunda corrida, y vincula retroactivamente solo las
  recién creadas.

Verificación final: `npm run typecheck` + `npm run lint` + `npx vitest run` + `npm run build` +
`npm run build:jobs`.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| La sincronización al montar tarda en el primer uso (47 edificios sin obligaciones) | Set-based: ~5 queries, sin llamadas externas. La vista muestra el estado de carga y el overview no depende de que termine bien |
| Pantalla y PDF se desincronizan | Ambos consumen el mismo `SheetData[]`; la divergencia posible es de layout, no de contenido |
| `jspdf` + `jspdf-autotable` engordan el bundle | `import()` dinámico: solo se descargan al apretar Descargar |
| La migración falla por duplicados preexistentes | Query de verificación en §6.1, a correr antes. El repositorio ya bloquea el alta duplicada (§3.4), así que se espera 0 |
| Borrado accidental que arrastra historia | Confirmación con conteo + "desactivar" ofrecido en el mismo diálogo |
| Sacar el alta de `ConfigModal` rompe un flujo en uso | El link deja el acceso desde el consorcio; los tests del modal se ajustan en el mismo cambio |
| Se imprime una lista incompleta sin notarlo | La sincronización automática es justamente el fix; además la pantalla es la vista previa obligatoria antes de imprimir |

## 10. Fuera de alcance (anotado para el futuro)

- **`contactName` / `contactPhone` en `Provider`**, con carga desde el ALTA y el import Excel, para
  llenar las dos columnas que hoy se imprimen vacías. Migración chica; el PDF no cambia de forma.
- **Alta matricial** (servicios × edificios) para cargar la cartera entera de una.
- **Obligaciones de una sola vez**, sin gasto fijo detrás. Hoy `ExpenseObligation` exige
  `fixedExpenseId`.
- **Marcar lo ya pagado** en el papel (el dato existe en `Payment` / saldo pendiente).
- **Guardar el PDF en Drive** o mandarlo por mail.

## 11. Pendiente del owner

1. **Correr la query de verificación de duplicados** de §6.1 antes de la migración.
2. **Aplicar la migración** (`npx prisma migrate deploy` → `npx prisma generate`). Claude no la
   ejecuta.
3. **Smoke visual post-deploy:** abrir la vista con los 47 edificios; agregar dos gastos fijos de una
   a un edificio y ver aparecer las filas; omitir uno y confirmar que desaparece del PDF pero se ve
   en pantalla; descargar el PDF en PC y en celular; imprimir y comparar con la planilla actual de
   FRANKLIN 25.
