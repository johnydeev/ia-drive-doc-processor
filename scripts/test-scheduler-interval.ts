import { resolveClientIntervalMs, resolveBatchSize, shouldEvaluateClient, SCHEDULER_TICK_MS } from "@/jobs/schedulerTiming";

let ok = 0, fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { ok++; console.log(`✓ ${label}`); }
  else { fail++; console.log(`✗ ${label}\n   esperado: ${e}\n   actual:   ${a}`); }
}

const BASE = 1_000_000_000; // timestamp realista (nunca 0, como Date.now())

// Simula el loop del scheduler: tickMs = resolución de polling, clientIntervalMin
// = intervalMinutes del cliente. Devuelve los minutos en que el cliente se evalúa.
function simulate(tickMs: number, clientIntervalMin: number, horizonMin: number): number[] {
  const intervalMs = resolveClientIntervalMs(clientIntervalMin, 15);
  let lastRun = 0;
  const runs: number[] = [];
  for (let t = 0; t <= horizonMin * 60_000; t += tickMs) {
    const now = BASE + t;
    if (shouldEvaluateClient(now, lastRun, intervalMs)) {
      runs.push(t / 60_000);
      lastRun = now;
    }
  }
  return runs;
}

// BUG (lo que pasaba): tick = intervalo global de 15 min → un cliente con
// intervalMinutes=5 corre cada 15, no cada 5. Esto reproduce el defecto.
eq(simulate(15 * 60_000, 5, 45), [0, 15, 30, 45], "BUG repro: tick=15min → cliente de 5min corre cada 15");

// FIX: tick fino (1 min) → el cliente de 5 min corre realmente cada 5.
eq(simulate(SCHEDULER_TICK_MS, 5, 25), [0, 5, 10, 15, 20, 25], "FIX: tick=1min → cliente de 5min corre cada 5");

// FIX: un cliente de 15 min sigue corriendo cada 15 (intervalos grandes intactos).
eq(simulate(SCHEDULER_TICK_MS, 15, 45), [0, 15, 30, 45], "FIX: tick=1min → cliente de 15min corre cada 15");

// Default: intervalMinutes=0/ausente → usa el default del env.
eq(resolveClientIntervalMs(0, 15), 15 * 60_000, "intervalMinutes=0 usa el default (15)");
eq(resolveClientIntervalMs(5, 15), 5 * 60_000, "intervalMinutes=5 usa 5");

// Mínimos obligatorios (piso): interval ≥ 5 min, batch ≥ 1.
eq(resolveClientIntervalMs(2, 15), 5 * 60_000, "interval < 5 se sube a 5 (piso)");
eq(resolveClientIntervalMs(1, 3), 5 * 60_000, "default < 5 también se sube a 5");
eq(resolveBatchSize(0), 1, "batch 0 → 1 (piso)");
eq(resolveBatchSize(1), 1, "batch 1 → 1");
eq(resolveBatchSize(8), 8, "batch 8 → 8");

console.log(`\n${ok} ok, ${fail} fail`);
if (fail > 0) process.exit(1);
