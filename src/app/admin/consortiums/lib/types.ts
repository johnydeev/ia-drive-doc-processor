// Tipos compartidos de la UI de consorcios. Movidos desde page.tsx sin cambios.

export type Period = { id: string; year: number; month: number; status: "ACTIVE" | "CLOSED" };
export type Coeficiente = { id: string; name: string; value: number };
export type Rubro = { id: string; name: string };
export type Bank = {
  id: string; name: string; color: string;
  _count?: { consortiums: number };
};
export type Consortium = {
  id: string; canonicalName: string; rawName: string; cuit: string | null; cutoffDay: number;
  matchNames: string | null; statementsFolderUrl: string | null;
  bankId: string | null;
  bank: { id: string; name: string; color: string } | null;
  bankAlias: string | null; cbu: string | null; accountNumber: string | null;
  branch: string | null; accountType: string | null; accountHolder: string | null;
  periods: Period[]; _count: { invoices: number };
  activePeriodInvoiceCount: number; activePeriodDebt: number; totalDebt: number;
};
/** Grupo de la vista nivel 0. El grupo "Sin banco" usa el id centinela
 *  `UNASSIGNED_BANK_ID` de `groupByBank.ts`, no null: así el header navega igual. */
export type BankGroup = {
  id: string;
  name: string;
  color: string;
  consortiums: Consortium[];
};
export type Provider = {
  id: string; canonicalName: string; cuit: string | null;
  /** Hasta 3 alias o CBU separados por `|`. Parsear con `parsePaymentAliases`. */
  paymentAlias: string | null;
  providerType?: "PROVEEDOR" | "EMPLEADO" | "SERVICIO";
  /** Oficio del catálogo (Pintor, Albañil…). No es el Rubro de la liquidación. */
  oficio?: { name: string } | null;
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
  providerType?: "PROVEEDOR" | "EMPLEADO" | "SERVICIO";
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
  /** `CARRIED_OVER`: llegó la boleta, no se pagó y se arrastró al mes siguiente.
   *  La obligación conserva su `invoiceId` para que el período mantenga la
   *  evidencia del atraso. Ojo: esta unión es manual — TypeScript no avisa si
   *  el enum de Prisma gana un valor y acá falta. */
  status: "PENDING" | "RECEIVED" | "SKIPPED" | "NOT_RECEIVED" | "CARRIED_OVER";
  fixedExpense: {
    description: string | null;
    provider: { canonicalName: string } | null;
    lspService: { providerName: string; clientNumber: string } | null;
  };
  invoice: { id: string; isPaid: boolean; sourceFileUrl: string | null } | null;
};

export type PaymentMode = "cuotas" | "libre";
export type PaymentRecord = {
  id: string; amount: string | number; paymentDate: string;
  installmentNumber: number | null; totalInstallments: number | null;
  paymentType: "TOTAL" | "LIBRE" | "CUOTA" | null;
  paymentMethod: string | null; driveFileUrl: string | null; observation: string | null;
};
export type PayForm = {
  amount: string; paymentDate: string; totalInstallments: string;
  paymentMethod: string; observation: string;
};

// Dominio Config (Tanda 3e): sección abierta del acordeón + form de alta de LSP.
export type ConfigSection = "matchNames" | "bank" | "lsp" | "fixed";
export type LspForm = { provider: string; clientNumber: string; description: string };

// Reporte del sync de directorio. El sync no borra: lo que está en la base y no
// en el ALTA viaja acá como "sobrante" para que el usuario lo vea y decida.
export type SyncOrphan = { id: string; name: string; invoices?: number };
export type SyncEntityReport = { created: number; updated: number; orphans: SyncOrphan[] };
/** Renombre detectado por CUIT, pendiente de que el usuario lo confirme. */
export type SyncPendingRename = {
  entity: "consortium" | "provider";
  id: string;
  from: string;
  to: string;
  cuit: string;
  invoices: number;
  periods: number;
};
export type DirectorySyncReport = {
  consortiums: SyncEntityReport;
  providers: SyncEntityReport;
  rubros: SyncEntityReport;
  coeficientes: SyncEntityReport;
  lspServices: SyncEntityReport;
  pendingRenames: SyncPendingRename[];
  ambiguous: string[];
  warnings: string[];
};

/** Sección Banco del acordeón de Config: banco asignado + datos de la cuenta. */
export type BankAccountForm = {
  bankId: string;
  bankAlias: string;
  cbu: string;
  accountNumber: string;
  branch: string;
  accountType: string;
  accountHolder: string;
};
