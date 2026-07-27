import { useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { todayInputDate } from "../lib/format";
import type { Invoice, PaymentMode, PaymentRecord, PayForm } from "../lib/types";

const EMPTY_FORM: PayForm = { amount: "", paymentDate: todayInputDate(), totalInstallments: "", paymentMethod: "", observation: "" };

export function usePayModal({ onSaved }: { onSaved: () => void }) {
  const { guardedFetch } = useAuthGuard();
  const { pending: saving, run } = useAsyncAction();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [existingPayments, setExistingPayments] = useState<PaymentRecord[]>([]);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [chosenMode, setChosenMode] = useState<PaymentMode>("libre");
  const [form, setForm] = useState<PayForm>(EMPTY_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Derivados del modo activo (idénticos al original).
  const activeMode: PaymentMode | null = existingPayments.length === 0
    ? null
    : existingPayments[0].totalInstallments !== null ? "cuotas" : "libre";
  const mode: PaymentMode = activeMode ?? chosenMode;
  const isFirstPayment = existingPayments.length === 0;
  const installmentsLocked = existingPayments[0]?.totalInstallments ?? null;
  const currentInstallmentNumber = installmentsLocked ? existingPayments.length + 1 : null;
  const isLastInstallment = installmentsLocked !== null && currentInstallmentNumber === installmentsLocked;
  const invoiceAmount = Number(invoice?.amount ?? 0);
  const invoiceRemaining = invoice?.remainingBalance !== null && invoice?.remainingBalance !== undefined
    ? Number(invoice.remainingBalance)
    : invoiceAmount;

  let computedAmount = 0;
  if (mode === "cuotas") {
    if (isLastInstallment) {
      computedAmount = invoiceRemaining;
    } else {
      const total = installmentsLocked ?? (Number(form.totalInstallments) || 0);
      computedAmount = total > 0 ? Number((invoiceAmount / total).toFixed(2)) : 0;
    }
  } else {
    computedAmount = Number(form.amount) || 0;
  }

  const setField = (patch: Partial<PayForm>) => setForm((f) => ({ ...f, ...patch }));

  const open = async (inv: Invoice) => {
    setInvoice(inv);
    setFile(null);
    setError(null);
    setChosenMode("libre");
    setForm({ ...EMPTY_FORM, amount: String(inv.remainingBalance ?? inv.amount ?? ""), paymentDate: todayInputDate() });
    setExistingPayments([]);
    setLoadingExisting(true);
    try {
      const res = await guardedFetch(`/api/client/invoices/${inv.id}/payments`, { cache: "no-store" });
      const data = await res.json();
      if (data.ok && Array.isArray(data.payments)) setExistingPayments(data.payments);
    } catch { /* silent */ }
    finally { setLoadingExisting(false); }
  };

  const close = () => {
    if (saving) return;
    setInvoice(null); setFile(null); setError(null); setExistingPayments([]);
  };

  const save = async () => {
    if (!invoice) return;
    const missing: string[] = [];
    if (!form.paymentDate) missing.push("fecha de pago");

    let amountToSend = 0;
    let installmentsToSend: number | null = null;
    let modeErr: string | null = null;

    if (mode === "cuotas") {
      if (installmentsLocked !== null) {
        installmentsToSend = installmentsLocked;
        amountToSend = computedAmount;
      } else {
        const inst = Number(form.totalInstallments);
        if (!Number.isInteger(inst) || inst < 2) {
          modeErr = "Las cuotas deben ser un entero mayor o igual a 2";
        } else {
          installmentsToSend = inst;
          amountToSend = computedAmount;
        }
      }
    } else {
      amountToSend = Number(form.amount);
      if (!Number.isFinite(amountToSend) || amountToSend <= 0) {
        modeErr = "El monto debe ser un número positivo";
      }
    }

    if (!form.paymentMethod) missing.push("medio de pago");
    if (!file) missing.push("comprobante PDF");

    if (missing.length > 0 || modeErr) {
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`Faltan campos: ${missing.join(", ")}.`);
      if (modeErr) parts.push(modeErr);
      setError(parts.join(" "));
      return;
    }

    setError(null);
    try {
      const formData = new FormData();
      formData.append("amount", String(amountToSend));
      formData.append("paymentDate", form.paymentDate);
      if (installmentsToSend && isFirstPayment) {
        formData.append("totalInstallments", String(installmentsToSend));
      }
      if (mode !== "cuotas") {
        formData.append("paymentType", "LIBRE");
      }
      if (form.paymentMethod) formData.append("paymentMethod", form.paymentMethod);
      if (form.observation) formData.append("observation", form.observation);
      if (file) formData.append("receipt", file);

      const res = await fetch(`/api/client/invoices/${invoice.id}/payments`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      setInvoice(null);
      setFile(null);
      setExistingPayments([]);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al registrar el pago");
    }
  };

  const submit = () => run(save);

  return {
    invoice, existingPayments, loadingExisting,
    mode, activeMode, isFirstPayment, installmentsLocked, currentInstallmentNumber, isLastInstallment, computedAmount,
    form, setField, setMode: setChosenMode,
    file, setFile,
    error, saving,
    open, close, submit,
  };
}
