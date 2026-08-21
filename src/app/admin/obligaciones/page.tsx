"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import styles from "./page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { useObligationsOverview } from "./hooks/useObligationsOverview";
import { useCarryOverRun } from "./hooks/useCarryOverRun";
import { SheetCard } from "./components/SheetCard";
import { AddFixedExpenseModal } from "./components/AddFixedExpenseModal";
import { filterSheets, toPrintableSheets, type SheetData } from "./lib/sheetModel";
import { downloadSheetsPdf } from "./lib/sheetPdf";

/** Agrupa hojas YA ordenadas (banco, después edificio) en bloques por banco. */
function groupSheetsByBank(sheets: SheetData[]): Array<{ bankName: string; sheets: SheetData[] }> {
  const groups: Array<{ bankName: string; sheets: SheetData[] }> = [];
  for (const sheet of sheets) {
    const last = groups[groups.length - 1];
    if (last && last.bankName === sheet.bankName) last.sheets.push(sheet);
    else groups.push({ bankName: sheet.bankName, sheets: [sheet] });
  }
  return groups;
}

export default function ObligacionesPage() {
  const {
    payload, sheets, month, monthLabel, goToPreviousMonth, goToNextMonth,
    isLoading, error, syncWarning, reload,
    addFixedExpenses, toggleFixedExpense, setObligationStatus,
    toggleCarryOver, undoCarryOver, setLateAmount,
  } = useObligationsOverview();

  // Traslados marcados: se ejecutan por tandas DESPUÉS de cerrar el período.
  const carryRun = useCarryOverRun(reload);
  const [query, setQuery] = useState("");

  // Al cambiar de mes se pregunta qué quedó marcado sin mover: es lo que sostiene
  // el "continuar" cuando el cliente cerró la pestaña a mitad de camino.
  // `loadPendingCarry` sale de un `useCallback` estable, así que no re-dispara.
  const { loadPending: loadPendingCarry } = carryRun;
  useEffect(() => {
    if (month) void loadPendingCarry(month);
  }, [month, loadPendingCarry]);
  const [addingFor, setAddingFor] = useState<string | null>(null);

  const visible = useMemo(() => filterSheets(sheets, query), [sheets, query]);
  const groups = useMemo(() => groupSheetsByBank(visible), [visible]);

  const totals = useMemo(() => {
    const withRows = sheets.filter((s) => s.rows.length > 0);
    return {
      edificios: withRows.length,
      gastos: sheets.reduce((acc, s) => acc + s.rows.length, 0),
      vacios: sheets.length - withRows.length,
    };
  }, [sheets]);

  // Lo que realmente se imprime: sin salteadas, sin desactivadas y sin edificios
  // vacíos. Sirve para deshabilitar los botones cuando no hay nada que sacar.
  const printableCount = useMemo(() => toPrintableSheets(sheets).length, [sheets]);

  const consortiumToAdd = payload?.consortiums.find((c) => c.consortiumId === addingFor) ?? null;

  return (
    <div className={styles.page}>
      {(carryRun.pendingCount > 0 || carryRun.isRunning) && month && (
        <div className={styles.carryRunBar}>
          {carryRun.isRunning ? (
            <>
              <span>
                Pasando boletas al mes siguiente: {carryRun.summary.processed} de {carryRun.summary.total}
                {carryRun.summary.failed > 0 && ` · ${carryRun.summary.failed} con error`}
              </span>
              <progress max={100} value={carryRun.summary.percent} />
            </>
          ) : (
            <>
              <span>
                Quedaron <strong>{carryRun.pendingCount}</strong> boleta(s) marcadas sin pasar al mes siguiente.
              </span>
              <AsyncButton
                type="button"
                className={styles.addInvoiceBtn}
                pendingLabel="Pasando…"
                onClick={() => carryRun.run(month)}
              >
                Continuar
              </AsyncButton>
            </>
          )}
        </div>
      )}

      <header className={styles.toolbar}>
        <div>
          <h1 className={styles.pageTitle}>Obligaciones del período</h1>
          {/* La vista es por MES, no por "período activo": se navega libremente
              hacia atrás para decidir qué pasa al mes siguiente. */}
          <div className={styles.monthNav}>
            <button
              type="button"
              className={styles.monthNavBtn}
              onClick={goToPreviousMonth}
              disabled={!monthLabel}
              aria-label="Mes anterior"
            >
              ‹
            </button>
            <p className={styles.pageSubtitle}>{monthLabel ?? "—"}</p>
            <button
              type="button"
              className={styles.monthNavBtn}
              onClick={goToNextMonth}
              disabled={!monthLabel}
              aria-label="Mes siguiente"
            >
              ›
            </button>
          </div>
        </div>

        <input
          className={styles.searchInput}
          placeholder="Buscar edificio, banco o servicio..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className={styles.toolbarRight}>
          <span className={styles.counters}>
            {totals.edificios} edificios · {totals.gastos} gastos fijos
            {totals.vacios > 0 && ` · ${totals.vacios} sin cargar`}
          </span>
          {/* Descargar arma el PDF y baja las librerías: es async, va con
              AsyncButton. Imprimir es `window.print()`, síncrono. */}
          <AsyncButton
            type="button"
            className={styles.primaryBtn}
            disabled={printableCount === 0}
            pendingLabel="Generando…"
            onClick={() => downloadSheetsPdf(sheets, monthLabel)}
          >
            Descargar PDF ({printableCount})
          </AsyncButton>
          <button
            type="button"
            className={styles.ghostBtn}
            disabled={printableCount === 0}
            onClick={() => window.print()}
          >
            Imprimir
          </button>
          <Link href="/admin/consortiums" className={styles.ghostBtn}>
            Volver
          </Link>
        </div>
      </header>

      {syncWarning && (
        <div className={styles.warning}>
          {syncWarning}{" "}
          <button type="button" className={styles.linkBtn} onClick={() => void reload()}>
            Reintentar
          </button>
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}

      {isLoading ? (
        <p className={styles.loading}>Sincronizando y cargando...</p>
      ) : groups.length === 0 ? (
        <p className={styles.emptyNote}>No hay edificios que coincidan con la búsqueda.</p>
      ) : (
        groups.map((group) => (
          <section key={group.bankName} className={styles.bankGroup}>
            <h2 className={styles.bankTitle}>{group.bankName}</h2>
            {group.sheets.map((sheet) => (
              <SheetCard
                key={sheet.consortiumId}
                sheet={sheet}
                onAdd={setAddingFor}
                /* Se pasan tal cual (devuelven la promesa) para que el spinner del
                   botón dure lo que dura la mutación + la recarga. */
                onToggle={toggleFixedExpense}
                onSetStatus={setObligationStatus}
                onToggleCarryOver={toggleCarryOver}
                onUndoCarryOver={undoCarryOver}
                onSetLateAmount={setLateAmount}
              />
            ))}
          </section>
        ))
      )}

      {consortiumToAdd && payload && (
        <AddFixedExpenseModal
          consortium={consortiumToAdd}
          providers={payload.providers}
          onAdd={addFixedExpenses}
          onClose={() => setAddingFor(null)}
        />
      )}
    </div>
  );
}
