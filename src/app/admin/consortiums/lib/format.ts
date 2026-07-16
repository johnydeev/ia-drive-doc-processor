// Helpers puros de formato/fecha/monto. Movidos desde page.tsx sin cambios de lógica.
import type { Period } from "./types";

export const MONTH_NAMES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

export function formatPeriod(p: Period | null | undefined) {
  if (!p) return "Sin período activo";
  return `${MONTH_NAMES[p.month - 1]} ${p.year}`;
}
export function formatAmount(v: number | null | undefined) {
  if (v == null) return "—";
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(v);
}
// Formato es-AR sin símbolo de moneda — útil para placeholders de inputs.
export function formatAmountPlain(v: number | null | undefined) {
  if (v == null) return "";
  return new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}
// Acepta lo que el usuario tipea: "97500,40", "97.500,40", "97500.40", "97,500.40".
export function parseAmountInput(raw: string): number {
  if (!raw) return NaN;
  const cleaned = raw.replace(/\s/g, "").replace(/[^\d.,-]/g, "");
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized: string;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, "");
  } else {
    normalized = cleaned.replace(",", ".");
  }
  return Number(normalized);
}
export function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  // Las fechas son "date-only" guardadas a medianoche UTC (issueDate, dueDate,
  // paymentDate). Se formatean en UTC para no restar el offset de AR (UTC-3),
  // que mostraría el día anterior.
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-AR", { timeZone: "UTC" });
}
export function toInputDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}
export function todayInputDate(): string {
  // Fecha local (no UTC): en la madrugada AR, toISOString() devolvería el día anterior.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
