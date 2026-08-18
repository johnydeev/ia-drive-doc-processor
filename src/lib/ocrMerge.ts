import { cuitDigits, extractCuitsFromText } from "@/lib/cuit";

/**
 * ¿El texto del OCR aporta algún CUIT que el texto directo no tiene?
 *
 * Se comparan por dígitos y solo cuentan los que pasan checksum
 * (`extractCuitsFromText` ya filtra por regex + módulo 11), así que el ruido del
 * OCR no cuenta como aporte.
 */
export function ocrAddsNewCuits(directText: string, ocrText: string): boolean {
  const ocrCuits = extractCuitsFromText(ocrText);
  if (ocrCuits.length === 0) return false;

  const directCuits = new Set(extractCuitsFromText(directText).map((c) => cuitDigits(c)));
  return ocrCuits.some((c) => !directCuits.has(cuitDigits(c)));
}

/**
 * ¿Vale la pena conservar el texto del OCR junto al de pdf-parse?
 *
 * El criterio histórico era solo la LONGITUD, y descartaba justo el caso que más
 * importa: las facturas con el cuerpo en texto (ítems, importes, CAE) y el
 * membrete en imagen. Ahí el texto directo es largo y el del OCR corto —aporta
 * apenas la razón social y el CUIT del emisor—, así que se tiraba entero con el
 * CUIT adentro y la boleta terminaba en Sin Asignar por SIN PROVEEDOR.
 *
 * Ahora también se conserva cuando el OCR aporta un CUIT nuevo, que es la señal
 * de que leyó el bloque del emisor que faltaba.
 */
export function shouldMergeOcrText(directText: string, ocrText: string): boolean {
  if (!ocrText) return false;
  return ocrText.length > directText.length || ocrAddsNewCuits(directText, ocrText);
}
