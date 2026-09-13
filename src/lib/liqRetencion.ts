/**
 * Liquidación de retenciones (spec 2026-09-12): el paquete que arma la
 * administración cuando el consorcio le retiene a su empresa de seguridad o
 * limpieza — planilla propia + certificados SICORE/F.2004/F.2005 + VEP
 * consolidado. NO es la factura (esa se sube aparte): la boleta que sale de acá
 * es la RETENCIÓN, a nombre de la empresa, y el nro. es el del VEP.
 *
 * Todo por regex: la planilla es un formato fijo y pdf-parse la devuelve una
 * línea por campo con el monto al lado.
 */
import { extractCuitsFromText, formatCuit } from "@/lib/cuit";
import { normalizeBusinessAmount } from "@/lib/businessKey";
import type { ExtractedDocumentData } from "@/types/extractedDocument.types";

const MARKERS = ["SUBTOTAL RETENCIONES", "IMPORTE NETO", "NOMBRE DEL PROVEEDOR"];

/** Recibe el texto ya en mayúsculas (el router trabaja así). */
export function isLiqRetencionText(upper: string): boolean {
  return MARKERS.every((m) => upper.includes(m));
}

export interface LiqRetencion {
  /** Dígitos. Primer "C.U.I.T. N*" de la planilla. */
  consortiumCuit: string;
  providerName: string | null;
  /** Dígitos. Segundo "C.U.I.T. N*" de la planilla. */
  providerCuit: string;
  invoiceNumber: string | null;
  invoiceTotal: number | null;
  lines: Array<{ label: string; amount: number }>;
  /** "SUBTOTAL RETENCIONES" = "Importe total a pagar" del VEP. */
  subtotal: number;
  vepNumber: string | null;
  /** "Día de Expiración" del VEP, YYYY-MM-DD. */
  expiresOn: string | null;
}

const AMOUNT = String.raw`\$?\s*([\d.]+,\d{2})`;

function amount(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = normalizeBusinessAmount(raw);
  return n ? Number(n) : null;
}

function first(text: string, re: RegExp): string | undefined {
  return re.exec(text)?.[1]?.trim();
}

/** null si falta alguno de: los dos CUIT válidos, el subtotal. */
export function parseLiqRetencion(text: string): LiqRetencion | null {
  // Los dos CUIT de la planilla, en orden: consorcio, empresa. Checksum obligatorio.
  const cuitLines = [...text.matchAll(/C\.U\.I\.T\.\s*N[*°º]?\s*([\d-]{11,13})/gi)].map((m) => m[1]);
  const consortiumCuit = extractCuitsFromText(cuitLines[0] ?? "")[0];
  const providerCuit = extractCuitsFromText(cuitLines[1] ?? "")[0];
  const subtotal = amount(first(text, new RegExp(String.raw`SUBTOTAL RETENCIONES\s*${AMOUNT}`, "i")));
  if (!consortiumCuit || !providerCuit || subtotal === null) return null;

  const lines: LiqRetencion["lines"] = [];
  const start = text.search(/RETENCION:/i);
  const end = text.search(/SUBTOTAL RETENCIONES/i);
  const block = start >= 0 && end > start ? text.slice(start, end) : "";
  for (const m of block.matchAll(new RegExp(String.raw`^(IVA|GANANCIAS|SEGURIDAD SOCIAL)\s+${AMOUNT}\s*$`, "gim"))) {
    const a = amount(m[2]);
    if (a !== null) lines.push({ label: m[1].toUpperCase(), amount: a });
  }

  return {
    consortiumCuit,
    providerName: first(text, /NOMBRE DEL PROVEEDOR:\s*(.+)$/im) ?? null,
    providerCuit,
    invoiceNumber: first(text, /FACTURA\s+[A-C]?\s*N[*°º]?:\s*([\d-]+)/i) ?? null,
    invoiceTotal: amount(first(text, new RegExp(String.raw`IMPORTE TOTAL:\s*${AMOUNT}`, "i"))),
    lines,
    subtotal,
    vepNumber: first(text, /Nro\.\s*VEP(?:\s+Consolidado)?:\s*(\d+)/i) ?? null,
    expiresOn: first(text, /D[ií]a de Expiraci[oó]n:\s*(\d{4}-\d{2}-\d{2})/i) ?? null,
  };
}

const fmt = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Lo que el pipeline persiste. */
export function toExtractedDocument(liq: LiqRetencion): ExtractedDocumentData {
  const desglose = liq.lines.map((l) => `${l.label} ${fmt.format(l.amount)}`).join(" · ");
  return {
    // El Nro. VEP y no el de la factura: la factura entra por su propio PDF y
    // las dos boletas tienen que convivir sin que el dedup las confunda.
    boletaNumber: liq.vepNumber ?? (liq.invoiceNumber ? `RET-${liq.invoiceNumber}` : null),
    provider: liq.providerName,
    consortium: null,
    providerTaxId: formatCuit(liq.providerCuit),
    detail: `Retenciones s/fra. ${liq.invoiceNumber ?? "?"}${desglose ? ` · ${desglose}` : ""}`,
    observation:
      liq.invoiceTotal !== null
        ? `Factura ${liq.invoiceNumber ?? "?"} $${fmt.format(liq.invoiceTotal)} · neto $${fmt.format(liq.invoiceTotal - liq.subtotal)}`
        : null,
    dueDate: liq.expiresOn,
    amount: liq.subtotal,
    alias: null,
    clientNumber: null,
    paymentMethod: null,
    // Sólo estos dos. El CUIT de la administradora está en el VEP y no debe entrar.
    allTaxIds: [formatCuit(liq.consortiumCuit)!, formatCuit(liq.providerCuit)!],
    isBoleta: true,
  };
}
