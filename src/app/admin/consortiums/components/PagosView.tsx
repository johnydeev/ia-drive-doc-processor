"use client";
import { useState } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { formatAmount, formatAmountPlain, formatDate, parseAmountInput, todayInputDate } from "../lib/format";
import type { Invoice } from "../lib/types";

interface PendingPaymentInput {
  paymentDate: string;
  amount: string;
  paymentMethod: string;
  file: File | null;
}

interface PagosViewProps {
  invoices: Invoice[];
  onPagoGuardado: () => void;
  onPagar: (inv: Invoice) => void;
  onVerPagos: (inv: Invoice) => void;
  onEliminarUltimoPago: (invoiceId: string) => Promise<void>;
}

export function PagosView({ invoices, onPagoGuardado, onPagar, onVerPagos, onEliminarUltimoPago }: PagosViewProps) {
  // Confirm inline para eliminar último pago de una boleta paga (estado local).
  const [confirmDeletePaymentInvoiceId, setConfirmDeletePaymentInvoiceId] = useState<string | null>(null);
  const [pendingPayments, setPendingPayments] = useState<Record<string, PendingPaymentInput>>({});
  const { pending: saving, run: runGuardar } = useAsyncAction();
  const [error, setError] = useState<string | null>(null);
  // Buscador local de PagosView. State separado del de Boletas — cada pestaña
  // tiene su contexto de búsqueda independiente.
  const [search, setSearch] = useState("");

  const allVisible = invoices.filter((inv) => !inv.isDuplicate);

  // Filtro por proveedor, N° boleta o CUIT (mismo criterio que la pestaña Boletas).
  const visibleInvoices = (() => {
    if (!search.trim()) return allVisible;
    const q = search.toLowerCase();
    return allVisible.filter((inv) => {
      const provider = (inv.provider ?? "").toLowerCase();
      const boleta = (inv.boletaNumber ?? "").toLowerCase();
      const cuit = inv.providerTaxId ?? "";
      return provider.includes(q) || boleta.includes(q) || cuit.includes(q);
    });
  })();

  // Prisma serializa Decimal como string → `string + 0` concatena en vez de sumar
  // y termina dando NaN cuando formateamos. Forzar Number() en cada reduce.
  const toNum = (v: number | string | null | undefined): number => {
    if (v === null || v === undefined) return 0;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // Métricas del header sobre el período completo (no sobre el filtrado) —
  // el buscador afecta la tabla, no las métricas globales.
  const totalBoletas = allVisible.length;
  const boletasPagadas = allVisible.filter((inv) => inv.isPaid).length;

  const totalImpago = allVisible
    .filter((inv) => !inv.isPaid)
    .reduce((sum, inv) => {
      const amount = toNum(inv.amount);
      const remaining = inv.remainingBalance === null ? amount : toNum(inv.remainingBalance);
      return sum + remaining;
    }, 0);

  const updatePending = (invoiceId: string, field: keyof PendingPaymentInput, value: string) => {
    setPendingPayments((prev) => {
      const existing = prev[invoiceId] ?? { paymentDate: todayInputDate(), amount: "", paymentMethod: "", file: null };
      return { ...prev, [invoiceId]: { ...existing, [field]: value } };
    });
  };

  // Handler separado para el File del comprobante (no es string).
  const updatePendingFile = (invoiceId: string, file: File | null) => {
    setPendingPayments((prev) => {
      const existing = prev[invoiceId] ?? { paymentDate: todayInputDate(), amount: "", paymentMethod: "", file: null };
      return { ...prev, [invoiceId]: { ...existing, file } };
    });
  };

  // Una fila "cuenta" para guardar solo si tiene un pago real cargado: monto > 0
  // (o, para empleado —cuyo monto es automático—, si eligió medio o adjuntó comprobante).
  // Así una fila cuyo input quedó vacío no infla el contador ni se intenta guardar.
  const isRowPayable = (inv: Invoice, p: PendingPaymentInput): boolean =>
    inv.providerType === "EMPLEADO"
      ? Boolean(p.paymentMethod || p.file)
      : parseAmountInput(p.amount) > 0;

  const payableEntries = Object.entries(pendingPayments).filter(([invoiceId, p]) => {
    const inv = visibleInvoices.find((i) => i.id === invoiceId);
    return inv ? isRowPayable(inv, p) : false;
  });

  const handleGuardarPagos = async () => {
    setError(null);

    // Solo procesamos filas con un pago real cargado (monto > 0, o empleado con
    // medio/comprobante). Las que quedaron con la fecha por defecto y el input
    // vacío se ignoran — no cuentan como pago.
    const dirtyEntries = payableEntries;

    if (dirtyEntries.length === 0) return;

    // Validación: cada fila iniciada debe tener fecha + importe (salvo
    // empleado, que se autocalcula) + medio de pago + comprobante.
    const errors: string[] = [];
    for (const [invoiceId, pago] of dirtyEntries) {
      const inv = visibleInvoices.find((i) => i.id === invoiceId);
      if (!inv) continue;
      const provider = inv.provider ?? "Proveedor s/d";
      const boleta = inv.boletaNumber ?? "s/N°";
      const label = `${provider} – ${boleta}`;
      const missing: string[] = [];

      if (!pago.paymentDate) missing.push("fecha de pago");

      // Inline = pago TOTAL: el importe debe coincidir con el saldo completo.
      // Para un pago parcial se usa el modal ("Cuotas" → "Pago libre").
      if (inv.providerType !== "EMPLEADO") {
        const parsed = parseAmountInput(pago.amount);
        const saldo = inv.remainingBalance ?? inv.amount ?? 0;
        if (!Number.isFinite(parsed) || parsed <= 0) {
          missing.push("importe");
        } else if (Math.abs(parsed - saldo) > 0.5) {
          errors.push(
            `${label}: el pago inline es total y debe ser el saldo (${formatAmount(saldo)}). Para un pago parcial usá "Cuotas" → "Pago libre".`
          );
        }
      }

      if (!pago.paymentMethod) missing.push("medio de pago");
      if (!pago.file) missing.push("comprobante PDF");

      if (missing.length > 0) errors.push(`${label}: falta ${missing.join(", ")}.`);
    }

    if (errors.length > 0) {
      setError(errors.join(" "));
      return;
    }

    try {
      for (const [invoiceId, pago] of dirtyEntries) {
        const inv = visibleInvoices.find((i) => i.id === invoiceId);
        if (!inv) continue;

        const totalAmount = inv.amount ?? 0;
        const remainingAmount = inv.remainingBalance ?? totalAmount;

        // Inline = pago TOTAL: siempre paga el saldo completo (para empleado, el total).
        const amount = inv.providerType === "EMPLEADO" ? totalAmount : remainingAmount;

        if (!amount || amount <= 0) continue;

        // Si hay archivo, usamos FormData (el endpoint acepta multipart;
        // el modal de Cuotas ya usa este camino). Si no, mantenemos JSON
        // para no romper la lógica existente del flujo inline simple.
        let res: Response;
        if (pago.file) {
          const fd = new FormData();
          fd.append("amount", String(amount));
          fd.append("paymentDate", pago.paymentDate);
          fd.append("paymentType", "TOTAL");
          if (pago.paymentMethod) fd.append("paymentMethod", pago.paymentMethod);
          fd.append("receipt", pago.file);
          res = await fetch(`/api/client/invoices/${invoiceId}/payments`, {
            method: "POST",
            body: fd,
          });
        } else {
          res = await fetch(`/api/client/invoices/${invoiceId}/payments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              amount,
              paymentDate: pago.paymentDate,
              paymentType: "TOTAL",
              paymentMethod: pago.paymentMethod || null,
            }),
          });
        }
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setPendingPayments({});
      onPagoGuardado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar los pagos");
    }
  };

  const pendingCount = payableEntries.length;
  const totalPendiente = payableEntries.reduce((sum, [invoiceId, p]) => {
    const inv = visibleInvoices.find((i) => i.id === invoiceId);
    if (!inv) return sum;
    if (inv.providerType === "EMPLEADO") return sum + toNum(inv.amount);
    return sum + parseAmountInput(p.amount);
  }, 0);

  return (
    <>
      <div className={styles.statsStrip}>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Pagos registrados</span>
          <span className={styles.statValue}>{boletasPagadas} de {totalBoletas}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Saldo impago</span>
          <span className={`${styles.statValue} ${totalImpago > 0 ? styles.statWarn : ""}`}>{formatAmount(totalImpago)}</span>
        </div>
      </div>

      {/* Buscador (espejo del de la pestaña Boletas) */}
      <div className={styles.searchRow}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Buscar por proveedor, N° boleta o CUIT..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button type="button" className={styles.clearSearch} onClick={() => setSearch("")}>✕</button>
        )}
      </div>
      {error && <p className={styles.errorMsg}>{error}</p>}

      <div className={styles.tableWrap}>
        {visibleInvoices.length === 0 ? (
          <div className={styles.tableEmpty}>
            {search
              ? "No hay boletas que coincidan con la búsqueda."
              : "No hay boletas para este período."}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>PERÍODO GASTO</th>
                <th>PROVEEDOR</th>
                <th>COMPROBANTE</th>
                <th>IMPORTE</th>
                <th>SALDO</th>
                <th>FECHA PAGO</th>
                <th>IMPORTE PAGO</th>
                <th>MEDIO DE PAGO</th>
                <th>COMPROBANTE</th>
                <th>ACCIONES</th>
              </tr>
            </thead>
            <tbody>
              {visibleInvoices.map((inv) => {
                const pending = pendingPayments[inv.id];
                const totalAmount = inv.amount ?? 0;
                const saldo = inv.remainingBalance ?? totalAmount;
                const isEmpleado = inv.providerType === "EMPLEADO";
                return (
                  <tr key={inv.id}>
                    <td>{formatDate(inv.issueDate)}</td>
                    <td>{inv.provider ?? "—"}</td>
                    <td className={styles.tdMono}>{inv.boletaNumber ?? "—"}</td>
                    <td className={styles.tdAmount}>{formatAmount(totalAmount)}</td>
                    <td className={styles.tdAmount}>{formatAmount(saldo)}</td>

                    <td>
                      {inv.isPaid ? (
                        <span className={styles.badgeOk}>Pagada</span>
                      ) : (
                        <input
                          type="date"
                          className={styles.formInput}
                          value={pending?.paymentDate ?? todayInputDate()}
                          onChange={(e) => updatePending(inv.id, "paymentDate", e.target.value)}
                        />
                      )}
                    </td>

                    <td>
                      {inv.isPaid ? (
                        <span>{formatAmount(totalAmount)}</span>
                      ) : isEmpleado ? (
                        <span>{formatAmount(totalAmount)}</span>
                      ) : (
                        <>
                          <input
                            type="text"
                            inputMode="decimal"
                            list={`sug-saldo-${inv.id}`}
                            className={styles.formInput}
                            placeholder={formatAmountPlain(saldo)}
                            value={pending?.amount ?? ""}
                            title="Pago total: elegí el saldo sugerido. Para un pago parcial usá 'Cuotas' → 'Pago libre'."
                            onChange={(e) => updatePending(inv.id, "amount", e.target.value)}
                          />
                          {/* Sugerencia nativa: el saldo completo. Solo se carga al elegirla
                              (no al hacer foco), y no crea una fila pendiente por sí sola. */}
                          <datalist id={`sug-saldo-${inv.id}`}>
                            <option value={formatAmountPlain(saldo)}>Pago total (saldo)</option>
                          </datalist>
                        </>
                      )}
                    </td>

                    <td>
                      {inv.isPaid ? (
                        <span>—</span>
                      ) : (
                        <select
                          className={styles.formSelect}
                          value={pending?.paymentMethod ?? ""}
                          onChange={(e) => updatePending(inv.id, "paymentMethod", e.target.value)}
                        >
                          <option value="" disabled hidden>Elija una opción</option>
                          <option value="Débito automático">Débito automático</option>
                          <option value="Transferencia">Transferencia</option>
                          <option value="Efectivo">Efectivo</option>
                        </select>
                      )}
                    </td>

                    {/* ── Comprobante (PDF opcional inline) ── */}
                    <td>
                      {inv.isPaid ? (
                        <span>—</span>
                      ) : (
                        <label
                          className={styles.ghostBtn}
                          style={{
                            padding: "4px 10px",
                            fontSize: 12,
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            maxWidth: 140,
                          }}
                          title={pending?.file?.name ?? "Adjuntar comprobante PDF"}
                        >
                          <span>📎</span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {pending?.file ? pending.file.name : "Adjuntar"}
                          </span>
                          <input
                            type="file"
                            accept="application/pdf"
                            style={{ display: "none" }}
                            onChange={(e) => updatePendingFile(inv.id, e.target.files?.[0] ?? null)}
                          />
                        </label>
                      )}
                    </td>

                    {/* ── Acciones: Pagar/Ver pagos + Eliminar último pago ── */}
                    <td>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {inv.isPaid ? (
                          <button
                            type="button"
                            className={styles.ghostBtn}
                            style={{ padding: "4px 10px", fontSize: 12 }}
                            onClick={() => onVerPagos(inv)}
                            title="Ver historial de pagos"
                          >
                            Ver pagos
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={styles.addInvoiceBtn}
                            style={{ padding: "4px 10px", fontSize: 12 }}
                            onClick={() => onPagar(inv)}
                            title="Registrar pago en cuotas (fijas o variables). Para un solo pago, usá los inputs inline de esta fila."
                          >
                            Cuotas
                          </button>
                        )}

                        {/* Eliminar último pago: solo si la boleta tiene al menos un pago */}
                        {(inv.isPaid || (inv.remainingBalance !== null && Number(inv.remainingBalance) < Number(inv.amount ?? 0))) && (
                          confirmDeletePaymentInvoiceId === inv.id ? (
                            <span className={styles.lspConfirmDelete}>
                              ¿Borrar último pago?{" "}
                              <AsyncButton
                                type="button"
                                className={styles.lspConfirmYes}
                                pendingLabel="…"
                                onClick={async () => {
                                  try { await onEliminarUltimoPago(inv.id); }
                                  finally { setConfirmDeletePaymentInvoiceId(null); }
                                }}
                              >
                                Sí
                              </AsyncButton>
                              <button type="button" className={styles.lspConfirmNo} onClick={() => setConfirmDeletePaymentInvoiceId(null)}>No</button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className={styles.lspDeleteBtn}
                              onClick={() => setConfirmDeletePaymentInvoiceId(inv.id)}
                              title="Eliminar el último pago registrado (revierte estado y borra comprobante de Drive si tenía)"
                              aria-label="Eliminar último pago"
                            >
                              🗑
                            </button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {pendingCount > 0 && (
        <div className={styles.pagosFooter}>
          <span>
            {pendingCount} pago(s) cargado(s) sin guardar: {formatAmount(totalPendiente)}
          </span>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => setPendingPayments({})}
            disabled={saving}
          >
            CANCELAR
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={() => runGuardar(handleGuardarPagos)}
            disabled={saving}
          >
            {saving ? "Guardando..." : "GUARDAR"}
          </button>
        </div>
      )}
    </>
  );
}
