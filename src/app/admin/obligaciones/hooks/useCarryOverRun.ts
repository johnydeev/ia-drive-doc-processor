"use client";

import { useCallback, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { useBatchRunner, type BatchEntry } from "@/app/admin/boletas/hooks/useBatchRunner";
import type { BatchItemResult } from "@/app/admin/boletas/lib/batchProgress";
import { CARRY_OVER_BATCH_SIZE } from "@/lib/carryOverBatch";
import type { YearMonth } from "@/lib/periodMonth";

/**
 * Ejecuta por tandas los traslados marcados de un mes.
 *
 * Se dispara DESPUÉS de cerrar el período —recién ahí existe el destino— y no
 * dentro del request del cierre: cerrar es irreversible y tiene que ser atómico,
 * mover es lento y reintentable. El límite de 100 s del túnel es por request, así
 * que partiéndolo en tandas el total deja de tener techo (spec 2026-08-20).
 *
 * Reusa `useBatchRunner`, el mismo motor de tandas de la pantalla de Boletas.
 */
export function useCarryOverRun(onFinished?: () => void | Promise<void>) {
  const { guardedFetch } = useAuthGuard();
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const runner = useBatchRunner({
    chunkSize: CARRY_OVER_BATCH_SIZE,
    runChunk: async (entries: BatchEntry[]) => {
      const results = new Map<string, BatchItemResult>();
      try {
        const res = await guardedFetch("/api/client/obligations/carry-over", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ invoiceIds: entries.map((e) => e.id) }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

        for (const r of data.results as Array<{ invoiceId: string; ok: boolean; error?: string }>) {
          results.set(
            r.invoiceId,
            r.ok ? { status: "done" } : { status: "failed", message: r.error ?? "Falló el traslado" }
          );
        }
      } catch (err) {
        // La tanda entera falló (red, sesión): se marcan todas, y como el traslado
        // es idempotente, reintentar es seguro.
        const message = err instanceof Error ? err.message : "Error";
        for (const entry of entries) results.set(entry.id, { status: "failed", message });
      }
      return results;
    },
  });

  /** Busca lo que quedó marcado sin mover en ese mes. */
  const loadPending = useCallback(
    async (month: YearMonth): Promise<BatchEntry[]> => {
      try {
        const res = await guardedFetch(
          `/api/client/obligations/carry-over/pending?month=${month.month}&year=${month.year}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        const entries = (data.invoices as Array<{ invoiceId: string; consortiumName: string; concepto: string }>)
          .map((inv) => ({ id: inv.invoiceId, label: `${inv.consortiumName} — ${inv.concepto}` }));
        setPendingCount(entries.length);
        setError(null);
        return entries;
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo consultar lo pendiente");
        return [];
      }
    },
    [guardedFetch]
  );

  /** Arranca (o retoma) el traslado de todo lo marcado en ese mes. */
  const run = useCallback(
    async (month: YearMonth) => {
      const entries = await loadPending(month);
      if (entries.length === 0) return;
      await runner.start(entries);
      setPendingCount(0);
      await onFinished?.();
    },
    [loadPending, runner, onFinished]
  );

  return { ...runner, pendingCount, error, loadPending, run };
}
