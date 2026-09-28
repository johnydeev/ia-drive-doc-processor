"use client";

import { useEffect, type ReactNode } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";

type Props = {
  title: string;
  /** Qué hace la acción, en criollo: se lee antes de confirmar. */
  children: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  /** Se espera la promesa (spinner en Confirmar); al resolver, el llamador cierra. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
};

/**
 * Confirmación de una acción de fila que cambia el estado del gasto (Omitir,
 * Desactivar). Están al lado del editor de rubro/coeficiente y un click
 * errado no se nota hasta tarde: el diálogo dice qué va a pasar y cómo se deshace.
 */
export function ConfirmActionDialog({ title, children, confirmLabel, pendingLabel, onConfirm, onCancel }: Props) {
  // Escape cancela, como en cualquier diálogo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.modalCard}>
        <h2 className={styles.modalTitle}>{title}</h2>
        <div className={styles.confirmBody}>{children}</div>
        <div className={styles.modalActions}>
          {/* El foco arranca en Cancelar: un Enter de más no confirma. */}
          <button type="button" className={styles.ghostBtn} onClick={onCancel} autoFocus>
            Cancelar
          </button>
          <AsyncButton type="button" className={styles.primaryBtn} pendingLabel={pendingLabel} onClick={onConfirm}>
            {confirmLabel}
          </AsyncButton>
        </div>
      </div>
    </div>
  );
}
