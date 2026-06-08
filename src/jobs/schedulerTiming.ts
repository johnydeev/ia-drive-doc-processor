/**
 * Helpers puros del timing del scheduler (separados de scheduler.ts para poder
 * testearlos sin arrancar el proceso, que tiene side-effects de top-level).
 *
 * Diseño: el scheduler hace polling a una resolución FINA (SCHEDULER_TICK_MS) y
 * cada cliente corre según su propio `intervalMinutes` (leído del DB en cada
 * ciclo). Antes, el tick era el intervalo global del env → un `intervalMinutes`
 * menor al global nunca se respetaba (quedaba redondeado al tick grueso).
 */

/**
 * Resolución de polling del scheduler. NO es la frecuencia de cada cliente —
 * esa la define `intervalMinutes` (DB). Debe ser ≤ al menor intervalMinutes que
 * se quiera soportar. 60s cubre cualquier intervalo en minutos.
 */
export const SCHEDULER_TICK_MS = 60 * 1000;

/**
 * Mínimos obligatorios (piso). Aunque el DB tenga un valor menor, el scheduler
 * respeta esto: nunca corre más seguido que MIN_INTERVAL_MINUTES ni encola menos
 * de MIN_BATCH_SIZE por ciclo.
 */
export const MIN_INTERVAL_MINUTES = 5;
export const MIN_BATCH_SIZE = 1;

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

/** ¿Corresponde evaluar al cliente ahora? Corre si nunca corrió o si ya pasó su intervalo. */
export function shouldEvaluateClient(now: number, lastRun: number, intervalMs: number): boolean {
  return !(lastRun > 0 && now - lastRun < intervalMs);
}
