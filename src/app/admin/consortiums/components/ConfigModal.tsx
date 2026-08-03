import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { LSP_PROVIDERS } from "../lib/constants";
import type { Bank, BankAccountForm, ConfigSection, FixedExpenseRow, LspForm, LspService, Provider } from "../lib/types";

type Props = {
  consortiumName: string;
  saving: boolean;
  openSection: ConfigSection | null;
  onToggleSection: (section: ConfigSection) => void;
  onClose: () => void;
  providers: Provider[];
  banks: Bank[];
  bank: {
    form: BankAccountForm;
    msg: string | null;
    onChangeForm: (patch: Partial<BankAccountForm>) => void;
    onSave: () => void;
  };
  matchNames: {
    editing: boolean;
    value: string;
    msg: string | null;
    onChangeValue: (value: string) => void;
    onStartEdit: () => void;
    onCancelEdit: () => void;
    onSave: () => void;
  };
  lsp: {
    services: LspService[];
    form: LspForm;
    error: string | null;
    confirmDeleteId: string | null;
    onChangeForm: (patch: Partial<LspForm>) => void;
    onConfirmDelete: (id: string | null) => void;
    onAdd: () => void;
    onDelete: (id: string) => void;
  };
  fixed: {
    list: FixedExpenseRow[];
    target: string;
    error: string | null;
    onChangeTarget: (value: string) => void;
    onAdd: () => void;
    onToggle: (fx: FixedExpenseRow) => void;
    onDelete: (id: string) => void;
  };
};

export function ConfigModal({
  consortiumName, saving, openSection, onToggleSection, onClose, providers, banks, bank, matchNames, lsp, fixed,
}: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !saving && onClose()}>
      <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Configuración — {consortiumName}</h3>
        <p className={styles.modalSubtitle}>Ajustes de matching y datos internos del consorcio</p>

        {/* ── Acordeón: una sola sección abierta a la vez ── */}
        <div className={styles.configSection}>
          <button
            type="button"
            className={styles.lspToggle}
            onClick={() => onToggleSection("matchNames")}
            aria-expanded={openSection === "matchNames"}
          >
            <span className={styles.lspToggleChevron} aria-hidden="true">{openSection === "matchNames" ? "▾" : "▸"}</span>
            <span className={styles.lspTitle}>Nombres alternativos (matching interno)</span>
          </button>
          {openSection === "matchNames" && (
            <div className={styles.lspContent}>
              <p className={styles.configSectionDesc}>
                Separar con | (pipe). Estos nombres se usan internamente para identificar el consorcio en facturas.
              </p>
              {!matchNames.editing ? (
                <>
                  <p className={styles.matchNamesValue}>
                    {matchNames.value || <span style={{ opacity: 0.4 }}>Sin nombres alternativos</span>}
                  </p>
                  <div className={styles.matchNamesActions} style={{ marginTop: 8 }}>
                    <button type="button" className={styles.matchNamesEditBtn} onClick={matchNames.onStartEdit}>Editar</button>
                  </div>
                </>
              ) : (
                <div className={styles.matchNamesEdit}>
                  <input
                    className={styles.formInput}
                    value={matchNames.value}
                    onChange={(e) => matchNames.onChangeValue(e.target.value)}
                    placeholder="NOMBRE ALT 1|NOMBRE ALT 2|NOMBRE ALT 3"
                  />
                  <div className={styles.matchNamesActions}>
                    <button type="button" className={styles.ghostBtn} onClick={matchNames.onCancelEdit} disabled={saving}>Cancelar</button>
                    <button type="button" className={styles.addInvoiceBtn} onClick={matchNames.onSave} disabled={saving}>
                      {saving ? "Guardando..." : "Guardar"}
                    </button>
                  </div>
                </div>
              )}
              {matchNames.msg && <p className={styles.infoMsg} style={{ marginTop: 6 }}>{matchNames.msg}</p>}
            </div>
          )}
        </div>

        <div className={styles.configSection}>
          <button
            type="button"
            className={styles.lspToggle}
            onClick={() => onToggleSection("bank")}
            aria-expanded={openSection === "bank"}
          >
            <span className={styles.lspToggleChevron} aria-hidden="true">{openSection === "bank" ? "▾" : "▸"}</span>
            <span className={styles.lspTitle}>Banco y cuenta</span>
          </button>
          {openSection === "bank" && (
            <div className={styles.lspContent}>
              <p className={styles.configSectionDesc}>
                Banco donde cobra el consorcio y datos de su cuenta (bloque FORMA DE PAGO).
              </p>
              <div className={styles.providerFormGrid}>
                <div className={`${styles.formField} ${styles.formFieldFull}`}>
                  <label>Banco</label>
                  <select
                    className={styles.formSelect}
                    value={bank.form.bankId}
                    onChange={(e) => bank.onChangeForm({ bankId: e.target.value })}
                  >
                    <option value="">— Sin banco —</option>
                    {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div className={styles.formField}>
                  <label>Alias</label>
                  <input className={styles.formInput} value={bank.form.bankAlias} onChange={(e) => bank.onChangeForm({ bankAlias: e.target.value })} placeholder="BROWN.706.CONS" />
                </div>
                <div className={styles.formField}>
                  <label>CBU</label>
                  <input className={styles.formInput} value={bank.form.cbu} onChange={(e) => bank.onChangeForm({ cbu: e.target.value })} placeholder="0720500220000000294986" />
                </div>
                <div className={styles.formField}>
                  <label>Nº de cuenta</label>
                  <input className={styles.formInput} value={bank.form.accountNumber} onChange={(e) => bank.onChangeForm({ accountNumber: e.target.value })} placeholder="500-002949/8" />
                </div>
                <div className={styles.formField}>
                  <label>Sucursal</label>
                  <input className={styles.formInput} value={bank.form.branch} onChange={(e) => bank.onChangeForm({ branch: e.target.value })} placeholder="016" />
                </div>
                <div className={styles.formField}>
                  <label>Tipo de cuenta</label>
                  <input className={styles.formInput} list="accountTypes" value={bank.form.accountType} onChange={(e) => bank.onChangeForm({ accountType: e.target.value })} placeholder="Cuenta Corriente" />
                  <datalist id="accountTypes">
                    <option value="Cuenta Corriente" />
                    <option value="Caja de Ahorro" />
                  </datalist>
                </div>
                <div className={`${styles.formField} ${styles.formFieldFull}`}>
                  <label>Titular</label>
                  <input className={styles.formInput} value={bank.form.accountHolder} onChange={(e) => bank.onChangeForm({ accountHolder: e.target.value })} placeholder="Consorcio de Propietarios A. Brown 706" />
                </div>
              </div>
              <div className={styles.matchNamesActions}>
                <AsyncButton type="button" className={styles.addInvoiceBtn} onClick={bank.onSave} pendingLabel="Guardando…">
                  Guardar
                </AsyncButton>
              </div>
              {bank.msg && <p className={styles.infoMsg} style={{ marginTop: 6 }}>{bank.msg}</p>}
            </div>
          )}
        </div>

        <div className={styles.configSection}>
          <button
            type="button"
            className={styles.lspToggle}
            onClick={() => onToggleSection("lsp")}
            aria-expanded={openSection === "lsp"}
          >
            <span className={styles.lspToggleChevron} aria-hidden="true">{openSection === "lsp" ? "▾" : "▸"}</span>
            <span className={styles.lspTitle}>Servicios públicos (LSP)</span>
            {lsp.services.length > 0 && <span className={styles.lspToggleCount}>{lsp.services.length}</span>}
          </button>
          {openSection === "lsp" && (
            <div className={styles.lspContent}>
              {lsp.services.length > 0 ? (
                <div className={styles.lspTableWrap}>
                  <table className={styles.lspTable}>
                    <thead>
                      <tr><th>Empresa</th><th>Nro. Cliente</th><th>Descripción</th><th>Acciones</th></tr>
                    </thead>
                    <tbody>
                      {lsp.services.map((s) => (
                        <tr key={s.id}>
                          <td>{LSP_PROVIDERS.find((p) => p.value === s.providerName)?.label ?? s.providerName}</td>
                          <td className={styles.tdMono}>{s.clientNumber}</td>
                          <td>{s.description ?? "—"}</td>
                          <td>
                            {lsp.confirmDeleteId === s.id ? (
                              <span className={styles.lspConfirmDelete}>
                                ¿Confirmar?{" "}
                                <AsyncButton type="button" className={styles.lspConfirmYes} onClick={() => lsp.onDelete(s.id)} pendingLabel="…">Sí</AsyncButton>
                                <button type="button" className={styles.lspConfirmNo} onClick={() => lsp.onConfirmDelete(null)}>No</button>
                              </span>
                            ) : (
                              <button type="button" className={styles.lspDeleteBtn} onClick={() => lsp.onConfirmDelete(s.id)}>Eliminar</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={styles.lspEmpty}>No hay servicios públicos cargados para este consorcio.</p>
              )}
              <div className={styles.lspAddForm}>
                <select className={styles.formSelect} value={lsp.form.provider} onChange={(e) => lsp.onChangeForm({ provider: e.target.value })}>
                  <option value="">Empresa...</option>
                  {LSP_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
                <input className={styles.formInput} value={lsp.form.clientNumber} onChange={(e) => lsp.onChangeForm({ clientNumber: e.target.value })} placeholder="Nro. de cliente" />
                <input className={styles.formInput} value={lsp.form.description} onChange={(e) => lsp.onChangeForm({ description: e.target.value })} placeholder="Descripción (opcional)" />
                <AsyncButton type="button" className={styles.addInvoiceBtn} onClick={lsp.onAdd} pendingLabel="Agregando…">Agregar</AsyncButton>
              </div>
              {lsp.error && <p className={styles.errorMsg}>{lsp.error}</p>}
            </div>
          )}
        </div>

        <div className={styles.configSection}>
          <button
            type="button"
            className={styles.lspToggle}
            onClick={() => onToggleSection("fixed")}
            aria-expanded={openSection === "fixed"}
          >
            <span className={styles.lspToggleChevron} aria-hidden="true">{openSection === "fixed" ? "▾" : "▸"}</span>
            <span className={styles.lspTitle}>Gastos fijos</span>
            {fixed.list.length > 0 && <span className={styles.lspToggleCount}>{fixed.list.length}</span>}
          </button>
          {openSection === "fixed" && (
            <div className={styles.lspContent}>
              {fixed.list.length > 0 ? (
                <div className={styles.lspTableWrap}>
                  <table className={styles.lspTable}>
                    <thead>
                      <tr><th>Gasto fijo</th><th>Estado</th><th>Acciones</th></tr>
                    </thead>
                    <tbody>
                      {fixed.list.map((fx) => {
                        const lspService = lsp.services.find((l) => l.id === fx.lspServiceId);
                        const prov = providers.find((p) => p.id === fx.providerId);
                        const label = lspService
                          ? `${LSP_PROVIDERS.find((p) => p.value === lspService.providerName)?.label ?? lspService.providerName} (${lspService.clientNumber})`
                          : prov?.canonicalName ?? fx.description ?? "—";
                        return (
                          <tr key={fx.id}>
                            <td>{label}</td>
                            <td>{fx.active ? "Activo" : "Inactivo"}</td>
                            <td>
                              <AsyncButton type="button" className={styles.ghostBtn} style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => fixed.onToggle(fx)}>
                                {fx.active ? "Desactivar" : "Activar"}
                              </AsyncButton>{" "}
                              <AsyncButton type="button" className={styles.lspDeleteBtn} onClick={() => fixed.onDelete(fx.id)} pendingLabel="…">Quitar</AsyncButton>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={styles.lspEmpty}>No hay gastos fijos cargados para este consorcio.</p>
              )}
              <div className={styles.lspAddForm}>
                <select className={styles.formSelect} value={fixed.target} onChange={(e) => fixed.onChangeTarget(e.target.value)}>
                  <option value="">Elegir proveedor o servicio...</option>
                  {providers.length > 0 && (
                    <optgroup label="Proveedores">
                      {providers.map((p) => <option key={`p-${p.id}`} value={`provider:${p.id}`}>{p.canonicalName}</option>)}
                    </optgroup>
                  )}
                  {lsp.services.length > 0 && (
                    <optgroup label="Servicios (LSP)">
                      {lsp.services.map((l) => (
                        <option key={`l-${l.id}`} value={`lsp:${l.id}`}>
                          {LSP_PROVIDERS.find((p) => p.value === l.providerName)?.label ?? l.providerName} ({l.clientNumber})
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <AsyncButton type="button" className={styles.addInvoiceBtn} onClick={fixed.onAdd} disabled={!fixed.target} pendingLabel="Agregando…">Agregar</AsyncButton>
              </div>
              {fixed.error && <p className={styles.errorMsg}>{fixed.error}</p>}
            </div>
          )}
        </div>

        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
