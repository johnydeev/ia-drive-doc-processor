/**
 * Reporte de diagnóstico de una corrida selectiva.
 *
 * El pipeline ya arma una línea `[metrics]` por boleta en TODOS sus caminos de
 * salida, pero vive en el stdout del contenedor y los snapshots de lo extraído
 * salen solo con `debugMode`. Acá esa información se consolida en dos archivos
 * que quedan en Drive: un JSON para analizar y un `.md` para leer de un vistazo.
 *
 * Todo es lógica pura: no toca Drive, DB ni el pipeline.
 */

/** Diagnóstico de UNA boleta, capturado por el runner al terminar el pipeline. */
export interface BoletaDiagnostics {
  fileId: string;
  fileName: string;
  /** Camino de salida: ok / unassigned / no_amount / duplicate / not_boleta / … */
  result: string;
  reason: string | null;
  reasonText: string | null;
  /** direct / merged / ocr / vision / image */
  textSource: string | null;
  textChars: number | null;
  emitterBlock: boolean | null;
  /** Empresa de servicios detectada por el router, o null si no es LSP. */
  lsp: string | null;
  ai: Record<string, unknown> | null;
  match: { consortium: string | null; provider: string | null };
  ms: Record<string, number>;
  /** Lo que devolvió la IA, ANTES de canonizar contra el directorio. */
  extracted: Record<string, unknown> | null;
  /** Lo que quedó DESPUÉS de canonizar. */
  canonical: Record<string, unknown> | null;
  /**
   * El texto exacto que se le mandó al modelo. Es lo que permite distinguir un
   * fallo del prompt de un fallo de la extracción de texto: sin esto hay que
   * volver a bajar el PDF a mano para entender qué pasó.
   */
  promptText: string;
}

export interface DiagnosticsRun {
  runId: string;
  clientName: string;
  startedAt: Date;
  finishedAt: Date;
}

const BUENOS_AIRES = "America/Argentina/Buenos_Aires";

/**
 * `2026-08-18_15-30` en hora de Buenos Aires. Se fija la zona para que el nombre
 * no dependa de la máquina donde corra el worker.
 */
export function formatRunStamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUENOS_AIRES,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}_${get("hour")}-${get("minute")}`;
}

/**
 * Nombre base de los dos archivos del reporte (sin extensión). Lleva un sufijo con
 * el id de la corrida para que dos corridas del mismo minuto no colisionen — el
 * worker usa la existencia del archivo para no escribir el reporte dos veces.
 */
export function diagnosticsFileName(startedAt: Date, runId: string): string {
  return `diagnostico-${formatRunStamp(startedAt)}-${runId.slice(-6)}`;
}

/** Una línea por resultado: cuántas boletas cayeron en cada camino de salida. */
export function summarizeResults(items: BoletaDiagnostics[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const item of items) {
    tally[item.result] = (tally[item.result] ?? 0) + 1;
  }
  return tally;
}

function formatMatch(item: BoletaDiagnostics): string {
  const consortium = item.match.consortium ?? "—";
  const provider = item.match.provider ?? "—";
  return `consorcio: ${consortium} · proveedor: ${provider}`;
}

function formatAi(item: BoletaDiagnostics): string {
  if (!item.ai) return "—";
  const provider = item.ai.provider ?? "—";
  const model = item.ai.model ?? "—";
  const total = item.ai.total ?? "—";
  return `${provider}/${model} · ${total} tokens`;
}

/** Valor de un campo del extraído, para la tabla del `.md`. */
function field(source: Record<string, unknown> | null, key: string): string {
  const value = source?.[key];
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

/**
 * Resumen legible de la corrida. Va al lado del JSON para poder abrir el reporte
 * en Drive y entender qué pasó sin leer el detalle.
 */
export function buildDiagnosticsMarkdown(run: DiagnosticsRun, items: BoletaDiagnostics[]): string {
  const durationSec = Math.max(0, Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000));
  const tally = summarizeResults(items);

  const lines: string[] = [
    `# Diagnóstico de corrida selectiva`,
    "",
    `- **Cliente:** ${run.clientName}`,
    `- **Corrida:** \`${run.runId}\``,
    `- **Inicio:** ${formatRunStamp(run.startedAt)} (hora de Buenos Aires)`,
    `- **Duración:** ${durationSec}s · **Boletas:** ${items.length}`,
    `- **Resultados:** ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" · ") || "—"}`,
    "",
    `## Por boleta`,
    "",
  ];

  for (const item of items) {
    lines.push(`### ${item.fileName}`);
    lines.push("");
    lines.push(`- **Resultado:** \`${item.result}\`${item.reason ? ` (${item.reason})` : ""}`);
    if (item.reasonText) lines.push(`- **Detalle:** ${item.reasonText}`);
    lines.push(`- **Texto:** ${item.textSource ?? "—"} · ${item.textChars ?? 0} chars · bloque emisor: ${item.emitterBlock ? "sí" : "no"}`);
    lines.push(`- **Router LSP:** ${item.lsp ?? "factura común"}`);
    lines.push(`- **IA:** ${formatAi(item)}`);
    lines.push(`- **Match:** ${formatMatch(item)}`);
    lines.push("");
    lines.push(`| Campo | Extraído por la IA | Canonizado |`);
    lines.push(`|---|---|---|`);
    for (const key of ["consortium", "provider", "taxId", "boleta", "due", "amount", "clientNumber"]) {
      lines.push(`| ${key} | ${field(item.extracted, key)} | ${field(item.canonical, key)} |`);
    }
    lines.push("");
  }

  lines.push(`> El texto completo que vio la IA en cada boleta está en el JSON de al lado.`);
  lines.push("");
  return lines.join("\n");
}

/** JSON con el detalle completo, incluido el texto que se le mandó al modelo. */
export function buildDiagnosticsJson(run: DiagnosticsRun, items: BoletaDiagnostics[]): string {
  return JSON.stringify(
    {
      runId: run.runId,
      clientName: run.clientName,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt.toISOString(),
      totals: { boletas: items.length, results: summarizeResults(items) },
      boletas: items,
    },
    null,
    2
  );
}
