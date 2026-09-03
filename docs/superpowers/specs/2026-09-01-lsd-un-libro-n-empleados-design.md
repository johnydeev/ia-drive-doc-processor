# LSD: un libro, N empleados, N gastos

**Fecha:** 2026-09-01
**Estado:** spec aprobado, sin implementar
**Origen:** los LSD (Liquidación de Sueldos Digital) llegan todos los meses y hoy no se procesan. Cada uno
tiene **varios empleados**, y el gasto que hay que registrar es el **sueldo neto de cada uno**, no un
total del libro. El pipeline produce como máximo una `Invoice` por archivo, así que el documento no
entra en el modelo actual.

---

## 1. Lo que dicen los papeles

Medido sobre los 5 LSD reales que aportó el owner (julio 2026).

**El CUIT del consorcio está impreso en el encabezado**, en formato canónico, y los 5 matchean
exacto contra la base:

| LSD | CUIT en el papel | Consorcio |
|---|---|---|
| ALMIRANTE BROWN 706 | `30-52063978-7` | ✅ |
| BOEDO 414 | `30-54675623-4` | ✅ |
| CALLAO 1441 | `30-70200241-5` | ✅ |
| PUEYRREDON 2418 | `30-71001560-7` | ✅ |
| RIOBAMBA 1261 | `30-70958299-9` | ✅ |

**Consecuencia:** el consorcio se resuelve con el matching por CUIT que ya existe. No hace falta
`LspService`, ni identificar el edificio por el CUIL del empleado, ni ningún alta previa extra.

**Cada libro tiene varios empleados**, en la misma hoja (no una hoja por empleado):

| LSD | Empleados | Legajos vistos |
|---|---|---|
| ALMIRANTE BROWN 706 | 2+ | 1, 4 |
| BOEDO 414 | 1 | 1 |
| CALLAO 1441 | 2+ | 2, 4 |
| PUEYRREDON 2418 | 2+ | 2, 4 |
| RIOBAMBA 1261 | 2+ | 1, 4 |

Los legajos saltan, así que hay empleados intermedios que la extracción de prueba no capturó: son
más de los que muestra la tabla. **Partir el PDF por páginas no sirve** — los empleados comparten
hoja, en dos columnas.

El CUIL tiene el mismo formato y checksum que un CUIT, así que `extractCuitsFromText` ya lo levanta.

## 2. Decisiones tomadas

| Tema | Decisión |
|---|---|
| Representación | **N `Invoice`, una por empleado**. El empleado es el proveedor de su boleta |
| Generación | El **pipeline** las extrae con IA: un prompt propio de LSD devuelve la lista de empleados |
| Alta del empleado | Manual, en `_Proveedores`: nombre, **CUIL en el campo CUIT**, tipo `EMPLEADO` |
| Gasto fijo | **Manual**, uno por empleado, como cualquier otro |
| Vista | **Una fila por empleado**, mezclada con el resto de los gastos del edificio |
| Empleado sin alta | **Todo o nada**: no entra ninguna boleta del libro |
| Número de comprobante | `<identificador único del libro>-<CUIL>` |
| Vencimiento | `null` |
| Unique de `documentHash` | Hash **derivado por empleado** |

## 3. Diseño

### 3.1 Extracción

Prompt propio de LSD (`buildLsdPrompt`), enrutado por el router que ya detecta el tipo de documento.
Devuelve:

```
consortiumTaxId   – el CUIT del encabezado
libroId           – IDENTIFICADOR ÚNICO DEL LIBRO
periodo           – "202607"
empleados: [ { cuil, apellidoNombre, sueldoNeto } ]
```

El `sueldoNeto` es el gasto. **No** se extrae el total del libro: no se registra como gasto.

### 3.2 Fan-out con sub-pipeline

El pipeline se parte en dos tramos:

- **Por archivo** (una vez): descarga, dedup, extracción de texto, triage, extracción IA.
- **Por boleta** (N veces): clave de negocio, asignación, canonización, Sheets, guardado.

Tras la extracción, si el documento es un LSD con N empleados, el runner ejecuta la cola de pasos
restante **N veces**, sobre contextos derivados que comparten `buffer`, `fileHash`, `driveFileId` y
`sourceFileUrl`, y difieren en `extracted`.

**Los pasos existentes no cambian**: cada uno sigue viendo una boleta, como hoy. Es lo que hace
viable el fan-out sin tocar los 12 pasos ni romper la red de tests de caracterización.

**`fileOrganizationStep` corre una sola vez**, al final: el archivo de Drive es uno solo y se mueve
una vez. Sheets sí escribe N filas, una por empleado.

Alternativas descartadas: que cada paso itere sobre un array (toca los 12 pasos y rompe los tests de
caracterización), y expandir antes de encolar (necesita estado nuevo para "N jobs del mismo archivo"
y complica el movimiento en Drive).

### 3.3 Identidad y deduplicación

Cada boleta lleva:

- `boletaNumber` = `<libroId>-<CUIL>` → la **clave de negocio ya distingue** las N boletas del mismo
  libro sin tocar su definición.
- `dueDate` = `null`.
- `documentHash` = **`sha256(hash del archivo + CUIL)`**. El unique `(clientId, documentHash)` de
  `Invoice` admite una sola fila por hash de archivo, así que N boletas del mismo PDF lo violan. El
  hash derivado las hace únicas **sin migración** y conservando la garantía a nivel base.

**El corte temprano se recupera por `driveFileId`.** `dedupHashStep` deja de reconocer un LSD
reprocesado (su hash derivado no coincide con el del binario), lo que gastaría una request de IA por
cada reproceso. Para evitarlo, el paso consulta **también** si ya existe una `Invoice` con ese
`driveFileId`: si la hay, el archivo ya se procesó y corta ahí, con 0 tokens. Vale para todos los
documentos, no sólo los LSD.

### 3.4 Contadores y métricas

Un archivo sigue siendo **un `ProcessingJob` y un `onOutcome`**, aunque produzca N boletas:

- `summary.processed` suma **N** (son N gastos registrados).
- `aiRequests` es el del **archivo**: una sola extracción para todos los empleados. Es el dato que
  hace visible la ganancia — un LSD de 4 empleados cuesta lo mismo que una factura común.
- `outcome` = `ok` si el libro entró; `unassigned` si rebotó por el todo-o-nada, con el CUIL faltante
  en `reasonCategory`.
- La línea `[metrics]` sigue siendo una por archivo, con el conteo de boletas generadas.

### 3.5 Todo o nada: el libro entra completo o no entra

Hay **un solo punto de decisión**, antes de persistir nada. Se validan dos cosas y ambas tienen que
dar bien:

1. **Todos los CUIL extraídos están dados de alta** como proveedor tipo `EMPLEADO`.
2. **Los empleados extraídos cubren todos los gastos fijos de empleado activos del consorcio.**

Si cualquiera falla: no se persiste ninguna boleta, no se escribe ninguna fila en Sheets, y el
archivo va a **Sin Asignar** etiquetado con lo que faltó.

**Por qué la segunda validación.** La primera sola no alcanza: si el libro tiene 4 empleados y la IA
devuelve 3 —todos dados de alta—, los 3 pasan y el edificio queda con un sueldo de menos sin que
nada lo marque. El sistema nunca supo que había un cuarto.

**Y no se puede validar contra el papel:** ninguno de los 5 LSD declara la cantidad de empleados, y
contar los CUIL del texto es ruidoso (ALMIRANTE BROWN devuelve 5 CUIL válidos para 2 empleados con
nombre: el libro está lleno de números largos —identificador de hoja móvil de 20 dígitos, códigos de
concepto— y algunos pasan el checksum por casualidad).

Los **gastos fijos** sí son una fuente exacta: el owner da de alta uno por empleado, a mano, así que
el padrón del edificio ya está en la base y no depende de la extracción.

| Situación | Resultado |
|---|---|
| La IA se saltea un empleado | Queda un gasto fijo sin cubrir → **el libro no entra** |
| **Suplente que cubre vacaciones**, sin alta previa | Su CUIL no está registrado → **el libro no entra**, avisando cuál |
| Empleado nuevo, sin gasto fijo todavía | Ídem: **no entra** |
| Empleado que se fue, con gasto fijo activo | El libro no lo trae → **no entra** hasta desactivarlo |

**El caso del suplente es el que más va a doler, y es una decisión consciente del owner
(2026-09-01).** Un reemplazo por vacaciones aparece en el libro sin haberse dado de alta antes, así
que va a frenar el libro completo del edificio. Se evaluó darlo de alta automáticamente —el LSD trae
CUIL y nombre completo, así que el alta no adivinaría nada— y **se descartó**: el owner prefiere que
nada se cree solo en el directorio.

Procedimiento cuando pasa: dar de alta al suplente en `_Proveedores` (CUIL, tipo `EMPLEADO`), crear
su gasto fijo, y reprocesar el libro. **Cuesta una request de extracción por cada reproceso.**

La fricción del último caso también es deliberada: obliga a mantener el padrón al día, que es la
condición para que la validación signifique algo.

### 3.6 La hoja de obligaciones

**No cambia nada del modelo de la vista.** Cada empleado ya es un `Provider` y su gasto fijo un
`FixedExpense`, así que produce una `SheetRow` normal:

| Columna | Valor |
|---|---|
| PROVEEDORES Y SERVICIOS | nombre del empleado |
| MONTO | sueldo neto |
| ALIAS - CBU | el CBU del empleado (`paymentAlias`) |

Es lo que la hoja necesita: **una transferencia por fila**. `FixedExpense` ya tiene unique
`(consortiumId, providerId)`, así que un empleado por edificio entra sin cambios, y
`linkInvoiceToObligation` marca la obligación como recibida igual que con cualquier proveedor.

El PDF imprimible tampoco cambia.

## 4. Riesgos

- **El sueldo neto no siempre es lo que se transfiere.** Con embargos, adelantos o pagos en dos
  partes, el monto de la hoja no va a coincidir con la transferencia real. Queda a la vista del owner
  al pagar.
- **Un empleado que se va deja su gasto fijo activo** y genera una obligación PENDING incumplida
  todos los meses hasta que se desactive. Es consecuencia del alta manual, que fue la decisión.
- **Una extracción mala mete un gasto mal.** Un sueldo leído de menos entra igual. Mitigación: el
  monto se ve en la hoja antes de pagar, y la boleta se puede borrar y reprocesar.
- **Extracción parcial de empleados** — cubierto por la validación contra los gastos fijos (§3.5).
  El riesgo que queda es el de un edificio cuyo padrón esté desactualizado: si nunca se cargó el
  gasto fijo de un empleado, su ausencia en el libro no se detecta. La validación es tan buena como
  el padrón.

## 5. Tests

| Qué | Dónde |
|---|---|
| El prompt de LSD devuelve N empleados sobre el texto real de los 5 libros | `extraction.test.ts` |
| El fan-out produce N boletas con `boletaNumber` distinto | `processPendingDocuments.job.test.ts` |
| El archivo se mueve **una sola vez** aunque haya N boletas | `processPendingDocuments.job.test.ts` |
| Sheets recibe N filas | `processPendingDocuments.job.test.ts` |
| Un CUIL sin alta → 0 boletas, archivo a Sin Asignar | `processPendingDocuments.job.test.ts` |
| Un gasto fijo de empleado sin cubrir → 0 boletas, archivo a Sin Asignar | `processPendingDocuments.job.test.ts` |
| Los empleados cubren exactamente los gastos fijos → entran las N | `processPendingDocuments.job.test.ts` |
| El hash derivado es distinto por empleado y estable entre corridas | `invoice.repository.test.ts` |
| Reprocesar un archivo ya cargado corta por `driveFileId` sin llamar a la IA | `processPendingDocuments.job.test.ts` |
| Un LSD de un solo empleado se comporta como una boleta normal | `processPendingDocuments.job.test.ts` |

## 6. Fuera de alcance

El triage actual manda los LSD a Sin Asignar como `[NO BOLETA - LSD]`; **eso se revierte cuando esta
feature entre**, no antes. Tampoco entra: el total del libro como gasto, las cargas sociales (que ya
llegan por su propio VEP/F931), ni ninguna UI nueva.

## 7. Verificación

`npm run typecheck` + `npx vitest run` + `npm run lint` + `npm run build:jobs`. **Sin migración.**

Verificación real: procesar un LSD de 2 empleados y confirmar que aparecen 2 gastos en la hoja del
edificio, cada uno con su CBU, y que el PDF quedó una sola vez en Rendiciones.
