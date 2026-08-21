"use client";

import { useState } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { hasPrintableRows, type SheetData, type SheetRow } from "../lib/sheetModel";

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
};

const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

/**
 * La hoja de un edificio: en pantalla se ve como va a salir impresa, más las
 * acciones de fila (que la hoja de estilos de impresión esconde).
 *
 * Muestra TODO — incluidas las omitidas y los gastos desactivados, en gris —
 * porque es la vista de control. El filtrado para el papel es de la Parte 2.
 *
 * **No hay borrado.** Un gasto fijo que deja de corresponder se DESACTIVA: el
 * registro y sus obligaciones de todos los períodos quedan intactos, que es lo
 * que exige una rendición de cuentas o una auditoría posterior. El borrado
 * físico arrastraría las obligaciones por `onDelete: Cascade`, así que no se
 * expone en la UI.
 */
export function SheetCard({
  sheet, onAdd, onToggle, onSetStatus, onToggleCarryOver, onUndoCarryOver, onSetLateAmount,
}: Props) {
  const [lateFor, setLateFor] = useState<string | null>(null);
  const [lateValue, setLateValue] = useState("");

  const rowClass = (row: SheetRow) => {
    if (!row.active) return styles.rowInactive;
    if (row.status === "SKIPPED") return styles.rowSkipped;
    return "";
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
        <div>
          <span className={styles.sheetBank}>{sheet.bankName}</span>
          <h2 className={styles.sheetTitle}>{sheet.consortiumName}</h2>
        </div>
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

      {sheet.rows.length === 0 ? (
        <p className={styles.emptyNote}>
          Este edificio está sin gastos fijos cargados: no se va a imprimir.
        </p>
      ) : (
        <table className={styles.sheetTable}>
          <thead>
            <tr>
              <th>FACTURAS</th>
              <th>PROVEEDORES Y SERVICIOS</th>
              <th>MONTO</th>
              <th>ALIAS - CBU</th>
              <th>TÉCNICO O GESTOR</th>
              <th>TEL. CONTACTO</th>
              <th className={styles.actionsHeader} aria-label="Acciones" />
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row) => {
              const isSkipped = Boolean(row.obligationId) && row.status === "SKIPPED";
              return (
              <tr key={row.fixedExpenseId} className={rowClass(row)}>
                <td>{row.facturas ?? ""}</td>
                <td>{row.concepto}</td>
                <td>{row.monto != null ? money.format(row.monto) : ""}</td>
                <td>{row.aliasCbu.map((a) => (<div key={a}>{a}</div>))}</td>
                <td />
                <td />
                <td className={styles.rowActions}>
                  {/* Una acción por vez: en cada estado sólo se ofrece la que lo
                      revierte. Saltear un gasto ya desactivado, o desactivar uno
                      que este mes no va, no significan nada. */}
                  {isSkipped ? (
                    <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Agregando…"
                      onClick={() => onSetStatus(row.obligationId!, "PENDING")}>
                      Agregar al periodo
                    </AsyncButton>
                  ) : !row.active ? (
                    <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Activando…"
                      onClick={() => onToggle(sheet.consortiumId, row.fixedExpenseId, true)}>
                      Activar
                    </AsyncButton>
                  ) : (
                    <>
                      {row.obligationId && row.status === "PENDING" && (
                        <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Salteando…"
                          onClick={() => onSetStatus(row.obligationId!, "SKIPPED")}>
                          Saltear periodo
                        </AsyncButton>
                      )}
                      {/* Sólo si llegó la boleta: es lo que se puede pasar. El
                          traslado real ocurre al ejecutar las tandas, después de
                          cerrar el período. */}
                      {row.invoiceId && (
                        <AsyncButton
                          type="button"
                          className={row.carryOverRequested ? styles.actionBtnMarked : styles.actionBtn}
                          pendingLabel={row.carryOverRequested ? "Quitando…" : "Marcando…"}
                          onClick={() => onToggleCarryOver(row.invoiceId!, !row.carryOverRequested)}
                        >
                          {row.carryOverRequested ? "Pasa al mes siguiente ✓" : "Pasar al mes siguiente"}
                        </AsyncButton>
                      )}
                      <AsyncButton type="button" className={styles.actionBtn} pendingLabel="Desactivando…"
                        onClick={() => onToggle(sheet.consortiumId, row.fixedExpenseId, false)}>
                        Desactivar
                      </AsyncButton>
                    </>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Vienen del mes anterior: bloque propio, para que la tabla de arriba siga
          significando "los gastos fijos de este edificio" y para distinguir de un
          vistazo qué es del mes y qué viene atrasado. */}
      {sheet.carried.length > 0 && (
        <div className={styles.carriedBlock}>
          <h3 className={styles.carriedTitle}>Vienen del mes anterior</h3>
          <table className={styles.sheetTable}>
            <thead>
              <tr>
                <th>FACTURAS</th>
                <th>PROVEEDORES Y SERVICIOS</th>
                <th>MONTO</th>
                <th>ALIAS - CBU</th>
                <th>TÉCNICO O GESTOR</th>
                <th>TEL. CONTACTO</th>
                <th className={styles.actionsHeader} aria-label="Acciones" />
              </tr>
            </thead>
            <tbody>
              {sheet.carried.map((row) => (
                <tr key={row.invoiceId} className={styles.rowCarried}>
                  <td>{row.facturas ?? ""}</td>
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
                    <AsyncButton
                      type="button"
                      className={row.carryOverRequested ? styles.actionBtnMarked : styles.actionBtn}
                      pendingLabel={row.carryOverRequested ? "Quitando…" : "Marcando…"}
                      onClick={() => onToggleCarryOver(row.invoiceId, !row.carryOverRequested)}
                    >
                      {row.carryOverRequested ? "Pasa al mes siguiente ✓" : "Pasar al mes siguiente"}
                    </AsyncButton>

                    <AsyncButton
                      type="button"
                      className={styles.actionBtn}
                      pendingLabel="Devolviendo…"
                      onClick={() => onUndoCarryOver(row.invoiceId)}
                    >
                      Devolver a {row.fromLabel ?? "su mes"}
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
                      >
                        Cargar monto vencido
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
