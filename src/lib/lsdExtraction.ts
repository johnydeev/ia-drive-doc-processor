import { normalizeBusinessAmount } from "@/lib/businessKey";
import { cuitDigits } from "@/lib/cuit";

/**
 * Liquidación de Sueldos Digital (LSD).
 *
 * A diferencia de una factura, un libro NO es un gasto: es un documento que
 * contiene VARIOS gastos, uno por empleado. El pipeline lo abre en N boletas
 * (ver `docs/superpowers/specs/2026-09-01-lsd-un-libro-n-empleados-design.md`).
 *
 * El CUIT del consorcio viene impreso en el encabezado, así que el edificio se
 * resuelve con el matching por CUIT de siempre.
 */
export interface LsdEmployee {
  /** CUIL tal como lo devolvió el modelo; se compara siempre por dígitos. */
  cuil: string;
  apellidoNombre: string;
  /** Lo que cobra de bolsillo. Es el gasto que se registra. */
  sueldoNeto: number;
}

export interface LsdExtraction {
  consortiumTaxId: string | null;
  libroId: string | null;
  periodo: string | null;
  empleados: LsdEmployee[];
}

export function buildLsdPrompt(text: string): string {
  return [
    "Sos un extractor de datos de un LIQUIDACIÓN DE SUELDOS DIGITAL (LSD) argentino.",
    "Devolvé SOLO JSON con esta forma exacta:",
    '{ "lsd": { "consortiumTaxId": "XX-XXXXXXXX-X|null", "libroId": "...|null",',
    '  "periodo": "AAAAMM|null",',
    '  "empleados": [ { "cuil": "XX-XXXXXXXX-X", "apellidoNombre": "...", "sueldoNeto": 0 } ] } }',
    "",
    "- consortiumTaxId: el CUIT que aparece en el ENCABEZADO junto al nombre del consorcio",
    "  (la línea que empieza con 30-... seguida de CONSORCIO / CONS DE PROP).",
    "- libroId: el valor de 'IDENTIFICADOR ÚNICO DEL LIBRO'.",
    "- periodo: el PERIODO del encabezado, en formato AAAAMM.",
    "- empleados: UNA entrada POR CADA persona listada en el libro, con su CUIL, su",
    "  apellido y nombre, y su SUELDO NETO (lo que cobra de bolsillo).",
    "- El sueldo neto es el valor rotulado **'Total Neto'** al pie del bloque de cada",
    "  empleado. NO es 'Sueldo Basico', ni 'Total Imp. Remunerados', ni las deducciones.",
    "  Ejemplo real: un empleado con 'Sueldo Basico 1.318.092,00' tiene",
    "  'Total Neto: 1.449.395,50' — el que va es el segundo.",
    "- NO devuelvas el total del libro ni las cargas sociales: sólo el neto de cada empleado.",
    "- Si una persona aparece más de una vez (varias hojas), devolvela UNA sola vez.",
    "- No inventes empleados: sólo los que figuran con CUIL en el libro.",
    "",
    "Texto del libro:",
    text,
  ].join("\n");
}

/**
 * Parsea la salida del modelo. Acepta tanto `{ lsd: {...} }` como el objeto
 * plano, porque el modelo a veces omite el envoltorio.
 *
 * Descarta lo que no sirve para registrar un gasto —sin CUIL o sin monto— y
 * deduplica por CUIL: un empleado que aparece en dos hojas es un solo gasto.
 */
export function parseLsdOutput(raw: string): LsdExtraction {
  const clean = raw.replace(/```json|```/g, "").trim();
  const outer = JSON.parse(clean || "{}") as Record<string, unknown>;
  const parsed = (outer.lsd && typeof outer.lsd === "object"
    ? (outer.lsd as Record<string, unknown>)
    : outer);

  return {
    consortiumTaxId: typeof parsed.consortiumTaxId === "string" ? parsed.consortiumTaxId : null,
    libroId: typeof parsed.libroId === "string" ? parsed.libroId : null,
    periodo: typeof parsed.periodo === "string" ? parsed.periodo : null,
    empleados: parseEmpleados(parsed.empleados),
  };
}

function parseEmpleados(value: unknown): LsdEmployee[] {
  if (!Array.isArray(value)) return [];

  const empleados: LsdEmployee[] = [];
  const vistos = new Set<string>();

  for (const item of value as Record<string, unknown>[]) {
    const cuil = typeof item?.cuil === "string" ? item.cuil.trim() : "";
    if (!cuil) continue;

    const digits = cuitDigits(cuil);
    if (!digits || vistos.has(digits)) continue;

    const monto = normalizeBusinessAmount(item?.sueldoNeto as string | number | null | undefined);
    if (!monto) continue;

    const sueldoNeto = Number(monto);
    if (!Number.isFinite(sueldoNeto) || sueldoNeto <= 0) continue;

    vistos.add(digits);
    empleados.push({
      cuil,
      apellidoNombre: typeof item?.apellidoNombre === "string" ? item.apellidoNombre.trim() : "",
      sueldoNeto,
    });
  }

  return empleados;
}
