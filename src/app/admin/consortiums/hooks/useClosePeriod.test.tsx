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
