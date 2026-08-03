import { useCallback, useEffect, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { DEFAULT_BANK_COLOR } from "../lib/bankPalette";
import type { Bank } from "../lib/types";

export type BankFormValues = { name: string; color: string };
const EMPTY_FORM: BankFormValues = { name: "", color: DEFAULT_BANK_COLOR };

/**
 * Catálogo de bancos del cliente (nivel Client, como Rubro y Coeficiente) + su ABM.
 *
 * El modal de gestión se abre desde el sidebar; la asignación de un banco a cada
 * consorcio la hace la sección Banco del modal de Configuración, no este hook.
 */
export function useBanks() {
  const { guardedFetch } = useAuthGuard();

  const [banks, setBanks] = useState<Bank[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [form, setFormState] = useState<BankFormValues>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const fetchBanks = useCallback(async () => {
    try {
      const res = await guardedFetch("/api/client/banks", { cache: "no-store" });
      const data = await res.json();
      if (data.ok) setBanks(data.banks ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  useEffect(() => { void fetchBanks(); }, [fetchBanks]);

  const setForm = (patch: Partial<BankFormValues>) => setFormState((f) => ({ ...f, ...patch }));

  const create = async () => {
    const name = form.name.trim();
    if (!name) { setError("El nombre es obligatorio"); return; }
    setError(null);
    try {
      const res = await guardedFetch("/api/client/banks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: form.color }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setFormState(EMPTY_FORM);
      await fetchBanks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al crear banco");
    }
  };

  const update = async (id: string, patch: BankFormValues) => {
    const name = patch.name.trim();
    if (!name) { setError("El nombre es obligatorio"); return; }
    setError(null);
    try {
      const res = await guardedFetch(`/api/client/banks/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: patch.color }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setEditingId(null);
      await fetchBanks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al actualizar banco");
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      const res = await guardedFetch(`/api/client/banks/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await fetchBanks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al eliminar banco");
    } finally {
      setConfirmDeleteId(null);
    }
  };

  return {
    banks, reload: fetchBanks,
    isOpen,
    open: () => { setError(null); setFormState(EMPTY_FORM); setIsOpen(true); },
    close: () => { setIsOpen(false); setConfirmDeleteId(null); setEditingId(null); },
    form, setForm,
    error,
    confirmDeleteId, setConfirmDeleteId,
    editingId, setEditingId,
    create, update, remove,
  };
}
