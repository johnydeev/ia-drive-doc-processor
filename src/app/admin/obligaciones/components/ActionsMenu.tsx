"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import styles from "../page.module.css";

export type ActionsMenuItem = {
  label: string;
  onSelect: () => void;
  /** Acción que saca algo de la hoja (Desactivar): va en color de advertencia. */
  danger?: boolean;
};

type Props = {
  items: ActionsMenuItem[];
  /** Concepto de la fila: da nombre al botón para lectores de pantalla y tests. */
  concepto: string;
};

/** Los items del menú abierto, en orden. */
function menuItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
}

/**
 * Menú «Acciones ▾» de una fila: agrupa las acciones que cambian el estado del
 * gasto (Omitir, Desactivar) para que no queden sueltas al lado del editor de
 * etiqueta. Cada item sólo abre un diálogo de confirmación (estado local), así
 * que no lleva spinner: el spinner va en el diálogo.
 */
export function ActionsMenu({ items, concepto }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Al abrir, el foco va al primer item: así el teclado entra al menú sin Tab.
  useEffect(() => {
    if (open) menuItems(menuRef.current)[0]?.focus();
  }, [open]);

  // Abierto, se cierra con Escape (y el foco vuelve al botón, para no dejarlo
  // perdido en el body) o con un click en cualquier lado fuera del menú.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  // Flechas arriba/abajo recorren los items en círculo (patrón menu de WAI-ARIA).
  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const list = menuItems(menuRef.current);
    if (list.length === 0) return;
    const current = list.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      current < 0
        ? (e.key === "ArrowDown" ? 0 : list.length - 1)
        : (current + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
    list[next].focus();
  };

  return (
    <div className={styles.actionsMenu} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.actionBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Acciones de ${concepto}`}
        onClick={() => setOpen((v) => !v)}
      >
        Acciones ▾
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className={styles.actionsMenuList}
          role="menu"
          aria-label={`Acciones de ${concepto}`}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={item.danger ? styles.actionsMenuItemDanger : styles.actionsMenuItem}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
