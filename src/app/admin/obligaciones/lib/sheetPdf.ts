// Import de SÓLO TIPOS: se borra al compilar, así que no rompe el `import()`
// dinámico de la librería (que es lo que la mantiene fuera del bundle).
import type { UserOptions } from "jspdf-autotable";
import {
  columnIndex,
  FALLBACK_COLUMN,
  facturasLabel,
  GRAND_TOTAL_LABEL,
  grandTotals,
  groupByRubro,
  isPrintableRow,
  PENDING_MARK,
  showsPendingMark,
  toPrintableSheets,
  type CoefColumn,
  type OtherRow,
  type RubroSection,
  type SheetData,
  type SheetRow,
} from "./sheetModel";

/** Columnas fijas antes y después de las de coeficiente. Etiquetas cortas: en 3-4
 * columnas de coeficiente no hay lugar para el rótulo largo sin cortar palabras.
 * El primer rótulo trae un salto de línea explícito (autoTable lo respeta): sin
 * eso, "FACT./NRO CLIENTE" corta a mitad de palabra en una columna angosta. */
export const LEAD_COLUMNS = ["FACT./\nNRO CLIENTE", "PROVEEDOR/SERVICIO"];
export const TRAIL_COLUMNS = ["ALIAS - CBU", "TÉCNICO", "TEL."];

type PdfCellStyles = {
  fontStyle?: "bold" | "normal";
  fillColor?: [number, number, number];
  halign?: "left" | "center" | "right";
};
/** Celda de autoTable: texto, o un objeto para las filas de sección y total. */
export type PdfCell = string | { content: string; colSpan?: number; styles?: PdfCellStyles };

export type PdfTable = {
  title: string;
  subtitle: string;
  /** Dos niveles: COEFICIENTE arriba, los códigos abajo. */
  head: PdfCell[][];
  /** Secciones por rubro + total del mes. */
  body: PdfCell[][];
  /** Bloque "Vienen del mes anterior", debajo. */
  carried: PdfCell[][];
  /** Ancho de cada columna en mm; suman 182 (A4 con márgenes de 14 mm). */
  widths: number[];
};

/** Título del bloque de impagas dentro de la hoja del edificio. */
export const CARRIED_TITLE = "VIENEN DEL MES ANTERIOR";

/** Sin `$` (D8): el ancho de cada columna de monto varía según cuántas columnas de
 * coeficiente tenga el edificio (13-28 mm; ver `pdfColumnWidths`). */
const amount = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (value: number | null) => (value != null ? amount.format(value) : "");
/** Con `$` (D8): sólo para el "1° pago" que va texto adentro del concepto de una impaga. */
const currency = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const SECTION_FILL: [number, number, number] = [245, 245, 245];

/** "agosto 2026" → "Agosto 2026" (la API devuelve el mes en minúscula). */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Normaliza el nombre del banco **sólo para el papel**. No toca el registro. */
function formatBankName(value: string): string {
  return value.trim().toLocaleLowerCase("es-AR").split(/\s+/).map((w) => capitalize(w)).join(" ");
}

/**
 * Anchos en mm según cuántas columnas de coeficiente tenga el edificio: los 182 mm
 * útiles se reparten y TÉCNICO / TEL. se achican primero (spec: se completan a mano).
 *
 * El ancho de cada columna de monto se calcula intentando dejarle al menos 40 mm a
 * PROVEEDOR/SERVICIO (concepto): eso alcanza hasta 6 columnas de coeficiente (el
 * ancho de monto va de 28 mm con 1-2 a 14 mm con 6). Con 7 el cálculo normal ya deja
 * sólo 26 mm de concepto — menos del piso de 40 pero todavía lejos del mínimo de 20,
 * así que no hace falta resignar nada. Recién con 8 el piso de 20 mm se cruza; ahí se
 * recalcula el ancho de monto (13 mm) para dejarle a concepto exactamente 20 —nunca
 * menos, para que el nombre siga siendo legible. El resultado siempre suma exactamente
 * 182 (concepto se lleva el resto entero, sea cual sea).
 */
export function pdfColumnWidths(coefCount: number): number[] {
  const n = Math.max(1, coefCount);
  const fixed =
    n === 1 ? { facturas: 18, alias: 26, tecnico: 22, tel: 20 }
    : n === 2 ? { facturas: 16, alias: 24, tecnico: 14, tel: 14 }
    : { facturas: 16, alias: 22, tecnico: 10, tel: 10 };
  const fixedTotal = fixed.facturas + fixed.alias + fixed.tecnico + fixed.tel;
  const maxAmountW = n <= 2 ? 28 : 22;
  let amountW = Math.max(14, Math.min(maxAmountW, Math.floor((182 - fixedTotal - 40) / n)));
  let concepto = 182 - fixedTotal - amountW * n;
  if (concepto < 20) {
    // No entraba el piso de 40mm para concepto: se resigna hasta dejarle 20mm.
    amountW = Math.max(1, Math.floor((182 - fixedTotal - 20) / n));
    concepto = 182 - fixedTotal - amountW * n;
  }
  return [fixed.facturas, concepto, ...Array.from({ length: n }, () => amountW), fixed.alias, fixed.tecnico, fixed.tel];
}

/** El monto en su columna; una fila pendiente, "—" en su columna (D12). */
function amountCells(value: number | null, col: number, n: number, pending = false): string[] {
  return Array.from({ length: n }, (_, i) => (i !== col ? "" : value != null ? fmt(value) : pending ? PENDING_MARK : ""));
}

/**
 * Una fila madre y sus adicionales, en la columna del coeficiente de la madre (D7).
 * Si la madre no se imprime (salteada), las adicionales llevan el concepto completo.
 */
function rowLines(row: SheetRow, columns: CoefColumn[]): PdfCell[][] {
  const n = columns.length;
  const col = columnIndex(columns, row.coeficienteId);
  const madre = isPrintableRow(row);
  const extras = row.extras.map((e) => [
    "",
    // "↳" no tiene glifo en la Helvetica embebida de jsPDF y sale un cuadrado: se
    // reemplaza por un prefijo ASCII.
    madre ? `   > ${e.ordinal}ª boleta` : `${row.concepto} — ${e.ordinal}ª boleta`,
    ...amountCells(e.monto, col, n),
    row.aliasCbu.join("\n"),
    "",
    "",
  ]);
  if (!madre) return extras;
  return [
    [facturasLabel(row) ?? "", row.concepto, ...amountCells(row.monto, col, n, showsPendingMark(row)), row.aliasCbu.join("\n"), "", ""],
    ...extras,
  ];
}

function otherLine(row: OtherRow, columns: CoefColumn[]): PdfCell[] {
  return [
    facturasLabel(row) ?? "",
    row.fantasia ? `${row.concepto} (${row.fantasia})` : row.concepto,
    ...amountCells(row.monto, columnIndex(columns, row.coeficienteId), columns.length),
    row.aliasCbu.join("\n"),
    "",
    "",
  ];
}

function sectionLines(section: RubroSection, columns: CoefColumn[]): PdfCell[][] {
  const width = LEAD_COLUMNS.length + columns.length + TRAIL_COLUMNS.length;
  return [
    [{ content: section.title, colSpan: width, styles: { fontStyle: "bold", fillColor: SECTION_FILL } }],
    ...section.items.flatMap((item) =>
      item.kind === "row" ? rowLines(item.row, columns) : [otherLine(item.other, columns)]
    ),
    [
      { content: section.totalLabel, colSpan: LEAD_COLUMNS.length, styles: { fontStyle: "bold" } },
      ...section.totals.map((t) => amount.format(t)),
      "", "", "",
    ],
  ];
}

/**
 * Convierte las hojas en tablas listas para `autoTable`. Puro: es lo que se testea.
 * Mismo modelo y mismo agrupado que la pantalla (`groupByRubro`); el filtro de qué
 * se imprime vive en `toPrintableSheets`. Las secciones vacías no van (D3).
 */
export function toPdfTables(sheets: SheetData[]): PdfTable[] {
  return toPrintableSheets(sheets).map((sheet) => {
    const columns = sheet.coefColumns.length > 0 ? sheet.coefColumns : [FALLBACK_COLUMN];
    const n = columns.length;
    const widths = pdfColumnWidths(n);
    // El rótulo de TÉCNICO se acorta si a esa columna le tocó menos de 14mm (edificios
    // con 3+ coeficientes): "TÉCNICO" entero corta a mitad de palabra ahí.
    const tecnicoWidth = widths[widths.length - 2];
    const trailLabels = ["ALIAS - CBU", tecnicoWidth < 14 ? "TÉC." : "TÉCNICO", "TEL."];
    const sections = groupByRubro(sheet).filter((s) => s.items.length > 0);
    const grand = grandTotals(sections, n);
    return {
      title: sheet.consortiumName,
      subtitle: [
        sheet.bankName ? `BANCO: ${formatBankName(sheet.bankName)}` : null,
        sheet.periodLabel ? `PERIODO: ${capitalize(sheet.periodLabel)}` : null,
      ].filter(Boolean).join("   ·   "),
      head: [
        [
          { content: "", colSpan: LEAD_COLUMNS.length },
          { content: columns.some((c) => c.id !== null) ? "COEFICIENTE" : "", colSpan: n, styles: { halign: "center" } },
          { content: "", colSpan: TRAIL_COLUMNS.length },
        ],
        [...LEAD_COLUMNS, ...columns.map((c) => c.code), ...trailLabels],
      ],
      body:
        sections.length === 0
          ? []
          : [
              ...sections.flatMap((s) => sectionLines(s, columns)),
              [
                { content: GRAND_TOTAL_LABEL, colSpan: LEAD_COLUMNS.length, styles: { fontStyle: "bold" } },
                ...grand.map((t) => amount.format(t)),
                "", "", "",
              ],
            ],
      // El monto de una impaga es el saldo (sobre el 2° vencimiento si se cargó);
      // el 1° pago va en el concepto, con signo $ (D8: acá sí, es texto suelto, no
      // una columna de monto). Primera columna (D10).
      carried: sheet.carried.map((row) => [
        row.facturas ?? "",
        `${row.concepto}${row.fromLabel ? ` — de ${row.fromLabel}` : ""}` +
          (row.lateAmount != null && row.originalAmount != null ? ` (1° pago ${currency.format(row.originalAmount)})` : ""),
        ...amountCells(row.monto, 0, n),
        row.aliasCbu.join("\n"),
        "",
        "",
      ]),
      widths,
    };
  });
}

export function pdfFileName(majorityLabel: string | null): string {
  if (!majorityLabel) return "obligaciones.pdf";
  const slug = majorityLabel.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim().replace(/\s+/g, "-");
  return `obligaciones-${slug}.pdf`;
}

/**
 * Arma el PDF y dispara la descarga. `jspdf` y `jspdf-autotable` se cargan con
 * `import()` dinámico: ~350 KB fuera del bundle hasta que alguien aprieta Descargar.
 */
export async function downloadSheetsPdf(sheets: SheetData[], majorityLabel: string | null): Promise<void> {
  const tables = toPdfTables(sheets);
  if (tables.length === 0) return;

  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const generado = new Date().toLocaleDateString("es-AR");

  tables.forEach((table, index) => {
    if (index > 0) doc.addPage(); // una hoja por edificio

    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(table.subtitle, 14, 16);
    doc.setFontSize(16);
    doc.setTextColor(20);
    doc.text(table.title, 14, 24);

    const n = table.widths.length - LEAD_COLUMNS.length - TRAIL_COLUMNS.length;
    const isAmount = (i: number) => i >= LEAD_COLUMNS.length && i < LEAD_COLUMNS.length + n;
    const tableStyles: Partial<UserOptions> = {
      styles: {
        fontSize: 9,
        cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 },
        lineColor: 200,
        lineWidth: 0.1,
        valign: "middle",
      },
      // El ancho de columna de monto varía con la cantidad de coeficientes del
      // edificio (13-28mm, ver `pdfColumnWidths`). Desde 20mm entra en una sola
      // línea con letra 7.5 y `overflow: visible` (igual que la vieja MONTO); por
      // debajo de eso un monto de 8 cifras se superpone con la columna vecina, así
      // que ahí se achica a 6.5 y se deja partir en dos líneas (`linebreak`).
      headStyles: {
        fillColor: [240, 240, 240],
        textColor: 40,
        fontStyle: "bold",
        fontSize: 7,
        cellPadding: { top: 1.2, bottom: 1.2, left: 1, right: 1 },
      },
      rowPageBreak: "avoid",
      columnStyles: Object.fromEntries(
        table.widths.map((w, i) => {
          if (!isAmount(i)) return [i, { cellWidth: w }];
          const narrow = w < 20;
          const overflow: "linebreak" | "visible" = narrow ? "linebreak" : "visible";
          return [
            i,
            {
              cellWidth: w,
              halign: "right" as const,
              fontSize: narrow ? 6.5 : 7.5,
              overflow,
              cellPadding: { top: 1.2, bottom: 1.2, left: 1, right: 1 },
            },
          ];
        })
      ),
      margin: { left: 14, right: 14 },
    };

    // Sin filas del mes (edificio sólo con impagas arrastradas): no se dibuja la
    // tabla principal — quedaría el encabezado de dos niveles solo, sin datos.
    const drewMain = table.body.length > 0;
    if (drewMain) {
      autoTable(doc, { startY: 30, head: table.head, body: table.body, ...tableStyles });
    }

    if (table.carried.length > 0) {
      // `lastAutoTable` existe en runtime (jspdf-autotable 5.0.8 → `{ finalY }`)
      // pero la v5 no lo declara en sus tipos.
      const withLast = doc as unknown as { lastAutoTable?: { finalY?: number } };
      const finalY = drewMain ? withLast.lastAutoTable?.finalY ?? 30 : 30;
      const pageHeight = doc.internal.pageSize.getHeight();
      let titleY = finalY + 10;
      let startY = finalY + 13;
      if (finalY + 25 > pageHeight - 15) {
        doc.addPage();
        titleY = 20;
        startY = 23;
      }
      doc.setFontSize(10);
      doc.setTextColor(60);
      doc.text(CARRIED_TITLE, 14, titleY);
      autoTable(doc, { startY, head: table.head, body: table.carried, ...tableStyles });
    }

    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`Generado el ${generado}`, 14, doc.internal.pageSize.getHeight() - 8);
  });

  doc.save(pdfFileName(majorityLabel));
}
