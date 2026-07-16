import { describe, it, expect, vi } from "vitest";
import { createSessionValidityResolver } from "./sessionRevocation";

const activeClient = { isActive: true, role: "CLIENT" as const };

describe("createSessionValidityResolver", () => {
  it("consulta la DB la primera vez y cachea dentro del TTL", async () => {
    const fetchAccount = vi.fn(async () => activeClient);
    let clock = 0;
    const resolve = createSessionValidityResolver({ fetchAccount, ttlMs: 60_000, now: () => clock });

    expect(await resolve("cli-1")).toEqual(activeClient);
    clock = 59_000;
    expect(await resolve("cli-1")).toEqual(activeClient);
    expect(fetchAccount).toHaveBeenCalledTimes(1);
  });

  it("re-consulta cuando el TTL venció", async () => {
    const fetchAccount = vi.fn(async () => activeClient);
    let clock = 0;
    const resolve = createSessionValidityResolver({ fetchAccount, ttlMs: 60_000, now: () => clock });

    await resolve("cli-1");
    clock = 61_000;
    await resolve("cli-1");
    expect(fetchAccount).toHaveBeenCalledTimes(2);
  });

  it("cliente inactivo o inexistente → null (sesión inválida)", async () => {
    const resolveInactive = createSessionValidityResolver({
      fetchAccount: async () => ({ isActive: false, role: "CLIENT" as const }),
      ttlMs: 60_000,
      now: () => 0,
    });
    expect(await resolveInactive("cli-1")).toBeNull();

    const resolveMissing = createSessionValidityResolver({
      fetchAccount: async () => null,
      ttlMs: 60_000,
      now: () => 0,
    });
    expect(await resolveMissing("cli-1")).toBeNull();
  });

  it("si la DB falla usa el cache vencido; sin cache previo → null (fail-closed)", async () => {
    let shouldFail = false;
    let clock = 0;
    const fetchAccount = vi.fn(async () => {
      if (shouldFail) throw new Error("P1001");
      return activeClient;
    });
    const resolve = createSessionValidityResolver({ fetchAccount, ttlMs: 60_000, now: () => clock });

    await resolve("cli-1"); // cachea
    shouldFail = true;
    clock = 120_000; // cache vencido
    expect(await resolve("cli-1")).toEqual(activeClient); // stale pero usable

    expect(await resolve("cli-nunca-visto")).toBeNull(); // sin cache → rechazo
  });

  it("clientes distintos cachean por separado", async () => {
    const fetchAccount = vi.fn(async (id: string) =>
      id === "cli-1" ? activeClient : { isActive: false, role: "CLIENT" as const }
    );
    const resolve = createSessionValidityResolver({ fetchAccount, ttlMs: 60_000, now: () => 0 });
    expect(await resolve("cli-1")).toEqual(activeClient);
    expect(await resolve("cli-2")).toBeNull();
  });

  it("la desactivación se refleja al vencer el TTL (revocación en ≤TTL)", async () => {
    let isActive = true;
    let clock = 0;
    const fetchAccount = vi.fn(async () => ({ isActive, role: "CLIENT" as const }));
    const resolve = createSessionValidityResolver({ fetchAccount, ttlMs: 60_000, now: () => clock });

    expect(await resolve("cli-1")).not.toBeNull();
    isActive = false; // el ADMIN desactiva al cliente
    clock = 30_000; // dentro del TTL: sigue el cache (aceptado por diseño)
    expect(await resolve("cli-1")).not.toBeNull();
    clock = 61_000; // TTL vencido: re-consulta y rechaza
    expect(await resolve("cli-1")).toBeNull();
  });
});
