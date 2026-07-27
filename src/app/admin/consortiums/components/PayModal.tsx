import { useRef } from "react";
import styles from "../page.module.css";
import { formatAmount } from "../lib/format";
import type { Invoice, PaymentMode, PayForm } from "../lib/types";

type Props = {
  invoice: Invoice;
  loadingExisting: boolean;
  isFirstPayment: boolean;
  activeMode: PaymentMode | null;
  mode: PaymentMode;
  installmentsLocked: number | null;
  currentInstallmentNumber: number | null;
  isLastInstallment: boolean;
  existingPaymentsCount: number;
  computedAmount: number;
  form: PayForm;
  onFieldChange: (patch: Partial<PayForm>) => void;
  onModeChange: (m: PaymentMode) => void;
  file: File | null;
  onFileChange: (f: File | null) => void;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
};

export function PayModal({
  invoice, loadingExisting, isFirstPayment, activeMode, mode, installmentsLocked,
  currentInstallmentNumber, isLastInstallment, existingPaymentsCount, computedAmount,
  form, onFieldChange, onModeChange, file, onFileChange, error, saving, onClose, onSubmit,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Registrar pago</h3>
        <p className={styles.modalSubtitle}>
          {invoice.provider ?? "—"} — {invoice.boletaNumber ?? "—"}
          {invoice.amount !== null && (
            <> · Importe: {formatAmount(invoice.amount)}</>
          )}
          {invoice.remainingBalance !== null && !invoice.isPaid && (
            <> · Saldo: {formatAmount(invoice.remainingBalance)}</>
          )}
        </p>

        {loadingExisting && (
          <p style={{ fontSize: 12, opacity: 0.6 }}>Cargando historial de pagos...</p>
        )}

        {!loadingExisting && !isFirstPayment && (
          <div style={{
            padding: "10px 14px", borderRadius: 8,
            background: activeMode === "cuotas" ? "rgba(99, 162, 255, 0.12)" : "rgba(255, 184, 114, 0.12)",
            border: `1px solid ${activeMode === "cuotas" ? "rgba(99, 162, 255, 0.35)" : "rgba(255, 184, 114, 0.35)"}`,
            fontSize: 13, marginTop: 8,
          }}>
            {activeMode === "cuotas" ? (
              <>
                <strong>Modo cuotas pactadas</strong> · Cuota {currentInstallmentNumber} de {installmentsLocked}
                {isLastInstallment && (
                  <span style={{ display: "block", marginTop: 4, fontSize: 12, opacity: 0.85 }}>
                    Última cuota — absorbe diferencias de redondeo.
                  </span>
                )}
              </>
            ) : (
              <><strong>Modo pago libre</strong> · Ya hay {existingPaymentsCount} pago(s) registrado(s)</>
            )}
          </div>
        )}

        {!loadingExisting && isFirstPayment && (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button"
              className={mode === "libre" ? styles.addInvoiceBtn : styles.ghostBtn}
              style={{ flex: 1 }}
              onClick={() => onModeChange("libre")}
              disabled={saving}
            >
              Pago libre
            </button>
            <button type="button"
              className={mode === "cuotas" ? styles.addInvoiceBtn : styles.ghostBtn}
              style={{ flex: 1 }}
              onClick={() => onModeChange("cuotas")}
              disabled={saving}
            >
              Cuotas fijas
            </button>
          </div>
        )}

        {error && <p className={styles.errorMsg} style={{ marginTop: 8 }}>{error}</p>}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          {isFirstPayment && mode === "cuotas" && (
            <label>
              <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>
                Cantidad de cuotas
              </span>
              <input
                type="number" min="2" step="1"
                className={styles.formInput}
                placeholder="ej. 3"
                value={form.totalInstallments}
                onChange={(e) => onFieldChange({ totalInstallments: e.target.value })}
                disabled={saving}
              />
            </label>
          )}

          <label>
            <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>
              Monto pagado
              {mode === "cuotas" && (
                <span style={{ fontWeight: 400, opacity: 0.6 }}> (calculado automáticamente)</span>
              )}
            </span>
            {mode === "cuotas" ? (
              <input
                type="text"
                className={styles.formInput}
                value={computedAmount > 0 ? formatAmount(computedAmount) : "—"}
                readOnly disabled
              />
            ) : (
              <input
                type="number" step="0.01"
                className={styles.formInput}
                value={form.amount}
                onChange={(e) => onFieldChange({ amount: e.target.value })}
                disabled={saving}
              />
            )}
          </label>

          <label>
            <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>Fecha de pago</span>
            <input
              type="date"
              className={styles.formInput}
              value={form.paymentDate}
              onChange={(e) => onFieldChange({ paymentDate: e.target.value })}
              disabled={saving}
            />
          </label>

          <label>
            <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>Medio de pago</span>
            <select
              className={styles.formSelect}
              value={form.paymentMethod}
              onChange={(e) => onFieldChange({ paymentMethod: e.target.value })}
              disabled={saving}
            >
              <option value="" disabled hidden>Elija una opción</option>
              <option value="Débito automático">Débito automático</option>
              <option value="Transferencia">Transferencia</option>
              <option value="Efectivo">Efectivo</option>
            </select>
          </label>
          <label style={{ gridColumn: "1 / -1" }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>Observación (opcional)</span>
            <input
              type="text"
              className={styles.formInput}
              value={form.observation}
              onChange={(e) => onFieldChange({ observation: e.target.value })}
              disabled={saving}
            />
          </label>
          <label style={{ gridColumn: "1 / -1" }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>Comprobante PDF</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className={styles.formInput}
              onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
              disabled={saving}
            />
            {file && (
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                {file.name} ({(file.size / 1024).toFixed(1)} KB)
              </span>
            )}
          </label>
        </div>

        <div className={styles.modalActions} style={{ marginTop: 16 }}>
          <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="button" className={styles.addInvoiceBtn} onClick={onSubmit} disabled={saving || loadingExisting}>
            {saving ? "Guardando..." : "Registrar pago"}
          </button>
        </div>
      </div>
    </div>
  );
}
