// Import de SÓLO TIPOS: se borra al compilar, así que no rompe el `import()`
// dinámico de la librería (que es lo que la mantiene fuera del bundle).
import type { UserOptions } from "jspdf-autotable";
import { toPrintableSheets, type SheetData } from "./sheetModel";

/** Las seis columnas de la planilla que el administrador ya usaba. */
export const PDF_COLUMNS = [
  "FACTURAS",
  "PROVEEDORES Y SERVICIOS",
  "MONTO",
  "ALIAS CBU",
  "TÉCNICO O GESTOR",
  "TEL. CONTACTO",
];

export type PdfTable = {
  title: string;
  subtitle: string;
  head: string[][];
  body: string[][];
  /** Bloque "Impagas de meses anteriores", debajo de la tabla del mes. */
  carried: string[][];
};

/** Título del bloque de impagas dentro de la hoja del edificio. */
export const CARRIED_TITLE = "IMPAGAS DE MESES ANTERIORES";

const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

/** "agosto 2026" → "Agosto 2026" (la API devuelve el mes en minúscula). */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Normaliza el nombre del banco **sólo para el papel**: el catálogo los tiene
 * cargados con mayúsculas y minúsculas mezcladas ("CIUDAD", "santander"), y en
 * el encabezado impreso conviene que se vean todos igual. No toca el registro.
 */
function formatBankName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("es-AR")
    .split(/\s+/)
    .map((word) => capitalize(word))
    .join(" ");
}

/**
 * Convierte las hojas en tablas listas para `autoTable`. Puro: es lo que se
 * testea. El filtro de qué se imprime vive en `toPrintableSheets`, no acá.
 */
export function toPdfTables(sheets: SheetData[]): PdfTable[] {
  return toPrintableSheets(sheets).map((sheet) => ({
    title: sheet.consortiumName,
    // Rotulado explícito: en el papel tiene que leerse qué es cada dato.
    subtitle: [
      sheet.bankName ? `BANCO: ${formatBankName(sheet.bankName)}` : null,
      sheet.periodLabel ? `PERIODO: ${capitalize(sheet.periodLabel)}` : null,
    ]
      .filter(Boolean)
      .join("   ·   "),
    head: [PDF_COLUMNS],
    body: sheet.rows.map((row) => [
      row.facturas ?? "",
      row.concepto,
      row.monto != null ? money.format(row.monto) : "",
      row.aliasCbu ?? "",
      "", // TÉCNICO O GESTOR — se completa a mano
      "", // TEL. CONTACTO — se completa a mano
    ]),
    // El monto de una impaga es el saldo (sobre el 2° vencimiento si se cargó);
    // el 1° pago va en el concepto para no meter dos números en la celda MONTO.
    carried: sheet.carried.map((row) => [
      row.facturas ?? "",
      `${row.concepto}${row.fromLabel ? ` — de ${row.fromLabel}` : ""}` +
        (row.lateAmount != null && row.originalAmount != null
          ? ` (1° pago ${money.format(row.originalAmount)})`
          : ""),
      money.format(row.monto),
      row.aliasCbu ?? "",
      "",
      "",
    ]),
  }));
}

export function pdfFileName(majorityLabel: string | null): string {
  if (!majorityLabel) return "obligaciones.pdf";
  const slug = majorityLabel
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-");
  return `obligaciones-${slug}.pdf`;
}

/**
 * Arma el PDF y dispara la descarga.
 *
 * `jspdf` y `jspdf-autotable` se cargan con `import()` dinámico: son ~350 KB que
 * no tienen por qué viajar en el bundle del panel hasta que alguien aprieta
 * Descargar. Por eso esta función es async y el botón usa `AsyncButton`.
 */
export async function downloadSheetsPdf(
  sheets: SheetData[],
  majorityLabel: string | null
): Promise<void> {
  const tables = toPdfTables(sheets);
  if (tables.length === 0) return;

  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);

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

    const tableStyles: Partial<UserOptions> = {
      // Filas compactas: el padding vertical se baja a 1.2mm (el horizontal se
      // mantiene para que el texto no toque el borde de la celda).
      styles: {
        fontSize: 9,
        cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 },
        lineColor: 200,
        lineWidth: 0.1,
        valign: "middle",
      },
      headStyles: { fillColor: [240, 240, 240], textColor: 40, fontStyle: "bold" },
      // Los anchos suman los 182mm útiles de un A4 con márgenes de 14mm.
      // MONTO se lleva 36mm y `overflow: "visible"`: montos de dos cifras de
      // millón ($ 12.470.392,00) entran en una sola línea, sin cortarse.
      columnStyles: {
        0: { cellWidth: 20 },
        1: { cellWidth: 52 },
        2: { cellWidth: 36, halign: "right", overflow: "visible" },
        3: { cellWidth: 26 },
        4: { cellWidth: 26 },
        5: { cellWidth: 22 },
      },
      margin: { left: 14, right: 14 },
    };

    autoTable(doc, { startY: 30, head: table.head, body: table.body, ...tableStyles });

    // Las impagas van en una segunda tabla de la MISMA hoja, debajo de la del
    // mes: el administrador ve primero lo corriente y después lo atrasado.
    if (table.carried.length > 0) {
      // `lastAutoTable` existe en runtime (verificado con jspdf-autotable 5.0.8:
      // devuelve `{ finalY }`), pero la v5 no lo declara en sus tipos — el
      // plugin lo agrega al documento sin augmentar la interfaz de jsPDF.
      const withLast = doc as unknown as { lastAutoTable?: { finalY?: number } };
      const finalY = withLast.lastAutoTable?.finalY ?? 30;

      doc.setFontSize(10);
      doc.setTextColor(60);
      doc.text(CARRIED_TITLE, 14, finalY + 10);

      autoTable(doc, {
        startY: finalY + 13,
        head: table.head,
        body: table.carried,
        ...tableStyles,
      });
    }

    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`Generado el ${generado}`, 14, doc.internal.pageSize.getHeight() - 8);
  });

  doc.save(pdfFileName(majorityLabel));
}
