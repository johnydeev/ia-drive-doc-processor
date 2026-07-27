import { useCallback, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import type { ObligationRow } from "../lib/types";

export function useObligations() {
  const { guardedFetch } = useAuthGuard();
  const [obligations, setObligations] = useState<ObligationRow[]>([]);

  const load = useCallback(async (periodId: string) => {
    try {
      const res = await guardedFetch(`/api/client/periods/${periodId}/obligations`, { cache: "no-store" });
      const data = await res.json();
      if (data.ok) setObligations(data.obligations ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  const generate = useCallback(async (periodId: string) => {
    await guardedFetch(`/api/client/periods/${periodId}/obligations`, { method: "POST" });
    await load(periodId);
  }, [guardedFetch, load]);

  const setStatus = useCallback(async (id: string, status: "PENDING" | "SKIPPED", periodId: string) => {
    await guardedFetch(`/api/client/obligations/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }),
    });
    await load(periodId);
  }, [guardedFetch, load]);

  const clear = useCallback(() => setObligations([]), []);

  return { obligations, load, generate, setStatus, clear };
}
