/**
 * Modelo del documento "hoja de obligaciones", como datos puros.
 *
 * Es la ÚNICA fuente que consumen la pantalla y (en la Parte 2) el generador de
 * PDF: si un edificio deja de aparecer, deja de aparecer en los dos lados a la
 * vez. Sin React, sin fetch — se testea sin montar nada.
 */
import { obligationMatchesInvoice } from "@/lib/fixedExpense";
import { parsePaymentAliases } from "@/lib/paymentAliases";

export type ObligationStatus = "PENDING" | "RECEIVED" | "SKIPPED" | "NOT_RECEIVED";
/**
 * Grupo de una fila, para el orden de la hoja: los sueldos primero, después los
 * servicios (número de cliente), después el resto. Sale del `providerType` del
 * proveedor o de que la fila sea un LSP.
 */
export type RowGroup = "EMPLEADO" | "SERVICIO" | "PROVEEDOR";
/** `NO_PERIOD` = el edificio no tiene período activo, así que no hay obligación posible. */
export type SheetStatus = ObligationStatus | "NO_PERIOD";

export type OverviewFixedExpense = {
  id: string;
  providerId: string | null;
  lspServiceId: string | null;
  description: string | null;
  /** FACTURA o RETENCION: la retención del proveedor es un gasto fijo aparte (spec 2026-09-17). */
  kind: "FACTURA" | "RETENCION";
  active: boolean;
  obligation: {
    id: string;
    status: ObligationStatus;
    amount: number | null;
    invoiceId: string | null;
    /** Marcada para pasar al mes siguiente; se mueve al ejecutar las tandas. */
    carryOverRequested: boolean;
    /** Esta boleta vino empujada de un mes anterior. */
    carriedIn: boolean;
    /** Link de Drive del PDF de la boleta, si llegó. */
    invoiceUrl: string | null;
  } | null;
};

export type OverviewLspService = {
  id: string;
  providerName: string;
  clientNumber: string;
  description: string | null;
  providerId: string | null;
};

/**
 * Una boleta que VIVE en este período pero nació en otro: la empujó el owner
 * desde el mes anterior. Es el único cruce de meses que existe.
 */
export type OverviewCarried = {
  invoiceId: string;
  concepto: string;
  facturas: string | null;
  aliasCbu: string | null;
  originalAmount: number | null;
  lateAmount: number | null;
  fromLabel: string | null;
  /** Marcada para volver a pasar al mes siguiente (arrastre encadenado). */
  carryOverRequested: boolean;
  /** Link de Drive del PDF de la boleta. */
  invoiceUrl?: string | null;
};

/**
 * Boleta del mes que NO ocupa ninguna obligación: la 2ª del mismo proveedor, o
 * la de un proveedor que no es gasto fijo del edificio. `carriedOutTo` la marca
 * si nació acá y el owner la empujó al mes siguiente (el origen la sigue
 * mostrando, sin acciones). `buildSheets` decide en cuál de los dos casos está.
 */
export type OverviewLooseInvoice = {
  invoiceId: string;
  providerId: string | null;
  lspServiceId: string | null;
  docKind: "FACTURA" | "RETENCION";
  concepto: string;
  matchNames: string | null;
  facturas: string | null;
  /** Alias de pago crudo del proveedor (`A|B|C`); se parsea acá. */
  aliasCbu: string | null;
  amount: number | null;
  invoiceUrl: string | null;
  carryOverRequested: boolean;
  createdAt: string;
  carriedOutTo: string | null;
};

export type OverviewConsortium = {
  consortiumId: string;
  consortiumName: string;
  bankId: string | null;
  bankName: string | null;
  bankColor: string | null;
  periodId: string | null;
  periodLabel: string | null;
  /** ACTIVE / CLOSED, o null si el edificio no tiene período de este mes. */
  periodStatus: "ACTIVE" | "CLOSED" | null;
  lspServices: OverviewLspService[];
  fixedExpenses: OverviewFixedExpense[];
  carried?: OverviewCarried[];
  looseInvoices?: OverviewLooseInvoice[];
};

export type OverviewPayload = {
  /** Mes que se está viendo. */
  month: number | null;
  year: number | null;
  monthLabel: string | null;
  providers: Array<{
    id: string;
    canonicalName: string;
    paymentAlias: string | null;
    matchNames: string | null;
    /** Tipo del ALTA. Ausente en payloads viejos → PROVEEDOR. */
    providerType?: RowGroup;
  }>;
  consortiums: OverviewConsortium[];
};

/**
 * Boleta ADICIONAL de un gasto fijo: la 2ª, 3ª… del mismo proveedor en el mes.
 * No es una obligación (no se omite, no vence): es otro gasto a pagar, con su
 * PDF, su recibo y su arrastre. Concepto y alias los hereda de la fila madre.
 */
export type ExtraRow = {
  invoiceId: string;
  /** 2, 3, … (la principal, vinculada a la obligación, es la 1ª). */
  ordinal: number;
  monto: number | null;
  invoiceUrl: string | null;
  carryOverRequested: boolean;
  /** "octubre 2026" si el owner la empujó al mes siguiente; null si vive acá. */
  carriedOutTo: string | null;
};

/**
 * Boleta de un proveedor que NO es gasto fijo del edificio (ticket, trabajo
 * eventual, razón social hermana de un proveedor cargado). Bloque propio,
 * "Otras boletas del mes".
 */
export type OtherRow = {
  invoiceId: string;
  facturas: string | null;
  concepto: string;
  fantasia: string | null;
  monto: number | null;
  aliasCbu: string[];
  invoiceUrl: string | null;
  carryOverRequested: boolean;
  carriedOutTo: string | null;
  group: RowGroup;
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
  /**
   * Nombre de fantasía del proveedor (primer valor de `Provider.matchNames`), debajo
   * de la razón social. Es lo que el administrador reconoce a simple vista y lo que
   * agrupa a los proveedores que facturan bajo varios CUITs por el mismo negocio
   * (Fumigaciones Miguel, Chere Ascensores). Null en filas LSP y si no tiene.
   */
  fantasia: string | null;
  /** Columna MONTO: sale de la boleta vinculada; null mientras no llegó. */
  monto: number | null;
  /** Columna ALIAS - CBU: hasta 3 alias o CBU, uno debajo del otro. */
  aliasCbu: string[];
  status: SheetStatus;
  active: boolean;
  /** Boleta vinculada, si llegó: es lo que se puede pasar al mes siguiente. */
  invoiceId: string | null;
  /** Ya marcada para pasar al mes siguiente. */
  carryOverRequested: boolean;
  /** Esta boleta vino empujada del mes anterior. */
  carriedIn: boolean;
  /** Link de Drive del PDF de la boleta, para la vista previa. Null si no llegó. */
  invoiceUrl: string | null;
  /** Las demás boletas del mes de este mismo gasto fijo, en orden de llegada. */
  extras: ExtraRow[];
  group: RowGroup;
};

/**
 * Fila del bloque "Vienen del mes anterior".
 *
 * No es una `SheetRow`: no sale de un gasto fijo del mes sino de una boleta que
 * el owner empujó desde el mes pasado. Va en un bloque propio —y en una sección
 * aparte del PDF— para distinguir a simple vista qué es del mes y qué viene
 * atrasado.
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
  /** De qué mes vino: "julio 2026" */
  fromLabel: string | null;
  /** Marcada para volver a pasar al mes siguiente. */
  carryOverRequested: boolean;
  /** Link de Drive del PDF, para la vista previa. */
  invoiceUrl: string | null;
};

export type SheetData = {
  consortiumId: string;
  consortiumName: string;
  bankId: string | null;
  bankName: string;
  bankColor: string | null;
  periodId: string | null;
  periodLabel: string | null;
  periodStatus: "ACTIVE" | "CLOSED" | null;
  rows: SheetRow[];
  /** Bloque aparte, debajo de la tabla de gastos fijos. */
  carried: CarriedRow[];
  /** Bloque "Otras boletas del mes": proveedores que no son gasto fijo del edificio. */
  others: OtherRow[];
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

/** Rango del grupo para ordenar: EMPLEADO < SERVICIO < PROVEEDOR. */
const GROUP_RANK: Record<RowGroup, number> = { EMPLEADO: 0, SERVICIO: 1, PROVEEDOR: 2 };

function groupOf(isLsp: boolean, providerType: RowGroup | undefined): RowGroup {
  if (isLsp) return "SERVICIO";
  return providerType === "EMPLEADO" ? "EMPLEADO" : "PROVEEDOR";
}

/**
 * Orden de la hoja, en dos niveles (pedido del owner, 2026-09-18):
 * 1. Las filas CON boleta (hay monto que pagar) van arriba de las que hay que
 *    pedir. Las salteadas debajo de todo lo activo; los desactivados al fondo
 *    (no son parte de lo que hay que pagar, y desactivar es también el camino
 *    para un alta cargada por error).
 * 2. Dentro de cada nivel: empleados → servicios → proveedores, y alfabético.
 */
function compareRows(a: SheetRow, b: SheetRow): number {
  const tier = (r: SheetRow) => {
    if (!r.active) return 3;
    if (r.status === "SKIPPED") return 2;
    return r.invoiceId || r.monto != null ? 0 : 1;
  };
  const byTier = tier(a) - tier(b);
  if (byTier !== 0) return byTier;
  const byGroup = GROUP_RANK[a.group] - GROUP_RANK[b.group];
  if (byGroup !== 0) return byGroup;
  return a.concepto.localeCompare(b.concepto, "es");
}

/** Tope de caracteres del nro. de cliente en pantalla; el completo va en el tooltip y en el PDF. */
export const CLIENT_NUMBER_MAX = 12;

/**
 * Recorta un número de cliente largo para que la columna FACTURA/NRO CLIENTE no
 * empuje a las demás y las dos tablas de la hoja queden alineadas.
 */
export function shortClientNumber(value: string | null, max = CLIENT_NUMBER_MAX): string | null {
  if (value == null) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Rótulo de la columna FACTURA/NRO CLIENTE de una fila de sueldo. */
export const EMPLOYEE_LABEL = "Empleado";

/**
 * Qué va en la columna FACTURA/NRO CLIENTE. El nro. de cliente sólo existe en
 * las filas LSP; en un sueldo la celda quedaba vacía y no se distinguía de un
 * proveedor sin factura. Los encargados se cargan como `EMPLEADO`, así que la
 * fila se rotula "Empleado". Fuente única de pantalla y PDF.
 */
export function facturasLabel(row: { facturas: string | null; group: RowGroup }): string | null {
  if (row.facturas) return row.facturas;
  return row.group === "EMPLEADO" ? EMPLOYEE_LABEL : null;
}

/** Primer nombre de fantasía de `matchNames` (`A|B|C`), o null si no hay ninguno. */
export function firstMatchName(matchNames: string | null | undefined): string | null {
  const first = (matchNames ?? "").split("|").map((n) => n.trim()).find(Boolean);
  return first ?? null;
}

export function buildSheets(payload: OverviewPayload): SheetData[] {
  const providerById = new Map(payload.providers.map((p) => [p.id, p]));

  const sheets = payload.consortiums.map((c) => {
    const lspById = new Map(c.lspServices.map((l) => [l.id, l]));

    // Boletas del mes que no ocupan ninguna obligación: si el edificio tiene un
    // gasto fijo ACTIVO que matchee (mismo criterio que el pipeline), cuelgan de
    // esa fila como adicionales; si no, van a "Otras boletas del mes". Un gasto
    // fijo desactivado no cuenta: su tabla está plegada y no se imprime, y la
    // boleta hay que pagarla igual.
    const extrasByFx = new Map<string, ExtraRow[]>();
    const others: OtherRow[] = [];
    const looseSorted = [...(c.looseInvoices ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const inv of looseSorted) {
      const fx = c.fixedExpenses.find(
        (f) =>
          f.active &&
          obligationMatchesInvoice(
            { providerId: f.providerId, lspServiceId: f.lspServiceId, kind: f.kind },
            { providerId: inv.providerId, lspServiceId: inv.lspServiceId, docKind: inv.docKind }
          )
      );
      if (fx) {
        const list = extrasByFx.get(fx.id) ?? [];
        list.push({
          invoiceId: inv.invoiceId,
          ordinal: list.length + 2,
          monto: inv.amount,
          invoiceUrl: inv.invoiceUrl,
          carryOverRequested: inv.carryOverRequested,
          carriedOutTo: inv.carriedOutTo,
        });
        extrasByFx.set(fx.id, list);
      } else {
        others.push({
          invoiceId: inv.invoiceId,
          facturas: inv.facturas,
          concepto: inv.concepto,
          fantasia: firstMatchName(inv.matchNames),
          group: groupOf(
            Boolean(inv.lspServiceId),
            inv.providerId ? providerById.get(inv.providerId)?.providerType : undefined
          ),
          monto: inv.amount,
          aliasCbu: parsePaymentAliases(inv.aliasCbu),
          invoiceUrl: inv.invoiceUrl,
          carryOverRequested: inv.carryOverRequested,
          carriedOutTo: inv.carriedOutTo,
        });
      }
    }
    others.sort(
      (a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group] || a.concepto.localeCompare(b.concepto, "es")
    );

    const rows: SheetRow[] = c.fixedExpenses.map((fx) => {
      const lsp = fx.lspServiceId ? lspById.get(fx.lspServiceId) ?? null : null;
      const provider = fx.providerId ? providerById.get(fx.providerId) ?? null : null;
      // Para un LSP el alias de pago vive en el proveedor asociado, si lo tiene.
      const lspProvider = lsp?.providerId ? providerById.get(lsp.providerId) ?? null : null;

      const base = lsp
        ? `${lsp.providerName}${lsp.description ? ` — ${lsp.description}` : ""}`
        : provider?.canonicalName ?? fx.description ?? "—";
      const concepto = fx.kind === "RETENCION" ? `${base} — Retención` : base;
      const fantasia = lsp ? null : firstMatchName(provider?.matchNames);

      return {
        fixedExpenseId: fx.id,
        obligationId: fx.obligation?.id ?? null,
        providerId: fx.providerId,
        lspServiceId: fx.lspServiceId,
        facturas: lsp?.clientNumber ?? null,
        concepto,
        fantasia,
        monto: fx.obligation?.amount ?? null,
        aliasCbu: parsePaymentAliases(lsp ? lspProvider?.paymentAlias : provider?.paymentAlias),
        status: c.periodId ? fx.obligation?.status ?? "PENDING" : "NO_PERIOD",
        active: fx.active,
        invoiceId: fx.obligation?.invoiceId ?? null,
        carryOverRequested: fx.obligation?.carryOverRequested ?? false,
        carriedIn: fx.obligation?.carriedIn ?? false,
        invoiceUrl: fx.obligation?.invoiceUrl ?? null,
        extras: extrasByFx.get(fx.id) ?? [],
        group: groupOf(Boolean(lsp), provider?.providerType),
      };
    });

    rows.sort(compareRows);

    // Lo que vino del mes anterior, alfabético.
    const carried: CarriedRow[] = [...(c.carried ?? [])]
      .map((inv) => ({
        invoiceId: inv.invoiceId,
        facturas: inv.facturas,
        concepto: inv.concepto,
        // El monto a pagar es el vencido si se cargó; si no, el original.
        monto: inv.lateAmount ?? inv.originalAmount ?? 0,
        originalAmount: inv.originalAmount,
        lateAmount: inv.lateAmount,
        aliasCbu: parsePaymentAliases(inv.aliasCbu),
        fromLabel: inv.fromLabel,
        carryOverRequested: inv.carryOverRequested,
        invoiceUrl: inv.invoiceUrl ?? null,
      }))
      .sort((a, b) => a.concepto.localeCompare(b.concepto, "es"));

    return {
      consortiumId: c.consortiumId,
      consortiumName: c.consortiumName,
      bankId: c.bankId,
      bankName: c.bankName ?? NO_BANK_LABEL,
      bankColor: c.bankColor,
      periodId: c.periodId,
      periodLabel: c.periodLabel,
      periodStatus: c.periodStatus,
      rows,
      carried,
      others,
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

/** Las adicionales que van al papel: las que siguen viviendo en este mes. */
export function printableExtras(row: SheetRow): ExtraRow[] {
  return row.extras.filter((e) => !e.carriedOutTo);
}

/**
 * ¿Esta hoja tiene algo que imprimir? Cuenta los gastos del mes, las adicionales
 * (aunque su madre esté salteada: llegó una boleta, hay que pagarla), las
 * impagas arrastradas y las otras boletas del mes: un edificio sin gastos fijos
 * pero con una deuda vieja o una boleta eventual igual tiene que salir en el papel.
 */
export function hasPrintableRows(sheet: SheetData): boolean {
  return (
    sheet.rows.some(isPrintableRow) ||
    sheet.rows.some((r) => printableExtras(r).length > 0) ||
    sheet.carried.length > 0 ||
    sheet.others.some((o) => !o.carriedOutTo)
  );
}

/**
 * Las hojas tal como salen impresas: sin filas salteadas ni desactivadas, sin
 * edificios sin período activo y sin edificios que quedarían en blanco (no se
 * gasta papel en una hoja vacía). Una madre no imprimible con adicionales
 * QUEDA: el PDF decide con `isPrintableRow` si imprime su línea o sólo las
 * adicionales. Lo que pasó a otro mes no va. El bloque de impagas viaja
 * intacto. No muta la entrada.
 */
export function toPrintableSheets(sheets: SheetData[]): SheetData[] {
  return sheets
    .map((sheet) => ({
      ...sheet,
      rows: sheet.rows
        .filter((row) => isPrintableRow(row) || printableExtras(row).length > 0)
        .map((row) => ({ ...row, extras: printableExtras(row) })),
      others: sheet.others.filter((o) => !o.carriedOutTo),
    }))
    .filter((sheet) => sheet.rows.length > 0 || sheet.carried.length > 0 || sheet.others.length > 0);
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
    const others = sheet.others.filter((o) => norm(o.concepto).includes(q));
    if (rows.length > 0 || others.length > 0) out.push({ ...sheet, rows, others });
  }
  return out;
}
