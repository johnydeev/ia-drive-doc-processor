import styles from "../page.module.css";
import { formatAmount, formatDate } from "../lib/format";
import type { Invoice, PaymentRecord } from "../lib/types";

type Props = {
  invoice: Invoice;
  list: PaymentRecord[];
  loading: boolean;
  onClose: () => void;
};

export function ViewPaymentsModal({ invoice, list, loading, onClose }: Props) {
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Historial de pagos</h3>
        <p className={styles.modalSubtitle}>
          {invoice.provider ?? "—"} — {invoice.boletaNumber ?? "—"}
          {invoice.amount !== null && (
            <> · Importe total: {formatAmount(invoice.amount)}</>
          )}
        </p>

        {loading ? (
          <p style={{ fontSize: 12, opacity: 0.6 }}>Cargando...</p>
        ) : list.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>Esta boleta no tiene pagos registrados.</p>
        ) : (
          <div className={styles.tableWrap} style={{ marginTop: 12 }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Fecha</th>
                  <th>Monto</th>
                  <th>Medio</th>
                  <th>Comprobante</th>
                  <th>Observación</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.paymentType === "CUOTA" || p.totalInstallments
                        ? <span className={styles.badgeOk}>Cuota {p.installmentNumber}/{p.totalInstallments}</span>
                        : p.paymentType === "TOTAL"
                          ? <span className={styles.badgeOk}>Total</span>
                          : <span className={styles.badgeManual}>Libre</span>}
                    </td>
                    <td>{formatDate(p.paymentDate)}</td>
                    <td className={styles.tdAmount}>{formatAmount(Number(p.amount))}</td>
                    <td>{p.paymentMethod ?? "—"}</td>
                    <td>
                      {p.driveFileUrl
                        ? <a href={p.driveFileUrl} target="_blank" rel="noopener noreferrer" className={styles.fileLink}>Ver PDF</a>
                        : "—"}
                    </td>
                    <td className={styles.tdDetail}>{p.observation ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className={styles.modalActions} style={{ marginTop: 16 }}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
