/**
 * Helpers puros del timing del scheduler (separados de scheduler.ts para testear
 * sin arrancar el proceso, que tiene side-effects de top-level).
 *
 * Modelo (desde 2026-07-02): cada cliente corre en su PROPIO loop independiente
 * (un setTimeout que se reprograma solo), agendado exactamente a su
 * `intervalMinutes` — leído fresco de la DB en cada reprogramación, así que
 * cambiarlo en el panel toma efecto al terminar el ciclo en curso, sin
 * reiniciar el proceso. El log de "Escaneando Drive" y su resultado aparecen,
 * por lo tanto, exactamente cada `intervalMinutes`: no hay un tick global fijo
 * de fondo que imprima de más.
 *
 * Aparte corre un loop de "discovery" (silencioso salvo altas/bajas de
 * clientes) cada CLIENT_DISCOVERY_INTERVAL_MS, que arranca el timer de un
 * cliente nuevo o detiene el de uno desactivado. Su cadencia es un detalle
 * interno y NO es el intervalo de escaneo de ningún cliente.
 */

/** Mínimo obligatorio (piso) para el intervalo de cualquier cliente, aunque el DB tenga un valor menor. */
export const MIN_INTERVAL_MINUTES = 5;
export const MIN_BATCH_SIZE = 1;

/** Cada cuánto se revisan altas/bajas de clientes activos (no es el intervalo de escaneo de ningún cliente). */
export const CLIENT_DISCOVERY_INTERVAL_MS = MIN_INTERVAL_MINUTES * 60 * 1000;

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
