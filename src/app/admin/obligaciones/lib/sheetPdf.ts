// Import de SÓLO TIPOS: se borra al compilar, así que no rompe el `import()`
// dinámico de la librería (que es lo que la mantiene fuera del bundle).
import type { UserOptions } from "jspdf-autotable";
import { isPrintableRow, toPrintableSheets, type SheetData, type SheetRow } from "./sheetModel";

/** Las seis columnas de la planilla que el administrador ya usaba (rótulos cortos desde 2026-09-18). */
export const PDF_COLUMNS = [
  "FACTURA/NRO CLIENTE",
  "PROVEEDOR/SERVICIO",
  "MONTO",
  "ALIAS - CBU",
  "TÉCNICO O GESTOR",
  "TEL. CONTACTO",
];

export type PdfTable = {
  title: string;
  subtitle: string;
  head: string[][];
  body: string[][];
  /** Bloque "Otras boletas del mes", entre la tabla del mes y las impagas. */
  others: string[][];
  /** Bloque "Vienen del mes anterior", debajo de la tabla del mes. */
  carried: string[][];
};

/** Título del bloque de impagas dentro de la hoja del edificio. */
export const CARRIED_TITLE = "VIENEN DEL MES ANTERIOR";
/** Título del bloque de boletas de proveedores que no son gasto fijo del edificio. */
export const OTHERS_TITLE = "OTRAS BOLETAS DEL MES";

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
 * Una fila madre y sus adicionales. Si la madre no se imprime (salteada), las
 * adicionales llevan el concepto completo: no hay línea a la que indentarse.
 */
function rowLines(row: SheetRow): string[][] {
  const madre = isPrintableRow(row);
  const extras = row.extras.map((e) => [
    "",
    madre ? `   ↳ ${e.ordinal}ª boleta` : `${row.concepto} — ${e.ordinal}ª boleta`,
    e.monto != null ? money.format(e.monto) : "",
    row.aliasCbu.join("\n"),
    "",
    "",
  ]);
  if (!madre) return extras;
  return [
    [
      row.facturas ?? "",
      row.concepto,
      row.monto != null ? money.format(row.monto) : "",
      row.aliasCbu.join("\n"),
      "", // TÉCNICO O GESTOR — se completa a mano
      "", // TEL. CONTACTO — se completa a mano
    ],
    ...extras,
  ];
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
    body: sheet.rows.flatMap(rowLines),
    others: sheet.others.map((row) => [
      row.facturas ?? "",
      row.fantasia ? `${row.concepto} (${row.fantasia})` : row.concepto,
      row.monto != null ? money.format(row.monto) : "",
      row.aliasCbu.join("\n"),
      "",
      "",
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
      row.aliasCbu.join("\n"),
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

    // Un bloque = título + otra tabla en la MISMA hoja, debajo de la anterior.
    // `lastAutoTable` existe en runtime (verificado con jspdf-autotable 5.0.8:
    // devuelve `{ finalY }`), pero la v5 no lo declara en sus tipos — el plugin
    // lo agrega al documento sin augmentar la interfaz de jsPDF.
    const appendBlock = (title: string, body: string[][]) => {
      if (body.length === 0) return;
      const withLast = doc as unknown as { lastAutoTable?: { finalY?: number } };
      const finalY = withLast.lastAutoTable?.finalY ?? 30;
      doc.setFontSize(10);
      doc.setTextColor(60);
      doc.text(title, 14, finalY + 10);
      autoTable(doc, { startY: finalY + 13, head: table.head, body, ...tableStyles });
    };

    autoTable(doc, { startY: 30, head: table.head, body: table.body, ...tableStyles });
    // Primero lo que llegó este mes fuera del padrón, después lo que viene
    // atrasado: el administrador lee de lo corriente a lo viejo, distinguible
    // de un vistazo.
    appendBlock(OTHERS_TITLE, table.others);
    appendBlock(CARRIED_TITLE, table.carried);

    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`Generado el ${generado}`, 14, doc.internal.pageSize.getHeight() - 8);
  });

  doc.save(pdfFileName(majorityLabel));
}
