# Spec — Refactor incremental de `consortiums/page.tsx`

**Fecha:** 2026-07-16
**Tipo:** Refactor de deuda técnica (Fase 2 del análisis de refactor del 2026-07-15)
**Origen:** Candidato #3 del análisis relevado en la sesión 44 (ver `docs/progreso.md` → "Análisis de refactor (2026-07-15)").
**Naturaleza:** Spec paraguas (arquitectura destino + roadmap completo) + detalle ejecutable de la 1ª tanda. Las tandas 2 y 3 se planifican al cerrar cada una.

---

## 1. Problema

`src/app/admin/consortiums/page.tsx` es un god-component:

- **3105 líneas** en un solo archivo, un único `"use client"` component (`ConsortiumsPage`).
- **91 `useState`** y 11 `useEffect` en el componente principal.
- **~9 modales inline** (Cerrar período, Boleta crear/scan, Mismatch, Crear proveedor, Crear consorcio, Configuración con acordeón, Pagar, Ver pagos, Cerrar Período General, Sin Asignar), cada uno con su propio bloque de estado embebido.
- Un único `page.module.css` de ~37 KB compartido por todo.

Cada feature nueva lo engorda y cualquier edición es riesgosa porque todo el estado convive en un solo scope. **No tiene tests de UI**: la infra de tests hoy no los soporta — Vitest corre en `environment: "node"` e incluye solo `*.test.ts` (sin jsdom ni testing-library), y el comentario del `vitest.config.ts` describe ese alcance: *"Entorno node: los tests cubren librerías/lógica pura, no componentes React."* No hay una decisión formal en `docs/decisiones.md` que prohíba testear React; es el estado de-facto del setup.

El problema real **no son las líneas**: son los 91 `useState` en un solo scope. Extraer JSX a componentes sin tocar el estado no resuelve nada.

## 2. Objetivo y no-objetivos

**Objetivo:** partir el componente en dominios aislados —hooks + componentes presentacionales— **sin cambiar ningún comportamiento observable**. Que `page.tsx` termine siendo un orquestador legible.

**No-objetivos (fuera de alcance):**
- Rediseño visual o cambios de UX.
- Tocar la API/backend o el schema.
- Refactorizar `logger.ts`, `schedulerControl.service.ts`, los repositories o `useAuthGuard` (el análisis los marcó como cohesivos/estables; `guardedFetch` ya está centralizado — fue falso positivo).
- Optimizaciones de performance (memoización, split de contextos) salvo que sean neutrales al comportamiento y necesarias para no romper nada.

## 3. Decisiones de diseño (tomadas en brainstorming)

| # | Decisión | Alternativas descartadas |
|---|----------|--------------------------|
| 1 | **Entregable:** spec paraguas (arquitectura + roadmap) + plan solo de la 1ª tanda | Plan completo de las 3105 líneas de una (riesgo de desactualizarse a mitad); spec chico sin visión de conjunto (cada tanda re-decide convenciones). |
| 2 | **Estado:** custom hooks por dominio (`useX()` encapsula estado + efectos + handlers) | Context+Provider central (riesgo de re-render storms, más invasivo, difícil de extraer incrementalmente); `useReducer` por dominio (verboso para UI con muchos forms, no parte el archivo por sí solo). |
| 3 | **Verificación:** TypeScript + lint + build + smoke visual + **tests progresivos por tier**. Se monta la infra de tests de UI (jsdom + testing-library) en esta 1ª tanda y se agrega un test por cada pieza extraída, de lo más barato/valioso a lo más frágil (ver §6.1). | Solo lógica pura sin jsdom (deja hooks y JSX sin red — es el mayor riesgo del refactor); tests de flujos full-page (tier 3: frágiles, mockean `fetch`, bajo ROI — se omiten). |
| 4 | **1ª tanda:** piezas de menor riesgo para validar el patrón | Atacar el núcleo enredado primero (`useConsortiumDetail`) — apuesta las convenciones sin validarlas; empezar por el modal de Configuración (pesado, no es arranque seguro). |

## 4. Arquitectura destino

```
src/app/admin/consortiums/
├── page.tsx            # orquestador delgado: compone hooks + layout + monta modales
├── page.module.css     # se mantiene compartido en tanda 1 (co-locación se evalúa luego)
├── lib/
│   ├── types.ts        # Period, Coeficiente, Rubro, Consortium, Provider, Invoice, InvoiceForm,
│   │                   #   ScannedData, FixedExpenseRow, ObligationRow, LspService, PaymentRecord,
│   │                   #   PaymentMode, PendingPaymentInput, ThemeMode, CloseAllPreview, ...
│   ├── constants.ts    # TIPOS_COMPROBANTE, TIPOS_GASTO, MONTH_NAMES, LSP_PROVIDERS, EMPTY_INVOICE_FORM
│   ├── format.ts       # formatPeriod, formatAmount, formatAmountPlain, parseAmountInput,
│   │                   #   formatDate, toInputDate, todayInputDate
│   ├── format.test.ts
│   ├── match.ts        # matchProvider, normName, slugifyName, consortiumUrlKey, idFromUrlKey
│   └── match.test.ts
├── hooks/              # un hook por dominio + su *.test.tsx (jsdom), se agregan por tanda
│                       #   (useConsortiumForm, useProviderForm, useConsortiumDetail,
│                       #    useObligations, useFixedExpenses, useLspServices, usePayments,
│                       #    useScheduler, ...)
└── components/         # componentes presentacionales + su *.test.tsx (jsdom), por tanda
                        #   (ConsortiumFormModal, ProviderFormModal, PagosView, ...)
```

**Infra de tests de UI (se monta en la tanda 1, una sola vez):**

```
vitest.config.ts        # pasa a usar test.projects: dos proyectos
                        #   • "node":  environment node,  include ["src/**/*.test.ts"]   (los 299 actuales, intactos)
                        #   • "jsdom": environment jsdom,  include ["src/**/*.test.tsx"]  + setupFiles
vitest.setup.ts         # nuevo: import "@testing-library/jest-dom/vitest" + cleanup automático
package.json (devDeps)  # + jsdom, @testing-library/react, @testing-library/user-event,
                        #   @testing-library/jest-dom
```

- **Convención de nombres:** tests de lógica pura → `*.test.ts` (node); tests de hooks/componentes → `*.test.tsx` (jsdom). El split por extensión mantiene los 299 tests actuales sin tocar y aísla el entorno.
- `npm test` corre ambos proyectos. La elección de **jsdom** (vs happy-dom) es por máxima compatibilidad y documentación con Vitest + testing-library; si la velocidad molesta, happy-dom es un swap posterior de una línea.

## 5. Patrón de extracción repetible (convención)

Cada dominio = **un hook + (opcional) un componente presentacional**:

- **`useX()`** (en `hooks/`): encapsula sus `useState`, `useEffect` y handlers (incluidos los `fetch` a la API). Expone un objeto `{ ...estado, ...acciones }` tipado. **Cero JSX.**
- **`<XModal>` / `<XView>`** (en `components/`): presentacional. Recibe **props explícitas** (datos + callbacks). No hace fetch propio (usa lo que el hook le pasa, o su propio hook si el dominio es autocontenido).
- **Lógica pura** (formateo, parsing, matching) → `lib/*.ts`, cubierta con `.test.ts` en el entorno node actual.
- **`page.tsx`** solo compone: invoca los hooks y pasa props a los componentes.

**Naming:** hooks `useCamelCase.ts`, componentes `PascalCase.tsx`, módulos de lib `camelCase.ts`. Los componentes importan estilos del `page.module.css` compartido (mismo `styles`).

## 6. Contrato "cero cambio de comportamiento" — verificación por paso atómico

Cada paso (mover UNA pieza) debe dejar el árbol verde y commiteable:

1. **Mover, no reescribir** la lógica (copiar la implementación tal cual; solo se ajustan imports y la firma de props/retorno del hook).
2. **Escribir el test de la pieza** según su tier (§6.1) — junto con la extracción, en el mismo paso.
3. `npm run typecheck` → 0 errores.
4. `npm run lint` → 0 errores nuevos (los 13 warnings preexistentes son tolerados).
5. `npm run build` → OK.
6. `npx vitest run` → verde (los 299 previos + los nuevos, node y jsdom).
7. **Smoke visual** en `next dev`: abrir en el navegador el flujo tocado y confirmar que se ve/comporta idéntico.
8. El **owner commitea** (Claude no; regla del proyecto). Cada paso es un commit atómico y reversible.

**Dos redes complementarias, cada una cubre un momento distinto:**
- El **smoke visual** protege *el instante de la extracción* (el test recién existe post-extracción, así que no puede atrapar un cambio introducido en esa misma mudanza — para eso está el ojo humano en el navegador).
- El **test** protege *el futuro* (cualquier cambio posterior sobre esa pieza queda con red). Es la red que hoy no existe y que este refactor construye.

Si el smoke visual o un test revela una diferencia, se corrige en ese mismo paso antes de avanzar (no se acumula deuda entre pasos).

### 6.1 Tiers de test (de mayor a menor ROI)

| Tier | Aplica a | Entorno | Qué afirma |
|---|---|---|---|
| **0 · Lógica pura** | `lib/format.ts`, `lib/match.ts` | node (`*.test.ts`) | Entradas → salidas de funciones puras (formato es-AR, parsing, matching). |
| **1 · Hooks** | `useConsortiumForm`, `useProviderForm`, … | jsdom (`*.test.tsx`, `renderHook`) | Transiciones de estado y validación: p.ej. abrir/cerrar modal, setear error al fallar, resetear el form. Se mockea `fetch`. |
| **2 · Componentes** | `ConsortiumFormModal`, `ProviderFormModal`, `PagosView` | jsdom (`*.test.tsx`, `render` + `user-event`) | Render con props + interacción: escribir en un input y clickear Guardar dispara el callback esperado con los datos correctos. |
| ~~3 · Flujos full-page~~ | *(omitido)* | — | Integración de la página entera: frágil, mockea mucho `fetch`, bajo ROI. Fuera de alcance. |

## 7. Roadmap completo (spec paraguas) — orden por riesgo creciente

- **Tanda 1 (esta — detallada en §8):** `lib/` (tipos + constantes + helpers con tests) → modal **Crear Consorcio** → modal **Crear Proveedor** → mover **`PagosView`**. Estado 100% autocontenido → valida la arquitectura completa en lo barato.
- **Tanda 2:** núcleo de detalle — `useConsortiumDetail` (períodos + boletas + selección + `activeTab` + búsqueda), `useObligations`, modal **Cerrar período**. Es el estado del que más depende todo lo demás.
- **Tanda 3:** los pesados — modal **Boleta** (crear/scan/mismatch), modal **Configuración** (acordeón matchNames/LSP/gastos fijos), modales **Pagar**/**Ver pagos**, **Cerrar Período General**, **Sin Asignar**, `useScheduler`, sidebar/tema.

El orden fino de las tandas 2 y 3 se re-planifica al cerrar cada una (con un plan propio). Este spec fija el inventario y el criterio: **riesgo creciente, estado no-compartido primero, lo más ramificado al final.**

## 8. Detalle de la 1ª tanda (base del plan) — 7 pasos atómicos

Cada paso sigue el contrato de verificación de §6.

1. **`lib/types.ts` + `lib/constants.ts`** — mover los `type`/`interface` del tope del archivo y las constantes (`TIPOS_COMPROBANTE`, `TIPOS_GASTO`, `MONTH_NAMES`, `LSP_PROVIDERS`, `EMPTY_INVOICE_FORM`). Sin lógica. `page.tsx` los importa. *(Riesgo: nulo — solo movimiento de declaraciones.)*
2. **`lib/format.ts` + `format.test.ts`** (tier 0) — mover `formatPeriod`, `formatAmount`, `formatAmountPlain`, `parseAmountInput`, `formatDate`, `toInputDate`, `todayInputDate`. Tests de casos es-AR (incluye `parseAmountInput` con `"97.500,40"`, `"97500.40"`, `"97,500.40"`). *(Riesgo: nulo — funciones puras; ahora con red.)*
3. **`lib/match.ts` + `match.test.ts`** (tier 0) — mover `matchProvider`, `normName`, `slugifyName`, `consortiumUrlKey`, `idFromUrlKey`. Tests de matching de proveedor y de las claves de URL. *(Riesgo: nulo — funciones puras.)*
4. **Montar infra de tests de UI** (una sola vez) — instalar `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom` (devDeps); pasar `vitest.config.ts` a `test.projects` (node → `*.test.ts`, jsdom → `*.test.tsx`); crear `vitest.setup.ts`. **Validar con un test trivial** `*.test.tsx` que renderice un `<div>` y afirme que está en el DOM, y confirmar que los 299 tests node **siguen pasando** sin cambios. *(Riesgo: bajo pero es infra — se aísla en su propio paso/commit para no mezclarlo con una extracción.)*
5. **modal Crear Consorcio** → `hooks/useConsortiumForm.ts` (`showConsortiumModal`, `consortiumForm`, `consortiumError`, `consortiumSuccess`, `handleSaveConsortium`) + `components/ConsortiumFormModal.tsx` (JSX del modal). `page.tsx` usa el hook y monta el componente. **Tests:** tier 1 del hook (abrir/cerrar, error al fallar el `fetch` mockeado, reset del form) + tier 2 del modal (escribir nombre/CUIT → click Guardar → dispara el callback con los datos). *(Riesgo: bajo — estado 100% propio, form chico. Smoke: abrir modal → crear consorcio dummy.)*
6. **modal Crear Proveedor** → `hooks/useProviderForm.ts` + `components/ProviderFormModal.tsx`, análogo al paso 5, con sus tests tier 1 + tier 2. *(Riesgo: bajo. Smoke: abrir modal → crear proveedor dummy.)*
7. **mover `PagosView`** → `components/PagosView.tsx`. Ya es un sub-componente con props (`invoices`, `onPagoGuardado`, `onPagar`, `onVerPagos`, `onEliminarUltimoPago`) y estado propio → mudanza casi mecánica (mover la función + sus tipos auxiliares + imports). **Test:** tier 2 (render con boletas de prueba → interacción de un pago pendiente → dispara `onPagoGuardado`). *(Riesgo: bajo. Smoke: solapa Pagos → cargar/guardar un pago pendiente.)*

**Resultado esperado de la tanda 1:** `page.tsx` baja ~600-700 líneas; `lib/`, `hooks/` y `components/` creados y poblados; **infra de tests de UI montada y validada**; red de tests tier 0/1/2 sobre las piezas extraídas; patrón validado end-to-end; docs actualizadas.

## 9. Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|-----------|
| El JSX/wiring queda sin red a futuro | Este refactor **construye** la red: infra jsdom (paso 4) + tests tier 1/2 por pieza (§6.1). Más el smoke visual obligatorio por paso; el owner commitea cada paso verde (rollback trivial). |
| Cambiar comportamiento sin darse cuenta en la mudanza | Regla "mover, no reescribir" + smoke visual (el test recién nace post-extracción, ver §6); si el smoke o un test muestra diferencia, se corrige antes de avanzar. |
| Montar jsdom rompe o enlentece los 299 tests actuales | Se aísla en su propio paso/commit (paso 4) y se usa `test.projects` con split por extensión: los `*.test.ts` siguen en entorno node intactos; jsdom solo aplica a los `*.test.tsx` nuevos. Se valida que los 299 pasen antes de avanzar. |
| Estado compartido entre dominios enreda la extracción | La tanda 1 se eligió por estado **no compartido**; las dependencias reales (detalle) se enfrentan recién en tanda 2 con plan propio. |
| Romper estilos al mover JSX | Se mantiene el `page.module.css` compartido; los componentes importan el mismo `styles`. Co-locación de CSS se evalúa en tandas futuras (fuera de alcance ahora). |
| Alcance se desborda a refactors vecinos | Lista explícita de no-objetivos (§2); no tocar logger/scheduler/repos/useAuthGuard. |

## 10. Documentación a actualizar (regla del proyecto)

Al cerrar la tanda 1: `docs/progreso.md` (estado de la Fase 2, tanda 1 completa + qué queda), `docs/decisiones.md` (dos decisiones: (a) arquitectura de hooks por dominio + verificación por tiers de test; (b) montaje de infra de tests de UI — jsdom + testing-library con `test.projects` y split por extensión `.test.ts`/`.test.tsx` —, con su razón y alternativas descartadas), `CHANGELOG.md` (entrada 2026-07-16). Actualizar también `CLAUDE.md` (sección Convenciones → Tests) con la nueva convención de extensión y los dos proyectos de Vitest.
