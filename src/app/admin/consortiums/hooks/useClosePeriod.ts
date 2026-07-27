import { useEffect, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { useAsyncAction } from "@/lib/useAsyncAction";

export function useClosePeriod({ consortiumId, periodId, onClosed }: {
  consortiumId: string | null;
  periodId: string | null;
  onClosed: () => void;
}) {
  const { guardedFetch } = useAuthGuard();
  const { pending: saving, run } = useAsyncAction();
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Reemplaza el reset inline que hacía handleSelectConsortium: al cambiar de
  // consorcio se limpian los mensajes de cierre del consorcio anterior.
  useEffect(() => { setError(null); setSuccess(null); }, [consortiumId]);

  const open = () => setIsOpen(true);
  const close = () => setIsOpen(false);

  const save = async () => {
    if (!consortiumId || !periodId) return;
    setError(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/close-period`, {
        method: "POST", headers: { "content-type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSuccess("Período cerrado. Se creó el siguiente período activo.");
      setIsOpen(false);
      onClosed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cerrar el período");
    }
  };

  const submit = () => run(save);

  return { isOpen, open, close, error, success, saving, submit };
}
