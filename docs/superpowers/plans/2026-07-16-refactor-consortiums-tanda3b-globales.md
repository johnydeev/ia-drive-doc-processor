# Refactor `consortiums/page.tsx` — Tanda 3b (modales globales) · Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans o subagent-driven-development. Checkbox (`- [ ]`) por paso.

**Goal:** Extraer los modales globales de toolbar (Cerrar Período General + Sin Asignar) a hooks + componentes, sin cambiar comportamiento.

**Architecture:** `useCloseAllModal` + `CloseAllModal` y `useUnassignedModal` + `UnassignedModal`. Ambos son modales de 2 pasos (preview → result), autocontenidos, disparados desde la sidebar. Spec: `docs/superpowers/specs/2026-07-16-refactor-consortiums-tanda3-design.md` (§1, sub-tanda 3b). Hereda convenciones del paraguas.

**Regla:** Claude no commitea (owner con GitLens). Mover-no-reescribir.

---

## Task 1: `useCloseAllModal` + `CloseAllModal`

**Files:**
- Create: `hooks/useCloseAllModal.ts`, `hooks/useCloseAllModal.test.tsx`
- Create: `components/CloseAllModal.tsx`, `components/CloseAllModal.test.tsx`
- Modify: `page.tsx`

**Origen:** estado 55-60, `handleCloseAllPreview` (242-254), `handleCloseAllExecute` (256-270), JSX 1742-1814, botón sidebar 830.

- [ ] **Step 1: Test `useCloseAllModal.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCloseAllModal } from "./useCloseAllModal";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));
beforeEach(() => guardedFetch.mockReset());

describe("useCloseAllModal", () => {
  it("open carga el preview y abre el modal", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, majorityMonth: "Julio 2026", nextMonth: "Agosto 2026", toClose: [], toSkip: [] }) });
    const { result } = renderHook(() => useCloseAllModal({ onExecuted: vi.fn() }));
    await act(async () => { await result.current.open(); });
    await waitFor(() => expect(result.current.isOpen).toBe(true));
    expect(result.current.preview?.majorityMonth).toBe("Julio 2026");
    expect(result.current.step).toBe("preview");
  });

  it("open con error abre el modal con error", async () => {
    guardedFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ ok: false, error: "boom" }) });
    const { result } = renderHook(() => useCloseAllModal({ onExecuted: vi.fn() }));
    await act(async () => { await result.current.open(); });
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.isOpen).toBe(true);
  });

  it("execute OK: setea result, pasa a step result y llama onExecuted", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, closed: 3, skipped: 1, warnings: [] }) });
    const onExecuted = vi.fn();
    const { result } = renderHook(() => useCloseAllModal({ onExecuted }));
    await act(async () => { await result.current.execute(); });
    await waitFor(() => expect(result.current.step).toBe("result"));
    expect(result.current.result).toEqual({ closed: 3, skipped: 1, warnings: [] });
    expect(onExecuted).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Correr → FAIL** (`npx vitest run src/app/admin/consortiums/hooks/useCloseAllModal.test.tsx`)

- [ ] **Step 3: Crear `useCloseAllModal.ts`**

```tsx
import { useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import type { CloseAllPreview } from "../lib/types";

type CloseAllResult = { closed: number; skipped: number; warnings: string[] };

export function useCloseAllModal({ onExecuted }: { onExecuted: () => void }) {
  const { guardedFetch } = useAuthGuard();
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<"preview" | "result">("preview");
  const [preview, setPreview] = useState<CloseAllPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CloseAllResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setLoading(true); setError(null); setResult(null); setStep("preview");
    try {
      const res = await guardedFetch("/api/client/periods/close-all/preview", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPreview(data);
      setIsOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
      setIsOpen(true);
    } finally { setLoading(false); }
  };

  const execute = async () => {
    setLoading(true); setError(null);
    try {
      const res = await guardedFetch("/api/client/periods/close-all", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult({ closed: data.closed, skipped: data.skipped, warnings: data.warnings ?? [] });
      setStep("result");
      onExecuted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally { setLoading(false); }
  };

  const close = () => setIsOpen(false);

  return { isOpen, step, preview, loading, result, error, open, execute, close };
}
```

- [ ] **Step 4: Correr → PASS** (3 tests)

- [ ] **Step 5: Test `CloseAllModal.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CloseAllModal } from "./CloseAllModal";

const preview = { majorityMonth: "Julio 2026", nextMonth: "Agosto 2026", toClose: [{ id: "c1", canonicalName: "THAMES", currentPeriod: "Julio 2026" }], toSkip: [] };

describe("CloseAllModal", () => {
  it("preview: muestra el mes y dispara onExecute", async () => {
    const onExecute = vi.fn();
    render(<CloseAllModal step="preview" preview={preview} loading={false} result={null} error={null} onClose={vi.fn()} onExecute={onExecute} />);
    expect(screen.getByText("Julio 2026")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Confirmar/ }));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });
  it("result: muestra cerrados/salteados", () => {
    render(<CloseAllModal step="result" preview={null} loading={false} result={{ closed: 3, skipped: 1, warnings: [] }} error={null} onClose={vi.fn()} onExecute={vi.fn()} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Correr → FAIL**

- [ ] **Step 7: Crear `CloseAllModal.tsx`** (JSX de 1742-1814, estado → props)

```tsx
import styles from "../page.module.css";
import type { CloseAllPreview } from "../lib/types";

type Props = {
  step: "preview" | "result";
  preview: CloseAllPreview | null;
  loading: boolean;
  result: { closed: number; skipped: number; warnings: string[] } | null;
  error: string | null;
  onClose: () => void;
  onExecute: () => void;
};

export function CloseAllModal({ step, preview, loading, result, error, onClose, onExecute }: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !loading && onClose()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        {step === "preview" && (
          <>
            <h3 className={styles.modalTitle}>Cerrar Periodo General</h3>
            {error && <p className={styles.errorMsg}>{error}</p>}
            {preview && !preview.majorityMonth && (
              <p className={styles.modalBody}>No hay períodos activos para cerrar.</p>
            )}
            {preview && preview.majorityMonth && (
              <>
                <p className={styles.modalBody}>
                  Se cerrarán <strong>{preview.toClose.length}</strong> consorcio(s).
                  <br />Período: <strong>{preview.majorityMonth}</strong> → <strong>{preview.nextMonth}</strong>
                </p>
                {(() => {
                  const totalPend = preview.toClose.reduce((s, c) => s + (c.pendingObligations ?? 0), 0);
                  const affected = preview.toClose.filter((c) => (c.pendingObligations ?? 0) > 0).length;
                  return totalPend > 0 ? (
                    <p style={{ fontSize: "13px", color: "#ffb872", marginBottom: "6px" }}>
                      ⚠️ Faltan {totalPend} boleta(s) de gastos fijos en {affected} consorcio(s).
                    </p>
                  ) : null;
                })()}
                {preview.toSkip.length > 0 && (
                  <>
                    <p style={{ fontSize: "13px", color: "#ffb872", marginBottom: "6px" }}>
                      Se saltearán {preview.toSkip.length} consorcio(s):
                    </p>
                    <ul className={styles.closeAllList}>
                      {preview.toSkip.map((c) => (
                        <li key={c.id}>
                          <strong>{c.canonicalName}</strong> — {c.currentPeriod}
                          <span className={styles.closeAllSkipReason}>Ya está en período más avanzado</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={loading}>Cancelar</button>
              {preview?.majorityMonth && (
                <button type="button" className={styles.closePeriodConfirmBtn} onClick={onExecute} disabled={loading}>
                  {loading ? "Cerrando..." : "Confirmar"}
                </button>
              )}
            </div>
          </>
        )}
        {step === "result" && result && (
          <>
            <h3 className={styles.modalTitle}>Resultado</h3>
            <p className={styles.modalBody}>
              Cerrados: <strong>{result.closed}</strong> | Salteados: <strong>{result.skipped}</strong>
            </p>
            {result.warnings.length > 0 && (
              <ul className={styles.closeAllList}>
                {result.warnings.map((w, i) => (
                  <li key={i} style={{ color: "#ffb872" }}>{w}</li>
                ))}
              </ul>
            )}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Correr → PASS** (2 tests)

- [ ] **Step 9: Cablear `page.tsx`**

1. Borrar estado 55-60 y handlers `handleCloseAllPreview` (242-254), `handleCloseAllExecute` (256-270).
2. Import + hook (junto a los otros; `onExecuted: fetchConsortiums`):
```tsx
import { useCloseAllModal } from "./hooks/useCloseAllModal";
import { CloseAllModal } from "./components/CloseAllModal";
const closeAll = useCloseAllModal({ onExecuted: fetchConsortiums });
```
3. Botón sidebar (830): `onClick={() => { handleCloseAllPreview(); setNavMobileOpen(false); }}` → `onClick={() => { void closeAll.open(); setNavMobileOpen(false); }}`, y `disabled={closeAllLoading || busyAction !== null}` → `disabled={closeAll.loading || busyAction !== null}`.
4. Reemplazar JSX 1742-1814 por:
```tsx
{closeAll.isOpen && (
  <CloseAllModal
    step={closeAll.step}
    preview={closeAll.preview}
    loading={closeAll.loading}
    result={closeAll.result}
    error={closeAll.error}
    onClose={closeAll.close}
    onExecute={closeAll.execute}
  />
)}
```

- [ ] **Step 10: Verificar** — `npm run typecheck`; `npm run lint`; `npx vitest run`; `npm run build:jobs`. 0 errores; +5 tests.

- [ ] **Step 11: Commit (owner)** — los 3 archivos + `page.tsx`.

---

## Task 2: `useUnassignedModal` + `UnassignedModal`

**Files:**
- Create: `hooks/useUnassignedModal.ts`, `hooks/useUnassignedModal.test.tsx`
- Create: `components/UnassignedModal.tsx`, `components/UnassignedModal.test.tsx`
- Modify: `page.tsx`

**Origen:** estado 63-68, `handleOpenUnassigned` (272-289), `handleRequeue` (291-305), JSX 1817-1876, botón sidebar 836.

- [ ] **Step 1: Test `useUnassignedModal.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useUnassignedModal } from "./useUnassignedModal";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));
beforeEach(() => guardedFetch.mockReset());

describe("useUnassignedModal", () => {
  it("open carga los archivos y abre el modal", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, folderConfigured: true, files: [{ id: "f1", name: "a.pdf" }] }) });
    const { result } = renderHook(() => useUnassignedModal());
    await act(async () => { await result.current.open(); });
    await waitFor(() => expect(result.current.files).toHaveLength(1));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.folderConfigured).toBe(true);
  });

  it("requeue OK: setea result y pasa a step result", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, moved: 2, failed: 0 }) });
    const { result } = renderHook(() => useUnassignedModal());
    await act(async () => { await result.current.requeue(); });
    await waitFor(() => expect(result.current.step).toBe("result"));
    expect(result.current.result).toEqual({ moved: 2, failed: 0 });
  });
});
```

- [ ] **Step 2: Correr → FAIL**

- [ ] **Step 3: Crear `useUnassignedModal.ts`**

```tsx
import { useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";

type UnassignedFile = { id: string; name: string };
type UnassignedResult = { moved: number; failed: number };

export function useUnassignedModal() {
  const { guardedFetch } = useAuthGuard();
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<"preview" | "result">("preview");
  const [files, setFiles] = useState<UnassignedFile[]>([]);
  const [folderConfigured, setFolderConfigured] = useState(true);
  const [result, setResult] = useState<UnassignedResult | null>(null);
  const [loading, setLoading] = useState(false);

  const open = async () => {
    setIsOpen(true); setStep("preview"); setResult(null); setFiles([]); setFolderConfigured(true);
    setLoading(true);
    try {
      const res = await guardedFetch("/api/client/unassigned/preview", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setFolderConfigured(data.folderConfigured ?? false);
      setFiles(data.files ?? []);
    } catch {
      setFolderConfigured(false);
      setFiles([]);
    } finally { setLoading(false); }
  };

  const requeue = async () => {
    setLoading(true);
    try {
      const res = await guardedFetch("/api/client/unassigned/requeue", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult({ moved: data.moved ?? 0, failed: data.failed ?? 0 });
      setStep("result");
    } catch {
      setResult({ moved: 0, failed: files.length });
      setStep("result");
    } finally { setLoading(false); }
  };

  const close = () => setIsOpen(false);

  return { isOpen, step, files, folderConfigured, result, loading, open, requeue, close };
}
```

- [ ] **Step 4: Correr → PASS** (2 tests)

- [ ] **Step 5: Test `UnassignedModal.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnassignedModal } from "./UnassignedModal";

describe("UnassignedModal", () => {
  it("preview con archivos: lista y dispara onRequeue", async () => {
    const onRequeue = vi.fn();
    render(<UnassignedModal step="preview" files={[{ id: "f1", name: "a.pdf" }]} folderConfigured={true} result={null} loading={false} onClose={vi.fn()} onRequeue={onRequeue} />);
    expect(screen.getByText("a.pdf")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Mover a Pendientes/ }));
    expect(onRequeue).toHaveBeenCalledTimes(1);
  });
  it("carpeta no configurada", () => {
    render(<UnassignedModal step="preview" files={[]} folderConfigured={false} result={null} loading={false} onClose={vi.fn()} onRequeue={vi.fn()} />);
    expect(screen.getByText(/no está configurada/)).toBeInTheDocument();
  });
  it("result: muestra el resumen", () => {
    render(<UnassignedModal step="result" files={[]} folderConfigured={true} result={{ moved: 2, failed: 0 }} loading={false} onClose={vi.fn()} onRequeue={vi.fn()} />);
    expect(screen.getByText(/2 archivo\(s\) movidos/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Correr → FAIL**

- [ ] **Step 7: Crear `UnassignedModal.tsx`** (JSX de 1817-1876, estado → props)

```tsx
import styles from "../page.module.css";

type UnassignedFile = { id: string; name: string };

type Props = {
  step: "preview" | "result";
  files: UnassignedFile[];
  folderConfigured: boolean;
  result: { moved: number; failed: number } | null;
  loading: boolean;
  onClose: () => void;
  onRequeue: () => void;
};

export function UnassignedModal({ step, files, folderConfigured, result, loading, onClose, onRequeue }: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !loading && onClose()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        {step === "preview" && (
          <>
            <h3 className={styles.modalTitle}>Archivos Sin Asignar</h3>
            {loading && <p className={styles.modalBody}>Consultando Drive...</p>}
            {!loading && !folderConfigured && (
              <>
                <p className={styles.modalBody}>La carpeta Sin Asignar no está configurada para este cliente.</p>
                <div className={styles.modalActions}>
                  <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
                </div>
              </>
            )}
            {!loading && folderConfigured && files.length === 0 && (
              <>
                <p className={styles.modalBody}>No hay archivos sin asignar.</p>
                <div className={styles.modalActions}>
                  <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
                </div>
              </>
            )}
            {!loading && folderConfigured && files.length > 0 && (
              <>
                <p className={styles.modalBody}>
                  Se encontraron <strong>{files.length}</strong> archivo(s) en la carpeta Sin Asignar:
                </p>
                <ul className={styles.closeAllList}>
                  {files.map((f) => (
                    <li key={f.id}>{f.name}</li>
                  ))}
                </ul>
                <div className={styles.modalActions}>
                  <button type="button" className={styles.ghostBtn} onClick={onClose}>Cancelar</button>
                  <button type="button" className={styles.closePeriodConfirmBtn} onClick={onRequeue} disabled={loading}>
                    Mover a Pendientes ({files.length} archivos)
                  </button>
                </div>
              </>
            )}
          </>
        )}
        {step === "result" && result && (
          <>
            <h3 className={styles.modalTitle}>Archivos movidos a Pendientes</h3>
            <p className={styles.modalBody}>
              {result.moved > 0 && <>{result.moved} archivo(s) movidos a Pendientes correctamente.<br /></>}
              {result.failed > 0 && <span style={{ color: "#ffb872" }}>{result.failed} archivo(s) no pudieron moverse.<br /></span>}
              <br />
              El scheduler los procesará en el próximo ciclo automáticamente.
              También podés usar <strong>Ejecutar ahora</strong> en la toolbar.
            </p>
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Correr → PASS** (3 tests)

- [ ] **Step 9: Cablear `page.tsx`**

1. Borrar estado 63-68 y handlers `handleOpenUnassigned` (272-289), `handleRequeue` (291-305).
2. Import + hook:
```tsx
import { useUnassignedModal } from "./hooks/useUnassignedModal";
import { UnassignedModal } from "./components/UnassignedModal";
const unassigned = useUnassignedModal();
```
3. Botón sidebar (836): `onClick={() => { handleOpenUnassigned(); setNavMobileOpen(false); }}` → `onClick={() => { void unassigned.open(); setNavMobileOpen(false); }}`, y `disabled={loadingUnassigned || busyAction !== null}` → `disabled={unassigned.loading || busyAction !== null}`.
4. Reemplazar JSX 1817-1876 por:
```tsx
{unassigned.isOpen && (
  <UnassignedModal
    step={unassigned.step}
    files={unassigned.files}
    folderConfigured={unassigned.folderConfigured}
    result={unassigned.result}
    loading={unassigned.loading}
    onClose={unassigned.close}
    onRequeue={unassigned.requeue}
  />
)}
```

- [ ] **Step 10: Verificar** — typecheck + lint + vitest + build:jobs + build. 0 errores; +5 tests. Limpiar `CloseAllPreview` del import de tipos si quedó sin uso en page.tsx (se movió al hook/componente).

- [ ] **Step 11: Commit (owner)** — los 3 archivos + `page.tsx`.

---

## Task 3: Docs
- [ ] `docs/progreso.md` + `CHANGELOG.md`: Tanda 3b completa (2 modales globales, +10 tests, conteo de líneas). Commit (owner).

## Verificación final 3b
```
npm run typecheck / lint / vitest run / build:jobs / build   # 0 errores; +10 tests
```
