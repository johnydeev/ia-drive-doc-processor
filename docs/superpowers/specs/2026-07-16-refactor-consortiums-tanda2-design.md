# Spec — Refactor `consortiums/page.tsx`, Tanda 2 (núcleo de detalle)

**Fecha:** 2026-07-16
**Tipo:** Refactor de deuda técnica (Fase 2 del análisis del 2026-07-15).
**Relación:** Continúa el refactor incremental de `consortiums/page.tsx`. Hereda arquitectura, convenciones
y contrato de verificación del **spec paraguas** `docs/superpowers/specs/2026-07-16-refactor-consortiums-page-design.md`
(este spec NO los redefine; solo detalla lo específico de la Tanda 2). Tanda 1 (lib/ + infra tests + 2 modales
+ PagosView) ya está completa: ver `docs/progreso.md`.
**Estado de partida:** `page.tsx` en 2418 líneas, 79 `useState`.

---

## 1. Alcance

**Incluye (el "núcleo enredado" del detalle de un consorcio):**
- `useConsortiumDetail` — cascada selección → períodos → período activo → boletas + `activeTab` + búsqueda +
  restauración por deep-link (`?c=`) + navegación de períodos.
- `useObligations` — la solapa de obligaciones (estado + carga + generar + cambiar estado).
- `useClosePeriod` + `ClosePeriodModal` — el modal Cerrar período (patrón Tanda 1).

**No incluye (decisiones de alcance tomadas en brainstorming):**
- **El grid/lista de consorcios** (`consortiums`, `loadingList`, `listError`, `consortiumSearch`,
  `fetchConsortiums`) se queda en `page.tsx`. `useConsortiumDetail` recibe lo que necesita (`consortiums`,
  `loadingList`) como input. Se extraerá como `useConsortiums` en una tanda posterior (oportunista).
- **El estado de Configuración y datos de referencia** (coeficientes, rubros, LSP services, gastos fijos,
  matchNames) es **Tanda 3**. Se queda en `page.tsx`; la Tanda 2 solo lo **dispara** vía callback (§4), no
  se adueña de él.

## 2. Decisiones de diseño (tomadas en brainstorming)

| # | Decisión | Alternativas descartadas |
|---|----------|--------------------------|
| 1 | **Corte cohesivo:** un `useConsortiumDetail` dueño de la cascada núcleo + hooks satélite (`useObligations` aparte, `useClosePeriod` como hook+componente) | Hooks granulares (selección/períodos/boletas separados): la cascada (elegir consorcio dispara carga de períodos que dispara carga de boletas) habría que recablearla ENTRE hooks vía callbacks/efectos en page.tsx — reintroduce el acoplamiento por la puerta de atrás y sube el riesgo de cambiar timing. Un solo `useConsortiumDetail` que abarque también obligaciones y cierre: hook grande, mezcla dominios, menos testeable. |
| 2 | **Alcance:** solo el detalle; la lista queda en `page.tsx` | Extraer también `useConsortiums` en esta tanda: más grande, sin necesidad (la lista es simple y de bajo riesgo — se extrae después). |
| 3 | **Costura de orquestación:** fan-out por callback `onConsortiumSelected` (§4) | Que `useConsortiumDetail` se adueñe del estado de config/referencia (Tanda 3): recrea el god-component en versión hook, rompe la frontera, y obliga a sacarle ese estado de nuevo en la Tanda 3 (churn + riesgo). |

## 3. Unidades

### 3.1 `useConsortiumDetail`
Dueño de: `selectedId`, `selectedConsortium`, `periods`, `selectedPeriod`, `invoices`, `loadingInvoices`,
`invoicesError`, `search`, `activeTab`, el estado de restauración (`pendingRestore` + `didRestoreRef`), y los
derivados de navegación de período (`periodIndex`, `canGoPrev`, `canGoNext`).
Fetches internos: `fetchPeriodsAndInvoices`, `fetchInvoices`.
Acciones expuestas: `selectConsortium(c)`, `selectPeriod(p)`, `back()`, `goPrevPeriod()`, `goNextPeriod()`,
`setSearch(v)`, `setActiveTab(t)`, `reloadAfterClose()` (re-corre la cascada tras cerrar período).

- **Inputs:** `{ consortiums, loadingList, onConsortiumSelected(c, activePeriodId) }`.
- **Restauración por deep-link:** el efecto que lee `?c=` y restaura la selección vive **dentro** del hook
  (depende de `consortiums` + `loadingList`, que llegan por input). Esto **elimina el hack
  `handleSelectConsortiumRef`** de `page.tsx` (existía solo porque el orquestador se declaraba después del
  efecto; dentro del hook el orden se resuelve).
- **Salidas:** todo el estado anterior (read) + las acciones.

### 3.2 `useObligations`
Dueño de: `obligations`.
Acciones: `load(periodId)`, `generate(periodId)`, `setStatus(id, status, periodId)`, `clear()`.
- No guarda el `periodId` internamente: lo recibe en cada acción (lo provee `page.tsx` desde
  `detail.selectedPeriod?.id`). Así no comparte estado con `useConsortiumDetail`.

### 3.3 `useClosePeriod` + `ClosePeriodModal`
Patrón Tanda 1 (hook de estado + componente presentacional).
- **Hook** `useClosePeriod({ consortiumId, periodId, onClosed })` → `{ isOpen, open, close, error, success,
  saving, submit }`. `submit` pega a `close-period`; en éxito setea `success`, cierra el modal y llama
  `onClosed()`.
- **Componente** `ClosePeriodModal` — recibe props explícitas; sin fetch propio.
- **Nota de verificación (plan):** `closeError`/`closeSuccess` hoy se muestran también fuera del modal (en el
  header/detalle). El plan debe leer el JSX exacto y decidir si esos mensajes viven en el hook de close
  (leídos por el detalle) o se mueven — **sin cambiar dónde se ven**.

## 4. Costura de orquestación (fan-out por callback)

`selectConsortium` (en `useConsortiumDetail`) hace la parte de detalle (setear selección, actualizar URL,
resetear `activeTab`/`invoices`/`search`, cargar períodos+boletas) y **dispara `onConsortiumSelected(c,
activePeriodId)`**. En `page.tsx` ese callback ejecuta lo que todavía vive ahí:

```tsx
const obligations = useObligations();
const detail = useConsortiumDetail({
  consortiums, loadingList,
  onConsortiumSelected: (c, activePeriodId) => {
    // Tanda 3 (config/referencia) — resets + fetches que siguen en page.tsx:
    setEditingMatchNames(false); setMatchNamesMsg(null); setMatchNamesValue(c.matchNames ?? "");
    setLspServices([]); setLspError(null); setLspForm({ provider: "", clientNumber: "", description: "" });
    setConfirmDeleteLspId(null); setConfirmDeleteInvoiceId(null);
    setFixedExpenses([]); setFxTarget(""); setFxError(null);
    void fetchCoeficientes(c.id); void fetchRubros(c.id);
    void fetchLspServices(c.id); void fetchFixedExpenses(c.id);
    // Tanda 2 (obligaciones):
    obligations.clear();
    if (activePeriodId) obligations.load(activePeriodId);
  },
});
const closePeriod = useClosePeriod({
  consortiumId: detail.selectedId,
  periodId: detail.selectedPeriod?.id,
  onClosed: () => { void fetchConsortiums(); void detail.reloadAfterClose(); },
});
```

La costura es **temporal y se achica sola**: cuando la Tanda 3 extraiga el modal de Configuración a su propio
hook, el bloque de config del callback se reduce a algo como `config.load(c.id)`. El estado de Tanda 3 se
mueve una sola vez, en su tanda.

## 5. Preservar comportamiento (quirks reales — NO se "arreglan")

- **Cambiar de período recarga boletas pero NO obligaciones.** `handleSelectPeriod` (actual línea 822) solo
  llama `fetchInvoices`, no `fetchObligations`. `selectPeriod` en el hook debe replicar esto **exacto** (no
  agregar recarga de obligaciones aunque parezca lógico).
- **`selectConsortium` carga obligaciones solo del período activo inicial** (vía el callback), no en cambios
  de período posteriores.
- **`close-period`** refresca `consortiums` (`fetchConsortiums`, en page) + re-corre la cascada de detalle
  (`detail.reloadAfterClose`), no la config.
- **Deep-link:** al restaurar por `?c=`, si el id no existe (consorcio borrado) se limpia la URL y se cae al
  grid — comportamiento actual, se preserva. Al `back()`, se limpia la URL.

## 6. Orden de extracción (contrato del spec paraguas §6)

Cada paso: mover-no-reescribir → test (tier según §6.1 del paraguas) → typecheck + lint + build + vitest →
smoke → commit (owner, GitLens).

1. **`useObligations`** (+ test tier 1) — el más aislado. `page.tsx` lo cablea (el reset/carga en el callback
   de selección + los botones de generar/cambiar estado de la solapa Obligaciones).
2. **`useClosePeriod` + `ClosePeriodModal`** (+ tests tier 1/2) — patrón Tanda 1 ya validado.
3. **`useConsortiumDetail`** (+ tests tier 1) — el grande. Se cablea con el fan-out (§4), se conecta
   `useObligations`/`useClosePeriod`, y **se elimina el hack `handleSelectConsortiumRef`**. Es el paso con
   más superficie: extraer estado + cascada + restauración + navegación, verificando que el detalle
   (selección, cambio de período, tabs, búsqueda, deep-link F5) se comporta idéntico.
4. **Docs** — `progreso.md`, `decisiones.md`, `CHANGELOG.md` (y `CLAUDE.md` si cambia alguna convención).

## 7. Verificación

Igual que Tanda 1 (spec paraguas §6): typecheck + lint + build + `vitest run` (node + jsdom) + smoke visual.
Tests nuevos por tier: `useObligations`/`useClosePeriod`/`useConsortiumDetail` → tier 1 (`renderHook`, `fetch`
mockeado); `ClosePeriodModal` → tier 2 (`render` + `user-event`). El smoke visual interactivo del detalle
(selección, cascada, deep-link F5, cambio de período, cerrar período) lo confirma el owner con sesión
autenticada post-deploy; los tests tier 1/2 cubren la lógica y el render.

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|-----------|
| `useConsortiumDetail` es grande y toca la cascada + restauración | Se extrae último (paso 3), con los satélites ya en su lugar; contrato mover-no-reescribir; tests tier 1 de las transiciones (select → periods → invoices, selectPeriod, back, restore). |
| Cambiar timing de la cascada sin querer | Replicar exacto el orden de `handleSelectConsortium` (fetches disparados + await de `fetchPeriodsAndInvoices` antes de invoices/obligations). Los quirks de §5 se preservan literalmente. |
| El callback fan-out deja estado de Tanda 3 "colgado" en page.tsx | Es intencional y temporal (§4): se documenta que ese bloque se disuelve en la Tanda 3. No se toca el estado de config ahora. |
| `closeError`/`closeSuccess` se muestran fuera del modal | El plan lee el JSX exacto y preserva dónde se ven (§3.3). |

## 9. Documentación a actualizar (regla del proyecto)

Al cerrar la Tanda 2: `docs/progreso.md` (Tanda 2 completa + qué queda de Tanda 3), `docs/decisiones.md`
(decisión de la costura fan-out para extracción incremental de dominios acoplados), `CHANGELOG.md` (entrada
2026-07-16). `CLAUDE.md` solo si cambia una convención (no se espera).
