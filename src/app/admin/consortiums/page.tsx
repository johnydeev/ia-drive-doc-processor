"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { AsyncButton } from "@/components/AsyncButton";
import type { Coeficiente, Rubro, Consortium, Provider } from "./lib/types";
import {
  MONTH_NAMES, formatPeriod, formatAmount, formatDate,
} from "./lib/format";
import { normName } from "./lib/match";
import { useConsortiumForm } from "./hooks/useConsortiumForm";
import { ConsortiumFormModal } from "./components/ConsortiumFormModal";
import { useProviderForm } from "./hooks/useProviderForm";
import { ProviderFormModal } from "./components/ProviderFormModal";
import { PagosView } from "./components/PagosView";
import { useObligations } from "./hooks/useObligations";
import { useConsortiumDetail } from "./hooks/useConsortiumDetail";
import { useClosePeriod } from "./hooks/useClosePeriod";
import { ClosePeriodModal } from "./components/ClosePeriodModal";
import { usePayModal } from "./hooks/usePayModal";
import { PayModal } from "./components/PayModal";
import { useViewPayments } from "./hooks/useViewPayments";
import { ViewPaymentsModal } from "./components/ViewPaymentsModal";
import { useCloseAllModal } from "./hooks/useCloseAllModal";
import { CloseAllModal } from "./components/CloseAllModal";
import { useUnassignedModal } from "./hooks/useUnassignedModal";
import { UnassignedModal } from "./components/UnassignedModal";
import { DirectorySyncModal } from "./components/DirectorySyncModal";
import { useSession } from "./hooks/useSession";
import { useTheme } from "./hooks/useTheme";
import { useToolbarToast } from "./hooks/useToolbarToast";
import { useScheduler } from "./hooks/useScheduler";
import { useInvoiceModal } from "./hooks/useInvoiceModal";
import { InvoiceModal } from "./components/InvoiceModal";
import { MismatchModal } from "./components/MismatchModal";
import { useConsortiumConfig } from "./hooks/useConsortiumConfig";
import { ConfigModal } from "./components/ConfigModal";
import { useBanks } from "./hooks/useBanks";
import { BanksModal } from "./components/BanksModal";
import { ManualRunModal } from "./components/ManualRunModal";
import { useManualRun } from "./hooks/useManualRun";
import { BankGrid } from "./components/BankGrid";
import { groupByBank, UNASSIGNED_BANK_ID } from "./lib/groupByBank";

export default function ConsortiumsPage() {
  const router = useRouter();
  const { guardedFetch } = useAuthGuard();
  const { accessChecked, userName, userRole, consortiumsEnabled, handleLogout } = useSession();
  const { theme } = useTheme();
  const { toolbarInfo, toolbarError, setToolbarInfo, setToolbarError } = useToolbarToast();

  // Nav sidebar
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [navMobileOpen, setNavMobileOpen] = useState(false);

  const [consortiums, setConsortiums] = useState<Consortium[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  // Búsqueda de la vista general de tarjetas (independiente del `search` de boletas).
  const [consortiumSearch, setConsortiumSearch] = useState("");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [coeficientes, setCoeficientes] = useState<Coeficiente[]>([]);
  const [rubros, setRubros] = useState<Rubro[]>([]);

  // Receipt upload state — un input ref oculto por invoice
  const receiptInputRef = useRef<HTMLInputElement>(null);
  const [uploadingReceiptId, setUploadingReceiptId] = useState<string | null>(null);


  const [copiedStatementsId, setCopiedStatementsId] = useState<string | null>(null);



  // Eliminar boleta (pestaña Boletas)
  const [confirmDeleteInvoiceId, setConfirmDeleteInvoiceId] = useState<string | null>(null);

  const fetchConsortiums = useCallback(async () => {
    setLoadingList(true); setListError(null);
    try {
      const res = await guardedFetch("/api/client/consortiums", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setConsortiums(data.consortiums ?? []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Error al cargar consorcios");
    } finally { setLoadingList(false); }
  }, [guardedFetch]);

  useEffect(() => { void fetchConsortiums(); }, [fetchConsortiums]);

  const consortium = useConsortiumForm(fetchConsortiums);
  const provider = useProviderForm((p) => setProviders((prev) => [...prev, p]));

  // Catálogo de bancos + navegación de 2 niveles de la vista general:
  // nivel 0 = cards de banco, nivel 1 = grilla de edificios del banco elegido.
  const banks = useBanks();
  const [manualRunOpen, setManualRunOpen] = useState(false);
  const manualRun = useManualRun(manualRunOpen);
  const [selectedBankId, setSelectedBankId] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await guardedFetch("/api/client/providers", { cache: "no-store" });
      const data = await res.json();
      if (data.ok) setProviders(data.providers ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  useEffect(() => { void fetchProviders(); }, [fetchProviders]);


  const fetchCoeficientes = useCallback(async (consortiumId: string) => {
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/coeficientes`);
      const data = await res.json();
      if (data.ok) setCoeficientes(data.coeficientes ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  const fetchRubros = useCallback(async (consortiumId: string) => {
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/rubros`);
      const data = await res.json();
      if (data.ok) setRubros(data.rubros ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  // ── Núcleo de detalle (Tanda 2): obligaciones + cascada + cerrar período ──
  const { obligations, load: loadObligations, generate: generateObligations, setStatus: setObligationStatus, clear: clearObligations } = useObligations();

  const detail = useConsortiumDetail({
    consortiums,
    loadingList,
    onConsortiumSelected: (c, activePeriodId) => {
      // Datos de referencia (los consume el modal Boleta, no son de config):
      void fetchCoeficientes(c.id); void fetchRubros(c.id);
      setConfirmDeleteInvoiceId(null);
      // Config del consorcio (Tanda 3e): resets + LSP + gastos fijos.
      config.load(c);
      // Obligaciones (Tanda 2):
      clearObligations();
      if (activePeriodId) void loadObligations(activePeriodId);
    },
  });
  const {
    selectedId, selectedConsortium, setSelectedConsortium, selectedPeriod,
    invoices, setInvoices, loadingInvoices, invoicesError, search, setSearch,
    activeTab, setActiveTab, canGoPrev, canGoNext, pendingRestore,
    selectConsortium, back, goPrevPeriod, goNextPeriod, reloadAfterClose, reloadInvoices,
  } = detail;

  const closePeriod = useClosePeriod({
    consortiumId: selectedId,
    periodId: selectedPeriod?.id ?? null,
    onClosed: () => { void fetchConsortiums(); void reloadAfterClose(); },
  });

  // Configuración del consorcio (Tanda 3e): acordeón matchNames / LSP / gastos fijos.
  // Se declara después de `detail` porque necesita `selectedId`; el callback
  // `onConsortiumSelected` de arriba lo referencia sin TDZ (corre en un handler
  // posterior al render, con `config` ya inicializado).
  const config = useConsortiumConfig({
    consortiumId: selectedId,
    onMatchNamesSaved: (matchNames) =>
      setSelectedConsortium((prev) => prev ? { ...prev, matchNames } : prev),
    // Cambiar el banco reordena los grupos del nivel 0 → recargar la lista.
    onBankSaved: () => { void fetchConsortiums(); },
  });

  // Pagos (Tanda 3a): modal Pagar + modal Ver pagos (disparados desde PagosView).
  const payModal = usePayModal({ onSaved: reloadInvoices });
  const viewPayments = useViewPayments();

  // Modales globales de toolbar (Tanda 3b).
  const closeAll = useCloseAllModal({ onExecuted: fetchConsortiums });
  const unassigned = useUnassignedModal();

  // Scheduler + acciones de toolbar (Tanda 3c).
  const {
    schedulerEnabled, busyAction,
    handleToggleScheduler, handleRunNow, handleSyncDirectory,
    handleSyncPayments, handleSetupSheetProtection, handleUnprotectSheet,
    syncReport, closeSyncReport, applyRenames,
  } = useScheduler({
    accessChecked,
    setToolbarInfo, setToolbarError,
    onDirectorySynced: fetchConsortiums,
    onInvoicesReload: reloadInvoices,
  });

  // Modal Boleta (crear/scan/mismatch) — Tanda 3d.
  const invoiceModal = useInvoiceModal({
    consortiumId: selectedId,
    periodId: selectedPeriod?.id ?? null,
    providers,
    onCreated: (inv) => setInvoices((prev) => [inv, ...prev]),
    addCoeficiente: (c) => setCoeficientes((prev) => [...prev, c]),
    addRubro: (r) => setRubros((prev) => [...prev, r]),
    setToolbarInfo, setToolbarError,
  });

  // Elimina la boleta: borra el Invoice + el recibo asociado + la fila de Sheets, y
  // mueve el PDF a **Revisión** (`failed`) — NO a Pendientes, para que el scheduler no
  // la reprocese y la recree.
  // Para CORREGIR una boleta mal procesada hay que borrarla desde "Boletas entrantes"
  // (/admin/boletas): esa vista borra con destino `pending`, así el worker la vuelve a
  // procesar. Ver `src/lib/invoiceDeletion.ts` (InvoiceDeleteDestination).
  // Bloqueado si tiene pagos (el backend responde 409).
  const handleDeleteInvoice = async (invoiceId: string) => {
    if (!selectedId) return;
    try {
      const res = await guardedFetch(`/api/client/consortiums/${selectedId}/invoices/${invoiceId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInvoices((prev) => prev.filter((i) => i.id !== invoiceId));
      setToolbarInfo("Boleta eliminada.");
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error al eliminar boleta");
    } finally {
      setConfirmDeleteInvoiceId(null);
    }
  };

  // Período actual del cliente = mes mayoritario entre los períodos ACTIVOS de los
  // consorcios cargados (mismo criterio que resolveMajorityMonth, pero client-side).
  const currentPeriodLabel = (() => {
    const freq = new Map<string, { count: number; month: number; year: number }>();
    for (const c of consortiums) {
      const active = c.periods.find((p) => p.status === "ACTIVE");
      if (!active) continue;
      const key = `${active.year}-${active.month}`;
      const cur = freq.get(key);
      if (cur) cur.count += 1;
      else freq.set(key, { count: 1, month: active.month, year: active.year });
    }
    let best: { count: number; month: number; year: number } | null = null;
    for (const v of freq.values()) if (!best || v.count > best.count) best = v;
    return best ? `${MONTH_NAMES[best.month - 1]} ${best.year}` : null;
  })();


  // ── Upload de recibo ──────────────────────────────────────────────────────
  const handleReceiptUpload = async (invoiceId: string, file: File) => {
    if (!selectedId) return;
    setUploadingReceiptId(invoiceId);
    try {
      const fd = new FormData();
      fd.append("receipt", file);
      const res = await guardedFetch(
        `/api/client/consortiums/${selectedId}/invoices/${invoiceId}/receipt`,
        { method: "POST", body: fd }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      // Actualizar la invoice en el estado local con los nuevos campos
      setInvoices((prev) => prev.map((inv) =>
        inv.id === invoiceId
          ? { ...inv, isPaid: data.invoice.isPaid ?? inv.isPaid, remainingBalance: data.invoice.remainingBalance ?? inv.remainingBalance }
          : inv
      ));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error al subir el recibo");
    } finally {
      setUploadingReceiptId(null);
      if (receiptInputRef.current) receiptInputRef.current.value = "";
    }
  };

  const filteredInvoices = invoices.filter((inv) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return inv.boletaNumber?.toLowerCase().includes(q) || inv.provider?.toLowerCase().includes(q) || inv.providerTaxId?.includes(q);
  });

  // Los totales del header se calculan sobre el período completo, no sobre
  // el subset filtrado — el filtro afecta la tabla visible, no las métricas.
  const totalAmount = invoices.reduce((s, i) => s + (i.amount != null ? Number(i.amount) : 0), 0);

  if (!accessChecked) return null;

  const isClient = userRole === "CLIENT";
  const paused = schedulerEnabled === false;

  return (
    <div className={styles.page} data-theme={theme}>
      <div className={styles.gridBackdrop} />

      {/* Input oculto compartido para subir recibos */}
      <input
        ref={receiptInputRef}
        type="file"
        accept=".pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          const invoiceId = receiptInputRef.current?.dataset.invoiceId;
          if (file && invoiceId) void handleReceiptUpload(invoiceId, file);
        }}
      />

      {/* Mobile overlay */}
      {navMobileOpen && (
        <div className={styles.navSidebarOverlay} onClick={() => setNavMobileOpen(false)} />
      )}

      {/* ── Columna 1: NavSidebar ── */}
      <aside className={`${styles.navSidebar} ${navCollapsed ? styles.navSidebarCollapsed : ""} ${navMobileOpen ? styles.navSidebarOpen : ""}`}>
        <div className={styles.navSidebarLogo}>
          <div className={styles.navSidebarLogoIcon}>🏢</div>
          {!navCollapsed && <span className={styles.navSidebarLogoText}>{userName || "Cliente"}</span>}
        </div>
        <div className={styles.navSidebarDivider} />
        <nav className={styles.navSidebarNav}>
          <button type="button" className={styles.navSidebarItem} onClick={() => { handleSyncDirectory(); setNavMobileOpen(false); }} disabled={busyAction !== null}>
            <span className={styles.navSidebarItemIcon}>🔄</span>
            {!navCollapsed && <span className={styles.navSidebarItemLabel}>{busyAction === "sync" ? "Sincronizando..." : "Sincronizar directorio"}</span>}
          </button>
          <button type="button" className={styles.navSidebarItem} onClick={() => { banks.open(); setNavMobileOpen(false); }}>
            <span className={styles.navSidebarItemIcon}>🏦</span>
            {!navCollapsed && <span className={styles.navSidebarItemLabel}>Bancos</span>}
          </button>
          {/* Navega a otra ruta, por eso es <a> y no <button>: la clase es la misma
              que la de los botones hermanos para que se vea igual. */}
          {isClient && (
            <a href="/admin/obligaciones" className={styles.navSidebarItem} onClick={() => setNavMobileOpen(false)}>
              <span className={styles.navSidebarItemIcon}>📋</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>Obligaciones</span>}
            </a>
          )}
          {isClient && (
            // Desactivado temporalmente (pedido del owner): visible pero inactivo mientras el
            // cliente explora la vista. El onClick queda cableado (nunca dispara por `disabled`);
            // reactivar = cambiar `disabled` por `disabled={busyAction !== null}`.
            <button type="button" className={styles.navSidebarItem} onClick={() => { handleSyncPayments(); setNavMobileOpen(false); }} disabled title="Sincronización de pagos desactivada temporalmente">
              <span className={styles.navSidebarItemIcon}>💵</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>Sincronizar pagos</span>}
            </button>
          )}
          {isClient && (
            <button type="button" className={styles.navSidebarItem} onClick={() => { handleSetupSheetProtection(); setNavMobileOpen(false); }} disabled={busyAction !== null} title="Sincroniza pagos pendientes y protege las columnas A:U de la hoja de boletas">
              <span className={styles.navSidebarItemIcon}>🔒</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>{busyAction === "protectSheet" ? "Protegiendo..." : "Proteger hoja"}</span>}
            </button>
          )}
          {isClient && (
            <button type="button" className={styles.navSidebarItem} onClick={() => { handleUnprotectSheet(); setNavMobileOpen(false); }} disabled={busyAction !== null} title="Desbloquea la hoja para editarla manualmente en casos puntuales">
              <span className={styles.navSidebarItemIcon}>🔓</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>{busyAction === "unprotectSheet" ? "Desprotegiendo..." : "Desproteger hoja"}</span>}
            </button>
          )}
          {/* Solo dentro de un consorcio: en la vista general (grid) es redundante — ya estamos ahí.
              Al clickear vuelve a la vista general de tarjetas. */}
          {selectedId && (
            <button type="button" className={styles.navSidebarItem} onClick={() => { back(); setNavMobileOpen(false); }} disabled={!consortiumsEnabled} title={!consortiumsEnabled ? "Función Premium" : "Volver a la vista general de consorcios"}>
              <span className={styles.navSidebarItemIcon}>🏢</span>
              {!navCollapsed && (
                <span className={styles.navSidebarItemLabel}>
                  Consorcios
                  {!consortiumsEnabled && <span className={styles.premiumBadge}>Premium</span>}
                </span>
              )}
            </button>
          )}
          {isClient && (
            <button type="button" className={styles.navSidebarItem} onClick={() => { void closeAll.open(); setNavMobileOpen(false); }} disabled={closeAll.loading || busyAction !== null}>
              <span className={styles.navSidebarItemIcon}>📅</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>{closeAll.loading ? "Cargando..." : "Cerrar Periodo General"}</span>}
            </button>
          )}
          {isClient && (
            <button type="button" className={styles.navSidebarItem} onClick={() => { void unassigned.open(); setNavMobileOpen(false); }} disabled={unassigned.loading || busyAction !== null}>
              <span className={styles.navSidebarItemIcon}>♻️</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>{unassigned.loading ? "Consultando..." : "Sin Asignar"}</span>}
            </button>
          )}
          {isClient && (
            <button type="button" className={styles.navSidebarItem} onClick={() => { router.push("/admin/boletas"); setNavMobileOpen(false); }} title="Todas las boletas en orden de entrada (como el Sheet), para revisar y borrar las últimas">
              <span className={styles.navSidebarItemIcon}>📋</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>Boletas entrantes</span>}
            </button>
          )}
        </nav>
        <div style={{ flex: 1 }} />

        {/* ── Controles del scheduler (movidos desde el toolbar superior) ── */}
        {isClient && schedulerEnabled !== null && (
          <button
            type="button"
            className={styles.navSidebarItem}
            onClick={() => { handleToggleScheduler(); setNavMobileOpen(false); }}
            disabled={busyAction !== null}
            title={paused ? "Reanudar el scheduler" : "Pausar el scheduler"}
          >
            <span className={styles.navSidebarItemIcon}>{paused ? "▶️" : "⏸️"}</span>
            {!navCollapsed && (
              <span className={styles.navSidebarItemLabel}>
                {paused ? "Encender scheduler" : "Pausar scheduler"}
              </span>
            )}
          </button>
        )}
        {isClient && (
          <button
            type="button"
            className={styles.navSidebarItem}
            onClick={() => { setManualRunOpen(true); setNavMobileOpen(false); }}
            disabled={busyAction !== null}
            title="Elegir boletas de Pendientes y encolarlas con diagnóstico"
          >
            <span className={styles.navSidebarItemIcon}>⚡</span>
            {!navCollapsed && <span className={styles.navSidebarItemLabel}>Ejecutar ahora</span>}
          </button>
        )}

        <div className={styles.navSidebarDivider} />

        <button type="button" className={styles.navSidebarItem} onClick={() => { handleLogout(); setNavMobileOpen(false); }}>
          <span className={styles.navSidebarItemIcon}>🚪</span>
          {!navCollapsed && <span className={styles.navSidebarItemLabel}>Cerrar sesión</span>}
        </button>
        <button type="button" className={styles.navSidebarCollapse} onClick={() => setNavCollapsed((c) => !c)}>
          {navCollapsed ? "»" : "«"}
        </button>
      </aside>

      {/* ── Botón hamburger flotante (solo mobile/tablet ≤1024px) ── */}
      <button
        type="button"
        className={styles.fabHamburger}
        onClick={() => setNavMobileOpen(true)}
        aria-label="Abrir menú lateral"
      >
        ☰
      </button>

      {/* ── Toasts flotantes (arriba a la derecha) ── */}
      {(toolbarInfo || toolbarError) && (
        <div className={styles.toastContainer} role="status" aria-live="polite">
          {toolbarInfo && (
            <div className={`${styles.toastItem} ${styles.toastInfoItem}`}>{toolbarInfo}</div>
          )}
          {toolbarError && (
            <div className={`${styles.toastItem} ${styles.toastErrorItem}`}>{toolbarError}</div>
          )}
        </div>
      )}

      {/* ── Columna 3: Contenido principal ── */}
      <div className={styles.contentCol}>

        {/* Barra superior (título + período + acciones globales): solo en la vista
            general. Dentro de un consorcio no aporta — el detalle tiene su propio
            header (volver, período, cargar boleta, configuración). */}
        {!selectedId && (
          <header className={styles.header}>
            <div>
              <p className={styles.eyebrow}>Gestion de consorcios</p>
              <div className={styles.titleRow}>
                <h1>Edificios</h1>
                {currentPeriodLabel && (
                  <span className={styles.currentPeriodBadge}>Período actual: {currentPeriodLabel}</span>
                )}
              </div>
            </div>
            <div className={styles.headerActions}>
              <button type="button" className={styles.consortiumBtn} onClick={consortium.open}>
                + Nuevo consorcio
              </button>
              <button type="button" className={styles.providerBtn} onClick={provider.open}>
                + Nuevo proveedor
              </button>
              <button type="button" className={styles.ghostBtn} onClick={() => router.push("/admin")}>
                ← Volver al panel
              </button>
            </div>
          </header>
        )}

        <main className={styles.main}>
          {!selectedId && pendingRestore && (
            <div className={styles.restoreLoader}>
              <span className={styles.spinner} aria-hidden="true" />
              <p>Cargando consorcio...</p>
            </div>
          )}

          {!selectedId && !pendingRestore && (
            <>
              <div className={styles.gridToolbar}>
                <div className={styles.searchRow}>
                  <input
                    type="text"
                    className={styles.searchInput}
                    placeholder={selectedBankId ? "Buscar consorcio..." : "Buscar banco o consorcio..."}
                    value={consortiumSearch}
                    onChange={(e) => setConsortiumSearch(e.target.value)}
                  />
                  {consortiumSearch && (
                    <button type="button" className={styles.clearSearch} onClick={() => setConsortiumSearch("")} aria-label="Limpiar búsqueda">✕</button>
                  )}
                </div>
                <span className={styles.gridCount}>
                  {loadingList ? "..." : `${consortiums.length} consorcio${consortiums.length === 1 ? "" : "s"}`}
                </span>
              </div>

              {loadingList && <div className={styles.gridInfo}>Cargando consorcios...</div>}
              {listError && <div className={styles.sidebarError}>{listError}</div>}

              {/* Nivel 0: grilla de bancos con los edificios como badges. */}
              {!loadingList && !listError && !selectedBankId && (() => {
                if (consortiums.length === 0 && banks.banks.length === 0) {
                  return <div className={styles.gridInfo}>No hay consorcios cargados.</div>;
                }
                const groups = groupByBank(banks.banks, consortiums, consortiumSearch);
                if (groups.length === 0) {
                  return <div className={styles.gridInfo}>Nada coincide con &quot;{consortiumSearch}&quot;.</div>;
                }
                return (
                  <BankGrid
                    groups={groups}
                    onSelectBank={(bankId) => { setSelectedBankId(bankId); setConsortiumSearch(""); }}
                    onSelectConsortium={(c) => void selectConsortium(c)}
                  />
                );
              })()}

              {/* Nivel 1: la grilla de edificios de siempre, filtrada por banco. */}
              {!loadingList && !listError && selectedBankId && (() => {
                const bankName = selectedBankId === UNASSIGNED_BANK_ID
                  ? "Sin banco"
                  : banks.banks.find((b) => b.id === selectedBankId)?.name ?? "Banco";
                const ofBank = consortiums.filter((c) =>
                  selectedBankId === UNASSIGNED_BANK_ID ? !c.bankId : c.bankId === selectedBankId
                );
                const q = normName(consortiumSearch);
                const filtered = q
                  ? ofBank.filter((c) => normName(c.rawName).includes(q) || normName(c.canonicalName).includes(q))
                  : ofBank;

                if (filtered.length === 0) {
                  return (
                    <>
                      <div className={styles.bankBreadcrumb}>
                        <button type="button" className={styles.backToGrid} onClick={() => { setSelectedBankId(null); setConsortiumSearch(""); }}>
                          ← Todos los bancos
                        </button>
                        <span className={styles.cardName}>{bankName}</span>
                      </div>
                      <div className={styles.gridInfo}>
                        {ofBank.length === 0
                          ? "Este banco no tiene edificios asignados."
                          : `Ningún consorcio coincide con "${consortiumSearch}".`}
                      </div>
                    </>
                  );
                }

                return (
                  <>
                  <div className={styles.bankBreadcrumb}>
                    <button type="button" className={styles.backToGrid} onClick={() => { setSelectedBankId(null); setConsortiumSearch(""); }}>
                      ← Todos los bancos
                    </button>
                    <span className={styles.cardName}>{bankName}</span>
                  </div>
                  <div className={styles.cardGrid}>
                    {filtered.map((c) => {
                      const hasPeriodDebt = c.activePeriodDebt > 0;
                      const hasTotalDebt = c.totalDebt > 0;
                      return (
                        <button key={c.id} type="button" className={styles.consortiumCard} onClick={() => void selectConsortium(c)}>
                          <div className={styles.cardTop}>
                            <span className={styles.cardIcon}>🏢</span>
                            <span className={styles.cardName}>{c.rawName}</span>
                          </div>
                          <div className={styles.cardStats}>
                            <div className={styles.cardStat}>
                              <span className={styles.cardStatLabel}>Boletas</span>
                              <span className={styles.cardStatValue}>{c.activePeriodInvoiceCount}</span>
                            </div>
                            <div className={styles.cardStat}>
                              <span className={styles.cardStatLabel}>Deuda mes</span>
                              <span className={`${styles.cardStatValue} ${hasPeriodDebt ? styles.cardDebt : styles.cardNoDebt}`}>
                                {formatAmount(c.activePeriodDebt)}
                              </span>
                            </div>
                          </div>
                          <div className={styles.cardTotalDebt}>
                            <span className={styles.cardStatLabel}>Deuda total</span>
                            <span className={`${styles.cardTotalValue} ${hasTotalDebt ? styles.cardDebt : styles.cardNoDebt}`}>
                              {formatAmount(c.totalDebt)}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  </>
                );
              })()}
            </>
          )}

          {selectedId && selectedConsortium && (
            <>
              <button
                type="button"
                className={styles.backToGrid}
                onClick={back}
              >
                ← Volver a Consorcios
              </button>
              <div className={styles.detailHeader}>
                <div>
                  <div className={styles.detailTitleRow}>
                    <h2 className={styles.detailTitle}>{selectedConsortium.rawName}</h2>
                    {/* Navegador de período inline al lado del nombre */}
                    <div className={styles.periodNav}>
                      <button type="button" className={styles.periodNavBtn} onClick={goPrevPeriod} disabled={!canGoPrev} aria-label="Período anterior">‹</button>
                      <span className={styles.periodNavLabel}>
                        {selectedPeriod ? formatPeriod(selectedPeriod) : "Sin período"}
                        {selectedPeriod?.status === "CLOSED" && <span className={styles.closedTag}>Cerrado</span>}
                      </span>
                      <button type="button" className={styles.periodNavBtn} onClick={goNextPeriod} disabled={!canGoNext} aria-label="Período siguiente">›</button>
                    </div>
                  </div>
                  {selectedConsortium.cuit && <p className={styles.detailMeta}>CUIT: {selectedConsortium.cuit}</p>}
                  <p className={styles.detailMeta}>
                    Rendición:{" "}
                    {selectedConsortium.statementsFolderUrl ? (
                      <>
                        <a
                          href={selectedConsortium.statementsFolderUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "inherit", textDecoration: "underline" }}
                        >
                          Carpeta pública
                        </a>{" "}
                        <button
                          type="button"
                          onClick={() => {
                            const url = selectedConsortium.statementsFolderUrl;
                            if (!url) return;
                            navigator.clipboard?.writeText(url);
                            setCopiedStatementsId(selectedConsortium.id);
                            setTimeout(() => setCopiedStatementsId(null), 1500);
                          }}
                          style={{ marginLeft: 6, padding: "2px 8px", fontSize: "0.75rem", cursor: "pointer", borderRadius: 4, border: "1px solid currentColor", background: "transparent", color: "inherit" }}
                        >
                          {copiedStatementsId === selectedConsortium.id ? "✓ Copiado" : "Copiar link"}
                        </button>
                      </>
                    ) : (
                      <span style={{ opacity: 0.7 }}>Pendiente (se genera al procesar la primera boleta)</span>
                    )}
                  </p>
                </div>
                <div className={styles.detailActions}>
                  {selectedPeriod?.status === "ACTIVE" && (
                    <button type="button" className={styles.closePeriodBtn} onClick={closePeriod.open}>Cerrar período</button>
                  )}
                  <button type="button" className={styles.addInvoiceBtn} onClick={invoiceModal.open}>
                    + Cargar boleta
                  </button>
                  <button type="button" className={styles.configBtn} onClick={() => config.open(selectedConsortium)}>
                    Configuración
                  </button>
                </div>
              </div>

              {closePeriod.success && <p className={styles.infoMsg}>{closePeriod.success}</p>}
              {closePeriod.error && <p className={styles.errorMsg}>{closePeriod.error}</p>}
              {invoicesError && <p className={styles.errorMsg}>{invoicesError}</p>}

              <div className={styles.tabBar}>
                <button
                  type="button"
                  className={activeTab === "obligaciones" ? styles.tabActive : styles.tab}
                  onClick={() => setActiveTab("obligaciones")}
                >
                  Obligaciones
                  {obligations.filter((o) => o.status === "PENDING").length > 0 && (
                    <span className={styles.statWarn} style={{ marginLeft: 6, fontWeight: 700 }}>
                      {obligations.filter((o) => o.status === "PENDING").length}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className={activeTab === "boletas" ? styles.tabActive : styles.tab}
                  onClick={() => setActiveTab("boletas")}
                >
                  Boletas
                </button>
                <button
                  type="button"
                  className={activeTab === "pagos" ? styles.tabActive : styles.tab}
                  onClick={() => setActiveTab("pagos")}
                >
                  Pagos
                </button>
              </div>

              {activeTab === "boletas" && (
              <>
              <div className={styles.statsStrip}>
                <div className={styles.statCard}><span className={styles.statLabel}>Boletas</span><span className={styles.statValue}>{invoices.length}</span></div>
                <div className={styles.statCard}><span className={styles.statLabel}>Total período</span><span className={styles.statValue}>{formatAmount(totalAmount)}</span></div>
              </div>

              <div className={styles.searchRow}>
                <input type="text" className={styles.searchInput} placeholder="Buscar por proveedor, N° boleta o CUIT..." value={search} onChange={(e) => setSearch(e.target.value)} />
                {search && <button type="button" className={styles.clearSearch} onClick={() => setSearch("")}>✕</button>}
              </div>

              {loadingInvoices ? (
                <div className={styles.emptyState}><p>Cargando boletas...</p></div>
              ) : (
                <div className={styles.tableWrap}>
                  {filteredInvoices.length === 0 ? (
                    <div className={styles.tableEmpty}>{search ? "No hay boletas que coincidan con la búsqueda." : "No hay boletas para este período."}</div>
                  ) : (
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>N° Boleta</th><th>Proveedor</th><th>CUIT</th><th>Comprobante</th>
                          <th>Detalle</th><th>Emisión</th><th>Vencimiento</th><th>Monto</th>
                          <th>Tipo</th><th>Rubro</th><th>Coef.</th><th>Origen</th>
                          <th>Archivo</th><th>Pago</th><th>Acciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredInvoices.map((inv) => (
                          <tr key={inv.id} className={inv.isDuplicate ? styles.rowDuplicate : ""}>
                            <td className={styles.tdMono}>{inv.boletaNumber ?? "—"}</td>
                            <td>{inv.provider ?? "—"}{inv.lspServiceId && <span className={styles.badgeLsp}>LSP</span>}</td>
                            <td className={styles.tdMono}>{inv.providerTaxId ?? "—"}</td>
                            <td className={styles.tdMono}>{inv.tipoComprobante ?? "—"}</td>
                            <td className={styles.tdDetail}>{inv.detail ?? inv.observation ?? "—"}</td>
                            <td>{formatDate(inv.issueDate)}</td>
                            <td>{formatDate(inv.dueDate)}</td>
                            <td className={styles.tdAmount}>{formatAmount(inv.amount)}</td>
                            <td>
                              <span className={
                                inv.tipoGasto === "EXTRAORDINARIO" ? styles.badgeDuplicate
                                : inv.tipoGasto === "PARTICULAR" ? styles.badgeManual
                                : styles.badgeOk
                              }>
                                {inv.tipoGasto === "ORDINARIO" ? "Ord." : inv.tipoGasto === "EXTRAORDINARIO" ? "Ext." : "Part."}
                              </span>
                            </td>
                            <td>{(inv as any).rubroRef?.name ?? "—"}</td>
                            <td className={styles.tdMono}>{(inv as any).coeficienteRef?.name ?? "—"}</td>
                            <td>
                              {inv.isManual
                                ? <span className={styles.badgeManual}>Manual</span>
                                : <span className={styles.badgeOk}>Automática</span>}
                            </td>
                            <td>
                              {inv.sourceFileUrl
                                ? <a href={inv.sourceFileUrl} target="_blank" rel="noopener noreferrer" className={styles.fileLink}>Ver PDF</a>
                                : "—"}
                            </td>
                            {/* ── Columna pago (solo estado visual; las acciones viven en la pestaña Pagos) ── */}
                            <td>
                              {inv.isPaid ? (
                                <span className={styles.badgeOk}>Pagada</span>
                              ) : inv.remainingBalance !== null && Number(inv.remainingBalance) < Number(inv.amount ?? 0) ? (
                                <span className={styles.badgeWarning}>
                                  Resta ${Number(inv.remainingBalance).toLocaleString("es-AR", { minimumFractionDigits: 2 })}
                                </span>
                              ) : (
                                <span style={{ color: "var(--text-muted, #888)" }}>—</span>
                              )}
                            </td>
                            {/* ── Acciones: eliminar boleta (confirm inline) ── */}
                            <td>
                              {confirmDeleteInvoiceId === inv.id ? (
                                <span className={styles.lspConfirmDelete}>
                                  ¿Borrar?{" "}
                                  <AsyncButton type="button" className={styles.lspConfirmYes} onClick={() => handleDeleteInvoice(inv.id)} pendingLabel="…">Sí</AsyncButton>
                                  <button type="button" className={styles.lspConfirmNo} onClick={() => setConfirmDeleteInvoiceId(null)}>No</button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className={styles.lspDeleteBtn}
                                  onClick={() => setConfirmDeleteInvoiceId(inv.id)}
                                  title="Eliminar boleta (mueve PDF a 'pending' y borra fila de Sheets)"
                                  aria-label="Eliminar boleta"
                                >
                                  🗑
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
              </>
              )}

              {activeTab === "pagos" && (
                <PagosView
                  invoices={invoices}
                  onPagoGuardado={() => {
                    if (selectedId && selectedPeriod) void reloadInvoices();
                  }}
                  onPagar={payModal.open}
                  onVerPagos={viewPayments.open}
                  onEliminarUltimoPago={async (invoiceId) => {
                    // Busca el último pago de la invoice y lo elimina. El endpoint
                    // valida que sea el más reciente (restricción del repository).
                    try {
                      const res = await guardedFetch(`/api/client/invoices/${invoiceId}/payments`, { cache: "no-store" });
                      const data = await res.json();
                      if (!data.ok || !Array.isArray(data.payments) || data.payments.length === 0) {
                        throw new Error("La boleta no tiene pagos para eliminar");
                      }
                      // Más reciente primero (paymentDate desc o createdAt desc; tomamos el primero)
                      const sorted = [...data.payments].sort((a: { createdAt?: string }, b: { createdAt?: string }) =>
                        (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
                      );
                      const last = sorted[0];
                      const delRes = await guardedFetch(`/api/client/invoices/${invoiceId}/payments/${last.id}`, { method: "DELETE" });
                      const delData = await delRes.json();
                      if (!delRes.ok || !delData.ok) throw new Error(delData.error ?? `HTTP ${delRes.status}`);
                      setToolbarInfo("Pago eliminado.");
                      if (selectedId && selectedPeriod) void reloadInvoices();
                    } catch (err) {
                      setToolbarError(err instanceof Error ? err.message : "Error al eliminar pago");
                    }
                  }}
                />
              )}

              {activeTab === "obligaciones" && (
                <div className={styles.tableWrap}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0" }}>
                    <span>
                      {obligations.filter((o) => o.status === "PENDING").length > 0
                        ? `Faltan ${obligations.filter((o) => o.status === "PENDING").length} boleta(s) de gastos fijos`
                        : "Sin faltantes"}
                    </span>
                    {obligations.length === 0 && (
                      <AsyncButton type="button" className={styles.addInvoiceBtn} onClick={() => { if (selectedPeriod) void generateObligations(selectedPeriod.id); }} pendingLabel="Sincronizando…">
                        Sincronizar gastos fijos
                      </AsyncButton>
                    )}
                  </div>
                  {obligations.length === 0 ? (
                    <div className={styles.tableEmpty}>No hay obligaciones generadas para este período.</div>
                  ) : (
                    <table className={styles.table}>
                      <thead>
                        <tr><th>GASTO FIJO</th><th>ESTADO</th><th>BOLETA / PAGO</th><th>ACCIONES</th></tr>
                      </thead>
                      <tbody>
                        {obligations.map((ob) => {
                          const label = ob.fixedExpense.lspService
                            ? `${ob.fixedExpense.lspService.providerName} (${ob.fixedExpense.lspService.clientNumber})`
                            : ob.fixedExpense.provider?.canonicalName ?? ob.fixedExpense.description ?? "—";
                          const badge =
                            ob.status === "RECEIVED" ? <span className={styles.badgeOk}>Recibida</span>
                            : ob.status === "PENDING" ? <span className={styles.badgeWarning}>Pendiente</span>
                            : ob.status === "NOT_RECEIVED" ? <span className={styles.badgeDuplicate}>No recibida</span>
                            // Llegó la boleta y no se pagó: se pasó al mes siguiente. La
                            // obligación queda acá como evidencia del atraso.
                            : ob.status === "CARRIED_OVER" ? <span className={styles.badgeDuplicate}>Impaga — pasada al mes siguiente</span>
                            : <span className={styles.badgeManual}>Omitida</span>;
                          return (
                            <tr key={ob.id}>
                              <td>{label}</td>
                              <td>{badge}</td>
                              <td>
                                {ob.invoice ? (
                                  <>
                                    {ob.invoice.isPaid ? "Pagada" : "Impaga"}{" · "}
                                    {ob.invoice.sourceFileUrl
                                      ? <a href={ob.invoice.sourceFileUrl} target="_blank" rel="noopener noreferrer" className={styles.fileLink}>Ver PDF</a>
                                      : "—"}
                                  </>
                                ) : "—"}
                              </td>
                              <td>
                                {ob.status === "PENDING" && (
                                  <AsyncButton type="button" className={styles.ghostBtn} style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => { if (selectedPeriod) void setObligationStatus(ob.id, "SKIPPED", selectedPeriod.id); }}>Omitir</AsyncButton>
                                )}
                                {ob.status === "SKIPPED" && (
                                  <AsyncButton type="button" className={styles.ghostBtn} style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => { if (selectedPeriod) void setObligationStatus(ob.id, "PENDING", selectedPeriod.id); }}>Reactivar</AsyncButton>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>{/* close contentCol */}

      {/* ── Config modal ── */}
      {config.isOpen && selectedConsortium && (
        <ConfigModal
          consortiumName={selectedConsortium.rawName}
          saving={config.matchNames.saving}
          openSection={config.openSection}
          onToggleSection={config.toggleSection}
          onClose={config.close}
          banks={banks.banks}
          bank={{
            form: config.bank.form,
            msg: config.bank.msg,
            onChangeForm: config.bank.setForm,
            onSave: config.bank.save,
          }}
          matchNames={{
            editing: config.matchNames.editing,
            value: config.matchNames.value,
            msg: config.matchNames.msg,
            onChangeValue: config.matchNames.setValue,
            onStartEdit: config.matchNames.startEdit,
            onCancelEdit: config.matchNames.cancelEdit,
            onSave: config.matchNames.save,
          }}
          lsp={{
            services: config.lsp.services,
            form: config.lsp.form,
            error: config.lsp.error,
            confirmDeleteId: config.lsp.confirmDeleteId,
            onChangeForm: config.lsp.setForm,
            onConfirmDelete: config.lsp.setConfirmDeleteId,
            onAdd: config.lsp.add,
            onDelete: config.lsp.remove,
          }}
          fixed={{ list: config.fixed.list }}
        />
      )}

      {/* ── ABM del catálogo de bancos ──
          Al cerrar se recargan los consorcios: borrar un banco desasigna edificios
          y eso cambia los grupos del nivel 0. */}
      {banks.isOpen && (
        <BanksModal
          banks={banks.banks}
          form={banks.form}
          error={banks.error}
          confirmDeleteId={banks.confirmDeleteId}
          editingId={banks.editingId}
          onChangeForm={banks.setForm}
          onCreate={banks.create}
          onUpdate={banks.update}
          onDelete={banks.remove}
          onConfirmDelete={banks.setConfirmDeleteId}
          onEdit={banks.setEditingId}
          onClose={() => { banks.close(); void fetchConsortiums(); }}
        />
      )}

      {/* ── Corrida selectiva: elegir boletas de Pendientes y encolarlas ──
          Se ENCOLAN (las procesa el worker, que no mira el flag del scheduler) y
          al terminar queda el reporte de diagnóstico en Drive. */}
      {manualRunOpen && (
        <ManualRunModal
          files={manualRun.files}
          selected={manualRun.selected}
          loading={manualRun.loading}
          error={manualRun.error}
          max={manualRun.max}
          runId={manualRun.runId}
          progress={manualRun.progress}
          done={manualRun.done}
          report={manualRun.report}
          onToggle={manualRun.toggle}
          onEnqueue={manualRun.enqueue}
          onReset={manualRun.reset}
          onClose={() => { setManualRunOpen(false); manualRun.reset(); }}
        />
      )}

      {/* ── Consortium mismatch modal — z-index 200 ── */}
      {invoiceModal.mismatchConsortium && (
        <MismatchModal consortiumName={invoiceModal.mismatchConsortium} onDismiss={invoiceModal.dismissMismatch} />
      )}

      {/* ── Close period modal ── */}
      {closePeriod.isOpen && (
        <ClosePeriodModal
          periodLabel={formatPeriod(selectedPeriod)}
          consortiumName={selectedConsortium?.rawName ?? ""}
          error={closePeriod.error}
          saving={closePeriod.saving}
          onClose={closePeriod.close}
          onSubmit={closePeriod.submit}
        />
      )}

      {invoiceModal.isOpen && (
        <InvoiceModal
          consortiumName={selectedConsortium?.rawName ?? ""}
          periodLabel={formatPeriod(selectedPeriod)}
          scanning={invoiceModal.scanning}
          scanFile={invoiceModal.scanFile}
          scanWarning={invoiceModal.scanWarning}
          matchedProvider={invoiceModal.matchedProvider}
          form={invoiceModal.form}
          setField={invoiceModal.setField}
          providers={providers}
          coeficientes={coeficientes}
          rubros={rubros}
          error={invoiceModal.error}
          saving={invoiceModal.saving}
          fileInputRef={invoiceModal.fileInputRef}
          onFileChange={invoiceModal.onFileChange}
          onClose={invoiceModal.close}
          onSubmit={invoiceModal.submit}
        />
      )}

      {/* ── Provider modal ── */}
      {provider.isOpen && (
        <ProviderFormModal
          form={provider.form}
          onChange={provider.setField}
          onClose={provider.close}
          onSubmit={provider.submit}
          saving={provider.saving}
          error={provider.error}
          success={provider.success}
        />
      )}

      {/* ── Consortium modal ── */}
      {consortium.isOpen && (
        <ConsortiumFormModal
          form={consortium.form}
          onChange={consortium.setField}
          onClose={consortium.close}
          onSubmit={consortium.submit}
          saving={consortium.saving}
          error={consortium.error}
          success={consortium.success}
        />
      )}

      {syncReport && (
        <DirectorySyncModal
          report={syncReport}
          onClose={closeSyncReport}
          onApplyRenames={applyRenames}
        />
      )}

      {closeAll.isOpen && (
        <CloseAllModal
          step={closeAll.step}
          preview={closeAll.preview}
          loading={closeAll.loading}
          result={closeAll.result}
          error={closeAll.error}
          onClose={closeAll.close}
          onExecute={closeAll.execute}
        />
      )}

      {unassigned.isOpen && (
        <UnassignedModal
          step={unassigned.step}
          files={unassigned.files}
          folderConfigured={unassigned.folderConfigured}
          result={unassigned.result}
          loading={unassigned.loading}
          onClose={unassigned.close}
          onRequeue={unassigned.requeue}
        />
      )}

      {payModal.invoice && (
        <PayModal
          invoice={payModal.invoice}
          loadingExisting={payModal.loadingExisting}
          isFirstPayment={payModal.isFirstPayment}
          activeMode={payModal.activeMode}
          mode={payModal.mode}
          installmentsLocked={payModal.installmentsLocked}
          currentInstallmentNumber={payModal.currentInstallmentNumber}
          isLastInstallment={payModal.isLastInstallment}
          existingPaymentsCount={payModal.existingPayments.length}
          computedAmount={payModal.computedAmount}
          form={payModal.form}
          onFieldChange={payModal.setField}
          onModeChange={payModal.setMode}
          file={payModal.file}
          onFileChange={payModal.setFile}
          error={payModal.error}
          saving={payModal.saving}
          onClose={payModal.close}
          onSubmit={payModal.submit}
        />
      )}

      {viewPayments.invoice && (
        <ViewPaymentsModal
          invoice={viewPayments.invoice}
          list={viewPayments.list}
          loading={viewPayments.loading}
          onClose={viewPayments.close}
        />
      )}
    </div>
  );
}
