import { useEffect, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import type { DirectorySyncReport } from "../lib/types";

export function useScheduler({ accessChecked, setToolbarInfo, setToolbarError, onDirectorySynced, onInvoicesReload }: {
  accessChecked: boolean;
  setToolbarInfo: (v: string | null) => void;
  setToolbarError: (v: string | null) => void;
  onDirectorySynced: () => void;
  onInvoicesReload: () => void;
}) {
  const { guardedFetch } = useAuthGuard();
  const [schedulerEnabled, setSchedulerEnabled] = useState<boolean | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [syncReport, setSyncReport] = useState<DirectorySyncReport | null>(null);

  useEffect(() => {
    if (!accessChecked) return;
    (async () => {
      try {
        const res = await guardedFetch("/api/admin/scheduler/status", { method: "GET", cache: "no-store" });
        const data = await res.json();
        if (data.ok && data.state) setSchedulerEnabled(data.state.enabled);
      } catch { /* silent */ }
    })();
  }, [accessChecked, guardedFetch]);

  const handleToggleScheduler = async () => {
    if (schedulerEnabled === null) return;
    setBusyAction("toggle"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/admin/scheduler/toggle", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !schedulerEnabled }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSchedulerEnabled(data.state.enabled);
      setToolbarInfo(data.state.enabled ? "Scheduler encendido." : "Scheduler pausado.");
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  // No hay `handleRunNow`: desde 2026-08-18 "Ejecutar ahora" abre la corrida
  // selectiva (elegir hasta 10 boletas y encolarlas con diagnóstico) en vez de
  // disparar el ciclo completo. El panel ADMIN conserva su propio disparador.

  const handleSyncDirectory = async () => {
    setBusyAction("sync"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/sync-directory", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      // El reporte deja de descartarse: lo consume el modal. Antes sólo se
      // mostraban los contadores en el toast y los avisos se perdían.
      setSyncReport(data.report ?? null);
      const counts = `C: ${data.consortiumsCount ?? 0} | P: ${data.providersCount ?? 0} | R: ${data.rubrosCount ?? 0}`;
      setToolbarInfo(`Directorio sincronizado. ${counts}`);
      onDirectorySynced();
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  /**
   * Aplica los renombres que el usuario tildó en el modal. Manda la lista exacta
   * que se mostró en pantalla; el backend no re-deduce nada del archivo ALTA.
   */
  const applyRenames = async (renames: Array<{ entity: "consortium" | "provider"; id: string; to: string }>) => {
    const res = await guardedFetch("/api/client/sync-directory/renames", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ renames }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setToolbarInfo(`${data.applied} renombre(s) aplicado(s).`);
    setSyncReport(null);
    onDirectorySynced();
  };

  const handleSyncPayments = async () => {
    setBusyAction("syncPayments"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/sync-payments", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const counts = `Creados: ${data.paymentsCreated ?? 0} | Actualizados: ${data.paymentsUpdated ?? 0} | Boletas: ${data.invoicesAffected ?? 0}`;
      setToolbarInfo(`Pagos sincronizados. ${counts}`);
      onInvoicesReload();
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleSetupSheetProtection = async () => {
    setBusyAction("protectSheet"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/setup-sheet-protection", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const syncInfo = data.sync
        ? ` Sync previo: ${data.sync.paymentsCreated} creados, ${data.sync.paymentsUpdated} actualizados.`
        : "";
      setToolbarInfo(`Hoja protegida (${data.columnsProtected ?? 0} columnas).${syncInfo}`);
      onInvoicesReload();
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleUnprotectSheet = async () => {
    if (!window.confirm(
      "Vas a desproteger la hoja. Vas a poder editar las columnas en Google Sheets " +
      "directamente. Recordá apretar 'Proteger hoja' cuando termines — eso disparará " +
      "una sincronización automática para volcar tus cambios a la base.\n\n¿Continuar?"
    )) return;

    setBusyAction("unprotectSheet"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/setup-sheet-protection", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setToolbarInfo(
        data.removedRanges > 0
          ? `Hoja desprotegida. Acordate de re-bloquearla cuando termines.`
          : `La hoja ya estaba desprotegida.`
      );
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  return {
    schedulerEnabled, busyAction,
    handleToggleScheduler, handleSyncDirectory,
    handleSyncPayments, handleSetupSheetProtection, handleUnprotectSheet,
    syncReport, closeSyncReport: () => setSyncReport(null), applyRenames,
  };
}
