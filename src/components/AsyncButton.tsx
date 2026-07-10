"use client";

import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { useAsyncAction } from "@/lib/useAsyncAction";

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
 * se deshabilita, muestra un spinner y corta el doble click (ver useAsyncAction).
 * Drop-in: acepta el resto de props de <button>.
 */
export function AsyncButton({ onClick, pendingLabel, children, disabled, ...rest }: AsyncButtonProps) {
  const { pending, run } = useAsyncAction();

  return (
    <button {...rest} disabled={disabled || pending} onClick={() => run(onClick)} aria-busy={pending}>
      {pending && <span className="asyncSpinner" aria-hidden="true" />}
      {pending ? (pendingLabel ?? children) : children}
    </button>
  );
}
