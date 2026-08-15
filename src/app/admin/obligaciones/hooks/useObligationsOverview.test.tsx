import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useObligationsOverview } from "./useObligationsOverview";

// La referencia de `guardedFetch` tiene que ser estable entre renders: el
// `useEffect` de carga depende de ella y una función nueva por render lo
// dispararía en loop.
const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));

const payload = {
  ok: true,
  majorityLabel: "julio 2026",
  providers: [{ id: "p1", canonicalName: "SEGURO", paymentAlias: null }],
  consortiums: [
    {
      consortiumId: "c1",
      consortiumName: "FRANKLIN 25",
      bankId: "b1", bankName: "Santander", bankColor: "red",
      periodId: "per1", periodLabel: "julio 2026",
      lspServices: [],
      fixedExpenses: [
        { id: "fx1", providerId: "p1", lspServiceId: null, description: null, active: true,
          obligation: { id: "ob1", status: "PENDING", amount: null } },
      ],
    },
  ],
};

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  guardedFetch.mockReset();
  guardedFetch.mockImplementation(async (url: string) => {
    if (url.includes("/obligations/sync")) return jsonOk({ ok: true, created: 2, linked: 0, periods: 1 });
    if (url.includes("/obligations/overview")) return jsonOk(payload);
    return jsonOk({ ok: true });
  });
});

describe("useObligationsOverview", () => {
  it("sincroniza antes de cargar el overview", async () => {
    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const urls = guardedFetch.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain("/api/client/obligations/sync");
    expect(urls[1]).toContain("/api/client/obligations/overview");
    expect(result.current.sheets).toHaveLength(1);
    expect(result.current.sheets[0].consortiumName).toBe("FRANKLIN 25");
  });

  it("si la sincronización falla, igual carga y avisa", async () => {
    guardedFetch.mockImplementation(async (url: string) => {
      if (url.includes("/obligations/sync")) throw new Error("red caída");
      if (url.includes("/obligations/overview")) return jsonOk(payload);
      return jsonOk({ ok: true });
    });

    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.syncWarning).toMatch(/no se pudo sincronizar/i);
    expect(result.current.sheets).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("si el overview falla, expone el error", async () => {
    guardedFetch.mockImplementation(async (url: string) => {
      if (url.includes("/obligations/sync")) return jsonOk({ ok: true, created: 0, linked: 0, periods: 0 });
      return { ok: false, status: 500, json: async () => ({ ok: false, error: "explotó" }) } as unknown as Response;
    });

    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe("explotó");
    expect(result.current.sheets).toEqual([]);
  });

  it("addFixedExpenses postea los items y recarga", async () => {
    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    guardedFetch.mockClear();

    await act(async () => {
      await result.current.addFixedExpenses("c1", [
        { kind: "provider", id: "p2", label: "TECNOPAS" },
        { kind: "lsp", id: "l1", label: "AYSA (66757)" },
      ]);
    });

    const post = guardedFetch.mock.calls.find((c) => (c[0] as string).includes("/fixed-expenses"))!;
    expect(post[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({
      items: [{ providerId: "p2" }, { lspServiceId: "l1" }],
    });
    expect(guardedFetch.mock.calls.some((c) => (c[0] as string).includes("/overview"))).toBe(true);
  });

  it("setObligationStatus propaga el mensaje de error del servidor", async () => {
    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    guardedFetch.mockImplementation(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, error: "La obligación ya tiene boleta recibida." }),
    }) as unknown as Response);

    await act(async () => {
      await result.current.setObligationStatus("ob1", "SKIPPED");
    });

    expect(result.current.error).toBe("La obligación ya tiene boleta recibida.");
  });

  it("toggleFixedExpense patchea el gasto fijo y recarga", async () => {
    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    guardedFetch.mockClear();

    await act(async () => {
      await result.current.toggleFixedExpense("c1", "fx1", false);
    });

    const patch = guardedFetch.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH")!;
    expect(patch[0]).toBe("/api/client/consortiums/c1/fixed-expenses/fx1");
    expect(JSON.parse((patch[1] as RequestInit).body as string)).toEqual({ active: false });
    expect(guardedFetch.mock.calls.some((c) => (c[0] as string).includes("/overview"))).toBe(true);
  });

  // El borrado físico no se expone: arrastra las obligaciones de todos los
  // períodos por `onDelete: Cascade` y destruiría el historial.
  it("el hook no expone ningún borrado de gasto fijo", async () => {
    const { result } = renderHook(() => useObligationsOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect("deleteFixedExpense" in result.current).toBe(false);
  });
});
