# Spec — Arrastre de boletas impagas al mes siguiente

**Fecha:** 2026-08-12
**Tipo:** Feature (UI + endpoint + migración).
**Estado de partida:** Partes 1 y 2 de la vista global de obligaciones implementadas y verificadas
(565 tests), migración `20260812000000_unique_fixed_expense_target` aplicada. Sin commitear.
**Requiere migración.** No toca el pipeline de procesamiento.

---

## 1. Problema

El cliente se lo contó al owner en estos términos: hay meses en que **no entran los pagos de las
expensas**, y una boleta de gasto fijo que llegó y correspondía **no se puede pagar**. Esa boleta se
abona al mes siguiente, junto con la del mes corriente — dos boletas del mismo servicio, una vencida y
otra al día.

Hoy el sistema no lo contempla:

- **La hoja imprimible no la muestra.** El papel de septiembre lista la obligación de septiembre y
  nada más. El administrador va al banco sin saber que además debe la de agosto.
- **Saltear el período no sirve** para esto: marca que el gasto *no corresponde* (fumigación
  trimestral, seguro semestral). Acá la boleta **sí correspondía** y **sí llegó**: es deuda, no una
  excepción de calendario.
- La deuda existe en `Invoice.remainingBalance` / `isPaid` y alimenta las tarjetas de deuda de la
  vista general, pero no llega al papel.

Hay además una razón de negocio explícita del owner: **la administración tiene que ser transparente
con los inquilinos.** Si una boleta no se pagó por falta de fondos, eso se debe poder saber y quedar
registrado como tal — hay intereses de por medio.

## 2. Decisión de negocio del owner

> "El pago se registra contra el período en que se paga. EDESUR de agosto, pagada en septiembre, se
> registra en septiembre."

De ahí se derivan las tres decisiones tomadas en el brainstorming:

| Decisión | Elegido |
|---|---|
| Qué pasa con la boleta impaga | **Se mueve al período siguiente** (el egreso cae en el mes en que salió la plata) |
| Quién dispara el pase | **Botón por fila** en la vista de obligaciones — el administrador sabe cuál no pudo pagar |
| Cómo se ve en la hoja destino | **Fila aparte**, marcada con su mes de origen ("vencida de agosto") |

**Alternativas descartadas:** el pase automático al cerrar el período (una boleta puede estar impaga
porque está en disputa con el proveedor, no por falta de fondos) y duplicar el `Invoice` en los dos
meses (dos registros de la misma factura obligan a decidir cuál manda para la deuda total y cuál se
escribe en Sheets).

## 3. Hallazgos verificados

### 3.1 Mover una boleta ya está resuelto, y mueve las tres puntas

`moveOneInvoiceToTarget` (`src/lib/invoicePeriodMove.ts:235`) mueve **Drive → Sheets → DB** con
compensación LIFO por boleta, es idempotente (si ya está en el destino → `ya_en_destino`) y valida que
el destino sea `ACTIVE`, del mismo consorcio y del mes siguiente. Esta feature **reusa esa función**:
no se escribe un camino de movimiento nuevo.

Que mueva también la fila de Sheets es exactamente lo que pide la decisión de negocio: la liquidación
registra el gasto en el mes en que se paga.

### 3.2 El re-vínculo de obligaciones choca de frente con este caso

`applyDbMove` (`invoicePeriodMove.ts:207`) hace, en una transacción:

1. la obligación vinculada vuelve a `PENDING` con `invoiceId: null`;
2. la boleta cambia de `periodId`;
3. `linkInvoiceToObligation` la re-vincula a una obligación **`PENDING`** del período nuevo.

En nuestro caso el paso 3 **no puede funcionar, y está bien que no funcione**: en septiembre la
obligación de EDESUR ya está `RECEIVED` con la boleta de septiembre. La de agosto llega y no encuentra
dónde engancharse. Sin un tratamiento explícito quedaría en la base pero **invisible en la hoja**.

Y el paso 1 es justamente lo que borra la huella en agosto: la obligación queda `PENDING` y al cerrar
el período pasa a `NOT_RECEIVED` — que significa "nunca llegó la boleta", una mentira. La boleta llegó;
lo que no hubo fue plata.

### 3.3 `Invoice` no sabe de dónde vino

No hay campo que registre el período original. Sin eso, la hoja de septiembre no puede escribir
"vencida de agosto": después del move, la boleta es indistinguible de una de septiembre.

### 3.4 Estados de obligación disponibles

`ObligationStatus` es `PENDING | RECEIVED | SKIPPED | NOT_RECEIVED`. Ninguno significa "llegó, no se
pagó, se pasó al mes siguiente".

## 4. Diseño

### 4.1 Modelo — dos campos y un estado nuevo

```prisma
enum ObligationStatus {
  PENDING
  RECEIVED
  SKIPPED
  NOT_RECEIVED
  CARRIED_OVER   // llegó, no se pagó, la boleta se pasó al período siguiente
}

model Invoice {
  // …
  /// Período del que se arrastró esta boleta por quedar impaga. Null = nació acá.
  carriedFromPeriodId String?
  carriedFrom         Period?  @relation("InvoiceCarriedFrom", fields: [carriedFromPeriodId], references: [id], onDelete: SetNull)
}
```

`carriedFromPeriodId` se setea **una sola vez**, en el primer arrastre: si una boleta de agosto se
arrastra a septiembre y de septiembre a octubre, sigue diciendo "vencida de agosto", que es la verdad
que le importa al inquilino. La migración la aplica el owner.

### 4.2 Qué pasa exactamente al apretar el botón

Sobre una fila cuya obligación está `RECEIVED` y cuya boleta tiene saldo pendiente:

1. **Drive + Sheets + DB**: `moveOneInvoiceToTarget` mueve la boleta al período siguiente del
   consorcio (el PDF cambia de subcarpeta y se renombra; la fila de Sheets actualiza su período).
2. **La obligación de origen NO se vacía.** Conserva su `invoiceId` y pasa a `CARRIED_OVER`. Agosto
   queda diciendo: *EDESUR llegó, por $X, y no se pagó — se pasó a septiembre*. Es la huella que exige
   la transparencia hacia los inquilinos.
3. **En el destino no se re-vincula a ninguna obligación.** La de septiembre es de la boleta de
   septiembre. La arrastrada vive como boleta suelta del período, marcada con `carriedFromPeriodId`.
4. Se registra `carriedFromPeriodId` con el período de origen, sólo si estaba en `null`.

Esto exige un camino propio en vez del `applyDbMove` genérico: se agrega un parámetro (o una variante)
que, en lugar de "vaciar origen y re-vincular destino", haga "marcar origen como `CARRIED_OVER` y
dejar la boleta suelta en el destino". El resto de `moveOneInvoiceToTarget` —Drive, Sheets,
compensación, idempotencia— se reusa sin tocar.

**El camino existente de Boletas entrantes no cambia**: ahí mover una boleta sigue significando "entró
en el mes equivocado", y para eso vaciar y re-vincular es lo correcto.

### 4.3 De dónde se dispara — corregido tras la revisión del 2026-08-12

**La primera versión de este spec ponía el botón en la fila de la obligación impaga. Es imposible.**
`classifyTarget` (`invoicePeriodMove.ts:104`) exige que el destino sea el mes siguiente **y esté
`ACTIVE`**; como cada consorcio tiene un solo período abierto, septiembre recién está activo cuando
agosto se cerró. Y el `overview` sólo consulta períodos `ACTIVE`, así que la obligación de agosto
**nunca aparece en la vista**. El botón no tendría fila donde vivir.

**Diseño corregido:** al pie de cada edificio va un bloque **"Impagas de meses anteriores"**,
alimentado por las **boletas del consorcio con saldo pendiente cuyo período no es el activo**. No
depende de que exista una obligación visible: se consulta por consorcio.

Cada fila del bloque ofrece:

- **"Pasar a este período"** — sólo si el período de la boleta es el **inmediatamente anterior** al
  activo (es lo que valida `classifyTarget`). Si la boleta es más vieja, la fila se muestra igual
  —para que la deuda se vea— con el botón deshabilitado y el motivo.
- **"Cargar monto vencido"** — una vez pasada (§4.6).

Después del pase, la boleta pertenece al período activo y **sigue en el mismo bloque**, ahora con el
badge *"pasada a este período"*: no cambia de lugar en la pantalla, cambia su estado.

### 4.4 Cómo se ve

**Un bloque propio al pie de cada edificio**, debajo de la tabla de gastos fijos, con el mismo formato
de columnas para que se lea como continuación de la hoja:

```
BOEDO 414                                    BANCO: Ciudad · PERIODO: Septiembre 2026
┌──────────┬───────────────────────────┬──────────────┬─────────────┬─────────┬──────┐
│ FACTURAS │ PROVEEDORES Y SERVICIOS   │ MONTO        │ ALIAS CBU   │ TÉCNICO │ TEL. │
│ 80010977 │ EDESUR S.A.               │ $ 1.200.000  │ edesur.pago │         │      │
│          │ ASECLIM S.R.L.            │ $ 80.360     │             │         │      │
└──────────┴───────────────────────────┴──────────────┴─────────────┴─────────┴──────┘

IMPAGAS DE MESES ANTERIORES
┌──────────┬───────────────────────────┬──────────────┬─────────────┬─────────┬──────┐
│ 80010977 │ EDESUR S.A. — de agosto   │ $ 980.000    │ edesur.pago │         │      │
└──────────┴───────────────────────────┴──────────────┴─────────────┴─────────┴──────┘
```

El monto de una fila impaga es el **saldo pendiente**, no el total de la boleta: si se pagó una parte,
lo que hay que llevar al banco es lo que falta. Se ordenan por período de origen, lo más viejo
primero.

**Se separa en un bloque y no se mezcla con los gastos fijos** por dos razones: el administrador
distingue de un vistazo lo del mes de lo atrasado, y la tabla de arriba conserva su significado
("los gastos fijos de este edificio"), que es lo que se compara mes a mes.

En pantalla, cada fila del bloque lleva sus acciones: **Pasar a este período**, **Cargar monto
vencido** y el acceso al modal de pagos existente.

**En la fila de origen (agosto):** la obligación queda `CARRIED_OVER`. **No se ve en la vista global**
—agosto está cerrado y esa vista sólo muestra períodos activos— sino en la **pestaña Obligaciones del
consorcio**, navegando al período viejo. Ahí se pinta como *"Impaga — pasada al mes siguiente"*.

Eso obliga a dos cambios en esa pantalla, que hoy no conoce el estado nuevo:

- el tipo `ObligationRow.status` (`consortiums/lib/types.ts:72`) es una **unión escrita a mano**: si no
  se le agrega `CARRIED_OVER`, TypeScript no avisa nada y el badge cae al final de la cadena;
- la cadena de badges (`consortiums/page.tsx:865`) necesita su rama.

### 4.5 Endpoint

`POST /api/client/obligations/[id]/carry-over` — sin body. Resuelve el período destino server-side
(el `ACTIVE` siguiente del consorcio), valida las tres condiciones de §4.3 y llama al camino de move.
Devuelve `{ ok, movedTo: { periodLabel }, invoiceId }` o el motivo del rechazo.

Se hace de a una boleta: es una acción deliberada por fila, no masiva. Cada llamada mueve un PDF en
Drive y actualiza una fila de Sheets — ~8,5 s, muy lejos del techo de 100 s del túnel.

### 4.6 El monto del 2° vencimiento

Las boletas de servicios —EDESUR y Metrogas sobre todo— traen impresos **dos importes**: el del 1er
vencimiento y el del 2°, mayor, para pago fuera de término. El pipeline extrae **sólo el primero**, a
propósito y de forma explícita: los prompts dicen *"monto del PRIMER vencimiento solamente"*, *"sin
recargo"*, y rechazan *"fechas de 2° o 3° vencimiento con recargo"* (`extraction.ts:686` y `:740`).
Así que cuando una boleta se paga arrastrada, **el importe real no está en la base**.

**Campo nuevo:**

```prisma
model Invoice {
  /// Importe del 2° vencimiento (pago fuera de término). Se carga a mano sobre una
  /// boleta arrastrada; el pipeline nunca lo escribe.
  lateAmount Decimal? @db.Decimal(14, 2)
}
```

**Por qué un campo aparte y no editar `amount`:** `amountNorm` —derivado de `amount`— es parte del
índice único de deduplicación `uq_invoice_business_key`. Pisar el monto obliga a recalcular esa llave,
con riesgo de colisión, y borra lo que decía el papel. Con un campo separado el original queda intacto
para la deduplicación y el guard de IVA, y se ve junto al vencido.

**Procedimiento:** la fila arrastrada —y sólo ella, porque tiene `carriedFromPeriodId`— ofrece
**"Cargar monto vencido"**: un input con el importe del 2° vencimiento que el administrador lee del
papel. Al guardar se escribe `lateAmount` y **se recalcula el saldo**:
`remainingBalance += (lateAmount − base anterior)`, donde la base anterior es el `lateAmount` previo
si lo había, o `amount`. Un pago parcial ya registrado se respeta: el saldo sube por la diferencia.
`remainingBalance` hoy se siembra con `invoice.amount` en el primer pago
(`payment.repository.ts:151`), así que el cálculo de pagos pasa a usar `lateAmount ?? amount` como
base.

**Los dos importes se muestran como "1° pago" y "2° pago", sin exponer la diferencia** (decisión del
owner: menos números, más claro):

| Lugar | Qué muestra |
|---|---|
| **Pantalla**, fila arrastrada | MONTO = lo que hay que pagar (el 2°). Debajo, en chico: `1° pago $ 980.000 · 2° pago $ 1.050.000` |
| **PDF** | MONTO = el 2° pago (un solo número en la celda, para no equivocarse en el banco). El concepto dice `EDESUR S.A. — vencida de agosto (1° pago $ 980.000)` |
| **Pestaña Pagos** | El saldo ya refleja el 2°, así el historial cierra contra lo que realmente se pagó |
| **Google Sheets** | La columna H (MONTO) **no se toca**: conserva lo que decía la boleta. El recargo se refleja en P (SALDO PENDIENTE) y Q (MONTO PAGADO) |

Si no se carga el `lateAmount`, la fila arrastrada muestra el saldo sobre el monto original: la
feature no obliga a cargarlo.

### 4.7 El vínculo retroactivo tiene que ignorar las arrastradas

**Bug encontrado en la revisión, antes de escribir el código.** `ExpenseObligation.invoiceId` es
`@unique` y nuestro diseño deja la obligación de agosto conservándolo. Pero el vínculo retroactivo
—`generateObligationsForPeriod` (`obligation.service.ts:32`) y `syncObligationsForClient` (`:218`)—
busca las boletas del período **sin filtrar las arrastradas**.

Secuencia que rompe: se arrastra EDESUR de agosto a septiembre → la boleta de septiembre todavía no
llegó, así que su obligación está `PENDING` → alguien abre la vista, que sincroniza sola → el matcher
encuentra la boleta arrastrada en septiembre, matchea el proveedor e intenta vincularla → **violación
de unique (P2002) en runtime**.

**Fix:** las dos queries filtran `carriedFromPeriodId: null`. Una boleta arrastrada nunca ocupa la
obligación del período destino: ese lugar es de la boleta del mes.

### 4.8 Qué consulta el `overview`

Suma una consulta por cliente: **boletas con saldo pendiente (`isPaid: false`) cuyo `periodId` no es
el período activo de su consorcio**, más las que ya se arrastraron (`carriedFromPeriodId != null`,
que ya viven en el activo y siguen impagas). De cada una: proveedor, número de cliente, alias,
`amount`, `lateAmount`, saldo, período de origen y si su período es el inmediatamente anterior al
activo (para habilitar el botón de pase).

`buildSheets` las devuelve en `SheetData.carried`, separadas de `rows`: son un bloque propio, no una
fila más de la tabla de gastos fijos.

## 5. Bordes

- **No hay período siguiente ACTIVE:** el botón se deshabilita con el motivo. Es el mismo caso que ya
  maneja `classifyTarget` (`destino_inexistente`).
- **La boleta se pagó entre que se pintó la pantalla y el click:** el endpoint revalida el saldo y
  responde 409 con "la boleta ya está paga".
- **Doble click / reintento:** `moveOneInvoiceToTarget` es idempotente (`ya_en_destino`), y
  `carriedFromPeriodId` sólo se escribe si estaba vacío.
- **Falla Drive o Sheets:** la compensación LIFO existente deja todo como estaba y el endpoint reporta
  el paso que falló. El estado `CARRIED_OVER` se escribe **dentro** de la transacción de DB, o sea
  después de que Drive y Sheets salieron bien.
- **Arrastre encadenado** (agosto → septiembre → octubre): permitido; `carriedFromPeriodId` conserva
  agosto.
- **Cierre de período con una `CARRIED_OVER`:** no se toca. `closeObligationsForPeriod` sólo pasa las
  `PENDING` a `NOT_RECEIVED`.

## 6. Testing

- **Tier 0:** el orden y el pintado de las filas arrastradas en `buildSheets`/`toPrintableSheets`
  (después de los gastos del mes, antes de los desactivados, con su etiqueta de origen y el saldo como
  monto); `toPdfTables` con una arrastrada.
- **Servicio:** el camino de arrastre — la obligación de origen queda `CARRIED_OVER` **conservando**
  su `invoiceId`, la boleta cambia de período, `carriedFromPeriodId` se escribe una sola vez, y no se
  re-vincula a la obligación del destino aunque esté `PENDING`.
- **Endpoint:** rechaza si no hay saldo, si no hay período destino, o si la obligación no está
  `RECEIVED`.
- **Tier 1/2:** el botón aparece sólo bajo las tres condiciones; da feedback de carga (`AsyncButton`);
  la fila arrastrada se ve distinta y muestra su mes de origen.

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| Agosto pierde la huella del atraso | El estado `CARRIED_OVER` conservando el `invoiceId` es justamente la huella; hay test que lo fija |
| Tocar `applyDbMove` rompe Boletas entrantes | El camino nuevo es una variante explícita; el existente no se modifica y sus tests de caracterización quedan como red |
| Una boleta arrastrada se cuenta dos veces en la deuda | El `Invoice` es uno solo y cambia de período: no hay duplicado. La deuda total no cambia |
| La hoja se llena de arrastradas si el consorcio está muy atrasado | Van agrupadas al final y con su origen; si aparece el caso, el paso siguiente es un tope visual |

## 8. Fuera de alcance

- **Calcular** intereses y recargos. El monto del 2° vencimiento se **carga a mano** (§4.6); el
  sistema no lo deriva. Calcularlo necesitaría tasa, fecha de vencimiento real y reglas por proveedor.
- **Que la IA extraiga el 2° vencimiento.** Sería lo ideal (las boletas LSP lo traen impreso), pero
  toca los 12 prompts y el pipeline de extracción, el área más delicada del sistema. Feature aparte.
- **Pase masivo** de todas las impagas de un edificio, o de toda la cartera.
- **Pase automático al cerrar el período** (descartado en §2).
- **Registrar el pago desde la hoja**: el botón lleva al modal de pagos existente; no se construye uno
  nuevo.
