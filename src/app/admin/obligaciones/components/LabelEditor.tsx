"use client";

import { useState } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { rubroTitle, type CoefColumn, type RubroInfo } from "../lib/sheetModel";

export type Labels = { rubroId: string | null; coeficienteId: string | null };
/** Qué se escribe: gasto fijo + boleta del mes, o sólo la boleta (eventual). */
export type LabelTarget = { fixedExpenseId?: string; invoiceId?: string };

type Props = {
  rubros: RubroInfo[];
  coefColumns: CoefColumn[];
  value: Labels;
  /** Nombre de la fila, para los rótulos accesibles. */
  concepto: string;
  onSave: (labels: Labels) => void | Promise<void>;
};

/**
 * Rubro y coeficiente de una fila de la hoja (spec 2026-09-24, "Edición inline").
 * Cerrado muestra "R-3 · C-A" (R = rubro, C = coeficiente; "sin rubro" / "sin coef." si le falta; marcado en ámbar
 * cuando el edificio usa coeficientes y a la fila le falta uno); abierto, dos listas con
 * lo que el EDIFICIO tiene asignado. Guardar escribe boleta y gasto fijo (lo decide
 * el llamador con el `target`).
 */
export function LabelEditor({ rubros, coefColumns, value, concepto, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [rubroId, setRubroId] = useState(value.rubroId ?? "");
  const [coeficienteId, setCoeficienteId] = useState(value.coeficienteId ?? "");
  // Estado propio de "guardando": deshabilita Cancelar mientras el AsyncButton de
  // Guardar hace su propia cosa (spinner + disabled). Mismo hook, otra instancia.
  const { pending: saving, run } = useAsyncAction();

  const rubro = rubros.find((r) => r.id === value.rubroId);
  const coef = coefColumns.find((c) => c.id !== null && c.id === value.coeficienteId);
  const coefs = coefColumns.filter((c): c is { id: string; code: string } => c.id !== null);

  if (!editing) {
    return (
      <button
        type="button"
        className={!coef && coefs.length > 0 ? `${styles.labelBtn} ${styles.labelBtnMissing}` : styles.labelBtn}
        aria-label={`Rubro y coeficiente de ${concepto}`}
        title={rubro ? rubro.name : "Sin rubro"}
        onClick={() => {
          // Sólo se re-propone un id si sigue existiendo en las listas del edificio:
          // un rubro/coeficiente borrado no se reenvía en silencio al guardar.
          setRubroId(rubros.some((r) => r.id === value.rubroId) ? (value.rubroId as string) : "");
          setCoeficienteId(coefs.some((c) => c.id === value.coeficienteId) ? (value.coeficienteId as string) : "");
          setEditing(true);
        }}
      >
        {rubro ? `R-${rubro.order ?? rubro.name}` : "sin rubro"} · {coef ? `C-${coef.code}` : "sin coef."}
      </button>
    );
  }

  return (
    <span className={styles.labelEditor}>
      <select className={styles.labelSelect} aria-label={`Rubro de ${concepto}`} value={rubroId} onChange={(e) => setRubroId(e.target.value)}>
        <option value="">Sin rubro</option>
        {rubros.map((r) => (
          <option key={r.id} value={r.id}>{rubroTitle(r)}</option>
        ))}
      </select>
      <select className={`${styles.labelSelect} ${styles.labelSelectCoef}`} aria-label={`Coeficiente de ${concepto}`} value={coeficienteId} onChange={(e) => setCoeficienteId(e.target.value)}>
        <option value="">Sin coef.</option>
        {coefs.map((c) => (<option key={c.id} value={c.id}>{c.code}</option>))}
      </select>
      <AsyncButton
        type="button"
        className={styles.labelSaveBtn}
        pendingLabel="Guardando…"
        onClick={() =>
          run(async () => {
            await onSave({ rubroId: rubroId || null, coeficienteId: coeficienteId || null });
            setEditing(false);
          })
        }
      >
        Guardar
      </AsyncButton>
      <button type="button" className={styles.actionBtn} disabled={saving} onClick={() => setEditing(false)}>
        Cancelar
      </button>
    </span>
  );
}
