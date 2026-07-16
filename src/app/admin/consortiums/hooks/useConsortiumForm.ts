import { useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { useAsyncAction } from "@/lib/useAsyncAction";

export type ConsortiumFormValues = { canonicalName: string; cuit: string };
const EMPTY: ConsortiumFormValues = { canonicalName: "", cuit: "" };

export function useConsortiumForm(onCreated: () => void) {
  const { guardedFetch } = useAuthGuard();
  const { pending: saving, run } = useAsyncAction();
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState<ConsortiumFormValues>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const open = () => { setError(null); setSuccess(null); setIsOpen(true); };
  const close = () => setIsOpen(false);
  const setField = (patch: Partial<ConsortiumFormValues>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (!form.canonicalName.trim()) { setError("El nombre del consorcio es obligatorio"); return; }
    setError(null); setSuccess(null);
    try {
      const res = await guardedFetch("/api/client/consortiums", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ canonicalName: form.canonicalName.trim(), cuit: form.cuit.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSuccess("Consorcio creado correctamente.");
      setForm(EMPTY);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar el consorcio");
    }
  };

  const submit = () => run(save);

  return { isOpen, open, close, form, setField, error, success, saving, submit };
}
