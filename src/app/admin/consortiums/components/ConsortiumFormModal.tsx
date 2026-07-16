import styles from "../page.module.css";
import type { ConsortiumFormValues } from "../hooks/useConsortiumForm";

type Props = {
  form: ConsortiumFormValues;
  onChange: (patch: Partial<ConsortiumFormValues>) => void;
  onClose: () => void;
  onSubmit: () => void;
  saving: boolean;
  error: string | null;
  success: string | null;
};

export function ConsortiumFormModal({ form, onChange, onClose, onSubmit, saving, error, success }: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !saving && onClose()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Nuevo consorcio</h3>
        <p className={styles.modalBody}>Se creará con un período activo para el mes en curso.</p>
        <div className={styles.providerFormGrid}>
          <div className={`${styles.formField} ${styles.formFieldFull}`}>
            <label>Nombre del consorcio *</label>
            <input className={styles.formInput} value={form.canonicalName} onChange={(e) => onChange({ canonicalName: e.target.value })} placeholder="Ej: Consorcio Av. Corrientes 1234" />
          </div>
          <div className={`${styles.formField} ${styles.formFieldFull}`}>
            <label>CUIT (opcional)</label>
            <input className={styles.formInput} value={form.cuit} onChange={(e) => onChange({ cuit: e.target.value })} placeholder="30-12345678-9" />
          </div>
        </div>
        {error && <p className={styles.errorMsg}>{error}</p>}
        {success && <p className={styles.infoMsg}>{success}</p>}
        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={saving}>Cerrar</button>
          <button type="button" className={styles.consortiumBtn} onClick={onSubmit} disabled={saving}>
            {saving ? "Creando..." : "Crear consorcio"}
          </button>
        </div>
      </div>
    </div>
  );
}
