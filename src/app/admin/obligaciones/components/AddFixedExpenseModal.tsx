"use client";

import { useMemo, useState } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { availableTargets, type TargetOption } from "../lib/availableTargets";
import type { OverviewConsortium, OverviewPayload } from "../lib/sheetModel";

type Props = {
  consortium: OverviewConsortium;
  providers: OverviewPayload["providers"];
  onAdd: (consortiumId: string, targets: TargetOption[]) => Promise<void>;
  onClose: () => void;
};

/**
 * Alta múltiple de gastos fijos para un edificio.
 *
 * Lo ya cargado no aparece en la lista: es la primera defensa contra el
 * duplicado (la segunda es el índice único de la base).
 */
export function AddFixedExpenseModal({ consortium, providers, onAdd, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Map<string, TargetOption>>(new Map());

  const options = useMemo(
    () => availableTargets(consortium, providers, query),
    [consortium, providers, query]
  );
  const nothingLeft = options.lsp.length === 0 && options.providers.length === 0 && query === "";

  const toggle = (option: TargetOption) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const key = `${option.kind}:${option.id}`;
      if (next.has(key)) next.delete(key);
      else next.set(key, option);
      return next;
    });
  };

  // El guard anti doble-click y el estado `pending` los pone `AsyncButton`.
  const submit = async () => {
    if (selected.size === 0) return;
    await onAdd(consortium.consortiumId, [...selected.values()]);
    onClose();
  };

  const renderOption = (option: TargetOption) => {
    const key = `${option.kind}:${option.id}`;
    return (
      <li key={key} className={styles.targetItem}>
        <label className={styles.targetLabel}>
          <input
            type="checkbox"
            checked={selected.has(key)}
            onChange={() => toggle(option)}
          />
          <span>{option.label}</span>
        </label>
      </li>
    );
  };

  return (
    <div className={styles.modalOverlay} role="dialog" aria-modal="true">
      <div className={styles.modalCard}>
        <h2 className={styles.modalTitle}>Agregar gastos fijos</h2>
        <p className={styles.modalSubtitle}>{consortium.consortiumName}</p>

        {nothingLeft ? (
          <p className={styles.emptyNote}>
            Ya están cargados todos los proveedores y servicios disponibles para este edificio.
          </p>
        ) : (
          <>
            <input
              className={styles.searchInput}
              placeholder="Buscar proveedor o servicio..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className={styles.targetList}>
              {options.lsp.length > 0 && (
                <>
                  <h3 className={styles.targetGroupTitle}>Servicios (LSP)</h3>
                  <ul className={styles.targetGroup}>{options.lsp.map(renderOption)}</ul>
                </>
              )}
              {options.providers.length > 0 && (
                <>
                  <h3 className={styles.targetGroupTitle}>Proveedores</h3>
                  <ul className={styles.targetGroup}>{options.providers.map(renderOption)}</ul>
                </>
              )}
              {options.lsp.length === 0 && options.providers.length === 0 && (
                <p className={styles.emptyNote}>Nada coincide con la búsqueda.</p>
              )}
            </div>
          </>
        )}

        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>
            Cancelar
          </button>
          <AsyncButton
            type="button"
            className={styles.primaryBtn}
            disabled={selected.size === 0}
            pendingLabel="Agregando…"
            onClick={submit}
          >
            {`Agregar (${selected.size})`}
          </AsyncButton>
        </div>
      </div>
    </div>
  );
}
