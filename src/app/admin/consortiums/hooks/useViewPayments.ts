import { useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import type { Invoice, PaymentRecord } from "../lib/types";

export function useViewPayments() {
  const { guardedFetch } = useAuthGuard();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [list, setList] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const open = async (inv: Invoice) => {
    setInvoice(inv);
    setList([]);
    setLoading(true);
    try {
      const res = await guardedFetch(`/api/client/invoices/${inv.id}/payments`, { cache: "no-store" });
      const data = await res.json();
      if (data.ok && Array.isArray(data.payments)) setList(data.payments);
    } catch { /* silent */ }
    finally { setLoading(false); }
  };

  const close = () => setInvoice(null);

  return { invoice, list, loading, open, close };
}
