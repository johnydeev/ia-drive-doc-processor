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
