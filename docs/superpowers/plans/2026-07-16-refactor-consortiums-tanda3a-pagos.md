# Refactor `consortiums/page.tsx` — Tanda 3a (Pagos) · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extraer los modales Pagar y Ver pagos de `consortiums/page.tsx` a hooks + componentes, sin cambiar comportamiento.

**Architecture:** `useViewPayments` + `ViewPaymentsModal` (simple, read-only) y `usePayModal` + `PayModal` (dos modos cuotas/libre, con la lógica derivada dentro del hook). Ambos disparados desde los callbacks que `PagosView` ya expone; recargan la lista vía `reloadInvoices` (de `useConsortiumDetail`). Spec: `docs/superpowers/specs/2026-07-16-refactor-consortiums-tanda3-design.md`.

**Tech Stack:** React (hooks) · TypeScript · Vitest (node + jsdom) · @testing-library/react + user-event.

**Regla del proyecto:** Claude **no commitea**; el owner lo hace con GitLens. Los pasos de "commit" solo listan archivos.

**Estrategia de bajo riesgo:** mover-no-reescribir; la lógica derivada del modo (cuotas/libre) se copia tal cual dentro de `usePayModal`. El POST de pago usa `fetch` plano (no `guardedFetch`) — se preserva.

---

## Estructura de archivos (Tanda 3a)

```
src/app/admin/consortiums/
├── page.tsx                          # MODIFICAR: quita estado/handlers/JSX de pagos, cablea 2 hooks + 2 modales
├── lib/types.ts                      # MODIFICAR: + PaymentMode, PaymentRecord, PayForm
├── hooks/
│   ├── useViewPayments.ts            # CREAR
│   ├── useViewPayments.test.tsx      # CREAR (jsdom, tier 1)
│   ├── usePayModal.ts                # CREAR
│   └── usePayModal.test.tsx          # CREAR (jsdom, tier 1)
└── components/
    ├── ViewPaymentsModal.tsx         # CREAR
    ├── ViewPaymentsModal.test.tsx    # CREAR (jsdom, tier 2)
    ├── PayModal.tsx                  # CREAR
    └── PayModal.test.tsx             # CREAR (jsdom, tier 2)
```

---

## Task 1: Mover tipos de pago a `lib/types.ts`

**Files:**
- Modify: `src/app/admin/consortiums/lib/types.ts`
- Modify: `src/app/admin/consortiums/page.tsx`

**Origen:** `PaymentMode` y `PaymentRecord` están definidos dentro del componente (page.tsx 363-369).

- [ ] **Step 1: Agregar los tipos a `lib/types.ts`**

Agregar al final de `src/app/admin/consortiums/lib/types.ts`:

```typescript
export type PaymentMode = "cuotas" | "libre";
export type PaymentRecord = {
  id: string; amount: string | number; paymentDate: string;
  installmentNumber: number | null; totalInstallments: number | null;
  paymentType: "TOTAL" | "LIBRE" | "CUOTA" | null;
  paymentMethod: string | null; driveFileUrl: string | null; observation: string | null;
};
export type PayForm = {
  amount: string; paymentDate: string; totalInstallments: string;
  paymentMethod: string; observation: string;
};
```

- [ ] **Step 2: Quitar las definiciones locales en `page.tsx` e importar**

Borrar de `page.tsx` (363-369) las definiciones de `PaymentMode` y `PaymentRecord` (dejar el comentario 357-362 si se prefiere, o moverlo al hook). Agregar `PaymentMode`, `PaymentRecord` al import de tipos:

```typescript
import type {
  Coeficiente, Rubro, Consortium, Provider, Invoice, ScannedData,
  InvoiceForm, LspService, ThemeMode, CloseAllPreview, FixedExpenseRow,
  PaymentMode, PaymentRecord,
} from "./lib/types";
```

- [ ] **Step 3: Verificar**

Run: `npm run typecheck` (0 errores) y `npx vitest run` (sin regresiones). El resto de page.tsx sigue usando `PaymentMode`/`PaymentRecord` importados — typecheck confirma que resuelven.

- [ ] **Step 4: Commit (owner)** — `lib/types.ts`, `page.tsx`.

---

## Task 2: `useViewPayments` + `ViewPaymentsModal`

**Files:**
- Create: `src/app/admin/consortiums/hooks/useViewPayments.ts`
- Create: `src/app/admin/consortiums/hooks/useViewPayments.test.tsx`
- Create: `src/app/admin/consortiums/components/ViewPaymentsModal.tsx`
- Create: `src/app/admin/consortiums/components/ViewPaymentsModal.test.tsx`
- Modify: `src/app/admin/consortiums/page.tsx`

**Origen:** estado 525-527, `handleOpenViewPayments` (529-539), JSX del modal (2235-2294).

- [ ] **Step 1: Escribir el test `useViewPayments.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useViewPayments } from "./useViewPayments";
import type { Invoice } from "../lib/types";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));
beforeEach(() => guardedFetch.mockReset());

const inv = { id: "i1" } as Invoice;

describe("useViewPayments", () => {
  it("open carga la lista de pagos de la invoice", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, payments: [{ id: "p1" }] }) });
    const { result } = renderHook(() => useViewPayments());
    await act(async () => { await result.current.open(inv); });
    await waitFor(() => expect(result.current.list).toHaveLength(1));
    expect(result.current.invoice?.id).toBe("i1");
    expect(guardedFetch).toHaveBeenCalledWith("/api/client/invoices/i1/payments", { cache: "no-store" });
  });

  it("close limpia la invoice", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, payments: [] }) });
    const { result } = renderHook(() => useViewPayments());
    await act(async () => { await result.current.open(inv); });
    act(() => result.current.close());
    expect(result.current.invoice).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/hooks/useViewPayments.test.tsx`
Expected: FAIL — no existe `./useViewPayments`.

- [ ] **Step 3: Crear `useViewPayments.ts`**

```tsx
import { useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import type { Invoice, PaymentRecord } from "../lib/types";

export function useViewPayments() {
  const { guardedFetch } = useAuthGuard();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [list, setList] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const open = async (inv: Invoice) => {
    setInvoice(inv);
    setList([]);
    setLoading(true);
    try {
      const res = await guardedFetch(`/api/client/invoices/${inv.id}/payments`, { cache: "no-store" });
      const data = await res.json();
      if (data.ok && Array.isArray(data.payments)) setList(data.payments);
    } catch { /* silent */ }
    finally { setLoading(false); }
  };

  const close = () => setInvoice(null);

  return { invoice, list, loading, open, close };
}
```

- [ ] **Step 4: Correr el test para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/hooks/useViewPayments.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Escribir el test `ViewPaymentsModal.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ViewPaymentsModal } from "./ViewPaymentsModal";
import type { Invoice, PaymentRecord } from "../lib/types";

const inv = { id: "i1", provider: "EDESUR", boletaNumber: "0001", amount: 1000 } as Invoice;
const pago: PaymentRecord = {
  id: "p1", amount: 500, paymentDate: "2026-07-01T00:00:00.000Z", installmentNumber: 1,
  totalInstallments: 2, paymentType: "CUOTA", paymentMethod: "Transferencia", driveFileUrl: null, observation: null,
};

describe("ViewPaymentsModal", () => {
  it("lista los pagos", () => {
    render(<ViewPaymentsModal invoice={inv} list={[pago]} loading={false} onClose={vi.fn()} />);
    expect(screen.getByText("Historial de pagos")).toBeInTheDocument();
    expect(screen.getByText("Cuota 1/2")).toBeInTheDocument();
  });
  it("empty-state cuando no hay pagos", () => {
    render(<ViewPaymentsModal invoice={inv} list={[]} loading={false} onClose={vi.fn()} />);
    expect(screen.getByText("Esta boleta no tiene pagos registrados.")).toBeInTheDocument();
  });
  it("Cerrar dispara onClose", async () => {
    const onClose = vi.fn();
    render(<ViewPaymentsModal invoice={inv} list={[]} loading={false} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /Cerrar/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Correr el test para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/components/ViewPaymentsModal.test.tsx`
Expected: FAIL — no existe `./ViewPaymentsModal`.

- [ ] **Step 7: Crear `ViewPaymentsModal.tsx`** (JSX de 2235-2294, estado → props)

```tsx
import styles from "../page.module.css";
import { formatAmount, formatDate } from "../lib/format";
import type { Invoice, PaymentRecord } from "../lib/types";

type Props = {
  invoice: Invoice;
  list: PaymentRecord[];
  loading: boolean;
  onClose: () => void;
};

export function ViewPaymentsModal({ invoice, list, loading, onClose }: Props) {
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Historial de pagos</h3>
        <p className={styles.modalSubtitle}>
          {invoice.provider ?? "—"} — {invoice.boletaNumber ?? "—"}
          {invoice.amount !== null && (
            <> · Importe total: {formatAmount(invoice.amount)}</>
          )}
        </p>

        {loading ? (
          <p style={{ fontSize: 12, opacity: 0.6 }}>Cargando...</p>
        ) : list.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>Esta boleta no tiene pagos registrados.</p>
        ) : (
          <div className={styles.tableWrap} style={{ marginTop: 12 }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Fecha</th>
                  <th>Monto</th>
                  <th>Medio</th>
                  <th>Comprobante</th>
                  <th>Observación</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.paymentType === "CUOTA" || p.totalInstallments
                        ? <span className={styles.badgeOk}>Cuota {p.installmentNumber}/{p.totalInstallments}</span>
                        : p.paymentType === "TOTAL"
                          ? <span className={styles.badgeOk}>Total</span>
                          : <span className={styles.badgeManual}>Libre</span>}
                    </td>
                    <td>{formatDate(p.paymentDate)}</td>
                    <td className={styles.tdAmount}>{formatAmount(Number(p.amount))}</td>
                    <td>{p.paymentMethod ?? "—"}</td>
                    <td>
                      {p.driveFileUrl
                        ? <a href={p.driveFileUrl} target="_blank" rel="noopener noreferrer" className={styles.fileLink}>Ver PDF</a>
                        : "—"}
                    </td>
                    <td className={styles.tdDetail}>{p.observation ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className={styles.modalActions} style={{ marginTop: 16 }}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Correr el test para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/components/ViewPaymentsModal.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 9: Cablear en `page.tsx`**

1. Borrar estado 525-527 (`viewPaymentsInvoice`, `viewPaymentsList`, `loadingViewPayments`) y `handleOpenViewPayments` (529-539).
2. Import + hook:

```tsx
import { useViewPayments } from "./hooks/useViewPayments";
import { ViewPaymentsModal } from "./components/ViewPaymentsModal";
// ...junto a los otros hooks:
const viewPayments = useViewPayments();
```

3. En `<PagosView>` (línea ~1418): `onVerPagos={handleOpenViewPayments}` → `onVerPagos={viewPayments.open}`.
4. Reemplazar el JSX del modal (2235-2294) por:

```tsx
{viewPayments.invoice && (
  <ViewPaymentsModal
    invoice={viewPayments.invoice}
    list={viewPayments.list}
    loading={viewPayments.loading}
    onClose={viewPayments.close}
  />
)}
```

- [ ] **Step 10: Verificar**

Run (PowerShell, por separado): `npm run typecheck`; `npm run lint`; `npx vitest run`; `npm run build:jobs`.
Expected: 0 errores; +5 tests (2 hook + 3 componente).

- [ ] **Step 11: Commit (owner)** — `hooks/useViewPayments.*`, `components/ViewPaymentsModal.*`, `page.tsx`.

---

## Task 3: `usePayModal` + `PayModal`

**Files:**
- Create: `src/app/admin/consortiums/hooks/usePayModal.ts`
- Create: `src/app/admin/consortiums/hooks/usePayModal.test.tsx`
- Create: `src/app/admin/consortiums/components/PayModal.tsx`
- Create: `src/app/admin/consortiums/components/PayModal.test.tsx`
- Modify: `src/app/admin/consortiums/page.tsx`

**Origen:** estado + derivados + handlers de pago (page.tsx 371-522), JSX del modal (2056-2232).

**Interfaz del hook:** `usePayModal({ onSaved })` → expone estado, derivados del modo (calculados dentro del hook, tal cual el original) y acciones `open/close/submit/setField/setMode/setFile`.

- [ ] **Step 1: Escribir el test `usePayModal.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePayModal } from "./usePayModal";
import type { Invoice } from "../lib/types";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));

// El POST usa fetch global (no guardedFetch); lo mockeamos aparte.
const fetchMock = vi.fn();
beforeEach(() => { guardedFetch.mockReset(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });

const inv = { id: "i1", amount: 1000, remainingBalance: 1000, isPaid: false } as Invoice;

describe("usePayModal", () => {
  it("open setea la invoice y carga los pagos existentes", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, payments: [] }) });
    const { result } = renderHook(() => usePayModal({ onSaved: vi.fn() }));
    await act(async () => { await result.current.open(inv); });
    await waitFor(() => expect(result.current.invoice?.id).toBe("i1"));
    expect(result.current.isFirstPayment).toBe(true);
    expect(result.current.mode).toBe("libre"); // chosenMode default
  });

  it("submit en modo libre con campos válidos hace POST, cierra y llama onSaved", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, payments: [] }) });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const onSaved = vi.fn();
    const { result } = renderHook(() => usePayModal({ onSaved }));
    await act(async () => { await result.current.open(inv); });
    act(() => { result.current.setField({ amount: "500", paymentMethod: "Efectivo" }); result.current.setFile(new File(["x"], "r.pdf", { type: "application/pdf" })); });
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/client/invoices/i1/payments", expect.objectContaining({ method: "POST" }));
    expect(result.current.invoice).toBeNull();
  });

  it("submit sin comprobante/medio acumula error y NO hace POST", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, payments: [] }) });
    const { result } = renderHook(() => usePayModal({ onSaved: vi.fn() }));
    await act(async () => { await result.current.open(inv); });
    act(() => result.current.setField({ amount: "500" })); // falta medio + comprobante
    await act(async () => { await result.current.submit(); });
    expect(result.current.error).toContain("Faltan campos");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("modo cuotas: primer pago exige totalInstallments >= 2", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, payments: [] }) });
    const { result } = renderHook(() => usePayModal({ onSaved: vi.fn() }));
    await act(async () => { await result.current.open(inv); });
    act(() => { result.current.setMode("cuotas"); result.current.setField({ paymentMethod: "Efectivo", totalInstallments: "1" }); result.current.setFile(new File(["x"], "r.pdf")); });
    await act(async () => { await result.current.submit(); });
    expect(result.current.error).toContain("cuotas");
  });
});
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/hooks/usePayModal.test.tsx`
Expected: FAIL — no existe `./usePayModal`.

- [ ] **Step 3: Crear `usePayModal.ts`** (mover estado + derivados + `handleOpen/Submit/Close`, sin cambiar lógica)

```tsx
import { useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { todayInputDate } from "../lib/format";
import type { Invoice, PaymentMode, PaymentRecord, PayForm } from "../lib/types";

const EMPTY_FORM: PayForm = { amount: "", paymentDate: todayInputDate(), totalInstallments: "", paymentMethod: "", observation: "" };

export function usePayModal({ onSaved }: { onSaved: () => void }) {
  const { guardedFetch } = useAuthGuard();
  const { pending: saving, run } = useAsyncAction();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [existingPayments, setExistingPayments] = useState<PaymentRecord[]>([]);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [chosenMode, setChosenMode] = useState<PaymentMode>("libre");
  const [form, setForm] = useState<PayForm>(EMPTY_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Derivados del modo activo (idénticos al original).
  const activeMode: PaymentMode | null = existingPayments.length === 0
    ? null
    : existingPayments[0].totalInstallments !== null ? "cuotas" : "libre";
  const mode: PaymentMode = activeMode ?? chosenMode;
  const isFirstPayment = existingPayments.length === 0;
  const installmentsLocked = existingPayments[0]?.totalInstallments ?? null;
  const currentInstallmentNumber = installmentsLocked ? existingPayments.length + 1 : null;
  const isLastInstallment = installmentsLocked !== null && currentInstallmentNumber === installmentsLocked;
  const invoiceAmount = Number(invoice?.amount ?? 0);
  const invoiceRemaining = invoice?.remainingBalance !== null && invoice?.remainingBalance !== undefined
    ? Number(invoice.remainingBalance)
    : invoiceAmount;

  let computedAmount = 0;
  if (mode === "cuotas") {
    if (isLastInstallment) {
      computedAmount = invoiceRemaining;
    } else {
      const total = installmentsLocked ?? (Number(form.totalInstallments) || 0);
      computedAmount = total > 0 ? Number((invoiceAmount / total).toFixed(2)) : 0;
    }
  } else {
    computedAmount = Number(form.amount) || 0;
  }

  const setField = (patch: Partial<PayForm>) => setForm((f) => ({ ...f, ...patch }));

  const open = async (inv: Invoice) => {
    setInvoice(inv);
    setFile(null);
    setError(null);
    setChosenMode("libre");
    setForm({ ...EMPTY_FORM, amount: String(inv.remainingBalance ?? inv.amount ?? ""), paymentDate: todayInputDate() });
    setExistingPayments([]);
    setLoadingExisting(true);
    try {
      const res = await guardedFetch(`/api/client/invoices/${inv.id}/payments`, { cache: "no-store" });
      const data = await res.json();
      if (data.ok && Array.isArray(data.payments)) setExistingPayments(data.payments);
    } catch { /* silent */ }
    finally { setLoadingExisting(false); }
  };

  const close = () => {
    if (saving) return;
    setInvoice(null); setFile(null); setError(null); setExistingPayments([]);
  };

  const save = async () => {
    if (!invoice) return;
    const missing: string[] = [];
    if (!form.paymentDate) missing.push("fecha de pago");

    let amountToSend = 0;
    let installmentsToSend: number | null = null;
    let modeErr: string | null = null;

    if (mode === "cuotas") {
      if (installmentsLocked !== null) {
        installmentsToSend = installmentsLocked;
        amountToSend = computedAmount;
      } else {
        const inst = Number(form.totalInstallments);
        if (!Number.isInteger(inst) || inst < 2) {
          modeErr = "Las cuotas deben ser un entero mayor o igual a 2";
        } else {
          installmentsToSend = inst;
          amountToSend = computedAmount;
        }
      }
    } else {
      amountToSend = Number(form.amount);
      if (!Number.isFinite(amountToSend) || amountToSend <= 0) {
        modeErr = "El monto debe ser un número positivo";
      }
    }

    if (!form.paymentMethod) missing.push("medio de pago");
    if (!file) missing.push("comprobante PDF");

    if (missing.length > 0 || modeErr) {
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`Faltan campos: ${missing.join(", ")}.`);
      if (modeErr) parts.push(modeErr);
      setError(parts.join(" "));
      return;
    }

    setError(null);
    try {
      const formData = new FormData();
      formData.append("amount", String(amountToSend));
      formData.append("paymentDate", form.paymentDate);
      if (installmentsToSend && isFirstPayment) {
        formData.append("totalInstallments", String(installmentsToSend));
      }
      if (mode !== "cuotas") {
        formData.append("paymentType", "LIBRE");
      }
      if (form.paymentMethod) formData.append("paymentMethod", form.paymentMethod);
      if (form.observation) formData.append("observation", form.observation);
      if (file) formData.append("receipt", file);

      const res = await fetch(`/api/client/invoices/${invoice.id}/payments`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      setInvoice(null);
      setFile(null);
      setExistingPayments([]);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al registrar el pago");
    }
  };

  const submit = () => run(save);

  return {
    invoice, existingPayments, loadingExisting,
    mode, activeMode, isFirstPayment, installmentsLocked, currentInstallmentNumber, isLastInstallment, computedAmount,
    form, setField, setMode: setChosenMode,
    file, setFile,
    error, saving,
    open, close, submit,
  };
}
```

- [ ] **Step 4: Correr el test del hook para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/hooks/usePayModal.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Escribir el test `PayModal.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PayModal } from "./PayModal";
import type { Invoice } from "../lib/types";

const inv = { id: "i1", provider: "EDESUR", boletaNumber: "0001", amount: 1000, remainingBalance: 1000, isPaid: false } as Invoice;

function setup(overrides: Partial<React.ComponentProps<typeof PayModal>> = {}) {
  const props: React.ComponentProps<typeof PayModal> = {
    invoice: inv,
    loadingExisting: false,
    isFirstPayment: true,
    activeMode: null,
    mode: "libre",
    installmentsLocked: null,
    currentInstallmentNumber: null,
    isLastInstallment: false,
    existingPaymentsCount: 0,
    computedAmount: 0,
    form: { amount: "1000", paymentDate: "2026-07-16", totalInstallments: "", paymentMethod: "", observation: "" },
    onFieldChange: vi.fn(),
    onModeChange: vi.fn(),
    file: null,
    onFileChange: vi.fn(),
    error: null,
    saving: false,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
  render(<PayModal {...props} />);
  return props;
}

describe("PayModal", () => {
  it("primer pago: muestra el toggle de modo", () => {
    setup();
    expect(screen.getByRole("button", { name: /Pago libre/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cuotas fijas/ })).toBeInTheDocument();
  });
  it("click en 'Cuotas fijas' dispara onModeChange", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Cuotas fijas/ }));
    expect(props.onModeChange).toHaveBeenCalledWith("cuotas");
  });
  it("Registrar pago dispara onSubmit", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Registrar pago/ }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
  it("muestra el error", () => {
    setup({ error: "Faltan campos" });
    expect(screen.getByText("Faltan campos")).toBeInTheDocument();
  });
  it("saving deshabilita el submit y muestra 'Guardando...'", () => {
    setup({ saving: true });
    expect(screen.getByRole("button", { name: /Guardando/ })).toBeDisabled();
  });
});
```

- [ ] **Step 6: Correr el test para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/components/PayModal.test.tsx`
Expected: FAIL — no existe `./PayModal`.

- [ ] **Step 7: Crear `PayModal.tsx`** (JSX de 2056-2232, estado/derivados → props; el ref del file input queda local)

```tsx
import { useRef } from "react";
import styles from "../page.module.css";
import { formatAmount } from "../lib/format";
import type { Invoice, PaymentMode, PayForm } from "../lib/types";

type Props = {
  invoice: Invoice;
  loadingExisting: boolean;
  isFirstPayment: boolean;
  activeMode: PaymentMode | null;
  mode: PaymentMode;
  installmentsLocked: number | null;
  currentInstallmentNumber: number | null;
  isLastInstallment: boolean;
  existingPaymentsCount: number;
  computedAmount: number;
  form: PayForm;
  onFieldChange: (patch: Partial<PayForm>) => void;
  onModeChange: (m: PaymentMode) => void;
  file: File | null;
  onFileChange: (f: File | null) => void;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
};

export function PayModal({
  invoice, loadingExisting, isFirstPayment, activeMode, mode, installmentsLocked,
  currentInstallmentNumber, isLastInstallment, existingPaymentsCount, computedAmount,
  form, onFieldChange, onModeChange, file, onFileChange, error, saving, onClose, onSubmit,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Registrar pago</h3>
        <p className={styles.modalSubtitle}>
          {invoice.provider ?? "—"} — {invoice.boletaNumber ?? "—"}
          {invoice.amount !== null && (
            <> · Importe: {formatAmount(invoice.amount)}</>
          )}
          {invoice.remainingBalance !== null && !invoice.isPaid && (
            <> · Saldo: {formatAmount(invoice.remainingBalance)}</>
          )}
        </p>

        {loadingExisting && (
          <p style={{ fontSize: 12, opacity: 0.6 }}>Cargando historial de pagos...</p>
        )}

        {!loadingExisting && !isFirstPayment && (
          <div style={{
            padding: "10px 14px", borderRadius: 8,
            background: activeMode === "cuotas" ? "rgba(99, 162, 255, 0.12)" : "rgba(255, 184, 114, 0.12)",
            border: `1px solid ${activeMode === "cuotas" ? "rgba(99, 162, 255, 0.35)" : "rgba(255, 184, 114, 0.35)"}`,
            fontSize: 13, marginTop: 8,
          }}>
            {activeMode === "cuotas" ? (
              <>
                <strong>Modo cuotas pactadas</strong> · Cuota {currentInstallmentNumber} de {installmentsLocked}
                {isLastInstallment && (
                  <span style={{ display: "block", marginTop: 4, fontSize: 12, opacity: 0.85 }}>
                    Última cuota — absorbe diferencias de redondeo.
                  </span>
                )}
              </>
            ) : (
              <><strong>Modo pago libre</strong> · Ya hay {existingPaymentsCount} pago(s) registrado(s)</>
            )}
          </div>
        )}

        {!loadingExisting && isFirstPayment && (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button"
              className={mode === "libre" ? styles.addInvoiceBtn : styles.ghostBtn}
              style={{ flex: 1 }}
              onClick={() => onModeChange("libre")}
              disabled={saving}
            >
              Pago libre
            </button>
            <button type="button"
              className={mode === "cuotas" ? styles.addInvoiceBtn : styles.ghostBtn}
              style={{ flex: 1 }}
              onClick={() => onModeChange("cuotas")}
              disabled={saving}
            >
              Cuotas fijas
            </button>
          </div>
        )}

        {error && <p className={styles.errorMsg} style={{ marginTop: 8 }}>{error}</p>}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          {isFirstPayment && mode === "cuotas" && (
            <label>
              <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>
                Cantidad de cuotas
              </span>
              <input
                type="number" min="2" step="1"
                className={styles.formInput}
                placeholder="ej. 3"
                value={form.totalInstallments}
                onChange={(e) => onFieldChange({ totalInstallments: e.target.value })}
                disabled={saving}
              />
            </label>
          )}

          <label>
            <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>
              Monto pagado
              {mode === "cuotas" && (
                <span style={{ fontWeight: 400, opacity: 0.6 }}> (calculado automáticamente)</span>
              )}
            </span>
            {mode === "cuotas" ? (
              <input
                type="text"
                className={styles.formInput}
                value={computedAmount > 0 ? formatAmount(computedAmount) : "—"}
                readOnly disabled
              />
            ) : (
              <input
                type="number" step="0.01"
                className={styles.formInput}
                value={form.amount}
                onChange={(e) => onFieldChange({ amount: e.target.value })}
                disabled={saving}
              />
            )}
          </label>

          <label>
            <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>Fecha de pago</span>
            <input
              type="date"
              className={styles.formInput}
              value={form.paymentDate}
              onChange={(e) => onFieldChange({ paymentDate: e.target.value })}
              disabled={saving}
            />
          </label>

          <label>
            <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>Medio de pago</span>
            <select
              className={styles.formSelect}
              value={form.paymentMethod}
              onChange={(e) => onFieldChange({ paymentMethod: e.target.value })}
              disabled={saving}
            >
              <option value="" disabled hidden>Elija una opción</option>
              <option value="Débito automático">Débito automático</option>
              <option value="Transferencia">Transferencia</option>
              <option value="Efectivo">Efectivo</option>
            </select>
          </label>
          <label style={{ gridColumn: "1 / -1" }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>Observación (opcional)</span>
            <input
              type="text"
              className={styles.formInput}
              value={form.observation}
              onChange={(e) => onFieldChange({ observation: e.target.value })}
              disabled={saving}
            />
          </label>
          <label style={{ gridColumn: "1 / -1" }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>Comprobante PDF</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className={styles.formInput}
              onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
              disabled={saving}
            />
            {file && (
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                {file.name} ({(file.size / 1024).toFixed(1)} KB)
              </span>
            )}
          </label>
        </div>

        <div className={styles.modalActions} style={{ marginTop: 16 }}>
          <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="button" className={styles.addInvoiceBtn} onClick={onSubmit} disabled={saving || loadingExisting}>
            {saving ? "Guardando..." : "Registrar pago"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Correr el test para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/components/PayModal.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 9: Cablear en `page.tsx`**

1. Borrar el comentario 357-362 + estado 371-386 (`payModalInvoice`…`payFileInputRef`), los derivados 388-414 (`activeMode`…`computedAmount`), y los handlers `handleOpenPayModal` (416-438), `handleClosePayModal` (440-446), `handleSubmitPayment` (448-522). *(Los tipos ya se movieron en Task 1.)*
2. Import + hook (usa `reloadInvoices` de `useConsortiumDetail`, ya destructurado):

```tsx
import { usePayModal } from "./hooks/usePayModal";
import { PayModal } from "./components/PayModal";
// ...junto a los otros hooks:
const payModal = usePayModal({ onSaved: reloadInvoices });
```

3. En `<PagosView>` (línea ~1417): `onPagar={handleOpenPayModal}` → `onPagar={payModal.open}`.
4. Reemplazar el JSX del modal (2056-2232) por:

```tsx
{payModal.invoice && (
  <PayModal
    invoice={payModal.invoice}
    loadingExisting={payModal.loadingExisting}
    isFirstPayment={payModal.isFirstPayment}
    activeMode={payModal.activeMode}
    mode={payModal.mode}
    installmentsLocked={payModal.installmentsLocked}
    currentInstallmentNumber={payModal.currentInstallmentNumber}
    isLastInstallment={payModal.isLastInstallment}
    existingPaymentsCount={payModal.existingPayments.length}
    computedAmount={payModal.computedAmount}
    form={payModal.form}
    onFieldChange={payModal.setField}
    onModeChange={payModal.setMode}
    file={payModal.file}
    onFileChange={payModal.setFile}
    error={payModal.error}
    saving={payModal.saving}
    onClose={payModal.close}
    onSubmit={payModal.submit}
  />
)}
```

- [ ] **Step 10: Verificar (completo)**

Run (PowerShell, por separado): `npm run typecheck`; `npm run lint`; `npx vitest run`; `npm run build:jobs`; `npm run build`.
Expected: 0 errores (limpiar cualquier import/var que quede sin uso — p. ej. `todayInputDate` si ya no se usa en page.tsx tras mover el pago); tests verdes (+9 de esta tarea).

- [ ] **Step 11: Smoke visual (owner, post-deploy)**

Solapa Pagos con sesión autenticada: registrar un pago en **modo libre** y en **modo cuotas** (primer pago con N cuotas, luego cuota siguiente con monto autocalculado, última cuota absorbe redondeo), ver el banner de modo, y que la lista se recargue tras guardar.

- [ ] **Step 12: Commit (owner)** — `hooks/usePayModal.*`, `components/PayModal.*`, `page.tsx`.

---

## Task 4: Documentación

**Files:** `docs/progreso.md`, `CHANGELOG.md`.

- [ ] **Step 1: `docs/progreso.md`** — nueva sección "Tanda 3a (Pagos) completa": extraídos `usePayModal`/`useViewPayments` + `PayModal`/`ViewPaymentsModal`; tipos de pago a `lib/types.ts`; conteo de líneas de `page.tsx` (medir con `wc -l`); +N tests; pendiente de Tanda 3 (3b globales, 3c shell, 3d boleta, 3e config).
- [ ] **Step 2: `CHANGELOG.md`** — bajo `[Unreleased] → Refactor`, agregar la Tanda 3a.
- [ ] **Step 3: Commit (owner)** — los 2 docs.

---

## Verificación final de la Tanda 3a

```
npm run typecheck   # 0 errores
npm run lint        # 0 errores (solo warnings preexistentes)
npx vitest run      # todos verdes; +14 nuevos (useViewPayments 2, ViewPaymentsModal 3, usePayModal 4, PayModal 5; Task 1 sin tests nuevos)
npm run build:jobs  # OK
npm run build       # OK
```
`page.tsx` baja otro bloque de ~250 líneas (los dos modales de pago + estado/derivados/handlers).
