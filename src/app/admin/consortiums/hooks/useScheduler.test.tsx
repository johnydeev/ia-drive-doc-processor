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

// El reporte del sync dejó de descartarse (2026-08-17): lo consume el modal, que
// muestra los sobrantes y confirma los renombres detectados por CUIT.
describe("useScheduler — reporte del sync de directorio", () => {
  const report = {
    consortiums: { created: 1, updated: 2, orphans: [{ id: "c1", name: "FRIAS 320", invoices: 37 }] },
    providers: { created: 0, updated: 0, orphans: [] },
    rubros: { created: 0, updated: 0, orphans: [] },
    coeficientes: { created: 0, updated: 0, orphans: [] },
    lspServices: { created: 0, updated: 0, orphans: [] },
    pendingRenames: [],
    ambiguous: [],
    warnings: [],
  };

  it("guarda el reporte que devuelve el endpoint", async () => {
    const d = deps();
    guardedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, state: { enabled: true } }) });
    guardedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, report }) });

    const { result } = renderHook(() => useScheduler(d));
    await act(async () => { await result.current.handleSyncDirectory(); });

    await waitFor(() => expect(result.current.syncReport).toEqual(report));
  });

  it("applyRenames manda la lista exacta y limpia el reporte", async () => {
    const d = deps();
    guardedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, state: { enabled: true } }) });
    guardedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, applied: 1, skipped: [] }) });

    const { result } = renderHook(() => useScheduler(d));
    await act(async () => {
      await result.current.applyRenames([{ entity: "consortium", id: "c1", to: "FRIAS 324" }]);
    });

    expect(guardedFetch).toHaveBeenLastCalledWith(
      "/api/client/sync-directory/renames",
      expect.objectContaining({
        body: JSON.stringify({ renames: [{ entity: "consortium", id: "c1", to: "FRIAS 324" }] }),
      })
    );
    expect(result.current.syncReport).toBeNull();
  });

  it("un error del sync no deja reporte colgado", async () => {
    const d = deps();
    guardedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, state: { enabled: true } }) });
    guardedFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ ok: false, error: "Boom" }) });

    const { result } = renderHook(() => useScheduler(d));
    await act(async () => { await result.current.handleSyncDirectory(); });

    expect(result.current.syncReport).toBeNull();
    expect(d.setToolbarError).toHaveBeenCalledWith("Boom");
  });
});
