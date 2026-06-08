import { readFileSync } from "fs";

// Uso: npx tsx scripts/analyze-metrics.ts logs/<archivo>_worker.txt
const path = process.argv[2];
if (!path) { console.error("Falta el path del log"); process.exit(1); }

const raw = readFileSync(path, "utf8");
const rows: any[] = [];
for (const line of raw.split(/\r?\n/)) {
  const i = line.indexOf("[metrics] ");
  if (i === -1) continue;
  const jsonStr = line.slice(i + "[metrics] ".length).trim();
  try { rows.push(JSON.parse(jsonStr)); } catch { /* línea cortada, ignorar */ }
}

console.log(`\n=== ${rows.length} boletas con métricas (${path}) ===\n`);

function dist(key: (r: any) => string) {
  const m = new Map<string, number>();
  for (const r of rows) { const k = key(r) ?? "null"; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function pct(n: number) { return `${((n / rows.length) * 100).toFixed(0)}%`; }
function printDist(title: string, d: [string, number][]) {
  console.log(title);
  for (const [k, n] of d) console.log(`  ${k.padEnd(28)} ${String(n).padStart(3)}  (${pct(n)})`);
  console.log("");
}

function stats(vals: number[]) {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, min: s[0], p50: p(0.5), p95: p(0.95), max: s[s.length - 1], avg: Math.round(sum / s.length) };
}
function ms(v?: number) { return v == null ? "-" : `${v}ms`; }

// 1. Resultado / razón
printDist("RESULTADO:", dist((r) => r.result));
const nonOk = rows.filter((r) => r.result !== "ok" && r.result !== "duplicate");
if (nonOk.length) printDist("RAZÓN (no ok):", (() => {
  const m = new Map<string, number>();
  for (const r of nonOk) { const k = r.reason ?? "null"; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
})());

// 2. Fuente de texto
printDist("FUENTE DE TEXTO:", dist((r) => r.textSource));

// 3. IA: proveedor, modelo, latencia, tokens
printDist("IA PROVEEDOR:", dist((r) => r.ai?.provider));
printDist("IA MODELO:", dist((r) => r.ai?.model ?? "null"));

const aiMs = rows.map((r) => r.ms?.ai).filter((v): v is number => typeof v === "number");
const aiStats = stats(aiMs);
if (aiStats) {
  console.log("LATENCIA IA (ms.ai):");
  console.log(`  n=${aiStats.n}  min=${ms(aiStats.min)}  p50=${ms(aiStats.p50)}  p95=${ms(aiStats.p95)}  max=${ms(aiStats.max)}  avg=${ms(aiStats.avg)}`);
  const slow = rows.filter((r) => (r.ms?.ai ?? 0) > 30000)
    .map((r) => `    ${ms(r.ms.ai).padStart(8)}  ${r.ai?.provider}/${r.ai?.model}  ${r.file}`);
  if (slow.length) { console.log(`  OUTLIERS (>30s): ${slow.length}`); console.log(slow.join("\n")); }
  console.log("");
}

const tokTotal = rows.reduce((a, r) => a + (r.ai?.total ?? 0), 0);
const tokIn = rows.reduce((a, r) => a + (r.ai?.in ?? 0), 0);
const tokOut = rows.reduce((a, r) => a + (r.ai?.out ?? 0), 0);
console.log(`TOKENS: total=${tokTotal}  in=${tokIn}  out=${tokOut}  prom/boleta=${rows.length ? Math.round(tokTotal / rows.length) : 0}\n`);

// 4. Desglose de tiempos (promedios)
const stepKeys = ["download", "text", "textPage1", "ocr", "dedupHash", "ai", "dedupKey", "assign", "sheets", "move", "save", "total"];
console.log("TIEMPOS POR PASO (avg / p95 / max, solo boletas que lo tienen):");
for (const k of stepKeys) {
  const vals = rows.map((r) => r.ms?.[k]).filter((v): v is number => typeof v === "number");
  const st = stats(vals);
  if (st) console.log(`  ${k.padEnd(11)} n=${String(st.n).padStart(2)}  avg=${ms(st.avg).padStart(8)}  p95=${ms(st.p95).padStart(8)}  max=${ms(st.max).padStart(8)}`);
}
console.log("");

// 5. Métodos de match
printDist("MATCH CONSORCIO:", dist((r) => r.match?.consortium ?? "null"));
printDist("MATCH PROVEEDOR:", dist((r) => r.match?.provider ?? "null"));

// 6. OCR: cuántas y cuánto
const ocrUsed = rows.filter((r) => (r.ms?.ocr ?? 0) > 0);
console.log(`OCR: se usó en ${ocrUsed.length}/${rows.length} (${pct(ocrUsed.length)})`);
if (ocrUsed.length) {
  const st = stats(ocrUsed.map((r) => r.ms.ocr));
  console.log(`  ms OCR: avg=${ms(st!.avg)} p95=${ms(st!.p95)} max=${ms(st!.max)}`);
  for (const r of ocrUsed) console.log(`    ${ms(r.ms.ocr).padStart(8)} src=${r.textSource} emitter=${r.emitterBlock} ${r.file}`);
}
console.log("");

// 7. Calidad (solo si hay bloque values con debug): extraído vs canónico
const withValues = rows.filter((r) => r.values?.extracted);
if (withValues.length) {
  console.log(`CALIDAD (debug): ${withValues.length} boletas con valores extraídos`);
  let consDiff = 0, provDiff = 0, taxDiff = 0;
  const norm = (s: any) => (s ?? "").toString().trim().toUpperCase();
  for (const r of withValues) {
    const e = r.values.extracted, c = r.values.canonical ?? {};
    if (c.consortium && norm(e.consortium) !== norm(c.consortium)) consDiff++;
    if (c.provider && norm(e.provider) !== norm(c.provider)) provDiff++;
    if (c.taxId && norm(e.taxId).replace(/\D/g, "") !== norm(c.taxId).replace(/\D/g, "")) taxDiff++;
  }
  console.log(`  IA != canónico → consorcio: ${consDiff}  proveedor: ${provDiff}  CUIT: ${taxDiff} (de ${withValues.length})`);
  console.log("");
} else {
  console.log("CALIDAD: sin bloque `values` (debugMode estaba OFF) — no se puede comparar extraído vs canónico.\n");
}

// Tabla compacta por boleta
console.log("POR BOLETA:");
for (const r of rows) {
  console.log(`  ${(r.result ?? "?").padEnd(10)} ${r.textSource?.padEnd(7) ?? "-"} ai=${ms(r.ms?.ai).padStart(8)} tot=${ms(r.ms?.total).padStart(8)} ${r.ai?.provider}/${r.ai?.model ?? "-"} cons=${r.match?.consortium ?? "-"}/prov=${r.match?.provider ?? "-"} ${r.file}`);
}
