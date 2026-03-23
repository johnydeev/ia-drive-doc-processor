"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { useAuthGuard } from "@/lib/useAuthGuard";

const TIPOS_COMPROBANTE = [
  "A", "B", "C", "E", "M", "X",
  "Ticket", "Recibo", "Liq. Serv. Público", "Otro",
] as const;

const TIPOS_GASTO = [
  { value: "ORDINARIO",      label: "Ordinario" },
  { value: "EXTRAORDINARIO", label: "Extraordinario" },
  { value: "PARTICULAR",     label: "Particular" },
] as const;

type Period      = { id: string; year: number; month: number; status: "ACTIVE" | "CLOSED"; };
type Coeficiente = { id: string; name: string; value: number; };
type Rubro       = { id: string; name: string; };
type Consortium  = { id: string; canonicalName: string; rawName: string; cuit: string | null; cutoffDay: number; periods: Period[]; _count: { invoices: number }; };
type Provider    = { id: string; canonicalName: string; cuit: string | null; paymentAlias: string | null; };
type Invoice     = {
  id: string; boletaNumber: string | null; provider: string | null; providerTaxId: string | null;
  detail: string | null; observation: string | null; issueDate: string | null; dueDate: string | null;
  amount: number | null; isDuplicate: boolean; isManual: boolean; sourceFileUrl: string | null;
  tipoGasto: string; tipoComprobante: string | null; createdAt: string;
  coeficienteRef: { id: string; name: string; value: number } | null;
  rubroRef: { id: string; name: string } | null;
  receiptDriveFileId: string | null;
  receiptDriveFileUrl: string | null;
};
type ScannedData = {
  boletaNumber: string | null; provider: string | null; providerTaxId: string | null;
  detail: string | null; observation: string | null; issueDate: string | null;
  dueDate: string | null; amount: number | null; tipoComprobante: string | null;
};

const MONTH_NAMES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

function formatPeriod(p: Period | null | undefined) {
  if (!p) return "Sin período activo";
  return `${MONTH_NAMES[p.month - 1]} ${p.year}`;
}
function formatAmount(v: number | null | undefined) {
  if (v == null) return "—";
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(v);
}
function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-AR");
}
function toInputDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}
function todayInputDate(): string {
  return new Date().toISOString().slice(0, 10);
}
function normCuit(v: string | null | undefined): string { return (v ?? "").replace(/\D/g, ""); }
function normName(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/[.,\-_]/g, " ").replace(/\s+/g, " ").trim();
}
function matchProvider(providers: Provider[], extracted: ScannedData): Provider | undefined {
  if (extracted.providerTaxId) {
    const norm = normCuit(extracted.providerTaxId);
    if (norm.length >= 10) {
      const hit = providers.find((p) => normCuit(p.cuit) === norm);
      if (hit) return hit;
    }
  }
  if (extracted.provider) {
    const norm = normName(extracted.provider);
    if (norm.length >= 3) {
      const hit = providers.find((p) => normName(p.canonicalName) === norm || (p.paymentAlias && normName(p.paymentAlias) === norm));
      if (hit) return hit;
    }
  }
  return undefined;
}

type InvoiceForm = {
  providerId: string; boletaNumber: string; providerTaxId: string;
  detail: string; observation: string; issueDate: string; dueDate: string;
  amount: string; coeficienteId: string; newCoefName: string; newCoefValue: string;
  rubroId: string; newRubroName: string;
  tipoGasto: string; tipoComprobante: string;
};

const EMPTY_INVOICE_FORM: InvoiceForm = {
  providerId: "", boletaNumber: "", providerTaxId: "", detail: "", observation: "",
  issueDate: todayInputDate(), dueDate: "", amount: "",
  coeficienteId: "", newCoefName: "", newCoefValue: "",
  rubroId: "", newRubroName: "",
  tipoGasto: "ORDINARIO", tipoComprobante: "",
};

export default function ConsortiumsPage() {
  const router = useRouter();
  const { guardedFetch } = useAuthGuard();

  const [consortiums, setConsortiums] = useState<Consortium[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConsortium, setSelectedConsortium] = useState<Consortium | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<Period | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [coeficientes, setCoeficientes] = useState<Coeficiente[]>([]);
  const [rubros, setRubros] = useState<Rubro[]>([]);

  // Receipt upload state — un input ref oculto por invoice
  const receiptInputRef = useRef<HTMLInputElement>(null);
  const [uploadingReceiptId, setUploadingReceiptId] = useState<string | null>(null);

  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closingPeriod, setClosingPeriod] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closeSuccess, setCloseSuccess] = useState<string | null>(null);

  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanWarning, setScanWarning] = useState<string | null>(null);
  const [matchedProvider, setMatchedProvider] = useState<Provider | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [invoiceForm, setInvoiceForm] = useState<InvoiceForm>(EMPTY_INVOICE_FORM);
  const [savingInvoice, setSavingInvoice] = useState(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);

  const [showMismatchModal, setShowMismatchModal] = useState(false);
  const [mismatchFoundConsortium, setMismatchFoundConsortium] = useState<string | null>(null);

  const [showProviderModal, setShowProviderModal] = useState(false);
  const [providerForm, setProviderForm] = useState({ canonicalName: "", cuit: "", paymentAlias: "" });
  const [savingProvider, setSavingProvider] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerSuccess, setProviderSuccess] = useState<string | null>(null);

  const [showConsortiumModal, setShowConsortiumModal] = useState(false);
  const [consortiumForm, setConsortiumForm] = useState({ canonicalName: "", cuit: "" });
  const [savingConsortium, setSavingConsortium] = useState(false);
  const [consortiumError, setConsortiumError] = useState<string | null>(null);
  const [consortiumSuccess, setConsortiumSuccess] = useState<string | null>(null);

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

  const fetchProviders = useCallback(async () => {
    try {
      const res = await guardedFetch("/api/client/providers", { cache: "no-store" });
      const data = await res.json();
      if (data.ok) setProviders(data.providers ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  useEffect(() => { void fetchProviders(); }, [fetchProviders]);

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

  const handleSelectConsortium = useCallback(async (c: Consortium) => {
    setSelectedId(c.id); setSelectedConsortium(c);
    setInvoices([]); setSearch(""); setCloseSuccess(null); setCloseError(null);
    void fetchCoeficientes(c.id);
    void fetchRubros(c.id);
    const periodId = await fetchPeriodsAndInvoices(c.id);
    if (periodId) void fetchInvoices(c.id, periodId);
  }, [fetchPeriodsAndInvoices, fetchInvoices, fetchCoeficientes, fetchRubros]);

  const handleSelectPeriod = useCallback((p: Period) => {
    setSelectedPeriod(p);
    if (selectedId) void fetchInvoices(selectedId, p.id);
  }, [selectedId, fetchInvoices]);

  const periodIndex = periods.findIndex((p) => p.id === selectedPeriod?.id);
  const canGoPrev = periodIndex < periods.length - 1;
  const canGoNext = periodIndex > 0;
  const goPrevPeriod = () => { if (canGoPrev) handleSelectPeriod(periods[periodIndex + 1]); };
  const goNextPeriod = () => { if (canGoNext) handleSelectPeriod(periods[periodIndex - 1]); };

  const handleClosePeriod = async () => {
    if (!selectedId || !selectedPeriod) return;
    setClosingPeriod(true); setCloseError(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${selectedId}/close-period`, { method: "POST", headers: { "content-type": "application/json" } });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCloseSuccess("Período cerrado. Se creó el siguiente período activo.");
      setShowCloseModal(false);
      void fetchConsortiums();
      const periodId = await fetchPeriodsAndInvoices(selectedId);
      if (periodId) void fetchInvoices(selectedId, periodId);
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "Error al cerrar el período");
    } finally { setClosingPeriod(false); }
  };

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
          ? { ...inv, receiptDriveFileId: data.invoice.receiptDriveFileId, receiptDriveFileUrl: data.invoice.receiptDriveFileUrl }
          : inv
      ));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error al subir el recibo");
    } finally {
      setUploadingReceiptId(null);
      if (receiptInputRef.current) receiptInputRef.current.value = "";
    }
  };

  const handleScanPdf = async (file: File) => {
    if (!selectedId) return;
    setScanning(true); setScanWarning(null); setMatchedProvider(null);
    try {
      const fd = new FormData();
      fd.append("pdf", file);
      const res = await guardedFetch(`/api/client/consortiums/${selectedId}/invoices/scan`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      if (data.consortiumMismatch && data.foundConsortium) {
        setMismatchFoundConsortium(data.foundConsortium as string);
        setShowMismatchModal(true);
        return;
      }

      if (data.warning) setScanWarning(data.warning);
      if (data.extracted) {
        const e: ScannedData = data.extracted;
        const hit = matchProvider(providers, e);
        setMatchedProvider(hit ?? null);
        setInvoiceForm((f) => ({
          ...f,
          boletaNumber:    e.boletaNumber    ?? f.boletaNumber,
          providerTaxId:   hit?.cuit         ?? e.providerTaxId ?? f.providerTaxId,
          detail:          e.detail          ?? f.detail,
          observation:     e.observation     ?? f.observation,
          issueDate:       toInputDate(e.issueDate) || f.issueDate,
          dueDate:         toInputDate(e.dueDate)   || f.dueDate,
          amount:          e.amount != null  ? String(e.amount) : f.amount,
          tipoComprobante: e.tipoComprobante ?? f.tipoComprobante,
          ...(hit ? { providerId: hit.id } : {}),
        }));
      }
    } catch (err) {
      setScanWarning(err instanceof Error ? err.message : "Error al escanear el PDF");
    } finally { setScanning(false); }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanFile(file);
    void handleScanPdf(file);
  };

  const handleSaveInvoice = async () => {
    if (!selectedId || !selectedPeriod) return;
    if (!invoiceForm.providerId) { setInvoiceError("Seleccioná un proveedor"); return; }
    setSavingInvoice(true); setInvoiceError(null);
    try {
      let coefId = invoiceForm.coeficienteId === "__new__" ? "" : invoiceForm.coeficienteId;
      if (invoiceForm.coeficienteId === "__new__" && invoiceForm.newCoefName && invoiceForm.newCoefValue) {
        const coefRes = await guardedFetch(`/api/client/consortiums/${selectedId}/coeficientes`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: invoiceForm.newCoefName, value: parseFloat(invoiceForm.newCoefValue) }),
        });
        const coefData = await coefRes.json();
        if (!coefRes.ok || !coefData.ok) throw new Error(coefData.error ?? "Error al crear coeficiente");
        coefId = coefData.coeficiente.id;
        setCoeficientes((prev) => [...prev, coefData.coeficiente]);
      }

      let rubroId = invoiceForm.rubroId === "__new__" ? "" : invoiceForm.rubroId;
      if (invoiceForm.rubroId === "__new__" && invoiceForm.newRubroName) {
        const rubroRes = await guardedFetch(`/api/client/consortiums/${selectedId}/rubros`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: invoiceForm.newRubroName }),
        });
        const rubroData = await rubroRes.json();
        if (!rubroRes.ok || !rubroData.ok) throw new Error(rubroData.error ?? "Error al crear rubro");
        rubroId = rubroData.rubro.id;
        setRubros((prev) => [...prev, rubroData.rubro]);
      }

      const res = await guardedFetch(`/api/client/consortiums/${selectedId}/invoices`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId:      invoiceForm.providerId,
          periodId:        selectedPeriod.id,
          boletaNumber:    invoiceForm.boletaNumber    || undefined,
          providerTaxId:   invoiceForm.providerTaxId   || undefined,
          detail:          invoiceForm.detail          || undefined,
          observation:     invoiceForm.observation     || undefined,
          issueDate:       invoiceForm.issueDate       || undefined,
          dueDate:         invoiceForm.dueDate         || undefined,
          amount:          invoiceForm.amount ? parseFloat(invoiceForm.amount) : undefined,
          coeficienteId:   coefId   || undefined,
          rubroId:         rubroId  || undefined,
          tipoGasto:       invoiceForm.tipoGasto,
          tipoComprobante: invoiceForm.tipoComprobante || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInvoices((prev) => [data.invoice, ...prev]);
      setShowInvoiceModal(false);
      resetInvoiceForm();
    } catch (err) {
      setInvoiceError(err instanceof Error ? err.message : "Error al guardar la boleta");
    } finally { setSavingInvoice(false); }
  };

  const resetInvoiceForm = () => {
    setScanFile(null); setScanWarning(null); setInvoiceError(null); setMatchedProvider(null);
    setInvoiceForm({ ...EMPTY_INVOICE_FORM, issueDate: todayInputDate() });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSaveProvider = async () => {
    if (!providerForm.canonicalName || !providerForm.cuit) { setProviderError("Razón social y CUIT son obligatorios"); return; }
    setSavingProvider(true); setProviderError(null); setProviderSuccess(null);
    try {
      const res = await guardedFetch("/api/client/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(providerForm) });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setProviders((prev) => [...prev, data.provider]);
      const requeuedMsg = data.requeued > 0 ? ` Se reencolarán ${data.requeued} boleta(s) para revalidación.` : "";
      setProviderSuccess(`Proveedor creado correctamente.${requeuedMsg}`);
      setProviderForm({ canonicalName: "", cuit: "", paymentAlias: "" });
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : "Error al guardar el proveedor");
    } finally { setSavingProvider(false); }
  };

  const handleSaveConsortium = async () => {
    if (!consortiumForm.canonicalName.trim()) { setConsortiumError("El nombre del consorcio es obligatorio"); return; }
    setSavingConsortium(true); setConsortiumError(null); setConsortiumSuccess(null);
    try {
      const res = await guardedFetch("/api/client/consortiums", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ canonicalName: consortiumForm.canonicalName.trim(), cuit: consortiumForm.cuit.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setConsortiumSuccess("Consorcio creado correctamente.");
      setConsortiumForm({ canonicalName: "", cuit: "" });
      void fetchConsortiums();
    } catch (err) {
      setConsortiumError(err instanceof Error ? err.message : "Error al guardar el consorcio");
    } finally { setSavingConsortium(false); }
  };

  const filteredInvoices = invoices.filter((inv) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return inv.boletaNumber?.toLowerCase().includes(q) || inv.provider?.toLowerCase().includes(q) || inv.detail?.toLowerCase().includes(q) || inv.providerTaxId?.includes(q);
  });

  const totalAmount = filteredInvoices.reduce((s, i) => s + (i.amount ?? 0), 0);
  const duplicates = filteredInvoices.filter((i) => i.isDuplicate).length;

  return (
    <div className={styles.page}>
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

      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Gestión de consorcios</p>
          <h1>Edificios</h1>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.consortiumBtn} onClick={() => { setShowConsortiumModal(true); setConsortiumError(null); setConsortiumSuccess(null); }}>
            + Nuevo consorcio
          </button>
          <button type="button" className={styles.providerBtn} onClick={() => { setShowProviderModal(true); setProviderError(null); setProviderSuccess(null); }}>
            + Nuevo proveedor
          </button>
          <button type="button" className={styles.ghostBtn} onClick={() => router.push("/admin")}>
            ← Volver al panel
          </button>
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <span className={styles.sidebarTitle}>Consorcios</span>
            <span className={styles.sidebarCount}>{loadingList ? "…" : consortiums.length}</span>
          </div>
          {loadingList && <div className={styles.sidebarLoading}>Cargando...</div>}
          {listError && <div className={styles.sidebarError}>{listError}</div>}
          <nav className={styles.sidebarNav}>
            {consortiums.map((c) => {
              const active = c.periods.find((p) => p.status === "ACTIVE");
              const isSelected = selectedId === c.id;
              return (
                <button key={c.id} type="button"
                  className={`${styles.sidebarItem} ${isSelected ? styles.sidebarItemActive : ""}`}
                  onClick={() => void handleSelectConsortium(c)}>
                  <span className={styles.sidebarItemIcon}>🏢</span>
                  <span className={styles.sidebarItemBody}>
                    <span className={styles.sidebarItemName}>{c.rawName}</span>
                    <span className={styles.sidebarItemMeta}>{active ? formatPeriod(active) : "Sin período"} · {c._count.invoices} boletas</span>
                  </span>
                  {isSelected && <span className={styles.sidebarItemArrow}>›</span>}
                </button>
              );
            })}
            {!loadingList && !listError && consortiums.length === 0 && (
              <p className={styles.sidebarEmpty}>No hay consorcios cargados.</p>
            )}
          </nav>
        </aside>

        <main className={styles.main}>
          {!selectedId && (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>🏢</span>
              <p>Seleccioná un consorcio para ver sus boletas.</p>
            </div>
          )}

          {selectedId && selectedConsortium && (
            <>
              <div className={styles.detailHeader}>
                <div>
                  <h2 className={styles.detailTitle}>{selectedConsortium.rawName}</h2>
                  {selectedConsortium.cuit && <p className={styles.detailMeta}>CUIT: {selectedConsortium.cuit}</p>}
                </div>
                <div className={styles.detailActions}>
                  {selectedPeriod?.status === "ACTIVE" && (
                    <button type="button" className={styles.closePeriodBtn} onClick={() => setShowCloseModal(true)}>Cerrar período</button>
                  )}
                  <button type="button" className={styles.addInvoiceBtn} onClick={() => { resetInvoiceForm(); setShowInvoiceModal(true); }}>
                    + Cargar boleta
                  </button>
                </div>
              </div>

              <div className={styles.periodNav}>
                <button type="button" className={styles.periodNavBtn} onClick={goPrevPeriod} disabled={!canGoPrev}>‹</button>
                <span className={styles.periodNavLabel}>
                  {selectedPeriod ? formatPeriod(selectedPeriod) : "Sin período"}
                  {selectedPeriod?.status === "CLOSED" && <span className={styles.closedTag}>Cerrado</span>}
                </span>
                <button type="button" className={styles.periodNavBtn} onClick={goNextPeriod} disabled={!canGoNext}>›</button>
              </div>

              {closeSuccess && <p className={styles.infoMsg}>{closeSuccess}</p>}
              {closeError && <p className={styles.errorMsg}>{closeError}</p>}
              {invoicesError && <p className={styles.errorMsg}>{invoicesError}</p>}

              <div className={styles.statsStrip}>
                <div className={styles.statCard}><span className={styles.statLabel}>Boletas</span><span className={styles.statValue}>{filteredInvoices.length}</span></div>
                <div className={styles.statCard}><span className={styles.statLabel}>Total período</span><span className={styles.statValue}>{formatAmount(totalAmount)}</span></div>
                <div className={styles.statCard}><span className={styles.statLabel}>Duplicados</span><span className={`${styles.statValue} ${duplicates > 0 ? styles.statWarn : ""}`}>{duplicates}</span></div>
                <div className={styles.statCard}><span className={styles.statLabel}>Rubros</span><span className={styles.statValue}>{rubros.length}</span></div>
              </div>

              <div className={styles.searchRow}>
                <input type="text" className={styles.searchInput} placeholder="Buscar por proveedor, N° boleta o detalle..." value={search} onChange={(e) => setSearch(e.target.value)} />
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
                          <th>Tipo</th><th>Rubro</th><th>Coef.</th><th>Estado</th>
                          <th>Archivo</th><th>Recibo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredInvoices.map((inv) => (
                          <tr key={inv.id} className={inv.isDuplicate ? styles.rowDuplicate : ""}>
                            <td className={styles.tdMono}>{inv.boletaNumber ?? "—"}</td>
                            <td>{inv.provider ?? "—"}</td>
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
                              {inv.isManual ? <span className={styles.badgeManual}>Manual</span>
                                : inv.isDuplicate ? <span className={styles.badgeDuplicate}>Duplicado</span>
                                : <span className={styles.badgeOk}>OK</span>}
                            </td>
                            <td>
                              {inv.sourceFileUrl
                                ? <a href={inv.sourceFileUrl} target="_blank" rel="noopener noreferrer" className={styles.fileLink}>Ver PDF</a>
                                : "—"}
                            </td>
                            {/* ── Columna recibo ── */}
                            <td>
                              {uploadingReceiptId === inv.id ? (
                                <span className={styles.receiptUploading}>Subiendo…</span>
                              ) : inv.receiptDriveFileUrl ? (
                                <a href={inv.receiptDriveFileUrl} target="_blank" rel="noopener noreferrer" className={styles.fileLink}>
                                  📄 Ver
                                </a>
                              ) : (
                                <button
                                  type="button"
                                  className={styles.receiptBtn}
                                  onClick={() => {
                                    if (receiptInputRef.current) {
                                      receiptInputRef.current.dataset.invoiceId = inv.id;
                                      receiptInputRef.current.click();
                                    }
                                  }}
                                  title="Adjuntar recibo de pago"
                                >
                                  + Recibo
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
        </main>
      </div>

      {/* ── Consortium mismatch modal — z-index 200 ── */}
      {showMismatchModal && (
        <div className={styles.modalOverlayTop}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>⚠️ Boleta de otro consorcio</h3>
            <p className={styles.modalBody}>
              Este gasto <strong>NO corresponde</strong> al consorcio seleccionado.<br /><br />
              Según la información extraída del PDF, la boleta pertenece a:<br />
              <strong style={{ fontSize: "16px", color: "#ffb347" }}>{mismatchFoundConsortium}</strong><br /><br />
              Verificá que estés cargando la boleta en el consorcio correcto antes de continuar.
            </p>
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn}
                onClick={() => {
                  setShowMismatchModal(false);
                  setMismatchFoundConsortium(null);
                  setScanFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}>
                Entendido — cancelar carga
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Close period modal ── */}
      {showCloseModal && (
        <div className={styles.modalOverlay} onClick={() => !closingPeriod && setShowCloseModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Cerrar período</h3>
            <p className={styles.modalBody}>
              Estás por cerrar el período <strong>{formatPeriod(selectedPeriod)}</strong> del consorcio{" "}
              <strong>{selectedConsortium?.rawName}</strong>.<br /><br />
              Se creará automáticamente el siguiente período activo. Esta acción no se puede deshacer.
            </p>
            {closeError && <p className={styles.errorMsg}>{closeError}</p>}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => setShowCloseModal(false)} disabled={closingPeriod}>Cancelar</button>
              <button type="button" className={styles.closePeriodConfirmBtn} onClick={handleClosePeriod} disabled={closingPeriod}>
                {closingPeriod ? "Cerrando..." : "Confirmar cierre"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Invoice modal ── */}
      {showInvoiceModal && (
        <div className={styles.modalOverlay} onClick={() => !savingInvoice && !scanning && setShowInvoiceModal(false)}>
          <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Cargar boleta</h3>
            <p className={styles.modalSubtitle}>{selectedConsortium?.rawName} · {formatPeriod(selectedPeriod)}</p>

            <div className={styles.scanSection}>
              <label className={styles.scanLabel}>
                {scanning ? "Escaneando PDF..." : scanFile ? `📄 ${scanFile.name}` : "Subir PDF para escanear (opcional)"}
                <input ref={fileInputRef} type="file" accept=".pdf" onChange={handleFileChange} style={{ display: "none" }} disabled={scanning} />
              </label>
              {scanning && <div className={styles.scanSpinner} />}
            </div>
            {matchedProvider && (
              <p className={styles.infoMsg}>
                ✓ Proveedor identificado: <strong>{matchedProvider.canonicalName}</strong>
                {matchedProvider.cuit ? ` — ${matchedProvider.cuit}` : ""}
              </p>
            )}
            {scanWarning && <p className={styles.warnMsg}>{scanWarning}</p>}

            <div className={styles.invoiceFormGrid}>
              <div className={styles.formField}>
                <label>Proveedor *</label>
                <select value={invoiceForm.providerId} onChange={(e) => setInvoiceForm((f) => ({ ...f, providerId: e.target.value }))} className={styles.formSelect}>
                  <option value="">Seleccioná un proveedor</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.canonicalName}{p.paymentAlias ? ` (${p.paymentAlias})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.formField}>
                <label>N° Comprobante</label>
                <input className={styles.formInput} value={invoiceForm.boletaNumber} onChange={(e) => setInvoiceForm((f) => ({ ...f, boletaNumber: e.target.value }))} placeholder="0001-00000123" />
              </div>

              <div className={styles.formField}>
                <label>
                  CUIT / CUIL emisor
                  {matchedProvider && <span className={styles.canonLabel}> ✓ verificado</span>}
                </label>
                <input
                  className={styles.formInput}
                  value={invoiceForm.providerTaxId}
                  onChange={(e) => setInvoiceForm((f) => ({ ...f, providerTaxId: e.target.value }))}
                  placeholder="20-12345678-9"
                  readOnly={!!matchedProvider}
                  style={matchedProvider ? { opacity: 0.7, cursor: "not-allowed" } : undefined}
                />
              </div>
              <div className={styles.formField}>
                <label>Tipo de comprobante</label>
                <select value={invoiceForm.tipoComprobante} onChange={(e) => setInvoiceForm((f) => ({ ...f, tipoComprobante: e.target.value }))} className={styles.formSelect}>
                  <option value="">Sin especificar</option>
                  {TIPOS_COMPROBANTE.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              <div className={styles.formField}>
                <label>Monto</label>
                <input type="number" className={styles.formInput} value={invoiceForm.amount} onChange={(e) => setInvoiceForm((f) => ({ ...f, amount: e.target.value }))} placeholder="0.00" min="0" step="0.01" />
              </div>
              <div className={styles.formField}>
                <label>Tipo de gasto</label>
                <select value={invoiceForm.tipoGasto} onChange={(e) => setInvoiceForm((f) => ({ ...f, tipoGasto: e.target.value }))} className={styles.formSelect}>
                  {TIPOS_GASTO.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>

              <div className={styles.formField}>
                <label>Fecha de emisión</label>
                <input type="date" className={styles.formInput} value={invoiceForm.issueDate} onChange={(e) => setInvoiceForm((f) => ({ ...f, issueDate: e.target.value }))} />
              </div>
              <div className={styles.formField}>
                <label>Fecha de vencimiento</label>
                <input type="date" className={styles.formInput} value={invoiceForm.dueDate} onChange={(e) => setInvoiceForm((f) => ({ ...f, dueDate: e.target.value }))} />
              </div>

              <div className={`${styles.formField} ${styles.formFieldFull}`}>
                <label>Detalle</label>
                <textarea
                  className={styles.formTextarea}
                  rows={3}
                  value={invoiceForm.detail}
                  onChange={(e) => setInvoiceForm((f) => ({ ...f, detail: e.target.value }))}
                  placeholder="Descripción del servicio"
                />
              </div>

              <div className={styles.formField}>
                <label>Rubro</label>
                <select value={invoiceForm.rubroId} onChange={(e) => setInvoiceForm((f) => ({ ...f, rubroId: e.target.value, newRubroName: "" }))} className={styles.formSelect}>
                  <option value="">Sin rubro</option>
                  {rubros.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  <option value="__new__">+ Nuevo rubro</option>
                </select>
              </div>
              {invoiceForm.rubroId === "__new__" ? (
                <div className={styles.formField}>
                  <label>Nombre del rubro</label>
                  <input className={styles.formInput} value={invoiceForm.newRubroName} onChange={(e) => setInvoiceForm((f) => ({ ...f, newRubroName: e.target.value }))} placeholder="Ej: Limpieza, Electricidad..." />
                </div>
              ) : <div />}

              <div className={styles.formField}>
                <label>Coeficiente</label>
                <select value={invoiceForm.coeficienteId} onChange={(e) => setInvoiceForm((f) => ({ ...f, coeficienteId: e.target.value, newCoefName: "", newCoefValue: "" }))} className={styles.formSelect}>
                  <option value="">Sin coeficiente</option>
                  {coeficientes.map((c) => <option key={c.id} value={c.id}>{c.name} ({Number(c.value).toFixed(4)})</option>)}
                  <option value="__new__">+ Nuevo coeficiente</option>
                </select>
              </div>
              {invoiceForm.coeficienteId === "__new__" ? (
                <div className={styles.formField}>
                  <label>Nombre del coeficiente</label>
                  <input className={styles.formInput} value={invoiceForm.newCoefName} onChange={(e) => setInvoiceForm((f) => ({ ...f, newCoefName: e.target.value }))} placeholder="Ej: A, B, Cochera" />
                </div>
              ) : <div />}
              {invoiceForm.coeficienteId === "__new__" && (
                <div className={`${styles.formField} ${styles.formFieldFull}`}>
                  <label>Valor del coeficiente</label>
                  <input type="number" className={styles.formInput} value={invoiceForm.newCoefValue} onChange={(e) => setInvoiceForm((f) => ({ ...f, newCoefValue: e.target.value }))} placeholder="0.0000" step="0.0001" min="0" />
                </div>
              )}
            </div>

            {invoiceError && <p className={styles.errorMsg}>{invoiceError}</p>}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => { setShowInvoiceModal(false); resetInvoiceForm(); }} disabled={savingInvoice || scanning}>Cancelar</button>
              <button type="button" className={styles.addInvoiceBtn} onClick={handleSaveInvoice} disabled={savingInvoice || scanning}>
                {savingInvoice ? "Guardando..." : "Guardar boleta"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Provider modal ── */}
      {showProviderModal && (
        <div className={styles.modalOverlay} onClick={() => !savingProvider && setShowProviderModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Nuevo proveedor</h3>
            <p className={styles.modalBody}>El proveedor se crea a nivel cliente y puede asignarse a cualquier consorcio.</p>
            <div className={styles.providerFormGrid}>
              <div className={styles.formField}>
                <label>Razón social *</label>
                <input className={styles.formInput} value={providerForm.canonicalName} onChange={(e) => setProviderForm((f) => ({ ...f, canonicalName: e.target.value }))} placeholder="Nombre completo del proveedor" />
              </div>
              <div className={styles.formField}>
                <label>CUIT *</label>
                <input className={styles.formInput} value={providerForm.cuit} onChange={(e) => setProviderForm((f) => ({ ...f, cuit: e.target.value }))} placeholder="20-12345678-9" />
              </div>
              <div className={`${styles.formField} ${styles.formFieldFull}`}>
                <label>Alias (opcional)</label>
                <input className={styles.formInput} value={providerForm.paymentAlias} onChange={(e) => setProviderForm((f) => ({ ...f, paymentAlias: e.target.value }))} placeholder="Nombre corto o abreviación" />
              </div>
            </div>
            {providerError && <p className={styles.errorMsg}>{providerError}</p>}
            {providerSuccess && <p className={styles.infoMsg}>{providerSuccess}</p>}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => setShowProviderModal(false)} disabled={savingProvider}>Cerrar</button>
              <button type="button" className={styles.providerBtn} onClick={handleSaveProvider} disabled={savingProvider}>
                {savingProvider ? "Guardando..." : "Crear proveedor"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Consortium modal ── */}
      {showConsortiumModal && (
        <div className={styles.modalOverlay} onClick={() => !savingConsortium && setShowConsortiumModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Nuevo consorcio</h3>
            <p className={styles.modalBody}>Se creará con un período activo para el mes en curso.</p>
            <div className={styles.providerFormGrid}>
              <div className={`${styles.formField} ${styles.formFieldFull}`}>
                <label>Nombre del consorcio *</label>
                <input className={styles.formInput} value={consortiumForm.canonicalName} onChange={(e) => setConsortiumForm((f) => ({ ...f, canonicalName: e.target.value }))} placeholder="Ej: Consorcio Av. Corrientes 1234" />
              </div>
              <div className={`${styles.formField} ${styles.formFieldFull}`}>
                <label>CUIT (opcional)</label>
                <input className={styles.formInput} value={consortiumForm.cuit} onChange={(e) => setConsortiumForm((f) => ({ ...f, cuit: e.target.value }))} placeholder="30-12345678-9" />
              </div>
            </div>
            {consortiumError && <p className={styles.errorMsg}>{consortiumError}</p>}
            {consortiumSuccess && <p className={styles.infoMsg}>{consortiumSuccess}</p>}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => setShowConsortiumModal(false)} disabled={savingConsortium}>Cerrar</button>
              <button type="button" className={styles.consortiumBtn} onClick={handleSaveConsortium} disabled={savingConsortium}>
                {savingConsortium ? "Creando..." : "Crear consorcio"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
