import styles from "../page.module.css";

type Props = {
  consortiumName: string;
  onDismiss: () => void;
};

export function MismatchModal({ consortiumName, onDismiss }: Props) {
  return (
    <div className={styles.modalOverlayTop}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>⚠️ Boleta de otro consorcio</h3>
        <p className={styles.modalBody}>
          Este gasto <strong>NO corresponde</strong> al consorcio seleccionado.<br /><br />
          Según la información extraída del PDF, la boleta pertenece a:<br />
          <strong style={{ fontSize: "16px", color: "#ffb347" }}>{consortiumName}</strong><br /><br />
          Verificá que estés cargando la boleta en el consorcio correcto antes de continuar.
        </p>
        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onDismiss}>
            Entendido — cancelar carga
          </button>
        </div>
      </div>
    </div>
  );
}
