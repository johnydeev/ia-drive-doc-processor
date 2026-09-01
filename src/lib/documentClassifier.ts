import { extractCuitsFromText } from "@/lib/cuit";

/**
 * Clasificación binaria de un documento por heurística (capa 1 del triage).
 * Función pura, testeable. NO usa IA. Sesgo conservador: solo devuelve
 * "not_boleta" cuando hay una señal negativa fuerte Y ninguna señal de boleta;
 * ante la duda devuelve "boleta" (= seguir el flujo normal de extracción).
 */
export type DocumentClass = "not_boleta" | "boleta";

/** Señales negativas fuertes: tipos de documento que NO son boletas/gastos. */
const NOT_BOLETA_MARKERS = [
  "OBLEA",
  "RUBRICA",
  "RÚBRICA",
  "CERTIFICADO DE DESINFECCION",
  "CERTIFICADO DE DESINSECTACION",
  "CERTIFICADO DE DESRATIZACION",
  "CERTIFICADO DE FUMIGACION",
  "CONTROL DE PLAGAS",
  "PLANO",
  "DISPOSICION",
  "DISPOSICIÓN",
  "HABILITACION",
  "HABILITACIÓN",
  "INFORME TECNICO",
  "INFORME TÉCNICO",
  "ACTA",
];

/** Señales de boleta: si alguna aparece, el documento se trata como boleta. */
const BOLETA_MARKERS = [
  "$",
  "TOTAL A PAGAR",
  "IMPORTE",
  "VENCIMIENTO",
  "FACTURA",
  "RECIBO",
  "COMPROBANTE",
  "CAE",
];

/** Tipos de documento que NO son boletas y se identifican sin ambigüedad. */
export type NotBoletaKind = "VEP" | "LSD";

/** Normaliza para comparar: sin acentos, en mayúsculas, sin espacios repetidos. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ");
}

/**
 * Ventana del ENCABEZADO para el VEP. Es la clave del detector.
 *
 * El F931 de ARCA se extrae con 2 páginas porque el "Importe total a pagar" está
 * en el VEP de la página 2 — o sea su texto CONTIENE "Volante Electrónico de
 * Pago", y es un gasto real que se paga. Buscando sólo en el encabezado, un VEP
 * suelto (que lo trae en la línea 2) se detecta y el F931 no.
 */
const VEP_HEADER_CHARS = 200;
const VEP_HEADER_MARKERS = ["VOLANTE ELECTRONICO DE PAGO", "NRO. VEP:", "NRO VEP:"];

/**
 * Marcadores del Libro de Sueldos Digital. Salen del papel real: el texto
 * extraíble **no** dice "libro de sueldos digital" en ningún lado, así que el
 * marcador obvio no habría detectado nada.
 *
 * Se exigen DOS coincidencias: cada frase por separado podría aparecer en otro
 * documento de RRHH, pero las tres juntas son el encabezado del LSD.
 */
const LSD_MARKERS = [
  "EMPRESA DOMICILIO FISCAL",
  "NRO.LIQUIDACION",
  "ACTIVIDAD PPAL",
  "IDENTIFICADOR UNICO DEL LIBRO",
  "IDENTIFICADOR UNICO DE HOJA MOVIL",
  "LEGAJO CUIL APELLIDO Y NOMBRE",
];
const LSD_MIN_MARKERS = 2;

/**
 * Capa 0 del triage: tipos de documento **inequívocos**, que se descartan aunque
 * tengan todas las señales de una boleta.
 *
 * Existe porque `classifyDocumentType` no puede agarrarlos: exige que NO haya
 * señales de boleta, y un VEP tiene `$`, `IMPORTE`, `VENCIMIENTO` y CUIT; un LSD
 * tiene `$` y CUIT. Agregarlos a `NOT_BOLETA_MARKERS` no serviría de nada.
 *
 * Devuelve el tipo (para etiquetar el archivo) o `null` si no es ninguno.
 */
export function detectDecisiveNotBoleta(text: string): NotBoletaKind | null {
  const header = normalize(text.slice(0, VEP_HEADER_CHARS));
  if (VEP_HEADER_MARKERS.some((marker) => header.includes(marker))) return "VEP";

  const body = normalize(text.slice(0, 4000));
  const hits = LSD_MARKERS.filter((marker) => body.includes(marker)).length;
  if (hits >= LSD_MIN_MARKERS) return "LSD";

  return null;
}

export function classifyDocumentType(text: string): DocumentClass {
  const upper = text.slice(0, 4000).toUpperCase();

  const hasNegative = NOT_BOLETA_MARKERS.some((marker) => upper.includes(marker));
  if (!hasNegative) return "boleta";

  const hasBoletaSignal =
    BOLETA_MARKERS.some((marker) => upper.includes(marker)) ||
    extractCuitsFromText(text).length > 0;

  return hasBoletaSignal ? "boleta" : "not_boleta";
}
