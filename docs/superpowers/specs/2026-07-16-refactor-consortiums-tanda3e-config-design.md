# Spec — Refactor `consortiums/page.tsx`, sub-tanda 3e (Config) · cierre del refactor

**Fecha:** 2026-07-16 (ejecutada 2026-07-27)
**Tipo:** Refactor de deuda técnica (Fase 2 del análisis del 2026-07-15).
**Relación:** Última sub-tanda de la Tanda 3. Hereda arquitectura, convenciones y contrato de verificación
del **spec paraguas** `2026-07-16-refactor-consortiums-page-design.md` y del **spec de Tanda 3**
`2026-07-16-refactor-consortiums-tanda3-design.md` (§1 lista a 3e como la que *disuelve el fan-out*).
Este spec **no redefine** ninguna de esas convenciones: solo resuelve los dos forks propios de 3e.
**Estado de partida (verificado):** `page.tsx` en **1268 líneas**, **394 tests** verdes, working tree limpio.

---

## 1. Alcance

Extraer el dominio **Config** (el modal de Configuración del consorcio: acordeón de 3 secciones
—nombres alternativos / servicios LSP / gastos fijos—) a un hook + un componente, y **disolver el fan-out**
del callback `onConsortiumSelected` de `useConsortiumDetail`.

**Entra:** `editingMatchNames`, `matchNamesValue`, `savingMatchNames`/`runMatchNames`, `matchNamesMsg`,
`showConfigModal`, `fixedExpenses`, `fxTarget`, `fxError`, `lspServices`, `lspForm`, `lspError`,
`confirmDeleteLspId`, `openConfigSection`; los handlers `handleSaveMatchNames`, `handleAddLsp`,
`handleDeleteLsp`, `handleAddFixedExpense`, `handleToggleFixedExpense`, `handleDeleteFixedExpense`;
los fetches `fetchLspServices` y `fetchFixedExpenses`; y el JSX del modal (líneas 958-1143).

**No entra (se queda en `page.tsx`):**
- **Datos de referencia** `coeficientes` / `rubros` + `fetchCoeficientes` / `fetchRubros` → los consume
  `InvoiceModal` (3d), no son de config (ver §3, fork 2).
- **`providers`** → se queda igual (lo consumen `InvoiceModal` y `useProviderForm`); el modal Config lo
  recibe **por props**, como hoy lo lee del scope.
- **`confirmDeleteInvoiceId`** → es el confirm de borrar boleta de la pestaña Boletas.
- Repositories / logger / `schedulerControl` (no-objetivos del paraguas §2).

## 2. Hallazgo que condiciona el diseño

Leyendo el JSX (líneas 1088-1130), **las 3 secciones del acordeón no son independientes**:

- La sección **Gastos fijos** consume `lspServices` para (a) resolver el label de cada fila
  (`lspServices.find((l) => l.id === fx.lspServiceId)`) y (b) armar el `<optgroup>` "Servicios (LSP)" del
  select de alta. También consume `providers` para el `<optgroup>` "Proveedores" y el label de proveedor.
- El estado `openConfigSection` (`"matchNames" | "lsp" | "fixed" | null`) es **uno solo compartido** por las
  tres: por definición del acordeón, abrir una cierra la otra.

O sea: los tres sub-dominios comparten datos y un estado de UI común. Cualquier corte en 3 hooks tendría
que re-componerlos igual.

## 3. Decisiones de diseño (los dos forks de 3e)

| # | Decisión | Alternativas descartadas |
|---|----------|--------------------------|
| 1 | **Un solo `useConsortiumConfig` + un solo `ConfigModal`**, con el estado agrupado en sub-objetos (`matchNames` / `lsp` / `fixed`) para que la interfaz siga siendo legible. | **3 sub-hooks compuestos** (`useMatchNames`/`useLspServices`/`useFixedExpenses`): más granular, pero por §2 `fixed` necesita recibir `lspServices` del hook vecino y el `load` hay que componerlo a mano → 4 archivos para el mismo acoplamiento. **3 sub-hooks + 3 sub-componentes**: ~8 archivos nuevos para un modal que se abre desde un único botón; sobre-ingeniería. El patrón validado 7 veces es **1 dominio = 1 hook + 1 componente**. |
| 2 | **`coeficientes`/`rubros` se quedan en `page.tsx`** (no se crea `useReferenceData`). | Extraerlos ahora mezcla dos ciclos de vida (`providers` carga al montar; `coeficientes`/`rubros` por consorcio) y obliga a tocar el wiring de `useProviderForm` y de `addCoeficiente`/`addRubro` del `InvoiceModal` — cirugía fuera del dominio Config, en la tanda más delicada. Es el YAGNI que ya anticipaba `docs/progreso.md`. |
| 3 | **`providers` viaja por props al `ConfigModal`** (no lo fetchea el hook). | Que el hook lo fetchee duplicaría la carga que ya hace `page.tsx` al montar. |
| 4 | **El `setSelectedConsortium` post-guardado se hace vía callback `onMatchNamesSaved(matchNames)`** que `page.tsx` cablea. | Pasarle el setter de `useConsortiumDetail` al hook de config lo acoplaría al dominio detalle. El callback cross-dominio es el patrón ya usado en 3a-3d (`onSaved`, `onCreated`, `onClosed`, `onExecuted`). |

## 4. Interfaz del hook

```ts
useConsortiumConfig({ consortiumId, onMatchNamesSaved }: {
  consortiumId: string | null;
  onMatchNamesSaved: (matchNames: string | null) => void;
}) => {
  isOpen, open(consortium), close,
  openSection, toggleSection,
  matchNames: { editing, value, msg, saving, setValue, startEdit, cancelEdit, save },
  lsp:        { services, form, error, confirmDeleteId, setForm, setConfirmDeleteId, add, remove },
  fixed:      { list, target, error, setTarget, add, toggle, remove },
  load(consortium),
}
```

- **`load(c)`** — reproduce **exacto** los resets de config del fan-out actual + dispara
  `fetchLspServices(c.id)` y `fetchFixedExpenses(c.id)` (fire-and-forget, como hoy). Es lo único que
  `page.tsx` invoca desde `onConsortiumSelected`.
- **`open(c)`** — reproduce **exacto** el bloque del botón "Configuración" (líneas 710-716):
  `setMatchNamesValue(c.matchNames ?? "")`, `setEditingMatchNames(false)`, `setMatchNamesMsg(null)`,
  `setOpenSection(null)`, `setIsOpen(true)`.
- **`toggleSection(s)`** — `setOpenSection((prev) => prev === s ? null : s)` (comportamiento acordeón).
- **`matchNames.save`** — `run(...)` de `useAsyncAction` (preserva `savingMatchNames`), PATCH al consorcio,
  y en éxito: `onMatchNamesSaved(data.consortium.matchNames)` + `setEditing(false)` + msg "Guardado
  correctamente" con el `setTimeout(..., 3000)` que lo limpia. Preservado tal cual.
- El hook **no** recibe `providers`: `fixed.add` solo necesita `fxTarget` (`"provider:<id>"` / `"lsp:<id>"`).

## 5. Props del componente

```ts
ConfigModal({
  consortiumName, saving, openSection, onToggleSection, onClose,
  matchNames: { editing, value, msg, onChangeValue, onStartEdit, onCancelEdit, onSave },
  lsp:        { services, form, error, confirmDeleteId, onChangeForm, onConfirmDelete, onAdd, onDelete },
  fixed:      { list, target, error, onChangeTarget, onAdd, onToggle, onDelete },
  providers,
})
```

Presentacional puro: sin fetch, sin estado propio. Importa `styles` del `page.module.css` compartido y
`LSP_PROVIDERS` de `lib/constants` (igual que hoy en `page.tsx`).

## 6. La disolución del fan-out (el corazón de 3e)

**Antes** (`page.tsx` 162-173):

```tsx
onConsortiumSelected: (c, activePeriodId) => {
  setEditingMatchNames(false); setMatchNamesMsg(null); setMatchNamesValue(c.matchNames ?? "");
  setLspServices([]); setLspError(null); setLspForm({ provider: "", clientNumber: "", description: "" });
  setConfirmDeleteLspId(null); setConfirmDeleteInvoiceId(null);
  setFixedExpenses([]); setFxTarget(""); setFxError(null);
  void fetchCoeficientes(c.id); void fetchRubros(c.id);
  void fetchLspServices(c.id); void fetchFixedExpenses(c.id);
  clearObligations();
  if (activePeriodId) void loadObligations(activePeriodId);
},
```

**Después:**

```tsx
onConsortiumSelected: (c, activePeriodId) => {
  void fetchCoeficientes(c.id); void fetchRubros(c.id);  // datos de referencia (se quedan)
  setConfirmDeleteInvoiceId(null);                        // confirm de la pestaña Boletas (se queda)
  config.load(c);                                         // matchNames + LSP + gastos fijos
  clearObligations();
  if (activePeriodId) void loadObligations(activePeriodId);
},
```

**Orden de declaración:** `config` se declara **después** de `detail` (necesita `selectedId`), pero el
callback lo referencia. No hay TDZ: el arrow se **ejecuta** en un event handler posterior al render, cuando
el `const config` ya está inicializado — y `selectConsortium` está memoizado con `onConsortiumSelected` en
sus deps, así que siempre corre la versión más reciente del arrow. (Mismo razonamiento que la Tanda 2.) El
`typecheck` valida que TypeScript acepte la referencia adelantada dentro del closure.

**Orden de efectos preservado:** los fetches son fire-and-forget; lo que importa es el estado final. Los
resets de config se ejecutan dentro de `config.load(c)` antes de sus fetches, igual que hoy.

## 7. Pasos (atómicos, cada uno deja el árbol verde)

1. **`hooks/useConsortiumConfig.ts` + `useConsortiumConfig.test.tsx`** (tier 1) — mover estado, fetches y
   los 6 handlers tal cual. Todavía no se toca `page.tsx`.
2. **`components/ConfigModal.tsx` + `ConfigModal.test.tsx`** (tier 2) — mover el JSX 958-1143 tal cual,
   cambiando solo lecturas de scope por props.
3. **Wiring en `page.tsx`** — declarar `config`, montar `<ConfigModal>`, apuntar el botón "Configuración" a
   `config.open(selectedConsortium)`, **disolver el fan-out** (§6) y borrar el estado/handlers/JSX movidos.
4. **Verificación completa + docs.**

Los pasos 1-2 son aditivos (no rompen nada); el 3 es el que cambia comportamiento potencial y se verifica
entero.

## 8. Tests

**Tier 1 — `useConsortiumConfig.test.tsx`** (`renderHook`, `guardedFetch` mockeado):
- `open(c)` abre con el valor de `matchNames` del consorcio y la sección colapsada; `close` cierra.
- `toggleSection` abre y cierra la misma sección (comportamiento acordeón).
- `load(c)` resetea el estado del consorcio anterior y carga LSP + gastos fijos.
- `matchNames.save` OK → llama `onMatchNamesSaved` con el valor de la respuesta y sale del modo edición.
- `lsp.add` sin empresa / sin número → setea `lspError` y no hace POST.
- `fixed.add` con `target` de proveedor → POST con `{ providerId }` y recarga la lista.

**Tier 2 — `ConfigModal.test.tsx`** (`render` + `user-event`):
- Renderiza el nombre del consorcio y las 3 cabeceras del acordeón colapsadas.
- Click en una cabecera dispara `onToggleSection` con la clave correcta.
- Con `openSection="lsp"` y servicios cargados, la tabla los muestra y "Agregar" dispara `lsp.onAdd`.

## 9. Verificación (heredada del paraguas §6)

`npm run typecheck` + `npm run lint` (0 errores; único warning baseline: `uploadingReceiptId`) +
`npx vitest run` (node + jsdom) + `npm run build:jobs` + `npm run build`.
**Smoke visual (owner, post-deploy, sesión autenticada):** abrir Config; editar nombres alternativos y
verificar que persiste en la tarjeta del consorcio; agregar/borrar un LSP; agregar/togglear/borrar un gasto
fijo; **cambiar de consorcio** y confirmar que el acordeón se resetea y carga los datos del nuevo.

## 10. Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|-----------|
| La disolución del fan-out pierde un reset y el consorcio B muestra datos de A | `load(c)` reproduce los resets **literales**; test tier 1 de `load` que afirma que la lista previa quedó vacía y se recargó. Smoke del owner cambia de consorcio explícitamente. |
| TDZ / orden de declaración de `config` vs `detail` | El callback corre en tiempo de ejecución, no de declaración (§6); lo confirma `typecheck` + el test tier 1 de la cascada ya existente. |
| `fixed` pierde el acceso a `lspServices`/`providers` para labels y optgroups | Ambos viajan al componente: `lsp.services` sale del hook, `providers` por props desde `page.tsx` (§3, decisión 3). |
| El acordeón cambia de comportamiento al mover el `setOpenConfigSection` funcional | `toggleSection` conserva la forma funcional `prev === s ? null : s`; test tier 1 dedicado. |
| `savingMatchNames` bloqueaba el cierre por overlay (`onClick={() => !savingMatchNames && setShowConfigModal(false)}`) | `saving` viaja como prop al modal y el overlay conserva el guard. |

## 11. Documentación (regla del proyecto)

Al cerrar: `docs/progreso.md` (3e completa + **refactor cerrado**), `CHANGELOG.md` (entrada del día), y
`docs/decisiones.md` — 3e **sí** toma una decisión registrable: **la disolución del fan-out** (por qué el
callback cross-dominio + `load()` reemplaza al bloque de setters, y por qué los datos de referencia se
quedaron afuera).
