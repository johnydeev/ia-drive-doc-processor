"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { buildSheets, type ObligationStatus, type OverviewPayload, type SheetData } from "../lib/sheetModel";
import { nextMonth, previousMonth, type YearMonth } from "@/lib/periodMonth";
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
  /** Mes que se está viendo. `null` = el que decida el servidor (el mayoritario). */
  const [month, setMonth] = useState<YearMonth | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      const query = month ? `?month=${month.month}&year=${month.year}` : "";
      const res = await guardedFetch(`/api/client/obligations/overview${query}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const payload = data as OverviewPayload;
      setPayload(payload);
      setSheets(buildSheets(payload));
      // La primera carga no pide mes: se adopta el que resolvió el servidor para
      // que la navegación tenga desde dónde partir.
      if (payload.month != null && payload.year != null) {
        setMonth({ month: payload.month, year: payload.year });
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la vista");
      setSheets([]);
    }
  }, [guardedFetch, month]);

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

  /**
   * Marca (o desmarca) una boleta para pasar al mes siguiente. **No la mueve**:
   * el traslado ocurre después de cerrar el período, por tandas.
   */
  const toggleCarryOver = useCallback(
    async (invoiceId: string, requested: boolean) => {
      try {
        const res = await guardedFetch(`/api/client/invoices/${invoiceId}/carry-over`, {
          method: requested ? "POST" : "DELETE",
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo marcar la boleta");
      }
      await loadOverview();
    },
    [guardedFetch, loadOverview]
  );

  /** Devuelve al mes de origen una boleta que ya se trasladó. */
  const undoCarryOver = useCallback(
    async (invoiceId: string) => {
      try {
        const res = await guardedFetch(`/api/client/invoices/${invoiceId}/carry-over/undo`, {
          method: "POST",
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo devolver la boleta");
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

  const goToPreviousMonth = useCallback(() => {
    setMonth((current) => (current ? previousMonth(current) : current));
  }, []);

  const goToNextMonth = useCallback(() => {
    setMonth((current) => (current ? nextMonth(current) : current));
  }, []);

  return {
    payload,
    sheets,
    month,
    monthLabel: payload?.monthLabel ?? null,
    goToPreviousMonth,
    goToNextMonth,
    isLoading,
    error,
    syncWarning,
    reload,
    addFixedExpenses,
    toggleFixedExpense,
    setObligationStatus,
    toggleCarryOver,
    undoCarryOver,
    setLateAmount,
  };
}
