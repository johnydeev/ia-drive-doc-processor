import { useCallback, useEffect, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import type { Coeficiente, Rubro } from "../lib/types";

export type RubroFormValues = { name: string; order: string };
export type CoeficienteFormValues = { code: string; name: string };

const EMPTY_RUBRO: RubroFormValues = { name: "", order: "" };
const EMPTY_COEF: CoeficienteFormValues = { code: "", name: "" };

/**
 * Catálogo de rubros y coeficientes del cliente (capa 1 del spec 2026-09-24) + su ABM.
 *
 * Es el mismo patrón que `useBanks`: el modal se abre desde el sidebar y sólo
 * administra el catálogo. Qué usa cada edificio (capa 2) lo decide la sección
 * "Rubros y coeficientes" del modal de Configuración, no este hook.
 *
 * `order` viaja como string en el formulario porque un input vacío tiene que
 * mandar "sin número", no un 0.
 */
export function useCatalogos() {
  const { guardedFetch } = useAuthGuard();

  const [rubros, setRubros] = useState<Rubro[]>([]);
  const [coeficientes, setCoeficientes] = useState<Coeficiente[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [rubroForm, setRubroFormState] = useState<RubroFormValues>(EMPTY_RUBRO);
  const [coeficienteForm, setCoeficienteFormState] = useState<CoeficienteFormValues>(EMPTY_COEF);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteRubroId, setConfirmDeleteRubroId] = useState<string | null>(null);
  const [confirmDeleteCoefId, setConfirmDeleteCoefId] = useState<string | null>(null);
  const [editingRubroId, setEditingRubroId] = useState<string | null>(null);
  const [editingCoefId, setEditingCoefId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [rRes, cRes] = await Promise.all([
        guardedFetch("/api/client/rubros", { cache: "no-store" }),
        guardedFetch("/api/client/coeficientes", { cache: "no-store" }),
      ]);
      const [rData, cData] = await Promise.all([rRes.json(), cRes.json()]);
      if (rData.ok) setRubros(rData.rubros ?? []);
      if (cData.ok) setCoeficientes(cData.coeficientes ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  const setRubroForm = (patch: Partial<RubroFormValues>) =>
    setRubroFormState((f) => ({ ...f, ...patch }));
  const setCoeficienteForm = (patch: Partial<CoeficienteFormValues>) =>
    setCoeficienteFormState((f) => ({ ...f, ...patch }));

  /** `""` → sin número; cualquier otra cosa no numérica se descarta igual. */
  const parseOrder = (raw: string): number | undefined => {
    const n = Number(raw.trim());
    return raw.trim() && Number.isInteger(n) && n > 0 ? n : undefined;
  };

  const createRubro = async () => {
    const name = rubroForm.name.trim();
    if (!name) { setError("El nombre del rubro es obligatorio"); return; }
    setError(null);
    try {
      const res = await guardedFetch("/api/client/rubros", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, order: parseOrder(rubroForm.order) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRubroFormState(EMPTY_RUBRO);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al crear rubro");
    }
  };

  const updateRubro = async (id: string, patch: RubroFormValues) => {
    const name = patch.name.trim();
    if (!name) { setError("El nombre del rubro es obligatorio"); return; }
    setError(null);
    try {
      const res = await guardedFetch(`/api/client/rubros/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, order: parseOrder(patch.order) ?? null }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setEditingRubroId(null);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al actualizar rubro");
    }
  };

  const removeRubro = async (id: string) => {
    setError(null);
    try {
      const res = await guardedFetch(`/api/client/rubros/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al eliminar rubro");
    } finally {
      setConfirmDeleteRubroId(null);
    }
  };

  const createCoeficiente = async () => {
    const code = coeficienteForm.code.trim();
    const name = coeficienteForm.name.trim();
    if (!code || !name) { setError("El código y el nombre del coeficiente son obligatorios"); return; }
    setError(null);
    try {
      const res = await guardedFetch("/api/client/coeficientes", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCoeficienteFormState(EMPTY_COEF);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al crear coeficiente");
    }
  };

  const updateCoeficiente = async (id: string, patch: CoeficienteFormValues) => {
    const code = patch.code.trim();
    const name = patch.name.trim();
    if (!code || !name) { setError("El código y el nombre del coeficiente son obligatorios"); return; }
    setError(null);
    try {
      const res = await guardedFetch(`/api/client/coeficientes/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setEditingCoefId(null);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al actualizar coeficiente");
    }
  };

  const removeCoeficiente = async (id: string) => {
    setError(null);
    try {
      const res = await guardedFetch(`/api/client/coeficientes/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al eliminar coeficiente");
    } finally {
      setConfirmDeleteCoefId(null);
    }
  };

  return {
    rubros, coeficientes, reload: fetchAll,
    isOpen,
    open: () => {
      setError(null);
      setRubroFormState(EMPTY_RUBRO);
      setCoeficienteFormState(EMPTY_COEF);
      setIsOpen(true);
    },
    close: () => {
      setIsOpen(false);
      setConfirmDeleteRubroId(null);
      setConfirmDeleteCoefId(null);
      setEditingRubroId(null);
      setEditingCoefId(null);
    },
    rubroForm, setRubroForm,
    coeficienteForm, setCoeficienteForm,
    error,
    confirmDeleteRubroId, setConfirmDeleteRubroId,
    confirmDeleteCoefId, setConfirmDeleteCoefId,
    editingRubroId, setEditingRubroId,
    editingCoefId, setEditingCoefId,
    createRubro, updateRubro, removeRubro,
    createCoeficiente, updateCoeficiente, removeCoeficiente,
  };
}
