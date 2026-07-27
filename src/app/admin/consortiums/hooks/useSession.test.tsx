import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSession } from "./useSession";

const guardedFetch = vi.fn();
const replace = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }) }));
beforeEach(() => { guardedFetch.mockReset(); replace.mockReset(); });

describe("useSession", () => {
  it("con acceso OK setea el usuario y accessChecked", async () => {
    guardedFetch.mockResolvedValue({ json: async () => ({ ok: true, user: { name: "Ana", role: "CLIENT", consortiumsEnabled: true } }) });
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.accessChecked).toBe(true));
    expect(result.current.userName).toBe("Ana");
    expect(result.current.consortiumsEnabled).toBe(true);
  });
  it("sin consortiumsEnabled redirige a /admin", async () => {
    guardedFetch.mockResolvedValue({ json: async () => ({ ok: true, user: { consortiumsEnabled: false } }) });
    renderHook(() => useSession());
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/admin"));
  });
});
