/**
 * Modelo del documento "hoja de obligaciones", como datos puros.
 *
 * Es la ÚNICA fuente que consumen la pantalla y (en la Parte 2) el generador de
 * PDF: si un edificio deja de aparecer, deja de aparecer en los dos lados a la
 * vez. Sin React, sin fetch — se testea sin montar nada.
 */
import { parsePaymentAliases } from "@/lib/paymentAliases";

export type ObligationStatus = "PENDING" | "RECEIVED" | "SKIPPED" | "NOT_RECEIVED";
/** `NO_PERIOD` = el edificio no tiene período activo, así que no hay obligación posible. */
export type SheetStatus = ObligationStatus | "NO_PERIOD";

export type OverviewFixedExpense = {
  id: string;
  providerId: string | null;
  lspServiceId: string | null;
  description: string | null;
  active: boolean;
  obligation: { id: string; status: ObligationStatus; amount: number | null } | null;
};

export type OverviewLspService = {
  id: string;
  providerName: string;
  clientNumber: string;
  description: string | null;
  providerId: string | null;
};

/** Una boleta impaga de un período anterior (o ya pasada a este). */
export type OverviewCarried = {
  invoiceId: string;
  concepto: string;
  facturas: string | null;
  aliasCbu: string | null;
  originalAmount: number | null;
  lateAmount: number | null;
  remaining: number;
  fromLabel: string | null;
  /** `year * 100 + month` del período de origen, para ordenar. */
  periodSort: number;
  alreadyCarried: boolean;
  canCarry: boolean;
};

export type OverviewConsortium = {
  consortiumId: string;
  consortiumName: string;
  bankId: string | null;
  bankName: string | null;
  bankColor: string | null;
  periodId: string | null;
  periodLabel: string | null;
  lspServices: OverviewLspService[];
  fixedExpenses: OverviewFixedExpense[];
  carried?: OverviewCarried[];
};

export type OverviewPayload = {
  majorityLabel: string | null;
  providers: Array<{ id: string; canonicalName: string; paymentAlias: string | null }>;
  consortiums: OverviewConsortium[];
};

export type SheetRow = {
  fixedExpenseId: string;
  obligationId: string | null;
  providerId: string | null;
  lspServiceId: string | null;
  /** Columna FACTURAS: número de cliente, sólo en filas LSP. */
  facturas: string | null;
  /** Columna PROVEEDORES Y SERVICIOS. */
  concepto: string;
  /** Columna MONTO: sale de la boleta vinculada; null mientras no llegó. */
  monto: number | null;
  /** Columna ALIAS - CBU: hasta 3 alias o CBU, uno debajo del otro. */
  aliasCbu: string[];
  status: SheetStatus;
  active: boolean;
};

/**
 * Fila del bloque "Impagas de meses anteriores".
 *
 * No es una `SheetRow`: no sale de un gasto fijo del mes sino de una boleta con
 * saldo que quedó de un período anterior. Va en un bloque propio para que la
 * tabla de arriba siga significando "los gastos fijos de este edificio".
 */
export type CarriedRow = {
  invoiceId: string;
  facturas: string | null;
  concepto: string;
  /** Lo que hay que pagar: el saldo, calculado sobre el monto vencido si se cargó. */
  monto: number;
  /** El importe del 1° pago, para mostrarlo al lado cuando hay monto vencido. */
  originalAmount: number | null;
  lateAmount: number | null;
  aliasCbu: string[];
  /** "agosto 2026" */
  fromLabel: string | null;
  /** Ya se pasó a este período (su boleta vive acá). */
  alreadyCarried: boolean;
  /** Se puede pasar: su período es el inmediatamente anterior al activo. */
  canCarry: boolean;
};

export type SheetData = {
  consortiumId: string;
  consortiumName: string;
  bankId: string | null;
  bankName: string;
  bankColor: string | null;
  periodId: string | null;
  periodLabel: string | null;
  rows: SheetRow[];
  /** Bloque aparte, debajo de la tabla de gastos fijos. */
  carried: CarriedRow[];
};

/** Etiqueta del grupo de edificios sin banco asignado. Va último en el orden. */
export const NO_BANK_LABEL = "Sin banco";

function norm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // saca los acentos: "FUMIGACIÓN" matchea con "fumigacion"
    .toLowerCase()
    .trim();
}

export function buildSheets(payload: OverviewPayload): SheetData[] {
  const providerById = new Map(payload.providers.map((p) => [p.id, p]));

  const sheets = payload.consortiums.map((c) => {
    const lspById = new Map(c.lspServices.map((l) => [l.id, l]));

    const rows: SheetRow[] = c.fixedExpenses.map((fx) => {
      const lsp = fx.lspServiceId ? lspById.get(fx.lspServiceId) ?? null : null;
      const provider = fx.providerId ? providerById.get(fx.providerId) ?? null : null;
      // Para un LSP el alias de pago vive en el proveedor asociado, si lo tiene.
      const lspProvider = lsp?.providerId ? providerById.get(lsp.providerId) ?? null : null;

      const concepto = lsp
        ? `${lsp.providerName}${lsp.description ? ` — ${lsp.description}` : ""}`
        : provider?.canonicalName ?? fx.description ?? "—";

      return {
        fixedExpenseId: fx.id,
        obligationId: fx.obligation?.id ?? null,
        providerId: fx.providerId,
        lspServiceId: fx.lspServiceId,
        facturas: lsp?.clientNumber ?? null,
        concepto,
        monto: fx.obligation?.amount ?? null,
        aliasCbu: parsePaymentAliases(lsp ? lspProvider?.paymentAlias : provider?.paymentAlias),
        status: c.periodId ? fx.obligation?.status ?? "PENDING" : "NO_PERIOD",
        active: fx.active,
      };
    });

    // Orden: los desactivados al fondo (no son parte de lo que hay que pagar, y
    // desactivar es también el camino para un alta cargada por error); entre los
    // activos, los LSP primero porque son los que llevan número de cliente; y
    // dentro de cada grupo, alfabético.
    rows.sort((a, b) => {
      const aOff = a.active ? 0 : 1;
      const bOff = b.active ? 0 : 1;
      if (aOff !== bOff) return aOff - bOff;

      const aLsp = a.lspServiceId ? 0 : 1;
      const bLsp = b.lspServiceId ? 0 : 1;
      if (aLsp !== bLsp) return aLsp - bLsp;

      return a.concepto.localeCompare(b.concepto, "es");
    });

    // Impagas de meses anteriores, lo más viejo primero.
    const carried: CarriedRow[] = [...(c.carried ?? [])]
      .sort((a, b) => a.periodSort - b.periodSort)
      .map((inv) => ({
        invoiceId: inv.invoiceId,
        facturas: inv.facturas,
        concepto: inv.concepto,
        monto: inv.remaining,
        originalAmount: inv.originalAmount,
        lateAmount: inv.lateAmount,
        aliasCbu: parsePaymentAliases(inv.aliasCbu),
        fromLabel: inv.fromLabel,
        alreadyCarried: inv.alreadyCarried,
        canCarry: inv.canCarry,
      }));

    return {
      consortiumId: c.consortiumId,
      consortiumName: c.consortiumName,
      bankId: c.bankId,
      bankName: c.bankName ?? NO_BANK_LABEL,
      bankColor: c.bankColor,
      periodId: c.periodId,
      periodLabel: c.periodLabel,
      rows,
      carried,
    };
  });

  // Banco alfabético con "Sin banco" al final; dentro, edificio alfabético.
  return sheets.sort((a, b) => {
    const aNo = a.bankId === null ? 1 : 0;
    const bNo = b.bankId === null ? 1 : 0;
    if (aNo !== bNo) return aNo - bNo;
    const byBank = a.bankName.localeCompare(b.bankName, "es");
    if (byBank !== 0) return byBank;
    return a.consortiumName.localeCompare(b.consortiumName, "es");
  });
}

/**
 * ¿Esta fila va al papel?
 *
 * La pantalla muestra TODO (es la vista de control); el papel es sólo lo que hay
 * que pagar este mes. Esta función es la ÚNICA definición de esa diferencia: la
 * usan el generador de PDF y también `SheetCard`, para marcar la tarjeta que la
 * hoja de estilos de impresión tiene que esconder.
 */
export function isPrintableRow(row: SheetRow): boolean {
  if (!row.active) return false;                 // gasto fijo dado de baja
  if (row.status === "SKIPPED") return false;    // este mes no va
  if (row.status === "NO_PERIOD") return false;  // el edificio no tiene período abierto
  return true;
}

/**
 * ¿Esta hoja tiene algo que imprimir? Cuenta tanto los gastos del mes como las
 * impagas arrastradas: un edificio sin gastos fijos pero con una deuda vieja
 * igual tiene que salir en el papel.
 */
export function hasPrintableRows(sheet: SheetData): boolean {
  return sheet.rows.some(isPrintableRow) || sheet.carried.length > 0;
}

/**
 * Las hojas tal como salen impresas: sin filas salteadas ni desactivadas, sin
 * edificios sin período activo y sin edificios que quedarían en blanco (no se
 * gasta papel en una hoja vacía). El bloque de impagas viaja intacto. No muta la
 * entrada.
 */
export function toPrintableSheets(sheets: SheetData[]): SheetData[] {
  return sheets
    .map((sheet) => ({ ...sheet, rows: sheet.rows.filter(isPrintableRow) }))
    .filter((sheet) => sheet.rows.length > 0 || sheet.carried.length > 0);
}

/**
 * Búsqueda de la barra superior.
 *
 * Si matchea el edificio o el banco, la hoja se muestra entera; si sólo matchea
 * por concepto, se recorta a las filas que matchean (mismo criterio que la
 * búsqueda de la grilla de bancos).
 */
export function filterSheets(sheets: SheetData[], query: string): SheetData[] {
  const q = norm(query);
  if (!q) return sheets;

  const out: SheetData[] = [];
  for (const sheet of sheets) {
    if (norm(sheet.consortiumName).includes(q) || norm(sheet.bankName).includes(q)) {
      out.push(sheet);
      continue;
    }
    const rows = sheet.rows.filter((r) => norm(r.concepto).includes(q));
    if (rows.length > 0) out.push({ ...sheet, rows });
  }
  return out;
}
