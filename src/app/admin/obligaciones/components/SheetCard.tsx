"use client";

import { Fragment, useState } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { PdfPreviewModal, type PdfPreview } from "@/components/PdfPreviewModal";
import { hasPrintableRows, shortClientNumber, type ExtraRow, type SheetData, type SheetRow } from "../lib/sheetModel";

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
  /** Acordeón: la hoja está desplegada. Por defecto sí (tests, impresión). */
  open?: boolean;
  /** Click en el encabezado. El padre decide cuál queda abierta (una por vez). */
  onToggleOpen?: (consortiumId: string) => void;
};

const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

/**
 * La hoja de un edificio: en pantalla se ve como va a salir impresa, más las
 * acciones de fila (que la hoja de estilos de impresión esconde).
 *
 * Muestra TODO — incluidas las omitidas, en gris — porque es la vista de
 * control. Los gastos desactivados no van en la tabla principal: viven en un
 * bloque plegado "Desactivados (N)" al pie, para que la tabla siga leyéndose como
 * "lo que hay que pagar este mes" y el archivo no la alargue. El filtrado para el
 * papel es de la Parte 2.
 *
 * **No hay borrado.** Un gasto fijo que deja de corresponder se DESACTIVA: el
 * registro y sus obligaciones de todos los períodos quedan intactos, que es lo
 * que exige una rendición de cuentas o una auditoría posterior. El borrado
 * físico arrastraría las obligaciones por `onDelete: Cascade`, así que no se
 * expone en la UI. Si el proveedor vuelve, se reactiva desde ese bloque y el
 * historial queda con los meses de hueco.
 */
export function SheetCard({
  sheet, onAdd, onToggle, onSetStatus, onToggleCarryOver, onUndoCarryOver, onSetLateAmount,
  open = true, onToggleOpen,
}: Props) {
  const [lateFor, setLateFor] = useState<string | null>(null);
  const [lateValue, setLateValue] = useState("");
  const [preview, setPreview] = useState<PdfPreview | null>(null);

  /** Ícono de vista previa: sólo si la boleta llegó y tiene PDF. Abre un modal
      local (no es una mutación: sin spinner). */
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

  const rowClass = (row: SheetRow) => {
    if (!row.active) return styles.rowInactive;
    if (row.status === "SKIPPED") return styles.rowSkipped;
    return "";
  };

  const activeRows = sheet.rows.filter((r) => r.active);
  const inactiveRows = sheet.rows.filter((r) => !r.active);

  /** Nro. de cliente recortado, con el completo en el tooltip (y en el PDF). */
  const facturasCell = (value: string | null) => (
    <td className={styles.facturasCell}>
      {value && <span title={value}>{shortClientNumber(value)}</span>}
    </td>
  );

  // Las tres tablas de la hoja (mes, otras, arrastradas) comparten colgroup y
  // encabezado con anchos fijos: así las columnas coinciden verticalmente
  // aunque una tenga tres botones de acción y otra uno. Las acciones no van
  // al papel, y ahí la tabla vuelve a layout automático (ver @media print).
  const columns = (
    <>
      <colgroup>
        <col className={styles.colPreview} />
        <col className={styles.colFacturas} />
        <col className={styles.colConcepto} />
        <col className={styles.colMonto} />
        <col className={styles.colAlias} />
        <col className={styles.colTecnico} />
        <col className={styles.colTel} />
        <col className={styles.colActions} />
      </colgroup>
    <thead>
      <tr>
        <th className={styles.previewCell} aria-label="Vista previa" />
        <th>FACTURA/NRO CLIENTE</th>
        <th>PROVEEDOR/SERVICIO</th>
        <th>MONTO</th>
        <th>ALIAS - CBU</th>
        <th>TÉCNICO O GESTOR</th>
        <th>TEL. CONTACTO</th>
        <th className={styles.actionsHeader} aria-label="Acciones" />
      </tr>
    </thead>
    </>
  );

  /** Marcar / desmarcar una boleta para pasar al mes siguiente. NO la mueve: el
      traslado real ocurre al ejecutar las tandas, después de cerrar el período.
      Es la única acción de una boleta sin obligación (adicional u otra). */
  const carryBtn = (invoiceId: string, requested: boolean) => (
    <AsyncButton
      type="button"
      className={requested ? styles.actionBtnMarked : styles.actionBtn}
      pendingLabel={requested ? "Quitando…" : "Marcando…"}
      onClick={() => onToggleCarryOver(invoiceId, !requested)}
      title={requested ? "Marcada para pasar al mes siguiente (click para quitar)" : "Pasar al mes siguiente"}
    >
      {requested ? "Mes siguiente ✓" : "Mes siguiente"}
    </AsyncButton>
  );

  /** Adicional: otra boleta del mismo proveedor en el mes, colgada de su fila.
      Sin estado, sin saltear ni desactivar (eso es de la obligación y del gasto
      fijo): si no corresponde, se borra desde Boletas. Concepto y alias son los
      de la madre. */
  const renderExtra = (row: SheetRow, extra: ExtraRow) => (
    <tr
      key={extra.invoiceId}
      className={extra.carriedOutTo ? `${styles.rowExtra} ${styles.rowCarriedOut}` : styles.rowExtra}
    >
      {previewCell(extra.invoiceUrl, `${row.concepto} — ${extra.ordinal}ª boleta`)}
      <td />
      <td>
        <span className={styles.extraLabel}>↳ {extra.ordinal}ª boleta</span>
        {extra.carriedOutTo && <span className={styles.carriedBadge}>pasó a {extra.carriedOutTo}</span>}
      </td>
      <td>{extra.monto != null ? money.format(extra.monto) : ""}</td>
      <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
      <td />
      <td />
      <td className={styles.rowActions}>
        {!extra.carriedOutTo && carryBtn(extra.invoiceId, extra.carryOverRequested)}
      </td>
    </tr>
  );

  const renderRow = (row: SheetRow) => {
    const isSkipped = Boolean(row.obligationId) && row.status === "SKIPPED";
    return (
      <Fragment key={row.fixedExpenseId}>
      <tr className={rowClass(row)}>
        {previewCell(row.invoiceUrl, row.concepto)}
        {facturasCell(row.facturas)}
        <td>
          {row.concepto}
          {row.fantasia && <strong className={styles.fantasia}>{row.fantasia}</strong>}
        </td>
        <td>{row.monto != null ? money.format(row.monto) : ""}</td>
        <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
        <td />
        <td />
        <td className={styles.rowActions}>
          {/* Una acción por vez: en cada estado sólo se ofrece la que lo
              revierte. Desactivado manda sobre salteado: un gasto archivado
              sólo puede volver, no "agregarse al periodo". */}
          {!row.active ? (
            <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Activando…"
              onClick={() => onToggle(sheet.consortiumId, row.fixedExpenseId, true)}>
              Activar
            </AsyncButton>
          ) : isSkipped ? (
            <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Agregando…"
              onClick={() => onSetStatus(row.obligationId!, "PENDING")}>
              Agregar al periodo
            </AsyncButton>
          ) : (
            <>
              {row.obligationId && row.status === "PENDING" && (
                <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Salteando…"
                  onClick={() => onSetStatus(row.obligationId!, "SKIPPED")}
                  title="No se espera boleta este mes">
                  Saltear periodo
                </AsyncButton>
              )}
              {/* Sólo si llegó la boleta: es lo que se puede pasar. */}
              {row.invoiceId && carryBtn(row.invoiceId, row.carryOverRequested)}
              <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Desactivando…"
                onClick={() => onToggle(sheet.consortiumId, row.fixedExpenseId, false)}>
                Desactivar
              </AsyncButton>
            </>
          )}
        </td>
      </tr>
      {row.extras.map((extra) => renderExtra(row, extra))}
      </Fragment>
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
      {/* El encabezado entero pliega/despliega la hoja (acordeón: el padre deja
          una sola abierta). El + queda afuera del botón para no plegarla al
          agregar. La hoja de impresión ignora el plegado y muestra todo. */}
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
      {activeRows.length === 0 ? (
        <p className={styles.emptyNote}>
          {inactiveRows.length === 0
            ? "Este edificio está sin gastos fijos cargados"
            : "Este edificio está sin gastos fijos activos"}
          {hasPrintableRows(sheet) ? "." : ": no se va a imprimir."}
        </p>
      ) : (
        <table className={styles.sheetTable}>
          {columns}
          <tbody>{activeRows.map(renderRow)}</tbody>
        </table>
      )}

      {/* Archivo del edificio: lo que se desactivó. Plegado por defecto, para que
          no compita con lo que hay que pagar; desde acá se reactiva. La hoja de
          impresión lo esconde entero. */}
      {inactiveRows.length > 0 && (
        <details className={styles.inactiveBlock}>
          <summary className={styles.inactiveSummary}>Desactivados ({inactiveRows.length})</summary>
          <table className={styles.sheetTable}>
            {columns}
            <tbody>{inactiveRows.map(renderRow)}</tbody>
          </table>
        </details>
      )}

      {/* Otras boletas del mes: proveedores que no son gasto fijo del edificio
          (ticket, trabajo eventual, razón social hermana). Bloque propio para
          que la tabla de arriba siga siendo "el padrón del edificio". */}
      {sheet.others.length > 0 && (
        <div className={styles.othersBlock}>
          <h3 className={styles.othersTitle}>Otras boletas del mes</h3>
          <table className={styles.sheetTable}>
            {columns}
            <tbody>
              {sheet.others.map((row) => (
                <tr
                  key={row.invoiceId}
                  className={row.carriedOutTo ? `${styles.rowOther} ${styles.rowCarriedOut}` : styles.rowOther}
                >
                  {previewCell(row.invoiceUrl, row.concepto)}
                  {facturasCell(row.facturas)}
                  <td>
                    {row.concepto}
                    {row.fantasia && <strong className={styles.fantasia}>{row.fantasia}</strong>}
                    {row.carriedOutTo && <span className={styles.carriedBadge}>pasó a {row.carriedOutTo}</span>}
                  </td>
                  <td>{row.monto != null ? money.format(row.monto) : ""}</td>
                  <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
                  <td />
                  <td />
                  <td className={styles.rowActions}>
                    {!row.carriedOutTo && carryBtn(row.invoiceId, row.carryOverRequested)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Vienen del mes anterior: bloque propio, para que la tabla de arriba siga
          significando "los gastos fijos de este edificio" y para distinguir de un
          vistazo qué es del mes y qué viene atrasado. */}
      {sheet.carried.length > 0 && (
        <div className={styles.carriedBlock}>
          <h3 className={styles.carriedTitle}>Vienen del mes anterior</h3>
          <table className={styles.sheetTable}>
            {columns}
            <tbody>
              {sheet.carried.map((row) => (
                <tr key={row.invoiceId} className={styles.rowCarried}>
                  {previewCell(row.invoiceUrl, row.concepto)}
                  {facturasCell(row.facturas)}
                  <td>
                    {row.concepto}
                    {row.fromLabel && <span className={styles.carriedBadge}>de {row.fromLabel}</span>}
                    {row.lateAmount != null && row.originalAmount != null && (
                      <span className={styles.carriedAmounts}>
                        1° pago {money.format(row.originalAmount)} · 2° pago {money.format(row.lateAmount)}
                      </span>
                    )}
                  </td>
                  <td>{money.format(row.monto)}</td>
                  <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
                  <td />
                  <td />
                  <td className={styles.rowActions}>
                    {/* Puede volver a pasarse: si vino de julio y en agosto tampoco
                        se paga, tiene que poder ir a septiembre. El origen que se
                        muestra sigue siendo el ORIGINAL. */}
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      </div>

      <PdfPreviewModal preview={preview} onClose={() => setPreview(null)} />
    </section>
  );
}
