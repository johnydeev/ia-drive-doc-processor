import { z } from "zod";
import { formatCuit } from "@/lib/cuit";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

/**
 * Normaliza un CUIT devuelto por la IA al formato canónico `XX-XXXXXXXX-X`
 * (lib/cuit). Si no tiene 11 dígitos se conserva el crudo (el saneo del
 * pipeline decide después si descartarlo).
 */
function normalizeCuit(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const formatted = formatCuit(value);
  if (formatted) return formatted;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAmount(value: number | string | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
  }

  const normalized = value.replace(/[^\d.,-]/g, "").replace(/,/g, ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

export const EXTRACTED_DOCUMENT_SCHEMA = z
  .object({
    boletaNumber: z.string().nullable().default(null),
    provider: z.string().nullable().default(null),
    consortium: z.string().nullable().default(null),
    providerTaxId: z.string().nullable().default(null).transform((value) => normalizeCuit(value)),
    detail: z.string().nullable().default(null),
    observation: z.string().nullable().default(null),
    dueDate: z.string().nullable().default(null),
    amount: z
      .union([z.number(), z.string()])
      .nullable()
      .default(null)
      .transform((value) => normalizeAmount(value)),
    alias: z.string().nullable().default(null),
    clientNumber: z.string().nullable().default(null),
    paymentMethod: z.enum(["DEBITO_AUTOMATICO", "TRANSFERENCIA", "EFECTIVO"]).nullable().default(null),
    allTaxIds: z
      .array(z.string())
      .nullable()
      .default(null)
      .transform((arr) => (arr === null ? null : arr.map((v) => normalizeCuit(v) ?? v))),
    // Triage capa 2: la IA marca si el documento es una boleta. Default conservador
    // `true` (si la IA lo omite, se trata como boleta y sigue el flujo normal).
    isBoleta: z.boolean().nullable().default(true),
  })
  .passthrough();

const OUTPUT_JSON_TEMPLATE = {
  boletaNumber: "string | null",
  provider: "string | null",
  consortium: "string | null",
  providerTaxId: "string | null",
  detail: "string | null",
  observation: "string | null",
  dueDate: "YYYY-MM-DD | null",
  amount: "number | null",
  alias: "string | null",
  clientNumber: "string | null",
  paymentMethod: "DEBITO_AUTOMATICO | TRANSFERENCIA | EFECTIVO | null",
  allTaxIds: "string[] (todos los CUITs encontrados) | []",
  isBoleta: "boolean — true si es factura/recibo/comprobante; false SOLO si NO es boleta (certificado, oblea, plano, disposición)",
};

// ═══════════════════════════════════════════════════════════════════════════
// LSP Provider Identification — Router
// ═══════════════════════════════════════════════════════════════════════════

export type LSPProvider =
  | "EDESUR"
  | "EDENOR"
  | "AYSA"
  | "METROGAS"
  | "NATURGY"
  | "CAMUZZI"
  | "LITORAL_GAS"
  | "ABSA"
  | "PERSONAL"
  | "SUTERH"
  | "FATERYH"
  | "SERACARH"
  | "GENERIC_LSP";

/** Nombres de fallback para proveedores LSP cuando no se encuentran en la DB */
export const LSP_FALLBACK_NAMES: Partial<Record<LSPProvider, string>> = {
  EDESUR: "EDESUR S.A.",
  EDENOR: "EDENOR S.A.",
  AYSA: "AYSA",
  METROGAS: "METROGAS S.A.",
  NATURGY: "NATURGY BAN S.A.",
  CAMUZZI: "CAMUZZI GAS PAMPEANA S.A.",
  LITORAL_GAS: "LITORAL GAS S.A.",
  ABSA: "ABSA",
  PERSONAL: "PERSONAL",
  SUTERH: "SUTERH",
  FATERYH: "FATERYH",
  SERACARH: "SERACARH",
};

/**
 * Identifica qué empresa de servicios públicos emitió la factura.
 * Analiza los primeros 4000 caracteres del texto del PDF.
 *
 * Retorna null si no es una LSP.
 */
/**
 * ¿Es una factura de Personal / Telecom Argentina?
 *
 * "PERSONAL" como palabra suelta es ambigua: aparece en frases como
 * "CÓDIGO DE GESTIÓN PERSONAL" (facturas de IPLAN), "DATOS PERSONALES", etc.
 * → falso positivo que mandaba esas facturas al camino LSP de Telecom. Se
 * detecta por MARCADORES POSITIVOS de la empresa (su razón social TELECOM
 * ARGENTINA o la marca Personal/Flow), no por la palabra suelta.
 */
function isPersonalTelecom(upper: string): boolean {
  return (
    upper.includes("TELECOM ARGENTINA") ||
    upper.includes("TELECOM PERSONAL") ||
    upper.includes("MI PERSONAL") ||
    upper.includes("PERSONAL FLOW") ||
    upper.includes("PERSONAL.COM") ||
    /\bPERSONAL\s+S\.?\s*A\.?/.test(upper) // "Personal S.A."
  );
}

export function identifyLSPProvider(text: string): LSPProvider | null {
  const upper = text.slice(0, 4000).toUpperCase();

  // ── Boletas sindicales (SUTERH / FATERYH / SERACARH) ─────────────────────
  // No son servicios públicos (van ANTES del gate isUtilityBill) pero usan el
  // mismo mecanismo de prompt específico. Las tres comparten el CUIT recaudador
  // 30-54675623-4 (FATERYH recauda todo); el patrón único que distingue cada
  // tipo es el CÓDIGO DE FORMULARIO + la razón social del encabezado:
  //   F0201 / "SINDICATO UNICO ..."        → SUTERH  (aportes CPF + sindical)
  //   F0106 / concepto "SERACARH"          → SERACARH (contribución SERACARH)
  //   F0101 / "FEDERACION ARGENTINA ..."   → FATERYH (FMVDD, OS, ART 27 bis)
  if (
    upper.includes("TRABAJADORES DE EDIFICIOS DE RENTA Y HORIZONTAL") ||
    upper.includes("FATERYH") ||
    upper.includes("SUTERH")
  ) {
    if (upper.includes("F0201") || upper.includes("SINDICATO UNICO")) return "SUTERH";
    if (upper.includes("F0106") || upper.includes("SERACARH")) return "SERACARH";
    return "FATERYH";
  }

  // Primero verificar si es una LSP
  if (!isUtilityBill(upper)) {
    return null;
  }

  // Identificar empresa específica
  if (upper.includes("EDESUR")) return "EDESUR";
  if (upper.includes("EDENOR")) return "EDENOR";

  if (
    upper.includes("AYSA") ||
    upper.includes("AY.S.A") ||
    upper.includes("AGUA Y SANEAMIENTOS")
  ) {
    return "AYSA";
  }

  if (upper.includes("METROGAS")) return "METROGAS";
  if (upper.includes("NATURGY")) return "NATURGY";
  if (upper.includes("CAMUZZI")) return "CAMUZZI";
  if (upper.includes("LITORAL GAS")) return "LITORAL_GAS";
  if (upper.includes("ABSA") || (upper.includes("AGUAS") && upper.includes("ARGENTINAS"))) {
    return "ABSA";
  }

  if (isPersonalTelecom(upper)) return "PERSONAL";

  return "GENERIC_LSP";
}

/**
 * Anota "(SERACARH)" en el nombre del proveedor cuando la boleta es del tipo
 * SERACARH. SERACARH se rinde bajo el MISMO proveedor que FATERYH (es un anexo,
 * registrado como alias en `matchNames`), así que sin esto las 2 boletas FATERYH
 * de un consorcio con empleados (FATERYH y SERACARH) quedarían con idéntico
 * nombre/proveedor. Pura e idempotente (no duplica el sufijo). El `providerId`
 * (FK) no cambia: esto solo afecta el texto que se muestra/guarda.
 */
export function annotateSindicalProvider(
  provider: string | null,
  lspProvider: LSPProvider | null | undefined
): string | null {
  if (lspProvider === "SERACARH" && provider && !/SERACARH/i.test(provider)) {
    return `${provider} (SERACARH)`;
  }
  return provider;
}

// ═══════════════════════════════════════════════════════════════════════════
// Text utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extrae las primeras N líneas no vacías del texto del PDF.
 */
function extractRelevantLines(text: string, maxLines = 80): string {
  return text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines)
    .join("\n");
}

/**
 * Detecta si el texto corresponde a una Liquidación de Servicios Públicos (LSP).
 * Acepta texto ya en uppercase o lo convierte.
 */
function isUtilityBill(textOrUpper: string): boolean {
  const upper =
    textOrUpper === textOrUpper.toUpperCase()
      ? textOrUpper
      : textOrUpper.slice(0, 4000).toUpperCase();

  return (
    upper.includes("LIQUIDACIÓN DE SERVICIOS PÚBLICOS") ||
    upper.includes("LIQUIDACION DE SERVICIOS PUBLICOS") ||
    upper.includes("LSP ") ||
    upper.includes("EMPRESA DISTRIBUIDORA") ||
    upper.includes("METROGAS") ||
    upper.includes("AYSA") ||
    upper.includes("AY.S.A") ||
    upper.includes("AGUA Y SANEAMIENTOS") ||
    upper.includes("EDESUR") ||
    upper.includes("EDENOR") ||
    upper.includes("NATURGY") ||
    upper.includes("CAMUZZI") ||
    upper.includes("LITORAL GAS") ||
    upper.includes("ABSA") ||
    (upper.includes("AGUAS") && upper.includes("ARGENTINAS")) ||
    isPersonalTelecom(upper)
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Main prompt builder — entry point
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detecta si el texto corresponde a un recibo de haberes de un empleado de consorcio.
 * Analiza los primeros 3000 caracteres del texto.
 */
export function isReciboHaberes(text: string): boolean {
  const upper = text.slice(0, 3000).toUpperCase();
  return (
    upper.includes("RECIBO DE HABERES") ||
    upper.includes("NETO A COBRAR") ||
    (upper.includes("SUELDO") && upper.includes("CUIL"))
  );
}

export function buildExtractionPrompt(text: string): string {
  const relevantText = extractRelevantLines(text, 80);

  // Detectar recibos de haberes antes del router LSP
  if (isReciboHaberes(text)) {
    return buildReciboHaberesPrompt(relevantText);
  }

  const lspProvider = identifyLSPProvider(text);

  if (!lspProvider) {
    return buildInvoicePrompt(relevantText);
  }

  // Route to specific prompt per LSP provider
  switch (lspProvider) {
    case "EDESUR":
      return buildEdesurPrompt(relevantText);
    case "EDENOR":
      return buildEdenorPrompt(relevantText);
    case "AYSA":
      return buildAysaPrompt(relevantText);
    case "METROGAS":
    case "NATURGY":
    case "CAMUZZI":
    case "LITORAL_GAS":
      return buildGasPrompt(relevantText, lspProvider);
    case "PERSONAL":
      return buildPersonalPrompt(relevantText);
    case "SUTERH":
    case "FATERYH":
    case "SERACARH":
      return buildSindicalPrompt(relevantText, lspProvider);
    default:
      return buildGenericUtilityBillPrompt(relevantText);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Boletas sindicales (SUTERH / FATERYH / SERACARH)
// ═══════════════════════════════════════════════════════════════════════════

const SINDICAL_ENTITY_LABELS: Record<"SUTERH" | "FATERYH" | "SERACARH", string> = {
  SUTERH: "SUTERH (Sindicato Único de Trabajadores de Edificios de Renta y Horizontal, formulario F0201)",
  FATERYH: "FATERYH (Federación Argentina de Trabajadores de Edificios de Renta y Horizontal, formulario F0101)",
  SERACARH: "SERACARH (contribución SERACARH, boleta emitida por FATERYH, formulario F0106)",
};

/**
 * Prompt para boletas sindicales de edificios. Estructura idéntica entre los 3
 * tipos (solo cambia la entidad y los conceptos): encabezado con razón social +
 * código de formulario, y campos rotulados (CONSORCIO:, PERIODO:, Nº BOLETA:,
 * VENCIMIENTO:, TOTAL A PAGAR:).
 *
 * CLAVE del modelo de negocio: el CUIT que figura en la boleta es del CONSORCIO
 * contribuyente (cada edificio tiene el suyo: BOEDO 414 = 30-54675623-4,
 * BROWN 706 = 30-52063978-7, etc.), NO del sindicato. El proveedor sindical se
 * identifica por NOMBRE; no tiene CUIT propio en el sistema.
 */
function buildSindicalPrompt(relevantText: string, tipo: "SUTERH" | "FATERYH" | "SERACARH"): string {
  return [
    `Extrae datos de una boleta sindical de ${SINDICAL_ENTITY_LABELS[tipo]}.`,
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS ESPECÍFICAS BOLETA SINDICAL ===",

    `- provider: siempre '${tipo}' (se identifica por NOMBRE, no por CUIT). No usar la razón social completa.`,

    "- providerTaxId: null. El CUIT que figura en la boleta NO es del sindicato:",
    "  es el CUIT del CONSORCIO/edificio contribuyente (cada edificio tiene el",
    "  suyo). No asignarlo al proveedor.",

    "- consortium: el texto que sigue a 'CONSORCIO:' (la dirección del edificio).",
    "  Copiarlo tal cual aparece, sin la localidad ('CIUDAD DE BUENOS AIRES',",
    "  'CAPITAL FEDERAL'). Ej: 'CONSORCIO: AVDA BOEDO 00410 /14-...' → 'AVDA BOEDO 00410 /14'.",

    "- boletaNumber: el valor de 'Nº BOLETA:' (formato NN-NNNNNNNN). Copiarlo completo.",

    "- dueDate: el valor de 'VENCIMIENTO:' en formato YYYY-MM-DD.",
    "  La fecha viene como DD/MM/YYYY → convertir. Siempre es la fecha de pago válida.",

    "- amount: el valor de 'TOTAL A PAGAR:'. Formato numérico.",

    "- detail: los conceptos de la tabla separados por coma, más el período.",
    "  Ej: 'CPF aporte, CPF contribución, Aporte sindical — Período 05/2026'.",

    "- observation: el valor de 'PERIODO:' (MM/YYYY).",

    "- clientNumber: siempre null (estas boletas no tienen número de cliente).",

    "- paymentMethod: si dice 'SE DEBITARA DIRECTAMENTE EN SU CUENTA BANCARIA'",
    "  → DEBITO_AUTOMATICO. Si no, null.",

    "- allTaxIds: incluir el CUIT que aparece junto a 'CUIT:' en la boleta",
    "  (es el del CONSORCIO/edificio — sirve para imputar el gasto al edificio correcto).",

    "Texto de la boleta sindical:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Common rules shared across prompts
// ═══════════════════════════════════════════════════════════════════════════

const JSON_RESPONSE_INSTRUCTION = [
  "Responde SOLO JSON con EXACTAMENTE estas claves y tipos:",
  JSON.stringify(OUTPUT_JSON_TEMPLATE, null, 2),
].join("\n");

const CONSORTIUM_ADDRESS_RULES = [
  "- consortium: dirección del INMUEBLE donde se presta el servicio.",
  "  Buscarlo en 'Domicilio de Prestación del Servicio', 'Domicilio suministro',",
  "  'Dirección del inmueble', o dirección del cliente/titular.",
  "  Extraer SOLO calle y número principal. ELIMINAR:",
  "    • Números de piso, departamento, unidad (PB, PA, 1°A, etc.)",
  "    • Código postal (C1414AWF, B1602, etc.)",
  "    • Localidad y provincia (CAPITAL FEDERAL, BUENOS AIRES, etc.)",
  "    • Ceros a la izquierda en el número (00246 → 246, 02178 → 2178)",
  "    • Sufijos numéricos extras después del número principal (001, 018, etc.)",
  "  Ejemplos:",
  "    'FRAY JUSTO SANTAMARIA DE ORO 02178 001' → 'FRAY JUSTO SANTAMARIA DE ORO 2178'",
  "    'CASTILLO 00246 C1414AWF CAPITAL FEDERAL' → 'CASTILLO 246'",
  "    'SAN ANTONIO 345 PB A' → 'SAN ANTONIO 345'",
  "    'AV ALMIRANTE BROWN 706 018' → 'AV ALMIRANTE BROWN 706'",
].join("\n");

const INVALID_DATE_RULES = [
  "  INVÁLIDO — siempre null:",
  "    ✗ 'C.E.S.P: XXXXX | Fecha Vto: [fecha]' — el Fecha Vto es del código CESP",
  "       (código electrónico de servicio público), NO de pago.",
  "    ✗ 'CAE N°: XXXXXXXXXX | Fecha Vto: [fecha]' — es vencimiento del código AFIP.",
  "    ✗ 'Fecha de emisión' o 'Fecha:' sola — es cuando se generó el documento.",
  "    ✗ 'Próxima liquidación vence el [fecha]' — es del próximo mes.",
  "    ✗ Fechas de 2° o 3° vencimiento con recargo.",
  "    ✗ 'Inicio de actividades' — antigüedad del emisor en AFIP.",
  "  Si no existe ningún caso válido: null. No deducir, no calcular, no suponer.",
].join("\n");

const PAYMENT_METHOD_RULES = [
  "- paymentMethod: método de pago detectado. Valores posibles: DEBITO_AUTOMATICO, TRANSFERENCIA, EFECTIVO, null.",
  "  • DEBITO_AUTOMATICO si detectás: 'débito automático', 'débito directo', 'pago directo',",
  "    'a debitar el', 'se debitará', 'DEBITO AUTOMATICO', 'FACTURA CON DÉBITO AUTOMÁTICO',",
  "    'Abona por Pago Directo', 'DEBITO POR PAGO DIRECTO'.",
  "  • TRANSFERENCIA si detectás: 'transferencia', 'CVU', 'CBU'.",
  "  • EFECTIVO si detectás: 'Rapipago', 'Pago Fácil', 'efectivo', 'cobro express'",
  "    SIN mención de débito automático.",
  "  • null si no se puede determinar con certeza.",
].join("\n");

const PROVIDER_NAME_RULES = [
  "  Si el nombre del proveedor/emisor aparece acompañado de una razón social",
  "  (S.R.L., S.A., S.A.S., S.C., S.H., COOP., LTDA., S.A.C.I., S.A.C.I.F.,",
  "  S.A.I.C., u otras variantes), CONSERVARLA como parte del nombre.",
  "  Ejemplo: 'ASCENSORES POTENZA S.R.L.' → 'ASCENSORES POTENZA S.R.L.' (NO 'ASCENSORES POTENZA').",
].join("\n");

const LSP_PROVIDER_TAX_ID_RULES = [
  "- providerTaxId: CUIT de la EMPRESA DE SERVICIOS emisora (NO del cliente/consorcio).",
  "  Buscar en el encabezado del documento, junto al nombre/logo de la empresa, etiquetas como 'CUIT', 'CUIT Nº'.",
  "  ⚠️ TRAMPA COMÚN: el CUIT del CLIENTE (consorcio) aparece prominente en la sección del titular",
  "  o al final del documento. Ese CUIT NO es el de la empresa emisora. IGNORARLO SIEMPRE.",
  "  Si no podés identificar con certeza el CUIT de la empresa emisora: null.",
].join("\n");

const LSP_LATERAL_CUIT_RULES =
  "  ⚠️ EN ESTA EMPRESA: el CUIT aparece en el margen lateral izquierdo del documento, " +
  "impreso de manera vertical/rotada junto a datos como 'IVA Responsable Inscripto', " +
  "'Ingresos Brutos' y 'Fecha de inicio de actividades'. Buscarlo ahí si no aparece en el encabezado.";

const ALL_TAX_IDS_RULES = [
  "- allTaxIds: lista de TODOS los CUITs que aparezcan en el documento, sin clasificar.",
  "  Un CUIT argentino tiene exactamente 11 dígitos numéricos.",
  "  Puede aparecer con o sin guiones: '30-71880844-4' o '30718808444'.",
  "  Normalizar SIEMPRE al formato CON guiones: 'XX-XXXXXXXX-X'.",
  "",
  "  ✓ INCLUIR CUITs junto a cualquiera de estas etiquetas:",
  "    'C.U.I.T.:', 'CUIT:', 'CUIT', 'C.U.I.T', 'ING. BRUTOS:', 'Ing. Brutos:'",
  "    (Ingresos Brutos usa el mismo número que el CUIT para personas jurídicas)",
  "",
  "  ✓ INCLUIR si aparece 'DNI: XXXXXXXXXXX' con exactamente 11 dígitos —",
  "    algunos sistemas emiten el CUIT del consorcio bajo la etiqueta DNI.",
  "    Incluirlo en allTaxIds normalizado con guiones.",
  "",
  "  ✗ NO incluir si 'DNI:' tiene MENOS de 11 dígitos — es un DNI real de persona física.",
  "  ✗ NO incluir el número de CAE (14 dígitos).",
  "  ✗ NO incluir el número de comprobante.",
  "  ✗ NO incluir secuencias de más de 11 dígitos numéricos consecutivos.",
  "",
  "  Resultado: array de strings con formato 'XX-XXXXXXXX-X'.",
  "  Si no hay ningún CUIT en el texto: [].",
].join("\n");

// ═══════════════════════════════════════════════════════════════════════════
// Invoice prompt (facturas normales A, B, C, etc.)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Regla de dueDate para facturas normales.
 */
const DUE_DATE_RULE = [
  "- dueDate: fecha límite en que el cliente debe PAGAR este comprobante. YYYY-MM-DD.",
  "",
  "  VÁLIDO — usar la fecha:",
  "    ✓ 'Fecha de Vto. para el pago', 'Fecha límite de pago', 'Vence:', 'Vencimiento:'",
  "      con una fecha de pago.",
  "    ✓ 'Vencimiento: [fecha]' o 'Fecha Vto.: [fecha]' en el encabezado de la factura",
  "      junto al número de comprobante, CUIT e inicio de actividades del emisor.",
  "    ✓ '1° Vencimiento: [fecha]' junto a un monto — siempre válido.",
  "",
  INVALID_DATE_RULES,
].join("\n");

function buildInvoicePrompt(relevantText: string): string {
  return [
    "Extrae datos de una factura/comprobante en PDF (administración de consorcios en Argentina).",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS ===",

    "- boletaNumber: número de comprobante. Formato típico PPPP-NNNNNNNN (ej: '0002-00003019').",

    "- provider: razón social del EMISOR (quien factura). Está en el bloque superior del documento,",
    "  generalmente con su domicilio, teléfono y CUIT. NO es el consorcio.",
    PROVIDER_NAME_RULES,

    "- providerTaxId: CUIT del EMISOR (quien factura), formato 'XX-XXXXXXXX-X'.",
    "",
    "  ESTRUCTURA ESTÁNDAR de una factura AFIP:",
    "  • Bloque EMISOR (arriba): razón social, domicilio fiscal, C.U.I.T. del emisor,",
    "    Ingresos Brutos, Inicio de Actividades, condición IVA del emisor.",
    "  • Bloque COMPROBANTE (arriba derecha): letra (A/B/C), número de factura, fecha, CAE.",
    "  • Bloque RECEPTOR (cuerpo/abajo): nombre del cliente, domicilio, C.U.I.T. o DNI.",
    "",
    "  ✓ El providerTaxId está en el bloque EMISOR, junto a 'Ingresos Brutos' o",
    "    'Inicio de Actividades'. TIP: en personas jurídicas, Ingresos Brutos usa el",
    "    mismo número que el CUIT — si ves ese número, es el CUIT del emisor.",
    "",
    "  ✗ IGNORAR el CUIT o DNI del bloque RECEPTOR aunque tenga etiqueta 'C.U.I.T.:' o 'CUIT:'.",
    "    Ese pertenece al consorcio receptor, no al proveedor.",
    "",
    "  Si el CUIT del emisor no está en el texto (imagen no copiable): null.",
    "  El sistema puede resolver el proveedor usando allTaxIds aunque este campo sea null.",

    "- consortium: nombre del CONSORCIO receptor (quien RECIBE y PAGA la factura).",
    "  Buscarlo exclusivamente en la sección del RECEPTOR/CLIENTE del documento:",
    "  'Cliente:', 'Razón Social del receptor:', 'Señores:', 'A nombre de:'.",
    "  NUNCA usar el nombre del emisor/proveedor como consorcio.",
    "  El emisor aparece en el bloque SUPERIOR con su domicilio, teléfono,",
    "  CUIT e inicio de actividades. El consorcio es quien figura como CLIENTE.",
    "  Si el campo 'Cliente:' contiene solo una dirección (ej: 'BELGRANO 1431'),",
    "  ese valor ES el nombre del consorcio — usarlo tal cual.",
    "  MUY IMPORTANTE: el receptor suele figurar como 'CONSORCIO DE PROPIETARIOS'",
    "  seguido de la dirección del edificio (ej: 'CONSORCIO DE PROPIETARIOS",
    "  CORONEL DIAZ 1714'), MUCHAS VECES SIN etiqueta 'Cliente:' y con CUIT",
    "  00-00000000-0 o 'CONSUMIDOR FINAL'. Esa DIRECCIÓN es el nombre del consorcio:",
    "  extraerla ignorando el prefijo 'CONSORCIO DE PROPIETARIOS', la condición",
    "  frente al IVA ('Consumidor Final', etc.) y la localidad ('C.A.B.A.').",
    "  Jamás tomar la 'Razón Social:' del bloque emisor como consorcio.",

    "- amount: monto TOTAL a pagar ('Importe Total', 'Total a pagar'). Nunca un subtotal.",
    "  Formato numérico sin símbolos (ej: 34400.01).",

    DUE_DATE_RULE,

    "- detail: descripción breve del producto o servicio facturado (máx 120 caracteres).",

    "- clientNumber: null (no aplica a facturas normales).",
    "- paymentMethod: null (no aplica a facturas normales).",

    ALL_TAX_IDS_RULES,

    "- isBoleta: true si el documento es una FACTURA, RECIBO o COMPROBANTE de un gasto/pago",
    "  (tiene importe a pagar, emisor, etc.). Devolvé false SOLO si el documento claramente NO",
    "  es una boleta (por ejemplo: un certificado de desinfección/fumigación, una oblea de",
    "  rúbrica de libros, un plano, una disposición o un informe). Ante la duda, devolvé true.",

    "- Usa null si un dato falta o es incierto. No inventes datos.",

    "Texto del comprobante:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// EDESUR prompt
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Prompt especializado para facturas de EDESUR S.A.
 *
 * Formato observado en PDFs reales:
 * - Encabezado: "EDESUR S.A." con CUIT 30-71079642-7
 * - boletaNumber dentro de "LSP B 0501-73540975 18" → extraer solo "0501-73540975"
 * - Dos vencimientos:
 *     Total a pagar hasta   Fecha límite de pago en banco
 *     18/02/2026 $121.670,97    23/02/2026 $122.078,88
 *   → usar SIEMPRE el primer par (fecha + monto)
 * - consortium: aparece bajo "CONSORCIO DE PROPIETARIOS" como cliente,
 *   seguido de dirección del suministro
 * - CUIT del cliente (consorcio) aparece prominente → IGNORAR para providerTaxId
 */
function buildEdesurPrompt(relevantText: string): string {
  return [
    "Extrae datos de una factura de EDESUR (energía eléctrica) argentina.",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS ESPECÍFICAS EDESUR ===",

    "- provider: siempre 'EDESUR S.A.'",
    PROVIDER_NAME_RULES,

    LSP_PROVIDER_TAX_ID_RULES,
    LSP_LATERAL_CUIT_RULES,

    "- boletaNumber: extraer de la línea tipo 'LSP B PPPP-NNNNNNNN NN'.",
    "  Tomar SOLO la parte PPPP-NNNNNNNN (ej: de 'LSP B 0501-73540975 18' → '0501-73540975').",
    "  Si no encontrás ese formato, buscar 'Nro. de Cliente' o 'Nro. Factura'.",

    CONSORTIUM_ADDRESS_RULES,

    "- amount: monto del PRIMER vencimiento solamente.",
    "  Edesur presenta dos columnas:",
    "    'Total a pagar hasta [FECHA1] $[MONTO1]    Fecha límite de pago en banco [FECHA2] $[MONTO2]'",
    "  Usar MONTO1 (el menor, sin recargo). Formato numérico (ej: 121670.97).",

    "- dueDate: fecha del PRIMER vencimiento. YYYY-MM-DD.",
    "  Usar FECHA1 del par descrito arriba.",
    "  VÁLIDO:",
    "    ✓ 'Total a pagar hasta [fecha]' — es la fecha de pago.",
    "    ✓ '1° Vencimiento [fecha]'",
    INVALID_DATE_RULES,

    "- detail: 'Energía eléctrica' o descripción del servicio.",

    "- clientNumber: número de cliente de Edesur.",
    "  Buscar 'Su número de cliente es XXXXXXXX', 'Nro de cliente T2 XXXXXXXX',",
    "  o 'Cliente N° XXXXXXXX'. Mantener formato exacto incluyendo ceros a la izquierda.",

    "- paymentMethod:",
    "  • 'Esta factura posee débito automático' → DEBITO_AUTOMATICO",
    "  • 'Pago por transferencia CVU' → TRANSFERENCIA",
    "  • Sin mención → null",

    ALL_TAX_IDS_RULES,

    "- Usa null si un dato no se puede extraer con certeza.",

    "Texto de la factura Edesur:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// EDENOR prompt
// ═══════════════════════════════════════════════════════════════════════════

function buildEdenorPrompt(relevantText: string): string {
  return [
    "Extrae datos de una factura de EDENOR (energía eléctrica) argentina.",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS ESPECÍFICAS EDENOR ===",

    "- provider: siempre 'EDENOR S.A.'",
    PROVIDER_NAME_RULES,

    LSP_PROVIDER_TAX_ID_RULES,
    LSP_LATERAL_CUIT_RULES,

    "- boletaNumber: buscar formato LSP similar a Edesur: 'LSP B PPPP-NNNNNNNN'.",
    "  Extraer solo PPPP-NNNNNNNN. Si no hay ese formato, buscar 'Nro. Factura' o similar.",

    CONSORTIUM_ADDRESS_RULES,

    "- amount: monto del PRIMER vencimiento (sin recargo). Formato numérico.",

    "- dueDate: fecha del PRIMER vencimiento. YYYY-MM-DD.",
    "  VÁLIDO:",
    "    ✓ 'Vencimiento [fecha]' junto a un monto.",
    "    ✓ 'Total a pagar hasta [fecha]'",
    INVALID_DATE_RULES,

    "- detail: 'Energía eléctrica'.",

    "- clientNumber: número de cuenta de Edenor.",
    "  Buscar 'Cuenta X XXX XXX XXX' (puede tener espacios). Normalizar eliminando espacios.",

    "- paymentMethod:",
    "  • 'Abona por Pago Directo' o 'DEBITO POR PAGO DIRECTO' → DEBITO_AUTOMATICO",
    "  • Sin mención → null",

    ALL_TAX_IDS_RULES,

    "Texto de la factura Edenor:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// AySA prompt
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Prompt especializado para AySA (Agua y Saneamientos Argentinos S.A.).
 *
 * Particularidades observadas:
 * - CUIT de AySA: 30-70956507-5 (junto a nombre e inicio de actividades)
 * - CUIT del CLIENTE aparece AL FINAL: "IVA RESPONSABLE INSCRIPTO - CUIT No. XX-XXXXXXXX-X"
 * - C.E.S.P (código electrónico): "C.E.S.P: XXXXX | Fecha Vto: DD/MM" → NO es fecha de pago
 * - Caso débito automático: "A debitar el [fecha]" → SÍ es fecha de pago
 * - Caso pago normal: "Vencimiento [fecha]" en encabezado grande
 * - boletaNumber: alfanumérico largo tipo "0106A11487223"
 * - Domicilio: "Domicilio de Prestación del Servicio" con calle y número
 */
function buildAysaPrompt(relevantText: string): string {
  return [
    "Extrae datos de una factura de AySA (Agua y Saneamientos Argentinos) argentina.",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS ESPECÍFICAS AYSA ===",

    "- provider: siempre 'AYSA' (o 'AGUA Y SANEAMIENTOS ARGENTINOS S.A.' si aparece completo).",
    PROVIDER_NAME_RULES,

    LSP_PROVIDER_TAX_ID_RULES,

    "- boletaNumber: número alfanumérico largo, formato típico '0106A11487223'.",
    "  Tomarlo tal cual aparece. Puede estar etiquetado como 'Nro.' o en el código de barras.",

    CONSORTIUM_ADDRESS_RULES,
    "  En AySA buscar específicamente 'Domicilio de Prestación del Servicio'.",

    "- amount: monto total a pagar en el PRIMER vencimiento.",
    "  En débito automático: usar 'Total a debitar $XXX' o 'A debitar el [fecha] $XXX'.",
    "  Formato numérico (ej: 798400.87). Ignorar 2° y 3° vencimiento.",

    "- dueDate: fecha de pago. YYYY-MM-DD.",
    "  VÁLIDO:",
    "    ✓ 'Vencimiento [fecha]' — en encabezado grande, es la fecha de pago.",
    "    ✓ 'Total a pagar hasta el [fecha]' — explícitamente de pago.",
    "    ✓ 'A debitar el [fecha]' — en débito automático, es cuando se cobra.",
    "  INVÁLIDO — siempre null:",
    "    ✗ 'C.E.S.P: XXXXX | Fecha Vto: DD/MM/YYYY' — 'Fecha Vto' aquí es del código",
    "       C.E.S.P (Código Electrónico de Servicio Público). Es una referencia interna",
    "       de AySA para el sistema de cobro electrónico. NO es fecha de pago del usuario.",
    "    ✗ 'Fecha de emisión'",
    "    ✗ 'Próxima liquidación vence el [fecha]' — es del próximo mes.",
    "  Si no existe ningún caso válido: null.",

    "- detail: 'Agua y cloacas' o 'Servicio de agua y saneamiento'.",

    "- clientNumber: número de cuenta de servicios AySA.",
    "  Buscar 'Cuenta de Servicios XXXXX'. Mantener formato exacto.",

    "- paymentMethod:",
    "  • 'A debitar el DD/MM/YYYY' o 'Esta liquidación será debitada' → DEBITO_AUTOMATICO",
    "  • Sin mención → null",

    ALL_TAX_IDS_RULES,

    "Texto de la factura AySA:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Gas companies prompt (Metrogas, Naturgy, Camuzzi, Litoral Gas)
// ═══════════════════════════════════════════════════════════════════════════

const GAS_PROVIDER_NAMES: Record<string, string> = {
  METROGAS: "METROGAS S.A.",
  NATURGY: "NATURGY BAN S.A.",
  CAMUZZI: "CAMUZZI GAS PAMPEANA S.A.",
  LITORAL_GAS: "LITORAL GAS S.A.",
};

function buildGasPrompt(relevantText: string, provider: LSPProvider): string {
  const providerName = GAS_PROVIDER_NAMES[provider] ?? provider;

  return [
    `Extrae datos de una factura de ${providerName} (gas natural) argentina.`,
    JSON_RESPONSE_INSTRUCTION,

    `=== REGLAS ESPECÍFICAS ${provider} ===`,

    `- provider: siempre '${providerName}'.`,
    PROVIDER_NAME_RULES,

    LSP_PROVIDER_TAX_ID_RULES,

    "- boletaNumber: número de la liquidación/factura.",
    "  Buscar 'Nro. Factura', 'Nro. Comprobante', o formato LSP.",

    CONSORTIUM_ADDRESS_RULES,

    "- amount: monto del PRIMER vencimiento (sin recargo). Formato numérico.",

    "- dueDate: fecha del PRIMER vencimiento. YYYY-MM-DD.",
    "  VÁLIDO:",
    "    ✓ 'Vencimiento [fecha]' junto a un monto.",
    "    ✓ 'Total a pagar hasta [fecha]'",
    "    ✓ '1° Vencimiento [fecha]'",
    INVALID_DATE_RULES,

    "- detail: 'Gas natural'.",

    "- clientNumber: número de cliente de la empresa de gas.",
    "  Buscar 'Número de cliente XXXXXXXX' o similar. Mantener formato exacto.",

    PAYMENT_METHOD_RULES,

    ALL_TAX_IDS_RULES,

    `Texto de la factura ${providerName}:`,
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Generic utility bill prompt (fallback for unrecognized LSPs)
// ═══════════════════════════════════════════════════════════════════════════

function buildGenericUtilityBillPrompt(relevantText: string): string {
  return [
    "Extrae datos de una Liquidación de Servicios Públicos (LSP) argentina.",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS PARA LSP (luz, gas, agua) ===",

    "- provider: nombre de la EMPRESA DE SERVICIOS emisora. Es el logo/encabezado principal.",
    "  Ejemplos: 'EDESUR', 'EDENOR', 'AYSA', 'METROGAS', 'NATURGY', 'CAMUZZI'.",
    PROVIDER_NAME_RULES,

    LSP_PROVIDER_TAX_ID_RULES,

    CONSORTIUM_ADDRESS_RULES,

    "- boletaNumber: número de la liquidación.",

    "- amount: monto total a pagar en el PRIMER vencimiento.",
    "  Ignorar 2° y 3° vencimiento (tienen recargo).",
    "  Formato numérico (ej: 798400.87).",

    "- dueDate: fecha de pago. YYYY-MM-DD.",
    "  VÁLIDO:",
    "    ✓ 'Vencimiento [fecha]' junto a un monto — es la fecha de pago.",
    "    ✓ 'Total a pagar hasta el [fecha]' — explícitamente de pago.",
    "    ✓ 'A debitar el [fecha]' — en débito automático.",
    INVALID_DATE_RULES,

    "- detail: tipo de servicio (ej: 'Agua y cloacas', 'Energía eléctrica', 'Gas natural').",

    "- clientNumber: número de cliente/cuenta si aparece en el documento. null si no se encuentra.",

    PAYMENT_METHOD_RULES,

    ALL_TAX_IDS_RULES,

    "Texto de la liquidación:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// PERSONAL (Telecom Argentina) prompt
// ═══════════════════════════════════════════════════════════════════════════

function buildPersonalPrompt(relevantText: string): string {
  return [
    "Extrae datos de una factura de PERSONAL / Telecom Argentina.",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS ESPECÍFICAS PERSONAL ===",

    "- provider: siempre 'PERSONAL'.",
    PROVIDER_NAME_RULES,

    LSP_PROVIDER_TAX_ID_RULES,

    "- boletaNumber: buscar 'N° de Factura XXXXX-XXXXXXXX'. Tomar el formato completo.",

    CONSORTIUM_ADDRESS_RULES,

    "- amount: total a pagar del mes. Formato numérico.",

    "- dueDate: fecha de vencimiento. YYYY-MM-DD.",
    "  VÁLIDO:",
    "    ✓ 'Vencimiento [fecha]' junto a un monto.",
    "    ✓ 'Fecha de vencimiento [fecha]'",
    INVALID_DATE_RULES,

    "- detail: 'Telecomunicaciones' o descripción del servicio.",

    "- clientNumber: buscar 'N° de Referencia de Pago XXXXXXXXXXXXXXXX'.",
    "  Mantener formato exacto incluyendo todos los dígitos.",

    "- paymentMethod:",
    "  • 'DEBITO AUTOMATICO' o 'FACTURA CON DÉBITO AUTOMÁTICO' → DEBITO_AUTOMATICO",
    "  • Sin mención → null",

    ALL_TAX_IDS_RULES,

    "Texto de la factura Personal:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Output parsing
// ═══════════════════════════════════════════════════════════════════════════

function normalizeModelOutput(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  return trimmed;
}

export function parseExtractionOutput(raw: string): ExtractedDocumentData {
  const normalized = normalizeModelOutput(raw || "{}");
  const parsed = JSON.parse(normalized);
  return EXTRACTED_DOCUMENT_SCHEMA.parse(parsed);
}

// ═══════════════════════════════════════════════════════════════════════════
// Post-extraction refinement (consortium enrichment from raw text)
// ═══════════════════════════════════════════════════════════════════════════

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitNonEmptyLines(text: string): string[] {
  return text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => normalizeLine(line))
    .filter((line) => line.length > 0);
}

function hasLetters(value: string): boolean {
  return /[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(value);
}

function isNumericLikeLine(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  return /^[\d\-./]+$/.test(compact);
}

function isMetadataLine(value: string): boolean {
  return /^(cuit|iva|fecha|cae|comprobante|subtotal|total|domicilio|condici[oó]n|ingresos|inicio|punto de venta|c[oó]digo|regimen|otros impuestos|hys)\b/i.test(
    value
  );
}

function needsConsortiumEnrichment(consortium: string | null | undefined): boolean {
  if (!consortium) {
    return true;
  }

  const normalized = normalizeLine(consortium)
    .replace(/[.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return /^(cons|consorcio)(\s+de)?\s+prop(ietarios)?$/.test(normalized);
}

// Marcador canónico del CONSORCIO receptor en facturas argentinas de
// administración: "CONSORCIO DE PROPIETARIOS" y variantes ("CONS. PROP.",
// "CONSORCIO PROPIETARIOS", "CONS DE PROP"). Requiere "prop" para no confundirse
// con "CONSUMIDOR FINAL" ni con la palabra "consorcio" suelta de un detalle.
const CONSORTIUM_MARKER = /\bcons(?:orcio)?\.?\s*(?:de\s+)?prop(?:ietarios)?\b/i;

// Ruido del bloque RECEPTOR que suele preceder a la dirección del edificio:
// condición frente al IVA, CUIT placeholder, etiqueta CUIT/DNI.
const RECEPTOR_NOISE_PREFIX =
  /^(?:consumidor\s+final|responsable\s+(?:inscripto|monotributo)|monotributo|iva\s+\w+|cuit\s*:?|c\.?u\.?i\.?t\.?\s*:?|dni\s*:?|\d[\d\-./]{6,}\d)\s*/i;

function stripReceptorNoise(value: string): string {
  let v = normalizeLine(value);
  let prev = "";
  while (v !== prev) {
    prev = v;
    v = v.replace(RECEPTOR_NOISE_PREFIX, "").trim();
  }
  return v;
}

function isLocalityLine(value: string): boolean {
  return /^(?:c\.?a\.?b\.?a\.?|capital\s+federal|ciudad\s+de\s+buenos\s+aires|buenos\s+aires|prov(?:incia)?\b)/i.test(
    value.trim()
  );
}

/**
 * Infiere el nombre del consorcio RECEPTOR desde el texto crudo, anclando en el
 * marcador "CONSORCIO DE PROPIETARIOS" — NO en "Razón Social:", que en una
 * factura AFIP corresponde al EMISOR (tomarlo confundía al proveedor con el
 * consorcio). Extrae la dirección que sigue al marcador (misma línea o las
 * siguientes), limpiando el ruido del bloque receptor (condición IVA, CUIT
 * placeholder, localidad). Devuelve null si no hay marcador de consorcio, para
 * no pisar lo que extrajo la IA cuando no hay una señal confiable.
 */
function inferConsortiumFromText(text: string): string | null {
  const lines = splitNonEmptyLines(text);
  const markerIdx = lines.findIndex((line) => CONSORTIUM_MARKER.test(line));
  if (markerIdx < 0) {
    return null;
  }

  const prefix = "CONSORCIO DE PROPIETARIOS";

  // 1) Dirección en la misma línea del marcador, después de él.
  const markerLine = lines[markerIdx];
  const match = markerLine.match(CONSORTIUM_MARKER);
  const afterMarker = match
    ? stripReceptorNoise(markerLine.slice((match.index ?? 0) + match[0].length))
    : "";
  if (hasLetters(afterMarker)) {
    return `${prefix} ${afterMarker}`.trim();
  }

  // 2) Dirección en las líneas siguientes (limpiando el ruido del receptor).
  for (let j = markerIdx + 1; j < Math.min(markerIdx + 7, lines.length); j += 1) {
    const candidate = stripReceptorNoise(lines[j]);
    if (
      !candidate ||
      isLocalityLine(candidate) ||
      isMetadataLine(candidate) ||
      isNumericLikeLine(candidate) ||
      !hasLetters(candidate)
    ) {
      continue;
    }
    return `${prefix} ${candidate}`.trim();
  }

  // 3) Marcador presente pero sin dirección detectable.
  return prefix;
}

export function refineExtractionWithRawText(
  extracted: ExtractedDocumentData,
  rawText: string
): ExtractedDocumentData {
  // Para LSPs no aplicar el refinamiento de consorcio por "Razón Social:"
  // porque esa sección puede pertenecer al cliente, no al consorcio
  if (isUtilityBill(rawText)) {
    return extracted;
  }

  const inferredConsortium = inferConsortiumFromText(rawText);
  if (!inferredConsortium) {
    return extracted;
  }

  const currentConsortium = extracted.consortium ? normalizeLine(extracted.consortium) : null;
  const shouldReplace =
    needsConsortiumEnrichment(currentConsortium) ||
    !currentConsortium ||
    inferredConsortium.length > currentConsortium.length;

  if (!shouldReplace) {
    return extracted;
  }

  return {
    ...extracted,
    consortium: inferredConsortium,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Recibo de Haberes — Prompt
// ═══════════════════════════════════════════════════════════════════════════

function buildReciboHaberesPrompt(relevantText: string): string {
  return [
    "Extrae datos de un recibo de haberes de un empleado de consorcio en Argentina.",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS ===",

    "- boletaNumber: número de recibo o liquidación si aparece. null si no.",

    "- provider: nombre completo del EMPLEADO (quien recibe el sueldo).",
    "  Buscarlo en 'EMPLEADO:', 'Apellido y Nombre:', o el nombre que figura",
    "  junto al CUIL del empleado.",

    "- providerTaxId: CUIL del EMPLEADO (formato XX-XXXXXXXX-X).",
    "  Está junto al nombre del empleado, NO el CUIT del empleador/consorcio.",
    "  El CUIT del empleador/consorcio NO es el providerTaxId.",

    "- consortium: nombre del consorcio EMPLEADOR.",
    "  Buscarlo en 'EMPLEADOR:', 'Consorcio de propietarios', o similar.",
    "  Incluir solo calle y número (ej: 'VILLARROEL 1181').",

    "- amount: valor del campo 'NETO A COBRAR' o 'NETO A PAGAR'.",
    "  Es el monto final después de deducciones. Formato numérico sin símbolos.",
    "  NUNCA usar el sueldo bruto ni el total de haberes.",

    "- dueDate: fecha del recibo o fecha de pago. YYYY-MM-DD.",
    "  Buscarlo en 'BUENOS AIRES, DD.MM.YYYY' o similar.",
    "  Si no hay fecha de pago explícita: null.",

    "- detail: 'Haberes [MES/AÑO]' usando el período de liquidación.",
    "  Ej: 'Haberes marzo/2026'.",

    "- clientNumber: null (no aplica).",
    "- paymentMethod: null (no aplica).",

    ALL_TAX_IDS_RULES,

    "Usa null si un dato falta o es incierto. No inventes datos.",

    "Texto del recibo:",
    relevantText,
  ].join("\n\n");
}
