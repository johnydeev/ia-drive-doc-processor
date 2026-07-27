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
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, periods: [{ id: "per1", year: 2026, month: 7, status: "ACTIVE" }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, invoices: [{ id: "i1" }] }) });
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
