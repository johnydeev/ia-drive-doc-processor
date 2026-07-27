# Refactor `consortiums/page.tsx` — Tanda 2 (núcleo de detalle) · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extraer el núcleo de detalle de `consortiums/page.tsx` —la cascada selección→períodos→boletas, la solapa de obligaciones y el modal Cerrar período— a hooks + componente, **sin cambiar comportamiento**, eliminando de paso el hack `handleSelectConsortiumRef`.

**Architecture:** Un `useConsortiumDetail` cohesivo dueño de la cascada (con fan-out por callback `onConsortiumSelected` hacia el estado de Tanda 3 que sigue en `page.tsx`), `useObligations` satélite, y `useClosePeriod` + `ClosePeriodModal` (patrón Tanda 1). Spec: `docs/superpowers/specs/2026-07-16-refactor-consortiums-tanda2-design.md`. Hereda convenciones y verificación del paraguas `2026-07-16-refactor-consortiums-page-design.md`.

**Tech Stack:** React (hooks) · TypeScript · Vitest (node + jsdom) · @testing-library/react + user-event.

**Regla del proyecto:** Claude **no commitea**; el owner lo hace con GitLens (inglés). Los pasos de "commit" del plan solo listan los archivos; sin mensajes.

**Estrategia de bajo riesgo (clave):** en `page.tsx`, **destructurar cada hook con los mismos nombres** que el JSX ya usa (`selectedPeriod`, `invoices`, `obligations`, `canGoPrev`, `search`, `activeTab`, …). Así el bloque grande de JSX queda **intacto**; solo cambian los call-sites cuya firma cambió (handlers de obligaciones que ahora reciben `periodId`) y el reemplazo del modal de cierre.

---

## Estructura de archivos (Tanda 2)

```
src/app/admin/consortiums/
├── page.tsx                       # MODIFICAR: quita estado/handlers del detalle, cablea 3 hooks + modal
├── hooks/
│   ├── useObligations.ts          # CREAR
│   ├── useObligations.test.tsx    # CREAR (jsdom, tier 1)
│   ├── useClosePeriod.ts          # CREAR
│   ├── useClosePeriod.test.tsx    # CREAR (jsdom, tier 1)
│   ├── useConsortiumDetail.ts     # CREAR
│   └── useConsortiumDetail.test.tsx # CREAR (jsdom, tier 1)
└── components/
    ├── ClosePeriodModal.tsx       # CREAR
    └── ClosePeriodModal.test.tsx  # CREAR (jsdom, tier 2)
```

**Orden de dependencias:** `useObligations` y `useClosePeriod` son independientes; `useConsortiumDetail` se cablea último y conecta a los otros dos vía el fan-out (§ Task 3).

---

## Task 1: `useObligations` (hook satélite)

**Files:**
- Create: `src/app/admin/consortiums/hooks/useObligations.ts`
- Create: `src/app/admin/consortiums/hooks/useObligations.test.tsx`
- Modify: `src/app/admin/consortiums/page.tsx`

**Origen:** `fetchObligations` (page.tsx 667-673), `handleGenerateObligations` (707-711), `handleSetObligationStatus` (713-719), estado `obligations` (360).

- [ ] **Step 1: Escribir el test `useObligations.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useObligations } from "./useObligations";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));

beforeEach(() => guardedFetch.mockReset());

describe("useObligations", () => {
  it("load setea las obligaciones del período", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, obligations: [{ id: "o1" }] }) });
    const { result } = renderHook(() => useObligations());
    await act(async () => { await result.current.load("p1"); });
    await waitFor(() => expect(result.current.obligations).toHaveLength(1));
    expect(guardedFetch).toHaveBeenCalledWith("/api/client/periods/p1/obligations", { cache: "no-store" });
  });

  it("generate hace POST y recarga", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, obligations: [] }) });
    const { result } = renderHook(() => useObligations());
    await act(async () => { await result.current.generate("p1"); });
    expect(guardedFetch).toHaveBeenCalledWith("/api/client/periods/p1/obligations", { method: "POST" });
    // segunda llamada = recarga (load)
    expect(guardedFetch).toHaveBeenCalledWith("/api/client/periods/p1/obligations", { cache: "no-store" });
  });

  it("setStatus hace PATCH del estado y recarga", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, obligations: [] }) });
    const { result } = renderHook(() => useObligations());
    await act(async () => { await result.current.setStatus("o1", "SKIPPED", "p1"); });
    expect(guardedFetch).toHaveBeenCalledWith("/api/client/obligations/o1", expect.objectContaining({ method: "PATCH" }));
  });

  it("clear vacía la lista", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, obligations: [{ id: "o1" }] }) });
    const { result } = renderHook(() => useObligations());
    await act(async () => { await result.current.load("p1"); });
    act(() => result.current.clear());
    expect(result.current.obligations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/hooks/useObligations.test.tsx`
Expected: FAIL — no existe `./useObligations`.

- [ ] **Step 3: Crear `useObligations.ts`**

```tsx
import { useCallback, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import type { ObligationRow } from "../lib/types";

export function useObligations() {
  const { guardedFetch } = useAuthGuard();
  const [obligations, setObligations] = useState<ObligationRow[]>([]);

  const load = useCallback(async (periodId: string) => {
    try {
      const res = await guardedFetch(`/api/client/periods/${periodId}/obligations`, { cache: "no-store" });
      const data = await res.json();
      if (data.ok) setObligations(data.obligations ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  const generate = useCallback(async (periodId: string) => {
    await guardedFetch(`/api/client/periods/${periodId}/obligations`, { method: "POST" });
    await load(periodId);
  }, [guardedFetch, load]);

  const setStatus = useCallback(async (id: string, status: "PENDING" | "SKIPPED", periodId: string) => {
    await guardedFetch(`/api/client/obligations/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }),
    });
    await load(periodId);
  }, [guardedFetch, load]);

  const clear = useCallback(() => setObligations([]), []);

  return { obligations, load, generate, setStatus, clear };
}
```

- [ ] **Step 4: Correr el test para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/hooks/useObligations.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Cablear en `page.tsx` (parcial — se completa en Task 3)**

En esta tarea solo se crea el hook y se lo deja disponible; el reset/carga en la selección se conecta en Task 3 (fan-out). Por ahora:

1. Borrar el estado `obligations` (línea 360), `fetchObligations` (667-673), `handleGenerateObligations` (707-711), `handleSetObligationStatus` (713-719).
2. Agregar el import y el hook (destructurando `obligations` con el mismo nombre para no tocar el JSX de lectura):

```tsx
import { useObligations } from "./hooks/useObligations";
// ...dentro del componente, junto a los otros hooks:
const { obligations, load: loadObligations, generate: generateObligations, setStatus: setObligationStatus, clear: clearObligations } = useObligations();
```

3. Reemplazar los call-sites de los handlers en el JSX de la solapa Obligaciones (los reads `obligations.filter/map` quedan **igual**):
   - Línea ~1566 (generar): `onClick={handleGenerateObligations}` → `onClick={() => selectedPeriod && generateObligations(selectedPeriod.id)}`
   - Línea ~1604 (omitir): `onClick={() => handleSetObligationStatus(ob.id, "SKIPPED")}` → `onClick={() => selectedPeriod && setObligationStatus(ob.id, "SKIPPED", selectedPeriod.id)}`
   - Línea ~1607 (reactivar): `onClick={() => handleSetObligationStatus(ob.id, "PENDING")}` → `onClick={() => selectedPeriod && setObligationStatus(ob.id, "PENDING", selectedPeriod.id)}`

   > `selectedPeriod` en este punto todavía es el `useState` de `page.tsx`; pasará a venir de `useConsortiumDetail` en Task 3 sin cambiar estos call-sites (mismo nombre). `clearObligations`/`loadObligations` se conectan al fan-out en Task 3.

- [ ] **Step 6: Verificar**

Run:
```bash
npm run typecheck
npm run lint
npx vitest run
npm run build:jobs
```
Expected: 0 errores; +4 tests. Nota: si `loadObligations`/`clearObligations` quedan momentáneamente sin usar hasta Task 3, ESLint los marca como warning (aceptable en este paso intermedio; se consumen en Task 3). Si preferís cero warnings nuevos, hacé Task 1 y Task 3 en un mismo commit.

- [ ] **Step 7: Commit (owner)** — archivos: `hooks/useObligations.ts`, `hooks/useObligations.test.tsx`, `page.tsx`.

---

## Task 2: `useClosePeriod` + `ClosePeriodModal`

**Files:**
- Create: `src/app/admin/consortiums/hooks/useClosePeriod.ts`
- Create: `src/app/admin/consortiums/hooks/useClosePeriod.test.tsx`
- Create: `src/app/admin/consortiums/components/ClosePeriodModal.tsx`
- Create: `src/app/admin/consortiums/components/ClosePeriodModal.test.tsx`
- Modify: `src/app/admin/consortiums/page.tsx`

**Origen:** estado `showCloseModal`/`closingPeriod`/`closeError`/`closeSuccess` (328-331), `handleClosePeriod` (850-865), modal JSX (1838-1856), mensajes en el header (1388-1389), botón "Cerrar período" (1371).

**Decisión resuelta (spec §3.3):** `closeError`/`closeSuccess` viven **dentro** de `useClosePeriod`. El reset que hoy hace `handleSelectConsortium` (`setCloseSuccess(null); setCloseError(null)`) se reemplaza por un **efecto sobre `consortiumId`** dentro del hook — equivalente observacional (los mensajes son del consorcio anterior; se limpian al cambiar de consorcio) y **evita la dependencia circular** con `useConsortiumDetail`. El header del detalle lee `closePeriod.error`/`closePeriod.success`.

- [ ] **Step 1: Escribir el test `useClosePeriod.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useClosePeriod } from "./useClosePeriod";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));

beforeEach(() => guardedFetch.mockReset());

describe("useClosePeriod", () => {
  it("open/close alterna isOpen", () => {
    const { result } = renderHook(() => useClosePeriod({ consortiumId: "c1", periodId: "p1", onClosed: () => {} }));
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });

  it("submit OK: setea success, cierra modal y llama onClosed", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const onClosed = vi.fn();
    const { result } = renderHook(() => useClosePeriod({ consortiumId: "c1", periodId: "p1", onClosed }));
    act(() => result.current.open());
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.success).toContain("Período cerrado"));
    expect(result.current.isOpen).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("submit con error del backend setea error y NO llama onClosed", async () => {
    guardedFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, error: "No se pudo" }) });
    const onClosed = vi.fn();
    const { result } = renderHook(() => useClosePeriod({ consortiumId: "c1", periodId: "p1", onClosed }));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.error).toBe("No se pudo"));
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("submit sin consortiumId/periodId no hace fetch", async () => {
    const { result } = renderHook(() => useClosePeriod({ consortiumId: null, periodId: null, onClosed: () => {} }));
    await act(async () => { await result.current.submit(); });
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("cambiar consortiumId limpia error/success", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const { result, rerender } = renderHook(
      ({ cid }) => useClosePeriod({ consortiumId: cid, periodId: "p1", onClosed: () => {} }),
      { initialProps: { cid: "c1" as string | null } },
    );
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.success).toBeTruthy());
    rerender({ cid: "c2" });
    await waitFor(() => expect(result.current.success).toBeNull());
  });
});
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/hooks/useClosePeriod.test.tsx`
Expected: FAIL — no existe `./useClosePeriod`.

- [ ] **Step 3: Crear `useClosePeriod.ts`**

```tsx
import { useEffect, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { useAsyncAction } from "@/lib/useAsyncAction";

export function useClosePeriod({ consortiumId, periodId, onClosed }: {
  consortiumId: string | null;
  periodId: string | null;
  onClosed: () => void;
}) {
  const { guardedFetch } = useAuthGuard();
  const { pending: saving, run } = useAsyncAction();
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Reemplaza el reset inline que hacía handleSelectConsortium: al cambiar de
  // consorcio se limpian los mensajes de cierre del consorcio anterior.
  useEffect(() => { setError(null); setSuccess(null); }, [consortiumId]);

  const open = () => setIsOpen(true);
  const close = () => setIsOpen(false);

  const save = async () => {
    if (!consortiumId || !periodId) return;
    setError(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/close-period`, {
        method: "POST", headers: { "content-type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSuccess("Período cerrado. Se creó el siguiente período activo.");
      setIsOpen(false);
      onClosed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cerrar el período");
    }
  };

  const submit = () => run(save);

  return { isOpen, open, close, error, success, saving, submit };
}
```

- [ ] **Step 4: Correr el test para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/hooks/useClosePeriod.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Escribir el test `ClosePeriodModal.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClosePeriodModal } from "./ClosePeriodModal";

function setup(overrides: Partial<React.ComponentProps<typeof ClosePeriodModal>> = {}) {
  const props = {
    periodLabel: "Julio 2026",
    consortiumName: "THAMES 647",
    error: null as string | null,
    saving: false,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
  render(<ClosePeriodModal {...props} />);
  return props;
}

describe("ClosePeriodModal", () => {
  it("muestra el período y el consorcio", () => {
    setup();
    expect(screen.getByText("Julio 2026")).toBeInTheDocument();
    expect(screen.getByText("THAMES 647")).toBeInTheDocument();
  });
  it("click en 'Confirmar cierre' dispara onSubmit", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Confirmar cierre/ }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
  it("saving deshabilita y muestra 'Cerrando...'", () => {
    setup({ saving: true });
    expect(screen.getByRole("button", { name: /Cerrando/ })).toBeDisabled();
  });
  it("muestra el error", () => {
    setup({ error: "No se pudo" });
    expect(screen.getByText("No se pudo")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Correr el test para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/components/ClosePeriodModal.test.tsx`
Expected: FAIL — no existe `./ClosePeriodModal`.

- [ ] **Step 7: Crear `ClosePeriodModal.tsx`** (JSX de 1838-1856, estado → props)

```tsx
import styles from "../page.module.css";

type Props = {
  periodLabel: string;
  consortiumName: string;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
};

export function ClosePeriodModal({ periodLabel, consortiumName, error, saving, onClose, onSubmit }: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !saving && onClose()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Cerrar período</h3>
        <p className={styles.modalBody}>
          Estás por cerrar el período <strong>{periodLabel}</strong> del consorcio{" "}
          <strong>{consortiumName}</strong>.<br /><br />
          Se creará automáticamente el siguiente período activo. Esta acción no se puede deshacer.
        </p>
        {error && <p className={styles.errorMsg}>{error}</p>}
        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className={styles.closePeriodConfirmBtn} onClick={onSubmit} disabled={saving}>
            {saving ? "Cerrando..." : "Confirmar cierre"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Correr el test para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/components/ClosePeriodModal.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 9: Cablear en `page.tsx`**

1. Borrar estado 328-331 (`showCloseModal`, `closingPeriod`/`runClosePeriod`, `closeError`, `closeSuccess`) y `handleClosePeriod` (850-865).
2. Agregar imports + hook (se cablea con `selectedId`/`selectedPeriod` que en Task 3 vendrán de `useConsortiumDetail`; hasta entonces siguen siendo el `useState` de page — mismo nombre, no cambia el cableado):

```tsx
import { useClosePeriod } from "./hooks/useClosePeriod";
import { ClosePeriodModal } from "./components/ClosePeriodModal";
// ...dentro del componente, DESPUÉS de tener selectedId/selectedPeriod y fetchConsortiums:
const closePeriod = useClosePeriod({
  consortiumId: selectedId,
  periodId: selectedPeriod?.id ?? null,
  onClosed: () => { void fetchConsortiums(); void reloadAfterClose(); },
});
```

   > `reloadAfterClose` lo provee `useConsortiumDetail` (Task 3). Hasta Task 3, definir un stub temporal en page: `const reloadAfterClose = async () => { const pid = await fetchPeriodsAndInvoices(selectedId!); if (pid) void fetchInvoices(selectedId!, pid); };` — se elimina al cablear Task 3. (O hacer Task 2 y 3 en el mismo commit para evitar el stub.)

3. Header (1388-1389): `{closeSuccess && ...}` `{closeError && ...}` → `{closePeriod.success && <p className={styles.infoMsg}>{closePeriod.success}</p>}` `{closePeriod.error && <p className={styles.errorMsg}>{closePeriod.error}</p>}`
4. Botón "Cerrar período" (1371): `onClick={() => setShowCloseModal(true)}` → `onClick={closePeriod.open}`
5. Modal (1838-1856) → reemplazar por:

```tsx
{closePeriod.isOpen && (
  <ClosePeriodModal
    periodLabel={formatPeriod(selectedPeriod)}
    consortiumName={selectedConsortium?.rawName ?? ""}
    error={closePeriod.error}
    saving={closePeriod.saving}
    onClose={closePeriod.close}
    onSubmit={closePeriod.submit}
  />
)}
```

- [ ] **Step 10: Verificar**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build:jobs` (en PowerShell, comandos por separado).
Expected: 0 errores; +9 tests (5 hook + 4 componente).

- [ ] **Step 11: Commit (owner)** — archivos: `hooks/useClosePeriod.*`, `components/ClosePeriodModal.*`, `page.tsx`.

---

## Task 3: `useConsortiumDetail` (cascada) + fan-out

**Files:**
- Create: `src/app/admin/consortiums/hooks/useConsortiumDetail.ts`
- Create: `src/app/admin/consortiums/hooks/useConsortiumDetail.test.tsx`
- Modify: `src/app/admin/consortiums/page.tsx`

**Origen:** estado 302-319 (selección, períodos, boletas, search, activeTab, pendingRestore, didRestoreRef), efectos de restauración (576-596), `fetchPeriodsAndInvoices` (608-621), `fetchInvoices` (623-633), `handleSelectConsortium` (792-811) + `handleSelectConsortiumRef` (307-310, 814), `handleBackToConsortiums` (817-820), `handleSelectPeriod` (822-825), `periodIndex`/`canGoPrev`/`canGoNext`/`goPrevPeriod`/`goNextPeriod` (844-848).

**Interfaz del hook:**
```
useConsortiumDetail({ consortiums, loadingList, onConsortiumSelected })
  → { selectedId, selectedConsortium, setSelectedConsortium, periods, selectedPeriod,
      invoices, setInvoices, loadingInvoices, invoicesError, search, setSearch,
      activeTab, setActiveTab, canGoPrev, canGoNext,
      selectConsortium, selectPeriod, back, goPrevPeriod, goNextPeriod, reloadAfterClose }
```
- `setSelectedConsortium`/`setInvoices` se exponen porque código de Tanda 3 que queda en page (`handleSaveMatchNames`) y de boletas (`handleDeleteInvoice`, `handleReceiptUpload`) los mutan — así esos handlers quedan **byte-idénticos**.
- `onConsortiumSelected(c, activePeriodId)` = el fan-out hacia el estado que sigue en page (config de Tanda 3 + obligaciones + close-reset ya lo cubre el efecto de `useClosePeriod`).

- [ ] **Step 1: Escribir el test `useConsortiumDetail.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useConsortiumDetail } from "./useConsortiumDetail";
import type { Consortium } from "../lib/types";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));
beforeEach(() => { guardedFetch.mockReset(); window.history.replaceState(null, "", "/"); });

const consortium = { id: "c1", canonicalName: "THAMES 647", rawName: "CONS THAMES", periods: [] } as unknown as Consortium;

function mockPeriodsThenInvoices() {
  guardedFetch
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, periods: [{ id: "per1", year: 2026, month: 7, status: "ACTIVE" }] }) }) // periods
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, invoices: [{ id: "i1" }] }) }); // invoices
}

describe("useConsortiumDetail", () => {
  it("selectConsortium setea selección, carga períodos+boletas y dispara el fan-out con el período activo", async () => {
    mockPeriodsThenInvoices();
    const onConsortiumSelected = vi.fn();
    const { result } = renderHook(() => useConsortiumDetail({ consortiums: [consortium], loadingList: false, onConsortiumSelected }));
    await act(async () => { await result.current.selectConsortium(consortium); });
    await waitFor(() => expect(result.current.selectedId).toBe("c1"));
    expect(result.current.selectedPeriod?.id).toBe("per1");
    expect(onConsortiumSelected).toHaveBeenCalledWith(consortium, "per1");
    expect(result.current.activeTab).toBe("obligaciones");
  });

  it("selectPeriod recarga boletas (no dispara obligaciones — quirk preservado)", async () => {
    mockPeriodsThenInvoices();
    const { result } = renderHook(() => useConsortiumDetail({ consortiums: [consortium], loadingList: false, onConsortiumSelected: vi.fn() }));
    await act(async () => { await result.current.selectConsortium(consortium); });
    guardedFetch.mockClear();
    guardedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, invoices: [] }) });
    await act(async () => { result.current.selectPeriod({ id: "per2", year: 2026, month: 6, status: "CLOSED" }); });
    await waitFor(() => expect(guardedFetch).toHaveBeenCalledWith("/api/client/consortiums/c1/invoices?periodId=per2"));
    // solo una llamada (boletas), ninguna a /periods/per2/obligations
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("back deselecciona y limpia la URL", async () => {
    mockPeriodsThenInvoices();
    const { result } = renderHook(() => useConsortiumDetail({ consortiums: [consortium], loadingList: false, onConsortiumSelected: vi.fn() }));
    await act(async () => { await result.current.selectConsortium(consortium); });
    act(() => result.current.back());
    expect(result.current.selectedId).toBeNull();
    expect(window.location.search).toBe("");
  });
});
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/hooks/useConsortiumDetail.test.tsx`
Expected: FAIL — no existe `./useConsortiumDetail`.

- [ ] **Step 3: Crear `useConsortiumDetail.ts`**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { consortiumUrlKey, idFromUrlKey } from "../lib/match";
import type { Consortium, Invoice, Period } from "../lib/types";

export function useConsortiumDetail({ consortiums, loadingList, onConsortiumSelected }: {
  consortiums: Consortium[];
  loadingList: boolean;
  onConsortiumSelected: (c: Consortium, activePeriodId: string | undefined) => void;
}) {
  const { guardedFetch } = useAuthGuard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConsortium, setSelectedConsortium] = useState<Consortium | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<Period | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"boletas" | "pagos" | "obligaciones">("obligaciones");
  const [pendingRestore, setPendingRestore] = useState(false);
  const didRestoreRef = useRef(false);

  const fetchPeriodsAndInvoices = useCallback(async (consortiumId: string, periodId?: string) => {
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/periods`);
      const data = await res.json();
      if (!data.ok) return;
      const allPeriods: Period[] = data.periods ?? [];
      setPeriods(allPeriods);
      const target = periodId
        ? allPeriods.find((p) => p.id === periodId)
        : allPeriods.find((p) => p.status === "ACTIVE") ?? allPeriods[0];
      setSelectedPeriod(target ?? null);
      return target?.id;
    } catch { return undefined; }
  }, [guardedFetch]);

  const fetchInvoices = useCallback(async (consortiumId: string, periodId: string) => {
    setLoadingInvoices(true); setInvoicesError(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/invoices?periodId=${periodId}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInvoices(data.invoices ?? []);
    } catch (err) {
      setInvoicesError(err instanceof Error ? err.message : "Error al cargar boletas");
    } finally { setLoadingInvoices(false); }
  }, [guardedFetch]);

  const selectConsortium = useCallback(async (c: Consortium) => {
    setSelectedId(c.id); setSelectedConsortium(c);
    // Deep-link híbrido: URL legible (slug) + id inmutable al final. Sin navegar.
    window.history.replaceState(null, "", `${window.location.pathname}?c=${consortiumUrlKey(c)}`);
    setActiveTab("obligaciones");
    setInvoices([]); setSearch("");
    const periodId = await fetchPeriodsAndInvoices(c.id);
    if (periodId) void fetchInvoices(c.id, periodId);
    // Fan-out: config (Tanda 3) + obligaciones, en page.tsx.
    onConsortiumSelected(c, periodId);
  }, [fetchPeriodsAndInvoices, fetchInvoices, onConsortiumSelected]);

  const back = useCallback(() => {
    setSelectedId(null); setSelectedConsortium(null); setPendingRestore(false);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const selectPeriod = useCallback((p: Period) => {
    setSelectedPeriod(p);
    if (selectedId) void fetchInvoices(selectedId, p.id);
  }, [selectedId, fetchInvoices]);

  const reloadAfterClose = useCallback(async () => {
    if (!selectedId) return;
    const periodId = await fetchPeriodsAndInvoices(selectedId);
    if (periodId) void fetchInvoices(selectedId, periodId);
  }, [selectedId, fetchPeriodsAndInvoices, fetchInvoices]);

  // Deep-link: leer ?c= al montar → marcar restauración.
  useEffect(() => {
    const cid = new URLSearchParams(window.location.search).get("c");
    if (cid) setPendingRestore(true);
  }, []);

  // Restaurar la selección una vez que la lista cargó. Si el id no existe → limpia URL.
  useEffect(() => {
    if (didRestoreRef.current || !pendingRestore || loadingList) return;
    didRestoreRef.current = true;
    const cid = idFromUrlKey(new URLSearchParams(window.location.search).get("c"));
    const target = cid ? consortiums.find((c) => c.id === cid) : null;
    if (target) {
      void selectConsortium(target).finally(() => setPendingRestore(false));
    } else {
      setPendingRestore(false);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [pendingRestore, loadingList, consortiums, selectConsortium]);

  const periodIndex = periods.findIndex((p) => p.id === selectedPeriod?.id);
  const canGoPrev = periodIndex < periods.length - 1;
  const canGoNext = periodIndex > 0;
  const goPrevPeriod = () => { if (canGoPrev) selectPeriod(periods[periodIndex + 1]); };
  const goNextPeriod = () => { if (canGoNext) selectPeriod(periods[periodIndex - 1]); };

  return {
    selectedId, selectedConsortium, setSelectedConsortium, periods, selectedPeriod,
    invoices, setInvoices, loadingInvoices, invoicesError, search, setSearch,
    activeTab, setActiveTab, canGoPrev, canGoNext,
    selectConsortium, selectPeriod, back, goPrevPeriod, goNextPeriod, reloadAfterClose,
  };
}
```

> **Nota de comportamiento (spec §5):** el original resetea config/obligaciones **antes** del `await fetchPeriodsAndInvoices`; acá el fan-out se llama **después** (para pasar `activePeriodId`). Diferencia observable: durante la carga de períodos (~100ms) la solapa de config/obligaciones muestra brevemente los datos del consorcio anterior en vez de vacío; el estado final es idéntico. Es un transitorio dentro de la transición de detalle. Si se quisiera byte-exacto, se agregaría un callback de "pre-reset" — YAGNI salvo que el smoke lo justifique.

- [ ] **Step 4: Correr el test para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/hooks/useConsortiumDetail.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Cablear en `page.tsx` — quitar estado/handlers migrados**

Borrar de `page.tsx`:
- Estado: `selectedId` (302), `selectedConsortium` (303), `pendingRestore` (306), `didRestoreRef` (307) + el comentario y `handleSelectConsortiumRef` (308-310), `periods` (311), `selectedPeriod` (312), `invoices` (313), `loadingInvoices` (314), `invoicesError` (315), `search` (316), `activeTab` (319).
- Efectos de restauración (576-596).
- `fetchPeriodsAndInvoices` (608-621), `fetchInvoices` (623-633).
- `handleSelectConsortium` (792-811) + la línea `handleSelectConsortiumRef.current = handleSelectConsortium;` (814) + su comentario (813).
- `handleBackToConsortiums` (817-820), `handleSelectPeriod` (822-825), `periodIndex`/`canGoPrev`/`canGoNext`/`goPrevPeriod`/`goNextPeriod` (844-848), y el stub temporal `reloadAfterClose` si se creó en Task 2.

- [ ] **Step 6: Cablear en `page.tsx` — instanciar los hooks con el fan-out**

Agregar el import y, en el cuerpo del componente (después de `fetchConsortiums`, `loadingList`, `fetchProviders` y los fetchers de config que siguen en page — `fetchCoeficientes`, `fetchRubros`, `fetchLspServices`, `fetchFixedExpenses`), instanciar en este orden:

```tsx
import { useConsortiumDetail } from "./hooks/useConsortiumDetail";

// obligations ya existe (Task 1). detail primero, luego closePeriod (que depende de detail):
const detail = useConsortiumDetail({
  consortiums,
  loadingList,
  onConsortiumSelected: (c, activePeriodId) => {
    // ── Tanda 3 (config/referencia) — resets + fetches que siguen en page.tsx ──
    setEditingMatchNames(false); setMatchNamesMsg(null); setMatchNamesValue(c.matchNames ?? "");
    setLspServices([]); setLspError(null); setLspForm({ provider: "", clientNumber: "", description: "" });
    setConfirmDeleteLspId(null); setConfirmDeleteInvoiceId(null);
    setFixedExpenses([]); setFxTarget(""); setFxError(null);
    void fetchCoeficientes(c.id); void fetchRubros(c.id);
    void fetchLspServices(c.id); void fetchFixedExpenses(c.id);
    // ── Tanda 2 (obligaciones) ──
    clearObligations();
    if (activePeriodId) void loadObligations(activePeriodId);
  },
});
const {
  selectedId, selectedConsortium, setSelectedConsortium, periods, selectedPeriod,
  invoices, setInvoices, loadingInvoices, invoicesError, search, setSearch,
  activeTab, setActiveTab, canGoPrev, canGoNext,
  selectConsortium, selectPeriod, back, goPrevPeriod, goNextPeriod, reloadAfterClose,
} = detail;
```

Ajustar `closePeriod` (de Task 2) para que use `reloadAfterClose` real (ya no el stub) — su definición queda:
```tsx
const closePeriod = useClosePeriod({
  consortiumId: selectedId,
  periodId: selectedPeriod?.id ?? null,
  onClosed: () => { void fetchConsortiums(); void reloadAfterClose(); },
});
```

> Con la **destructuración de nombres idénticos**, todo el JSX que lee `selectedId`, `selectedConsortium`, `periods`, `selectedPeriod`, `invoices`, `loadingInvoices`, `invoicesError`, `search`, `activeTab`, `canGoPrev`, `canGoNext` queda **sin cambios**. Idem `setSearch`/`setActiveTab` (usados en el JSX del buscador y el tab bar).

- [ ] **Step 7: Cablear los call-sites que cambiaron de referencia**

Reemplazos en el JSX (grep-ables):
- `void handleSelectConsortium(c)` (1282) → `void selectConsortium(c)`
- `handleBackToConsortiums` (1107, 1319) → `back`
- `handleSelectPeriod(` — ya no debería quedar ninguno directo (goPrev/goNext lo usan internamente en el hook). Verificar con grep que no queden referencias.
- `handleDeleteInvoice` y `handleReceiptUpload` **no cambian de nombre** (siguen en page); pero sus cuerpos usan `setInvoices` — que ahora viene destructurado del hook (mismo nombre) → **cuerpos byte-idénticos**. Verificar que `setInvoices` resuelve al del hook.
- `handleSaveMatchNames` usa `setSelectedConsortium` (731) → ahora del hook (mismo nombre) → sin cambios.

- [ ] **Step 8: Verificar (completo)**

Run (PowerShell, por separado):
```
npm run typecheck
npm run lint
npx vitest run
npm run build:jobs
npm run build
```
Expected: 0 errores; `vitest` con todos los tests verdes (incluye +3 de detail); `build` OK. Confirmar que **no quedó** ninguna referencia a `handleSelectConsortiumRef` (grep: 0 resultados).

- [ ] **Step 9: Smoke visual (owner, post-deploy)**

Con sesión autenticada: seleccionar un consorcio (cascada: períodos + boletas + obligaciones cargan), cambiar de período (recarga boletas, NO obligaciones), cambiar de solapa, buscar, **F5 con `?c=` en la URL** (restaura la selección), "Volver" (limpia la URL), y cerrar período (crea el siguiente + refresca). Los tests tier 1 ya cubren la lógica de la cascada.

- [ ] **Step 10: Commit (owner)** — archivos: `hooks/useConsortiumDetail.*`, `page.tsx`.

---

## Task 4: Documentación

**Files:** `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`.

- [ ] **Step 1: `docs/progreso.md`** — nueva sección "Tanda 2 completa (2026-07-16)": qué se extrajo (`useConsortiumDetail` + `useObligations` + `useClosePeriod`/`ClosePeriodModal`), eliminación del hack `handleSelectConsortiumRef`, conteo de líneas de `page.tsx` (medir con `wc -l`), +N tests, y el pendiente de Tanda 3 (modal Boleta, modal Configuración, Pagar/Ver pagos, Cerrar Período General, Sin Asignar, scheduler, sidebar/tema).

- [ ] **Step 2: `docs/decisiones.md`** — entrada 2026-07-16: la costura **fan-out por callback `onConsortiumSelected`** para extraer un dominio acoplado sin arrastrar el estado de la Tanda 3 (con la alternativa descartada: que el hook se adueñe del estado de config), y el reset de mensajes de cierre por efecto sobre `consortiumId` (evita dependencia circular).

- [ ] **Step 3: `CHANGELOG.md`** — bajo `[Unreleased] → Refactor`, agregar la Tanda 2.

- [ ] **Step 4: Commit (owner)** — los 3 docs.

---

## Verificación final de la Tanda 2

```
npm run typecheck   # 0 errores
npm run lint        # 0 errores (solo warnings preexistentes)
npx vitest run      # todos verdes; +16 nuevos (useObligations 4, useClosePeriod 5, ClosePeriodModal 4, useConsortiumDetail 3)
npm run build:jobs  # OK
npm run build       # OK
```
Grep de sanidad: `handleSelectConsortiumRef` → 0 resultados. `page.tsx` debe bajar otro bloque grande de líneas.
