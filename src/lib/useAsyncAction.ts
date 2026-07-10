"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Encapsula una acción async con guard anti doble-ejecución + estado `pending`.
 *
 * - `run(fn)` ejecuta `fn` e ignora nuevas invocaciones mientras ya hay una en
 *   curso (corta el doble click aunque React todavía no re-renderizó el `disabled`).
 * - `pending` sirve para deshabilitar el botón **y sus hermanos** (Cancelar, overlay,
 *   inputs del modal) mientras corre.
 *
 * Reemplaza el patrón repetido de `useState(saving)` + `try/finally` en cada acción.
 * Lo usa `AsyncButton` internamente y los modales directamente.
 */
export function useAsyncAction(): {
  pending: boolean;
  run: (fn: () => void | Promise<void>) => Promise<void>;
} {
  const [pending, setPending] = useState(false);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);

  // Setear en cada (re)montaje: en React StrictMode (dev) el ciclo
  // setup→cleanup→setup dejaría el ref en false para siempre si el setup no lo
  // re-setea, y el finally nunca llamaría setPending(false) → loader eterno.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async (fn: () => void | Promise<void>) => {
    if (runningRef.current) return; // ya hay una ejecución en curso → ignorar
    runningRef.current = true;
    setPending(true);
    try {
      await fn();
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }, []);

  return { pending, run };
}
