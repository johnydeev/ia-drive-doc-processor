# Arrastre en rubros + "Omitir" + menú Acciones — plan de implementación

> **Para agentes:** ejecutar con superpowers:subagent-driven-development. Spec:
> `docs/superpowers/specs/2026-09-28-arrastre-en-rubros-y-omitir-design.md`. Sin migración.

**Objetivo:** que la boleta impaga arrastrada viva dentro de su rubro en el mes destino (con
`de septiembre`), que el origen la marque `pasó a octubre` sin contarla, que el traslado se ofrezca
desde el mes destino, renombrar Saltear→Omitir / Agregar al periodo→Incluir, y agrupar Omitir +
Desactivar en un menú `Acciones ▾`.

**Stack:** Next.js 16 + React + TypeScript, Vitest (`.test.ts` node, `.test.tsx` jsdom), CSS Modules
en modo `pure`. Reglas de seguridad: `scratchpad/tareas/reglas.md` (nunca conectarse a la base, ni
`.env`, ni dev server, ni git que escriba).

Base de todo: `src/app/admin/obligaciones/`.

---

## Tarea 1 — "Omitir"/"Incluir" y menú Acciones

**Archivos:** `components/ActionsMenu.tsx` (nuevo) + `components/ActionsMenu.test.tsx` (nuevo),
`components/SheetCard.tsx`, `components/SheetCard.test.tsx`, `page.module.css`.

1. `ActionsMenu`: botón `Acciones ▾` (`aria-haspopup="menu"`, `aria-expanded`, `aria-label` =
   `Acciones de <concepto>`) que despliega un `role="menu"` con items `role="menuitem"` (props:
   `items: Array<{ label: string; onSelect: () => void }>`, `concepto: string`). Cierra con Escape,
   click afuera (listener `mousedown` en `document`) o al elegir. Estado local: no lleva spinner
   (sólo abre un diálogo). Menú posicionado absoluto a la derecha, debajo del botón, con fondo
   `var(--background)`, borde y sombra; items con el mismo alto mínimo que `.actionBtn`.
2. `SheetCard.renderRow` (fila activa): reemplazar los botones `Saltear periodo` y `Desactivar` por
   `<ActionsMenu>` con `Omitir` (sólo si `row.obligationId && row.status === "PENDING"`) y
   `Desactivar`; cada item hace `setConfirm(...)` como hoy. Orden en la celda: editor de etiqueta,
   `Mes siguiente` (si hay boleta), `Acciones ▾` al final.
3. Renombres: botón que deshace una omitida `Agregar al periodo` → `Incluir` (pendingLabel
   `Incluyendo…`). Diálogo de omitir: título `¿Omitir <concepto> en <periodo>?`, confirmLabel
   `Omitir`, pendingLabel `Omitiendo…`, texto del spec (decisión 1) con la línea «Si la boleta llegó
   y no se pudo pagar, no la omitas: usá «Mes siguiente».». El diálogo de Desactivar no cambia.
4. Tooltip de `Mes siguiente` (sin marcar): `Llegó y no se pudo pagar: pasa al mes siguiente al
   cerrar el período`.
5. Tests: `ActionsMenu` (abre/cierra con click, Escape, click afuera; elegir llama `onSelect` y
   cierra; aria). `SheetCard`: actualizar los que buscan `Saltear periodo` / `Agregar al periodo` /
   `Desactivar` en la fila (ahora: abrir `Acciones`, elegir item, confirmar en el diálogo); fila con
   boleta → el menú no tiene `Omitir`; fila omitida → sólo `Incluir`, sin menú.

## Tarea 2 — Modelo: arrastradas en rubros y origen marcado

**Archivos:** `src/app/api/client/obligations/overview/route.ts`, `lib/sheetModel.ts`,
`lib/sheetModel.test.ts`.

1. Overview:
   - Query `carried`: sumar `rubroId: true, coeficienteId: true` y devolverlos en cada item.
   - Query `obligations`: en `invoice.select` sumar `periodRef: { select: { year: true, month: true } }`
     y exponer `invoiceCarriedOutTo: ob.status === "CARRIED_OVER" && ob.invoice?.periodRef ?
     periodLabel(year, month) : null` en el objeto `obligation`.
2. `sheetModel`:
   - `ObligationStatus` suma `"CARRIED_OVER"`. `OverviewCarried` suma `rubroId?`/`coeficienteId?`;
     `obligation` suma `invoiceCarriedOutTo?: string | null`.
   - `SheetRow` suma `carriedOutTo: string | null` (de `invoiceCarriedOutTo`). `CarriedRow` suma
     `rubroId`/`coeficienteId`.
   - `isPrintableRow`: `false` si `row.status === "CARRIED_OVER"`. `hasPrintableRows` sin cambio
     de criterio (`carried.length > 0` sigue contando).
   - `SectionItem` suma `{ kind: "carried"; carried: CarriedRow }`. `groupByRubro` las ubica por su
     `rubroId` (ausente/no asignado → Sin rubro), tier 0, orden por concepto, y **suma** `monto` en la
     columna de su coeficiente. Una fila `CARRIED_OVER` **no suma** su `monto` (sus adicionales sí,
     con el criterio de siempre). Tier de una `CARRIED_OVER`: 2 (al final, como omitida).
   - `filterSheets` también filtra `carried` por concepto (hoy no lo hace; si sólo matchea una
     arrastrada la hoja debe quedar).
3. Tests: arrastrada con rubro va a su sección y suma en su columna; sin rubro → Sin rubro; fila
   `CARRIED_OVER` con `carriedOutTo` no suma ni es imprimible; `buildSheets` mapea
   `invoiceCarriedOutTo` y los labels de la arrastrada; `grandTotals` incluye la arrastrada.

## Tarea 3 — Pantalla: arrastradas dentro de los rubros

**Archivos:** `components/SheetCard.tsx`, `components/SheetCard.test.tsx`, `page.module.css`.

1. `renderCarried(row: CarriedRow)`: la fila que hoy está dentro del bloque "Vienen del mes
   anterior" (preview, facturas, concepto + distintivo `de <fromLabel>` + "1° pago · 2° pago", monto
   en la columna de su coeficiente, alias, acciones Mes siguiente / Devolver / Monto vencido), con
   clase `rowCarried`. `renderSection` la dibuja para `kind: "carried"`; `isItemPrintable` → true.
2. Borrar el bloque `carriedBlock` ("Vienen del mes anterior") del JSX. Las clases CSS
   `carriedBlock`/`carriedTitle` se borran si quedan sin uso.
3. Fila `CARRIED_OVER` en origen (`row.carriedOutTo`): clase `rowCarriedOut` (atenuada, ya existe y la
   impresión la esconde), distintivo `pasó a <carriedOutTo>` (`carriedBadge`), celda de acciones
   vacía (ni editor, ni menú, ni Mes siguiente). `rowClass` la contempla.
4. El distintivo de la arrastrada dice `de septiembre` (texto `de ${fromLabel}` sin año: usar sólo el
   mes — `fromLabel` viene "septiembre 2026", tomar la primera palabra). Lo mismo `pasó a octubre`
   en origen para filas y adicionales/eventuales (`carriedOutTo`): mostrar sólo el mes.
   Helper puro `monthOnly(label)` en `sheetModel.ts` (+test).
5. Tests: la arrastrada aparece dentro del `tbody` de su rubro con `de septiembre`, suma en el total
   del rubro, conserva Devolver / Monto vencido; ya no existe "Vienen del mes anterior"; fila de
   origen `CARRIED_OVER` muestra `pasó a octubre`, sin botones, clase `rowCarriedOut`.

## Tarea 4 — PDF

**Archivos:** `lib/sheetPdf.ts`, `lib/sheetPdf.test.ts`.

1. `sectionLines` dibuja `kind: "carried"`: `[facturas, "<concepto> (de septiembre)" + " (1° pago
   $X)" si hay lateAmount, ...amountCells(monto, col), alias, "", ""]`.
2. Quitar `carried` de `PdfTable`, `CARRIED_TITLE` y el segundo `autoTable`. `drewMain` pasa a ser
   siempre la tabla principal (`toPrintableSheets` ya descarta hojas vacías).
3. Las filas `CARRIED_OVER` no salen (ya las excluye `isPrintableRow` vía `toPrintableSheets`).
4. Tests: arrastrada en su sección con `(de septiembre)`; no hay tabla aparte; total de rubro la
   incluye.

## Tarea 5 — Traslado ofrecido desde el mes destino

**Archivos:** `src/app/api/client/obligations/carry-over/pending/route.ts`, `page.tsx`.

1. `pending`: devolver las marcadas cuyo período es el mes pedido **o el anterior** y está
   **CLOSED** (sólo esas tienen destino: el siguiente ya existe). Query:
   `periodRef: { status: "CLOSED", OR: [{year, month}, {year: prevYear, month: prevMonth}] }`.
   Usar el helper de mes anterior que exista en `@/lib/periodMonth` (si no hay, calcularlo inline:
   enero → diciembre del año anterior).
2. `page.tsx`: texto de la barra → `Hay <N> boleta(s) marcadas para pasar al mes siguiente.` y el
   botón `Pasar ahora` (hoy `Continuar`).
3. `run(month)` no cambia (usa `loadPending`, que ya trae las correctas).

## Tarea 6 — Documentación

`docs/progreso.md`, `docs/decisiones.md` (entrada 2026-09-28: revierte D10, origen marcado, Omitir,
menú Acciones, traslado desde el destino), `CHANGELOG.md`, `CLAUDE.md` (la línea de obligaciones/
hoja si menciona "Vienen del mes anterior" o "Saltear").

## Verificación final
`npx vitest run` + `npm run typecheck` + `npm run lint` + `npm run build` (el warning EINVAL de copia
en Windows es conocido e inofensivo).
