# Spec — UX vista de consorcio: limpieza + Configuración con acordeón

Fecha: 2026-07-09
Estado: **Implementado** (2026-07-09). Se implementó directo desde el spec, sin plan formal
(cambio chico, un solo archivo). Verificado con typecheck + lint (0 errores). No hizo falta CSS nuevo:
el acordeón reusa `configSection` + `lspToggle`/`lspToggleChevron`/`lspTitle`/`lspContent`.
Ámbito: `src/app/admin/consortiums/page.tsx`. Solo frontend.

---

## 1. Objetivo

Tres ajustes de UX en la vista de un consorcio, pedidos por el owner:

1. Quitar ruido visual: las tarjetas **Duplicados** y **Rubros** de la solapa Boletas no aportan.
2. Sacar **Servicios públicos (LSP)** y **Gastos fijos** de la vista principal y llevarlos **dentro
   del modal de Configuración** del consorcio, para que ambos se carguen/administren desde ahí.
3. Reordenar las solapas: **Obligaciones** primera (antes de Boletas y Pagos) y activa por defecto.

Ninguno toca backend, API, datos ni Prisma. Es puramente presentación.

---

## 2. Decisiones cerradas

| Tema | Decisión |
|---|---|
| Tarjetas Duplicados/Rubros | Se **eliminan** del `statsStrip` de Boletas. Queda: Boletas + Total período. |
| `const duplicates` | Se elimina (queda sin uso). |
| Estado `rubros` | **Se mantiene**: se sigue usando en el dropdown del modal de carga de boleta. |
| Ubicación LSP + Gastos fijos | Dentro del **modal de Configuración** existente (el del botón "Configuración"). |
| Forma en el modal | **Acordeón de una sola sección abierta a la vez.** |
| Secciones del acordeón | 3: (1) Nombres alternativos, (2) Servicios públicos (LSP), (3) Gastos fijos. |
| Estado inicial del acordeón | **Todas colapsadas** al abrir el modal. |
| Comportamiento | Abrir una **colapsa las otras dos**. Volver a clickear la abierta la cierra (queda ninguna). |
| Vista principal | Pierde las dos secciones → queda header + tabs directo (más limpia). |
| Funcionalidad LSP/Gastos | **Sin cambios**: mismos formularios/acciones, solo relocalizados. |
| Orden de tabs | Obligaciones · Boletas · Pagos. |
| Tab por defecto | **Obligaciones** (al abrir un consorcio arranca ahí). |

---

## 3. Cambio 1 — Quitar tarjetas Duplicados y Rubros

En el `statsStrip` de la solapa Boletas se eliminan las dos tarjetas:

```
Duplicados  → fuera
Rubros      → fuera
```

Queda: **Boletas** y **Total período**.

- Eliminar también `const duplicates = invoices.filter((i) => i.isDuplicate).length;` (queda huérfano).
- **No** tocar el estado `rubros` ni `fetchRubros`: `rubros` se usa en el `<select>` de rubro del
  modal de carga de boleta.

---

## 4. Cambio 2 — LSP + Gastos fijos dentro de Configuración (acordeón)

### 4.1 Qué se mueve

Las dos secciones colapsables que hoy viven en la vista principal (`<div className={styles.lspSection}>`
para "Servicios públicos (LSP)" y para "Gastos fijos") se **quitan de la vista principal** y su contenido
(tabla + formulario de alta + estados de confirmación/borrado) se **relocaliza dentro del modal de
Configuración**, junto a "Nombres alternativos".

### 4.2 Modelo de estado

Reemplazar los flags booleanos separados por un **único estado de acordeón**:

- **Quitar:** `lspCollapsed` / `setLspCollapsed`, `fxCollapsed` / `setFxCollapsed` (y su reset en
  `handleSelectConsortium`).
- **Agregar:** `openConfigSection: "matchNames" | "lsp" | "fixed" | null`, default `null`.

Se conserva `editingMatchNames` (modo edición del campo de nombres), que ahora vive **dentro** de la
sección "Nombres alternativos" del acordeón.

### 4.3 Comportamiento del acordeón

- Cada sección tiene un **header clickeable**. Al clickear un header:
  - si esa sección estaba cerrada → `openConfigSection = <clave>` (se abre; las otras se colapsan solas
    porque el render de contenido es condicional a `openConfigSection === <clave>`).
  - si ya estaba abierta → `openConfigSection = null` (se cierra; queda ninguna abierta).
- El contenido de cada sección se renderiza solo si `openConfigSection === <su clave>`.
- Al **abrir el modal** de Configuración (`setShowConfigModal(true)`), setear `openConfigSection = null`
  (todas colapsadas) además del reset actual (`matchNamesValue`, `editingMatchNames=false`,
  `matchNamesMsg=null`).

### 4.4 Presentación

- Las 3 secciones usan el patrón visual del acordeón (header + chevron). Reusar en lo posible los
  estilos existentes (`configSection`, `lspToggle`/`lspToggleChevron`/`lspTitle`, tablas `lspTable`,
  `lspAddForm`). Si el acordeón necesita algún estilo nuevo, agregarlo en `page.module.css`.
- "Nombres alternativos" pasa de estar siempre visible a ser un ítem más del acordeón (su resumen +
  botón Editar quedan dentro del contenido expandido).

### 4.5 Sin cambios funcionales

Alta/eliminación de LSP, alta/quita/activar-desactivar de gastos fijos y edición de nombres funcionan
igual (mismos handlers: `handleAddLsp`, `handleDeleteLsp`, `handleAddFixedExpense`,
`handleToggleFixedExpense`, `handleDeleteFixedExpense`, `handleSaveMatchNames`). Los fetch
(`fetchLspServices`, `fetchFixedExpenses`) siguen disparándose al seleccionar consorcio; solo cambia
**dónde** se muestran los datos.

---

## 5. Cambio 3 — Obligaciones primera y por defecto

- Reordenar los botones del `tabBar`: **Obligaciones · Boletas · Pagos** (Obligaciones mantiene su badge
  de pendientes).
- Cambiar el estado inicial `useState<"boletas" | "pagos" | "obligaciones">("boletas")` →
  `("obligaciones")`.
- Cambiar el reset en `handleSelectConsortium`: `setActiveTab("boletas")` → `setActiveTab("obligaciones")`.

---

## 6. Alcance y archivos

- **Único archivo de lógica:** `src/app/admin/consortiums/page.tsx`.
- **CSS:** `src/app/admin/consortiums/page.module.css` solo si el acordeón requiere estilos nuevos
  (preferir reusar los existentes).
- **Sin** cambios de backend/API/Prisma. **Sin** migración.

---

## 7. Edge cases

- **Modal recién abierto:** las 3 secciones colapsadas → se ven 3 headers. El usuario abre la que
  necesita.
- **Consorcio sin LSP / sin gastos fijos:** al expandir, la sección muestra su mensaje vacío actual
  ("No hay servicios públicos…" / "No hay gastos fijos…") + el formulario de alta. Igual que hoy.
- **Editar nombres:** al entrar en modo edición dentro de su sección, la sección sigue abierta; abrir
  otra sección la colapsa (el estado de edición se resetea al reabrir el modal, no al colapsar — es
  aceptable; el guardado ya existe).
- **Vista principal:** sin las dos secciones, el header del consorcio queda pegado a la barra de tabs.
  Verificar el espaciado (posible ajuste menor de margen).

---

## 8. Plan de verificación

- `npm run typecheck` limpio.
- `npm run lint` sin errores nuevos (ojo: no dejar `lspCollapsed`/`fxCollapsed`/`duplicates` huérfanos).
- Verificación visual (requiere login): (a) tabs en orden Obligaciones·Boletas·Pagos y arranca en
  Obligaciones; (b) statsStrip de Boletas sin Duplicados/Rubros; (c) modal de Configuración con las 3
  secciones en acordeón, una sola abierta a la vez, todas colapsadas al abrir; (d) alta/edición de LSP,
  gastos fijos y nombres funcionan desde el modal.
- No hay tests unitarios de esta página; no se agregan (es reshuffle de presentación).

---

## 9. Fuera de alcance

- Sub-pestañas internas del modal (se descartó a favor del acordeón).
- Cualquier cambio de comportamiento de LSP / gastos fijos / obligaciones (solo se relocalizan).
- Refactors no relacionados de `page.tsx` (el archivo es grande, pero partirlo no es parte de este spec).
