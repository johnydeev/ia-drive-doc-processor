/**
 * Guard del vencimiento del CAE.
 *
 * Los prompts prohíben explícitamente usar la "Fecha de Vto. de CAE" como
 * `dueDate` — es la caducidad de la autorización de AFIP, no una fecha de pago.
 * Igual el modelo la devuelve: se detectó en producción el 2026-08-18 con una
 * factura de Fumigaciones Miguel (EVA PERON 1761) que entró con
 * `dueDate = 2026-07-07`, exactamente su "Fecha de Vto. de CAE: 07/07/2026".
 *
 * La boleta hermana, mismo emisor y mismo layout, devolvió `null` correctamente.
 * O sea: no es el prompt, es inconsistencia del modelo. Y es peor que un rebote,
 * porque la boleta entra en silencio con un vencimiento falso.
 *
 * Por eso el guard es determinístico y no depende de que el modelo obedezca.
 */

/** Ventana de texto ANTES de la fecha donde se busca el rótulo del CAE. */
const LABEL_WINDOW = 60;

/**
 * Texto anterior a la fecha donde se busca el rótulo, **sin cruzar el salto de
 * línea**: en las tres formas reales el rótulo del CAE está en la MISMA línea que
 * su fecha.
 *
 * Sin ese corte, una ventana de 60 caracteres se comía la línea siguiente y
 * marcaba como CAE la fecha de emisión (`Fecha 27/06/2026` en la factura de EVA
 * PERON 1761). Ese falso positivo habría anulado vencimientos buenos — peor que
 * el bug que este guard arregla.
 */
function labelWindow(text: string, dateIndex: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, dateIndex - 1)) + 1;
  const start = Math.max(lineStart, dateIndex - LABEL_WINDOW);
  return text.slice(start, dateIndex).toUpperCase();
}

const DATE_RE = /(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/g;

/** `12/03/26` y `07/07/2026` → `2026-03-12` / `2026-07-07`. */
function toIso(day: string, month: string, year: string): string | null {
  const d = Number(day);
  const m = Number(month);
  let y = Number(year);
  if (year.length === 2) y += 2000;

  if (d < 1 || d > 31 || m < 1 || m > 12 || y < 2000 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Fechas del documento que son vencimiento del CAE, en ISO.
 *
 * En vez de rotular por "Vto" —que también aparece en el vencimiento de pago,
 * el bueno— se mira la ventana de texto ANTERIOR a cada fecha: si menciona el
 * CAE, la fecha es del CAE. Cubre las tres formas que aparecen en el papel:
 *
 *   Fecha de Vto. de CAE: 07/07/2026
 *   Fecha de Vito. de CAE: 11/07/2026        (así lo leyó el OCR)
 *   Nro. de CAE: 86095857203130 - Fecha de Vto.: 12/03/26
 *
 * Si la ventana además menciona un PAGO, la fecha se deja en paz: los prompts
 * tratan "vencimiento para el pago" como siempre válido, y esa regla manda.
 */
export function extractCaeExpiryDates(text: string | null | undefined): string[] {
  if (!text) return [];

  const dates: string[] = [];

  for (const match of text.matchAll(DATE_RE)) {
    const iso = toIso(match[1], match[2], match[3]);
    if (!iso) continue;

    const window = labelWindow(text, match.index ?? 0);

    if (!/C\.?A\.?E\.?\b/.test(window)) continue;
    if (window.includes("PAGO")) continue;

    dates.push(iso);
  }

  return [...new Set(dates)];
}

export interface CaeDueDateCorrection {
  dueDate: string | null;
  /** El vencimiento extraído era el del CAE y se anuló. */
  corrected: boolean;
}

/**
 * Anula el `dueDate` si coincide con un vencimiento de CAE del documento.
 *
 * Ante la duda no inventa nada: deja `null`, que es lo que los prompts piden
 * cuando la fecha no es un vencimiento de pago identificable.
 */
export function correctCaeDueDate(
  dueDate: string | null | undefined,
  text: string | null | undefined
): CaeDueDateCorrection {
  if (!dueDate) return { dueDate: dueDate ?? null, corrected: false };

  const caeDates = extractCaeExpiryDates(text);
  if (caeDates.includes(dueDate)) {
    return { dueDate: null, corrected: true };
  }

  return { dueDate, corrected: false };
}
