/**
 * Cálculo del próximo reset de cuota diaria de la IA.
 *
 * El free tier de Gemini renueva los baldes diarios a la MEDIANOCHE del
 * Pacífico (America/Los_Angeles). El horario UTC varía con el DST (07:00 UTC
 * en verano PDT, 08:00 UTC en invierno PST), por eso se calcula con Intl en
 * vez de hardcodear un offset.
 */

/** Margen para no despertar exactamente en el instante del reset. */
const QUOTA_RESET_BUFFER_MS = 5 * 60_000;

/** Offset (en minutos) de una zona horaria respecto de UTC en un instante dado. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return (asUtc - date.getTime()) / 60_000;
}

/**
 * Próximo reset de cuota (medianoche siguiente en America/Los_Angeles) + 5 min
 * de buffer, como instante UTC. DST-safe.
 */
export function nextQuotaResetUtc(now: Date = new Date()): Date {
  // Fecha calendario actual en LA (YYYY-MM-DD)
  const laDate = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const [y, m, d] = laDate.split("-").map(Number);

  // Medianoche LA del día siguiente = medianoche UTC de ese día menos el offset
  // de LA en ese instante (offset negativo → se suman horas).
  const nextDayUtcMidnight = Date.UTC(y, m - 1, d + 1);
  const offset = tzOffsetMinutes(new Date(nextDayUtcMidnight), "America/Los_Angeles");
  let result = new Date(nextDayUtcMidnight - offset * 60_000);

  // Si justo cae en una frontera de DST, el offset del resultado puede diferir
  // del estimado: recalcular una vez con el instante corregido.
  const offsetCheck = tzOffsetMinutes(result, "America/Los_Angeles");
  if (offsetCheck !== offset) {
    result = new Date(nextDayUtcMidnight - offsetCheck * 60_000);
  }

  return new Date(result.getTime() + QUOTA_RESET_BUFFER_MS);
}
