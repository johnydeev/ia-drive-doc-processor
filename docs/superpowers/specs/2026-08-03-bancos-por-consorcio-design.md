# Spec — Bancos a nivel cliente + datos de cuenta por consorcio + vista agrupada por banco

**Fecha:** 2026-08-03
**Tipo:** Feature (modelo de datos + backend + UI).
**Estado de partida (verificado):** working tree limpio en `e555327`, **419 tests** verdes,
`consortiums/page.tsx` en **1000 líneas** tras el cierre del refactor.
**Requiere migración de base de datos** — la escribe Claude, la ejecuta el owner.

---

## 1. Problema

Los consorcios se administran hoy sin ninguna noción de en qué banco cobran. Dos consecuencias:

1. La vista general de `/admin/consortiums` es una grilla plana de N edificios sin ningún eje de
   organización. Con ~50 edificios, encontrar "los que cobran en Santander" es imposible.
2. Los datos de la cuenta del consorcio (el bloque **FORMA DE PAGO** que va en las liquidaciones:
   banco, sucursal, titular, CBU, alias, número y tipo de cuenta) no viven en el sistema. Están
   fuera, en planillas sueltas.

## 2. Hallazgos verificados que condicionan el diseño

Relevados sobre el código antes de diseñar. Los tres cambian decisiones.

### 2.1 `Consortium.bank` ya existe y está muerto en el sentido opuesto al esperado

`prisma/schema.prisma:313` declara `bank String?`. El pipeline **lo lee** y lo propaga hasta Google
Sheets, columna **O = BANCO**:

- `processPendingDocuments.job.ts:415` → `base.consortiumBank = consortium.bank ?? null`
- `processPendingDocuments.job.ts:347` → misma asignación en la rama LSP
- `processPendingDocuments.job.ts:1039` → `extracted.bank = assignment.consortiumBank`
- `clientProcessingConfig.ts:73` → `bank: "O"` en `DEFAULT_SHEETS_MAPPING`

Pero **ningún código lo escribe**: ni la UI, ni el sync ALTA (`sync-directory/route.ts`), ni el
import Excel (`import/route.ts`). Está en `null` en todas las filas y la columna O de Sheets sale
siempre vacía.

**Consecuencia:** la feature no agrega una columna de Sheets, *destapa* una que ya está cableada.
Y el campo se puede reemplazar por una FK sin romper nada, porque no hay datos que preservar
(salvo carga manual por Supabase Studio — ver §4.3, el backfill lo cubre).

### 2.2 La columna ALIAS de Sheets es del proveedor

La columna **I = ALIAS** se llena con `extracted.alias = assignment.providerPaymentAlias`
(`job.ts:1036`), que sale de **`Provider.paymentAlias`** (`job.ts:346` y `job.ts:481`). Es el alias
de la contraparte a la que hay que pagarle, y funciona correctamente. **No se toca.**

### 2.3 `Consortium.paymentAlias` nació huérfano y está vacío

Origen documentado: commit `aa7784f` (23/03/2026) y la entrada *"Separar matchNames (interno) de
paymentAlias (visible)"* de `docs/decisiones.md`. Ese cambio partió el viejo campo `alias`/`aliases`
(que mezclaba matching interno con nombre de display) en dos: `matchNames` interno y `paymentAlias`
visible, **agregando `paymentAlias` a `Provider` y `Consortium` por simetría**.

Pero sólo se cableó el del proveedor. El de consorcio quedó así:

- **Se escribe:** desde el sync ALTA (`sync-directory/route.ts:122,131`, columna D de `_Consorcios`)
  y desde el import Excel (`import/route.ts:110,132`, columna "Alias de pago" de la hoja Edificios).
- **No se lee:** ningún código lo consume. No llega a Sheets ni a la UI.
- **No tiene datos:** la columna ALIAS de la hoja de consorcios está vacía en todas las filas
  (verificado por el owner sobre el archivo real).

Un campo sin lectores, sin datos y con nombre que describe otra cosa. Se reutiliza (§4.2).

## 3. Alcance

**Entra:**
- Modelo `Bank` a nivel `Client` (catálogo reutilizable: nombre + color).
- FK `bankId` en `Consortium` reemplazando el `bank String?` muerto.
- Rename `Consortium.paymentAlias` → `bankAlias`, que pasa a ser el alias CBU de la cuenta del
  consorcio, cargado por UI.
- Cinco campos de cuenta más en `Consortium` (`cbu`, `accountNumber`, `branch`, `accountType`,
  `accountHolder`).
- Baja de la carga de alias de consorcio por ALTA y por import Excel.
- CRUD de bancos (`/api/client/banks`), y `bankId` + los campos de cuenta en el PATCH de consorcio.
- Vista general de dos niveles: cards de banco con badges de edificios → grilla de edificios actual
  filtrada por banco.
- Modal ABM de bancos desde el sidebar.
- Nueva sección "Banco" en el acordeón del `ConfigModal` del consorcio.
- El pipeline pasa a leer el nombre del banco por la relación → la columna O de Sheets se llena.

**No entra (decisiones explícitas, ver §9):**
- Múltiples cuentas bancarias por consorcio.
- Tocar `Provider.paymentAlias` ni la columna I de Sheets ni la hoja `_Proveedores`.
- Asignación masiva de banco desde la grilla.
- Escribir CBU / alias bancario / número de cuenta en Google Sheets.
- Carga de bancos desde el archivo ALTA.

## 4. Modelo de datos

### 4.1 Modelo `Bank`

```prisma
model Bank {
  id          String       @id @default(cuid())
  clientId    String
  name        String
  /// Slug de la paleta fija (ver src/app/admin/consortiums/lib/bankPalette.ts).
  /// No es un hex libre: garantiza contraste en dark y light.
  color       String       @default("slate")
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  client      Client       @relation(fields: [clientId], references: [id], onDelete: Cascade)
  consortiums Consortium[]

  @@unique([clientId, name])
  @@index([clientId])
}
```

`Client` suma `banks Bank[]`.

### 4.2 Cambios en `Consortium`

La línea `bank String?` se reemplaza, `paymentAlias` se renombra, y se agregan cinco campos:

```prisma
  /// Banco del catálogo del cliente. Reemplaza el viejo `bank String?`, que era
  /// texto suelto y ningún código llenaba.
  bankId                 String?
  bank                   Bank?    @relation(fields: [bankId], references: [id], onDelete: SetNull)
  /// Datos de la cuenta del consorcio (bloque FORMA DE PAGO de la liquidación).
  /// Una sola cuenta por consorcio — ver §9.1. Se cargan por UI, no por ALTA.
  /// bankAlias es el alias CBU (ex `paymentAlias`, que nació huérfano — ver §2.3).
  bankAlias              String?
  cbu                    String?
  accountNumber          String?
  branch                 String?
  accountType            String?
  accountHolder          String?
```

**Por qué el banco va en tabla aparte y la cuenta no:** el banco se repite entre edificios (los 4
que cobran en Santander comparten nombre y color, y un renombre debe impactar a los 4). El CBU y el
número de cuenta son únicos de cada edificio — si vivieran en `Bank`, todos los edificios de un
banco compartirían un solo CBU, que es incorrecto.

`accountType` es `String?` y no un enum: evita una migración si aparece un tipo de cuenta no
previsto. La UI ofrece un `<select>` con "Cuenta Corriente" y "Caja de Ahorro" más la opción de
escribir otro valor.

**No se guarda el CUIT de la cuenta:** `Consortium.cuit` ya existe y es el mismo (decisión del
owner).

### 4.3 Migración

Carpeta `prisma/migrations/20260803000000_bancos_por_consorcio/migration.sql`, en este orden:

1. `CREATE TABLE "Bank"` + índices + FK a `Client`.
2. **Backfill defensivo:** `INSERT INTO "Bank" (...)` con un `SELECT DISTINCT "clientId", "bank"` de
   los consorcios con `bank IS NOT NULL`. Se espera que no traiga filas (§2.1), pero cubre el caso de
   que alguien haya cargado el campo a mano por Supabase Studio.
3. `ALTER TABLE "Consortium" ADD COLUMN "bankId"` + las 5 columnas de cuenta nuevas.
4. `UPDATE "Consortium" SET "bankId" = ...` matcheando por `(clientId, bank)` contra las filas
   recién insertadas.
5. `ALTER TABLE "Consortium" DROP COLUMN "bank"`.
6. `ALTER TABLE "Consortium" RENAME COLUMN "paymentAlias" TO "bankAlias"` — preserva los valores,
   que además están todos en `NULL` (§2.3).
7. FK de `Consortium.bankId` → `Bank.id` con `ON DELETE SET NULL`.

El paso 5 es el único destructivo, y es seguro porque los pasos 2 y 4 preservaron cualquier valor
que existiera. **La ejecuta el owner** (`npx prisma migrate deploy` → `npx prisma generate`), como
manda CLAUDE.md.

## 5. Backend

### 5.1 Endpoints nuevos

| Ruta | Método | Comportamiento |
|---|---|---|
| `/api/client/banks` | GET | Bancos del cliente, orden alfabético, con `_count.consortiums`. |
| `/api/client/banks` | POST | Crea (`name`, `color`). Nombre duplicado → **409**. |
| `/api/client/banks/[id]` | PATCH | Renombra y/o cambia color. Duplicado → **409**. |
| `/api/client/banks/[id]` | DELETE | Borra. Los consorcios asignados quedan en `bankId = null`. |

Todos con `requireClientSession` (`src/lib/clientAuth.ts`) — el test de regresión
`routeAuthGuard.test.ts` falla si una ruta nueva no usa un guard. Validación con Zod, `name`
trimeado y con `min(1)`, `color` restringido a los slugs de la paleta.

El scoping por `clientId` sale de la sesión, nunca del body: cada handler filtra por
`{ id, clientId: auth.session.clientId }` antes de mutar, como hace hoy el PATCH de consorcio
(`consortiums/[id]/route.ts:71`).

### 5.2 Endpoint existente a extender

`PATCH /api/client/consortiums/[id]` hoy sólo acepta `matchNames` (whitelist explícita en
`route.ts:82-85`). Suma `bankId` (validando que el banco pertenezca al mismo cliente, o `null` para
desasignar) y los seis campos de cuenta (`bankAlias`, `cbu`, `accountNumber`, `branch`,
`accountType`, `accountHolder`). Se mantiene el patrón de whitelist: campo no reconocido se ignora,
no se hace spread del body.

### 5.3 Baja de la carga de alias de consorcio por ALTA e import

El alias del consorcio pasa a cargarse **sólo por UI**. Se quita su lectura y escritura de las dos
vías de importación:

- `googleSheets.service.ts:414` → el mapeo de `_Consorcios` deja de leer `row[3]`; el rango pasa de
  `A:D` a `A:C` y el tipo `DirectoryData.consortiums` pierde `paymentAlias`
  (`googleSheets.service.ts:128`). Los headers auto-creados de la hoja bajan a 3 columnas
  (`googleSheets.service.ts:98`).
- `sync-directory/route.ts:122,131` → el upsert de consorcios deja de mandar `paymentAlias`.
- `import/route.ts:110,132` → la hoja Edificios deja de leer "Alias de pago"; se quita también del
  template (`import/template/route.ts`).

**La hoja `_Proveedores` y el import de proveedores no se tocan:** ahí `paymentAlias` tiene
consumidor real (columna I de Sheets) y sigue igual, con su rango `A:E`.

Si el archivo ALTA de un cliente conserva físicamente la columna D en la hoja de consorcios, no pasa
nada: el código simplemente deja de leerla.

### 5.4 Repositorio

`BankRepository` en `src/repositories/bank.repository.ts`, siguiendo el patrón de
`consortium.repository.ts`: sólo operaciones de base de datos, sin lógica de negocio.

## 6. Pipeline y Google Sheets

`consortiumBank` deja de leer una columna de texto y pasa a leer la relación:

```ts
base.consortiumBank = consortium.bank?.name ?? null;
```

Hay que incluir la relación en los tres puntos donde se selecciona el consorcio:

- `processPendingDocuments.job.ts` (rama normal, ~línea 415, y rama LSP, ~línea 347)
- `src/app/api/client/consortiums/[id]/invoices/route.ts:97`
- `src/repositories/lspService.repository.ts:11`

Nada más cambia: `extracted.bank` y el mapping a la columna O quedan igual. Los tests de
caracterización del pipeline (`processPendingDocuments.job.test.ts`) deben correr verdes antes y
después; su fixture usa `bank: null` (`job.test.ts:127`) y pasa a usar la relación.

**Efecto visible:** la columna O de Sheets empieza a llenarse para los consorcios con banco
asignado. Las boletas ya procesadas no se reescriben.

## 7. UI

### 7.1 Navegación de dos niveles

`/admin/consortiums` gana un nivel por delante del actual:

- **Nivel 0 (nuevo landing):** grilla de cards de banco.
- **Nivel 1:** la grilla de edificios **actual, sin cambios**, filtrada por el banco elegido. Header
  con `← Todos los bancos` y el nombre del banco.
- **Nivel 2:** el detalle del consorcio, sin cambios.

Estado nuevo: `selectedBankId: string | null` (más el valor centinela para "Sin banco"). Vive en el
hook de la vista general, no en `page.tsx` suelto.

**Restauración por deep-link:** la lógica existente de `pendingRestore` (que reabre un consorcio por
URL) no cambia. Al volver desde el detalle de un consorcio se vuelve al nivel 1 de su banco. El
nivel 0/1 no se refleja en la URL.

### 7.2 Card de banco

Contenido: nombre del banco + un badge por edificio + color sutil de la paleta.

- Click en la card → nivel 1.
- Click en un badge → entra directo a ese consorcio (atajo que saltea el nivel 1). Para no anidar
  controles interactivos, la card es un `<div>` con el título clickeable, no un `<button>`
  envolvente.
- Card **"Sin banco"** al final, en gris neutro, con los consorcios sin asignar. Si no hay ninguno,
  no se renderiza.

### 7.3 Paleta

`lib/bankPalette.ts` es la fuente única: exporta los slugs válidos (`slate`, `red`, `amber`,
`emerald`, `teal`, `sky`, `violet`, `rose`) con su label en español para el selector. Es el mismo
literal que valida el Zod del endpoint.

El color se aplica con `data-bank-color="<slug>"` en la card, y `page.module.css` define
`[data-bank-color="red"] { --bank-accent: ...; --bank-bg: ...; }` etc., con valores propios para
`[data-theme="dark"]` y `[data-theme="light"]` — mismo mecanismo que ya usa `globals.css`. Se evita
así construir nombres de clase dinámicos con CSS Modules.

Contraste: el color pinta borde y fondo tenue de la card; el texto sigue usando `--text-heading` /
`--text-secondary`. Ningún texto queda coloreado, así no hay riesgo de ilegibilidad en ninguno de
los dos temas.

### 7.4 Buscador del nivel 0

Filtra por nombre de banco **y** por nombre de edificio. Si el término matchea edificios, se muestran
las cards de los bancos que los contienen, con los badges reducidos a los que matchean. Sin esto se
perdería el "buscar un edificio directo desde la home" que hoy existe.

Reutiliza `normName` de `lib/match.ts` (el mismo que usa el buscador actual).

### 7.5 Piezas nuevas

Siguiendo el patrón validado en el refactor (hook de dominio + componente presentacional + tests
tier 1/tier 2), y el contrato "mover, no reescribir" para lo que ya existe:

| Pieza | Responsabilidad |
|---|---|
| `hooks/useBanks.ts` | Catálogo (fetch), alta, renombre, borrado, estado del modal ABM. |
| `components/BanksModal.tsx` | ABM presentacional: lista con color y contador, form de alta, selector de paleta, confirmación de borrado. |
| `components/BankGrid.tsx` | Nivel 0: cards de banco con badges. Presentacional puro. |
| `lib/groupByBank.ts` | Agrupación pura: `(banks, consortiums, query) → BankGroup[]`, con "Sin banco" al final. Sin React. |
| `lib/bankPalette.ts` | Slugs válidos + labels. Fuente única compartida con el Zod del endpoint. |

`lib/types.ts` suma `Bank`, `BankGroup` y los campos de cuenta en el tipo `Consortium` (que ya
declara `bank: string | null` en `types.ts:8` — pasa a `bank: { id, name, color } | null`).

### 7.6 Sección "Banco" en el ConfigModal

`ConfigSection` pasa de `"matchNames" | "lsp" | "fixed"` a incluir `"bank"`. La sección contiene el
`<select>` de banco (opciones del catálogo + "— Sin banco —") y los seis campos de cuenta
(`bankAlias`, `cbu`, `accountNumber`, `branch`, `accountType`, `accountHolder`), con un único botón
de guardado que hace el PATCH.

Entra en `useConsortiumConfig` como cuarto sub-objeto (`bank`), junto a `matchNames` / `lsp` /
`fixed`, y se resetea/recarga en su `load(c)` como los otros tres. El hook recibe el catálogo de
bancos por parámetro (lo dueña `useBanks`), igual que hoy `ConfigModal` recibe `providers` por props.

Botón **Bancos** en el sidebar abre el `BanksModal`.

### 7.7 Feedback de carga

Todo botón que dispare una llamada a API (crear/renombrar/borrar banco, guardar la sección Banco)
usa `AsyncButton` / `useAsyncAction`, y los botones de sólo icono (tacho de borrar banco) muestran
`Loader2` con `animate-spin` mientras `isPending`, según la regla global del owner.

## 8. Testing

Convención vigente: lógica pura → `.test.ts` (proyecto `node`); hooks y componentes → `.test.tsx`
(proyecto `jsdom`).

- **Tier 0 —** `lib/groupByBank.test.ts`: agrupación con bancos vacíos, consorcios sin banco,
  filtrado por nombre de banco, filtrado por nombre de edificio (badges reducidos), orden y
  posición del grupo "Sin banco", y que no se emita el grupo "Sin banco" cuando no corresponde.
  `lib/bankPalette.test.ts`: los slugs del módulo y los del Zod no divergen.
- **Tier 1 —** `hooks/useBanks.test.tsx`: alta, renombre, borrado con confirmación, manejo del 409
  por nombre duplicado. `hooks/useConsortiumConfig.test.tsx`: el sub-objeto `bank` se resetea y
  recarga en `load(c)`, y el guardado arma el PATCH correcto.
- **Tier 2 —** `components/BankGrid.test.tsx`: render de cards, badges, click en card vs click en
  badge, card "Sin banco". `components/BanksModal.test.tsx`: lista, alta, borrado.
- **Regresión —** `routeAuthGuard.test.ts` cubre automáticamente las rutas nuevas.
- **Caracterización —** `processPendingDocuments.job.test.ts` verde antes y después del cambio de
  `consortiumBank`.
- **Sync — sin cobertura automatizada.** Verificado: no existe ningún test de `readDirectory` ni de
  `sync-directory` (los únicos tests de `googleSheets.service` son los de `rowIndex`). El cambio de
  `A:D` a `A:C` en la hoja de consorcios se valida en el smoke del owner (§11, punto 5). Escribir un
  test del mapeo exige mockear el cliente de la API de Sheets — es trabajo aparte, no se arrastra
  a esta feature.

## 9. Decisiones tomadas y alternativas descartadas

### 9.1 Una sola cuenta bancaria por consorcio

Decisión del owner. Los seis campos van sueltos en `Consortium`, no en una tabla `BankAccount` 1:N.

Descartado: tabla `BankAccount` con `isPrimary`. Habilita el caso de un consorcio con cuenta de
expensas y cuenta de fondo de reserva, pero rompe la partición limpia de la vista (un edificio
aparecería en dos grupos, o habría que elegir por cuál agrupar) y obliga a decidir qué banco va a la
columna O de Sheets. Si el caso aparece, la migración es acotada: mover seis columnas a una tabla
nueva y elegir la política de agrupación.

### 9.2 `paymentAlias` del consorcio se renombra a `bankAlias` en vez de convivir con un campo nuevo

El campo no tiene lectores, no tiene datos y su nombre describe otra cosa (§2.3). Renombrarlo evita
dejar un campo huérfano al lado de uno nuevo que hace lo que aquél nunca hizo.

Descartado: agregar `bankAlias` y dejar `paymentAlias` del consorcio como estaba. Quedarían dos
campos de alias en la misma entidad, uno de ellos sin fuente de carga (se le saca el ALTA) y sin
lector.

Descartado también: reusar el nombre `paymentAlias` para el alias CBU. Cero cambios de columna, pero
perpetúa la confusión que nos costó tres vueltas de investigación en este mismo diseño.

### 9.3 Borrar un banco desasigna, no bloquea

`onDelete: SetNull`. La UI confirma diciendo cuántos consorcios quedarán sin banco.

Descartado: rechazar con 409 si tiene consorcios asignados. Deja al usuario trabado teniendo que
desasignar uno por uno antes de poder borrar.

### 9.4 El color se guarda como slug de paleta, no como hex

Descartado: `<input type="color">`. Da libertad total pero permite elegir un tono ilegible en dark o
en light, y obligaría a derivar el fondo por opacidad para mitigarlo. La paleta fija resuelve el
contraste de una vez.

Descartado también: color automático por hash del nombre. Cero UI, pero el color sería arbitrario
(Santander podría salir verde) y cambiaría al renombrar.

### 9.5 Los datos de cuenta no van a Google Sheets

Sólo el nombre del banco sigue yendo a la columna O, que ya está cableada. Agregar CBU, alias y
número de cuenta implica columnas nuevas en el mapping y en la hoja de cada cliente, sin un consumo
que lo justifique todavía. Si más adelante se genera el bloque FORMA DE PAGO de la liquidación, los
datos ya están en la DB.

### 9.6 Sin asignación masiva desde la grilla

Para ~50 edificios la carga inicial se hace de a uno desde el Config. La selección múltiple + barra
de acciones es UI que se justifica sólo si la carga se vuelve recurrente.

## 10. Fuera de alcance, anotado

- **Bancos en el archivo ALTA:** hoy `Rubro` y `Coeficiente` (los otros catálogos a nivel cliente) se
  cargan desde ALTA. Los bancos se cargan sólo por UI. Sumar una hoja `_Bancos` es coherente, pero es
  trabajo aparte y la UI ya cubre el caso.
- **A verificar con el owner (no bloquea):** en una captura del archivo ALTA la hoja aparece con el
  nombre `Consortium_Details` y una columna `ACTIVO`, mientras que `readDirectory` lee la hoja
  `_Consorcios` y nunca una columna `ACTIVO`. Si el archivo real usa esos nombres, el sync no está
  leyendo lo que el owner cree. Es un tema del sync ALTA, independiente de esta feature.

## 11. Verificación

Contrato de siempre:

```
npm run typecheck
npm run lint
npx vitest run
npm run build:jobs
npm run build
```

Cero errores; el único warning baseline conocido es `uploadingReceiptId`.

**Smoke visual del owner post-deploy** (requiere sesión autenticada):
1. Crear dos bancos con colores distintos; renombrar uno; borrar uno y verificar que el consorcio
   asignado queda en "Sin banco".
2. Asignar banco y cargar alias/CBU/cuenta a un consorcio desde Config; reabrir y verificar que
   persistió.
3. Vista general: ver las cards por banco, entrar por la card y por un badge, volver con
   `← Todos los bancos`.
4. Buscar por nombre de banco y por nombre de edificio en el nivel 0.
5. Correr **Sincronizar directorio** y verificar que los consorcios se siguen sincronizando bien con
   la hoja de 3 columnas, y que el alias cargado por UI **no se pisa**.
6. Procesar una boleta de un consorcio con banco asignado y verificar la columna **O = BANCO** en
   Google Sheets.

**Documentación obligatoria al cerrar:** `docs/progreso.md`, `docs/decisiones.md` (el hallazgo de la
columna O muerta, el origen huérfano de `Consortium.paymentAlias` y la decisión de una cuenta por
consorcio) y `CHANGELOG.md`.
