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
export type NotBoletaKind = never;

/**
 * Capa 0 del triage: tipos de documento **inequívocos**, que se descartan aunque
 * tengan todas las señales de una boleta.
 *
 * Existe porque `classifyDocumentType` no puede agarrarlos: exige que NO haya
 * señales de boleta, y tanto un VEP como un LSD tienen `$` y CUIT. Agregarlos a
 * `NOT_BOLETA_MARKERS` no serviría de nada.
 *
 * **Hoy está vacía.** Nació el 2026-08-31 con el VEP y el LSD; los dos salieron
 * después porque pasaron a procesarse (el LSD el 2026-09-01, el VEP el
 * 2026-09-03) y hoy los detecta el router de prompts (`identifyLSPProvider`). El
 * mecanismo se conserva —la firma, el gate que la llama y su lugar en el
 * pipeline— para el próximo formulario que haya que descartar.
 */
export function detectDecisiveNotBoleta(_text: string): NotBoletaKind | null {
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
