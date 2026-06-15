export interface ExtractedDocumentData {
  boletaNumber: string | null;
  provider: string | null;
  consortium: string | null;
  providerTaxId: string | null;
  detail: string | null;
  observation: string | null;
  dueDate: string | null;
  amount: number | null;
  alias: string | null;
  clientNumber: string | null;
  paymentMethod: string | null;
  allTaxIds?: string[] | null;
  /** La IA juzga si el documento es una boleta/factura/recibo (capa 2 del triage). */
  isBoleta?: boolean | null;
  period?: string | null;
  sourceFileUrl?: string | null;
  isDuplicate?: "YES" | "NO" | null;
  paymentStatus?: string | null;
  bank?: string | null;
  remainingBalance?: number | string | null;
  paidAmount?: number | string | null;
  installmentsCount?: string | null;
  paymentDate?: string | null;
  receiptUrl?: string | null;
  paidWith?: string | null;
}