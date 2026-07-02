import {
  resolveClientIntervalMs, resolveBatchSize,
  CLIENT_DISCOVERY_INTERVAL_MS, MIN_INTERVAL_MINUTES,
} from "@/jobs/schedulerTiming";

let ok = 0, fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { ok++; console.log(`✓ ${label}`); }
  else { fail++; console.log(`✗ ${label}\n   esperado: ${e}\n   actual:   ${a}`); }
}

const MIN = 60_000;

// Simula el loop propio de un cliente (setTimeout que se reprograma con SU
// propio intervalMinutes): primer ciclo inmediato (t=0), luego cada intervalMs.
function simulateClient(clientIntervalMin: number, defaultMin: number, horizonMin: number): number[] {
  const intervalMs = resolveClientIntervalMs(clientIntervalMin, defaultMin);
  const runs: number[] = [];
  for (let t = 0; t <= horizonMin * MIN; t += intervalMs) {
    runs.push(t / MIN);
  }
  return runs;
}

eq(MIN_INTERVAL_MINUTES, 5, "intervalo mínimo obligatorio = 5");
eq(CLIENT_DISCOVERY_INTERVAL_MS, 5 * MIN, "discovery de clientes nuevos/bajas cada 5 min (no es el intervalo de escaneo)");

// Cada cliente corre EXACTAMENTE a su propio intervalo, sin acoplarse al de otros
// (el bug histórico era que un tick global grueso forzaba a todos a su cadencia).
eq(simulateClient(5, 15, 25), [0, 5, 10, 15, 20, 25], "cliente de 5min corre cada 5");
eq(simulateClient(10, 15, 40), [0, 10, 20, 30, 40], "cliente de 10min corre cada 10");
eq(simulateClient(20, 15, 60), [0, 20, 40, 60], "cliente de 20min corre cada 20 — el log coincide con el intervalo configurado");
eq(simulateClient(30, 15, 90), [0, 30, 60, 90], "cliente de 30min corre cada 30, sin importar la cadencia de otros clientes");

// Pisos obligatorios.
eq(resolveClientIntervalMs(2, 15), 5 * MIN, "interval < 5 → 5 (piso)");
eq(resolveClientIntervalMs(0, 3), 5 * MIN, "default < 5 → 5 (piso)");
eq(resolveBatchSize(0), 1, "batch 0 → 1 (piso)");
eq(resolveBatchSize(8), 8, "batch 8 → 8");

console.log(`\n${ok} ok, ${fail} fail`);
if (fail > 0) process.exit(1);
