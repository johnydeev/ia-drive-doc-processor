"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

type AsyncButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  /** Handler de la acción. Mientras la promesa está pendiente, el botón se deshabilita
   *  y muestra el spinner + pendingLabel. Los clicks repetidos se ignoran. */
  onClick: () => void | Promise<void>;
  /** Qué mostrar mientras corre (ej. "Agregando…"). Si no se pasa, mantiene los children. */
  pendingLabel?: ReactNode;
  children: ReactNode;
};

/**
 * Botón que da feedback de carga automático: mientras su `onClick` async está en curso
 * se deshabilita, muestra un spinner y corta el doble click (guard por ref, antes de que
 * React re-renderice el `disabled`). Drop-in: acepta el resto de props de <button>.
 */
export function AsyncButton({ onClick, pendingLabel, children, disabled, ...rest }: AsyncButtonProps) {
  const [pending, setPending] = useState(false);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const handleClick = async () => {
    if (runningRef.current) return; // ya hay una ejecución en curso → ignorar
    runningRef.current = true;
    setPending(true);
    try {
      await onClick();
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  };

  return (
    <button {...rest} disabled={disabled || pending} onClick={handleClick} aria-busy={pending}>
      {pending && <span className="asyncSpinner" aria-hidden="true" />}
      {pending ? (pendingLabel ?? children) : children}
    </button>
  );
}
