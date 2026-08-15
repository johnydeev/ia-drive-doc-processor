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
    });
    await act(async () => { result.current.load(consortium); });
    await waitFor(() => expect(result.current.lsp.services).toHaveLength(1));
    expect(result.current.fixed.list).toHaveLength(1);
    expect(result.current.lsp.form).toEqual({ provider: "", clientNumber: "", description: "" });
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

  // El alta/toggle/borrado de gastos fijos se mudó a /admin/obligaciones: acá
  // `fixed` quedó de solo lectura y `load()` sólo carga la lista.
  it("fixed sólo expone la lista cargada por load()", async () => {
    guardedFetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: async () => url.includes("lsp-services")
          ? { ok: true, lspServices: [] }
          : { ok: true, fixedExpenses: [{ id: "f1", providerId: "p1", lspServiceId: null, description: null, active: true }] },
      }));
    const { result } = renderHook(() => useConsortiumConfig(deps()));
    await act(async () => { result.current.load(consortium); });
    await waitFor(() => expect(result.current.fixed.list).toHaveLength(1));
    expect(Object.keys(result.current.fixed)).toEqual(["list"]);
    expect(guardedFetch.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  // ── Sección Banco ──────────────────────────────────────────────────────
  it("load() carga el banco y los datos de cuenta del consorcio", () => {
    const { result } = renderHook(() => useConsortiumConfig(deps()));

    act(() => result.current.load({
      ...consortium,
      bankId: "b1",
      bank: { id: "b1", name: "Santander", color: "red" },
      bankAlias: "BROWN.706.CONS",
      cbu: "0720500220000000294986",
      accountNumber: "500-002949/8",
      branch: "016",
      accountType: "Cuenta Corriente",
      accountHolder: "Consorcio A. Brown 706",
    } as Consortium));

    expect(result.current.bank.form.bankId).toBe("b1");
    expect(result.current.bank.form.cbu).toBe("0720500220000000294986");
    expect(result.current.bank.form.branch).toBe("016");
  });

  it("load() resetea los datos bancarios al cambiar a un consorcio sin banco", () => {
    const { result } = renderHook(() => useConsortiumConfig(deps()));

    act(() => result.current.load({ ...consortium, bankId: "b1", cbu: "123" } as Consortium));
    act(() => result.current.load({ ...consortium, id: "c2" } as Consortium));

    expect(result.current.bank.form.bankId).toBe("");
    expect(result.current.bank.form.cbu).toBe("");
  });

  it("bank.save() manda el PATCH con los datos normalizados y avisa al padre", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, consortium: { id: "c1" } }) });
    const onBankSaved = vi.fn();
    const { result } = renderHook(() => useConsortiumConfig(deps({ onBankSaved })));

    act(() => result.current.bank.setForm({ bankId: "b1", cbu: " 0720500220000000294986 ", accountHolder: "  " }));
    await act(async () => { await result.current.bank.save(); });

    const patch = guardedFetch.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PATCH");
    expect(patch?.[0]).toBe("/api/client/consortiums/c1");
    expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toMatchObject({
      bankId: "b1",
      cbu: "0720500220000000294986",
      accountHolder: null,
    });
    expect(onBankSaved).toHaveBeenCalled();
  });
});
