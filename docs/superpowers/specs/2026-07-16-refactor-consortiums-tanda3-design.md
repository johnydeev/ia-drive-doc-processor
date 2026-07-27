# Spec — Refactor `consortiums/page.tsx`, Tanda 3 (paraguas) + sub-tanda 3a (Pagos)

**Fecha:** 2026-07-16
**Tipo:** Refactor de deuda técnica (Fase 2 del análisis del 2026-07-15).
**Relación:** Cierra el refactor de `consortiums/page.tsx`. Hereda arquitectura, convenciones y contrato de
verificación del **spec paraguas** `docs/superpowers/specs/2026-07-16-refactor-consortiums-page-design.md`
(este spec NO los redefine). Tandas 1 y 2 ya completas (ver `docs/progreso.md`).
**Estado de partida:** `page.tsx` en 2297 líneas, 65 `useState`.

---

## 1. Paraguas Tanda 3 — descomposición y orden

El estado restante en `page.tsx` se agrupa en 5 sub-dominios, cada uno del tamaño de un modal. La Tanda 3 se
ejecuta como **sub-tandas independientes**, en orden **menor a mayor por acoplamiento** (decisión de
brainstorming: minimiza solapamiento y riesgo, deja los pesados acoplados para el final):

| # | Sub-tanda | Contenido | Acoplamiento |
|---|-----------|-----------|--------------|
| 3a | **Pagos** | modal Pagar + modal Ver pagos | Autocontenido (disparado por callbacks de `PagosView`) |
| 3b | **Modales globales** | Cerrar Período General + Sin Asignar | Autocontenido (toolbar, no toca el detalle) |
| 3c | **Shell** | scheduler + toolbar + sidebar/tema + auth/access | Ortogonal al detalle |
| 3d | **Modal Boleta** | crear/scan/mismatch | Usa datos de referencia (providers/coeficientes/rubros) |
| 3e | **Config** | acordeón matchNames/LSP/gastos fijos | **Disuelve el fan-out de la Tanda 2** |

Cada sub-tanda = un hook por dominio + componente presentacional + tests (tier 1 hook / tier 2 componente) +
commit del owner. Cada una hereda el contrato "mover, no reescribir" + verificación por paso del paraguas
(§6). **3d y 3e** llevarán su propio mini-spec **solo si** aparecen forks de diseño reales (el flujo de scan
de 3d; el acordeón de 3 secciones de 3e). 3a/3b/3c son extracciones que siguen el patrón validado y se
planifican directo.

**Datos de referencia (nota transversal):** `providers`, `coeficientes`, `rubros` los consumen el modal
Boleta (3d) y el Config (3e). Se quedan en `page.tsx` hasta 3d; si conviene, se aíslan en un `useReferenceData`
como primer paso de 3d. No es alcance de 3a-3c.

**Fan-out (Tanda 2):** el callback `onConsortiumSelected` seguirá disparando el estado de config hasta 3e.
3a-3d no lo tocan. En 3e, al extraer Config a su hook, el bloque de config del callback se reduce a
`config.load(c.id)`.

## 2. Sub-tanda 3a — Pagos (detalle ejecutable)

Dos modales, ambos disparados desde los callbacks que `PagosView` ya expone (`onPagar`, `onVerPagos`,
`onPagoGuardado`, `onEliminarUltimoPago`). Son autocontenidos: operan sobre una `Invoice` y recargan la lista
vía `reloadInvoices` (ya expuesto por `useConsortiumDetail` en la Tanda 2).

### 2.1 Unidades

- **`hooks/usePayModal.ts`** — estado del modal Pagar: `payModalInvoice`, `existingPayments`,
  `loadingExistingPayments`, `chosenMode` (`"cuotas" | "libre"`), `payForm`, `payFile`, `payError`, y
  `useAsyncAction` (`savingPayment`/`runPayment`). Interfaz:
  `usePayModal({ onSaved })` → `{ invoice, existingPayments, loadingExisting, mode, setMode, form, setField,
  file, setFile, error, saving, open, close, submit }`.
  - `open(inv)`: setea la invoice y carga los pagos existentes (`GET .../payments`).
  - `submit`: arma el body según modo (cuotas/libre), pega a `POST .../payments`, y en éxito cierra +
    `onSaved()` (page pasa `reloadInvoices`).
- **`components/PayModal.tsx`** — presentacional: formulario con selección de modo cuotas/libre, importe,
  fecha, medio de pago, comprobante. Props explícitas; sin fetch propio.
- **`hooks/useViewPayments.ts`** — estado del modal Ver pagos: `viewPaymentsInvoice`, `viewPaymentsList`,
  `loadingViewPayments`. Interfaz: `useViewPayments()` → `{ invoice, list, loading, open, close }`.
  `open(inv)` carga los pagos (read-only).
- **`components/ViewPaymentsModal.tsx`** — presentacional: lista read-only de pagos.

### 2.2 Tipos

`PaymentMode` y `PaymentRecord` (hoy definidos dentro del componente `ConsortiumsPage`) se mueven a
`lib/types.ts` y se importan desde los hooks/componentes. `PendingPaymentInput` ya vive en `PagosView.tsx`
(no se toca).

### 2.3 Wiring en `page.tsx`

```tsx
const payModal = usePayModal({ onSaved: reloadInvoices });
const viewPayments = useViewPayments();
// ...
<PagosView
  invoices={invoices}
  onPagoGuardado={reloadInvoices}
  onPagar={payModal.open}
  onVerPagos={viewPayments.open}
  onEliminarUltimoPago={/* se mantiene (opera sobre la lista); revisar en el plan si conviene moverlo */}
/>
// ...montaje de los modales:
{payModal.invoice && <PayModal {...} />}
{viewPayments.invoice && <ViewPaymentsModal {...} />}
```

Se borran de `page.tsx`: el estado de pago (371-385) + `viewPayments` (525-527), y los handlers
`handleOpenPayModal`/`handleClosePayModal`/`handleSubmitPayment`/`handleOpenViewPayments` + el JSX de ambos
modales. `onPagoGuardado` pasa a `reloadInvoices` (el actual ya recarga la lista — el plan verifica que sea
equivalente).

### 2.4 Quirks a preservar (el plan lee el código exacto)

- Los **dos modos de pago** (cuotas/libre) y cómo `submit` arma el body según `chosenMode` — se mueven tal
  cual, sin cambiar la lógica de clasificación.
- La **carga de pagos existentes** al abrir el modal Pagar (para mostrar el estado actual antes de registrar)
  se preserva.
- `onEliminarUltimoPago` y `onPagoGuardado` deben seguir recargando la lista igual que hoy.

## 3. Verificación (heredada del paraguas §6)

Por cada paso: mover-no-reescribir → test (tier 1 hooks / tier 2 componentes) → `npm run typecheck` + `lint`
+ `vitest run` (node + jsdom) + `build:jobs` + smoke visual → commit (owner, GitLens). El smoke interactivo
de pagos (registrar pago en modo libre y cuotas, ver pagos, eliminar último pago) lo confirma el owner con
sesión autenticada post-deploy; los tests tier 1/2 cubren la lógica y el render.

## 4. Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|-----------|
| El modal Pagar tiene lógica de 2 modos + carga de existentes | Mover-no-reescribir; tests tier 1 de `submit` en ambos modos y de `open` cargando existentes. |
| `PagosView` ya extraído — el wiring de callbacks debe seguir igual | Los callbacks (`onPagar`/`onVerPagos`/`onPagoGuardado`) se re-apuntan a los nuevos hooks sin cambiar la firma que `PagosView` espera. |
| Tipos `PaymentMode`/`PaymentRecord` compartidos | Se mueven a `lib/types.ts` (una vez), importados por hooks/componentes. |

## 5. Documentación (regla del proyecto)

Al cerrar cada sub-tanda: `docs/progreso.md` (sub-tanda completa + qué queda de Tanda 3), `CHANGELOG.md`.
`docs/decisiones.md` solo si la sub-tanda toma una decisión nueva (p. ej. 3e y la disolución del fan-out).
