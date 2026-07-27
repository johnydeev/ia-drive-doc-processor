# Tanda 3e (Config) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans` (ejecución inline con
> checkpoints). Los pasos usan checkbox (`- [ ]`).
> **Regla dura del proyecto:** Claude **NUNCA** commitea ni pushea. Los "Checkpoint" reemplazan a los
> commits; el owner commitea al final con GitLens (mensaje en inglés).

**Goal:** extraer el dominio Config (modal de Configuración: acordeón matchNames / LSP / gastos fijos) a
`useConsortiumConfig` + `ConfigModal`, y disolver el fan-out de `onConsortiumSelected` — cerrando el
refactor de `src/app/admin/consortiums/page.tsx`.

**Architecture:** un hook por dominio (estado + efectos + handlers, cero JSX) + un componente
presentacional con props explícitas; `page.tsx` solo compone. Contrato **mover-no-reescribir**: la
implementación se copia tal cual, solo cambian imports y firmas. Spec:
`docs/superpowers/specs/2026-07-16-refactor-consortiums-tanda3e-config-design.md`.

**Tech Stack:** Next.js 15 (App Router, `"use client"`), React 19, TypeScript, Vitest con `test.projects`
(node `*.test.ts` / jsdom `*.test.tsx`), `@testing-library/react` + `user-event`.

**Baseline verificado (2026-07-27):** `page.tsx` **1268 líneas**, **394 tests / 52 archivos** verdes,
working tree limpio.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/app/admin/consortiums/lib/types.ts` *(modificar)* | + `ConfigSection`, + `LspForm` |
| `src/app/admin/consortiums/hooks/useConsortiumConfig.ts` *(crear)* | Estado + fetches + 6 handlers del dominio Config. Cero JSX. |
| `src/app/admin/consortiums/hooks/useConsortiumConfig.test.tsx` *(crear)* | Tier 1 (`renderHook`, `guardedFetch` mockeado) |
| `src/app/admin/consortiums/components/ConfigModal.tsx` *(crear)* | JSX del modal (acordeón de 3 secciones). Presentacional puro. |
| `src/app/admin/consortiums/components/ConfigModal.test.tsx` *(crear)* | Tier 2 (`render` + `user-event`) |
| `src/app/admin/consortiums/page.tsx` *(modificar)* | Borra el estado/handlers/JSX movidos, cablea el hook + modal, **disuelve el fan-out** |

---

## Task 1: Tipos compartidos

**Files:**
- Modify: `src/app/admin/consortiums/lib/types.ts` (al final del archivo)

- [ ] **Step 1: Agregar los dos tipos del dominio Config**

Al final de `lib/types.ts`:

```ts
// Dominio Config (Tanda 3e): sección abierta del acordeón + form de alta de LSP.
export type ConfigSection = "matchNames" | "lsp" | "fixed";
export type LspForm = { provider: string; clientNumber: string; description: string };
```

- [ ] **Step 2: Verificar**

Run: `npm run typecheck`
Expected: 0 errores.

---

## Task 2: `useConsortiumConfig` (hook)

**Files:**
- Create: `src/app/admin/consortiums/hooks/useConsortiumConfig.ts`
- Test: `src/app/admin/consortiums/hooks/useConsortiumConfig.test.tsx`

- [ ] **Step 1: Escribir el test (falla porque el hook no existe)**

`src/app/admin/consortiums/hooks/useConsortiumConfig.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useConsortiumConfig } from "./useConsortiumConfig";
import type { Consortium } from "../lib/types";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));
beforeEach(() => guardedFetch.mockReset());

const consortium = { id: "c1", matchNames: "ALT 1|ALT 2" } as Consortium;

function deps(over: Partial<Parameters<typeof useConsortiumConfig>[0]> = {}) {
  return { consortiumId: "c1", onMatchNamesSaved: vi.fn(), ...over };
}

describe("useConsortiumConfig", () => {
  it("open(c) abre con los matchNames del consorcio y el acordeón colapsado", () => {
    const { result } = renderHook(() => useConsortiumConfig(deps()));
    expect(result.current.isOpen).toBe(false);
    act(() => result.current.open(consortium));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.matchNames.value).toBe("ALT 1|ALT 2");
    expect(result.current.matchNames.editing).toBe(false);
    expect(result.current.openSection).toBeNull();
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });

  it("toggleSection abre una sección y la cierra al repetirla (acordeón)", () => {
    const { result } = renderHook(() => useConsortiumConfig(deps()));
    act(() => result.current.toggleSection("lsp"));
    expect(result.current.openSection).toBe("lsp");
    act(() => result.current.toggleSection("fixed"));
    expect(result.current.openSection).toBe("fixed");
    act(() => result.current.toggleSection("fixed"));
    expect(result.current.openSection).toBeNull();
  });

  it("load(c) resetea el estado previo y carga LSP + gastos fijos", async () => {
    guardedFetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          url.includes("lsp-services")
            ? { ok: true, lspServices: [{ id: "l1", providerName: "EDESUR", clientNumber: "123", description: null }] }
            : { ok: true, fixedExpenses: [{ id: "f1", providerId: "p1", lspServiceId: null, description: null, active: true }] },
      }));
    const { result } = renderHook(() => useConsortiumConfig(deps()));
    act(() => {
      result.current.lsp.setForm({ provider: "AYSA", clientNumber: "9" });
      result.current.fixed.setTarget("provider:p9");
    });
    await act(async () => { result.current.load(consortium); });
    await waitFor(() => expect(result.current.lsp.services).toHaveLength(1));
    expect(result.current.fixed.list).toHaveLength(1);
    expect(result.current.lsp.form).toEqual({ provider: "", clientNumber: "", description: "" });
    expect(result.current.fixed.target).toBe("");
    expect(result.current.matchNames.value).toBe("ALT 1|ALT 2");
  });

  it("matchNames.save OK: llama onMatchNamesSaved y sale del modo edición", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, consortium: { matchNames: "NUEVO" } }) });
    const d = deps();
    const { result } = renderHook(() => useConsortiumConfig(d));
    act(() => { result.current.matchNames.startEdit(); result.current.matchNames.setValue("NUEVO"); });
    await act(async () => { await result.current.matchNames.save(); });
    await waitFor(() => expect(d.onMatchNamesSaved).toHaveBeenCalledWith("NUEVO"));
    expect(result.current.matchNames.editing).toBe(false);
    expect(result.current.matchNames.msg).toBe("Guardado correctamente");
  });

  it("lsp.add sin empresa setea error y no hace POST", async () => {
    const { result } = renderHook(() => useConsortiumConfig(deps()));
    await act(async () => { await result.current.lsp.add(); });
    expect(result.current.lsp.error).toBe("Seleccioná una empresa");
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("fixed.add con proveedor postea { providerId } y recarga la lista", async () => {
    guardedFetch.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: async () => init?.method === "POST"
          ? { ok: true }
          : { ok: true, fixedExpenses: [{ id: "f1", providerId: "p1", lspServiceId: null, description: null, active: true }] },
      }));
    const { result } = renderHook(() => useConsortiumConfig(deps()));
    act(() => result.current.fixed.setTarget("provider:p1"));
    await act(async () => { await result.current.fixed.add(); });
    await waitFor(() => expect(result.current.fixed.list).toHaveLength(1));
    const post = guardedFetch.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    expect(post?.[0]).toBe("/api/client/consortiums/c1/fixed-expenses");
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({ providerId: "p1" });
    expect(result.current.fixed.target).toBe("");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/app/admin/consortiums/hooks/useConsortiumConfig.test.tsx`
Expected: FAIL — `Failed to resolve import "./useConsortiumConfig"`.

- [ ] **Step 3: Escribir el hook (mover-no-reescribir desde `page.tsx`)**

`src/app/admin/consortiums/hooks/useConsortiumConfig.ts`:

```ts
import { useCallback, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { useAsyncAction } from "@/lib/useAsyncAction";
import type { ConfigSection, Consortium, FixedExpenseRow, LspForm, LspService } from "../lib/types";

const EMPTY_LSP_FORM: LspForm = { provider: "", clientNumber: "", description: "" };

/**
 * Dominio Config del consorcio: el modal con el acordeón de 3 secciones
 * (nombres alternativos / servicios LSP / gastos fijos).
 *
 * `load(c)` es el único punto de entrada del fan-out de `useConsortiumDetail`:
 * resetea el estado del consorcio anterior y recarga LSP + gastos fijos.
 */
export function useConsortiumConfig({ consortiumId, onMatchNamesSaved }: {
  consortiumId: string | null;
  onMatchNamesSaved: (matchNames: string | null) => void;
}) {
  const { guardedFetch } = useAuthGuard();
  const { pending: savingMatchNames, run: runMatchNames } = useAsyncAction();

  const [isOpen, setIsOpen] = useState(false);
  // Acordeón: una sola sección abierta a la vez. null = todas colapsadas.
  const [openSection, setOpenSection] = useState<ConfigSection | null>(null);

  // matchNames
  const [editingMatchNames, setEditingMatchNames] = useState(false);
  const [matchNamesValue, setMatchNamesValue] = useState("");
  const [matchNamesMsg, setMatchNamesMsg] = useState<string | null>(null);

  // LspServices
  const [lspServices, setLspServices] = useState<LspService[]>([]);
  const [lspForm, setLspForm] = useState<LspForm>(EMPTY_LSP_FORM);
  const [lspError, setLspError] = useState<string | null>(null);
  const [confirmDeleteLspId, setConfirmDeleteLspId] = useState<string | null>(null);

  // Gastos fijos
  const [fixedExpenses, setFixedExpenses] = useState<FixedExpenseRow[]>([]);
  const [fxTarget, setFxTarget] = useState("");
  const [fxError, setFxError] = useState<string | null>(null);

  const fetchLspServices = useCallback(async (id: string) => {
    try {
      const res = await guardedFetch(`/api/client/consortiums/${id}/lsp-services`);
      const data = await res.json();
      if (data.ok) setLspServices(data.lspServices ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  const fetchFixedExpenses = useCallback(async (id: string) => {
    try {
      const res = await guardedFetch(`/api/client/consortiums/${id}/fixed-expenses`);
      const data = await res.json();
      if (data.ok) setFixedExpenses(data.fixedExpenses ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  // ── Ciclo de vida del dominio ────────────────────────────────────────────
  // Reemplaza el bloque de config del fan-out de `onConsortiumSelected`.
  const load = (c: Consortium) => {
    setEditingMatchNames(false); setMatchNamesMsg(null); setMatchNamesValue(c.matchNames ?? "");
    setLspServices([]); setLspError(null); setLspForm(EMPTY_LSP_FORM);
    setConfirmDeleteLspId(null);
    setFixedExpenses([]); setFxTarget(""); setFxError(null);
    void fetchLspServices(c.id); void fetchFixedExpenses(c.id);
  };

  const open = (c: Consortium) => {
    setMatchNamesValue(c.matchNames ?? "");
    setEditingMatchNames(false);
    setMatchNamesMsg(null);
    setOpenSection(null);
    setIsOpen(true);
  };
  const close = () => setIsOpen(false);
  const toggleSection = (s: ConfigSection) => setOpenSection((prev) => (prev === s ? null : s));

  // ── matchNames ───────────────────────────────────────────────────────────
  const saveMatchNames = async () => {
    if (!consortiumId) return;
    setMatchNamesMsg(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ matchNames: matchNamesValue.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onMatchNamesSaved(data.consortium.matchNames);
      setEditingMatchNames(false);
      setMatchNamesMsg("Guardado correctamente");
      setTimeout(() => setMatchNamesMsg(null), 3000);
    } catch (err) {
      setMatchNamesMsg(err instanceof Error ? err.message : "Error al guardar");
    }
  };

  // ── LspServices ──────────────────────────────────────────────────────────
  const addLsp = async () => {
    if (!consortiumId) return;
    if (!lspForm.provider) { setLspError("Seleccioná una empresa"); return; }
    if (!lspForm.clientNumber.trim()) { setLspError("El número de cliente es obligatorio"); return; }
    setLspError(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/lsp-services`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: lspForm.provider,
          clientNumber: lspForm.clientNumber.trim(),
          description: lspForm.description.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLspServices((prev) => [data.lspService, ...prev]);
      setLspForm(EMPTY_LSP_FORM);
    } catch (err) {
      setLspError(err instanceof Error ? err.message : "Error al agregar servicio");
    }
  };

  const removeLsp = async (lspId: string) => {
    if (!consortiumId) return;
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/lsp-services/${lspId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLspServices((prev) => prev.filter((s) => s.id !== lspId));
    } catch (err) {
      setLspError(err instanceof Error ? err.message : "Error al eliminar servicio");
    } finally { setConfirmDeleteLspId(null); }
  };

  // ── Gastos fijos ─────────────────────────────────────────────────────────
  const addFixedExpense = async () => {
    if (!consortiumId || !fxTarget) return;
    setFxError(null);
    const [kind, targetId] = fxTarget.split(":");
    const body = kind === "provider" ? { providerId: targetId } : { lspServiceId: targetId };
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/fixed-expenses`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { setFxError(data.error ?? `HTTP ${res.status}`); return; }
      setFxTarget("");
      await fetchFixedExpenses(consortiumId);
    } catch (err) {
      setFxError(err instanceof Error ? err.message : "Error al agregar");
    }
  };

  const toggleFixedExpense = async (fx: FixedExpenseRow) => {
    if (!consortiumId) return;
    await guardedFetch(`/api/client/consortiums/${consortiumId}/fixed-expenses/${fx.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ active: !fx.active }),
    });
    await fetchFixedExpenses(consortiumId);
  };

  const removeFixedExpense = async (id: string) => {
    if (!consortiumId) return;
    await guardedFetch(`/api/client/consortiums/${consortiumId}/fixed-expenses/${id}`, { method: "DELETE" });
    await fetchFixedExpenses(consortiumId);
  };

  return {
    isOpen, open, close, load,
    openSection, toggleSection,
    matchNames: {
      editing: editingMatchNames,
      value: matchNamesValue,
      msg: matchNamesMsg,
      saving: savingMatchNames,
      setValue: setMatchNamesValue,
      startEdit: () => setEditingMatchNames(true),
      cancelEdit: () => setEditingMatchNames(false),
      save: () => runMatchNames(saveMatchNames),
    },
    lsp: {
      services: lspServices,
      form: lspForm,
      error: lspError,
      confirmDeleteId: confirmDeleteLspId,
      setForm: (patch: Partial<LspForm>) => setLspForm((f) => ({ ...f, ...patch })),
      setConfirmDeleteId: setConfirmDeleteLspId,
      add: addLsp,
      remove: removeLsp,
    },
    fixed: {
      list: fixedExpenses,
      target: fxTarget,
      error: fxError,
      setTarget: setFxTarget,
      add: addFixedExpense,
      toggle: toggleFixedExpense,
      remove: removeFixedExpense,
    },
  };
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/app/admin/consortiums/hooks/useConsortiumConfig.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck` y `npm run lint`
Expected: 0 errores; único warning tolerado `uploadingReceiptId`.
*(Paso aditivo: `page.tsx` todavía no cambió, la app sigue funcionando igual.)*

---

## Task 3: `ConfigModal` (componente presentacional)

**Files:**
- Create: `src/app/admin/consortiums/components/ConfigModal.tsx`
- Test: `src/app/admin/consortiums/components/ConfigModal.test.tsx`

- [ ] **Step 1: Escribir el test (falla porque el componente no existe)**

`src/app/admin/consortiums/components/ConfigModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigModal } from "./ConfigModal";
import type { Provider } from "../lib/types";

const providers: Provider[] = [{ id: "pr1", canonicalName: "EDESUR", cuit: "30-65511651-2", paymentAlias: null }];

function setup(overrides: Partial<React.ComponentProps<typeof ConfigModal>> = {}) {
  const props: React.ComponentProps<typeof ConfigModal> = {
    consortiumName: "THAMES 647",
    saving: false,
    openSection: null,
    onToggleSection: vi.fn(),
    onClose: vi.fn(),
    providers,
    matchNames: {
      editing: false, value: "ALT 1", msg: null,
      onChangeValue: vi.fn(), onStartEdit: vi.fn(), onCancelEdit: vi.fn(), onSave: vi.fn(),
    },
    lsp: {
      services: [], form: { provider: "", clientNumber: "", description: "" },
      error: null, confirmDeleteId: null,
      onChangeForm: vi.fn(), onConfirmDelete: vi.fn(), onAdd: vi.fn(), onDelete: vi.fn(),
    },
    fixed: {
      list: [], target: "", error: null,
      onChangeTarget: vi.fn(), onAdd: vi.fn(), onToggle: vi.fn(), onDelete: vi.fn(),
    },
    ...overrides,
  };
  render(<ConfigModal {...props} />);
  return props;
}

describe("ConfigModal", () => {
  it("muestra el consorcio y las 3 secciones del acordeón colapsadas", () => {
    setup();
    expect(screen.getByText(/THAMES 647/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Nombres alternativos/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /Servicios públicos/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /Gastos fijos/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("click en la cabecera de LSP dispara onToggleSection('lsp')", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Servicios públicos/ }));
    expect(props.onToggleSection).toHaveBeenCalledWith("lsp");
  });

  it("con openSection='lsp' lista los servicios y 'Agregar' dispara lsp.onAdd", async () => {
    const props = setup({
      openSection: "lsp",
      lsp: {
        services: [{ id: "l1", providerName: "EDESUR", clientNumber: "12345", description: "Edificio" }],
        form: { provider: "AYSA", clientNumber: "9", description: "" },
        error: null, confirmDeleteId: null,
        onChangeForm: vi.fn(), onConfirmDelete: vi.fn(), onAdd: vi.fn(), onDelete: vi.fn(),
      },
    });
    expect(screen.getByText("12345")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Agregar$/ }));
    expect(props.lsp.onAdd).toHaveBeenCalledTimes(1);
  });

  it("click en 'Cerrar' dispara onClose", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /^Cerrar$/ }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/app/admin/consortiums/components/ConfigModal.test.tsx`
Expected: FAIL — `Failed to resolve import "./ConfigModal"`.

- [ ] **Step 3: Escribir el componente (JSX movido tal cual desde `page.tsx` 958-1143)**

`src/app/admin/consortiums/components/ConfigModal.tsx`:

```tsx
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { LSP_PROVIDERS } from "../lib/constants";
import type { ConfigSection, FixedExpenseRow, LspForm, LspService, Provider } from "../lib/types";

type Props = {
  consortiumName: string;
  saving: boolean;
  openSection: ConfigSection | null;
  onToggleSection: (section: ConfigSection) => void;
  onClose: () => void;
  providers: Provider[];
  matchNames: {
    editing: boolean;
    value: string;
    msg: string | null;
    onChangeValue: (value: string) => void;
    onStartEdit: () => void;
    onCancelEdit: () => void;
    onSave: () => void;
  };
  lsp: {
    services: LspService[];
    form: LspForm;
    error: string | null;
    confirmDeleteId: string | null;
    onChangeForm: (patch: Partial<LspForm>) => void;
    onConfirmDelete: (id: string | null) => void;
    onAdd: () => void;
    onDelete: (id: string) => void;
  };
  fixed: {
    list: FixedExpenseRow[];
    target: string;
    error: string | null;
    onChangeTarget: (value: string) => void;
    onAdd: () => void;
    onToggle: (fx: FixedExpenseRow) => void;
    onDelete: (id: string) => void;
  };
};

export function ConfigModal({
  consortiumName, saving, openSection, onToggleSection, onClose, providers, matchNames, lsp, fixed,
}: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !saving && onClose()}>
      <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Configuración — {consortiumName}</h3>
        <p className={styles.modalSubtitle}>Ajustes de matching y datos internos del consorcio</p>

        {/* ── Acordeón: una sola sección abierta a la vez ── */}
        <div className={styles.configSection}>
          <button
            type="button"
            className={styles.lspToggle}
            onClick={() => onToggleSection("matchNames")}
            aria-expanded={openSection === "matchNames"}
          >
            <span className={styles.lspToggleChevron} aria-hidden="true">{openSection === "matchNames" ? "▾" : "▸"}</span>
            <span className={styles.lspTitle}>Nombres alternativos (matching interno)</span>
          </button>
          {openSection === "matchNames" && (
            <div className={styles.lspContent}>
              <p className={styles.configSectionDesc}>
                Separar con | (pipe). Estos nombres se usan internamente para identificar el consorcio en facturas.
              </p>
              {!matchNames.editing ? (
                <>
                  <p className={styles.matchNamesValue}>
                    {matchNames.value || <span style={{ opacity: 0.4 }}>Sin nombres alternativos</span>}
                  </p>
                  <div className={styles.matchNamesActions} style={{ marginTop: 8 }}>
                    <button type="button" className={styles.matchNamesEditBtn} onClick={matchNames.onStartEdit}>Editar</button>
                  </div>
                </>
              ) : (
                <div className={styles.matchNamesEdit}>
                  <input
                    className={styles.formInput}
                    value={matchNames.value}
                    onChange={(e) => matchNames.onChangeValue(e.target.value)}
                    placeholder="NOMBRE ALT 1|NOMBRE ALT 2|NOMBRE ALT 3"
                  />
                  <div className={styles.matchNamesActions}>
                    <button type="button" className={styles.ghostBtn} onClick={matchNames.onCancelEdit} disabled={saving}>Cancelar</button>
                    <button type="button" className={styles.addInvoiceBtn} onClick={matchNames.onSave} disabled={saving}>
                      {saving ? "Guardando..." : "Guardar"}
                    </button>
                  </div>
                </div>
              )}
              {matchNames.msg && <p className={styles.infoMsg} style={{ marginTop: 6 }}>{matchNames.msg}</p>}
            </div>
          )}
        </div>

        <div className={styles.configSection}>
          <button
            type="button"
            className={styles.lspToggle}
            onClick={() => onToggleSection("lsp")}
            aria-expanded={openSection === "lsp"}
          >
            <span className={styles.lspToggleChevron} aria-hidden="true">{openSection === "lsp" ? "▾" : "▸"}</span>
            <span className={styles.lspTitle}>Servicios públicos (LSP)</span>
            {lsp.services.length > 0 && <span className={styles.lspToggleCount}>{lsp.services.length}</span>}
          </button>
          {openSection === "lsp" && (
            <div className={styles.lspContent}>
              {lsp.services.length > 0 ? (
                <div className={styles.lspTableWrap}>
                  <table className={styles.lspTable}>
                    <thead>
                      <tr><th>Empresa</th><th>Nro. Cliente</th><th>Descripción</th><th>Acciones</th></tr>
                    </thead>
                    <tbody>
                      {lsp.services.map((s) => (
                        <tr key={s.id}>
                          <td>{LSP_PROVIDERS.find((p) => p.value === s.providerName)?.label ?? s.providerName}</td>
                          <td className={styles.tdMono}>{s.clientNumber}</td>
                          <td>{s.description ?? "—"}</td>
                          <td>
                            {lsp.confirmDeleteId === s.id ? (
                              <span className={styles.lspConfirmDelete}>
                                ¿Confirmar?{" "}
                                <AsyncButton type="button" className={styles.lspConfirmYes} onClick={() => lsp.onDelete(s.id)} pendingLabel="…">Sí</AsyncButton>
                                <button type="button" className={styles.lspConfirmNo} onClick={() => lsp.onConfirmDelete(null)}>No</button>
                              </span>
                            ) : (
                              <button type="button" className={styles.lspDeleteBtn} onClick={() => lsp.onConfirmDelete(s.id)}>Eliminar</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={styles.lspEmpty}>No hay servicios públicos cargados para este consorcio.</p>
              )}
              <div className={styles.lspAddForm}>
                <select className={styles.formSelect} value={lsp.form.provider} onChange={(e) => lsp.onChangeForm({ provider: e.target.value })}>
                  <option value="">Empresa...</option>
                  {LSP_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
                <input className={styles.formInput} value={lsp.form.clientNumber} onChange={(e) => lsp.onChangeForm({ clientNumber: e.target.value })} placeholder="Nro. de cliente" />
                <input className={styles.formInput} value={lsp.form.description} onChange={(e) => lsp.onChangeForm({ description: e.target.value })} placeholder="Descripción (opcional)" />
                <AsyncButton type="button" className={styles.addInvoiceBtn} onClick={lsp.onAdd} pendingLabel="Agregando…">Agregar</AsyncButton>
              </div>
              {lsp.error && <p className={styles.errorMsg}>{lsp.error}</p>}
            </div>
          )}
        </div>

        <div className={styles.configSection}>
          <button
            type="button"
            className={styles.lspToggle}
            onClick={() => onToggleSection("fixed")}
            aria-expanded={openSection === "fixed"}
          >
            <span className={styles.lspToggleChevron} aria-hidden="true">{openSection === "fixed" ? "▾" : "▸"}</span>
            <span className={styles.lspTitle}>Gastos fijos</span>
            {fixed.list.length > 0 && <span className={styles.lspToggleCount}>{fixed.list.length}</span>}
          </button>
          {openSection === "fixed" && (
            <div className={styles.lspContent}>
              {fixed.list.length > 0 ? (
                <div className={styles.lspTableWrap}>
                  <table className={styles.lspTable}>
                    <thead>
                      <tr><th>Gasto fijo</th><th>Estado</th><th>Acciones</th></tr>
                    </thead>
                    <tbody>
                      {fixed.list.map((fx) => {
                        const lspService = lsp.services.find((l) => l.id === fx.lspServiceId);
                        const prov = providers.find((p) => p.id === fx.providerId);
                        const label = lspService
                          ? `${LSP_PROVIDERS.find((p) => p.value === lspService.providerName)?.label ?? lspService.providerName} (${lspService.clientNumber})`
                          : prov?.canonicalName ?? fx.description ?? "—";
                        return (
                          <tr key={fx.id}>
                            <td>{label}</td>
                            <td>{fx.active ? "Activo" : "Inactivo"}</td>
                            <td>
                              <AsyncButton type="button" className={styles.ghostBtn} style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => fixed.onToggle(fx)}>
                                {fx.active ? "Desactivar" : "Activar"}
                              </AsyncButton>{" "}
                              <AsyncButton type="button" className={styles.lspDeleteBtn} onClick={() => fixed.onDelete(fx.id)} pendingLabel="…">Quitar</AsyncButton>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={styles.lspEmpty}>No hay gastos fijos cargados para este consorcio.</p>
              )}
              <div className={styles.lspAddForm}>
                <select className={styles.formSelect} value={fixed.target} onChange={(e) => fixed.onChangeTarget(e.target.value)}>
                  <option value="">Elegir proveedor o servicio...</option>
                  {providers.length > 0 && (
                    <optgroup label="Proveedores">
                      {providers.map((p) => <option key={`p-${p.id}`} value={`provider:${p.id}`}>{p.canonicalName}</option>)}
                    </optgroup>
                  )}
                  {lsp.services.length > 0 && (
                    <optgroup label="Servicios (LSP)">
                      {lsp.services.map((l) => (
                        <option key={`l-${l.id}`} value={`lsp:${l.id}`}>
                          {LSP_PROVIDERS.find((p) => p.value === l.providerName)?.label ?? l.providerName} ({l.clientNumber})
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <AsyncButton type="button" className={styles.addInvoiceBtn} onClick={fixed.onAdd} disabled={!fixed.target} pendingLabel="Agregando…">Agregar</AsyncButton>
              </div>
              {fixed.error && <p className={styles.errorMsg}>{fixed.error}</p>}
            </div>
          )}
        </div>

        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
```

> **Nota de fidelidad:** el `onClick` del acordeón pasa de `setOpenConfigSection((s) => s === "x" ? null : "x")`
> a `onToggleSection("x")` — la forma funcional se preserva **dentro del hook** (`toggleSection`), no se
> pierde. La variable local `lsp` de la fila de gastos fijos se renombró a `lspService` para no sombrear la
> prop `lsp`.

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/app/admin/consortiums/components/ConfigModal.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck` y `npm run lint`
Expected: 0 errores. *(Sigue siendo aditivo — `page.tsx` intacto.)*

---

## Task 4: Wiring en `page.tsx` + disolución del fan-out

**Files:**
- Modify: `src/app/admin/consortiums/page.tsx`

- [ ] **Step 1: Imports**

Agregar junto al resto de imports de hooks/componentes:

```tsx
import { useConsortiumConfig } from "./hooks/useConsortiumConfig";
import { ConfigModal } from "./components/ConfigModal";
```

Quitar de los imports lo que deja de usarse en `page.tsx`:
- `useAsyncAction` (línea 8) — solo lo usaba `savingMatchNames`.
- De `./lib/types`: `LspService` y `FixedExpenseRow`.
- `LSP_PROVIDERS` de `./lib/constants` (la línea de import completa desaparece).

`AsyncButton` **se queda** (lo sigue usando la tabla de boletas y la de obligaciones).

- [ ] **Step 2: Borrar el estado del dominio Config (líneas 72-94 del original)**

Eliminar el bloque completo de `// matchNames editing (inside config modal)` hasta
`const [openConfigSection, ...]`, **conservando** estas dos líneas (no son de config):

```tsx
  // Eliminar boleta (pestaña Boletas)
  const [confirmDeleteInvoiceId, setConfirmDeleteInvoiceId] = useState<string | null>(null);
```

- [ ] **Step 3: Borrar `fetchLspServices` y `fetchFixedExpenses` (líneas 140-154)**

`fetchCoeficientes` y `fetchRubros` **se quedan** (datos de referencia del `InvoiceModal`).

- [ ] **Step 4: Disolver el fan-out**

Reemplazar el callback `onConsortiumSelected` de `useConsortiumDetail` por:

```tsx
    onConsortiumSelected: (c, activePeriodId) => {
      // Datos de referencia (los consume el modal Boleta, no son de config):
      void fetchCoeficientes(c.id); void fetchRubros(c.id);
      setConfirmDeleteInvoiceId(null);
      // Config del consorcio (Tanda 3e): resets + LSP + gastos fijos.
      config.load(c);
      // Obligaciones (Tanda 2):
      clearObligations();
      if (activePeriodId) void loadObligations(activePeriodId);
    },
```

> `config` se declara más abajo (necesita `selectedId`). No hay TDZ: el arrow se ejecuta en un handler
> posterior al render, con el `const config` ya inicializado; y `selectConsortium` está memoizado con
> `onConsortiumSelected` en sus deps, así que siempre corre el arrow más reciente.

- [ ] **Step 5: Declarar el hook**

Inmediatamente después del bloque `const closePeriod = useClosePeriod({...});`:

```tsx
  // Configuración del consorcio (Tanda 3e): acordeón matchNames / LSP / gastos fijos.
  const config = useConsortiumConfig({
    consortiumId: selectedId,
    onMatchNamesSaved: (matchNames) =>
      setSelectedConsortium((prev) => prev ? { ...prev, matchNames } : prev),
  });
```

- [ ] **Step 6: Borrar los 6 handlers movidos**

Eliminar de `page.tsx`: `handleAddFixedExpense`, `handleToggleFixedExpense`, `handleDeleteFixedExpense`,
`handleSaveMatchNames`, `handleAddLsp`, `handleDeleteLsp` (líneas 219-304 del original).
`handleDeleteInvoice` (línea 308) **se queda**.

- [ ] **Step 7: Re-apuntar el botón "Configuración"**

Reemplazar el `onClick` inline (líneas 710-716) por:

```tsx
                  <button type="button" className={styles.configBtn} onClick={() => config.open(selectedConsortium)}>
                    Configuración
                  </button>
```

- [ ] **Step 8: Reemplazar el JSX del modal (líneas 958-1143) por el montaje del componente**

```tsx
      {/* ── Config modal ── */}
      {config.isOpen && selectedConsortium && (
        <ConfigModal
          consortiumName={selectedConsortium.rawName}
          saving={config.matchNames.saving}
          openSection={config.openSection}
          onToggleSection={config.toggleSection}
          onClose={config.close}
          providers={providers}
          matchNames={{
            editing: config.matchNames.editing,
            value: config.matchNames.value,
            msg: config.matchNames.msg,
            onChangeValue: config.matchNames.setValue,
            onStartEdit: config.matchNames.startEdit,
            onCancelEdit: config.matchNames.cancelEdit,
            onSave: config.matchNames.save,
          }}
          lsp={{
            services: config.lsp.services,
            form: config.lsp.form,
            error: config.lsp.error,
            confirmDeleteId: config.lsp.confirmDeleteId,
            onChangeForm: config.lsp.setForm,
            onConfirmDelete: config.lsp.setConfirmDeleteId,
            onAdd: config.lsp.add,
            onDelete: config.lsp.remove,
          }}
          fixed={{
            list: config.fixed.list,
            target: config.fixed.target,
            error: config.fixed.error,
            onChangeTarget: config.fixed.setTarget,
            onAdd: config.fixed.add,
            onToggle: config.fixed.toggle,
            onDelete: config.fixed.remove,
          }}
        />
      )}
```

- [ ] **Step 9: Verificación completa**

Run, en este orden (PowerShell: un comando por línea, sin `&&`):

```bash
npm run typecheck
```
Expected: 0 errores.

```bash
npm run lint
```
Expected: 0 errores; único warning `uploadingReceiptId` (baseline).

```bash
npx vitest run
```
Expected: **404 tests** (394 baseline + 6 tier 1 + 4 tier 2) en 54 archivos, todos verdes.

```bash
npm run build:jobs
```
Expected: OK.

```bash
npm run build
```
Expected: OK.

- [ ] **Step 10: Medir el resultado**

Run: `wc -l src/app/admin/consortiums/page.tsx`
Expected: ~1050-1100 líneas (desde 1268).

---

## Task 5: Documentación (regla obligatoria del proyecto)

**Files:**
- Modify: `docs/progreso.md`
- Modify: `docs/decisiones.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: `docs/progreso.md`**

Reemplazar la sección `## ⏭️ PRÓXIMA SESIÓN — Tanda 3e (Config)` por una entrada de cierre: **3e completa**
(qué se extrajo, líneas antes/después, tests antes/después, fan-out disuelto) y **refactor cerrado**
(3105 → ~1050-1100 líneas). Dejar anotado el smoke visual pendiente del owner.

- [ ] **Step 2: `docs/decisiones.md`**

Entrada nueva con fecha 2026-07-27: **Disolución del fan-out de `onConsortiumSelected`** — problema (un
callback con 11 setters de 3 dominios distintos en `page.tsx`), decisión (`config.load(c)` + callback
cross-dominio `onMatchNamesSaved`), alternativas descartadas (3 sub-hooks; `useReferenceData` para
coeficientes/rubros), impacto (archivos tocados, líneas, tests).

- [ ] **Step 3: `CHANGELOG.md`**

Entrada del 2026-07-27 con el highlight de 3e y el cierre del refactor.

- [ ] **Step 4: Avisar al owner**

Reportar "listo para commitear" + lista de archivos creados/modificados. **No** ejecutar `git add` ni
`git commit` ni sugerir mensaje de commit (el owner usa GitLens, en inglés).

---

## Self-review (hecho)

- **Cobertura del spec:** §1 alcance → Tasks 2-4. §4 interfaz del hook → Task 2 Step 3. §5 props →
  Task 3 Step 3. §6 fan-out → Task 4 Steps 4-5. §7 pasos → Tasks 1-4. §8 tests → Task 2 Step 1 (6 casos) +
  Task 3 Step 1 (4 casos). §9 verificación → Task 4 Step 9. §11 docs → Task 5. Sin huecos.
- **Placeholders:** ninguno; todo paso con código muestra el código completo.
- **Consistencia de tipos:** `ConfigSection` y `LspForm` (Task 1) se usan con el mismo nombre en el hook
  (Task 2) y en el componente (Task 3). El hook expone `lsp.setForm`/`lsp.setConfirmDeleteId`/`lsp.remove`
  y `fixed.setTarget`/`fixed.toggle`/`fixed.remove`; el componente los recibe como
  `onChangeForm`/`onConfirmDelete`/`onDelete` y `onChangeTarget`/`onToggle`/`onDelete` — el mapeo está
  explícito en Task 4 Step 8.
