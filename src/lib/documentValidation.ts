import { cuitDigits } from "@/lib/cuit";

/**
 * Validaciones de documento para el pipeline (funciones puras, testeables).
 * - isMissingAmount: distingue "no hay monto" (null) de un monto $0 válido.
 * - cuitAppearsInText: detecta CUIT inventado (no presente en el texto del doc).
 * - appendNoAmountTag: etiqueta el nombre del archivo sin monto.
 * (La extracción/normalización de CUIT vive en lib/cuit.ts — fuente única.)
 */

/** true si NO hay monto extraíble (nullish). `0` es un monto válido → false. */
export function isMissingAmount(amount: number | null | undefined): boolean {
  return amount === null || amount === undefined;
}

/**
 * ¿Los dígitos del CUIT aparecen en el texto del documento? Normaliza ambos a
 * solo dígitos (tolera guiones/espacios). CUIT real = 11 dígitos; por debajo de
 * 10 no se considera (evita matches triviales).
 */
export function cuitAppearsInText(cuit: string | null | undefined, text: string): boolean {
  const c = cuitDigits(cuit);
  if (c.length < 10) return false;
  return cuitDigits(text).includes(c);
}

/**
 * Etiquetas de sufijo conocidas del pipeline (motivo por el que un archivo quedó
 * sin procesar). Se listan acá para poder limpiarlas de forma idempotente al
 * reprocesar (que el nombre no las apile: "x - SIN MONTO - SIN MONTO.pdf").
 */
export const KNOWN_SUFFIX_TAGS = [
  "SIN MONTO",
  "SIN PROVEEDOR",
  "PROVEEDOR SIN REGISTRAR",
  "SIN CONSORCIO",
  "CONSORCIO SIN REGISTRAR",
  "SIN PERÍODO",
  "LSP SIN REGISTRAR",
  // Facturas comunes (2026-08-26). Van DESPUÉS de las viejas para que un archivo
  // que arrastra una etiqueta anterior también se limpie al reprocesarse.
  "CUIT DE CONSORCIO INEXISTENTE EN BOLETA",
  "CUIT DE CONSORCIO NO REGISTRADO EN DB",
  "CUIT DE PROVEEDOR INEXISTENTE EN BOLETA",
  "CUIT DE PROVEEDOR NO REGISTRADO EN DB",
] as const;

function stripKnownSuffixTags(base: string): string {
  const alt = KNOWN_SUFFIX_TAGS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`\\s*-\\s*(?:${alt})\\s*$`, "i");
  let out = base;
  while (re.test(out)) out = out.replace(re, "");
  return out;
}

/**
 * Agrega " - <tag>" antes de la extensión, de forma IDEMPOTENTE: primero quita
 * cualquier etiqueta conocida ya presente (la misma u otra) para que el nombre no
 * las apile al reprocesar. Ej: "x - SIN MONTO.pdf" + "SIN PROVEEDOR" →
 * "x - SIN PROVEEDOR.pdf".
 */
export function appendTag(fileName: string, tag: string): string {
  const dot = fileName.lastIndexOf(".");
  const hasExt = dot > 0;
  const nameBase = hasExt ? fileName.slice(0, dot) : fileName;
  const ext = hasExt ? fileName.slice(dot) : "";
  return `${stripKnownSuffixTags(nameBase)} - ${tag}${ext}`;
}

/** Agrega " - SIN MONTO" antes de la extensión (idempotente vía appendTag). */
export function appendNoAmountTag(fileName: string): string {
  return appendTag(fileName, "SIN MONTO");
}

/** Prefijo de no-boleta, con o sin tipo: "[NO BOLETA] " o "[NO BOLETA - VEP] ". */
const NOT_BOLETA_PREFIX_RE = /^\s*\[NO BOLETA(?:\s*-\s*[^\]]+)?\]\s*/i;

/**
 * Antepone el prefijo "[NO BOLETA] " al nombre del archivo (triage de no-boletas).
 * Con `kind`, el prefijo lleva el tipo: "[NO BOLETA - VEP] ".
 *
 * **Idempotente**: primero quita el prefijo que hubiera (el mismo u otro tipo),
 * para que reprocesar no lo apile. Sin esto, devolver un archivo a Pendientes y
 * volver a procesarlo daba "[NO BOLETA] [NO BOLETA] archivo.pdf" — el mismo bug
 * que tuvieron las etiquetas de sufijo antes de `KNOWN_SUFFIX_TAGS`.
 */
export function markNotBoleta(fileName: string, kind?: string): string {
  const base = fileName.replace(NOT_BOLETA_PREFIX_RE, "");
  const label = kind ? `[NO BOLETA - ${kind}]` : "[NO BOLETA]";
  return `${label} ${base}`;
}

