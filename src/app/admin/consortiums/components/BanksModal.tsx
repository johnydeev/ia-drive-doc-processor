import { useEffect, useState } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { BANK_COLORS } from "../lib/bankPalette";
import type { Bank } from "../lib/types";
import type { BankFormValues } from "../hooks/useBanks";

type Props = {
  banks: Bank[];
  form: BankFormValues;
  error: string | null;
  confirmDeleteId: string | null;
  editingId: string | null;
  onChangeForm: (patch: Partial<BankFormValues>) => void;
  onCreate: () => void;
  onUpdate: (id: string, patch: BankFormValues) => void;
  onDelete: (id: string) => void;
  onConfirmDelete: (id: string | null) => void;
  onEdit: (id: string | null) => void;
  onClose: () => void;
};

/**
 * ABM del catálogo de bancos del cliente. Presentacional: el estado vive en `useBanks`.
 * La asignación de un banco a un consorcio se hace desde su modal de Configuración.
 */
export function BanksModal({
  banks, form, error, confirmDeleteId, editingId,
  onChangeForm, onCreate, onUpdate, onDelete, onConfirmDelete, onEdit, onClose,
}: Props) {
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Bancos</h3>
        <p className={styles.modalSubtitle}>
          Catálogo del cliente. Cada consorcio se asigna a un banco desde su Configuración.
        </p>

        {banks.length > 0 ? (
          <div className={styles.lspTableWrap}>
            <table className={styles.lspTable}>
              <thead>
                <tr><th>Banco</th><th>Edificios</th><th>Acciones</th></tr>
              </thead>
              <tbody>
                {banks.map((b) => (
                  <BankRow
                    key={b.id}
                    bank={b}
                    isEditing={editingId === b.id}
                    isConfirmingDelete={confirmDeleteId === b.id}
                    onUpdate={onUpdate}
                    onDelete={onDelete}
                    onConfirmDelete={onConfirmDelete}
                    onEdit={onEdit}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.lspEmpty}>No hay bancos cargados.</p>
        )}

        <div className={styles.lspAddForm}>
          <input
            className={styles.formInput}
            value={form.name}
            onChange={(e) => onChangeForm({ name: e.target.value })}
            placeholder="Nombre del banco"
            aria-label="Nombre del banco nuevo"
          />
          <select
            className={styles.formSelect}
            value={form.color}
            onChange={(e) => onChangeForm({ color: e.target.value })}
            aria-label="Color del banco nuevo"
          >
            {BANK_COLORS.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
          </select>
          <AsyncButton type="button" className={styles.addInvoiceBtn} onClick={onCreate} pendingLabel="Agregando…">
            Agregar
          </AsyncButton>
        </div>
        {error && <p className={styles.errorMsg}>{error}</p>}

        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}

type RowProps = {
  bank: Bank;
  isEditing: boolean;
  isConfirmingDelete: boolean;
  onUpdate: (id: string, patch: BankFormValues) => void;
  onDelete: (id: string) => void;
  onConfirmDelete: (id: string | null) => void;
  onEdit: (id: string | null) => void;
};

/**
 * Fila del catálogo. El borrador del renombre es estado local: si se cancela, no
 * tiene que haber ensuciado el catálogo de arriba.
 */
function BankRow({ bank, isEditing, isConfirmingDelete, onUpdate, onDelete, onConfirmDelete, onEdit }: RowProps) {
  const [draft, setDraft] = useState<BankFormValues>({ name: bank.name, color: bank.color });
  const count = bank._count?.consortiums ?? 0;

  // Al entrar en edición el borrador arranca de los valores actuales de la fila.
  useEffect(() => {
    if (isEditing) setDraft({ name: bank.name, color: bank.color });
  }, [isEditing, bank.name, bank.color]);

  if (isEditing) {
    return (
      <tr>
        <td>
          <input
            className={styles.formInput}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            aria-label="Nombre del banco"
          />
        </td>
        <td>
          <select
            className={styles.formSelect}
            value={draft.color}
            onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
            aria-label="Color"
          >
            {BANK_COLORS.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
          </select>
        </td>
        <td>
          <AsyncButton type="button" className={styles.addInvoiceBtn} onClick={() => onUpdate(bank.id, draft)} pendingLabel="Guardando…">
            Guardar
          </AsyncButton>{" "}
          <button type="button" className={styles.ghostBtn} onClick={() => onEdit(null)}>Cancelar</button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>
        <span className={styles.bankDot} data-bank-color={bank.color} aria-hidden="true" />
        {bank.name}
      </td>
      <td>{count > 0 ? `${count} edificios` : "Sin edificios"}</td>
      <td>
        {isConfirmingDelete ? (
          <span className={styles.lspConfirmDelete}>
            {count > 0 ? `${count} edificios quedarán sin banco. ¿Confirmar?` : "¿Confirmar?"}{" "}
            <AsyncButton type="button" className={styles.lspConfirmYes} onClick={() => onDelete(bank.id)} pendingLabel="…">Sí</AsyncButton>
            <button type="button" className={styles.lspConfirmNo} onClick={() => onConfirmDelete(null)}>No</button>
          </span>
        ) : (
          <>
            <button type="button" className={styles.matchNamesEditBtn} onClick={() => onEdit(bank.id)}>Editar</button>{" "}
            <button type="button" className={styles.lspDeleteBtn} onClick={() => onConfirmDelete(bank.id)}>Eliminar</button>
          </>
        )}
      </td>
    </tr>
  );
}
