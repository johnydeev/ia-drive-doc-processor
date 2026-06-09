import {
  resolveClientIntervalMs, resolveBatchSize, shouldEvaluateClient,
  SCHEDULER_TICK_MS, MIN_INTERVAL_MINUTES,
} from "@/jobs/schedulerTiming";

let ok = 0, fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { ok++; console.log(`✓ ${label}`); }
  else { fail++; console.log(`✗ ${label}\n   esperado: ${e}\n   actual:   ${a}`); }
}

const BASE = 1_000_000_000; // timestamp realista (nunca 0, como Date.now())
const MIN = 60_000;

// Simula el loop del scheduler: tickMs = cada cuánto despierta el setInterval,
// clientIntervalMin = intervalMinutes del cliente. Devuelve los minutos en que corre.
function simulate(tickMs: number, clientIntervalMin: number, horizonMin: number): number[] {
  const intervalMs = resolveClientIntervalMs(clientIntervalMin, 15);
  let lastRun = 0;
  const runs: number[] = [];
  for (let t = 0; t <= horizonMin * MIN; t += tickMs) {
    const now = BASE + t;
    if (shouldEvaluateClient(now, lastRun, intervalMs)) { runs.push(t / MIN); lastRun = now; }
  }
  return runs;
}

// El scheduler NO despierta más seguido que 5 min.
eq(SCHEDULER_TICK_MS, 5 * MIN, "tick del scheduler = 5 min (no menos)");
eq(MIN_INTERVAL_MINUTES, 5, "intervalo mínimo obligatorio = 5");

// BUG histórico: un tick grueso (15 min) hacía que un cliente de 5 corra cada 15.
eq(simulate(15 * MIN, 5, 45), [0, 15, 30, 45], "BUG repro: tick=15min → cliente de 5min corre cada 15");

// Con tick=5min: el cliente de 5 corre cada 5 (la frecuencia mínima permitida).
eq(simulate(SCHEDULER_TICK_MS, 5, 25), [0, 5, 10, 15, 20, 25], "tick=5min → cliente de 5min corre cada 5");
eq(simulate(SCHEDULER_TICK_MS, 10, 40), [0, 10, 20, 30, 40], "tick=5min → cliente de 10min corre cada 10");
eq(simulate(SCHEDULER_TICK_MS, 15, 45), [0, 15, 30, 45], "tick=5min → cliente de 15min corre cada 15");

// Pisos obligatorios.
eq(resolveClientIntervalMs(2, 15), 5 * MIN, "interval < 5 → 5 (piso)");
eq(resolveClientIntervalMs(0, 3), 5 * MIN, "default < 5 → 5 (piso)");
eq(resolveBatchSize(0), 1, "batch 0 → 1 (piso)");
eq(resolveBatchSize(8), 8, "batch 8 → 8");

// Tolerancia de drift: un tick 5s antes del vencimiento igual evalúa; muy antes no.
eq(shouldEvaluateClient(BASE + 5 * MIN - 5_000, BASE, 5 * MIN), true, "tick 5s antes → evalúa (drift)");
eq(shouldEvaluateClient(BASE + 2 * MIN, BASE, 5 * MIN), false, "2 min antes → NO evalúa");
eq(shouldEvaluateClient(BASE, 0, 5 * MIN), true, "primera vez (lastRun=0) → evalúa");

console.log(`\n${ok} ok, ${fail} fail`);
if (fail > 0) process.exit(1);
