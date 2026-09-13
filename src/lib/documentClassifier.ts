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
export type NotBoletaKind = "CERTIFICADO RETENCION";

/**
 * Capa 0 del triage: tipos de documento **inequívocos**, que se descartan aunque
 * tengan todas las señales de una boleta ($, CUIT, montos).
 *
 * Existe porque `classifyDocumentType` no puede agarrarlos: exige que NO haya
 * señales de boleta. Nació el 2026-08-31 con el VEP y el LSD; los dos salieron al
 * pasar a procesarse (hoy los detecta `identifyLSPProvider`).
 *
 * Desde el 2026-09-12 tiene un caso: el **certificado de retención/percepción**
 * suelto (SICORE, F.2004, F.2005). Es el comprobante de una retención que el
 * consorcio ya ingresó por VEP; solo no hay nada que pagar, y procesado como
 * factura terminaba a nombre de la administradora. El paquete completo de
 * liquidación (planilla + certificados + VEP) NO pasa por acá: el router lo marca
 * `LIQ_RETENCION` y `documentTriageGate` lo saltea.
 */
export function detectDecisiveNotBoleta(text: string): NotBoletaKind | null {
  const upper = text.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (upper.includes("DATOS DEL AGENTE DE RETENCI") && upper.includes("DATOS DEL SUJETO RETENIDO")) {
    return "CERTIFICADO RETENCION";
  }
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
