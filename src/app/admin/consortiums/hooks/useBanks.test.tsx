import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBanks } from "./useBanks";

// La referencia de `guardedFetch` tiene que ser estable entre renders: el
// `useEffect` de carga depende de ella y una función nueva por render lo
// dispararía en loop.
const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

const santander = { id: "b1", name: "Santander", color: "red", _count: { consortiums: 2 } };

describe("useBanks", () => {
  beforeEach(() => {
    guardedFetch.mockReset();
    guardedFetch.mockResolvedValue(jsonResponse({ ok: true, banks: [santander] }));
  });

  it("carga el catálogo al montar", async () => {
    const { result } = renderHook(() => useBanks());
    await waitFor(() => expect(result.current.banks).toHaveLength(1));
    expect(result.current.banks[0].name).toBe("Santander");
  });

  it("crea un banco y recarga el catálogo", async () => {
    const { result } = renderHook(() => useBanks());
    await waitFor(() => expect(result.current.banks).toHaveLength(1));

    guardedFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, bank: { id: "b2", name: "Galicia", color: "amber" } }, true, 201)
    );
    guardedFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, banks: [santander, { id: "b2", name: "Galicia", color: "amber", _count: { consortiums: 0 } }] })
    );

    act(() => { result.current.setForm({ name: "Galicia", color: "amber" }); });
    await act(async () => { await result.current.create(); });

    await waitFor(() => expect(result.current.banks).toHaveLength(2));
    expect(result.current.form.name).toBe("");
  });

  it("expone el error del 409 por nombre duplicado", async () => {
    const { result } = renderHook(() => useBanks());
    await waitFor(() => expect(result.current.banks).toHaveLength(1));

    guardedFetch.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "Ya existe un banco con ese nombre" }, false, 409)
    );

    act(() => { result.current.setForm({ name: "Santander" }); });
    await act(async () => { await result.current.create(); });

    expect(result.current.error).toBe("Ya existe un banco con ese nombre");
  });

  it("no llama a la API si el nombre está vacío", async () => {
    const { result } = renderHook(() => useBanks());
    await waitFor(() => expect(result.current.banks).toHaveLength(1));
    guardedFetch.mockClear();

    await act(async () => { await result.current.create(); });

    expect(guardedFetch).not.toHaveBeenCalled();
    expect(result.current.error).toBe("El nombre es obligatorio");
  });

  it("renombra un banco y sale del modo edición", async () => {
    const { result } = renderHook(() => useBanks());
    await waitFor(() => expect(result.current.banks).toHaveLength(1));

    guardedFetch.mockResolvedValueOnce(jsonResponse({ ok: true, bank: { ...santander, name: "Santander Río" } }));
    guardedFetch.mockResolvedValueOnce(jsonResponse({ ok: true, banks: [{ ...santander, name: "Santander Río" }] }));

    act(() => { result.current.setEditingId("b1"); });
    await act(async () => { await result.current.update("b1", { name: "Santander Río", color: "red" }); });

    await waitFor(() => expect(result.current.banks[0].name).toBe("Santander Río"));
    expect(result.current.editingId).toBeNull();
  });

  it("borra un banco y limpia la confirmación", async () => {
    const { result } = renderHook(() => useBanks());
    await waitFor(() => expect(result.current.banks).toHaveLength(1));

    guardedFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    guardedFetch.mockResolvedValueOnce(jsonResponse({ ok: true, banks: [] }));

    act(() => { result.current.setConfirmDeleteId("b1"); });
    await act(async () => { await result.current.remove("b1"); });

    await waitFor(() => expect(result.current.banks).toHaveLength(0));
    expect(result.current.confirmDeleteId).toBeNull();
  });
});
