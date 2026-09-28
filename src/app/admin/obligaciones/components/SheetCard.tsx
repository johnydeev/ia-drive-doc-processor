"use client";

import { Fragment, useState, type ReactNode } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { PdfPreviewModal, type PdfPreview } from "@/components/PdfPreviewModal";
import { ActionsMenu, type ActionsMenuItem } from "./ActionsMenu";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { LabelEditor, type LabelTarget, type Labels } from "./LabelEditor";
import {
  columnIndex,
  extraLabels,
  facturasLabel,
  GRAND_TOTAL_LABEL,
  grandTotals,
  groupByRubro,
  hasPrintableRows,
  isItemPrintable,
  monthOnly,
  PENDING_MARK,
  shortClientNumber,
  showsPendingMark,
  type CarriedRow,
  type ExtraRow,
  type OtherRow,
  type RubroSection,
  type SheetData,
  type SheetRow,
} from "../lib/sheetModel";

type Props = {
  sheet: SheetData;
  onAdd: (consortiumId: string) => void;
  // Todas devuelven la promesa de la mutación: `AsyncButton` la espera para
  // mostrar el spinner y cortar el doble click.
  onToggle: (consortiumId: string, fixedExpenseId: string, active: boolean) => void | Promise<void>;
  onSetStatus: (obligationId: string, status: "PENDING" | "SKIPPED") => void | Promise<void>;
  /** Marca o desmarca la boleta para pasar al mes siguiente. NO la mueve. */
  onToggleCarryOver: (invoiceId: string, requested: boolean) => void | Promise<void>;
  /** Devuelve al mes de origen una boleta que YA se trasladó. */
  onUndoCarryOver: (invoiceId: string) => void | Promise<void>;
  onSetLateAmount: (invoiceId: string, lateAmount: number) => void | Promise<void>;
  /** Rubro y coeficiente de una fila. Sin handler no se ofrece la edición. */
  onSetLabels?: (target: LabelTarget, labels: Labels) => void | Promise<void>;
  /** Hay una búsqueda activa: el total avisa que está filtrado y "Sin rubro" se despliega (D13). */
  hideEmptySections?: boolean;
  /** Acordeón: la hoja está desplegada. Por defecto sí (tests, impresión). */
  open?: boolean;
  /** Click en el encabezado. El padre decide cuál queda abierta (una por vez). */
  onToggleOpen?: (consortiumId: string) => void;
};

const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
/** Importes de las columnas de coeficiente y totales: sin `$`, para que entren (D8). */
const amount = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Columnas antes de las de coeficiente (vista previa, factura, concepto) y después (alias, acciones). */
const LEAD = 3;
const TRAIL = 2;
/** Total en cero: celda vacía, como en la liquidación (un 0,00 por columna ensucia la hoja). */
const totalText = (t: number) => (t === 0 ? "" : amount.format(t));

/**
 * La hoja de un edificio, en secciones de rubro como la liquidación (spec
 * 2026-09-24, Parte 2). En pantalla se ve como va a salir impresa, más las
 * acciones de fila (que la hoja de estilos de impresión esconde).
 *
 * - Cada rubro con algo cargado es una sección, con fondo propio y su total; el
 *   monto va en la columna de su coeficiente (una por coeficiente del edificio).
 *   Los rubros vacíos no se dibujan.
 * - "Sin rubro" va plegado al final (pedido del owner) salvo que el edificio no
 *   tenga rubros; al imprimir sale desplegado.
 * - Las boletas eventuales entran en su rubro con el distintivo "eventual".
 * - Las impagas arrastradas del mes anterior entran en su rubro con el distintivo
 *   "de septiembre" y suman (spec 2026-09-28). En el mes de origen, la fila cuya
 *   boleta pasó queda atenuada con "pasó a octubre", sin acciones y sin sumar.
 * - Los desactivados siguen en su bloque plegado, fuera de las secciones.
 *
 * **No hay borrado.** Un gasto fijo que deja de corresponder se DESACTIVA: el
 * registro y sus obligaciones de todos los períodos quedan intactos, que es lo
 * que exige una rendición de cuentas o una auditoría posterior.
 */
export function SheetCard({
  sheet, onAdd, onToggle, onSetStatus, onToggleCarryOver, onUndoCarryOver, onSetLateAmount, onSetLabels,
  hideEmptySections = false, open = true, onToggleOpen,
}: Props) {
  const [lateFor, setLateFor] = useState<string | null>(null);
  const [lateValue, setLateValue] = useState("");
  const [preview, setPreview] = useState<PdfPreview | null>(null);
  // Omitir y Desactivar piden confirmación: están al lado del editor de etiqueta.
  const [confirm, setConfirm] = useState<{ action: "skip" | "deactivate"; row: SheetRow } | null>(null);
  // Plegado por defecto: se despliega con el click, o solo (ver `sinRubroShown`).
  // `null` = "sin decisión del usuario todavía": manda `forceSinRubroOpen`. En
  // cuanto el usuario clickea el toggle, su decisión pisa la del forzado —así
  // se puede volver a plegar aunque siga forzado (ver `sinRubroShown` abajo).
  const [sinRubroOpen, setSinRubroOpen] = useState<boolean | null>(null);

  const columns = sheet.coefColumns;
  const totalCols = LEAD + columns.length + TRAIL;
  const hasCoefs = columns.some((c) => c.id !== null);

  const activeRows = sheet.rows.filter((r) => r.active);
  const inactiveRows = sheet.rows.filter((r) => !r.active);
  // Un edificio que sólo tiene arrastradas también dibuja sus secciones y su total.
  const hasItems = activeRows.length > 0 || sheet.others.length > 0 || sheet.carried.length > 0;
  const sections = groupByRubro(sheet);
  const rubroSectionsAll = sections.filter((s) => s.rubroId !== null);
  const rubroSections = rubroSectionsAll.filter((s) => s.items.length > 0);
  const sinRubro = sections.find((s) => s.rubroId === null) ?? null;
  const grand = grandTotals(sections, columns.length);
  // Con una búsqueda activa, `sheet` ya llegó filtrado por `filterSheets`: el
  // total de abajo suma sólo lo que quedó visible, así que el rótulo lo avisa.
  const grandTotalLabel = hideEmptySections ? `${GRAND_TOTAL_LABEL} (filtrado)` : GRAND_TOTAL_LABEL;
  // El checklist de rubros no puede tapar lo único que tiene contenido: si el
  // edificio no tiene rubros (D1), ninguno tiene todavía nada cargado (rollout
  // de la feature), o hay una búsqueda activa (D13 ya esconde los vacíos: si
  // el resultado está en "Sin rubro", no puede quedar plegado), arranca
  // desplegado igual, sin esperar el click.
  const allRubroSectionsEmpty = rubroSectionsAll.every((s) => s.items.length === 0);
  const forceSinRubroOpen = hideEmptySections || allRubroSectionsEmpty;
  const sinRubroShown = sinRubroOpen ?? forceSinRubroOpen;

  // Para el papel: vacía en pantalla (D3, `allRubroSectionsEmpty`) no es lo
  // mismo que sin nada imprimible (todo salteado/desactivado o eventual ya
  // pasada a otro mes) — ambos casos dejan la tabla o el bloque "Sin rubro"
  // mostrando sólo su encabezado/título en el papel, así que las dos clases de
  // @media print se calculan sobre lo imprimible, no sobre la cantidad de
  // filas.
  const rubroSectionsPrintEmpty = !rubroSectionsAll.some((s) => s.items.some(isItemPrintable));
  const sinRubroPrintEmpty = !sinRubro || !sinRubro.items.some(isItemPrintable);

  /** Ícono de vista previa: sólo si la boleta llegó y tiene PDF. */
  const previewCell = (url: string | null, concepto: string) => (
    <td className={styles.previewCell}>
      {url && (
        <button
          type="button"
          className={styles.previewBtn}
          onClick={() => setPreview({ sourceUrl: url, title: `${concepto} — ${sheet.consortiumName}` })}
          aria-label={`Vista previa de la boleta de ${concepto}`}
          title="Vista previa de la boleta"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      )}
    </td>
  );

  /** La boleta de la fila pasó a otro mes: queda de rendición, sin acciones (spec 2026-09-28). */
  const isCarriedOut = (row: SheetRow) => row.active && row.status === "CARRIED_OVER";

  const rowClass = (row: SheetRow) => {
    if (!row.active) return styles.rowInactive;
    if (row.status === "SKIPPED") return styles.rowSkipped;
    if (row.status === "CARRIED_OVER") return styles.rowCarriedOut;
    return "";
  };

  /** Nro. de cliente recortado (o "Empleado"), con el completo en el tooltip y en el PDF. */
  const facturasCell = (value: string | null) => (
    <td className={styles.facturasCell}>
      {value && <span title={value}>{shortClientNumber(value)}</span>}
    </td>
  );

  /** Una celda por coeficiente; el monto sólo en la de su columna. Pendiente: "—" en su columna (D12). */
  const amountCells = (value: number | null, coeficienteId: string | null | undefined, pending = false) => {
    const col = columnIndex(columns, coeficienteId);
    return columns.map((c, i) => (
      <td key={c.code} className={styles.amountCell}>
        {i !== col ? "" : value != null ? amount.format(value) : pending ? PENDING_MARK : ""}
      </td>
    ));
  };

  /** Todas las tablas comparten colgroup y encabezado: las columnas coinciden verticalmente. */
  const colgroup = (
    <colgroup>
      <col className={styles.colPreview} />
      <col className={styles.colFacturas} />
      <col className={styles.colConcepto} />
      {columns.map((c) => (<col key={c.code} className={styles.colCoef} />))}
      <col className={styles.colAlias} />
      <col className={styles.colActions} />
    </colgroup>
  );

  // El header y las filas de total comparten el mismo problema: la impresión
  // esconde preview y acciones por clase (`.previewCell`, `.actionsCell`), así
  // que esas dos celdas tienen que ser SUYAS y no colar dentro de un colSpan
  // que abarque también columnas que siguen visibles — si no, en el papel todo
  // el resto de la fila se corre una columna.
  const tableHead = (
    <>
      {colgroup}
      <thead>
        <tr className={styles.coefGroupRow}>
          <th className={styles.previewCell} aria-hidden="true" />
          <th colSpan={LEAD - 1} aria-hidden="true" />
          <th colSpan={columns.length} className={styles.coefGroupHeader}>{hasCoefs ? "COEFICIENTE" : ""}</th>
          <th colSpan={TRAIL - 1} aria-hidden="true" />
          <th className={styles.actionsHeader} aria-hidden="true" />
        </tr>
        <tr>
          <th className={styles.previewCell} aria-label="Vista previa" />
          <th>FACTURA/NRO CLIENTE</th>
          <th>PROVEEDOR/SERVICIO</th>
          {columns.map((c) => (<th key={c.code} className={styles.amountHeader}>{c.code}</th>))}
          <th>ALIAS - CBU</th>
          <th className={styles.actionsHeader} aria-label="Acciones" />
        </tr>
      </thead>
    </>
  );

  /** Marcar / desmarcar una boleta para pasar al mes siguiente. NO la mueve. */
  const carryBtn = (invoiceId: string, requested: boolean) => (
    <AsyncButton
      type="button"
      className={requested ? styles.actionBtnMarked : styles.actionBtn}
      pendingLabel={requested ? "Quitando…" : "Marcando…"}
      onClick={() => onToggleCarryOver(invoiceId, !requested)}
      title={requested ? "Marcada para pasar al mes siguiente (click para quitar)" : "Llegó y no se pudo pagar: pasa al mes siguiente al cerrar el período"}
    >
      {requested ? "Mes siguiente ✓" : "Mes siguiente"}
    </AsyncButton>
  );

  /**
   * Celda de acciones. El flex va en un `div` de adentro: un `td` con
   * `display: flex` deja de ser celda de tabla y su borde no se alinea con el
   * resto de la fila.
   */
  const actionsCell = (children?: ReactNode) => (
    <td className={styles.actionsCell}>
      <div className={styles.rowActions}>{children}</div>
    </td>
  );

  /** Rubro y coeficiente de la fila (decisión D5: al principio de las acciones). */
  const labelEditor = (target: LabelTarget, rubroId: string | null | undefined, coeficienteId: string | null | undefined, concepto: string) =>
    onSetLabels ? (
      <LabelEditor
        rubros={sheet.rubros}
        coefColumns={columns}
        value={{ rubroId: rubroId ?? null, coeficienteId: coeficienteId ?? null }}
        concepto={concepto}
        onSave={(labels) => onSetLabels(target, labels)}
      />
    ) : null;

  /**
   * Adicional: otra boleta del mismo gasto fijo en el mes. Va pegada a su fila
   * con el MISMO nombre; la distinguen su factura, su monto y su columna. Tiene
   * etiqueta propia: si se le pone otro rubro, pasa a esa sección (`groupByRubro`).
   */
  const renderExtra = (row: SheetRow, extra: ExtraRow) => {
    const labels = extraLabels(row, extra);
    return (
      <tr
        key={extra.invoiceId}
        className={extra.carriedOutTo ? `${styles.rowExtra} ${styles.rowCarriedOut}` : styles.rowExtra}
      >
        {previewCell(extra.invoiceUrl, row.concepto)}
        {facturasCell(extra.facturas)}
        <td>
          {row.concepto}
          {row.fantasia && <strong className={styles.fantasia}>{row.fantasia}</strong>}
          {extra.carriedOutTo && <span className={styles.carriedBadge}>pasó a {monthOnly(extra.carriedOutTo)}</span>}
        </td>
        {amountCells(extra.monto, labels.coeficienteId)}
        <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
        {actionsCell(
          !extra.carriedOutTo && (
            <>
              {labelEditor({ invoiceId: extra.invoiceId }, labels.rubroId, labels.coeficienteId, row.concepto)}
              {carryBtn(extra.invoiceId, extra.carryOverRequested)}
            </>
          )
        )}
      </tr>
    );
  };

  /** Items del menú «Acciones ▾» de una fila activa: Omitir sólo si la obligación sigue pendiente. */
  const rowMenuItems = (row: SheetRow): ActionsMenuItem[] => [
    ...(row.obligationId && row.status === "PENDING"
      ? [{ label: "Omitir", onSelect: () => setConfirm({ action: "skip", row }) }]
      : []),
    { label: "Desactivar", danger: true, onSelect: () => setConfirm({ action: "deactivate", row }) },
  ];

  const renderRow = (row: SheetRow) => {
    const isSkipped = Boolean(row.obligationId) && row.status === "SKIPPED";
    const target: LabelTarget = row.invoiceId
      ? { fixedExpenseId: row.fixedExpenseId, invoiceId: row.invoiceId }
      : { fixedExpenseId: row.fixedExpenseId };
    return (
      <Fragment key={row.fixedExpenseId}>
        <tr className={rowClass(row)}>
          {previewCell(row.invoiceUrl, row.concepto)}
          {facturasCell(facturasLabel(row))}
          <td>
            {row.concepto}
            {row.fantasia && <strong className={styles.fantasia}>{row.fantasia}</strong>}
            {isCarriedOut(row) && row.carriedOutTo && (
              <span className={styles.carriedBadge}>pasó a {monthOnly(row.carriedOutTo)}</span>
            )}
          </td>
          {amountCells(row.monto, row.coeficienteId, showsPendingMark(row))}
          <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
          {isCarriedOut(row) ? actionsCell() : actionsCell(<>
            {row.active && labelEditor(target, row.rubroId, row.coeficienteId, row.concepto)}
            {/* Una acción por vez: en cada estado sólo se ofrece la que lo revierte. */}
            {!row.active ? (
              <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Activando…"
                onClick={() => onToggle(sheet.consortiumId, row.fixedExpenseId, true)}>
                Activar
              </AsyncButton>
            ) : isSkipped ? (
              <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Incluyendo…"
                onClick={() => onSetStatus(row.obligationId!, "PENDING")}>
                Incluir
              </AsyncButton>
            ) : (
              <>
                {row.invoiceId && carryBtn(row.invoiceId, row.carryOverRequested)}
                {/* Los items abren la confirmación (estado local): el spinner va en el diálogo. */}
                <ActionsMenu concepto={row.concepto} items={rowMenuItems(row)} />
              </>
            )}
          </>)}
        </tr>
        {row.extras.map((extra) => renderExtra(row, extra))}
      </Fragment>
    );
  };

  /** Boleta eventual: un proveedor que no es gasto fijo del edificio (D6). */
  const renderOther = (row: OtherRow) => (
    <tr
      key={row.invoiceId}
      className={row.carriedOutTo ? `${styles.rowOther} ${styles.rowCarriedOut}` : styles.rowOther}
    >
      {previewCell(row.invoiceUrl, row.concepto)}
      {facturasCell(facturasLabel(row))}
      <td>
        {row.concepto}
        <span className={styles.eventualBadge}>eventual</span>
        {row.fantasia && <strong className={styles.fantasia}>{row.fantasia}</strong>}
        {row.carriedOutTo && <span className={styles.carriedBadge}>pasó a {monthOnly(row.carriedOutTo)}</span>}
      </td>
      {amountCells(row.monto, row.coeficienteId)}
      <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
      {actionsCell(
        !row.carriedOutTo && (
          <>
            {labelEditor({ invoiceId: row.invoiceId }, row.rubroId, row.coeficienteId, row.concepto)}
            {carryBtn(row.invoiceId, row.carryOverRequested)}
          </>
        )
      )}
    </tr>
  );

  /**
   * Impaga arrastrada del mes anterior: va en su sección de rubro, en la columna
   * de su coeficiente, con "de septiembre". Conserva lo que tenía el viejo bloque
   * "Vienen del mes anterior": 1° pago · 2° pago, Mes siguiente (arrastre
   * encadenado), Devolver y Monto vencido.
   */
  const renderCarried = (row: CarriedRow) => (
    <tr key={row.invoiceId} className={styles.rowCarried}>
      {previewCell(row.invoiceUrl, row.concepto)}
      {facturasCell(row.facturas)}
      <td>
        {row.concepto}
        {row.fromLabel && <span className={styles.carriedBadge}>de {monthOnly(row.fromLabel)}</span>}
        {row.lateAmount != null && row.originalAmount != null && (
          <span className={styles.carriedAmounts}>
            1° pago {money.format(row.originalAmount)} · 2° pago {money.format(row.lateAmount)}
          </span>
        )}
      </td>
      {amountCells(row.monto, row.coeficienteId)}
      <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
      {actionsCell(<>
        {labelEditor({ invoiceId: row.invoiceId }, row.rubroId, row.coeficienteId, row.concepto)}
        {carryBtn(row.invoiceId, row.carryOverRequested)}
        <AsyncButton
          type="button"
          className={styles.actionBtn}
          pendingLabel="Devolviendo…"
          onClick={() => onUndoCarryOver(row.invoiceId)}
          title={`Devolver a ${row.fromLabel ?? "su mes"}`}
        >
          Devolver
        </AsyncButton>
        {lateFor === row.invoiceId ? (
          <>
            <input
              className={styles.lateInput}
              type="number"
              min="0"
              step="0.01"
              placeholder="Monto vencido"
              aria-label={`Monto vencido de ${row.concepto}`}
              value={lateValue}
              onChange={(e) => setLateValue(e.target.value)}
            />
            <AsyncButton
              type="button"
              className={styles.actionBtn}
              pendingLabel="Guardando…"
              disabled={!(Number(lateValue) > 0)}
              onClick={async () => {
                await onSetLateAmount(row.invoiceId, Number(lateValue));
                setLateFor(null);
                setLateValue("");
              }}
            >
              Guardar
            </AsyncButton>
          </>
        ) : (
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => {
              setLateFor(row.invoiceId);
              setLateValue(row.lateAmount != null ? String(row.lateAmount) : "");
            }}
            title="Cargar el monto del 2° vencimiento"
          >
            Monto vencido
          </button>
        )}
      </>)}
    </tr>
  );

  const renderSection = (section: RubroSection) => {
    // Vacía, o sin nada imprimible (todo salteado/desactivado o eventual ya
    // pasada a otro mes): el checklist de pantalla la muestra igual (D3), pero
    // el papel la omite (`.sectionEmpty` en @media print) — pasa también con
    // "Sin rubro" (`sinRubroPrintEmpty`, D14 review): tiene filas para el
    // checklist de pantalla pero ninguna imprimible.
    const empty = section.items.length === 0 || !section.items.some(isItemPrintable);
    // Un `tbody` por rubro: es lo que lleva el fondo gris del bloque.
    return (
      <tbody
        key={section.rubroId ?? "sin-rubro"}
        className={empty ? `${styles.rubroBlock} ${styles.sectionEmpty}` : styles.rubroBlock}
      >
        <tr className={styles.sectionRow}>
          <td className={styles.previewCell} />
          <td colSpan={totalCols - 2}>{section.title}</td>
          <td className={styles.actionsCell} />
        </tr>
        {section.items.map((item) =>
          item.kind === "row" ? renderRow(item.row)
          : item.kind === "extra" ? renderExtra(item.row, item.extra)
          : item.kind === "carried" ? renderCarried(item.carried)
          : renderOther(item.other)
        )}
        <tr className={styles.sectionTotal}>
          <td className={styles.previewCell} />
          <td colSpan={LEAD - 1}>{section.totalLabel}</td>
          {section.totals.map((t, i) => (
            <td key={columns[i]?.code ?? i} className={styles.amountCell}>{totalText(t)}</td>
          ))}
          <td colSpan={TRAIL - 1} />
          <td className={styles.actionsCell} />
        </tr>
      </tbody>
    );
  };

  return (
    // `data-printable` lo consume el @media print: una tarjeta sin filas
    // imprimibles no debe ocupar una hoja. El criterio es el mismo que usa el PDF.
    <section
      className={styles.sheetCard}
      data-bank-color={sheet.bankColor ?? "slate"}
      data-printable={hasPrintableRows(sheet) ? "true" : "false"}
    >
      <header className={styles.sheetHeader}>
        <button
          type="button"
          className={styles.sheetToggle}
          aria-expanded={open}
          aria-controls={`sheet-body-${sheet.consortiumId}`}
          onClick={() => onToggleOpen?.(sheet.consortiumId)}
        >
          <span className={styles.sheetChevron} aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span>
            <span className={styles.sheetBank}>
              {sheet.bankId ? `BANCO: ${sheet.bankName}` : sheet.bankName}
            </span>
            <span className={styles.sheetTitle}>{sheet.consortiumName}</span>
          </span>
        </button>
        <div className={styles.sheetHeaderRight}>
          <span className={styles.sheetPeriod}>
            {sheet.periodLabel ?? "sin período abierto"}
          </span>
          <button
            type="button"
            className={styles.addBtn}
            onClick={() => onAdd(sheet.consortiumId)}
            aria-label={`Agregar gasto fijo a ${sheet.consortiumName}`}
            title="Agregar gastos fijos"
          >
            +
          </button>
        </div>
      </header>

      <div id={`sheet-body-${sheet.consortiumId}`} className={styles.sheetBody} hidden={!open}>
        {activeRows.length === 0 && (
          <p className={styles.emptyNote}>
            {inactiveRows.length === 0
              ? "Este edificio está sin gastos fijos cargados"
              : "Este edificio está sin gastos fijos activos"}
            {hasPrintableRows(sheet) ? "." : ": no se va a imprimir."}
          </p>
        )}

        {hasItems && rubroSections.length > 0 && (
          <table
            // `rubroTableEmpty` esconde la tabla entera al imprimir (sólo dentro de
            // `@media print`) cuando sus filas no tienen NADA imprimible
            // (`rubroSectionsPrintEmpty`: todo salteado/desactivado o eventual ya
            // pasada a otro mes) — sin esto el papel imprimiría sólo el
            // encabezado. Sin ninguna fila la tabla directamente no se dibuja.
            className={
              rubroSectionsPrintEmpty ? `${styles.sheetTable} ${styles.rubroTableEmpty}` : styles.sheetTable
            }
          >
            {tableHead}
            {rubroSections.map(renderSection)}
          </table>
        )}

        {/* "Sin rubro": plegado para no alargar la hoja (D1), salvo que sea lo
            único con contenido — edificio sin rubros, con rubros pero ninguno
            cargado todavía (rollout), o con una búsqueda activa que ya vació
            los rubros (D13) — donde arranca desplegado (`sinRubroShown`, D1 +
            su generalización). El click del usuario pisa el forzado: se puede
            volver a plegar igual. Al imprimir sale entero siempre (D2), salvo
            que no tenga nada imprimible (`sinRubroBlockEmpty`, mismo criterio
            que `rubroTableEmpty` arriba). */}
        {hasItems && sinRubro && (
          <div
            className={
              sinRubroPrintEmpty ? `${styles.sinRubroBlock} ${styles.sinRubroBlockEmpty}` : styles.sinRubroBlock
            }
          >
            <button
              type="button"
              className={styles.sinRubroToggle}
              aria-expanded={sinRubroShown}
              aria-controls={`sin-rubro-${sheet.consortiumId}`}
              onClick={() => setSinRubroOpen(!sinRubroShown)}
            >
              {sinRubroShown ? "▾" : "▸"} Sin rubro ({sinRubro.items.length})
            </button>
            <div id={`sin-rubro-${sheet.consortiumId}`} className={styles.sinRubroBody} hidden={!sinRubroShown}>
              <table className={styles.sheetTable}>
                {tableHead}
                {renderSection(sinRubro)}
              </table>
            </div>
          </div>
        )}

        {/* Total del mes: tabla propia (no `tfoot` de la de arriba) para que
            siga sumando aunque "Sin rubro" esté plegado, y con el mismo
            colgroup para que sus columnas coincidan con las de encima. */}
        {hasItems && (
          <table className={styles.sheetTable}>
            {colgroup}
            <tbody>
              <tr className={styles.grandTotal}>
                <td className={styles.previewCell} />
                <td colSpan={LEAD - 1}>{grandTotalLabel}</td>
                {grand.map((t, i) => (
                  <td key={columns[i]?.code ?? i} className={styles.amountCell}>{totalText(t)}</td>
                ))}
                <td colSpan={TRAIL - 1} />
                <td className={styles.actionsCell} />
              </tr>
            </tbody>
          </table>
        )}

        {/* Archivo del edificio: lo que se desactivó. Plegado; la impresión lo esconde. */}
        {inactiveRows.length > 0 && (
          <details className={styles.inactiveBlock}>
            <summary className={styles.inactiveSummary}>Desactivados ({inactiveRows.length})</summary>
            <table className={styles.sheetTable}>
              {tableHead}
              <tbody>{inactiveRows.map(renderRow)}</tbody>
            </table>
          </details>
        )}
      </div>

      <PdfPreviewModal preview={preview} onClose={() => setPreview(null)} />

      {confirm?.action === "skip" && (
        <ConfirmActionDialog
          title={`¿Omitir ${confirm.row.concepto} en ${sheet.periodLabel ?? "este período"}?`}
          confirmLabel="Omitir"
          pendingLabel="Omitiendo…"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await onSetStatus(confirm.row.obligationId!, "SKIPPED");
            setConfirm(null);
          }}
        >
          <p>
            Este mes no corresponde este gasto en {sheet.consortiumName}: la fila queda tachada y no sale en el PDF
            del banco. El mes que viene vuelve a aparecer. Se deshace con «Incluir».
          </p>
          <p>Si la boleta llegó y no se pudo pagar, no la omitas: usá «Mes siguiente».</p>
        </ConfirmActionDialog>
      )}
      {confirm?.action === "deactivate" && (
        <ConfirmActionDialog
          title={`¿Desactivar ${confirm.row.concepto}?`}
          confirmLabel="Desactivar"
          pendingLabel="Desactivando…"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await onToggle(sheet.consortiumId, confirm.row.fixedExpenseId, false);
            setConfirm(null);
          }}
        >
          <p>
            {sheet.consortiumName} deja de tener este gasto fijo: sale de la hoja y del PDF del banco, pasa al
            bloque «Desactivados» y no se le generan obligaciones en los meses siguientes.
          </p>
          <p>No se borra nada (boletas e historial quedan). Se deshace con «Activar».</p>
        </ConfirmActionDialog>
      )}
    </section>
  );
}
