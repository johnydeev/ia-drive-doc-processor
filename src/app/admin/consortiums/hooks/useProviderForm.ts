import { useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { useAsyncAction } from "@/lib/useAsyncAction";
import type { Provider } from "../lib/types";

export type ProviderFormValues = { canonicalName: string; cuit: string; paymentAlias: string };
const EMPTY: ProviderFormValues = { canonicalName: "", cuit: "", paymentAlias: "" };

export function useProviderForm(onCreated: (provider: Provider) => void) {
  const { guardedFetch } = useAuthGuard();
  const { pending: saving, run } = useAsyncAction();
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState<ProviderFormValues>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const open = () => { setError(null); setSuccess(null); setIsOpen(true); };
  const close = () => setIsOpen(false);
  const setField = (patch: Partial<ProviderFormValues>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (!form.canonicalName || !form.cuit) { setError("Razón social y CUIT son obligatorios"); return; }
    setError(null); setSuccess(null);
    try {
      const res = await guardedFetch("/api/client/providers", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onCreated(data.provider);
      const requeuedMsg = data.requeued > 0 ? ` Se reencolarán ${data.requeued} boleta(s) para revalidación.` : "";
      setSuccess(`Proveedor creado correctamente.${requeuedMsg}`);
      setForm(EMPTY);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar el proveedor");
    }
  };

  const submit = () => run(save);

  return { isOpen, open, close, form, setField, error, success, saving, submit };
}
