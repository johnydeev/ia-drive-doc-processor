// Tipos compartidos de la UI de consorcios. Movidos desde page.tsx sin cambios.

export type Period = { id: string; year: number; month: number; status: "ACTIVE" | "CLOSED" };
export type Coeficiente = { id: string; name: string; value: number };
export type Rubro = { id: string; name: string };
export type Consortium = {
  id: string; canonicalName: string; rawName: string; cuit: string | null; cutoffDay: number;
  matchNames: string | null; bank: string | null; statementsFolderUrl: string | null;
  periods: Period[]; _count: { invoices: number };
  activePeriodInvoiceCount: number; activePeriodDebt: number; totalDebt: number;
};
export type Provider = {
  id: string; canonicalName: string; cuit: string | null; paymentAlias: string | null;
  providerType?: "PROVEEDOR" | "EMPLEADO";
};
export type Invoice = {
  id: string; boletaNumber: string | null; provider: string | null; providerTaxId: string | null;
  detail: string | null; observation: string | null; issueDate: string | null; dueDate: string | null;
  amount: number | null; isDuplicate: boolean; isManual: boolean; sourceFileUrl: string | null;
  tipoGasto: string; tipoComprobante: string | null; createdAt: string;
  coeficienteRef: { id: string; name: string; value: number } | null;
  rubroRef: { id: string; name: string } | null;
  isPaid: boolean;
  remainingBalance: number | null;
  lspServiceId: string | null;
  providerType?: "PROVEEDOR" | "EMPLEADO";
};
export type ScannedData = {
  boletaNumber: string | null; provider: string | null; providerTaxId: string | null;
  detail: string | null; observation: string | null; issueDate: string | null;
  dueDate: string | null; amount: number | null; tipoComprobante: string | null;
};
export type InvoiceForm = {
  providerId: string; boletaNumber: string; providerTaxId: string;
  detail: string; observation: string; issueDate: string; dueDate: string;
  amount: string; coeficienteId: string; newCoefName: string; newCoefValue: string;
  rubroId: string; newRubroName: string;
  tipoGasto: string; tipoComprobante: string;
};
export type LspService = {
  id: string; providerName: string; clientNumber: string; description: string | null;
};
export type ThemeMode = "dark" | "light";
export type CloseAllPreview = {
  majorityMonth: string | null;
  nextMonth: string | null;
  toClose: { id: string; canonicalName: string; currentPeriod: string; pendingObligations?: number }[];
  toSkip: { id: string; canonicalName: string; currentPeriod: string }[];
};
export type FixedExpenseRow = {
  id: string; providerId: string | null; lspServiceId: string | null;
  description: string | null; active: boolean;
};
export type ObligationRow = {
  id: string;
  status: "PENDING" | "RECEIVED" | "SKIPPED" | "NOT_RECEIVED";
  fixedExpense: {
    description: string | null;
    provider: { canonicalName: string } | null;
    lspService: { providerName: string; clientNumber: string } | null;
  };
  invoice: { id: string; isPaid: boolean; sourceFileUrl: string | null } | null;
};
