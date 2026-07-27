import styles from "../page.module.css";

type Props = {
  periodLabel: string;
  consortiumName: string;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
};

export function ClosePeriodModal({ periodLabel, consortiumName, error, saving, onClose, onSubmit }: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !saving && onClose()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Cerrar período</h3>
        <p className={styles.modalBody}>
          Estás por cerrar el período <strong>{periodLabel}</strong> del consorcio{" "}
          <strong>{consortiumName}</strong>.<br /><br />
          Se creará automáticamente el siguiente período activo. Esta acción no se puede deshacer.
        </p>
        {error && <p className={styles.errorMsg}>{error}</p>}
        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className={styles.closePeriodConfirmBtn} onClick={onSubmit} disabled={saving}>
            {saving ? "Cerrando..." : "Confirmar cierre"}
          </button>
        </div>
      </div>
    </div>
  );
}
