"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import styles from "../page.module.css";
import { useAsyncAction } from "@/lib/useAsyncAction";

export type ActionsMenuItem = {
  label: string;
  /**
   * Si devuelve una promesa (una mutación, ej. «Pasar al mes siguiente»), el
   * botón del menú queda con spinner y deshabilitado hasta que resuelve.
   */
  onSelect: () => void | Promise<void>;
  /** Qué muestra el botón mientras corre la acción. Por defecto "Procesando…". */
  pendingLabel?: string;
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

/** Una promesa (o cualquier "thenable") que hay que esperar. */
function isPromise(value: unknown): value is Promise<void> {
  return typeof (value as Promise<void> | undefined)?.then === "function";
}

/**
 * Menú «Acciones ▾» de una fila: agrupa todas sus acciones (Pasar al mes
 * siguiente, Devolver, Omitir, Desactivar) para que no queden sueltas al lado
 * del editor de etiqueta.
 *
 * Hay dos clases de item. Los que abren un diálogo de confirmación (Omitir,
 * Desactivar) son sincrónicos: el spinner va en el diálogo. Los que disparan la
 * mutación directo devuelven su promesa: el menú se cierra y el botón
 * «Acciones ▾» queda deshabilitado, con spinner y el `pendingLabel` del item,
 * hasta que resuelve (`useAsyncAction` corta el doble disparo).
 */
export function ActionsMenu({ items, concepto }: Props) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useAsyncAction();
  const [pendingLabel, setPendingLabel] = useState("Procesando…");
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
        aria-busy={pending}
        disabled={pending}
        onClick={() => setOpen((v) => !v)}
      >
        {pending && <span className="asyncSpinner" aria-hidden="true" />}
        {pending ? pendingLabel : "Acciones ▾"}
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
                if (pending) return;
                // Se llama primero y recién se espera si devolvió promesa: un item
                // sincrónico (abre un diálogo) no hace parpadear el spinner.
                const result = item.onSelect();
                if (!isPromise(result)) return;
                setPendingLabel(item.pendingLabel ?? "Procesando…");
                void run(() => result);
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
