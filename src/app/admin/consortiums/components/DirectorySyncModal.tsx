"use client";

import { useState } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import type { DirectorySyncReport, SyncEntityReport } from "../lib/types";

type Props = {
  report: DirectorySyncReport;
  onClose: () => void;
  onApplyRenames: (renames: Array<{ entity: "consortium" | "provider"; id: string; to: string }>) => Promise<void>;
};

const ETIQUETAS: Array<[keyof DirectorySyncReport, string]> = [
  ["consortiums", "Edificios"],
  ["providers", "Proveedores"],
  ["rubros", "Rubros"],
  ["coeficientes", "Coeficientes"],
  ["lspServices", "Servicios"],
  ["oficios", "Oficios"],
];

/**
 * Resultado del sync de directorio: qué se creó, qué se actualizó y qué quedó en
 * la base sin estar en el ALTA (que el sync ya no borra).
 *
 * Si se detectaron cambios de nombre por CUIT, acá se confirman: ninguno se
 * aplica solo, y el botón dice cuántos se van a aplicar.
 */
export function DirectorySyncModal({ report, onClose, onApplyRenames }: Props) {
  const [seleccionados, setSeleccionados] = useState<Set<string>>(
    () => new Set(report.pendingRenames.map((r) => r.id))
  );

  const toggle = (id: string) =>
    setSeleccionados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const aAplicar = report.pendingRenames.filter((r) => seleccionados.has(r.id));

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Sincronización de directorio</h3>

        <ul className={styles.syncSummary}>
          {ETIQUETAS.map(([clave, etiqueta]) => {
            const r = report[clave] as SyncEntityReport;
            return (
              <li key={clave}>
                <strong>{etiqueta}</strong>: {r.created} nuevos, {r.updated} actualizados
                {r.orphans.length > 0 && ` · ${r.orphans.length} en la base que no están en el ALTA`}
              </li>
            );
          })}
        </ul>

        {ETIQUETAS.some(([clave]) => (report[clave] as SyncEntityReport).orphans.length > 0) && (
          <ul className={styles.closeAllList}>
            {ETIQUETAS.flatMap(([clave]) =>
              (report[clave] as SyncEntityReport).orphans.map((o) => (
                <li key={`${String(clave)}-${o.id}`}>
                  <strong>{o.name}</strong>
                  {typeof o.invoices === "number" && o.invoices > 0 && (
                    <span className={styles.closeAllSkipReason}>{o.invoices} boleta(s)</span>
                  )}
                </li>
              ))
            )}
          </ul>
        )}

        {report.pendingRenames.length > 0 && (
          <>
            <p className={styles.modalBody}>
              Se detectaron cambios de nombre por CUIT. Ninguno se aplicó todavía.
            </p>
            <ul className={styles.closeAllList}>
              {report.pendingRenames.map((r) => (
                <li key={r.id}>
                  <label>
                    <input type="checkbox" checked={seleccionados.has(r.id)} onChange={() => toggle(r.id)} />{" "}
                    <strong>{r.from}</strong> → <strong>{r.to}</strong>
                  </label>
                  <span className={styles.closeAllSkipReason}>
                    CUIT {r.cuit} · {r.invoices} boleta(s) · {r.periods} período(s)
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {report.ambiguous.length > 0 && (
          <p className={styles.modalBody}>
            Sin tocar por ambigüedad de CUIT: {report.ambiguous.join(", ")}
          </p>
        )}

        {report.warnings.length > 0 && (
          <ul className={styles.closeAllList}>
            {report.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}

        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>
            Cerrar
          </button>
          {report.pendingRenames.length > 0 && (
            <AsyncButton
              type="button"
              className={styles.closePeriodConfirmBtn}
              disabled={aAplicar.length === 0}
              pendingLabel="Aplicando…"
              onClick={() => onApplyRenames(aAplicar.map((r) => ({ entity: r.entity, id: r.id, to: r.to })))}
            >
              Aplicar {aAplicar.length} renombre(s)
            </AsyncButton>
          )}
        </div>
      </div>
    </div>
  );
}
