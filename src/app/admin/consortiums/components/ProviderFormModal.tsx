import styles from "../page.module.css";
import type { ProviderFormValues } from "../hooks/useProviderForm";

type Props = {
  form: ProviderFormValues;
  onChange: (patch: Partial<ProviderFormValues>) => void;
  onClose: () => void;
  onSubmit: () => void;
  saving: boolean;
  error: string | null;
  success: string | null;
};

export function ProviderFormModal({ form, onChange, onClose, onSubmit, saving, error, success }: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !saving && onClose()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Nuevo proveedor</h3>
        <p className={styles.modalBody}>El proveedor se crea a nivel cliente y puede asignarse a cualquier consorcio.</p>
        <div className={styles.providerFormGrid}>
          <div className={styles.formField}>
            <label>Razón social *</label>
            <input className={styles.formInput} value={form.canonicalName} onChange={(e) => onChange({ canonicalName: e.target.value })} placeholder="Nombre completo del proveedor" />
          </div>
          <div className={styles.formField}>
            <label>CUIT *</label>
            <input className={styles.formInput} value={form.cuit} onChange={(e) => onChange({ cuit: e.target.value })} placeholder="20-12345678-9" />
          </div>
          <div className={`${styles.formField} ${styles.formFieldFull}`}>
            <label>Alias (opcional)</label>
            <input className={styles.formInput} value={form.paymentAlias} onChange={(e) => onChange({ paymentAlias: e.target.value })} placeholder="Nombre corto o abreviación" />
          </div>
        </div>
        {error && <p className={styles.errorMsg}>{error}</p>}
        {success && <p className={styles.infoMsg}>{success}</p>}
        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={saving}>Cerrar</button>
          <button type="button" className={styles.providerBtn} onClick={onSubmit} disabled={saving}>
            {saving ? "Guardando..." : "Crear proveedor"}
          </button>
        </div>
      </div>
    </div>
  );
}
