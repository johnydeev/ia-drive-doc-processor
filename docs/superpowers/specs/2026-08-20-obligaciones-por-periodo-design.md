# Obligaciones por período: cada mes es una hoja cerrada — diseño

Fecha: 2026-08-20 · Estado: aprobado por el owner, pendiente de implementar

Reemplaza el modelo de arrastre de `2026-08-12-boletas-impagas-arrastre-design.md`.

## Problema

El owner abrió `/admin/obligaciones` y encontró una lista interminable de gastos en cada edificio, sin
haber cargado ninguna obligación. En THAMES 647, un edificio **sin gastos fijos cargados**, aparecían
31 boletas de marzo a julio.

No era un bug. El bloque "IMPAGAS DE MESES ANTERIORES" se alimenta de **boletas**, no de gastos fijos:
lista toda boleta con `isPaid: false` cuyo período ya está cerrado. Y en la base **1124 de 1125
boletas figuran impagas**, porque **los pagos se hacen fuera de la app**: hay un único registro de
pago en todo el sistema (fila 826 de la hoja Datos, `0005-00006020`, $179.249,61 del 05/07).

O sea: el sistema decía la verdad, pero la verdad era inservible. Un bloque que arrastra
automáticamente todo el histórico impago no es seguimiento, es ruido — y tapa lo único que el
administrador necesita ver, que es lo que tiene que pagar **este mes**.

## Modelo nuevo

**Cada mes es una hoja cerrada en sí misma.** Lo único que cruza de un mes a otro es lo que el owner
empujó explícitamente desde el mes de origen.

### 1. La vista es por período, navegable

Se elige un mes calendario y se muestran **todos los edificios que tienen período de ese mes**,
tengan el período activo o cerrado. Un edificio que se adelantó y ya cerró agosto sigue apareciendo
en agosto, marcado como cerrado, con lo que se hizo en ese mes.

Eso es lo que da la libertad de navegar hacia atrás y decidir qué pasa al mes siguiente.

**Un mes cerrado NO es de sólo lectura**: la acción de empujar al mes siguiente tiene que funcionar
ahí, porque es al cerrar cuando el owner sabe qué quedó sin pagar — un dato que tiene él, no la app.

### 1 bis. La app no sabe qué está pagado, y no tiene por qué

**Los pagos se registran fuera de la app** (decisión del owner, 2026-08-20). La página no admite
registro de pagos hasta nuevo aviso.

Lo que sí hace: cuando llega la boleta de un gasto fijo, **muestra el monto a pagar**. Nada más.

Esto tiene una consecuencia directa sobre el traspaso: **no se puede filtrar por "impaga"**, porque
para la app todas lo están. El criterio de qué pasa al mes siguiente es **la decisión del owner**, no
un estado calculado. El botón aplica a cualquier boleta del período.

### 2. Nada se arrastra solo

Se elimina el bloque de impagas de meses anteriores. Un mes muestra:

- los **gastos fijos** de ese período (lo de siempre), y
- lo que **vino empujado** del mes anterior, que hoy sería cero.

Las 1124 boletas históricas que figuraban impagas dejan de mostrarse. No se borra nada: dejan de listarse.

### 3. El traspaso se marca en el origen y se ejecuta por tandas después de cerrar

Botón **"Pasar al mes siguiente"** en cualquier boleta del período, dentro del mes de origen. Al
apretarlo la boleta queda **marcada**, no movida.

El movimiento real (Drive + Sheets + DB) ocurre **después de cerrar el período**, porque recién ahí
existe el período destino. Pero **no ocurre dentro del request del cierre**: lo dispara la UI en
**tandas de 5**, mostrando el avance, igual que la pantalla de Boletas con `useBatchRunner`.

**Por qué en tandas y no todo junto.** Cada traslado toca Drive y Sheets: el paso `move` midió
**1277 ms** en un diagnóstico real, y con la escritura en Sheets cada boleta queda en ~2 s. Con 46
edificios a una boleta cada uno son ~1 min 30 s; a dos, ~3 min. El túnel de Cloudflare corta cada
request a los 100 s — pero ese límite es **por request**, así que partiéndolo en tandas de ~10 s el
total deja de tener techo.

**Por qué secuencial y no en paralelo.** La API de Sheets permite 60 escrituras por minuto. Al ritmo
secuencial van unas 30/min, holgado. Paralelizar bajaría el tiempo a un minuto pero acercaría al
límite de cuota, con rebotes.

**Por qué tandas y no una cola de jobs.** Encolar sobreviviría a cerrar la pestaña, pero exigiría un
tipo de job nuevo en `ProcessingJob` (hoy modela archivos de Drive) y una rama en el worker — el
proceso donde un bug sale más caro. Y el owner **se queda mirando hasta que termina**: quiere que el
cliente vea que el proceso terminó, cosa que la barra de avance da gratis y la cola no. Si algún día
son 200 traslados, encolar pasa a convenir.

**Si el cliente cierra la pestaña igual**, las que faltaban quedan marcadas y la vista del mes muestra
**"quedaron N sin pasar — continuar"**. Nada queda a medias: cada traslado es individual e idempotente
(`moveOneInvoiceToTarget` detecta `ya_en_destino`), así que reintentar es seguro.

El costo es un estado intermedio que hay que mostrar en pantalla y poder deshacer.

### 4. Se puede deshacer

Dos casos, los dos necesarios:

- **Marcada pero todavía no cerrada**: se desmarca y listo.
- **Ya trasladada**: se devuelve al período de origen (Drive, Sheets y base), y la obligación de
  origen deja de estar marcada como pasada.

### 5. Un gasto fijo cuya boleta nunca llegó no se arrastra

Queda vacío en su mes de origen y ahí muere. El gasto fijo ya genera una obligación nueva cada mes,
así que el mes siguiente vuelve a mostrar que falta.

**Fuera de alcance, anotado por el owner:** un botón "Agregar Factura" sobre ese gasto fijo, para
revivirlo **en el mes de origen** y desde ahí pagarlo o pasarlo al siguiente.

### 6. El PDF separa lo arrastrado

El papel del banco incluye las boletas que vinieron del mes anterior, pero **en una sección aparte**
("Vienen del mes anterior"), para distinguir a simple vista qué es del mes y qué viene atrasado.

## Qué se reusa y qué se tira

| Pieza | Qué pasa |
|---|---|
| `Invoice.carriedFromPeriodId` | **Se reusa.** Registra el origen una sola vez |
| `Invoice.lateAmount` (2º vencimiento) | **Se reusa** tal cual |
| `ObligationStatus.CARRIED_OVER` | **Se reusa**: marca el origen cuando el traslado se ejecuta |
| `moveOneInvoiceToTarget` (Drive + Sheets + DB) | **Se reusa**: es el motor del traslado |
| Endpoint `invoices/[id]/carry-over` | **Se invierte**: hoy tira desde el destino; pasa a marcar en el origen |
| Bloque "impagas de meses anteriores" | **Se elimina** de la vista y del `overview` |
| Consulta `unpaid` del overview | **Se elimina**: es la que traía las 1124 |

## Cambios por capa

### Migración

`Invoice` suma la marca del traspaso pendiente:

| Columna | Tipo | Para qué |
|---|---|---|
| `carryOverRequestedAt` | `DateTime?` | Marcada para pasar al mes siguiente; `null` = no marcada. Se limpia al ejecutarse o al desmarcar |

Se usa un timestamp y no un booleano para saber **cuándo** se marcó, que es lo que permite auditar
una corrida de cierre.

### Backend

- **`overview`**: pasa a recibir el mes (`?month=8&year=2026`) en vez de resolver por período activo.
  Devuelve los edificios con período de ese mes —con su estado— y elimina la consulta `unpaid`.
- **`executeCloseAll`**: **no ejecuta traslados**. Sigue haciendo sólo lo suyo —cerrar y crear el
  período siguiente—, que es lo irreversible y tiene que ser rápido y atómico.
- **Endpoint de traslado por tandas**: recibe hasta 5 boletas marcadas y las mueve. Lo llama la UI en
  bucle, mostrando el avance. Es reentrante: se puede volver a llamar con las que faltan.
- **Endpoints nuevos**: marcar / desmarcar el traspaso, y devolver al origen una ya trasladada.

### UI

- **Selector de mes** con navegación adelante/atrás.
- Cada edificio muestra si su período de ese mes está **abierto o cerrado**.
- Botón **"Pasar al mes siguiente"** en las boletas del mes, con su estado "en espera".
- Sección **"Vienen del mes anterior"**, en pantalla y en el PDF.

## Riesgos

- **El traslado depende de que la pestaña siga abierta.** Es el precio de las tandas: si se cierra a
  mitad de camino el bucle se corta. No corrompe nada —la tanda en vuelo termina en el servidor y las
  demás quedan marcadas— pero hay que volver a entrar para terminar. Por eso el "continuar" de la
  vista del mes no es un adorno: es lo que cierra ese agujero.
- **El cierre NO debe ejecutar traslados.** Se intentó primero así y obligaba a un tope arbitrario
  (20) para no comerse el timeout; peor todavía, las que quedaban afuera eran inalcanzables, porque su
  período ya estaba cerrado y un segundo cierre no las volvía a mirar. Queda escrito para que no se
  reintente.
- **Marcar y no cerrar nunca**: una boleta marcada que se queda meses sin cerrar el período no se
  mueve. La pantalla tiene que mostrar la marca de forma visible para que no pase inadvertida.
- **Navegar a meses viejos** puede tentar a "arreglar" el pasado. El alcance es explícito: en un mes
  cerrado sólo se puede empujar al siguiente y deshacer, nada más.

## Fuera de alcance

- El botón "Agregar Factura" sobre un gasto fijo sin boleta (anotado arriba).
- **El registro de pagos, en cualquier forma.** Decisión del owner (2026-08-20): **los pagos se hacen
  fuera de la app**, y la página no los admite **hasta nuevo aviso** — la app todavía no está madura
  para sostener ese registro.

  Lo único que sí se muestra es el **monto a pagar** cuando llegó la boleta del gasto fijo.

  El dato que lo confirma: hay **un solo** registro de pago en todo el sistema (hoja Datos fila 826,
  `0005-00006020`, $179.249,61 del 05/07) y la base tiene exactamente ese mismo. No era un problema de
  sincronización: el sync corrió el 10/08 y trajo lo único que había.

  Consecuencia para quien retome esto: **cualquier pantalla que hable de deuda, saldo o "impago" va a
  leerse como si nunca se hubiera pagado nada**. No es un bug de esa pantalla; es que el dato no
  existe. Eso alcanza a `Invoice.isPaid`, `remainingBalance`, el modelo `Payment` y las tarjetas de
  deuda del panel de consorcios.
