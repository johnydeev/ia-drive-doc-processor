import { isMissingAmount, cuitAppearsInText, appendNoAmountTag } from "@/lib/documentValidation";

let ok = 0, fail = 0;
function check(cond: boolean, label: string) {
  if (cond) { ok++; console.log(`✓ ${label}`); }
  else { fail++; console.log(`✗ ${label}`); }
}

// isMissingAmount: null/undefined = sin monto; 0 = válido (boletas LSP de $0).
check(isMissingAmount(null) === true, "null → sin monto");
check(isMissingAmount(undefined) === true, "undefined → sin monto");
check(isMissingAmount(0) === false, "0 → NO es sin monto (monto válido)");
check(isMissingAmount(118000) === false, "118000 → no sin monto");

// cuitAppearsInText
check(cuitAppearsInText("30-65511651-2", "Emisor CUIT 30-65511651-2 Responsable") === true, "CUIT con guiones presente");
check(cuitAppearsInText("30655116512", "...30 65511651 2...") === true, "CUIT con espacios presente");
check(cuitAppearsInText("30-71771550-7", "Certificado de revisión Nº 2606684, sin CUIT") === false, "CUIT ausente (inventado)");
check(cuitAppearsInText(null, "cualquier texto") === false, "CUIT null → false");
check(cuitAppearsInText("123", "el numero 123 aparece") === false, "CUIT corto (<10) → false");

// appendNoAmountTag
check(appendNoAmountTag("Certificado de revisión.pdf") === "Certificado de revisión - SIN MONTO.pdf", "tag con extensión");
check(appendNoAmountTag("sin_extension") === "sin_extension - SIN MONTO", "tag sin extensión");
check(appendNoAmountTag("a.b.pdf") === "a.b - SIN MONTO.pdf", "tag con múltiples puntos");

console.log(`\n${ok} ok, ${fail} fail`);
if (fail > 0) process.exit(1);
