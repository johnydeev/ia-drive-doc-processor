import styles from "../page.module.css";
import { TIPOS_COMPROBANTE, TIPOS_GASTO } from "../lib/constants";
import { formatAmountPlain, parseAmountInput } from "../lib/format";
import { parsePaymentAliases } from "@/lib/paymentAliases";
import type { Coeficiente, InvoiceForm, Provider, Rubro } from "../lib/types";

type Props = {
  consortiumName: string;
  periodLabel: string;
  scanning: boolean;
  scanFile: File | null;
  scanWarning: string | null;
  matchedProvider: Provider | null;
  form: InvoiceForm;
  setField: (patch: Partial<InvoiceForm>) => void;
  providers: Provider[];
  coeficientes: Coeficiente[];
  rubros: Rubro[];
  error: string | null;
  saving: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function InvoiceModal({
  consortiumName, periodLabel, scanning, scanFile, scanWarning, matchedProvider,
  form, setField, providers, coeficientes, rubros, error, saving, fileInputRef, onFileChange, onClose, onSubmit,
}: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !saving && !scanning && onClose()}>
      <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Cargar boleta</h3>
        <p className={styles.modalConsortiumName}>{consortiumName}</p>
        <p className={styles.modalSubtitle} style={{ textAlign: "center" }}>{periodLabel}</p>

        <div className={styles.scanSection}>
          <label className={styles.scanLabel}>
            {scanning ? "Escaneando PDF..." : scanFile ? `📄 ${scanFile.name}` : "Subir PDF para escanear (opcional)"}
            <input ref={fileInputRef} type="file" accept=".pdf" onChange={onFileChange} style={{ display: "none" }} disabled={scanning} />
          </label>
          {scanning && <div className={styles.scanSpinner} />}
        </div>
        {matchedProvider && (
          <p className={styles.infoMsg}>
            ✓ Proveedor identificado: <strong>{matchedProvider.canonicalName}</strong>
            {matchedProvider.cuit ? ` — ${matchedProvider.cuit}` : ""}
          </p>
        )}
        {scanWarning && <p className={styles.warnMsg}>{scanWarning}</p>}

        <div className={styles.invoiceFormGrid}>
          <div className={styles.formField}>
            <label>Proveedor *</label>
            <select value={form.providerId} onChange={(e) => setField({ providerId: e.target.value })} className={styles.formSelect}>
              <option value="">Seleccioná un proveedor</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.canonicalName}
                  {/* Sólo el primer alias: con tres el desplegable se vuelve ilegible. */}
                  {parsePaymentAliases(p.paymentAlias)[0] ? ` (${parsePaymentAliases(p.paymentAlias)[0]})` : ""}
                  {p.oficio ? ` — ${p.oficio.name}` : ""}
                  {p.providerType === "EMPLEADO" ? " [EMPLEADO]" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.formField}>
            <label>N° Comprobante</label>
            <input className={styles.formInput} value={form.boletaNumber} onChange={(e) => setField({ boletaNumber: e.target.value })} placeholder="0001-00000123" />
          </div>

          <div className={styles.formField}>
            <label>
              {matchedProvider?.providerType === "EMPLEADO" ? "CUIL" : "CUIT"} emisor
              {matchedProvider && <span className={styles.canonLabel}> ✓ verificado</span>}
            </label>
            <input
              className={styles.formInput}
              value={form.providerTaxId}
              onChange={(e) => setField({ providerTaxId: e.target.value })}
              placeholder="20-12345678-9"
              readOnly={!!matchedProvider}
              style={matchedProvider ? { opacity: 0.7, cursor: "not-allowed" } : undefined}
            />
          </div>
          <div className={styles.formField}>
            <label>Tipo de comprobante</label>
            <select value={form.tipoComprobante} onChange={(e) => setField({ tipoComprobante: e.target.value })} className={styles.formSelect}>
              <option value="">Sin especificar</option>
              {TIPOS_COMPROBANTE.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div className={styles.formField}>
            <label>Monto</label>
            <input
              type="text"
              inputMode="decimal"
              className={styles.formInput}
              value={form.amount}
              onChange={(e) => setField({ amount: e.target.value })}
              onBlur={(e) => {
                const raw = e.target.value.trim();
                if (!raw) { setField({ amount: "" }); return; }
                const n = parseAmountInput(raw);
                setField({ amount: Number.isFinite(n) ? formatAmountPlain(n) : raw });
              }}
              placeholder="0,00"
            />
          </div>
          <div className={styles.formField}>
            <label>Tipo de gasto</label>
            <select value={form.tipoGasto} onChange={(e) => setField({ tipoGasto: e.target.value })} className={styles.formSelect}>
              {TIPOS_GASTO.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          <div className={styles.formField}>
            <label>Fecha de emisión</label>
            <input type="date" className={styles.formInput} value={form.issueDate} onChange={(e) => setField({ issueDate: e.target.value })} />
          </div>
          <div className={styles.formField}>
            <label>Fecha de vencimiento</label>
            <input type="date" className={styles.formInput} value={form.dueDate} onChange={(e) => setField({ dueDate: e.target.value })} />
          </div>

          <div className={`${styles.formField} ${styles.formFieldFull}`}>
            <label>Detalle</label>
            <textarea
              className={styles.formTextarea}
              rows={3}
              value={form.detail}
              onChange={(e) => setField({ detail: e.target.value })}
              placeholder="Descripción del servicio"
            />
          </div>

          <div className={styles.formField}>
            <label>Rubro</label>
            <select value={form.rubroId} onChange={(e) => setField({ rubroId: e.target.value, newRubroName: "" })} className={styles.formSelect}>
              <option value="">Sin rubro</option>
              {rubros.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              <option value="__new__">+ Nuevo rubro</option>
            </select>
          </div>
          {form.rubroId === "__new__" ? (
            <div className={styles.formField}>
              <label>Nombre del rubro</label>
              <input className={styles.formInput} value={form.newRubroName} onChange={(e) => setField({ newRubroName: e.target.value })} placeholder="Ej: Limpieza, Electricidad..." />
            </div>
          ) : <div />}

          <div className={styles.formField}>
            <label>Coeficiente</label>
            <select value={form.coeficienteId} onChange={(e) => setField({ coeficienteId: e.target.value, newCoefName: "", newCoefValue: "" })} className={styles.formSelect}>
              <option value="">Sin coeficiente</option>
              {coeficientes.map((c) => <option key={c.id} value={c.id}>{c.name} ({Number(c.value).toFixed(4)})</option>)}
              <option value="__new__">+ Nuevo coeficiente</option>
            </select>
          </div>
          {form.coeficienteId === "__new__" ? (
            <div className={styles.formField}>
              <label>Nombre del coeficiente</label>
              <input className={styles.formInput} value={form.newCoefName} onChange={(e) => setField({ newCoefName: e.target.value })} placeholder="Ej: A, B, Cochera" />
            </div>
          ) : <div />}
          {form.coeficienteId === "__new__" && (
            <div className={`${styles.formField} ${styles.formFieldFull}`}>
              <label>Valor del coeficiente</label>
              <input type="number" className={styles.formInput} value={form.newCoefValue} onChange={(e) => setField({ newCoefValue: e.target.value })} placeholder="0.0000" step="0.0001" min="0" />
            </div>
          )}
        </div>

        {error && <p className={styles.errorMsg}>{error}</p>}
        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={saving || scanning}>Cancelar</button>
          <button type="button" className={styles.addInvoiceBtn} onClick={onSubmit} disabled={saving || scanning}>
            {saving ? "Guardando..." : "Guardar boleta"}
          </button>
        </div>
      </div>
    </div>
  );
}
