import styles from "../../invoices/page.module.css";
import { formatEta, type BatchItem, type BatchSummary } from "../lib/batchProgress";

type Props = {
  title: string;
  items: BatchItem[];
  summary: BatchSummary;
  isRunning: boolean;
  etaMs: number | null;
  onCancel: () => void;
  onRetryFailed: () => void;
  onClose: () => void;
};

const STATUS_COLOR: Record<BatchItem["status"], string> = {
  pending: "#9ca3af",
  running: "#3b82f6",
  done: "#16a34a",
  skipped: "#b45309",
  failed: "#b91c1c",
};

const STATUS_ICON: Record<BatchItem["status"], string> = {
  pending: "○",
  running: "◐",
  done: "✓",
  skipped: "—",
  failed: "✕",
};

/**
 * Progreso de una corrida masiva. Presentacional puro: todo el estado vive en
 * `useBatchRunner`. Al terminar, esta misma lista ES el resumen — no hay salto a
 * otra pantalla.
 *
 * Mientras corre NO se puede cerrar (no hay botón Cerrar ni cierre por click en
 * el overlay): para frenar hay que usar Cancelar. Así la corrida nunca sigue
 * invisible.
 */
export function BatchProgressModal({
  title, items, summary, isRunning, etaMs, onCancel, onRetryFailed, onClose,
}: Props) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "#111827", color: "#f9fafb", borderRadius: 12, padding: 24,
          maxWidth: 620, width: "90%", maxHeight: "80vh", display: "flex", flexDirection: "column",
        }}
      >
        <h2 style={{ marginTop: 0 }}>{title}</h2>

        <p style={{ margin: "4px 0 8px" }}>
          <strong>{summary.processed} de {summary.total}</strong>
          {isRunning && <> · restante {formatEta(etaMs)}</>}
        </p>

        {/* Barra */}
        <div
          role="progressbar"
          aria-valuenow={summary.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.12)", overflow: "hidden" }}
        >
          <div
            style={{
              width: `${summary.percent}%`, height: "100%",
              background: summary.failed > 0 ? "#b45309" : "#2563eb",
              transition: "width 240ms ease",
            }}
          />
        </div>

        <p style={{ fontSize: 13, opacity: 0.8, margin: "8px 0" }}>
          {summary.done} hecha(s) · {summary.skipped} salteada(s) · {summary.failed} con error
        </p>

        <ul style={{ flex: 1, overflowY: "auto", listStyle: "none", padding: 0, margin: "8px 0" }}>
          {items.map((item) => (
            <li
              key={item.id}
              style={{
                display: "flex", gap: 8, alignItems: "baseline",
                padding: "4px 0", fontSize: 13,
                borderBottom: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <span style={{ color: STATUS_COLOR[item.status], width: 16, flexShrink: 0 }}>
                {STATUS_ICON[item.status]}
              </span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.message && (
                <span style={{ color: STATUS_COLOR[item.status], textAlign: "right" }}>
                  {item.message}
                  {item.needsReview && " — revisar manualmente"}
                </span>
              )}
            </li>
          ))}
        </ul>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          {isRunning ? (
            <button type="button" className={styles.ghostBtn} onClick={onCancel}>
              Cancelar (termina la tanda en curso)
            </button>
          ) : (
            <>
              {summary.failed > 0 && (
                <button
                  type="button"
                  className={styles.ghostBtn}
                  style={{ background: "#2563eb", borderColor: "#2563eb", color: "#fff" }}
                  onClick={onRetryFailed}
                >
                  Reintentar fallidas ({summary.failed})
                </button>
              )}
              <button type="button" className={styles.ghostBtn} onClick={onClose}>
                Cerrar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
