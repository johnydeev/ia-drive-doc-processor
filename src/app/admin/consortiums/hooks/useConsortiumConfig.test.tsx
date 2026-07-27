import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useConsortiumConfig } from "./useConsortiumConfig";
import type { Consortium } from "../lib/types";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));
beforeEach(() => guardedFetch.mockReset());

const consortium = { id: "c1", matchNames: "ALT 1|ALT 2" } as Consortium;

function deps(over: Partial<Parameters<typeof useConsortiumConfig>[0]> = {}) {
  return { consortiumId: "c1", onMatchNamesSaved: vi.fn(), ...over };
}

describe("useConsortiumConfig", () => {
  it("open(c) abre con los matchNames del consorcio y el acordeón colapsado", () => {
    const { result } = renderHook(() => useConsortiumConfig(deps()));
    expect(result.current.isOpen).toBe(false);
    act(() => result.current.open(consortium));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.matchNames.value).toBe("ALT 1|ALT 2");
    expect(result.current.matchNames.editing).toBe(false);
    expect(result.current.openSection).toBeNull();
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });

  it("toggleSection abre una sección y la cierra al repetirla (acordeón)", () => {
    const { result } = renderHook(() => useConsortiumConfig(deps()));
    act(() => result.current.toggleSection("lsp"));
    expect(result.current.openSection).toBe("lsp");
    act(() => result.current.toggleSection("fixed"));
    expect(result.current.openSection).toBe("fixed");
    act(() => result.current.toggleSection("fixed"));
    expect(result.current.openSection).toBeNull();
  });

  it("load(c) resetea el estado previo y carga LSP + gastos fijos", async () => {
    guardedFetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          url.includes("lsp-services")
            ? { ok: true, lspServices: [{ id: "l1", providerName: "EDESUR", clientNumber: "123", description: null }] }
            : { ok: true, fixedExpenses: [{ id: "f1", providerId: "p1", lspServiceId: null, description: null, active: true }] },
      }));
    const { result } = renderHook(() => useConsortiumConfig(deps()));
    act(() => {
      result.current.lsp.setForm({ provider: "AYSA", clientNumber: "9" });
      result.current.fixed.setTarget("provider:p9");
    });
    await act(async () => { result.current.load(consortium); });
    await waitFor(() => expect(result.current.lsp.services).toHaveLength(1));
    expect(result.current.fixed.list).toHaveLength(1);
    expect(result.current.lsp.form).toEqual({ provider: "", clientNumber: "", description: "" });
    expect(result.current.fixed.target).toBe("");
    expect(result.current.matchNames.value).toBe("ALT 1|ALT 2");
  });

  it("matchNames.save OK: llama onMatchNamesSaved y sale del modo edición", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, consortium: { matchNames: "NUEVO" } }) });
    const d = deps();
    const { result } = renderHook(() => useConsortiumConfig(d));
    act(() => { result.current.matchNames.startEdit(); result.current.matchNames.setValue("NUEVO"); });
    await act(async () => { await result.current.matchNames.save(); });
    await waitFor(() => expect(d.onMatchNamesSaved).toHaveBeenCalledWith("NUEVO"));
    expect(result.current.matchNames.editing).toBe(false);
    expect(result.current.matchNames.msg).toBe("Guardado correctamente");
  });

  it("lsp.add sin empresa setea error y no hace POST", async () => {
    const { result } = renderHook(() => useConsortiumConfig(deps()));
    await act(async () => { await result.current.lsp.add(); });
    expect(result.current.lsp.error).toBe("Seleccioná una empresa");
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("fixed.add con proveedor postea { providerId } y recarga la lista", async () => {
    guardedFetch.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: async () => init?.method === "POST"
          ? { ok: true }
          : { ok: true, fixedExpenses: [{ id: "f1", providerId: "p1", lspServiceId: null, description: null, active: true }] },
      }));
    const { result } = renderHook(() => useConsortiumConfig(deps()));
    act(() => result.current.fixed.setTarget("provider:p1"));
    await act(async () => { await result.current.fixed.add(); });
    await waitFor(() => expect(result.current.fixed.list).toHaveLength(1));
    const post = guardedFetch.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    expect(post?.[0]).toBe("/api/client/consortiums/c1/fixed-expenses");
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({ providerId: "p1" });
    expect(result.current.fixed.target).toBe("");
  });
});
