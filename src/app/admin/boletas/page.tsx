"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
// Reutiliza los estilos de la vista admin de invoices (tabla, panel, paginación).
import styles from "../invoices/page.module.css";
import { useAuthGuard } from "@/lib/useAuthGuard";

type ThemeMode = "dark" | "light";
const THEME_STORAGE_KEY = "dpp_admin_theme";
/** Tope de boletas por tanda al mover de período (evita el timeout de ~100s del túnel). */
const MAX_MOVE_BATCH = 40;

type InvoiceRow = {
  id: string;
  consortiumId: string | null;
  consortium: string | null;
  provider: string | null;
  boletaNumber: string | null;
  amount: number | null;
  period: string | null;
  dueDate: string | null;
  isDuplicate: boolean;
  sourceFileUrl: string | null;
  createdAt: string;
};

type Facet = { id: string; name: string };

type MovePreviewItem = { invoiceId: string; consortium: string | null; movable: boolean; fromLabel?: string; toLabel?: string; skip?: string };
type MoveSummary = { moved: number; skipped: Array<{ invoiceId: string; reason: string }>; failed: Array<{ invoiceId: string; error: string; reverted: boolean }>; total: number };

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
/** Últimos 4 dígitos del número de boleta (identificador corto para la lista). */
function formatBoletaShort(n: string | null) {
  if (!n) return "—";
  const last4 = n.replace(/\D/g, "").slice(-4);
  return last4 ? `…${last4}` : "—";
}

/**
 * Convierte una URL de Google Drive (webViewLink `.../d/<id>/view`, `open?id=<id>`,
 * etc.) a la URL `/preview` embebible en un iframe (visor de Drive, scrolleable).
 * Si no reconoce el formato devuelve la URL original (fallback: abrir en Drive).
 */
function toDrivePreviewUrl(url: string): string {
  const m = url.match(/\/d\/([^/]+)/) ?? url.match(/[?&]id=([^&]+)/);
  const id = m?.[1];
  return id ? `https://drive.google.com/file/d/${id}/preview` : url;
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
  const [moving, setMoving] = useState(false);
  const [moveStep, setMoveStep] = useState<null | "preview" | "result">(null);
  const [movePreview, setMovePreview] = useState<MovePreviewItem[]>([]);
  const [moveResult, setMoveResult] = useState<MoveSummary | null>(null);
  const [facets, setFacets] = useState<{ consortiums: Facet[]; providers: Facet[]; periods: Facet[] }>({ consortiums: [], providers: [], periods: [] });
  const [consortiumFilter, setConsortiumFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [periodFilter, setPeriodFilter] = useState("");
  // Modal de vista previa de boleta (iframe de Drive, sin salir de la pestaña).
  const [preview, setPreview] = useState<{ url: string; sourceUrl: string; title: string } | null>(null);

  // Cerrar el modal con Escape.
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPreview(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

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
      if (consortiumFilter) params.set("consortiumId", consortiumFilter);
      if (providerFilter) params.set("providerId", providerFilter);
      if (periodFilter) params.set("period", periodFilter);
      const res = await guardedFetch(`/api/client/invoices?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInvoices(data.invoices);
      setTotal(data.total);
      if (data.facets) setFacets(data.facets);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar boletas");
    } finally {
      setLoading(false);
    }
  }, [guardedFetch, page, pageSize, consortiumFilter, providerFilter, periodFilter]);

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

  const SKIP_LABELS: Record<string, string> = {
    sin_periodo: "sin período asignado",
    destino_inexistente: "el período siguiente no existe todavía (cerrá el período primero)",
    destino_cerrado: "el período siguiente está cerrado",
  };

  const openMoveModal = useCallback(async () => {
    if (selectedCount === 0) return;
    if (selectedCount > MAX_MOVE_BATCH) {
      setError(`No se pueden mover más de ${MAX_MOVE_BATCH} boletas por tanda. Seleccioná hasta ${MAX_MOVE_BATCH} y hacé el resto en la siguiente tanda.`);
      return;
    }
    setError(null);
    setNotice(null);
    setMoveResult(null);
    setMoving(true);
    try {
      const res = await guardedFetch("/api/client/invoices/bulk-move-period/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceIds: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMovePreview(data.items as MovePreviewItem[]);
      setMoveStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al previsualizar");
    } finally {
      setMoving(false);
    }
  }, [guardedFetch, selected, selectedCount]);

  const confirmMove = useCallback(async () => {
    setMoving(true);
    setError(null);
    try {
      const res = await guardedFetch("/api/client/invoices/bulk-move-period", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceIds: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMoveResult(data as MoveSummary);
      setMoveStep("result");
      setSelected(new Set());
      await fetchInvoices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al mover");
    } finally {
      setMoving(false);
    }
  }, [guardedFetch, selected, fetchInvoices]);

  const closeMoveModal = useCallback(() => {
    setMoveStep(null);
    setMovePreview([]);
    setMoveResult(null);
  }, []);

  const movableCount = movePreview.filter((i) => i.movable).length;
  const skippablePreview = movePreview.filter((i) => !i.movable);

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
              Volver a Consorcios
            </button>
            <button type="button" className={styles.ghostBtn}
              onClick={() => setTheme((t) => t === "dark" ? "light" : "dark")}>
              {theme === "dark" ? "Modo claro" : "Modo oscuro"}
            </button>
          </div>
        </header>

        <div className={styles.filterBar}>
          <button type="button" className={styles.ghostBtn} style={dangerBtnStyle}
            disabled={selectedCount === 0 || deleting || moving} onClick={handleDeleteSelected}>
            {deleting ? "Borrando..." : `Borrar seleccionadas${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
          </button>
          <button type="button" className={styles.ghostBtn}
            disabled={selectedCount === 0 || moving || deleting} onClick={() => void openMoveModal()}>
            {moving && moveStep === null ? "Cargando..." : `Mover al período siguiente${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
          </button>
          <button type="button" className={styles.ghostBtn} disabled={loading} onClick={() => void fetchInvoices()}>
            Refrescar
          </button>
          <select className={styles.select} value={consortiumFilter}
            onChange={(e) => { setConsortiumFilter(e.target.value); setPage(1); }} aria-label="Filtrar por consorcio">
            <option value="">Todos los consorcios</option>
            {facets.consortiums.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className={styles.select} value={providerFilter}
            onChange={(e) => { setProviderFilter(e.target.value); setPage(1); }} aria-label="Filtrar por proveedor">
            <option value="">Todos los proveedores</option>
            {facets.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className={styles.select} value={periodFilter}
            onChange={(e) => { setPeriodFilter(e.target.value); setPage(1); }} aria-label="Filtrar por periodo">
            <option value="">Todos los periodos</option>
            {facets.periods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
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
                    <th>N° Boleta</th>
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
                      <td>{formatBoletaShort(inv.boletaNumber)}</td>
                      <td>{formatAmount(inv.amount)}</td>
                      <td>{inv.period ?? "—"}</td>
                      <td>{formatDateOnly(inv.dueDate)}</td>
                      <td>{inv.isDuplicate ? "Sí" : "—"}</td>
                      <td>
                        {inv.sourceFileUrl
                          ? <button
                              type="button"
                              onClick={() => setPreview({
                                url: toDrivePreviewUrl(inv.sourceFileUrl!),
                                sourceUrl: inv.sourceFileUrl!,
                                title: `${inv.provider ?? "Boleta"}${inv.consortium ? ` — ${inv.consortium}` : ""}`,
                              })}
                              style={{ background: "none", border: "none", color: "#3b82f6", cursor: "pointer", padding: 0, font: "inherit", textDecoration: "underline" }}
                            >
                              Ver
                            </button>
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

      {/* Modal de vista previa: iframe del visor de Drive (scrolleable), sin salir de la pestaña. */}
      {preview && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setPreview(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.7)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "24px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(900px, 92vw)", height: "90vh",
              background: "#0f1629", border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 12, display: "flex", flexDirection: "column",
              overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 12, padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.1)",
            }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#eef2ff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {preview.title}
              </span>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <a
                  href={preview.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 13, color: "#7aaeff", textDecoration: "none", padding: "6px 10px", border: "1px solid rgba(91,140,247,0.35)", borderRadius: 8 }}
                >
                  Abrir en Drive ↗
                </a>
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                  style={{ fontSize: 16, color: "#c8d8ff", background: "none", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, width: 34, height: 34, cursor: "pointer" }}
                  aria-label="Cerrar vista previa"
                >
                  ✕
                </button>
              </div>
            </div>
            <iframe
              src={preview.url}
              title="Vista previa de boleta"
              style={{ flex: 1, width: "100%", border: "none", background: "#fff" }}
              allow="autoplay"
            />
          </div>
        </div>
      )}

      {/* Modal de 2 pasos: migración de boletas al período siguiente. */}
      {moveStep !== null && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
          onClick={closeMoveModal}
        >
          <div
            style={{ background: theme === "dark" ? "#111827" : "#fff", color: theme === "dark" ? "#f9fafb" : "#111827", borderRadius: 12, padding: 24, maxWidth: 560, width: "90%", maxHeight: "80vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            {moveStep === "preview" && (
              <>
                <h2 style={{ marginTop: 0 }}>Mover al período siguiente</h2>
                <p><strong>{movableCount}</strong> boleta(s) se moverán al mes siguiente de su consorcio.</p>
                <ul style={{ maxHeight: 180, overflowY: "auto", paddingLeft: 18 }}>
                  {movePreview.filter((i) => i.movable).map((i) => (
                    <li key={i.invoiceId}>{i.consortium ?? "(sin consorcio)"}: {i.fromLabel} → {i.toLabel}</li>
                  ))}
                </ul>
                {skippablePreview.length > 0 && (
                  <>
                    <p style={{ color: "#b45309" }}><strong>{skippablePreview.length}</strong> se saltearán:</p>
                    <ul style={{ maxHeight: 140, overflowY: "auto", paddingLeft: 18, color: "#b45309" }}>
                      {skippablePreview.map((i) => (
                        <li key={i.invoiceId}>{i.consortium ?? "(sin consorcio)"}: {i.skip ? SKIP_LABELS[i.skip] ?? i.skip : "no evaluable"}</li>
                      ))}
                    </ul>
                  </>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                  <button type="button" className={styles.ghostBtn} onClick={closeMoveModal} disabled={moving}>Cancelar</button>
                  <button type="button" className={styles.ghostBtn}
                    style={{ background: "#2563eb", borderColor: "#2563eb", color: "#fff", opacity: movableCount > 0 ? 1 : 0.5 }}
                    disabled={moving || movableCount === 0} onClick={() => void confirmMove()}>
                    {moving ? "Moviendo..." : `Confirmar (${movableCount})`}
                  </button>
                </div>
              </>
            )}
            {moveStep === "result" && moveResult && (
              <>
                <h2 style={{ marginTop: 0 }}>Resultado</h2>
                <p>
                  <strong>{moveResult.moved}</strong> movida(s) · <strong>{moveResult.skipped.length}</strong> salteada(s) · <strong>{moveResult.failed.length}</strong> con error
                </p>
                {moveResult.failed.length > 0 && (
                  <ul style={{ maxHeight: 180, overflowY: "auto", paddingLeft: 18, color: "#b91c1c" }}>
                    {moveResult.failed.map((f) => (
                      <li key={f.invoiceId}>
                        {f.invoiceId}: {f.error}{f.reverted ? " (revertida)" : " — NO revertida, revisar manualmente"}
                      </li>
                    ))}
                  </ul>
                )}
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
                  <button type="button" className={styles.ghostBtn} onClick={closeMoveModal}>Cerrar</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
