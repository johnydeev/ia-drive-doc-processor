"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { useAuthGuard } from "@/lib/useAuthGuard";

type ThemeMode = "dark" | "light";
const THEME_STORAGE_KEY = "dpp_admin_theme";

type InvoiceRow = {
  id: string;
  clientId: string;
  clientName: string;
  consortium: string | null;
  provider: string | null;
  period: string | null;
  amount: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensTotal: number | null;
  aiProvider: string | null;
  aiModel: string | null;
  isDuplicate: boolean;
  createdAt: string;
};

type ClientOption = { clientId: string; name: string };

function formatAmount(v: number | null) {
  if (v == null) return "—";
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(v);
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

function formatTokens(v: number | null) {
  if (v == null) return "—";
  return v.toLocaleString("es-AR");
}

export default function AdminInvoicesPage() {
  const router = useRouter();
  const { guardedFetch } = useAuthGuard();

  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [clientFilter, setClientFilter] = useState("");
  const [clients, setClients] = useState<ClientOption[]>([]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "dark" || stored === "light") setTheme(stored);
    } catch { /* no-op */ }
  }, []);

  const fetchClients = useCallback(async () => {
    try {
      const res = await guardedFetch("/api/admin/audit/clients", { cache: "no-store" });
      const data = await res.json();
      if (data.ok && data.clients) {
        setClients(data.clients.map((c: { clientId: string; name: string }) => ({
          clientId: c.clientId,
          name: c.name,
        })));
      }
    } catch { /* non-fatal */ }
  }, [guardedFetch]);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (clientFilter) params.set("clientId", clientFilter);
      const res = await guardedFetch(`/api/admin/invoices?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInvoices(data.invoices);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar invoices");
    } finally {
      setLoading(false);
    }
  }, [guardedFetch, page, pageSize, clientFilter]);

  useEffect(() => { void fetchClients(); }, [fetchClients]);
  useEffect(() => { void fetchInvoices(); }, [fetchInvoices]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className={styles.page} data-theme={theme}>
      <div className={styles.gridBackdrop} />
      <main className={styles.panel}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Panel Admin</p>
            <h1>Invoices</h1>
          </div>
          <div className={styles.headerActions}>
            <button type="button" className={styles.ghostBtn} onClick={() => router.push("/admin")}>
              Volver al panel
            </button>
            <button type="button" className={styles.ghostBtn}
              onClick={() => setTheme((t) => t === "dark" ? "light" : "dark")}>
              {theme === "dark" ? "Modo claro" : "Modo oscuro"}
            </button>
          </div>
        </header>

        <div className={styles.filterBar}>
          <label>Cliente:</label>
          <select
            className={styles.select}
            value={clientFilter}
            onChange={(e) => { setClientFilter(e.target.value); setPage(1); }}
          >
            <option value="">Todos los clientes</option>
            {clients.map((c) => (
              <option key={c.clientId} value={c.clientId}>{c.name}</option>
            ))}
          </select>
          <span style={{ opacity: 0.6, fontSize: 13 }}>
            {total} resultado{total !== 1 ? "s" : ""}
          </span>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        {loading ? (
          <p className={styles.loader}>Cargando invoices...</p>
        ) : invoices.length === 0 ? (
          <p className={styles.empty}>No hay invoices para mostrar.</p>
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Consorcio</th>
                    <th>Proveedor</th>
                    <th>Periodo</th>
                    <th>Monto</th>
                    <th>Tokens In</th>
                    <th>Tokens Out</th>
                    <th>Tokens Total</th>
                    <th>Provider IA</th>
                    <th>Modelo IA</th>
                    <th>Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td>{inv.clientName}</td>
                      <td>{inv.consortium ?? "—"}</td>
                      <td>{inv.provider ?? "—"}</td>
                      <td>{inv.period ?? "—"}</td>
                      <td>{formatAmount(inv.amount)}</td>
                      <td className={styles.mono}>{formatTokens(inv.tokensInput)}</td>
                      <td className={styles.mono}>{formatTokens(inv.tokensOutput)}</td>
                      <td className={styles.mono}>{formatTokens(inv.tokensTotal)}</td>
                      <td>{inv.aiProvider ?? "—"}</td>
                      <td className={styles.mono}>{inv.aiModel ?? "—"}</td>
                      <td>{formatDate(inv.createdAt)}</td>
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
