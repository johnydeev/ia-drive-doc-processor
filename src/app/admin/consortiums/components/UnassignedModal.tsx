import styles from "../page.module.css";

type UnassignedFile = { id: string; name: string };

type Props = {
  step: "preview" | "result";
  files: UnassignedFile[];
  folderConfigured: boolean;
  result: { moved: number; failed: number } | null;
  loading: boolean;
  onClose: () => void;
  onRequeue: () => void;
};

export function UnassignedModal({ step, files, folderConfigured, result, loading, onClose, onRequeue }: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !loading && onClose()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        {step === "preview" && (
          <>
            <h3 className={styles.modalTitle}>Archivos Sin Asignar</h3>
            {loading && <p className={styles.modalBody}>Consultando Drive...</p>}
            {!loading && !folderConfigured && (
              <>
                <p className={styles.modalBody}>La carpeta Sin Asignar no está configurada para este cliente.</p>
                <div className={styles.modalActions}>
                  <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
                </div>
              </>
            )}
            {!loading && folderConfigured && files.length === 0 && (
              <>
                <p className={styles.modalBody}>No hay archivos sin asignar.</p>
                <div className={styles.modalActions}>
                  <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
                </div>
              </>
            )}
            {!loading && folderConfigured && files.length > 0 && (
              <>
                <p className={styles.modalBody}>
                  Se encontraron <strong>{files.length}</strong> archivo(s) en la carpeta Sin Asignar:
                </p>
                <ul className={styles.closeAllList}>
                  {files.map((f) => (
                    <li key={f.id}>{f.name}</li>
                  ))}
                </ul>
                <div className={styles.modalActions}>
                  <button type="button" className={styles.ghostBtn} onClick={onClose}>Cancelar</button>
                  <button type="button" className={styles.closePeriodConfirmBtn} onClick={onRequeue} disabled={loading}>
                    Mover a Pendientes ({files.length} archivos)
                  </button>
                </div>
              </>
            )}
          </>
        )}
        {step === "result" && result && (
          <>
            <h3 className={styles.modalTitle}>Archivos movidos a Pendientes</h3>
            <p className={styles.modalBody}>
              {result.moved > 0 && <>{result.moved} archivo(s) movidos a Pendientes correctamente.<br /></>}
              {result.failed > 0 && <span style={{ color: "#ffb872" }}>{result.failed} archivo(s) no pudieron moverse.<br /></span>}
              <br />
              El scheduler los procesará en el próximo ciclo automáticamente.
              También podés usar <strong>Ejecutar ahora</strong> en la toolbar.
            </p>
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
