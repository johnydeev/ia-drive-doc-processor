import { formatCuit, isValidCuit } from "@/lib/cuit";

/**
 * Código de barras de comprobantes AFIP (RG 1702).
 *
 * Son 40 dígitos con tramos fijos: CUIT del EMISOR (11) + tipo de comprobante (2)
 * + punto de venta (4) + CAE (14) + vencimiento del CAE en AAAAMMDD (8) + dígito
 * verificador (1).
 *
 * Sirve para recuperar el CUIT del emisor en las facturas cuyo membrete es una
 * imagen (logo escaneado): el bloque del emisor no deja texto, pero el sistema de
 * facturación suele imprimir los dígitos del código debajo de las barras. Es
 * determinístico: no interviene ningún modelo.
 *
 * OJO — la RG obliga a IMPRIMIR el código, no a que los dígitos queden como texto
 * extraíble. Medido sobre boletas reales, solo ~6% lo trae. Es un refuerzo barato,
 * no un reemplazo del fallback visual.
 */
export interface AfipBarcode {
  /** Los 40 dígitos crudos. */
  raw: string;
  /** CUIT del emisor, canónico `XX-XXXXXXXX-X`. */
  cuit: string;
  /** Código de tipo de comprobante (01 = Factura A, 06 = Factura B, 11 = Factura C…). */
  tipoComprobante: string;
  /** Punto de venta, 4 dígitos. */
  puntoVenta: string;
  /** CAE, 14 dígitos. */
  cae: string;
  /** Vencimiento del CAE, `AAAAMMDD`. */
  caeVto: string;
  /** Dígito verificador. */
  dv: string;
  /** El CAE o el punto de venta del código coinciden con los impresos en el texto. */
  corroborated: boolean;
}

const BARCODE_LENGTH = 40;

/** Prefijos válidos de CUIT/CUIL (tipo de persona). */
const VALID_CUIT_PREFIXES = ["20", "23", "24", "25", "26", "27", "30", "33", "34"];

/** ¿Los 8 dígitos son una fecha `AAAAMMDD` plausible? */
function isPlausibleDate(yyyymmdd: string): boolean {
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  return year >= 2010 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** CAEs impresos aparte en el documento (etiqueta "CAE" seguida de 14 dígitos). */
function printedCaes(text: string): string[] {
  return [...text.matchAll(/C\.?A\.?E\.?[^0-9]{0,20}(\d{14})/gi)].map((m) => m[1]);
}

/** Puntos de venta impresos en el número de comprobante (`0010-00051837`). */
function printedPuntosVenta(text: string): string[] {
  return [...text.matchAll(/\b(\d{4})-(\d{8})\b/g)].map((m) => m[1]);
}

/**
 * Extrae los códigos de barras AFIP del texto de un PDF, ya validados.
 *
 * Se descartan las corridas de 40 dígitos que no son un código: los códigos de
 * pago electrónico (Banelco, PagoMisCuentas, CESP) también son cadenas largas de
 * dígitos y sin validación entregarían un CUIT falso — el bug de asignarle la
 * boleta a un proveedor equivocado. Filtros: prefijo de CUIT válido + checksum
 * módulo 11 + vencimiento del CAE con forma de fecha.
 *
 * Solo se leen corridas CONTIGUAS de dígitos: no se pegan números separados por
 * espacios, porque concatenar cifras vecinas inventa códigos que no existen.
 */
export function parseAfipBarcodes(text: string | null | undefined): AfipBarcode[] {
  if (!text) return [];

  const caes = printedCaes(text);
  const puntosVenta = printedPuntosVenta(text);
  const result: AfipBarcode[] = [];

  for (const match of text.matchAll(/\d{40,}/g)) {
    const run = match[0];
    for (let offset = 0; offset + BARCODE_LENGTH <= run.length; offset += BARCODE_LENGTH) {
      const raw = run.slice(offset, offset + BARCODE_LENGTH);
      const cuit = raw.slice(0, 11);
      const caeVto = raw.slice(31, 39);

      if (!VALID_CUIT_PREFIXES.includes(cuit.slice(0, 2))) continue;
      if (!isValidCuit(cuit)) continue;
      if (!isPlausibleDate(caeVto)) continue;

      const cae = raw.slice(17, 31);
      const puntoVenta = raw.slice(13, 17);

      result.push({
        raw,
        cuit: formatCuit(cuit) ?? cuit,
        tipoComprobante: raw.slice(11, 13),
        puntoVenta,
        cae,
        caeVto,
        dv: raw.slice(39, 40),
        corroborated: caes.includes(cae) || puntosVenta.includes(puntoVenta),
      });
    }
  }

  return result;
}

/**
 * CUIT del emisor a partir del código de barras, o `null` si el documento no
 * trae uno confiable.
 *
 * Cuando el documento imprime el CAE o el número de comprobante aparte, el código
 * tiene que COINCIDIR con ellos: que 18 dígitos den iguales por casualidad no
 * pasa, así que esa corroboración es la garantía fuerte de que se leyó un código
 * de barras y no otra cosa. Si el documento no imprime ninguno de los dos, se
 * acepta el código validado estructuralmente.
 */
export function extractEmitterCuitFromBarcode(text: string | null | undefined): string | null {
  const barcodes = parseAfipBarcodes(text);
  if (barcodes.length === 0) return null;

  const corroborated = barcodes.filter((b) => b.corroborated);
  if (corroborated.length > 0) return corroborated[0].cuit;

  // Sin nada contra qué contrastar (ni CAE ni número de comprobante en el texto):
  // el código validado es la única señal, y alcanza — un CUIT que no esté en el
  // directorio del cliente no matchea con nadie y la boleta queda como estaba.
  const hasCorroborationData = printedCaes(text!).length > 0 || printedPuntosVenta(text!).length > 0;
  if (hasCorroborationData) return null;

  return barcodes[0].cuit;
}
