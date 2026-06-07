import {
  sanitizeName, buildStatementPeriodFolderName, buildInvoiceFileName, buildReceiptFileName,
} from "@/lib/statementsNaming";

let ok = 0, fail = 0;
function eq(actual: string, expected: string, label: string) {
  if (actual === expected) { ok++; console.log(`✓ ${label}`); }
  else { fail++; console.log(`✗ ${label}\n   esperado: ${expected}\n   actual:   ${actual}`); }
}

eq(buildStatementPeriodFolderName(6, 2026), "2026-06 Junio", "periodo junio");
eq(buildStatementPeriodFolderName(12, 2026), "2026-12 Diciembre", "periodo diciembre");
eq(sanitizeName("AySA/Edesur: 2024"), "AySA Edesur 2024", "sanitizar");

eq(
  buildInvoiceFileName({ provider: "MATAFUEGOS GOMEZ", consortium: "JUNIN 1222", month: 6, year: 2026, boletaNumber: "0005-00009460", documentHash: "abc123def456" }),
  "MATAFUEGOS GOMEZ - JUNIN 1222 - P06-2026 - 0005-00009460.pdf", "boleta con N°"
);
eq(
  buildInvoiceFileName({ provider: "X", consortium: "Y", month: 6, year: 2026, boletaNumber: null, documentHash: "a3f9c2zzzz" }),
  "X - Y - P06-2026 - SN a3f9c2.pdf", "boleta sin N°"
);

const d = new Date(2026, 5, 15); // 15-06-2026
eq(
  buildReceiptFileName({ provider: "X", consortium: "Y", month: 6, year: 2026, boletaNumber: "0005-00009460", documentHash: "h", paymentDate: d, amount: 721571, saldaTotal: true }),
  "X - Y - P06-2026 - 0005-00009460 - RECIBO 15-06-2026.pdf", "recibo único"
);
eq(
  buildReceiptFileName({ provider: "X", consortium: "Y", month: 6, year: 2026, boletaNumber: "0005-00009460", documentHash: "h", paymentDate: d, amount: 240000, installmentNumber: 1, totalInstallments: 3, saldaTotal: false }),
  "X - Y - P06-2026 - 0005-00009460 - RECIBO cuota 1 de 3 - 15-06-2026.pdf", "recibo cuota"
);
eq(
  buildReceiptFileName({ provider: "X", consortium: "Y", month: 6, year: 2026, boletaNumber: "0005-00009460", documentHash: "h", paymentDate: d, amount: 250000, saldaTotal: false }),
  "X - Y - P06-2026 - 0005-00009460 - RECIBO pago parcial - 15-06-2026 - $250000.pdf", "recibo parcial libre"
);

console.log(`\n${ok} ok, ${fail} fail`);
if (fail > 0) process.exit(1);
