import { useEffect, useState } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import type { Coeficiente, Rubro } from "../lib/types";
import type { CoeficienteFormValues, RubroFormValues } from "../hooks/useCatalogos";

type Props = {
  rubros: Rubro[];
  coeficientes: Coeficiente[];
  rubroForm: RubroFormValues;
  coeficienteForm: CoeficienteFormValues;
  error: string | null;
  confirmDeleteRubroId: string | null;
  confirmDeleteCoefId: string | null;
  editingRubroId: string | null;
  editingCoefId: string | null;
  onChangeRubroForm: (patch: Partial<RubroFormValues>) => void;
  onChangeCoeficienteForm: (patch: Partial<CoeficienteFormValues>) => void;
  onCreateRubro: () => void;
  onCreateCoeficiente: () => void;
  onUpdateRubro: (id: string, patch: RubroFormValues) => void;
  onUpdateCoeficiente: (id: string, patch: CoeficienteFormValues) => void;
  onRemoveRubro: (id: string) => void;
  onRemoveCoeficiente: (id: string) => void;
  onConfirmDeleteRubro: (id: string | null) => void;
  onConfirmDeleteCoef: (id: string | null) => void;
  onEditRubro: (id: string | null) => void;
  onEditCoef: (id: string | null) => void;
  onClose: () => void;
};

/**
 * ABM del catálogo de rubros y coeficientes del cliente (capa 1 del spec
 * 2026-09-24). Presentacional: el estado vive en `useCatalogos`.
 *
 * Qué usa cada edificio se marca en su modal de Configuración; qué lleva cada gasto
 * fijo, en la hoja de Obligaciones.
 */
export function CatalogosModal({
  rubros, coeficientes, rubroForm, coeficienteForm, error,
  confirmDeleteRubroId, confirmDeleteCoefId, editingRubroId, editingCoefId,
  onChangeRubroForm, onChangeCoeficienteForm,
  onCreateRubro, onCreateCoeficiente,
  onUpdateRubro, onUpdateCoeficiente,
  onRemoveRubro, onRemoveCoeficiente,
  onConfirmDeleteRubro, onConfirmDeleteCoef,
  onEditRubro, onEditCoef,
  onClose,
}: Props) {
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Rubros y coeficientes</h3>
        <p className={styles.modalSubtitle}>
          Catálogo del cliente. A cada edificio se le asignan los que usa desde su Configuración.
        </p>

        <h4 className={styles.lspTitle}>Rubros</h4>
        <p className={styles.configSectionDesc}>
          El número es la sección de la liquidación (3 SERVICIOS PÚBLICOS). Los rubros sin número
          van al final.
        </p>
        {rubros.length > 0 ? (
          <div className={styles.lspTableWrap}>
            <table className={styles.lspTable}>
              <thead>
                <tr><th>#</th><th>Rubro</th><th>Acciones</th></tr>
              </thead>
              <tbody>
                {rubros.map((r) => (
                  <RubroRow
                    key={r.id}
                    rubro={r}
                    isEditing={editingRubroId === r.id}
                    isConfirmingDelete={confirmDeleteRubroId === r.id}
                    onUpdate={onUpdateRubro}
                    onRemove={onRemoveRubro}
                    onConfirmDelete={onConfirmDeleteRubro}
                    onEdit={onEditRubro}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.lspEmpty}>No hay rubros cargados.</p>
        )}

        <div className={styles.lspAddForm}>
          <input
            className={styles.formInput}
            value={rubroForm.order}
            onChange={(e) => onChangeRubroForm({ order: e.target.value })}
            placeholder="Nº"
            inputMode="numeric"
            aria-label="Número del rubro nuevo"
          />
          <input
            className={styles.formInput}
            value={rubroForm.name}
            onChange={(e) => onChangeRubroForm({ name: e.target.value })}
            placeholder="Nombre del rubro"
            aria-label="Nombre del rubro nuevo"
          />
          <AsyncButton
            type="button"
            className={styles.addInvoiceBtn}
            onClick={onCreateRubro}
            pendingLabel="Agregando…"
          >
            Agregar rubro
          </AsyncButton>
        </div>

        <h4 className={styles.lspTitle}>Coeficientes</h4>
        <p className={styles.configSectionDesc}>
          El código es la columna donde se escribe el importe del gasto (A, B, C).
        </p>
        {coeficientes.length > 0 ? (
          <div className={styles.lspTableWrap}>
            <table className={styles.lspTable}>
              <thead>
                <tr><th>Código</th><th>Nombre</th><th>Acciones</th></tr>
              </thead>
              <tbody>
                {coeficientes.map((c) => (
                  <CoeficienteRow
                    key={c.id}
                    coeficiente={c}
                    isEditing={editingCoefId === c.id}
                    isConfirmingDelete={confirmDeleteCoefId === c.id}
                    onUpdate={onUpdateCoeficiente}
                    onRemove={onRemoveCoeficiente}
                    onConfirmDelete={onConfirmDeleteCoef}
                    onEdit={onEditCoef}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.lspEmpty}>No hay coeficientes cargados.</p>
        )}

        <div className={styles.lspAddForm}>
          <input
            className={styles.formInput}
            value={coeficienteForm.code}
            onChange={(e) => onChangeCoeficienteForm({ code: e.target.value })}
            placeholder="Código"
            aria-label="Código del coeficiente nuevo"
          />
          <input
            className={styles.formInput}
            value={coeficienteForm.name}
            onChange={(e) => onChangeCoeficienteForm({ name: e.target.value })}
            placeholder="Nombre del coeficiente"
            aria-label="Nombre del coeficiente nuevo"
          />
          <AsyncButton
            type="button"
            className={styles.addInvoiceBtn}
            onClick={onCreateCoeficiente}
            pendingLabel="Agregando…"
          >
            Agregar coeficiente
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

type RubroRowProps = {
  rubro: Rubro;
  isEditing: boolean;
  isConfirmingDelete: boolean;
  onUpdate: (id: string, patch: RubroFormValues) => void;
  onRemove: (id: string) => void;
  onConfirmDelete: (id: string | null) => void;
  onEdit: (id: string | null) => void;
};

/**
 * Fila del catálogo de rubros. El borrador de la edición es estado local: si se
 * cancela, no tiene que haber ensuciado el catálogo de arriba (mismo criterio que
 * `BankRow`).
 */
function RubroRow({ rubro, isEditing, isConfirmingDelete, onUpdate, onRemove, onConfirmDelete, onEdit }: RubroRowProps) {
  const [draft, setDraft] = useState<RubroFormValues>({
    name: rubro.name,
    order: rubro.order != null ? String(rubro.order) : "",
  });

  useEffect(() => {
    if (isEditing) setDraft({ name: rubro.name, order: rubro.order != null ? String(rubro.order) : "" });
  }, [isEditing, rubro.name, rubro.order]);

  if (isEditing) {
    return (
      <tr>
        <td>
          <input
            className={styles.formInput}
            value={draft.order}
            onChange={(e) => setDraft((d) => ({ ...d, order: e.target.value }))}
            inputMode="numeric"
            aria-label="Número del rubro"
          />
        </td>
        <td>
          <input
            className={styles.formInput}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            aria-label="Nombre del rubro"
          />
        </td>
        <td>
          <AsyncButton
            type="button"
            className={styles.addInvoiceBtn}
            onClick={() => onUpdate(rubro.id, draft)}
            pendingLabel="Guardando…"
          >
            Guardar
          </AsyncButton>{" "}
          <button type="button" className={styles.ghostBtn} onClick={() => onEdit(null)}>Cancelar</button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className={styles.tdMono}>{rubro.order != null ? rubro.order : ""}</td>
      <td>{rubro.name}</td>
      <td>
        {isConfirmingDelete ? (
          <span className={styles.lspConfirmDelete}>
            Los gastos fijos que lo usen quedarán sin rubro. ¿Confirmar?{" "}
            <AsyncButton
              type="button"
              className={styles.lspConfirmYes}
              onClick={() => onRemove(rubro.id)}
              pendingLabel="…"
            >
              Sí
            </AsyncButton>
            <button type="button" className={styles.lspConfirmNo} onClick={() => onConfirmDelete(null)}>No</button>
          </span>
        ) : (
          <>
            <button type="button" className={styles.matchNamesEditBtn} onClick={() => onEdit(rubro.id)}>Editar</button>{" "}
            <button type="button" className={styles.lspDeleteBtn} onClick={() => onConfirmDelete(rubro.id)}>Eliminar</button>
          </>
        )}
      </td>
    </tr>
  );
}

type CoefRowProps = {
  coeficiente: Coeficiente;
  isEditing: boolean;
  isConfirmingDelete: boolean;
  onUpdate: (id: string, patch: CoeficienteFormValues) => void;
  onRemove: (id: string) => void;
  onConfirmDelete: (id: string | null) => void;
  onEdit: (id: string | null) => void;
};

function CoeficienteRow({ coeficiente, isEditing, isConfirmingDelete, onUpdate, onRemove, onConfirmDelete, onEdit }: CoefRowProps) {
  const [draft, setDraft] = useState<CoeficienteFormValues>({
    code: coeficiente.code,
    name: coeficiente.name,
  });

  useEffect(() => {
    if (isEditing) setDraft({ code: coeficiente.code, name: coeficiente.name });
  }, [isEditing, coeficiente.code, coeficiente.name]);

  if (isEditing) {
    return (
      <tr>
        <td>
          <input
            className={styles.formInput}
            value={draft.code}
            onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))}
            aria-label="Código del coeficiente"
          />
        </td>
        <td>
          <input
            className={styles.formInput}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            aria-label="Nombre del coeficiente"
          />
        </td>
        <td>
          <AsyncButton
            type="button"
            className={styles.addInvoiceBtn}
            onClick={() => onUpdate(coeficiente.id, draft)}
            pendingLabel="Guardando…"
          >
            Guardar
          </AsyncButton>{" "}
          <button type="button" className={styles.ghostBtn} onClick={() => onEdit(null)}>Cancelar</button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className={styles.tdMono}>{coeficiente.code}</td>
      <td>{coeficiente.name}</td>
      <td>
        {isConfirmingDelete ? (
          <span className={styles.lspConfirmDelete}>
            Los gastos fijos que lo usen quedarán sin coeficiente. ¿Confirmar?{" "}
            <AsyncButton
              type="button"
              className={styles.lspConfirmYes}
              onClick={() => onRemove(coeficiente.id)}
              pendingLabel="…"
            >
              Sí
            </AsyncButton>
            <button type="button" className={styles.lspConfirmNo} onClick={() => onConfirmDelete(null)}>No</button>
          </span>
        ) : (
          <>
            <button type="button" className={styles.matchNamesEditBtn} onClick={() => onEdit(coeficiente.id)}>Editar</button>{" "}
            <button type="button" className={styles.lspDeleteBtn} onClick={() => onConfirmDelete(coeficiente.id)}>Eliminar</button>
          </>
        )}
      </td>
    </tr>
  );
}
