import { useRef, useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { EMPTY_INVOICE_FORM } from "../lib/constants";
import { formatAmountPlain, parseAmountInput, toInputDate, todayInputDate } from "../lib/format";
import { matchProvider } from "../lib/match";
import type { Coeficiente, Invoice, InvoiceForm, Provider, Rubro, ScannedData } from "../lib/types";

export function useInvoiceModal({ consortiumId, periodId, providers, onCreated, addCoeficiente, addRubro, setToolbarInfo, setToolbarError }: {
  consortiumId: string | null;
  periodId: string | null;
  providers: Provider[];
  onCreated: (invoice: Invoice) => void;
  addCoeficiente: (c: Coeficiente) => void;
  addRubro: (r: Rubro) => void;
  setToolbarInfo: (v: string | null) => void;
  setToolbarError: (v: string | null) => void;
}) {
  const { guardedFetch } = useAuthGuard();
  const { pending: saving, run } = useAsyncAction();
  const [isOpen, setIsOpen] = useState(false);
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanWarning, setScanWarning] = useState<string | null>(null);
  const [matchedProvider, setMatchedProvider] = useState<Provider | null>(null);
  const [form, setForm] = useState<InvoiceForm>(EMPTY_INVOICE_FORM);
  const [error, setError] = useState<string | null>(null);
  const [mismatchConsortium, setMismatchConsortium] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setField = (patch: Partial<InvoiceForm>) => setForm((f) => ({ ...f, ...patch }));

  const reset = () => {
    setScanFile(null); setScanWarning(null); setError(null); setMatchedProvider(null);
    setForm({ ...EMPTY_INVOICE_FORM, issueDate: todayInputDate() });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const open = () => { reset(); setIsOpen(true); };
  const close = () => { setIsOpen(false); reset(); };

  const scan = async (file: File) => {
    if (!consortiumId) return;
    setScanning(true); setScanWarning(null); setMatchedProvider(null);
    try {
      const fd = new FormData();
      fd.append("pdf", file);
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/invoices/scan`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      if (data.consortiumMismatch && data.foundConsortium) {
        setMismatchConsortium(data.foundConsortium as string);
        return;
      }

      if (data.warning) setScanWarning(data.warning);
      if (data.extracted) {
        const e: ScannedData = data.extracted;
        const hit = matchProvider(providers, e);
        setMatchedProvider(hit ?? null);
        setForm((f) => ({
          ...f,
          boletaNumber:    e.boletaNumber    ?? f.boletaNumber,
          providerTaxId:   hit?.cuit         ?? e.providerTaxId ?? f.providerTaxId,
          detail:          e.detail          ?? f.detail,
          observation:     e.observation     ?? f.observation,
          issueDate:       toInputDate(e.issueDate) || f.issueDate,
          dueDate:         toInputDate(e.dueDate)   || f.dueDate,
          amount:          e.amount != null  ? formatAmountPlain(Number(e.amount)) : f.amount,
          tipoComprobante: e.tipoComprobante ?? f.tipoComprobante,
          ...(hit ? { providerId: hit.id } : {}),
        }));
      }
    } catch (err) {
      setScanWarning(err instanceof Error ? err.message : "Error al escanear el PDF");
    } finally { setScanning(false); }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanFile(file);
    void scan(file);
  };

  const dismissMismatch = () => {
    setMismatchConsortium(null);
    setScanFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const save = async () => {
    if (!consortiumId || !periodId) return;
    if (!form.providerId) { setError("Seleccioná un proveedor"); return; }
    setError(null);
    try {
      let coefId = form.coeficienteId === "__new__" ? "" : form.coeficienteId;
      if (form.coeficienteId === "__new__" && form.newCoefName && form.newCoefValue) {
        const coefRes = await guardedFetch(`/api/client/consortiums/${consortiumId}/coeficientes`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: form.newCoefName, value: parseFloat(form.newCoefValue) }),
        });
        const coefData = await coefRes.json();
        if (!coefRes.ok || !coefData.ok) throw new Error(coefData.error ?? "Error al crear coeficiente");
        coefId = coefData.coeficiente.id;
        addCoeficiente(coefData.coeficiente);
      }

      let rubroId = form.rubroId === "__new__" ? "" : form.rubroId;
      if (form.rubroId === "__new__" && form.newRubroName) {
        const rubroRes = await guardedFetch(`/api/client/consortiums/${consortiumId}/rubros`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: form.newRubroName }),
        });
        const rubroData = await rubroRes.json();
        if (!rubroRes.ok || !rubroData.ok) throw new Error(rubroData.error ?? "Error al crear rubro");
        rubroId = rubroData.rubro.id;
        addRubro(rubroData.rubro);
      }

      const url = `/api/client/consortiums/${consortiumId}/invoices`;
      const amountValue = form.amount ? parseAmountInput(form.amount) : undefined;
      let res: Response;
      if (scanFile) {
        // Carga asistida con PDF → multipart para guardar el archivo en Drive.
        const fd = new FormData();
        fd.append("pdf", scanFile);
        fd.append("providerId", form.providerId);
        fd.append("periodId", periodId);
        fd.append("tipoGasto", form.tipoGasto);
        if (form.boletaNumber)    fd.append("boletaNumber", form.boletaNumber);
        if (form.providerTaxId)   fd.append("providerTaxId", form.providerTaxId);
        if (form.detail)          fd.append("detail", form.detail);
        if (form.observation)     fd.append("observation", form.observation);
        if (form.issueDate)       fd.append("issueDate", form.issueDate);
        if (form.dueDate)         fd.append("dueDate", form.dueDate);
        if (amountValue !== undefined)   fd.append("amount", String(amountValue));
        if (coefId)               fd.append("coeficienteId", coefId);
        if (rubroId)              fd.append("rubroId", rubroId);
        if (form.tipoComprobante) fd.append("tipoComprobante", form.tipoComprobante);
        res = await guardedFetch(url, { method: "POST", body: fd });
      } else {
        res = await guardedFetch(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId:      form.providerId,
            periodId:        periodId,
            boletaNumber:    form.boletaNumber    || undefined,
            providerTaxId:   form.providerTaxId   || undefined,
            detail:          form.detail          || undefined,
            observation:     form.observation     || undefined,
            issueDate:       form.issueDate       || undefined,
            dueDate:         form.dueDate         || undefined,
            amount:          amountValue,
            coeficienteId:   coefId   || undefined,
            rubroId:         rubroId  || undefined,
            tipoGasto:       form.tipoGasto,
            tipoComprobante: form.tipoComprobante || undefined,
          }),
        });
      }
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onCreated(data.invoice);
      setIsOpen(false);
      reset();
      const warnings = [data.sheetsWarning, data.driveWarning].filter(Boolean);
      if (warnings.length > 0) {
        setToolbarError(warnings.join(" "));
      } else {
        setToolbarInfo("Boleta cargada y enviada a Google Sheets.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar la boleta");
    }
  };

  const submit = () => run(save);

  return {
    isOpen, open, close,
    scanFile, scanning, scanWarning, matchedProvider,
    form, setField, error, saving,
    onFileChange, submit, fileInputRef,
    mismatchConsortium, dismissMismatch,
  };
}
