# Spec — `_Proveedores`: terminología, alias múltiples y oficio

**Fecha:** 2026-08-17
**Tipo:** Terminología + modelo + UI.
**Requiere migración** (tabla `Oficio` + FK en `Provider`).
**Estado de partida:** sync de directorio sin borrado y `SERVICIO` en `ProviderType`, ambos
commiteados en `c4aa43f` y deployados. 636 tests verdes.

---

## 1. Problema

Tres cosas distintas sobre la misma hoja del ALTA:

**La terminología no es la del administrador.** La columna A dice "NOMBRE CANÓNICO", que es jerga
interna. Lo que el owner carga ahí es la **razón social** exacta, tomada del padrón por CUIT. La
columna C dice "NOMBRES ALTERNATIVOS" cuando en proveedores contiene el **nombre de fantasía**: el
nombre con el que la empresa aparece en sus boletas, que muchas veces no coincide con la razón
social — y cuando coincide, la celda se deja vacía.

**Un proveedor puede tener más de un alias de pago.** `Provider.paymentAlias` es un único texto. En
la práctica un proveedor puede dar dos o tres destinos de cobro, y a veces lo que da es un CBU en
lugar de un alias.

**No hay forma de saber a qué se dedica un proveedor.** Con ~180 proveedores cargados, el nombre solo
no alcanza para reconocer de qué se trata cada uno.

## 2. Qué NO es

**El oficio no es el `Rubro`.** El rubro divide las secciones de una liquidación de expensas y
**agrupa** varios oficios; el oficio identifica al proveedor uno por uno. Son dos niveles distintos y
conviven: un rubro "Mantenimiento" puede contener proveedores de oficio Pintor, Albañil y
Electricista. Por eso el oficio va en un catálogo propio y no reusa `Rubro`.

**El alias del proveedor no es el del edificio.** `Consortium.bankAlias` y `Consortium.cbu`
identifican la cuenta **del consorcio** (de dónde sale la plata) y se cargan por UI.
`Provider.paymentAlias` es el destino del pago. Sólo se toca este último.

## 3. Decisiones tomadas

| Decisión | Elegido | Descartado |
|---|---|---|
| Alcance de la terminología | **Sólo `_Proveedores`** | También `_Consorcios`; las cinco hojas |
| Persistencia de varios alias | **Mismo campo, separados por `\|`** | Columna `String[]`; tabla `ProviderAlias` |
| Tope de alias | **3** | Sin tope |
| Alias en el papel | **Todos** | Sólo el primero |
| Oficio | **Catálogo propio (`_Oficios`)** | Texto libre; lista cerrada en el código |
| Dónde se ve el oficio | **Sólo en el panel** | En la planilla imprimible; en la hoja de boletas |
| Matching por alias | **Se elimina** | Comparar contra los tres |

**Por qué `_Consorcios` queda afuera:** su columna A no es una razón social sino un nombre
normalizado (`FRIAS 324`, no `Consorcio de Propietarios Frías 324`), y su columna C mezcla nombres
alternativos con **CUITs alternativos** (`assignmentMatching.ts:96`), que no son un nombre de
fantasía.

**Por qué el mismo campo con `|`:** la convención ya existe en el proyecto y en la propia hoja
(columna C). Evita migración y el dato cargado sigue funcionando sin conversión.

**Por qué se elimina el matching por alias:** es coherente con la decisión de 2026-07-02 de matchear
proveedores **sólo por CUIT**. Un alias corto puede seleccionar al proveedor equivocado, y el daño
(una boleta asignada a quien no es) supera la comodidad.

## 4. Diseño

### 4.1 La hoja `_Proveedores`

Pasa de `A:E` a `A:F`:

| Col | Encabezado nuevo | Encabezado viejo | Campo |
|---|---|---|---|
| A | **RAZÓN SOCIAL** | NOMBRE CANÓNICO | `canonicalName` |
| B | CUIT | CUIT | `cuit` |
| C | **NOMBRE FANTASÍA** | NOMBRES ALTERNATIVOS | `matchNames` |
| D | **ALIAS DE PAGO** | ALIAS | `paymentAlias` |
| E | TIPO | TIPO | `providerType` |
| F | **OFICIO** | — | `oficioId` (por nombre) |

Sólo cambian los rótulos y se agrega la F: **los campos de la base no se renombran**. Renombrar
`canonicalName` o `matchNames` sería un refactor transversal (pipeline, matching, repositorios,
importación Excel) sin beneficio funcional.

**Los encabezados se corrigen solos.** Hoy sólo se escriben cuando la hoja no existe, así que un ALTA
ya creado se quedaría con los viejos. El sync compara `A1:F1` **de `_Proveedores`** con lo esperado y,
si difiere, lo reescribe. Las demás hojas no se tocan. Es idempotente y no puede romper la lectura,
que es por posición y no por nombre de columna.

### 4.2 Alias de pago múltiples

`Provider.paymentAlias` sigue siendo texto y guarda hasta **tres** valores separados por `|`. Cada
valor puede ser un alias o un CBU, indistintamente y sin validar el formato: un CBU se reconoce a
simple vista por sus 22 dígitos.

Una función pura, `parsePaymentAliases(raw): string[]`, parte por `|`, recorta espacios, descarta
vacíos y corta en tres. Si la hoja trae más de tres, **se guardan los primeros tres y el sync lo
avisa** en el reporte: no falla ni descarta la fila.

Dónde aparecen:

| Salida | Formato |
|---|---|
| Columna ALIAS de la hoja de boletas (I) | Los tres en una línea, separados por ` · ` |
| Planilla imprimible, pantalla y PDF | Uno debajo del otro en la celda |
| Modal de boleta, label del proveedor | Sólo el primero |

**El encabezado de la planilla imprimible pasa de "ALIAS CBU" a "ALIAS - CBU"**, en el PDF
(`sheetPdf.ts:11`) y en la tabla en pantalla (`SheetCard.tsx`). El guion refleja que la celda puede
traer un alias o un CBU. La columna sigue midiendo 26mm: los alias se apilan verticalmente, así que
no hay que rebalancear los anchos — las seis columnas siguen sumando los 182mm útiles del A4. Costo
asumido: una fila con tres alias es más alta y entran menos servicios por hoja.

### 4.3 El oficio

**Modelo `Oficio`**, con la misma forma que `Rubro`:

```prisma
model Oficio {
  id          String     @id @default(cuid())
  clientId    String
  name        String
  description String?
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
  client      Client     @relation(fields: [clientId], references: [id], onDelete: Cascade)
  providers   Provider[]

  @@unique([clientId, name])
  @@index([clientId])
}
```

`Provider` gana `oficioId String?` con `onDelete: SetNull`: borrar un oficio del catálogo deja a sus
proveedores sin etiqueta, nunca los borra.

**Hoja `_Oficios`** en el ALTA, con la forma de `_Rubros`: `NOMBRE` y `DESCRIPCIÓN` (opcional).

**Sync:** upsert por `(clientId, name)`, sin borrado, igual que el resto desde el fix de hoy. Si la
columna F de un proveedor menciona un oficio que no está en el catálogo, se **avisa en el reporte y
el proveedor queda sin oficio** — mismo patrón que un `LspService` cuyo consorcio no existe. No
bloquea: un dato de catalogación no puede impedir que se cargue un proveedor.

El orden importa: los oficios se sincronizan **antes** que los proveedores, porque la columna F
necesita resolver el nombre a un `id`.

**Dónde se ve:** en el panel, junto al nombre del proveedor, al estilo del `[EMPLEADO]` actual. No va
a la planilla imprimible ni a la hoja de boletas.

### 4.4 Se elimina el matching por alias

En `match.ts:41` la UI intenta reconocer al proveedor de una boleta escaneada comparando el nombre
extraído contra `canonicalName` **o** `paymentAlias`. Se elimina la segunda mitad de esa condición.
Quedan el match por CUIT y por razón social exacta.

El pipeline no se toca: `assignmentMatching.ts` nunca usó `paymentAlias` para matchear, sólo lo
transporta como dato para escribirlo en Sheets.

## 5. Testing

- `parsePaymentAliases`: uno solo, tres, más de tres (corta y no rompe), celda vacía, espacios
  alrededor de los separadores, separadores consecutivos.
- Encabezados: se reescriben cuando difieren; **no** se escriben cuando ya coinciden.
- El plan del sync: `_Oficios` se comporta como las demás entidades (upsert por nombre, sobrantes
  reportados, nunca borrados).
- Un proveedor con un oficio que no existe en el catálogo produce aviso y se guarda con `oficioId`
  en null.
- Las tres salidas del alias (celda de Sheets, celda de la planilla, label del modal) con uno y con
  tres alias.
- Regresión: un texto escaneado que coincide con un alias **ya no** selecciona al proveedor.

**Verificación completa:** `npm run typecheck` + `npm run lint` + `npx vitest run` + `npm run build` +
`npm run build:jobs`.

## 6. Fuera de alcance

- **Renombrar los campos de la base** (`canonicalName`, `matchNames`). Refactor transversal sin
  beneficio funcional; los rótulos de la hoja alcanzan.
- **Terminología de `_Consorcios`, `_Rubros`, `_Coeficientes` y `_LspServices`.**
- **El oficio en la planilla imprimible o en la hoja de boletas.** La columna TÉCNICO O GESTOR sigue
  vacía.
- **ABM de oficios desde el panel.** Se cargan por el ALTA, como rubros y coeficientes.
- **Selector de oficio en el modal de alta de proveedor**, que hoy tampoco tiene tipo.
- **Validar que un valor sea alias o CBU.** Se acepta cualquier texto.

## 7. Pendiente del owner

1. Correr la migración (`migrate deploy` + `generate`).
2. Crear la hoja `_Oficios` — la crea el propio sync en la primera corrida — y cargar los oficios.
3. Completar la columna F de `_Proveedores` con oficios que existan en ese catálogo.
4. Cargar los alias adicionales en la columna D separados por `|`, hasta tres por proveedor.
