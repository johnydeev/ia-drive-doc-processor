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

export function classifyDocumentType(text: string): DocumentClass {
  const upper = text.slice(0, 4000).toUpperCase();

  const hasNegative = NOT_BOLETA_MARKERS.some((marker) => upper.includes(marker));
  if (!hasNegative) return "boleta";

  const hasBoletaSignal =
    BOLETA_MARKERS.some((marker) => upper.includes(marker)) ||
    extractCuitsFromText(text).length > 0;

  return hasBoletaSignal ? "boleta" : "not_boleta";
}
