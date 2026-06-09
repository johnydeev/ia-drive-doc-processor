/**
 * Helpers puros del timing del scheduler (separados de scheduler.ts para testear
 * sin arrancar el proceso, que tiene side-effects de top-level).
 *
 * Modelo: el scheduler despierta como MUCHO cada MIN_INTERVAL_MINUTES (nunca más
 * seguido). Ese es también el menor intervalo por cliente posible. Un cliente con
 * intervalo mayor (10, 15 min) saltea ticks vía shouldEvaluateClient.
 * `intervalMinutes` se lee del DB en cada ciclo → cambiarlo toma efecto al próximo
 * tick, sin reiniciar.
 */

/** Mínimos obligatorios (piso). Aunque el DB tenga un valor menor, se respeta esto. */
export const MIN_INTERVAL_MINUTES = 5;
export const MIN_BATCH_SIZE = 1;

/**
 * Frecuencia del setInterval del scheduler. = MIN_INTERVAL_MINUTES: el scheduler
 * NO despierta más seguido que cada 5 min. Clientes con intervalo mayor saltean ticks.
 */
export const SCHEDULER_TICK_MS = MIN_INTERVAL_MINUTES * 60 * 1000;

/**
 * Tolerancia para el drift del setInterval: si un tick llega unos segundos antes
 * del vencimiento, igual cuenta. Evita saltar un ciclo (y duplicar el intervalo
 * real) cuando el intervalo del cliente coincide con el tick.
 */
const TICK_TOLERANCE_MS = 30 * 1000;

/**
 * Intervalo efectivo de un cliente en ms: su intervalMinutes (o el default si no
 * tiene), con piso de MIN_INTERVAL_MINUTES.
 */
export function resolveClientIntervalMs(intervalMinutes: number, defaultMinutes: number): number {
  const raw = intervalMinutes > 0 ? intervalMinutes : defaultMinutes;
  const mins = Math.max(MIN_INTERVAL_MINUTES, raw);
  return mins * 60 * 1000;
}

/** Tamaño de lote efectivo, con piso de MIN_BATCH_SIZE. */
export function resolveBatchSize(batchSize: number): number {
  return Math.max(MIN_BATCH_SIZE, Math.floor(batchSize) || 0);
}

/**
 * ¿Corresponde evaluar al cliente ahora? Corre si nunca corrió, o si ya pasó su
 * intervalo (con tolerancia de drift para que el tick que llega un toque antes
 * no saltee el ciclo).
 */
export function shouldEvaluateClient(now: number, lastRun: number, intervalMs: number): boolean {
  if (lastRun <= 0) return true;
  return now - lastRun >= intervalMs - TICK_TOLERANCE_MS;
}
