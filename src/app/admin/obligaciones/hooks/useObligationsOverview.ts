"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { buildSheets, type ObligationStatus, type OverviewPayload, type SheetData } from "../lib/sheetModel";
import type { TargetOption } from "../lib/availableTargets";

/**
 * Dueño de los datos de la vista global de obligaciones.
 *
 * Al montar sincroniza (idempotente y set-based) y después carga el overview. Si
 * la sincronización falla NO bloquea la pantalla: carga igual y expone un aviso,
 * porque una lista vieja sigue siendo más útil que una pantalla en blanco.
 */
export function useObligationsOverview() {
  const { guardedFetch } = useAuthGuard();

  const [payload, setPayload] = useState<OverviewPayload | null>(null);
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      const res = await guardedFetch("/api/client/obligations/overview", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPayload(data as OverviewPayload);
      setSheets(buildSheets(data as OverviewPayload));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la vista");
      setSheets([]);
    }
  }, [guardedFetch]);

  const sync = useCallback(async () => {
    try {
      const res = await guardedFetch("/api/client/obligations/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSyncWarning(null);
    } catch {
      setSyncWarning("No se pudo sincronizar: la lista puede estar incompleta.");
    }
  }, [guardedFetch]);

  const reload = useCallback(async () => {
    setIsLoading(true);
    await sync();
    await loadOverview();
    setIsLoading(false);
  }, [sync, loadOverview]);

  useEffect(() => { void reload(); }, [reload]);

  const addFixedExpenses = useCallback(
    async (consortiumId: string, targets: TargetOption[]) => {
      if (targets.length === 0) return;
      try {
        const items = targets.map((t) =>
          t.kind === "provider" ? { providerId: t.id } : { lspServiceId: t.id }
        );
        const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/fixed-expenses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudieron agregar los gastos fijos");
      }
      await loadOverview();
    },
    [guardedFetch, loadOverview]
  );

  const toggleFixedExpense = useCallback(
    async (consortiumId: string, fixedExpenseId: string, active: boolean) => {
      try {
        const res = await guardedFetch(
          `/api/client/consortiums/${consortiumId}/fixed-expenses/${fixedExpenseId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ active }),
          }
        );
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo actualizar el gasto fijo");
      }
      await loadOverview();
    },
    [guardedFetch, loadOverview]
  );

  // No hay `deleteFixedExpense` a propósito: el borrado físico arrastra las
  // obligaciones de todos los períodos (`onDelete: Cascade`) y destruiría la
  // evidencia que una rendición de cuentas o una auditoría necesita. Un gasto
  // que deja de corresponder se DESACTIVA.

  /** Pasa una boleta impaga al período siguiente (Drive + Sheets + DB). */
  const carryOverInvoice = useCallback(
    async (invoiceId: string) => {
      try {
        const res = await guardedFetch(`/api/client/invoices/${invoiceId}/carry-over`, {
          method: "POST",
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo pasar la boleta");
      }
      await loadOverview();
    },
    [guardedFetch, loadOverview]
  );

  /** Carga el importe del 2° vencimiento de una boleta arrastrada. */
  const setLateAmount = useCallback(
    async (invoiceId: string, lateAmount: number) => {
      try {
        const res = await guardedFetch(`/api/client/invoices/${invoiceId}/late-amount`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lateAmount }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo cargar el monto vencido");
      }
      await loadOverview();
    },
    [guardedFetch, loadOverview]
  );

  const setObligationStatus = useCallback(
    async (obligationId: string, status: Extract<ObligationStatus, "PENDING" | "SKIPPED">) => {
      try {
        const res = await guardedFetch(`/api/client/obligations/${obligationId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo cambiar el estado");
        return;
      }
      await loadOverview();
    },
    [guardedFetch, loadOverview]
  );

  return {
    payload,
    sheets,
    majorityLabel: payload?.majorityLabel ?? null,
    isLoading,
    error,
    syncWarning,
    reload,
    addFixedExpenses,
    toggleFixedExpense,
    setObligationStatus,
    carryOverInvoice,
    setLateAmount,
  };
}
