# Spec — Feedback de carga en botones de acción (`AsyncButton`)

- **Fecha:** 2026-07-09
- **Estado:** Draft (aprobado el enfoque en brainstorming)
- **Objetivo:** que toda acción de mutación del panel dé feedback visible mientras corre y no se pueda
  disparar dos veces por doble click.

---

## 1. Contexto y motivación

Al agregar un gasto fijo no hay ningún indicador de que la acción está en curso, así que el usuario
vuelve a hacer click y se crea el gasto dos veces. La mayoría del panel **ya** resuelve esto con un
estado `saving` por acción (`savingConsortium`, `savingInvoice`, `savingLsp`, `savingPayment`, etc.:
botón deshabilitado + "Guardando…"), pero **los botones nuevos de gastos fijos/obligaciones no lo
tienen**. En vez de repetir ese boilerplate, se introduce un componente reutilizable `AsyncButton` que
encapsula el patrón (patrón DRY) y además **corta el doble click** con un guard interno.

## 2. Decisiones (brainstorming)
- **Alcance:** todas las acciones de alta/mutación del panel deben tener feedback. Se hace en **2 fases**.
- **Mecanismo:** a nivel botón (deshabilitar + spinner/label mientras corre). Sin overlay global.
- **Componente reutilizable** `AsyncButton` (no seguir duplicando el estado `saving` a mano).

## 3. Componente `AsyncButton`

`src/components/AsyncButton.tsx` (client component).

**Comportamiento:**
- Recibe un `onClick` que puede devolver `Promise`. Mientras la promesa está pendiente:
  - el botón queda **deshabilitado** (`disabled || pending`),
  - muestra un **spinner** + `pendingLabel` (o los `children` si no se pasa `pendingLabel`),
  - `aria-busy={true}`.
- **Guard anti doble-click:** un `ref` corta la segunda invocación aunque React todavía no haya
  re-renderizado el `disabled` (click muy rápido).
- No hace `setState` si el componente se desmontó mientras corría (evita warning).
- Es **drop-in**: acepta el resto de props de `<button>` (`className`, `style`, `type`, `title`,
  `disabled`), así reemplaza a los `<button onClick>` existentes sin cambiar estilos.

**API:**
```tsx
type AsyncButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  onClick: () => void | Promise<void>;
  pendingLabel?: React.ReactNode; // opcional: texto mientras corre (ej. "Agregando…")
  children: React.ReactNode;
};
```

**Spinner:** clase `.asyncSpinner` (keyframes) en `src/app/globals.css`, reutilizable. Un `<span>` de
~12px que rota; hereda color del texto (`currentColor`).

## 4. Fase 1 (este spec): aplicar a los botones sin feedback

En `src/app/admin/consortiums/page.tsx`, reemplazar por `AsyncButton` los botones nuevos que hoy no
dan feedback:
- **Agregar gasto fijo** (`handleAddFixedExpense`) — `pendingLabel="Agregando…"`.
- **Generar obligaciones** (`handleGenerateObligations`) — `pendingLabel="Generando…"`.
- **Activar/Desactivar** gasto fijo (`handleToggleFixedExpense`) — por fila.
- **Quitar** gasto fijo (`handleDeleteFixedExpense`) — por fila.
- **Omitir/Reactivar** obligación (`handleSetObligationStatus`) — por fila.

Los handlers deben **await-ear también el refetch** de la lista (`fetchFixedExpenses` / `fetchObligations`)
para que el spinner se mantenga hasta que la vista se actualice (hoy algunos usan `void`).

> Los botones por fila se benefician especialmente: cada `AsyncButton` maneja su propio `pending`, así no
> hace falta un `busyId`/`deletingId` por fila.

## 5. Fase 2 (follow-up, incremental — NO en este spec)

Migrar a `AsyncButton` los botones que ya tienen su estado `saving` manual (Crear consorcio, Guardar
boleta, Crear proveedor, Agregar LSP, Registrar pago, Guardar match names, Cerrar período, Sincronizar
directorio, Reprocesar, rubros/coeficientes…), **borrando** su `useState(saving)` + `disabled` + ternario
de label. Sin urgencia (ya tienen feedback); se hace oportunistamente al pasar cerca. Uniforma el patrón
y elimina boilerplate.

## 6. Testing / verificación
- Test unitario del guard del componente si es viable con jsdom; si no, verificación manual (doble click
  rápido no duplica; el botón muestra el spinner y se re-habilita al terminar, incluso si la request falla).
- `npm run typecheck` + `npm run lint` + `npm test` + `npm run build:jobs`.

## 7. Fuera de alcance
- Overlay/toast global.
- Migración de los botones que ya funcionan (es la Fase 2).
- Otras páginas fuera del panel de consorcios (se evalúan aparte si hace falta).
