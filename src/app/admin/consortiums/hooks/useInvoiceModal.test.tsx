import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useInvoiceModal } from "./useInvoiceModal";
import type { Provider } from "../lib/types";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));
beforeEach(() => guardedFetch.mockReset());

const providers: Provider[] = [{ id: "pr1", canonicalName: "EDESUR", cuit: "30-65511651-2", paymentAlias: null }];

function deps(over: Partial<Parameters<typeof useInvoiceModal>[0]> = {}) {
  return {
    consortiumId: "c1", periodId: "per1", providers,
    onCreated: vi.fn(), addCoeficiente: vi.fn(), addRubro: vi.fn(),
    setToolbarInfo: vi.fn(), setToolbarError: vi.fn(), ...over,
  };
}

describe("useInvoiceModal", () => {
  it("open/close alterna isOpen", () => {
    const { result } = renderHook(() => useInvoiceModal(deps()));
    expect(result.current.isOpen).toBe(false);
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });

  it("scan con consortiumMismatch setea mismatchConsortium", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, consortiumMismatch: true, foundConsortium: "OTRO CONSORCIO" }) });
    const { result } = renderHook(() => useInvoiceModal(deps()));
    await act(async () => { await result.current.onFileChange({ target: { files: [new File(["x"], "b.pdf")] } } as unknown as React.ChangeEvent<HTMLInputElement>); });
    await waitFor(() => expect(result.current.mismatchConsortium).toBe("OTRO CONSORCIO"));
  });

  it("submit sin proveedor setea error y no hace POST de boleta", async () => {
    const d = deps();
    const { result } = renderHook(() => useInvoiceModal(d));
    await act(async () => { await result.current.submit(); });
    expect(result.current.error).toBe("Seleccioná un proveedor");
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("submit OK: llama onCreated, cierra y muestra info", async () => {
    guardedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, invoice: { id: "i9" } }) });
    const d = deps();
    const { result } = renderHook(() => useInvoiceModal(d));
    act(() => { result.current.open(); result.current.setField({ providerId: "pr1" }); });
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(d.onCreated).toHaveBeenCalledWith({ id: "i9" }));
    expect(result.current.isOpen).toBe(false);
    expect(d.setToolbarInfo).toHaveBeenCalledWith("Boleta cargada y enviada a Google Sheets.");
  });
});
