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
    expect(result.current.mode).toBe("libre");
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
    act(() => result.current.setField({ amount: "500" }));
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
