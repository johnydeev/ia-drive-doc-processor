# Refactor `consortiums/page.tsx` — Tanda 3c (Shell) · Plan

> REQUIRED SUB-SKILL: executing-plans / subagent-driven-development. Mover-no-reescribir. Owner commitea (GitLens).

**Goal:** Extraer la lógica del shell (sesión/auth, tema, toast de toolbar, scheduler) a hooks; el JSX del sidebar/toolbar queda en `page.tsx` consumiéndolos.

**Alcance (decisión brainstorming):** solo hooks de lógica. `navCollapsed`/`navMobileOpen` (UI del sidebar) quedan en page.tsx. Spec: `2026-07-16-refactor-consortiums-tanda3-design.md` §1 (3c).

**Nota de acoplamiento:** `useScheduler` recibe callbacks `onDirectorySynced` (= `fetchConsortiums`) y `onInvoicesReload` (= `reloadInvoices`, guarda internamente), y los setters del toast. El toast se separa en `useToolbarToast` porque también lo usa `handleDeleteInvoice` (que queda en page.tsx). Nombres de retorno = los que ya usa el JSX → sidebar/toast JSX **intacto**.

---

## Task 1: `useSession`, `useTheme`, `useToolbarToast` (los 3 chicos)

**Files:** Create `hooks/useSession.ts`(+test), `hooks/useTheme.ts`(+test), `hooks/useToolbarToast.ts`(+test).

- [ ] **Step 1: `hooks/useSession.ts`** (mover auth state 40-43 + efecto /me 82-99 + `handleLogout` 222-228)

```tsx
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthGuard } from "@/lib/useAuthGuard";

export function useSession() {
  const router = useRouter();
  const { guardedFetch } = useAuthGuard();
  const [accessChecked, setAccessChecked] = useState(false);
  const [userName, setUserName] = useState("");
  const [userRole, setUserRole] = useState<string>("");
  const [consortiumsEnabled, setConsortiumsEnabled] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await guardedFetch("/api/auth/me", { method: "GET", cache: "no-store" });
        const data = (await res.json()) as { ok: boolean; user?: { name?: string; role?: string; consortiumsEnabled?: boolean } };
        if (!data.ok || !data.user?.consortiumsEnabled) { router.replace("/admin"); return; }
        setUserName(data.user.name ?? data.user.role ?? "");
        setUserRole(data.user.role ?? "");
        setConsortiumsEnabled(data.user.consortiumsEnabled ?? false);
        setAccessChecked(true);
      } catch { router.replace("/admin"); }
    })();
  }, [guardedFetch, router]);

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch { /* silent */ }
  };

  return { accessChecked, userName, userRole, consortiumsEnabled, handleLogout };
}
```

- [ ] **Step 2: `hooks/useSession.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSession } from "./useSession";

const guardedFetch = vi.fn();
const replace = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }) }));
beforeEach(() => { guardedFetch.mockReset(); replace.mockReset(); });

describe("useSession", () => {
  it("con acceso OK setea el usuario y accessChecked", async () => {
    guardedFetch.mockResolvedValue({ json: async () => ({ ok: true, user: { name: "Ana", role: "CLIENT", consortiumsEnabled: true } }) });
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.accessChecked).toBe(true));
    expect(result.current.userName).toBe("Ana");
    expect(result.current.consortiumsEnabled).toBe(true);
  });
  it("sin consortiumsEnabled redirige a /admin", async () => {
    guardedFetch.mockResolvedValue({ json: async () => ({ ok: true, user: { consortiumsEnabled: false } }) });
    renderHook(() => useSession());
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/admin"));
  });
});
```

- [ ] **Step 3: `hooks/useTheme.ts`** (mover 47-56)

```tsx
import { useEffect, useState } from "react";
import type { ThemeMode } from "../lib/types";

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    if (current === "light" || current === "dark") setTheme(current);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return { theme };
}
```

- [ ] **Step 4: `hooks/useTheme.test.tsx`**

```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTheme } from "./useTheme";

beforeEach(() => document.documentElement.removeAttribute("data-theme"));

describe("useTheme", () => {
  it("default dark y setea data-theme en el html", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
  it("lee el data-theme existente al montar", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
  });
});
```

- [ ] **Step 5: `hooks/useToolbarToast.ts`** (mover state 65-66 + efectos autodismiss 71-80)

```tsx
import { useEffect, useState } from "react";

export function useToolbarToast() {
  const [toolbarInfo, setToolbarInfo] = useState<string | null>(null);
  const [toolbarError, setToolbarError] = useState<string | null>(null);

  useEffect(() => {
    if (!toolbarInfo) return;
    const t = setTimeout(() => setToolbarInfo(null), 4000);
    return () => clearTimeout(t);
  }, [toolbarInfo]);
  useEffect(() => {
    if (!toolbarError) return;
    const t = setTimeout(() => setToolbarError(null), 5000);
    return () => clearTimeout(t);
  }, [toolbarError]);

  return { toolbarInfo, toolbarError, setToolbarInfo, setToolbarError };
}
```

- [ ] **Step 6: `hooks/useToolbarToast.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useToolbarToast } from "./useToolbarToast";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useToolbarToast", () => {
  it("autodismiss del info a los 4s", () => {
    const { result } = renderHook(() => useToolbarToast());
    act(() => result.current.setToolbarInfo("hola"));
    expect(result.current.toolbarInfo).toBe("hola");
    act(() => vi.advanceTimersByTime(4000));
    expect(result.current.toolbarInfo).toBeNull();
  });
});
```

- [ ] **Step 7: Correr los 3 tests** — `npx vitest run src/app/admin/consortiums/hooks/useSession.test.tsx src/app/admin/consortiums/hooks/useTheme.test.tsx src/app/admin/consortiums/hooks/useToolbarToast.test.tsx` → PASS (2+2+1).

- [ ] **Step 8: Commit (owner)** — los 6 archivos.

---

## Task 2: `useScheduler`

**Files:** Create `hooks/useScheduler.ts`(+test).

- [ ] **Step 1: `hooks/useScheduler.ts`** (mover state 63-64 + efecto status 101-111 + 6 handlers 113-220; `fetchConsortiums`→`onDirectorySynced`, guard+`reloadInvoices`→`onInvoicesReload`, `setToolbarInfo/Error`→params)

```tsx
import { useEffect, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";

export function useScheduler({ accessChecked, setToolbarInfo, setToolbarError, onDirectorySynced, onInvoicesReload }: {
  accessChecked: boolean;
  setToolbarInfo: (v: string | null) => void;
  setToolbarError: (v: string | null) => void;
  onDirectorySynced: () => void;
  onInvoicesReload: () => void;
}) {
  const { guardedFetch } = useAuthGuard();
  const [schedulerEnabled, setSchedulerEnabled] = useState<boolean | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    if (!accessChecked) return;
    (async () => {
      try {
        const res = await guardedFetch("/api/admin/scheduler/status", { method: "GET", cache: "no-store" });
        const data = await res.json();
        if (data.ok && data.state) setSchedulerEnabled(data.state.enabled);
      } catch { /* silent */ }
    })();
  }, [accessChecked, guardedFetch]);

  const handleToggleScheduler = async () => {
    if (schedulerEnabled === null) return;
    setBusyAction("toggle"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/admin/scheduler/toggle", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !schedulerEnabled }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSchedulerEnabled(data.state.enabled);
      setToolbarInfo(data.state.enabled ? "Scheduler encendido." : "Scheduler pausado.");
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleRunNow = async () => {
    setBusyAction("run"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/admin/scheduler/run", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setToolbarInfo("Ejecución manual completada.");
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleSyncDirectory = async () => {
    setBusyAction("sync"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/sync-directory", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const counts = `C: ${data.consortiumsCount ?? 0} | P: ${data.providersCount ?? 0} | R: ${data.rubrosCount ?? 0}`;
      setToolbarInfo(`Directorio sincronizado. ${counts}`);
      onDirectorySynced();
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleSyncPayments = async () => {
    setBusyAction("syncPayments"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/sync-payments", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const counts = `Creados: ${data.paymentsCreated ?? 0} | Actualizados: ${data.paymentsUpdated ?? 0} | Boletas: ${data.invoicesAffected ?? 0}`;
      setToolbarInfo(`Pagos sincronizados. ${counts}`);
      onInvoicesReload();
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleSetupSheetProtection = async () => {
    setBusyAction("protectSheet"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/setup-sheet-protection", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const syncInfo = data.sync
        ? ` Sync previo: ${data.sync.paymentsCreated} creados, ${data.sync.paymentsUpdated} actualizados.`
        : "";
      setToolbarInfo(`Hoja protegida (${data.columnsProtected ?? 0} columnas).${syncInfo}`);
      onInvoicesReload();
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleUnprotectSheet = async () => {
    if (!window.confirm(
      "Vas a desproteger la hoja. Vas a poder editar las columnas en Google Sheets " +
      "directamente. Recordá apretar 'Proteger hoja' cuando termines — eso disparará " +
      "una sincronización automática para volcar tus cambios a la base.\n\n¿Continuar?"
    )) return;

    setBusyAction("unprotectSheet"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/setup-sheet-protection", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setToolbarInfo(
        data.removedRanges > 0
          ? `Hoja desprotegida. Acordate de re-bloquearla cuando termines.`
          : `La hoja ya estaba desprotegida.`
      );
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  return {
    schedulerEnabled, busyAction,
    handleToggleScheduler, handleRunNow, handleSyncDirectory,
    handleSyncPayments, handleSetupSheetProtection, handleUnprotectSheet,
  };
}
```

- [ ] **Step 2: `hooks/useScheduler.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useScheduler } from "./useScheduler";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));
beforeEach(() => guardedFetch.mockReset());

const deps = () => ({ accessChecked: true, setToolbarInfo: vi.fn(), setToolbarError: vi.fn(), onDirectorySynced: vi.fn(), onInvoicesReload: vi.fn() });

describe("useScheduler", () => {
  it("status effect setea schedulerEnabled", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, state: { enabled: true } }) });
    const { result } = renderHook(() => useScheduler(deps()));
    await waitFor(() => expect(result.current.schedulerEnabled).toBe(true));
  });
  it("handleSyncDirectory OK: setea info y llama onDirectorySynced", async () => {
    const d = deps();
    guardedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, state: { enabled: true } }) }); // status
    guardedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, consortiumsCount: 2, providersCount: 1, rubrosCount: 0 }) }); // sync
    const { result } = renderHook(() => useScheduler(d));
    await act(async () => { await result.current.handleSyncDirectory(); });
    expect(d.onDirectorySynced).toHaveBeenCalledTimes(1);
    expect(d.setToolbarInfo).toHaveBeenCalledWith(expect.stringContaining("Directorio sincronizado"));
  });
});
```

- [ ] **Step 3: Correr** → PASS (2 tests).

- [ ] **Step 4: Commit (owner)** — los 2 archivos.

---

## Task 3: Cablear `page.tsx`

- [ ] **Step 1: Borrar del top del componente:** `router` (38, si queda sin uso), auth state (40-43), bloque theme (45-56), scheduler state (62-66), efectos toast (68-80), efecto /me (82-99), efecto status (101-111), los 6 handlers (113-220), `handleLogout` (222-228). **Dejar** `navCollapsed`/`navMobileOpen` (58-60).

- [ ] **Step 2: Imports + hooks (top, antes de cualquier early return):**

```tsx
import { useSession } from "./hooks/useSession";
import { useTheme } from "./hooks/useTheme";
import { useToolbarToast } from "./hooks/useToolbarToast";
import { useScheduler } from "./hooks/useScheduler";
// ...al inicio del componente:
const { accessChecked, userName, userRole, consortiumsEnabled, handleLogout } = useSession();
const { theme } = useTheme();
const { toolbarInfo, toolbarError, setToolbarInfo, setToolbarError } = useToolbarToast();
const [navCollapsed, setNavCollapsed] = useState(false);
const [navMobileOpen, setNavMobileOpen] = useState(false);
```

- [ ] **Step 3: `useScheduler` después de `detail` (para `reloadInvoices`) y `fetchConsortiums`:**

```tsx
const {
  schedulerEnabled, busyAction,
  handleToggleScheduler, handleRunNow, handleSyncDirectory,
  handleSyncPayments, handleSetupSheetProtection, handleUnprotectSheet,
} = useScheduler({
  accessChecked,
  setToolbarInfo, setToolbarError,
  onDirectorySynced: fetchConsortiums,
  onInvoicesReload: reloadInvoices,
});
```

- [ ] **Step 4:** Con destructuración de nombres idénticos, **todo el JSX del sidebar/toast queda igual** (usa `busyAction`, `schedulerEnabled`, `toolbarInfo`, `toolbarError`, `handleSyncDirectory`, `handleLogout`, `userName`, `consortiumsEnabled`, `userRole` via `isClient`, `theme`). `handleDeleteInvoice` (queda en page) sigue usando `setToolbarInfo`/`setToolbarError` (de `useToolbarToast`) — sin cambios. Quitar el import de `useRouter` si `router` quedó sin uso.

- [ ] **Step 5: Verificar** — `npm run typecheck`; `npm run lint`; `npx vitest run`; `npm run build:jobs`; `npm run build`. 0 errores; +7 tests. Limpiar `ThemeMode` del import de tipos si quedó sin uso.

- [ ] **Step 6: Commit (owner)** — `page.tsx`.

---

## Task 4: Docs
- [ ] `docs/progreso.md` + `CHANGELOG.md`: Tanda 3c completa (4 hooks de shell, +7 tests, conteo de líneas). Commit (owner).

## Verificación final 3c
```
typecheck / lint / vitest run / build:jobs / build   # 0 errores; +7 tests
```
