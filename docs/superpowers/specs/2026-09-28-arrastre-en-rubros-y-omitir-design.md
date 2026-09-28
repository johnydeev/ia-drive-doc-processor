# Arrastre de impagas dentro de los rubros + "Omitir" — diseño

**Fecha:** 2026-09-28 · **Estado:** aprobado por el owner (2026-09-28) · **Migración:** no

## Contexto

El administrador pidió que un gasto que llegó y no se pudo pagar (falta de fondos, pasa incluso con
los servicios públicos) se pague sí o sí en el período siguiente, sumado a los del mes, y que el mes
de origen muestre que pasó. Eso existe desde el 2026-08-12/20 como botón **"Mes siguiente"**
(marca en origen → traslado por tandas después de cerrar). Un análisis del 2026-09-27 encontró que:

- **A.** El traslado no arranca después del cierre. La vista de Obligaciones abre en el mes en curso
  (octubre) y `carry-over/pending` busca las marcadas **de ese mes**: las de septiembre no aparecen
  hasta que alguien navega a septiembre y aprieta "Continuar".
- **B.** En el mes de origen, la fila cuya boleta principal ya pasó (`CARRIED_OVER`) se ve como una
  boleta del mes: suma en el total, sale en el PDF, no dice "pasó a octubre" y ofrece "Mes
  siguiente" otra vez. Las adicionales y eventuales ya se marcan bien (`carriedOutTo`).
- **C.** En el mes destino la arrastrada va en el bloque aparte "Vienen del mes anterior" (D10 de la
  parte 2), fuera de los rubros y fuera del TOTAL DEL MES de pantalla.

Aparte, "Saltear periodo" confunde: se leyó como "pasar al mes que viene".

## Decisiones

### 1. "Saltear periodo" pasa a llamarse **"Omitir"**
Mismo comportamiento (`SKIPPED`: este mes no corresponde). Corto y coincide con el estado que ya
muestra la pestaña de Consorcios ("Omitida"). El botón que lo deshace, "Agregar al periodo", pasa a
**"Incluir"**. Textos:

- Botón: `Omitir` · tooltip: *"Este mes no corresponde este gasto"*.
- Diálogo: **¿Omitir EDESUR S.A. — PORTERIA en septiembre 2026?**
  *"Este mes no corresponde este gasto: la fila queda tachada y no sale en el PDF del banco. El mes
  que viene vuelve a aparecer. Se deshace con «Incluir».
  Si la boleta llegó y no se pudo pagar, no la omitas: usá «Mes siguiente»."*
- Pendiente de sumar la aclaración también en la ayuda de "Mes siguiente": *"Llegó y no se pudo
  pagar: pasa al mes siguiente al cerrar el período."*

### 2. En el mes destino, la arrastrada va **en su rubro** (revierte D10)
- Rubro y coeficiente: los de la boleta (`Invoice.rubroId/coeficienteId`, que ya heredó del gasto fijo
  al vincularse en origen). Sin etiqueta → "Sin rubro".
- Distintivo `de septiembre` (el `carriedFrom` original, aunque se haya arrastrado varias veces).
- Conserva lo que hoy tiene el bloque: "1° pago · 2° pago", **Devolver** y **Monto vencido**, y
  "Mes siguiente" (arrastre encadenado).
- **Suma** en el total de su rubro y en el TOTAL DEL MES; en el PDF va en su sección con el mismo
  distintivo. El monto es el del 2° vencimiento si se cargó (`lateAmount ?? amount`, como hoy).
- El bloque "Vienen del mes anterior" desaparece de la pantalla y del PDF.
- Modelo: `SectionItem` suma `kind: "carried"`; `groupByRubro` la ubica y la totaliza.

### 3. En el mes de origen, la que pasó se marca y no cuenta
Fila con obligación `CARRIED_OVER`: distintivo `pasó a octubre`, atenuada, sin acciones, no suma y
no sale en el PDF — el mismo trato que ya tienen las adicionales/eventuales con `carriedOutTo`. El
overview agrega el período actual de la boleta para rotularlo. `ObligationStatus` de la hoja suma
`CARRIED_OVER`; `isPrintableRow` lo excluye.

### 4. El traslado se ofrece desde el mes destino
`carry-over/pending` pasa a devolver también las marcadas **del mes anterior** al que se mira. Así,
al abrir Obligaciones después del cierre (octubre), aparece la barra: *"Hay N boletas de septiembre
marcadas para pasar a octubre — Pasar ahora"*, con avance por tandas como hoy. **No arranca solo**:
el owner lo aprieta y mira la barra (mismo criterio que el spec 2026-08-20: quiere ver que terminó).

### 5. "Omitir" y "Desactivar" van en un menú **Acciones**
Ocupan mucho lugar en cada fila y están al lado del editor de rubro/coeficiente. Se agrupan en un
botón `Acciones ▾` que despliega las dos opciones; cada una sigue abriendo su diálogo de
confirmación. Se cierra con Escape, click afuera o al elegir.

- Quedan **afuera**, como botones directos: el editor de rubro/coeficiente, `Mes siguiente` (se usa
  todos los meses) y las acciones que **deshacen** (`Incluir` en una omitida, `Activar` en una
  desactivada) — una fila en ese estado sólo muestra la que la revierte, como hoy.
- Una fila con boleta no ofrece Omitir: el menú muestra sólo `Desactivar`.
- Accesible: `aria-haspopup="menu"`, `aria-expanded`, items `role="menuitem"`.

## Fuera de alcance
- Arrastrar una obligación **sin boleta** (sigue sin tener sentido: no hay qué pagar; al cerrar pasa
  a "No recibida" y la boleta atrasada entra sola al mes en que llega).
- Disparar el traslado dentro del request del cierre (se descartó el 2026-08-20 por el límite de 100 s).

## Archivos que se tocan
`overview/route.ts` (labels de la arrastrada, período actual de la principal arrastrada),
`carry-over/pending/route.ts`, `sheetModel.ts` (+tests), `sheetPdf.ts` (+tests), `SheetCard.tsx`
(+tests), `page.tsx` (texto de la barra), `page.module.css`, `docs/*`.

## Respuestas del owner (2026-09-28)
1. `Omitir` / `Incluir`: sí.
2. Distintivos `de septiembre` / `pasó a octubre`, sin año: sí.
3. Sumar el menú **Acciones** (decisión 5).
