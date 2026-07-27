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
