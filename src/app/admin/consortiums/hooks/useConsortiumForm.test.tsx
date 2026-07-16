import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useConsortiumForm } from "./useConsortiumForm";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));

beforeEach(() => guardedFetch.mockReset());

describe("useConsortiumForm", () => {
  it("open/close alterna isOpen y limpia mensajes", () => {
    const { result } = renderHook(() => useConsortiumForm(() => {}));
    expect(result.current.isOpen).toBe(false);
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });

  it("submit con nombre vacío setea error y NO llama al fetch", async () => {
    const { result } = renderHook(() => useConsortiumForm(() => {}));
    await act(async () => { await result.current.submit(); });
    expect(result.current.error).toBe("El nombre del consorcio es obligatorio");
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("submit OK: llama onCreated, setea success y resetea el form", async () => {
    guardedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const onCreated = vi.fn();
    const { result } = renderHook(() => useConsortiumForm(onCreated));
    act(() => result.current.setField({ canonicalName: "THAMES 647" }));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.success).toBe("Consorcio creado correctamente."));
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(result.current.form.canonicalName).toBe("");
  });

  it("submit con error del backend setea error", async () => {
    guardedFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, error: "CUIT inválido" }) });
    const { result } = renderHook(() => useConsortiumForm(() => {}));
    act(() => result.current.setField({ canonicalName: "X" }));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.error).toBe("CUIT inválido"));
  });
});
