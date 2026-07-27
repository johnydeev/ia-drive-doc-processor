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
