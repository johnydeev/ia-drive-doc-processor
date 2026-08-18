import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import type { ManualRunFile } from "@/lib/manualRun";
import type { ManualRunProgressFile, ManualRunReport } from "../hooks/useManualRun";

type Props = {
  files: ManualRunFile[];
  selected: Set<string>;
  loading: boolean;
  error: string | null;
  max: number;
  runId: string | null;
  progress: ManualRunProgressFile[];
  done: boolean;
  report: ManualRunReport | null;
  onToggle: (fileId: string) => void;
  onEnqueue: () => Promise<void> | void;
  onReset: () => void;
  onClose: () => void;
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "en espera",
  PROCESSING: "procesando…",
  COMPLETED: "lista",
  FAILED: "error",
};

const UNAVAILABLE_LABEL: Record<string, string> = {
  queued: "ya encolada",
  loaded: "ya cargada",
};

/**
 * Corrida selectiva: elegir hasta N boletas de Pendientes y seguir su avance.
 *
 * Presentacional — el estado vive en `useManualRun`. Las boletas se ENCOLAN: las
 * procesa el worker, que no depende del flag del scheduler.
 */
export function ManualRunModal({
  files, selected, loading, error, max,
  runId, progress, done, report,
  onToggle, onEnqueue, onReset, onClose,
}: Props) {
  const available = files.filter((file) => file.status === "available");

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Ejecutar boletas seleccionadas</h3>

        {!runId ? (
          <>
            <p className={styles.modalSubtitle}>
              Elegí hasta {max} boletas de Pendientes. Se encolan y las procesa el worker,
              esté el scheduler prendido o apagado. Al terminar queda un reporte de
              diagnóstico en la subcarpeta <strong>_diagnosticos</strong>.
            </p>

            {error && <p className={styles.errorMsg}>{error}</p>}

            {loading ? (
              <p className={styles.modalSubtitle}>Cargando boletas…</p>
            ) : files.length === 0 ? (
              <p className={styles.modalSubtitle}>No hay boletas en Pendientes.</p>
            ) : (
              <div className={styles.lspTableWrap}>
                <table className={styles.lspTable}>
                  <thead>
                    <tr><th /><th>Archivo</th><th>Estado</th></tr>
                  </thead>
                  <tbody>
                    {files.map((file) => {
                      const isAvailable = file.status === "available";
                      const isChecked = selected.has(file.id);
                      const capReached = !isChecked && selected.size >= max;
                      return (
                        <tr key={file.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              disabled={!isAvailable || capReached}
                              onChange={() => onToggle(file.id)}
                              aria-label={file.name}
                            />
                          </td>
                          <td>{file.name}</td>
                          <td>{isAvailable ? "—" : UNAVAILABLE_LABEL[file.status] ?? file.status}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className={styles.modalActions}>
              <span className={styles.modalSubtitle}>
                {selected.size} de {max} · {available.length} disponibles
              </span>
              <button type="button" className={styles.ghostBtn} onClick={onClose}>
                Cancelar
              </button>
              <AsyncButton
                type="button"
                className={styles.addInvoiceBtn}
                onClick={onEnqueue}
                disabled={selected.size === 0}
                pendingLabel="Encolando…"
              >
                Ejecutar {selected.size > 0 ? `(${selected.size})` : ""}
              </AsyncButton>
            </div>
          </>
        ) : (
          <>
            <p className={styles.modalSubtitle}>
              {done
                ? "Corrida terminada."
                : "Procesando. Podés cerrar esta ventana: el trabajo sigue igual."}
            </p>

            <div className={styles.lspTableWrap}>
              <table className={styles.lspTable}>
                <thead>
                  <tr><th>Archivo</th><th>Estado</th><th>Resultado</th></tr>
                </thead>
                <tbody>
                  {progress.map((file) => (
                    <tr key={file.fileId}>
                      <td>{file.fileName ?? file.fileId}</td>
                      <td>{STATUS_LABEL[file.status] ?? file.status}</td>
                      <td>
                        {file.result ?? "—"}
                        {file.reason ? ` (${file.reason})` : ""}
                        {file.errorMessage ? ` — ${file.errorMessage}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {done && (
              <p className={styles.modalSubtitle}>
                {report?.markdownUrl || report?.jsonUrl ? (
                  <>
                    Reporte:{" "}
                    {report.markdownUrl && (
                      <a href={report.markdownUrl} target="_blank" rel="noreferrer">resumen</a>
                    )}
                    {report.markdownUrl && report.jsonUrl && " · "}
                    {report.jsonUrl && (
                      <a href={report.jsonUrl} target="_blank" rel="noreferrer">JSON completo</a>
                    )}
                  </>
                ) : (
                  "El reporte no se pudo subir a Drive — revisá los logs del worker."
                )}
              </p>
            )}

            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={onReset}>
                Elegir otras
              </button>
              <button type="button" className={styles.addInvoiceBtn} onClick={onClose}>
                Cerrar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
