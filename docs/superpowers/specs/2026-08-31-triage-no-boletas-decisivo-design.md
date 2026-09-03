# Triage decisivo de no-boletas: VEP, LSD y compañía sin gastar un token

**Fecha:** 2026-08-31
**Estado:** spec aprobado, sin implementar
**Origen:** el owner quiere que los documentos que no son boletas —VEP, LSD, estados de cuenta,
presupuestos, pedidos— dejen de gastar requests de IA. Hoy hay varios en Sin Asignar y cada
reproceso los vuelve a pagar. Es la **pieza 3** (atacar el 30% de overhead), acotada a la clase que
rebota **siempre**.

---

## 1. Por qué hoy gastan IA

El pipeline ya tiene un triage de capa 1 (`documentTriageGate`) que corre **antes** de la IA y
cuesta 0 tokens. No los agarra, y **no es por falta de patrones**: es por la lógica.

`classifyDocumentType` (`src/lib/documentClassifier.ts`, 54 líneas) decide así:

```
hay marcador negativo  Y  ninguna señal de boleta  →  not_boleta
```

Donde "señal de boleta" es `$`, `TOTAL A PAGAR`, `IMPORTE`, `VENCIMIENTO`, `FACTURA`, `RECIBO`,
`COMPROBANTE`, `CAE` **o tener cualquier CUIT válido**.

| Documento | Señales de boleta que dispara | Resultado |
|---|---|---|
| VEP de AFIP | `$`, `IMPORTE`, `VENCIMIENTO`, CUIT | pasa a la IA |
| LSD (liquidación de sueldos) | `$`, `IMPORTE`, CUIT | pasa a la IA |
| Estado de cuenta | `$`, `COMPROBANTE`, CUIT | pasa a la IA |
| Presupuesto | `$`, `IMPORTE`, CUIT | pasa a la IA |

**Agregar `"VEP"` a `NOT_BOLETA_MARKERS` no alcanzaría**: `hasBoletaSignal` lo rescata igual. El
sesgo conservador ("ante la duda, es boleta") está bien calibrado para una oblea o un plano, que no
tienen ninguna de esas marcas. Para estos documentos falla justamente porque **parecen boletas en
todo salvo en lo que son**.

## 2. Decisiones tomadas

| Decisión | Elegido | Por qué |
|---|---|---|
| Dónde vive la lógica | En `documentTriageGate`, el triage que ya existe | Corre después de la extracción de texto: el texto ya está y cuesta 0 tokens. Un censo aparte duplicaría descarga de Drive y OCR sin ahorrar una sola request más |
| Alcance | Sólo no-boletas | El ahorro recurrente y el de menor riesgo. El censo de CUITs queda para después, medido |
| Disparador | Automático, en cada ciclo del worker | Decisión del owner: "que se muevan solos… lo que importa es que no gaste tokens ni requests". No quiere un paso manual previo |
| Destino | **Sin Asignar**, no Revisión | Decisión del owner: va a armar un flujo propio para VEP y LSD más adelante, así que son documentos *pendientes de asignar*, no descarte. La limpieza manual la hace en esa carpeta |
| Etiquetas | Una **por tipo** | Para filtrar visualmente y, el día que exista el flujo de VEP, poder seleccionarlos en lote por nombre |

## 3. Diseño

### 3.1 Marcadores decisivos

Categoría nueva en `documentClassifier.ts`: marcadores que **ganan aunque haya señales de boleta**,
porque identifican el formulario por su nombre propio. No reemplazan a los actuales — los de hoy
(oblea, plano, acta) conservan el criterio conservador, que para ellos funciona.

```ts
export type NotBoletaKind = "VEP" | "LSD" | "PRESUPUESTO" | "ESTADO DE CUENTA" | "PEDIDO";

/** Devuelve el tipo si el documento es inequívocamente un no-boleta; si no, null. */
export function detectDecisiveNotBoleta(text: string): NotBoletaKind | null
```

`classifyDocumentType` se mantiene con su firma actual (la usan el gate y sus tests); el gate llama
primero a `detectDecisiveNotBoleta` y, si da `null`, cae en la heurística de siempre.

**Los marcadores concretos se calibran contra texto real — ver §4.** Este spec NO los fija de
memoria a propósito: escribir `"VOLANTE ELECTRÓNICO DE PAGO"` cuando el papel dice `"V.E.P. Nº"` da
un detector que no detecta nada, y no hay forma de saberlo sin el papel.

### 3.2 El gate

```ts
async function documentTriageGate(ctx: PipelineContext): Promise<StepResult> {
  if (!ctx.docText) return { kind: "continue" };

  const kind = detectDecisiveNotBoleta(ctx.docText);
  if (kind) return divertNotBoleta(ctx, "decisive", kind);

  if (classifyDocumentType(ctx.docText) === "not_boleta") {
    return divertNotBoleta(ctx, "heuristic");
  }
  return { kind: "continue" };
}
```

`divertNotBoleta` pasa a aceptar el tipo y a mover a **Sin Asignar** en vez de Revisión, etiquetando
`[NO BOLETA - <TIPO>]`. `m.result` sigue siendo `"not_boleta"`; `m.reason` pasa a llevar el tipo, que
con la instrumentación del 2026-08-31 **queda persistido en `ProcessingJob.reasonCategory`** — o sea
se puede contar cuántos VEP se cortaron y cuántas requests ahorraron.

### 3.3 Etiquetas idempotentes

La etiqueta de no-boleta es un **prefijo**, no un sufijo: `[NO BOLETA - VEP] archivo.pdf`. Sigue la
forma que ya tenía `markNotBoleta` y se lee de un golpe al ordenar la carpeta por nombre.

Por ser prefijo, **no** entra en `KNOWN_SUFFIX_TAGS` — esa lista limpia sufijos ` - TAG` antes de la
extensión, y aplicarla acá no corresponde.

**Bug preexistente que se arregla acá:** `markNotBoleta` (`documentValidation.ts:76`) anteponía el
prefijo **sin quitar el que ya estuviera**, así que reprocesar dos veces daba
`[NO BOLETA] [NO BOLETA] archivo.pdf`. Con el flujo nuevo —el owner devuelve archivos a Pendientes
para reprocesarlos— eso se dispara solo. Pasa a aceptar el tipo y a ser idempotente contra
cualquier prefijo previo, con o sin tipo:

```ts
markNotBoleta("[NO BOLETA - VEP] x.pdf", "LSD")  // → "[NO BOLETA - LSD] x.pdf"
```

### 3.4 Cambio de comportamiento

Las no-boletas dejan de ir a **Revisión** y pasan a **Sin Asignar**. Afecta también a las que ya se
detectaban hoy (oblea, plano, acta) y a las de capa 2 (`isBoleta = false` de la IA). Es intencional:
un solo lugar donde hacer la limpieza.

## 4. Calibración: el paso que no se puede saltear

Los marcadores se escriben **sobre el texto real**, no de memoria. Método:

1. El owner copia 2-3 VEP y 2-3 LSD de Sin Asignar a una carpeta local.
2. Se extrae el texto con `pdf-parse` (el mismo que usa el pipeline) y se leen los encabezados.
3. Los marcadores salen de ahí, eligiendo frases que **sólo** aparecen en ese formulario.

Sin este paso el detector se puede escribir igual, pero su tasa de falsos negativos es desconocida y
el trabajo no se puede dar por verificado.

## 5. Riesgos

**El falso positivo es el riesgo real**: un marcador demasiado ancho saca de circulación una boleta
buena sin extraerla. Mitigaciones:

- **`F931` de ARCA no es un LSD.** Es un gasto real, que se paga, y tiene prompt propio
  (`buildArcaPrompt`). Una regla de sueldos escrita con la mano pesada lo mata. El marcador de LSD
  tiene que ser el nombre del libro, nunca la palabra "sueldos" suelta, y hay que dejar un test que
  fije que un F931 **sigue pasando**.
- **El documento no se pierde ni se borra**: se renombra y se mueve. El owner revisa la carpeta y
  devuelve a Pendientes lo que haya que rescatar.
- **Sesgo**: ante la duda, sigue siendo boleta. Un falso negativo cuesta una request; un falso
  positivo cuesta una boleta no procesada.
- **La instrumentación mide el resultado**: `outcome = 'not_boleta'` agrupado por `reasonCategory`
  dice cuántos se cortaron y de qué tipo. Si aparece un tipo con volumen inesperado, es señal de
  marcador demasiado ancho.

## 6. Tests

| Qué | Dónde |
|---|---|
| Cada tipo se detecta sobre el texto real del papel | `documentClassifier.test.ts` |
| **Un F931 de ARCA NO se detecta como LSD** | `documentClassifier.test.ts` |
| Una factura común no se detecta como ninguno | `documentClassifier.test.ts` |
| Los marcadores decisivos ganan aunque haya `$`, `IMPORTE` y CUIT | `documentClassifier.test.ts` |
| El gate corta antes de la IA y mueve a Sin Asignar con la etiqueta del tipo | `processPendingDocuments.job.test.ts` |
| El gate no gasta requests (`aiRequests = 0`) | `processPendingDocuments.job.test.ts` |
| `appendTag` limpia las etiquetas nuevas en vez de apilarlas | `documentValidation.test.ts` |
| `markNotBoleta` es idempotente | `documentValidation.test.ts` |

## 7. Alternativas descartadas

- **Censo separado que barre Pendientes antes del worker** (la idea original). Ahorra exactamente las
  mismas requests que el gate, porque el triage de capa 1 ya corre antes de la IA — pero duplica la
  descarga de Drive y el OCR, agrega un proceso nuevo que mantener, y sólo funciona cuando alguien lo
  dispara. El gate funciona siempre.
- **Botón "Censar Pendientes" en el panel.** El owner fue explícito: no quiere un paso manual previo,
  quiere que se muevan solos.
- **Agregar los tipos a `NOT_BOLETA_MARKERS`.** No funciona: `hasBoletaSignal` los rescata (§1).
- **Preguntarle a la IA si es boleta antes de extraer.** Es lo que ya hace la capa 2, y cuesta
  exactamente la request que se quiere ahorrar.

## 8. Fuera de alcance

El censo determinístico de CUITs para predecir rebotes de facturas comunes (queda para cuando la
instrumentación diga cuánto pesa esa clase), el flujo futuro de procesamiento de VEP y LSD como
gastos, y cualquier UI.

## 9. Verificación

`npm run typecheck` + `npx vitest run` + `npm run lint` + `npm run build:jobs`. Sin migración.

Verificación real, después de un par de días en producción:

```sql
SELECT "reasonCategory", count(*), sum("aiRequests")
FROM "ProcessingJob" WHERE outcome = 'not_boleta' GROUP BY 1;
```

`sum("aiRequests")` tiene que dar **0** para los tipos decisivos: si da más, el gate se está
disparando después de la llamada a la IA y no está ahorrando nada.
