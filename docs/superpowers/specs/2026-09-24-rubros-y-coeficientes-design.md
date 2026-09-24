# Rubros y coeficientes: darles vida

**Fecha:** 2026-09-24
**Estado:** spec aprobado, sin implementar
**Evidencia:** 20 liquidaciones de expensas de agosto 2026 (MorinigoAdm), analizadas con `pdf-parse`

---

## El problema

`Rubro` e `Invoice.rubroId` existen en el schema desde el principio. `Coeficiente` e
`Invoice.coeficienteId`, también. Los dos catálogos se cargan desde el archivo ALTA y los dos campos
de `Invoice` se pueden elegir a mano en [InvoiceModal.tsx:142](../../../src/app/admin/consortiums/components/InvoiceModal.tsx#L142)
al cargar una boleta manualmente.

Nada más. Las boletas que entran por el pipeline —que son casi todas— nacen con `rubroId` y
`coeficienteId` en `null`, y ninguna vista los usa para nada. El pendiente estaba anotado en
`CLAUDE.md` como "UI para asignar Rubro y Coeficiente a invoices individuales desde el panel
(Stage 2)".

Rubro y coeficiente son las dos coordenadas con las que el administrador arma la liquidación mensual.
Sin ellas, la hoja de obligaciones es una lista de pagos; con ellas, es el borrador de la liquidación.

## Qué dicen los papeles

### El rubro es el eje vertical

Cada liquidación divide los gastos en secciones numeradas, en el mismo orden en los 20 edificios:

| # | Rubro | # | Rubro |
|---|---|---|---|
| 1 | Detalle / Extras sueldo | 7 | Gastos bancarios |
| 2 | Aportes y contribuciones | 8 | Gastos de limpieza |
| 3 | Servicios públicos | 9 | Gastos de administración |
| 4 | Abonos de servicios | 10 | Pagos del período por seguros |
| 5 | Mantenimiento de partes comunes | 11 | Otros |
| 6 | Trabajo de reparaciones en unidades | | |

**Un edificio sólo tiene los rubros que le corresponden.** Bonifacio 720 no tiene empleado propio, así
que su liquidación no tiene rubro 1: arranca en el 2 y sigue con los números del catálogo, sin
renumerar. Corrientes 4815 junta el 1 y el 2 en una sola sección. Los rótulos varían levemente
(`DETALLE SUELDO` vs `EXTRAS SUELDO`, mayúsculas y minúsculas): es texto del catálogo del
administrador, no una constante del sistema.

### El coeficiente es el eje horizontal

Dentro de cada rubro, el importe de cada gasto se escribe en la columna del coeficiente que le
corresponde: `Gasto A`, `Gasto B`, `Gasto C`. En el prorrateo esas columnas reaparecen como
`GASTOS A / GASTOS B / GASTOS C`, cada una con **un porcentaje distinto por unidad funcional**
(Callao 1441: `0,604%`; Garay 350: `2,690%`). El total de la columna se reparte entre las unidades
según ese porcentaje.

Cuántas columnas hay depende del edificio: Araoz 192 usa A y B; Callao 1441, Garay 350 y Mitre 1225
usan A, B y C; varios edificios tienen B siempre en `0,000%`.

### El coeficiente es del gasto, no del proveedor

Araoz 192, rubro 3:

```
Edesur C: 01048046                          406.582,47  → A
Metrogas Consorcio C: 10971798300 Caldera 1.154.742,45  → B
Metrogas Consorcio C: 1097199100 Porteria    58.550,40  → A
```

Mismo proveedor, dos cuentas, dos coeficientes (`406.582,47 + 58.550,40 = 465.132,87`, el total de la
columna A). Lo mismo en el rubro 6: la reparación del 8A va a A y la del 1B a B, porque las paga la
unidad. El rubro sí es estable por proveedor —Edesur siempre 3, ascensores 4, honorarios 9, Mapfre
10—, pero el coeficiente hay que mirarlo gasto por gasto.

De ahí sale la decisión central: **la unidad que lleva la etiqueta es el gasto fijo, no el
proveedor.** El padrón de `FixedExpense` ya tiene la granularidad correcta: un gasto fijo por cuenta
LSP (Metrogas caldera y Metrogas portería son dos `LspService`, así que son dos gastos fijos) y uno
por proveedor fijo del edificio.

## Las tres capas

```
1. Catálogo del cliente       Rubro, Coeficiente                       (ya existen)
2. Qué usa cada edificio      ConsortiumRubro, ConsortiumCoeficiente   (tablas nuevas)
3. Qué lleva el gasto fijo    FixedExpense.rubroId, .coeficienteId     (columnas nuevas)
      ↓ el pipeline copia al vincular la obligación
   Qué lleva la boleta        Invoice.rubroId, .coeficienteId          (ya existen)
```

El administrador carga una vez su lista de rubros y coeficientes (capa 1), le asigna a cada edificio
los que usa (capa 2) y etiqueta los gastos fijos de ese edificio con lo que le asignó (capa 3). Cada
capa sólo ofrece lo que la anterior habilitó.

## Modelo de datos

### Capa 1 — catálogo del cliente

`Rubro` suma **`order Int?`**: el número con el que se muestra y ordena (`3 SERVICIOS PÚBLICOS`).
Nullable, sin `unique`: dos rubros con el mismo número son un error de carga que el ABM avisa pero no
bloquea, y bloquearlo en la base haría chocar cualquier reordenamiento a mitad de camino. Los rubros
sin número van al final, alfabéticos.

> El sync del ALTA no pisa este campo: `directorySync.service.ts` actualiza de `Rubro` únicamente la
> columna `description` (`applyUpdates(tx, "Rubro", [{ name: "description" }], …)`). No hay que tocar
> la hoja `_Rubros` ni el plan de sincronización.

`Coeficiente` no cambia de columnas — sólo suma las relaciones inversas de Prisma hacia
`ConsortiumCoeficiente` y `FixedExpense`, que no tocan el SQL. Su campo `value Decimal?` queda sin
usar en esta feature: el porcentaje real es por unidad funcional, y eso es prorrateo — fuera de
alcance.

### Capa 2 — qué usa cada edificio

```prisma
model ConsortiumRubro {
  id           String     @id @default(cuid())
  consortiumId String
  rubroId      String
  consortium   Consortium @relation(fields: [consortiumId], references: [id], onDelete: Cascade)
  rubro        Rubro      @relation(fields: [rubroId], references: [id], onDelete: Cascade)

  @@unique([consortiumId, rubroId])
  @@index([consortiumId])
}

model ConsortiumCoeficiente {
  id            String      @id @default(cuid())
  consortiumId  String
  coeficienteId String
  consortium    Consortium  @relation(fields: [consortiumId], references: [id], onDelete: Cascade)
  coeficiente   Coeficiente @relation(fields: [coeficienteId], references: [id], onDelete: Cascade)

  @@unique([consortiumId, coeficienteId])
  @@index([consortiumId])
}
```

Tablas de unión puras, sin campos propios. El orden de los rubros sale de `Rubro.order`; el de las
columnas, del `Coeficiente.code`. `Cascade` en las dos puntas: sacar un rubro del catálogo lo saca de
los edificios que lo tenían.

### Capa 3 — qué lleva el gasto fijo

`FixedExpense` suma `rubroId String?` y `coeficienteId String?`, ambos `onDelete: SetNull`: borrar un
rubro del catálogo deja los gastos fijos sin etiqueta, no los borra.

### La boleta

`Invoice.rubroId` y `Invoice.coeficienteId` no cambian. El pipeline los completa copiando los del
gasto fijo; quedan editables por boleta.

### Migración

Una sola, `prisma/migrations/YYYYMMDDNNNNNN_rubros_y_coeficientes_por_edificio/migration.sql`:

1. `ALTER TABLE "Rubro" ADD COLUMN "order" INTEGER;`
2. `CREATE TABLE "ConsortiumRubro"` + sus índices y FKs.
3. `CREATE TABLE "ConsortiumCoeficiente"` + sus índices y FKs.
4. `ALTER TABLE "FixedExpense" ADD COLUMN "rubroId" TEXT, ADD COLUMN "coeficienteId" TEXT;` + FKs
   `ON DELETE SET NULL`.

Todo aditivo y nullable: la aplicación vieja sigue funcionando contra el schema nuevo.
**La ejecuta el owner**, según las reglas de migraciones de `CLAUDE.md`.

## Cómo se asigna

### El pipeline copia, no adivina

[`linkInvoiceToObligation`](../../../src/services/obligation.service.ts#L81) ya trae el `fixedExpense`
de la obligación que vincula. Se suman `rubroId` y `coeficienteId` a ese `select` y se escriben en la
`Invoice` en el mismo paso en que la obligación pasa a `RECEIVED`. Cero requests de IA, cero
heurística: si el gasto fijo está etiquetado, la boleta nace etiquetada; si no, nace vacía.

El mismo copiado va en los otros dos lugares que vinculan boleta y obligación:

- `syncObligationsForClient` (`obligation.service.ts`), que hace el vínculo retroactivo.
- `invoicePeriodMove.ts:220`, cuando una boleta se empuja al mes siguiente.

### Boletas eventuales

Una boleta sin gasto fijo que la cubra (un plomero de una vez, un ticket) entra **sin rubro y sin
coeficiente**. No se infiere nada: en Araoz las dos reparaciones del rubro 6 tienen coeficientes
distintos porque las paga cada unidad, y eso no hay regla que lo sepa. Se etiquetan a mano en la hoja,
con el mismo control que las demás.

En los papeles analizados, las eventuales caen casi siempre en el rubro 5 (mantenimiento de partes
comunes) y el 6 (reparaciones en unidades). Es una observación, no una restricción: todas las filas
son editables.

### Editar es corregir y también fijar

Editar el rubro o el coeficiente de una fila **escribe dos cosas**: la boleta de ese mes y el gasto
fijo. Las boletas de los meses anteriores no se tocan (la liquidación ya emitida queda como se
emitió) y las de los meses siguientes ya nacen con el valor nuevo. Queda así hasta que se vuelva a
modificar.

Una fila sin gasto fijo (eventual) sólo escribe la boleta: no hay regla que fijar.

### Dónde se carga cada capa

| Capa | Lugar | Forma |
|---|---|---|
| Catálogo del cliente | Sidebar del panel, junto a **Bancos** | ABM de Rubros (nombre + número) y Coeficientes (código + nombre) |
| Qué usa el edificio | Modal de Configuración del consorcio, bajo "Banco y cuenta" | Dos listas de casillas contra el catálogo |
| Qué lleva el gasto fijo | Hoja de Obligaciones, control en la fila | Selector acotado a lo asignado al edificio |

El server valida la cadena en cada escritura: un gasto fijo no acepta un rubro o coeficiente que el
edificio no tenga asignado, y un edificio no acepta uno que no esté en el catálogo del cliente.
Al desasignar un rubro de un edificio que tiene gastos fijos usándolo, el endpoint responde cuántos
quedarán sin etiqueta y pide confirmación — el mismo patrón que hoy usa el borrado de un banco.

## La hoja de obligaciones

### Estructura nueva

```
BANCO: CIUDAD
BARTOLOME MITRE 1225                                       Septiembre 2026

                                                 COEFICIENTE
  FACTURA/NRO CLIENTE   PROVEEDOR/SERVICIO         A        B       C     ALIAS - CBU  …

  3 SERVICIOS PÚBLICOS
   3540951              AYSA S.A.            1.311.117,83
   86813706             EDESUR S.A.            835.312,50
                        TOTAL RUBRO 3        2.146.430,33     0,00    0,00

  4 ABONOS DE SERVICIOS
   …
```

- **El rubro manda el orden.** El orden actual por tipo de proveedor (`GROUP_RANK`: empleados →
  servicios → proveedores) se elimina: el rubro ya hace esa separación, y mejor. Los rubros aparecen
  por `Rubro.order`, sólo los que el edificio tiene asignados.
- **Todos los rubros asignados se muestran**, tengan boletas o no, con su total en cero. Es el
  checklist del mes.
- **Dentro de cada rubro**: las filas con boleta arriba, las `PENDING` debajo, las salteadas y las
  desactivadas al final. Alfabético dentro de cada tramo.
- **`MONTO` desaparece** y se reparte en una columna por coeficiente del edificio. Encabezado de dos
  niveles: una celda `COEFICIENTE` abarcando A / B / C.
- **Total por rubro** en cada columna, más el total general del edificio al pie.
- Una fila `PENDING` no tiene importe: marca su coeficiente con la celda vacía.

### Qué pasa con los bloques actuales

- **Adicionales** (`↳ 2ª boleta`): siguen colgando de su fila madre, dentro del rubro de la madre.
- **"Otras boletas del mes"**: el bloque desaparece. Las eventuales entran en su rubro junto a los
  gastos fijos —que es donde están en el papel— con una marca visual que las distingue del padrón.
  Las que todavía no tienen rubro caen en el bloque de abajo.
- **`Sin rubro`**: bloque nuevo al final, después del último rubro y antes de "Vienen del mes
  anterior". Junta **todo lo que no tiene rubro**: boletas eventuales sin etiquetar y también gastos
  fijos del padrón que todavía no fueron etiquetados (al principio, los 725). Desaparece cuando está
  vacío.
- **Sin coeficiente, primera columna.** El coeficiente define **en qué columna va el monto**, no el
  orden de la fila. Una fila sin coeficiente asignado muestra su importe en la primera columna del
  edificio (la A) y suma a ese total. Sin columna aparte, sin marcas: por defecto todo cae en A.
- **"Vienen del mes anterior"**: sigue como bloque propio al pie, fuera de los rubros — es deuda
  arrastrada, no un gasto del mes, y en la liquidación no va en ninguna sección. Suma la aclaración
  de qué gasto fijo arrastra.

### Edición inline

Control en la fila: vacío muestra `Rubro` / `Coef`; cargado muestra el valor y lo deja cambiar. Un
click escribe la boleta y el gasto fijo. Los selectores ofrecen sólo lo asignado al edificio.

Botón asíncrono con spinner y `disabled` mientras está en curso, como el resto de la hoja
(`AsyncButton`).

## El PDF del banco

Mismo modelo (`sheetModel`) y mismo agrupado que la pantalla: una sola fuente, lo que se ve es lo que
se imprime.

Pasa de 6 a 8 columnas en los 182 mm útiles del A4. Los 36 mm de `MONTO` se reparten entre las
columnas de coeficiente y hay que recortar `TÉCNICO O GESTOR` y `TEL. CONTACTO` (van en blanco, se
completan a mano). Un edificio con dos coeficientes usa menos ancho que uno con tres: los anchos se
calculan por hoja, no se fijan como constante.

## Carga inicial del padrón

Los ~725 gastos fijos arrancan sin rubro, y las liquidaciones ya dicen a qué rubro pertenece cada uno.
Entregable: **`scripts/seed-rubros.ts`**, con el mapeo *(edificio, proveedor o nro. de cliente) →
rubro* extraído de las liquidaciones como datos literales, revisable en el diff antes de ejecutarlo.
Escribe `rubroId` en los `FixedExpense` que matchea por `providerId` o `lspServiceId`, es idempotente
y **sólo escribe donde no hay nada** (no pisa una corrección del administrador). Reporta los gastos
fijos sin línea en el papel y las líneas del papel sin gasto fijo.

No toca el coeficiente: con más de una columna con monto en el mismo rubro, el texto plano no dice
cuál importe cayó en cuál.

## Fuera de alcance

- **El prorrateo.** Repartir el total de cada columna entre las unidades funcionales según su
  porcentaje. Requiere modelar la unidad funcional y su porcentaje por coeficiente, que hoy no
  existen. Esta feature deja los totales por columna listos para esa etapa.
- **`Coeficiente.value`.** Queda sin usar. El porcentaje es por unidad, no por coeficiente.
- **Etiquetar retroactivamente las boletas ya procesadas.** Se etiquetan a mano desde la hoja; lo que
  se fija hacia adelante es el gasto fijo.
- **Adivinar el rubro por oficio.** El catálogo `Oficio` existe y podría mapear a rubros
  (Ascensorista → 4, Fumigador → 5), pero se descartó: el gasto fijo es más preciso y ya está cargado.
- **La hoja `_Rubros` del ALTA.** No cambia. El número del rubro se carga por panel.

## Testing

Todo lo nuevo que decide algo vive en funciones puras, testeables sin montar nada:

- `sheetModel`: agrupado por rubro, orden dentro del rubro, totales por columna, bloque `Sin rubro`,
  eventuales dentro de su rubro, adicionales bajo su madre. Es donde va el grueso de los tests.
- `sheetPdf`: las mismas secciones en el papel, anchos según cuántos coeficientes tenga el edificio.
- `obligation.service`: que `linkInvoiceToObligation` copie rubro y coeficiente, y que no escriba nada
  cuando el gasto fijo no los tiene.
- Endpoints: que rechacen un rubro o coeficiente ajeno al edificio; que la edición inline escriba la
  boleta y el gasto fijo; que desasignar avise cuántos gastos fijos quedan sin etiqueta.
- `SheetCard`: que el control aparezca vacío o cargado según corresponda, y el pending del botón.

La red de caracterización del pipeline (`processPendingDocuments.job.test.ts`) tiene que correr verde
antes y después.

## Riesgos

- **La hoja se rediseña, no se retoca.** `compareRows` se elimina y `buildSheets` cambia de forma:
  pasa de devolver una lista de filas a devolver secciones. Es el cambio más grande desde que existe
  la vista, y `sheetPdf` lo sigue.
- **El ancho del A4.** Ocho columnas en 182 mm es apretado. Si no entra, la salida es recortar
  `TÉCNICO O GESTOR` y `TEL. CONTACTO` a lo mínimo o pasarlas a una línea propia.
- **La calidad del mapeo inicial.** El script de carga sale de leer las liquidaciones, y ahí el
  nombre del proveedor es texto libre escrito por la administración (`Cimex Control de plagas`,
  `myn: fact:245`, `GCN_CERR.AR`). Matchear eso contra el padrón va a fallar en una porción de los
  casos. Por eso el script reporta las dos listas de no-matcheados en vez de adivinar, y por eso no
  toca lo que ya tiene valor.
- **El coeficiente sigue siendo trabajo manual.** El script carga rubros; los coeficientes se
  etiquetan desde la hoja, uno por gasto fijo. Es menos volumen (una vez por gasto fijo, no por mes)
  pero es el trabajo que queda.
