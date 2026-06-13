"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
// Reutiliza los estilos de la vista admin de invoices (tabla, panel, paginación).
import styles from "../invoices/page.module.css";
import { useAuthGuard } from "@/lib/useAuthGuard";

type ThemeMode = "dark" | "light";
const THEME_STORAGE_KEY = "dpp_admin_theme";

type InvoiceRow = {
  id: string;
  consortiumId: string | null;
  consortium: string | null;
  provider: string | null;
  amount: number | null;
  period: string | null;
  dueDate: string | null;
  isDuplicate: boolean;
  sourceFileUrl: string | null;
  createdAt: string;
};

function formatAmount(v: number | null) {
  if (v == null) return "—";
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(v);
}
function formatDateTime(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}
function formatDateOnly(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-AR", { dateStyle: "short" });
}

export default function BoletasEntrantesPage() {
  const router = useRouter();
  const { guardedFetch } = useAuthGuard();

  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "dark" || stored === "light") setTheme(stored);
    } catch { /* no-op */ }
  }, []);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      const res = await guardedFetch(`/api/client/invoices?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInvoices(data.invoices);
      setTotal(data.total);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar boletas");
    } finally {
      setLoading(false);
    }
  }, [guardedFetch, page, pageSize]);

  useEffect(() => { void fetchInvoices(); }, [fetchInvoices]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const allSelected = invoices.length > 0 && invoices.every((i) => selected.has(i.id));
  const selectedCount = selected.size;

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => (prev.size === invoices.length ? new Set() : new Set(invoices.map((i) => i.id))));
  };

  const handleDeleteSelected = useCallback(async () => {
    if (selectedCount === 0) return;
    const ok = window.confirm(
      `¿Borrar ${selectedCount} boleta(s)?\n\n` +
      `Se quitan del Sheet y de la base, y los PDFs vuelven a Pendientes para reprocesarse.`
    );
    if (!ok) return;

    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await guardedFetch("/api/client/invoices/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceIds: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const failedCount = data.failed?.length ?? 0;
      setNotice(
        `${data.deleted} boleta(s) borrada(s)` +
        (failedCount > 0 ? ` — ${failedCount} con error (revisá la consola)` : "")
      );
      if (failedCount > 0) console.warn("[bulk-delete] fallidas:", data.failed);
      await fetchInvoices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al borrar");
    } finally {
      setDeleting(false);
    }
  }, [guardedFetch, selected, selectedCount, fetchInvoices]);

  const dangerBtnStyle = useMemo<React.CSSProperties>(() => ({
    background: selectedCount > 0 ? "#b91c1c" : undefined,
    borderColor: selectedCount > 0 ? "#b91c1c" : undefined,
    color: selectedCount > 0 ? "#fff" : undefined,
    opacity: selectedCount > 0 ? 1 : 0.5,
  }), [selectedCount]);

  return (
    <div className={styles.page} data-theme={theme}>
      <div className={styles.gridBackdrop} />
      <main className={styles.panel}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Boletas</p>
            <h1>Boletas entrantes</h1>
          </div>
          <div className={styles.headerActions}>
            <button type="button" className={styles.ghostBtn} onClick={() => router.push("/admin/consortiums")}>
              Volver al panel
            </button>
            <button type="button" className={styles.ghostBtn}
              onClick={() => setTheme((t) => t === "dark" ? "light" : "dark")}>
              {theme === "dark" ? "Modo claro" : "Modo oscuro"}
            </button>
          </div>
        </header>

        <div className={styles.filterBar}>
          <button type="button" className={styles.ghostBtn} style={dangerBtnStyle}
            disabled={selectedCount === 0 || deleting} onClick={handleDeleteSelected}>
            {deleting ? "Borrando..." : `Borrar seleccionadas${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
          </button>
          <button type="button" className={styles.ghostBtn} disabled={loading} onClick={() => void fetchInvoices()}>
            Refrescar
          </button>
          <span style={{ opacity: 0.6, fontSize: 13 }}>
            {total} boleta{total !== 1 ? "s" : ""} · orden de entrada (más recientes arriba)
          </span>
        </div>

        {error && <p className={styles.error}>{error}</p>}
        {notice && <p style={{ color: "#16a34a", fontSize: 13, margin: "4px 0" }}>{notice}</p>}

        {loading ? (
          <p className={styles.loader}>Cargando boletas...</p>
        ) : invoices.length === 0 ? (
          <p className={styles.empty}>No hay boletas para mostrar.</p>
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Seleccionar todas" /></th>
                    <th>Entrada</th>
                    <th>Consorcio</th>
                    <th>Proveedor</th>
                    <th>Monto</th>
                    <th>Periodo</th>
                    <th>Vto</th>
                    <th>Dup.</th>
                    <th>PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} style={selected.has(inv.id) ? { background: "rgba(185,28,28,0.12)" } : undefined}>
                      <td><input type="checkbox" checked={selected.has(inv.id)} onChange={() => toggleOne(inv.id)} aria-label="Seleccionar boleta" /></td>
                      <td>{formatDateTime(inv.createdAt)}</td>
                      <td>{inv.consortium ?? "—"}</td>
                      <td>{inv.provider ?? "—"}</td>
                      <td>{formatAmount(inv.amount)}</td>
                      <td>{inv.period ?? "—"}</td>
                      <td>{formatDateOnly(inv.dueDate)}</td>
                      <td>{inv.isDuplicate ? "Sí" : "—"}</td>
                      <td>
                        {inv.sourceFileUrl
                          ? <a href={inv.sourceFileUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#3b82f6" }}>Ver</a>
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.pagination}>
              <button type="button" className={styles.ghostBtn}
                disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Anterior
              </button>
              <span style={{ fontSize: 13 }}>Pagina {page} de {totalPages}</span>
              <button type="button" className={styles.ghostBtn}
                disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Siguiente
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
