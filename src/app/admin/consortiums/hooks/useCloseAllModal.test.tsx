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
