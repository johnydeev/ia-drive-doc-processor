# Spec — Sync de directorio: dejar de destruir datos y sacarlo del timeout

**Fecha:** 2026-08-17
**Tipo:** Fix estructural (backend + un modal de confirmación en la UI).
**Sin migración.** No toca el pipeline de procesamiento.
**Origen:** el renombre de FRIAS 320 → FRIAS 324, que obligó a un runbook manual de SQL porque
cambiar el nombre en el ALTA habría borrado el historial del edificio.

---

## 1. Problema

`src/app/api/client/sync-directory/route.ts` (~350 líneas, **sin un solo test**) tiene tres defectos
que comparten una misma causa: el sync trata al archivo ALTA como la fuente de verdad de todo, y no
sólo del directorio.

### 1.1 El borrado de huérfanos es silencioso y destructivo

El endpoint borra los consorcios y proveedores que están en la base pero no en la hoja, envuelto en
un `try/catch` que promete este aviso:

> "N consorcio(s) no pudieron eliminarse porque tienen boletas asociadas. Eliminalos manualmente
> desde el panel."

Ese mensaje **nunca puede aparecer**. Todas las relaciones hijas de `Consortium` son
`onDelete: Cascade` — `Period`, `FixedExpense`, `ExpenseObligation`, `LspService`,
`ConsortiumProvider`, `Receipt` — así que el `deleteMany` no lanza ninguna excepción: Postgres borra
en cascada y devuelve éxito. `Invoice` es `SetNull`, de modo que las boletas sobreviven huérfanas,
con `consortiumId` y `periodId` en null. `Provider` tiene el mismo agujero (`Receipt`,
`ConsortiumProvider`, `FixedExpense` en `Cascade`) y el mismo `catch` inútil.

En el caso FRIAS, sincronizar con el nombre cambiado se habría llevado **6 períodos** y habría dejado
**37 boletas** sin edificio, sin ningún error visible.

Dos agravantes:

- **El panel no tiene borrado.** `/api/client/consortiums/[id]/route.ts` sólo expone `GET` y `PATCH`.
  El mensaje remite a una función que no existe.
- **La UI descarta los `warnings`.** `useScheduler.ts:65` muestra sólo los contadores en el toast.
  Aunque el backend los devuelva, nadie los ve.

### 1.2 El reemplazo total desvincula boletas

`Rubro`, `Coeficiente` y `LspService` se sincronizan con `deleteMany` + `createMany`. Los registros
recreados son idénticos en contenido pero tienen `id` nuevo, y todo lo que apuntaba al `id` viejo
queda colgado.

Medido en producción: **1054 boletas, 70 de empresas de servicios** (Edesur 26, Metrogas 21, AySA 18,
Edenor 5) y **ninguna con `lspServiceId`**. El pipeline sí persiste ese campo
(`processPendingDocuments.job.ts:1244` → `invoice.repository.ts:184`), así que la explicación
dominante es el barrido de cada sync.

Sin `lspServiceId` se pierde a qué cuenta pertenece la boleta. FRIAS tiene dos servicios de Edesur
(1061158 y 1061133 / GITMAN MOISES): una boleta desvinculada ya no distingue el medidor del edificio
del local.

Lo mismo explica que no haya ningún `FixedExpense` apuntando a un `LspService`: cuelgan con
`Cascade` y se van con el borrado.

### 1.3 El sync roza el timeout del túnel

Corrida real (46 consorcios, 176 proveedores, 59 servicios):

| Etapa | Tiempo |
|---|---|
| Rubros (0) | 1,2 s |
| Coeficientes (0) | 1,2 s |
| Consorcios (46) | 23,9 s |
| **Proveedores (176)** | **84,7 s** |
| LspServices (59, `createMany`) | 2,9 s |
| **Total** | **119,9 s** |

Son **~500 ms por registro**. Los `Promise.all` de `tx.update` no paralelizan: dentro de una
transacción interactiva de Prisma todas las queries van por la misma conexión, así que son N
round-trips en serie contra el pooler. El contraste está en los LspServices, que con `createMany`
hacen 59 registros en 2,9 s.

El túnel de Cloudflare corta a los 100 s. Es la misma clase de incidente que `close-all` (2026-07-12)
y `bulk-move-period` (2026-07-13).

---

## 2. Principio de diseño

> **El ALTA manda sobre el directorio, no sobre los datos operativos.**

La hoja define qué edificios, proveedores, rubros, coeficientes y servicios existen. No tiene
autoridad para destruir boletas, períodos, obligaciones ni vínculos: eso lo produce la operación
diaria y no está representado en la hoja. Una fila que desaparece del ALTA es información
incompleta, no una orden de baja.

---

## 3. Decisiones tomadas

| Decisión | Elegido | Descartado |
|---|---|---|
| Huérfanos | **Nunca borrar, sólo reportar** | Borrar si está vacío; borrar con preview |
| Camino de baja | **Ninguno nuevo por ahora** | `DELETE` con preview en el panel; campo `archived` |
| Rendimiento | **Diff en memoria + un solo `UPDATE ... FROM (VALUES ...)`** | Sólo diff; sólo update masivo |
| Renombre | **Detección por CUIT, aplicada con confirmación en la UI** | Aplicarlo automático; sólo reportarlo; no hacer nada |

La baja real de un edificio queda fuera de alcance a propósito: un consorcio que se va de la
administración conserva su historial para rendiciones y auditoría, y las bajas verdaderas son raras.

---

## 4. Diseño

### 4.1 Comportamiento por tabla

Las cinco entidades pasan a **upsert por clave natural, sin borrado**. Todas las claves ya existen
como `@@unique` en el schema.

| Entidad | Clave natural | Hoy | Después |
|---|---|---|---|
| `Consortium` | `(clientId, canonicalName)` | upsert + borra huérfanos | upsert; sobrantes al reporte |
| `Provider` | `(clientId, canonicalName)` | igual | igual |
| `Rubro` | `(clientId, name)` | borra todo y recrea | upsert; conserva el `id` |
| `Coeficiente` | `(clientId, code)` | borra todo y recrea | upsert; conserva el `id` |
| `LspService` | `(consortiumId, providerName, clientNumber)` | borra todo y recrea | upsert; conserva el `id` |

**Conservar el `id` es lo que arregla §1.2.** Si el registro no se destruye, nada queda apuntando al
vacío.

### 4.2 El reporte

Reemplaza al `warnings[]` actual. Por entidad: cuántas se crearon, cuántas se actualizaron, y la
lista de las que están en la base y no en la hoja. Para consorcios y proveedores, cada sobrante trae
cuántas boletas tiene colgando, obtenidas con **un solo `COUNT` agrupado**, no una query por
registro.

Así el aviso dice `FRIAS 320 — 37 boletas` en vez de un número pelado.

La UI deja de descartar esta información: se muestra en un modal, no en el toast.

### 4.3 Renombre por CUIT con confirmación

Aplica **sólo a `Consortium` y `Provider`**, las dos entidades que tienen CUIT. Rubros,
coeficientes y servicios no lo tienen: ahí un nombre cambiado es un alta más y el registro viejo cae
en la lista de sobrantes.

**Detección.** Una fila del ALTA es candidata a renombre cuando cumple las tres guardas:

1. su `canonicalName` no existe en la base;
2. su CUIT no está vacío y coincide con **exactamente un** registro existente;
3. ese registro **no aparece por nombre** en ninguna otra fila de la hoja.

Si el CUIT matchea a más de uno, o el registro ya está representado por otra fila, no es renombre: se
reporta como ambiguo y no se toca nada.

**Paso 1 — el sync.** Aplica todo lo inocuo: altas, actualizaciones de CUIT y alias, upserts de
rubros, coeficientes y servicios. Los candidatos a renombre quedan **en suspenso**: no se renombra
nada y **tampoco se crea el registro nuevo**, porque crearlo es lo que produce el duplicado. La
respuesta trae la lista de candidatos.

**Paso 2 — la confirmación.** Si la lista viene vacía, el sync termina como siempre. Si trae
candidatos, se abre un modal con una fila por renombre: `FRIAS 320 → FRIAS 324`, el CUIT que los
emparejó, y cuántas boletas y períodos tiene el registro afectado. Cada fila con su checkbox; el
botón dice **"Aplicar N renombres"** con el número explícito. Cancelar no aplica ninguno.

**Paso 3 — la aplicación.** Un endpoint aparte recibe la lista exacta de `{ id, nuevoNombre }` y no
vuelve a deducir nada de la hoja: es idempotente y no puede aplicar nada que no se haya visto en
pantalla. Actualiza `canonicalName` y `rawName`, y **agrega el nombre viejo a `matchNames` si no
estaba**, para que las boletas que traigan impreso el nombre anterior sigan matcheando.

**Si se cancela**, no pasa nada y el próximo sync vuelve a preguntar. Para forzar un alta nueva en
lugar de un renombre, se cambia el CUIT en la hoja: dos consorcios distintos no comparten CUIT.

### 4.4 Rendimiento

**Diff.** Antes de escribir, el plan compara fila del ALTA contra fila de la base campo por campo
(`cuit` ya normalizado con `formatCuit`, `matchNames`, `paymentAlias`, `providerType`). Lo idéntico
se descarta. En un sync de rutina, donde nadie tocó la hoja, el resultado es **cero updates**.

**Escritura.** Lo que cambió se aplica con un único `UPDATE ... FROM (VALUES ...)` por entidad. Un
camino solo, no dos: mantener updates individuales para los casos chicos dejaría el timeout vivo
para el día que se editen 176 filas de golpe.

El SQL va encapsulado en `bulkUpdate(tx, tabla, filas, columnas)`, construido con
`Prisma.sql`/`Prisma.join` — parametrizado, nunca concatenando valores.

**Altas:** siguen con `createMany`, que ya era el camino rápido.

**Números esperados.** El techo pasa a ser la lectura del ALTA en Sheets (~6 s de los 120 medidos).
El costo deja de depender de la cantidad de filas. Los `console.log` con milisegundos por etapa se
mantienen: son los que dieron el diagnóstico.

### 4.5 Estructura y errores

**Piezas nuevas:**

| Archivo | Responsabilidad |
|---|---|
| `src/lib/directorySyncPlan.ts` | Tier 0, puro. Lectura del ALTA + foto de la base → plan: altas, cambios reales, candidatos a renombre, sobrantes, ambiguos. Sin Prisma, sin red |
| `src/lib/bulkUpdate.ts` | Helper del `UPDATE ... FROM (VALUES ...)` parametrizado |
| `src/services/directorySync.service.ts` | Lee la foto, pide el plan, lo aplica, arma el reporte |
| `src/app/api/client/sync-directory/renames/route.ts` | `POST` con la lista confirmada |
| `consortiums/hooks/` + `components/` | Hook y modal del reporte y la confirmación |

`sync-directory/route.ts` queda fino.

**Errores.** Cada entidad sigue en su propia transacción: si falla la de proveedores, rubros y
coeficientes ya quedaron aplicados y el reporte lo dice. Abortar todo sería peor — el sync es
idempotente, así que reintentar siempre es seguro, y esa propiedad es la que cubre si algún día
vuelve a rozar el timeout.

El endpoint de renombres valida que cada `id` sea del cliente, responde 409 si el nombre destino ya
existe, y es no-op si el registro ya tiene ese nombre.

---

## 5. Testing

Hoy hay **cero tests** sobre estas ~350 líneas que borran datos.

**Sobre el plan (`directorySyncPlan.test.ts`, tier 0):**

- hoja idéntica a la base → cero updates;
- un campo cambiado → exactamente un update, y sólo el de esa fila;
- alta nueva;
- sobrante → se reporta y **no** se borra;
- renombre por CUIT: caso feliz, y las tres guardas por separado (CUIT vacío, CUIT que matchea a dos,
  registro ya representado por otra fila);
- **regresión de §1.2:** el upsert de `LspService` conserva el `id`.

**Sobre `bulkUpdate`:** el SQL y los parámetros que genera.

**Rutas:** la nueva entra en `src/app/api/routeAuthGuard.test.ts`.

**UI:** hook (tier 1) y modal (tier 2), incluyendo que Cancelar no dispara ninguna llamada y que el
botón es `AsyncButton` con spinner y guard anti doble-click.

**Verificación completa:** `npm run typecheck` + `npm run lint` + `npx vitest run` + `npm run build` +
`npm run build:jobs`.

---

## 6. Fuera de alcance

- **`DELETE` de consorcios y proveedores en el panel.** Decisión explícita: las bajas reales son
  raras y hoy se resuelven por SQL.
- **Campo `archived`.** Requeriría migración y tocar todas las queries que listan edificios.
- **`SERVICIO` en `ProviderType`.** Idea validada, spec propio a continuación de este: la hoja
  `_Proveedores` ya tiene la columna E "TIPO" y `googleSheets.service.ts:428` la parsea, así que es
  un valor más del enum. Sirve para filtrar la UI, validar que un `LspService` apunte a un proveedor
  de servicio y darle rumbo al bloque que hoy rellena `providerId` a ciegas. **No** habría evitado
  ninguno de los 70 nulls: el vínculo boleta → `LspService` se resuelve por el número de cliente que
  extrae el pipeline, no por el catálogo.
- **Re-vincular las 70 boletas ya desvinculadas.** El arreglo detiene la sangría pero no repara lo
  perdido. `Invoice` no guarda el número de cliente, así que el proveedor solo no alcanza para saber
  a cuál de los dos servicios de Edesur pertenece cada boleta; el dato está en la columna J de la
  hoja Datos y en el PDF. Script propio, con su propia decisión.

---

## 7. Impacto esperado

- El sync deja de poder destruir historial. El caso FRIAS se resolvería con dos clicks en vez de un
  runbook de SQL.
- Las boletas de servicios dejan de perder su vínculo en cada sincronización.
- El sync baja de ~120 s a segundos, y sale de la zona del 524.
- El endpoint más destructivo del sistema pasa de cero tests a tener su lógica en una función pura
  con red de regresión.
