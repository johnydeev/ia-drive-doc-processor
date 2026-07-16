import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProviderForm } from "./useProviderForm";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));

beforeEach(() => guardedFetch.mockReset());

const provider = { id: "p1", canonicalName: "TIGRE", cuit: "27-33906838-6", paymentAlias: null };

describe("useProviderForm", () => {
  it("submit sin razón social o CUIT setea error y no llama al fetch", async () => {
    const { result } = renderHook(() => useProviderForm(() => {}));
    act(() => result.current.setField({ canonicalName: "TIGRE" })); // falta CUIT
    await act(async () => { await result.current.submit(); });
    expect(result.current.error).toBe("Razón social y CUIT son obligatorios");
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("submit OK: llama onCreated con el provider y resetea el form", async () => {
    guardedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, provider, requeued: 0 }) });
    const onCreated = vi.fn();
    const { result } = renderHook(() => useProviderForm(onCreated));
    act(() => result.current.setField({ canonicalName: "TIGRE", cuit: "27-33906838-6" }));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.success).toContain("Proveedor creado correctamente."));
    expect(onCreated).toHaveBeenCalledWith(provider);
    expect(result.current.form.canonicalName).toBe("");
  });

  it("submit OK con reencolado incluye el aviso en el success", async () => {
    guardedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, provider, requeued: 3 }) });
    const { result } = renderHook(() => useProviderForm(() => {}));
    act(() => result.current.setField({ canonicalName: "TIGRE", cuit: "27-33906838-6" }));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.success).toContain("3 boleta(s)"));
  });
});
