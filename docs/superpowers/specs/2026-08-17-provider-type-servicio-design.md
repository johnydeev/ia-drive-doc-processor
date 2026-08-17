# Spec — `SERVICIO` en `ProviderType`

**Fecha:** 2026-08-17
**Tipo:** Modelo + parseo + validación. **Sin cambios de UI.**
**Requiere migración** (dos, ver §4.1). No toca el pipeline de procesamiento.
**Estado de partida:** el sync de directorio sin borrado ya implementado y verificado (627 tests).

---

## 1. Problema

`ProviderType` tiene hoy dos valores: `PROVEEDOR` y `EMPLEADO`. No hay forma de decir que un
proveedor es una **empresa de servicios** (Edesur, AySA, Metrogas, Naturgy, Camuzzi, Litoral Gas,
Edenor, Personal), que es una categoría con reglas propias en todo el resto del sistema: prompts
específicos por empresa, extracción limitada a la primera página, y servicios (`LspService`) con
número de cliente por consorcio.

Consecuencias concretas:

- **El catálogo no sabe qué es cada proveedor.** Un `LspService` puede apuntar a cualquier `Provider`
  sin que nada lo cuestione.
- **El bloque que rellena `providerId` en servicios históricos trabaja a ciegas**, buscando por nombre
  contra todo el catálogo.
- La gestión de `LspService` desde el panel, que figura como pendiente, no tendría contra qué filtrar
  el selector de proveedor.

## 2. Qué NO resuelve

**No habría evitado las 70 boletas desvinculadas** del fix anterior. El vínculo boleta → `LspService`
lo resuelve el pipeline por el número de cliente que extrae del PDF, no por el catálogo. Aquel
problema se arregló conservando el `id` en el upsert.

Tampoco cambia cómo el pipeline detecta que una boleta es de una empresa de servicios: eso lo hace
`identifyLSPProvider()` sobre el texto del PDF.

## 3. Decisiones tomadas

| Decisión | Elegido | Descartado |
|---|---|---|
| Alcance | **Dato + validación en el sync** | Sólo el dato; dato + validación + UI |
| Forma | **Tercer valor del enum** | `isService` booleano en paralelo |
| Fuente de verdad | **La hoja ALTA, columna E** | Derivarlo de si tiene servicios; celda vacía que no pisa |

**Por qué un valor del enum y no un booleano:** un `isService` junto a `providerType` crea dos fuentes
que pueden contradecirse (un `EMPLEADO` marcado como servicio). Las tres categorías son excluyentes.

**Por qué la hoja manda:** es el principio que se estableció el mismo día para el sync de directorio —
el ALTA es la fuente de verdad del directorio. Derivar el tipo de la existencia de `LspService`
introduciría un campo que la hoja no controla y volvería la validación redundante: nunca podría
fallar.

**Consecuencia asumida:** el owner tiene que escribir `SERVICIO` en la columna E de esos proveedores.
Si no lo hace, el próximo sync los devuelve a `PROVEEDOR` y la validación empieza a avisar. Es el
comportamiento correcto, no un efecto colateral.

## 4. Diseño

### 4.1 Modelo — dos migraciones, no una

`enum ProviderType` suma `SERVICIO`.

Van **dos carpetas de migración separadas**. Postgres no permite usar un valor de enum dentro de la
misma transacción que lo agregó (`unsafe use of new value of enum type`), y Prisma corre cada
migración en una transacción:

1. `..._provider_type_servicio` — sólo el `ALTER TYPE "ProviderType" ADD VALUE 'SERVICIO';`
2. `..._backfill_provider_type_servicio` — el backfill:

```sql
UPDATE "Provider" SET "providerType" = 'SERVICIO'
WHERE id IN (SELECT DISTINCT "providerId" FROM "LspService" WHERE "providerId" IS NOT NULL);
```

El backfill deja el estado correcto desde el arranque, sin depender de que la hoja se actualice
primero.

### 4.2 Parseo

Hoy la columna E se parsea inline en `readDirectory` con un ternario
(`googleSheets.service.ts:428`), sin tests:

```ts
providerType: providerTypeRaw === "EMPLEADO" ? "EMPLEADO" : "PROVEEDOR"
```

Se extrae a una función pura `parseProviderType(raw)` para poder cubrir los cuatro casos:
`"SERVICIO"`, `"EMPLEADO"`, celda vacía y texto no reconocido. Los dos últimos caen a `PROVEEDOR`,
igual que hoy.

### 4.3 Validación

En `directorySync.service.ts`, donde se arma la lista de servicios: si el `LspService` resuelve a un
`Provider` cuyo `providerType` no es `SERVICIO`, se agrega un aviso al reporte del sync.

**No bloquea.** El servicio se crea o actualiza igual: el vínculo con la boleta no depende del tipo,
y bloquearlo dejaría servicios sin cargar por un dato de catalogación.

Un `LspService` sin `providerId` resuelto (el proveedor no está en el catálogo) ya tiene su propio
camino y no cambia.

### 4.4 Que el valor nuevo no rompa lo existente

Los consumidores actuales preguntan por `EMPLEADO`, así que `SERVICIO` cae en la rama de proveedor
común, que es lo correcto:

| Lugar | Comportamiento con `SERVICIO` |
|---|---|
| `PagosView` (4 comparaciones) | Pago parcial y saldo, como cualquier proveedor |
| `InvoiceModal` | Etiqueta "CUIT emisor", no "CUIL"; sin badge `[EMPLEADO]` |

Correcto por omisión, pero se cubre con tests para dejarlo fijado.

**Tipos a actualizar** o el typecheck los marca: dos uniones escritas a mano en
`consortiums/lib/types.ts`, la de `DirectoryData` en `googleSheets.service.ts:131`, y el cast de
`directorySync.service.ts:126`.

## 5. Testing

- `parseProviderType`: los cuatro casos, incluido que basura y vacío caen a `PROVEEDOR`.
- Validación del sync: un servicio que apunta a un proveedor `PROVEEDOR` produce el aviso; uno que
  apunta a un `SERVICIO` no produce ninguno; en ningún caso se deja de crear el servicio.
- Regresión de `PagosView`: una boleta de un proveedor `SERVICIO` se comporta como `PROVEEDOR` y no
  como `EMPLEADO`.

**Verificación completa:** `npm run typecheck` + `npm run lint` + `npx vitest run` + `npm run build` +
`npm run build:jobs`.

## 6. Fuera de alcance

- **Selector de tipo en el modal de alta de proveedor.** Hoy ese modal tiene sólo razón social, CUIT
  y alias, así que todo lo creado desde el panel nace `PROVEEDOR`. Queda como estaba.
- **Badge `[SERVICIO]` en las listas**, al estilo del `[EMPLEADO]` actual.
- **Gestión de `LspService` desde el panel**, que es el consumidor natural del filtrado. Sigue
  pendiente y con spec propio.
- **Columna de tipo en el import de Excel.**

## 7. Pendiente del owner

1. Correr las dos migraciones (`migrate deploy` + `generate`).
2. Escribir `SERVICIO` en la columna E de `_Proveedores` para las empresas de servicios, **antes del
   próximo sync**. Si no, vuelven a `PROVEEDOR` y el reporte empieza a avisarlo.
