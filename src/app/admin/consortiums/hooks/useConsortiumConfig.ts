import { useCallback, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { useAsyncAction } from "@/lib/useAsyncAction";
import type { BankAccountForm, ConfigSection, Consortium, FixedExpenseRow, LspForm, LspService } from "../lib/types";

const EMPTY_LSP_FORM: LspForm = { provider: "", clientNumber: "", description: "" };
const EMPTY_BANK_FORM: BankAccountForm = {
  bankId: "", bankAlias: "", cbu: "", accountNumber: "", branch: "", accountType: "", accountHolder: "",
};

/**
 * Dominio Config del consorcio: el modal con el acordeón de 3 secciones
 * (nombres alternativos / servicios LSP / gastos fijos).
 *
 * `load(c)` es el único punto de entrada del fan-out de `useConsortiumDetail`:
 * resetea el estado del consorcio anterior y recarga LSP + gastos fijos.
 */
export function useConsortiumConfig({ consortiumId, onMatchNamesSaved, onBankSaved }: {
  consortiumId: string | null;
  onMatchNamesSaved: (matchNames: string | null) => void;
  /** Se dispara tras guardar banco/cuenta: la vista por bancos tiene que recargar. */
  onBankSaved?: () => void;
}) {
  const { guardedFetch } = useAuthGuard();
  const { pending: savingMatchNames, run: runMatchNames } = useAsyncAction();
  const { pending: savingBank, run: runBank } = useAsyncAction();

  const [isOpen, setIsOpen] = useState(false);
  // Acordeón: una sola sección abierta a la vez. null = todas colapsadas.
  const [openSection, setOpenSection] = useState<ConfigSection | null>(null);

  // matchNames
  const [editingMatchNames, setEditingMatchNames] = useState(false);
  const [matchNamesValue, setMatchNamesValue] = useState("");
  const [matchNamesMsg, setMatchNamesMsg] = useState<string | null>(null);

  // Banco + datos de la cuenta del consorcio
  const [bankForm, setBankForm] = useState<BankAccountForm>(EMPTY_BANK_FORM);
  const [bankMsg, setBankMsg] = useState<string | null>(null);

  // LspServices
  const [lspServices, setLspServices] = useState<LspService[]>([]);
  const [lspForm, setLspForm] = useState<LspForm>(EMPTY_LSP_FORM);
  const [lspError, setLspError] = useState<string | null>(null);
  const [confirmDeleteLspId, setConfirmDeleteLspId] = useState<string | null>(null);

  // Gastos fijos: solo lectura desde acá (se administran en /admin/obligaciones).
  const [fixedExpenses, setFixedExpenses] = useState<FixedExpenseRow[]>([]);

  const fetchLspServices = useCallback(async (id: string) => {
    try {
      const res = await guardedFetch(`/api/client/consortiums/${id}/lsp-services`);
      const data = await res.json();
      if (data.ok) setLspServices(data.lspServices ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  const fetchFixedExpenses = useCallback(async (id: string) => {
    try {
      const res = await guardedFetch(`/api/client/consortiums/${id}/fixed-expenses`);
      const data = await res.json();
      if (data.ok) setFixedExpenses(data.fixedExpenses ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  // ── Ciclo de vida del dominio ────────────────────────────────────────────
  // Reemplaza el bloque de config del fan-out de `onConsortiumSelected`.
  const load = (c: Consortium) => {
    setEditingMatchNames(false); setMatchNamesMsg(null); setMatchNamesValue(c.matchNames ?? "");
    setBankMsg(null);
    setBankForm({
      bankId: c.bankId ?? "",
      bankAlias: c.bankAlias ?? "",
      cbu: c.cbu ?? "",
      accountNumber: c.accountNumber ?? "",
      branch: c.branch ?? "",
      accountType: c.accountType ?? "",
      accountHolder: c.accountHolder ?? "",
    });
    setLspServices([]); setLspError(null); setLspForm(EMPTY_LSP_FORM);
    setConfirmDeleteLspId(null);
    setFixedExpenses([]);
    void fetchLspServices(c.id); void fetchFixedExpenses(c.id);
  };

  const open = (c: Consortium) => {
    setMatchNamesValue(c.matchNames ?? "");
    setEditingMatchNames(false);
    setMatchNamesMsg(null);
    setOpenSection(null);
    setIsOpen(true);
  };
  const close = () => setIsOpen(false);
  const toggleSection = (s: ConfigSection) => setOpenSection((prev) => (prev === s ? null : s));

  // ── matchNames ───────────────────────────────────────────────────────────
  const saveMatchNames = async () => {
    if (!consortiumId) return;
    setMatchNamesMsg(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ matchNames: matchNamesValue.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onMatchNamesSaved(data.consortium.matchNames);
      setEditingMatchNames(false);
      setMatchNamesMsg("Guardado correctamente");
      setTimeout(() => setMatchNamesMsg(null), 3000);
    } catch (err) {
      setMatchNamesMsg(err instanceof Error ? err.message : "Error al guardar");
    }
  };

  // ── Banco + cuenta ───────────────────────────────────────────────────────
  const saveBank = async () => {
    if (!consortiumId) return;
    setBankMsg(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bankId: bankForm.bankId || null,
          bankAlias: bankForm.bankAlias.trim() || null,
          cbu: bankForm.cbu.trim() || null,
          accountNumber: bankForm.accountNumber.trim() || null,
          branch: bankForm.branch.trim() || null,
          accountType: bankForm.accountType.trim() || null,
          accountHolder: bankForm.accountHolder.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setBankMsg("Guardado correctamente");
      setTimeout(() => setBankMsg(null), 3000);
      onBankSaved?.();
    } catch (err) {
      setBankMsg(err instanceof Error ? err.message : "Error al guardar");
    }
  };

  // ── LspServices ──────────────────────────────────────────────────────────
  const addLsp = async () => {
    if (!consortiumId) return;
    if (!lspForm.provider) { setLspError("Seleccioná una empresa"); return; }
    if (!lspForm.clientNumber.trim()) { setLspError("El número de cliente es obligatorio"); return; }
    setLspError(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/lsp-services`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: lspForm.provider,
          clientNumber: lspForm.clientNumber.trim(),
          description: lspForm.description.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLspServices((prev) => [data.lspService, ...prev]);
      setLspForm(EMPTY_LSP_FORM);
    } catch (err) {
      setLspError(err instanceof Error ? err.message : "Error al agregar servicio");
    }
  };

  const removeLsp = async (lspId: string) => {
    if (!consortiumId) return;
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/lsp-services/${lspId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLspServices((prev) => prev.filter((s) => s.id !== lspId));
    } catch (err) {
      setLspError(err instanceof Error ? err.message : "Error al eliminar servicio");
    } finally { setConfirmDeleteLspId(null); }
  };

  return {
    isOpen, open, close, load,
    openSection, toggleSection,
    matchNames: {
      editing: editingMatchNames,
      value: matchNamesValue,
      msg: matchNamesMsg,
      saving: savingMatchNames,
      setValue: setMatchNamesValue,
      startEdit: () => setEditingMatchNames(true),
      cancelEdit: () => setEditingMatchNames(false),
      save: () => runMatchNames(saveMatchNames),
    },
    bank: {
      form: bankForm,
      msg: bankMsg,
      saving: savingBank,
      setForm: (patch: Partial<BankAccountForm>) => setBankForm((f) => ({ ...f, ...patch })),
      save: () => runBank(saveBank),
    },
    lsp: {
      services: lspServices,
      form: lspForm,
      error: lspError,
      confirmDeleteId: confirmDeleteLspId,
      setForm: (patch: Partial<LspForm>) => setLspForm((f) => ({ ...f, ...patch })),
      setConfirmDeleteId: setConfirmDeleteLspId,
      add: addLsp,
      remove: removeLsp,
    },
    fixed: {
      list: fixedExpenses,
    },
  };
}
