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
    guardedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, state: { enabled: true } }) });
    guardedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, consortiumsCount: 2, providersCount: 1, rubrosCount: 0 }) });
    const { result } = renderHook(() => useScheduler(d));
    await act(async () => { await result.current.handleSyncDirectory(); });
    expect(d.onDirectorySynced).toHaveBeenCalledTimes(1);
    expect(d.setToolbarInfo).toHaveBeenCalledWith(expect.stringContaining("Directorio sincronizado"));
  });
});
