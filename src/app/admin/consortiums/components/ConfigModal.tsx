import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { LSP_PROVIDERS } from "../lib/constants";
import type {
  Bank, BankAccountForm, Coeficiente, ConfigSection, FixedExpenseRow, LspForm, LspService, Rubro,
} from "../lib/types";

type Props = {
  consortiumName: string;
  saving: boolean;
  openSection: ConfigSection | null;
  onToggleSection: (section: ConfigSection) => void;
  onClose: () => void;
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
  /**
   * Capa 2 del spec 2026-09-24: del catálogo del cliente, cuáles usa este edificio.
   * `rubros` / `coeficientes` son el catálogo completo; los `*Ids`, lo asignado.
   */
  catalogos: {
    rubros: Rubro[];
    coeficientes: Coeficiente[];
    rubroIds: string[];
    coeficienteIds: string[];
    msg: string | null;
    /** Si está puesto, el guardado va a desetiquetar gastos fijos y espera el sí. */
    confirmMsg: string | null;
    onToggleRubro: (id: string) => void;
    onToggleCoeficiente: (id: string) => void;
    onSave: () => void;
    onSaveConfirmed: () => void;
    onCancelConfirm: () => void;
  };
  /** Solo lectura: los gastos fijos se administran en /admin/obligaciones. */
  fixed: {
    list: FixedExpenseRow[];
  };
};

export function ConfigModal({
  consortiumName, saving, openSection, onToggleSection, onClose, banks, bank, matchNames, catalogos, lsp, fixed,
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

        {/* Capa 2 de rubros y coeficientes: del catálogo del cliente, cuáles usa
            este edificio. Es lo que después habilita etiquetar sus gastos fijos. */}
        <div className={styles.configSection}>
          <button
            type="button"
            className={styles.lspToggle}
            onClick={() => onToggleSection("catalogos")}
            aria-expanded={openSection === "catalogos"}
          >
            <span className={styles.lspToggleChevron} aria-hidden="true">{openSection === "catalogos" ? "▾" : "▸"}</span>
            <span className={styles.lspTitle}>Rubros y coeficientes</span>
          </button>
          {openSection === "catalogos" && (
            <div className={styles.lspContent}>
              <p className={styles.configSectionDesc}>
                Del catálogo del cliente, cuáles usa este edificio. Un edificio sin empleado propio
                no tiene el rubro 1: su liquidación arranca en el 2.
              </p>

              <h5 className={styles.lspTitle}>Rubros</h5>
              {catalogos.rubros.length > 0 ? (
                <div className={styles.checkboxList}>
                  {catalogos.rubros.map((r) => (
                    <label key={r.id} className={styles.checkboxRow}>
                      <input
                        type="checkbox"
                        checked={catalogos.rubroIds.includes(r.id)}
                        onChange={() => catalogos.onToggleRubro(r.id)}
                      />
                      <span>{r.order != null ? `${r.order} ` : ""}{r.name}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className={styles.lspEmpty}>
                  No hay rubros en el catálogo. Se cargan desde Rubros y coeficientes, en el menú.
                </p>
              )}

              <h5 className={styles.lspTitle}>Coeficientes</h5>
              {catalogos.coeficientes.length > 0 ? (
                <div className={styles.checkboxList}>
                  {catalogos.coeficientes.map((c) => (
                    <label key={c.id} className={styles.checkboxRow}>
                      <input
                        type="checkbox"
                        checked={catalogos.coeficienteIds.includes(c.id)}
                        onChange={() => catalogos.onToggleCoeficiente(c.id)}
                      />
                      <span>{c.code} — {c.name}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className={styles.lspEmpty}>
                  No hay coeficientes en el catálogo. Se cargan desde Rubros y coeficientes, en el menú.
                </p>
              )}

              <div className={styles.matchNamesActions}>
                {catalogos.confirmMsg ? (
                  <span className={styles.lspConfirmDelete}>
                    {catalogos.confirmMsg}{" "}
                    <AsyncButton
                      type="button"
                      className={styles.lspConfirmYes}
                      onClick={catalogos.onSaveConfirmed}
                      pendingLabel="Guardando…"
                    >
                      Guardar igual
                    </AsyncButton>
                    <button type="button" className={styles.lspConfirmNo} onClick={catalogos.onCancelConfirm}>
                      Cancelar
                    </button>
                  </span>
                ) : (
                  <AsyncButton type="button" className={styles.addInvoiceBtn} onClick={catalogos.onSave} pendingLabel="Guardando…">
                    Guardar
                  </AsyncButton>
                )}
              </div>
              {catalogos.msg && <p className={styles.infoMsg} style={{ marginTop: 6 }}>{catalogos.msg}</p>}
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
              <p className={styles.lspEmpty}>
                {fixed.list.length === 0
                  ? "No hay gastos fijos cargados para este consorcio."
                  : `${fixed.list.filter((fx) => fx.active).length} gasto(s) fijo(s) activo(s) de ${fixed.list.length}.`}
              </p>
              <p className={styles.lspEmpty}>
                Los gastos fijos se administran desde la vista de{" "}
                <a href="/admin/obligaciones" className={styles.linkInline}>Obligaciones</a>, donde se
                ven todos los edificios juntos.
              </p>
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
