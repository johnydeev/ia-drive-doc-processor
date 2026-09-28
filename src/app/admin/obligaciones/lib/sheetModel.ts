/**
 * Modelo del documento "hoja de obligaciones", como datos puros.
 *
 * Es la ÚNICA fuente que consumen la pantalla y el generador de PDF: si un
 * edificio deja de aparecer, deja de aparecer en los dos lados a la vez. Sin
 * React, sin fetch — se testea sin montar nada.
 */
import { obligationMatchesInvoice } from "@/lib/fixedExpense";
import { parsePaymentAliases } from "@/lib/paymentAliases";

/** `CARRIED_OVER`: su boleta pasó al mes siguiente; el origen la muestra, sin contarla. */
export type ObligationStatus = "PENDING" | "RECEIVED" | "SKIPPED" | "NOT_RECEIVED" | "CARRIED_OVER";
/**
 * Grupo de una fila. Desde `groupByRubro` (parte 2) ya no ordena la hoja —eso
 * lo hace la sección de rubro—; hoy sólo se usa para que `facturasLabel`
 * rotule "Empleado" en la columna FACTURA/NRO CLIENTE de un sueldo. Sale del
 * `providerType` del proveedor o de que la fila sea un LSP.
 */
export type RowGroup = "EMPLEADO" | "SERVICIO" | "PROVEEDOR";
/** `NO_PERIOD` = el edificio no tiene período activo, así que no hay obligación posible. */
export type SheetStatus = ObligationStatus | "NO_PERIOD";

/** Rubro que usa el edificio: el número y el nombre con los que se titula la sección. */
export type RubroInfo = { id: string; order: number | null; name: string };
/**
 * Columna de importe de la hoja (spec 2026-09-24). `id: null` = columna única de
 * respaldo para un edificio sin coeficientes asignados (decisión D9).
 */
export type CoefColumn = { id: string | null; code: string };
export const FALLBACK_COLUMN: CoefColumn = { id: null, code: "MONTO" };
export const NO_RUBRO_TITLE = "SIN RUBRO";
export const GRAND_TOTAL_LABEL = "TOTAL DEL MES";

export type OverviewFixedExpense = {
  id: string;
  providerId: string | null;
  lspServiceId: string | null;
  description: string | null;
  /** FACTURA o RETENCION: la retención del proveedor es un gasto fijo aparte (spec 2026-09-17). */
  kind: "FACTURA" | "RETENCION";
  active: boolean;
  /** Etiqueta del gasto fijo. Opcional: payloads viejos / fixtures de test no la traen. */
  rubroId?: string | null;
  coeficienteId?: string | null;
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
    /** Etiqueta propia de la boleta vinculada; manda sobre la del gasto fijo (D4). */
    invoiceRubroId?: string | null;
    invoiceCoeficienteId?: string | null;
    /** Nro. de la factura vinculada: va en FACTURA/NRO CLIENTE cuando no es un servicio. */
    invoiceBoletaNumber?: string | null;
    /** Con status CARRIED_OVER: a qué mes pasó la boleta ("octubre 2026"). */
    invoiceCarriedOutTo?: string | null;
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
  /** Etiqueta de la boleta: la sección de rubro y la columna donde va (spec 2026-09-28). */
  rubroId?: string | null;
  coeficienteId?: string | null;
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
  rubroId?: string | null;
  coeficienteId?: string | null;
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
  /** Rubros y coeficientes que usa el edificio. Ausentes → sin secciones / columna MONTO. */
  rubros?: RubroInfo[];
  coeficientes?: Array<{ id: string; code: string }>;
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
 * PDF, su recibo y su arrastre. Concepto y alias los hereda de la fila madre y
 * se muestra con ese mismo nombre, pegada a ella; lo que la distingue es su
 * factura, su monto y, si se le cargó, su propia etiqueta.
 */
export type ExtraRow = {
  invoiceId: string;
  /** Nro. de la factura (o de cliente, si es un servicio). */
  facturas: string | null;
  monto: number | null;
  invoiceUrl: string | null;
  carryOverRequested: boolean;
  /** "octubre 2026" si el owner la empujó al mes siguiente; null si vive acá. */
  carriedOutTo: string | null;
  /**
   * Etiqueta PROPIA de la boleta; null = hereda la de la madre (`extraLabels`).
   * Con otro rubro que la madre, `groupByRubro` la lleva a esa sección.
   */
  rubroId?: string | null;
  coeficienteId?: string | null;
};

/** Rubro y coeficiente que valen para una adicional: los suyos, o los de su madre. */
export function extraLabels(row: SheetRow, extra: ExtraRow): { rubroId: string | null; coeficienteId: string | null } {
  return {
    rubroId: extra.rubroId ?? row.rubroId ?? null,
    coeficienteId: extra.coeficienteId ?? row.coeficienteId ?? null,
  };
}

/**
 * Boleta de un proveedor que NO es gasto fijo del edificio (ticket, trabajo
 * eventual, razón social hermana de un proveedor cargado). No tiene bloque
 * propio: `groupByRubro` la mete en su sección de rubro con el distintivo
 * "eventual" (D6).
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
  /** Rubro y coeficiente que valen para esta fila (D4). Ausentes = sin etiqueta. */
  rubroId?: string | null;
  coeficienteId?: string | null;
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
  /**
   * Obligación CARRIED_OVER: su boleta pasó a otro mes ("octubre 2026"). La fila
   * queda de rendición: atenuada, sin acciones, no suma ni se imprime.
   */
  carriedOutTo: string | null;
  /** Las demás boletas del mes de este mismo gasto fijo, en orden de llegada. */
  extras: ExtraRow[];
  group: RowGroup;
  /** Rubro y coeficiente que valen para esta fila (D4). Ausentes = sin etiqueta. */
  rubroId?: string | null;
  coeficienteId?: string | null;
};

/**
 * Boleta impaga que vino empujada del mes anterior.
 *
 * No es una `SheetRow`: no sale de un gasto fijo del mes sino de una boleta que
 * el owner empujó desde el mes pasado. `groupByRubro` la mete en la sección de
 * su rubro con el distintivo "de septiembre" y la suma (spec 2026-09-28, revierte
 * el bloque aparte "Vienen del mes anterior").
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
  /** Rubro y coeficiente de la boleta. Sin rubro (o uno que el edificio no usa) → "Sin rubro". */
  rubroId: string | null;
  coeficienteId: string | null;
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
  /** Arrastradas del mes anterior. `groupByRubro` las reparte en su sección de rubro. */
  carried: CarriedRow[];
  /** Boletas eventuales: proveedores que no son gasto fijo del edificio. `groupByRubro`
   * las reparte en su sección de rubro (D6), no forman un bloque propio. */
  others: OtherRow[];
  /** Rubros del edificio en orden de impresión: son las secciones. */
  rubros: RubroInfo[];
  /** Columnas de importe, por código (A, B, C, EXTRA). Nunca vacío: ver FALLBACK_COLUMN. */
  coefColumns: CoefColumn[];
};

/** Lo que va dentro de una sección: una fila del padrón o una boleta eventual (D6). */
/**
 * `extra`: adicional con un rubro distinto al de su madre. Va suelta en SU sección,
 * con el nombre de la madre (las que comparten rubro viajan en `row.extras`).
 * `carried`: impaga arrastrada del mes anterior (spec 2026-09-28).
 */
export type SectionItem =
  | { kind: "row"; row: SheetRow }
  | { kind: "other"; other: OtherRow }
  | { kind: "extra"; row: SheetRow; extra: ExtraRow }
  | { kind: "carried"; carried: CarriedRow };

export type RubroSection = {
  /** null = "Sin rubro". */
  rubroId: string | null;
  /** "3 SERVICIOS PÚBLICOS" */
  title: string;
  /** "TOTAL RUBRO 3" — como en la liquidación. */
  totalLabel: string;
  items: SectionItem[];
  /** Un total por columna, en el orden de `coefColumns`. */
  totals: number[];
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

function groupOf(isLsp: boolean, providerType: RowGroup | undefined): RowGroup {
  if (isLsp) return "SERVICIO";
  return providerType === "EMPLEADO" ? "EMPLEADO" : "PROVEEDOR";
}

/**
 * Tope de caracteres del nro. de cliente o de factura en pantalla; el completo va
 * en el tooltip y en el PDF. 14 = un nro. de factura entero (`00003-00001234`).
 */
export const CLIENT_NUMBER_MAX = 14;

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

/** Número ascendente; los rubros sin número al final, alfabéticos. */
function sortRubros(rubros: RubroInfo[]): RubroInfo[] {
  return [...rubros].sort((a, b) => {
    if (a.order == null && b.order != null) return 1;
    if (a.order != null && b.order == null) return -1;
    return (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, "es");
  });
}

/** Columnas por código (A, B, C, EXTRA); sin coeficientes, la columna única MONTO. */
function toColumns(coefs: Array<{ id: string; code: string }>): CoefColumn[] {
  if (coefs.length === 0) return [FALLBACK_COLUMN];
  return [...coefs]
    .sort((a, b) => a.code.localeCompare(b.code, "es", { numeric: true }))
    .map((k) => ({ id: k.id, code: k.code }));
}

/** En qué columna va el importe: la de su coeficiente, o la primera si no tiene (spec). */
export function columnIndex(columns: CoefColumn[], coeficienteId: string | null | undefined): number {
  const i = columns.findIndex((c) => c.id !== null && c.id === coeficienteId);
  return i >= 0 ? i : 0;
}

/**
 * Sólo el mes de un rótulo de período: "septiembre 2026" → "septiembre". Los
 * distintivos "de septiembre" / "pasó a octubre" no llevan año (spec 2026-09-28).
 */
export function monthOnly(label: string | null): string | null {
  if (label == null) return null;
  const first = label.trim().split(/\s+/)[0];
  return first ? first : null;
}

export function rubroTitle(r: RubroInfo): string {
  return r.order != null ? `${r.order} ${r.name}` : r.name;
}

/** Marca de la celda de una fila pendiente (D12): dónde va a caer el monto. */
export const PENDING_MARK = "—";

/** ¿La fila lleva la marca de pendiente en su columna? Fuente única de pantalla y PDF. */
export function showsPendingMark(row: SheetRow): boolean {
  return row.active && row.status === "PENDING" && !row.invoiceId && row.monto == null;
}

export function buildSheets(payload: OverviewPayload): SheetData[] {
  const providerById = new Map(payload.providers.map((p) => [p.id, p]));

  const sheets = payload.consortiums.map((c) => {
    const lspById = new Map(c.lspServices.map((l) => [l.id, l]));

    // Boletas del mes que no ocupan ninguna obligación: si el edificio tiene un
    // gasto fijo ACTIVO que matchee (mismo criterio que el pipeline), cuelgan de
    // esa fila como adicionales; si no, van como eventual a su sección de rubro
    // (`groupByRubro`, D6). Un gasto
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
          facturas: inv.facturas,
          monto: inv.amount,
          invoiceUrl: inv.invoiceUrl,
          carryOverRequested: inv.carryOverRequested,
          carriedOutTo: inv.carriedOutTo,
          rubroId: inv.rubroId ?? null,
          coeficienteId: inv.coeficienteId ?? null,
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
          rubroId: inv.rubroId ?? null,
          coeficienteId: inv.coeficienteId ?? null,
        });
      }
    }
    // El orden de verdad lo pone `groupByRubro` dentro de cada sección.
    others.sort((a, b) => a.concepto.localeCompare(b.concepto, "es"));

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
        // Servicio: su nro. de cliente. Resto: el nro. de la factura del mes, si llegó.
        facturas: lsp?.clientNumber ?? fx.obligation?.invoiceBoletaNumber ?? null,
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
        carriedOutTo: fx.obligation?.invoiceCarriedOutTo ?? null,
        extras: extrasByFx.get(fx.id) ?? [],
        group: groupOf(Boolean(lsp), provider?.providerType),
        rubroId: fx.obligation?.invoiceRubroId ?? fx.rubroId ?? null,
        coeficienteId: fx.obligation?.invoiceCoeficienteId ?? fx.coeficienteId ?? null,
      };
    });

    rows.sort((a, b) => a.concepto.localeCompare(b.concepto, "es"));

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
        rubroId: inv.rubroId ?? null,
        coeficienteId: inv.coeficienteId ?? null,
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
      rubros: sortRubros(c.rubros ?? []),
      coefColumns: toColumns(c.coeficientes ?? []),
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
  if (row.status === "CARRIED_OVER") return false; // su boleta se paga en otro mes
  return true;
}

/** Las adicionales que van al papel: las que siguen viviendo en este mes. */
export function printableExtras(row: SheetRow): ExtraRow[] {
  return row.extras.filter((e) => !e.carriedOutTo);
}

/**
 * ¿Este ítem de una sección va al papel? Mismo criterio que `toPrintableSheets`,
 * pero por ítem: una madre salteada (o pasada a otro mes) cuya única adicional
 * imprimible cayó en OTRO rubro queda en su sección con `extras: []` — cuenta
 * como ítem pero no imprime nada. La pantalla y el PDF lo usan para no dejar una
 * sección con título y total y sin ninguna fila.
 */
export function isItemPrintable(item: SectionItem): boolean {
  switch (item.kind) {
    case "row":
      return isPrintableRow(item.row) || printableExtras(item.row).length > 0;
    case "extra":
      return !item.extra.carriedOutTo;
    case "carried":
      return true; // la arrastrada es deuda a pagar este mes: siempre va
    case "other":
      return !item.other.carriedOutTo;
  }
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
 * adicionales. Lo que pasó a otro mes no va. Las impagas arrastradas viajan
 * intactas. No muta la entrada.
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
    const carried = sheet.carried.filter((c) => norm(c.concepto).includes(q));
    if (rows.length > 0 || others.length > 0 || carried.length > 0) out.push({ ...sheet, rows, others, carried });
  }
  return out;
}

/**
 * Tramo dentro de la sección: con boleta (0), pendiente (1), salteada o pasada a
 * otro mes (2). Una eventual y una arrastrada siempre traen boleta.
 */
function itemTier(item: SectionItem): number {
  if (item.kind !== "row") return 0;
  if (item.row.status === "SKIPPED" || item.row.status === "CARRIED_OVER") return 2;
  return item.row.invoiceId || item.row.monto != null ? 0 : 1;
}

function itemConcepto(item: SectionItem): string {
  if (item.kind === "other") return item.other.concepto;
  if (item.kind === "carried") return item.carried.concepto;
  return item.row.concepto;
}

/**
 * La hoja en secciones de rubro, como la liquidación (spec 2026-09-24, Parte 2).
 *
 * - Una sección por rubro asignado al edificio, en su orden, aunque esté vacía:
 *   es el checklist del mes (el PDF omite las vacías, decisión D3).
 * - "Sin rubro" al final, sólo si tiene algo: lo que no tiene rubro y lo que tiene
 *   uno que el edificio ya no usa.
 * - Los desactivados no entran: viven en su bloque plegado.
 * - Totales por columna de coeficiente; una fila sin coeficiente suma en la primera;
 *   una adicional en la de su propio coeficiente, o el de su madre si no tiene;
 *   lo que pasó a otro mes no suma; lo que vino del mes anterior sí.
 *
 * Pura: la consumen la pantalla y el PDF, así ven exactamente lo mismo.
 */
export function groupByRubro(sheet: SheetData): RubroSection[] {
  const columns = sheet.coefColumns.length > 0 ? sheet.coefColumns : [FALLBACK_COLUMN];
  const assigned = new Set(sheet.rubros.map((r) => r.id));
  const buckets = new Map<string | null, SectionItem[]>();
  const bucketOf = (rubroId: string | null | undefined) => (rubroId && assigned.has(rubroId) ? rubroId : null);
  const put = (rubroId: string | null | undefined, item: SectionItem) => {
    const key = bucketOf(rubroId);
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  };
  for (const row of sheet.rows) {
    if (!row.active) continue;
    // La adicional acompaña a su madre salvo que tenga otro rubro: ahí va a esa sección.
    const own = row.extras.filter((e) => bucketOf(extraLabels(row, e).rubroId) === bucketOf(row.rubroId));
    put(row.rubroId, { kind: "row", row: own.length === row.extras.length ? row : { ...row, extras: own } });
    for (const extra of row.extras) {
      if (!own.includes(extra)) put(extraLabels(row, extra).rubroId, { kind: "extra", row, extra });
    }
  }
  for (const other of sheet.others) put(other.rubroId, { kind: "other", other });
  for (const carried of sheet.carried) put(carried.rubroId, { kind: "carried", carried });

  const sortItems = (items: SectionItem[]) =>
    [...items].sort((a, b) => itemTier(a) - itemTier(b) || itemConcepto(a).localeCompare(itemConcepto(b), "es"));

  const totalsOf = (items: SectionItem[]) => {
    const totals = columns.map(() => 0);
    for (const item of items) {
      if (item.kind === "row") {
        // La que pasó a otro mes no suma acá (sus adicionales sí, criterio de siempre).
        if (item.row.status !== "CARRIED_OVER" && item.row.monto != null) totals[columnIndex(columns, item.row.coeficienteId)] += item.row.monto;
        for (const e of item.row.extras) {
          if (!e.carriedOutTo && e.monto != null) totals[columnIndex(columns, extraLabels(item.row, e).coeficienteId)] += e.monto;
        }
      } else if (item.kind === "extra") {
        const e = item.extra;
        if (!e.carriedOutTo && e.monto != null) totals[columnIndex(columns, extraLabels(item.row, e).coeficienteId)] += e.monto;
      } else if (item.kind === "carried") {
        totals[columnIndex(columns, item.carried.coeficienteId)] += item.carried.monto;
      } else if (!item.other.carriedOutTo && item.other.monto != null) {
        totals[columnIndex(columns, item.other.coeficienteId)] += item.other.monto;
      }
    }
    // Redondeo a centavos: evita el drift de punto flotante (0.1 + 0.2 !== 0.3).
    return totals.map((t) => Math.round(t * 100) / 100);
  };

  const sections: RubroSection[] = sheet.rubros.map((r) => {
    const items = sortItems(buckets.get(r.id) ?? []);
    return {
      rubroId: r.id,
      title: rubroTitle(r),
      totalLabel: r.order != null ? `TOTAL RUBRO ${r.order}` : `TOTAL ${r.name}`,
      items,
      totals: totalsOf(items),
    };
  });

  const sinRubro = buckets.get(null) ?? [];
  if (sinRubro.length > 0) {
    const items = sortItems(sinRubro);
    sections.push({
      rubroId: null, title: NO_RUBRO_TITLE, totalLabel: `TOTAL ${NO_RUBRO_TITLE}`, items, totals: totalsOf(items),
    });
  }
  return sections;
}

/** Total del mes, columna por columna. */
export function grandTotals(sections: RubroSection[], columnCount: number): number[] {
  const length = Math.max(1, columnCount, ...sections.map((s) => s.totals.length));
  const totals = Array.from({ length }, () => 0);
  for (const s of sections) s.totals.forEach((t, i) => { totals[i] += t; });
  return totals.map((t) => Math.round(t * 100) / 100);
}
