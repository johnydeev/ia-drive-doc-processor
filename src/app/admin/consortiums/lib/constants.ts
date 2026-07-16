import { todayInputDate } from "./format";
import type { InvoiceForm } from "./types";

export const TIPOS_COMPROBANTE = [
  "A", "B", "C", "E", "M", "X",
  "Ticket", "Recibo", "Liq. Serv. Público", "Otro",
] as const;

export const TIPOS_GASTO = [
  { value: "ORDINARIO",      label: "Ordinario" },
  { value: "EXTRAORDINARIO", label: "Extraordinario" },
  { value: "PARTICULAR",     label: "Particular" },
] as const;

export const LSP_PROVIDERS = [
  { value: "EDESUR",      label: "Edesur" },
  { value: "AYSA",        label: "AySA" },
  { value: "EDENOR",      label: "Edenor" },
  { value: "METROGAS",    label: "Metrogas" },
  { value: "NATURGY",     label: "Naturgy" },
  { value: "CAMUZZI",     label: "Camuzzi" },
  { value: "LITORAL_GAS", label: "Litoral Gas" },
  { value: "PERSONAL",    label: "Personal" },
] as const;

export const EMPTY_INVOICE_FORM: InvoiceForm = {
  providerId: "", boletaNumber: "", providerTaxId: "", detail: "", observation: "",
  issueDate: todayInputDate(), dueDate: "", amount: "",
  coeficienteId: "", newCoefName: "", newCoefValue: "",
  rubroId: "", newRubroName: "",
  tipoGasto: "ORDINARIO", tipoComprobante: "",
};
