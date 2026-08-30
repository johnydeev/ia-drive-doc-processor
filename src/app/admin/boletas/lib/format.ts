/**
 * Formateo de fechas de la vista "Boletas entrantes".
 *
 * Hay dos clases de fecha y NO se formatean igual:
 *
 * - **Instantes reales** (`createdAt`): un momento en el tiempo. Se muestran en la
 *   zona del que mira, que es lo correcto.
 * - **Fechas "date-only"** (`dueDate`): el vencimiento es un día del calendario, sin
 *   hora. Se guardan a **medianoche UTC**, así que formatearlas en la zona local de
 *   Argentina (UTC-3) las corre 3 horas hacia atrás y muestra **el día anterior**.
 *   Por eso llevan `timeZone: "UTC"`.
 *
 * Mismo criterio que `admin/consortiums/lib/format.ts`.
 */

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

export function formatDateOnly(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-AR", { dateStyle: "short", timeZone: "UTC" });
}
