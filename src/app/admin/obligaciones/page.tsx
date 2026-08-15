"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import styles from "./page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { useObligationsOverview } from "./hooks/useObligationsOverview";
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
    payload, sheets, majorityLabel, isLoading, error, syncWarning, reload,
    addFixedExpenses, toggleFixedExpense, setObligationStatus,
    carryOverInvoice, setLateAmount,
  } = useObligationsOverview();

  const [query, setQuery] = useState("");
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
      <header className={styles.toolbar}>
        <div>
          <h1 className={styles.pageTitle}>Obligaciones del período</h1>
          {majorityLabel && <p className={styles.pageSubtitle}>{majorityLabel}</p>}
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
            onClick={() => downloadSheetsPdf(sheets, majorityLabel)}
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
                onCarryOver={carryOverInvoice}
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
