/**
 * Reflow de totales de comprobantes AFIP ("Comprobante en línea").
 *
 * Problema real: `pdf-parse` extrae la columna de importes SEPARADA de sus
 * rótulos. El número del total queda flotando varias líneas ARRIBA de un rótulo
 * `Importe Total: $` vacío, y los modelos de IA débiles no logran reasociarlos
 * → devuelven `amount: null` y la boleta cae a Revisión con el tag "SIN MONTO".
 *
 * Estructura típica que produce pdf-parse:
 *
 *     0,00            ← número suelto
 *     85000,00        ← número suelto
 *     85000,00        ← número suelto, inmediato al 1er rótulo
 *     Subtotal: $
 *     Importe Otros Tributos: $
 *     Importe Total: $
 *
 * Regla confiable (validada con boletas reales): el **Importe Total** es el
 * número suelto inmediatamente anterior a la línea `Subtotal: $`. Esta función
 * reescribe el rótulo `Importe Total: $` → `Importe Total: $ <total>` para que
 * cualquier extractor lo lea inline.
 *
 * No toca subtotal/otros tributos: su orden en el texto extraído es ambiguo y no
 * hacen falta para `amount`. Si no encuentra un número válido, no inventa nada
 * (no-op). Es una función pura y idempotente.
 */

/** Importe AFIP: dígitos con separador opcional de miles y 2 decimales (85.000,00 / 85000,00). */
const AMOUNT_LINE = /^\$?\s*(\d{1,3}(?:\.\d{3})*|\d+),\d{2}$/;
/** Rótulo "Subtotal: $" sin número (ancla del bloque de totales). */
const SUBTOTAL_LABEL = /^Subtotal\s*:\s*\$?\s*$/i;
/** Rótulo "Importe Total: $" — vacío (a reescribir) o ya con número (a respetar). */
const IMPORTE_TOTAL_EMPTY = /^Importe Total\s*:\s*\$?\s*$/i;

export function reflowAfipTotals(text: string): string {
  if (!text || !text.includes("Importe Total")) return text;

  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!IMPORTE_TOTAL_EMPTY.test(lines[i].trim())) continue;

    // Buscar el rótulo "Subtotal: $" que ancla este bloque, unas pocas líneas
    // arriba del "Importe Total: $" (entre medio va "Importe Otros Tributos: $").
    let subtotalIdx = -1;
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      if (SUBTOTAL_LABEL.test(lines[j].trim())) {
        subtotalIdx = j;
        break;
      }
    }
    if (subtotalIdx <= 0) continue;

    // El número inmediatamente anterior al rótulo "Subtotal: $" es el Importe Total.
    const candidate = lines[subtotalIdx - 1].trim();
    const match = candidate.match(AMOUNT_LINE);
    if (!match) continue;

    const total = candidate.replace(/^\$?\s*/, "");
    lines[i] = `Importe Total: $ ${total}`;
  }

  return lines.join("\n");
}
