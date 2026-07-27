import styles from "../page.module.css";
import type { CloseAllPreview } from "../lib/types";

type Props = {
  step: "preview" | "result";
  preview: CloseAllPreview | null;
  loading: boolean;
  result: { closed: number; skipped: number; warnings: string[] } | null;
  error: string | null;
  onClose: () => void;
  onExecute: () => void;
};

export function CloseAllModal({ step, preview, loading, result, error, onClose, onExecute }: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !loading && onClose()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        {step === "preview" && (
          <>
            <h3 className={styles.modalTitle}>Cerrar Periodo General</h3>
            {error && <p className={styles.errorMsg}>{error}</p>}
            {preview && !preview.majorityMonth && (
              <p className={styles.modalBody}>No hay períodos activos para cerrar.</p>
            )}
            {preview && preview.majorityMonth && (
              <>
                <p className={styles.modalBody}>
                  Se cerrarán <strong>{preview.toClose.length}</strong> consorcio(s).
                  <br />Período: <strong>{preview.majorityMonth}</strong> → <strong>{preview.nextMonth}</strong>
                </p>
                {(() => {
                  const totalPend = preview.toClose.reduce((s, c) => s + (c.pendingObligations ?? 0), 0);
                  const affected = preview.toClose.filter((c) => (c.pendingObligations ?? 0) > 0).length;
                  return totalPend > 0 ? (
                    <p style={{ fontSize: "13px", color: "#ffb872", marginBottom: "6px" }}>
                      ⚠️ Faltan {totalPend} boleta(s) de gastos fijos en {affected} consorcio(s).
                    </p>
                  ) : null;
                })()}
                {preview.toSkip.length > 0 && (
                  <>
                    <p style={{ fontSize: "13px", color: "#ffb872", marginBottom: "6px" }}>
                      Se saltearán {preview.toSkip.length} consorcio(s):
                    </p>
                    <ul className={styles.closeAllList}>
                      {preview.toSkip.map((c) => (
                        <li key={c.id}>
                          <strong>{c.canonicalName}</strong> — {c.currentPeriod}
                          <span className={styles.closeAllSkipReason}>Ya está en período más avanzado</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={loading}>Cancelar</button>
              {preview?.majorityMonth && (
                <button type="button" className={styles.closePeriodConfirmBtn} onClick={onExecute} disabled={loading}>
                  {loading ? "Cerrando..." : "Confirmar"}
                </button>
              )}
            </div>
          </>
        )}
        {step === "result" && result && (
          <>
            <h3 className={styles.modalTitle}>Resultado</h3>
            <p className={styles.modalBody}>
              Cerrados: <strong>{result.closed}</strong> | Salteados: <strong>{result.skipped}</strong>
            </p>
            {result.warnings.length > 0 && (
              <ul className={styles.closeAllList}>
                {result.warnings.map((w, i) => (
                  <li key={i} style={{ color: "#ffb872" }}>{w}</li>
                ))}
              </ul>
            )}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
