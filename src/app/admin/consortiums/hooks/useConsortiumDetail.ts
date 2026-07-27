import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { consortiumUrlKey, idFromUrlKey } from "../lib/match";
import type { Consortium, Invoice, Period } from "../lib/types";

export function useConsortiumDetail({ consortiums, loadingList, onConsortiumSelected }: {
  consortiums: Consortium[];
  loadingList: boolean;
  onConsortiumSelected: (c: Consortium, activePeriodId: string | undefined) => void;
}) {
  const { guardedFetch } = useAuthGuard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConsortium, setSelectedConsortium] = useState<Consortium | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<Period | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"boletas" | "pagos" | "obligaciones">("obligaciones");
  const [pendingRestore, setPendingRestore] = useState(false);
  const didRestoreRef = useRef(false);

  const fetchPeriodsAndInvoices = useCallback(async (consortiumId: string, periodId?: string) => {
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/periods`);
      const data = await res.json();
      if (!data.ok) return;
      const allPeriods: Period[] = data.periods ?? [];
      setPeriods(allPeriods);
      const target = periodId
        ? allPeriods.find((p) => p.id === periodId)
        : allPeriods.find((p) => p.status === "ACTIVE") ?? allPeriods[0];
      setSelectedPeriod(target ?? null);
      return target?.id;
    } catch { return undefined; }
  }, [guardedFetch]);

  const fetchInvoices = useCallback(async (consortiumId: string, periodId: string) => {
    setLoadingInvoices(true); setInvoicesError(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/invoices?periodId=${periodId}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInvoices(data.invoices ?? []);
    } catch (err) {
      setInvoicesError(err instanceof Error ? err.message : "Error al cargar boletas");
    } finally { setLoadingInvoices(false); }
  }, [guardedFetch]);

  const selectConsortium = useCallback(async (c: Consortium) => {
    setSelectedId(c.id); setSelectedConsortium(c);
    // Deep-link híbrido: URL legible (slug) + id inmutable al final. Sin navegar.
    window.history.replaceState(null, "", `${window.location.pathname}?c=${consortiumUrlKey(c)}`);
    setActiveTab("obligaciones");
    setInvoices([]); setSearch("");
    const periodId = await fetchPeriodsAndInvoices(c.id);
    if (periodId) void fetchInvoices(c.id, periodId);
    // Fan-out: config (Tanda 3) + obligaciones, en page.tsx.
    onConsortiumSelected(c, periodId);
  }, [fetchPeriodsAndInvoices, fetchInvoices, onConsortiumSelected]);

  const back = useCallback(() => {
    setSelectedId(null); setSelectedConsortium(null); setPendingRestore(false);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const selectPeriod = useCallback((p: Period) => {
    setSelectedPeriod(p);
    if (selectedId) void fetchInvoices(selectedId, p.id);
  }, [selectedId, fetchInvoices]);

  const reloadAfterClose = useCallback(async () => {
    if (!selectedId) return;
    const periodId = await fetchPeriodsAndInvoices(selectedId);
    if (periodId) void fetchInvoices(selectedId, periodId);
  }, [selectedId, fetchPeriodsAndInvoices, fetchInvoices]);

  // Recarga las boletas del consorcio + período seleccionados (tras guardar/pagar/borrar).
  const reloadInvoices = useCallback(() => {
    if (selectedId && selectedPeriod) void fetchInvoices(selectedId, selectedPeriod.id);
  }, [selectedId, selectedPeriod, fetchInvoices]);

  // Deep-link: leer ?c= al montar → marcar restauración.
  useEffect(() => {
    const cid = new URLSearchParams(window.location.search).get("c");
    if (cid) setPendingRestore(true);
  }, []);

  // Restaurar la selección una vez que la lista cargó. Si el id no existe → limpia URL.
  useEffect(() => {
    if (didRestoreRef.current || !pendingRestore || loadingList) return;
    didRestoreRef.current = true;
    const cid = idFromUrlKey(new URLSearchParams(window.location.search).get("c"));
    const target = cid ? consortiums.find((c) => c.id === cid) : null;
    if (target) {
      void selectConsortium(target).finally(() => setPendingRestore(false));
    } else {
      setPendingRestore(false);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [pendingRestore, loadingList, consortiums, selectConsortium]);

  const periodIndex = periods.findIndex((p) => p.id === selectedPeriod?.id);
  const canGoPrev = periodIndex < periods.length - 1;
  const canGoNext = periodIndex > 0;
  const goPrevPeriod = () => { if (canGoPrev) selectPeriod(periods[periodIndex + 1]); };
  const goNextPeriod = () => { if (canGoNext) selectPeriod(periods[periodIndex - 1]); };

  return {
    selectedId, selectedConsortium, setSelectedConsortium, periods, selectedPeriod,
    invoices, setInvoices, loadingInvoices, invoicesError, search, setSearch,
    activeTab, setActiveTab, canGoPrev, canGoNext, pendingRestore,
    selectConsortium, selectPeriod, back, goPrevPeriod, goNextPeriod, reloadAfterClose, reloadInvoices,
  };
}
