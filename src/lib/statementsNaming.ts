const MONTHS_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/** Quita caracteres inválidos para nombres de archivo/carpeta de Drive. */
export function sanitizeName(value: string): string {
  return (value ?? "")
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "2026-06 Junio" — ordena cronológico y es legible. */
export function buildStatementPeriodFolderName(month: number, year: number): string {
  const mm = String(month).padStart(2, "0");
  return `${year}-${mm} ${MONTHS_ES[month - 1] ?? ""}`.trim();
}

function pTag(month: number, year: number): string {
  return `P${String(month).padStart(2, "0")}-${year}`;
}

function fmtDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

/** Nombre de boleta. Sin N°, usa "SN " + 6 chars del hash para unicidad. */
export function buildInvoiceFileName(input: {
  provider: string | null;
  consortium: string | null;
  month: number;
  year: number;
  boletaNumber: string | null;
  documentHash: string;
}): string {
  const prov = sanitizeName(input.provider ?? "SIN PROVEEDOR");
  const cons = sanitizeName(input.consortium ?? "SIN CONSORCIO");
  const num = input.boletaNumber?.trim()
    ? sanitizeName(input.boletaNumber)
    : `SN ${input.documentHash.slice(0, 6)}`;
  return `${prov} - ${cons} - ${pTag(input.month, input.year)} - ${num}.pdf`;
}

/** Nombre de recibo según tipo de pago. */
export function buildReceiptFileName(input: {
  provider: string | null;
  consortium: string | null;
  month: number;
  year: number;
  boletaNumber: string | null;
  documentHash: string;
  paymentDate: Date;
  amount: number;
  installmentNumber?: number | null;
  totalInstallments?: number | null;
  saldaTotal: boolean; // true si el pago salda el total de la boleta
}): string {
  const prov = sanitizeName(input.provider ?? "SIN PROVEEDOR");
  const cons = sanitizeName(input.consortium ?? "SIN CONSORCIO");
  const num = input.boletaNumber?.trim()
    ? sanitizeName(input.boletaNumber)
    : `SN ${input.documentHash.slice(0, 6)}`;
  const base = `${prov} - ${cons} - ${pTag(input.month, input.year)} - ${num}`;
  const fecha = fmtDate(input.paymentDate);

  if ((input.totalInstallments ?? 0) > 1) {
    return `${base} - RECIBO cuota ${input.installmentNumber} de ${input.totalInstallments} - ${fecha}.pdf`;
  }
  if (!input.saldaTotal) {
    const monto = Math.round(input.amount);
    return `${base} - RECIBO pago parcial - ${fecha} - $${monto}.pdf`;
  }
  return `${base} - RECIBO ${fecha}.pdf`;
}
