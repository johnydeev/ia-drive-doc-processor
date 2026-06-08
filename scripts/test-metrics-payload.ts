import { buildMetricsPayload } from "@/lib/logger";

let ok = 0, fail = 0;
function check(cond: boolean, label: string) {
  if (cond) { ok++; console.log(`✓ ${label}`); }
  else { fail++; console.log(`✗ ${label}`); }
}

const core = { ts: "x", client: "c", result: "ok", ms: { total: 10 } };
const values = {
  extracted: { amount: 118000, taxId: "30-65511651-2", provider: "EDESUR S.A." },
  canonical: { consortium: "RIVADAVIA 4243" },
  reasonText: "algo",
};

// Sin debug: el núcleo va completo, pero NO debe aparecer `values` ni ninguna PII.
const noDebug = buildMetricsPayload(core, values, false);
check(!("values" in noDebug), "sin debug NO incluye values");
check(!JSON.stringify(noDebug).includes("118000"), "sin debug NO filtra el monto");
check(!JSON.stringify(noDebug).includes("30-65511651-2"), "sin debug NO filtra el CUIT");
check(!JSON.stringify(noDebug).includes("EDESUR"), "sin debug NO filtra el proveedor");
check((noDebug as { result?: string }).result === "ok", "sin debug conserva el núcleo");

// Con debug: incluye el bloque values (con la PII para análisis).
const withDebug = buildMetricsPayload(core, values, true);
check("values" in withDebug, "con debug incluye values");
check(JSON.stringify(withDebug).includes("118000"), "con debug incluye el monto");

// values null: nunca agrega el bloque, ni siquiera con debug=true.
const noValues = buildMetricsPayload(core, null, true);
check(!("values" in noValues), "values null no agrega el bloque (con debug)");

console.log(`\n${ok} ok, ${fail} fail`);
if (fail > 0) process.exit(1);
