import type { BatchItemResult } from "./batchProgress";

/**
 * Normaliza la respuesta de cada endpoint masivo a un resultado por `invoiceId`.
 *
 * Ambos endpoints devuelven los éxitos como CONTADOR (`deleted` / `moved`), no
 * como lista de ids: sólo `skipped[]` y `failed[]` traen `invoiceId`. De ahí la
 * regla común: se arranca marcando todo `done` y se pisan los ids que volvieron
 * salteados o fallidos.
 */

/** Motivos de skip de "mover al período siguiente", en castellano. */
export const SKIP_LABELS: Record<string, string> = {
  sin_periodo: "sin período asignado",
  destino_inexistente: "el período siguiente no existe todavía (cerrá el período primero)",
  destino_cerrado: "el período siguiente está cerrado",
  ya_en_destino: "ya estaba en el período destino",
  destino_invalido: "el período destino ya no es válido (recargá y reintentá)",
};

/**
 * Mensaje para una tanda cuya respuesta no se pudo interpretar (timeout del
 * túnel, HTML de error, red caída). El trabajo puede haber terminado igual: los
 * endpoints son idempotentes, así que reintentar es seguro.
 */
export const UNCONFIRMED_MESSAGE =
  "Resultado no confirmado — puede que haya terminado igual; reintentar es seguro.";

export type DeleteResponse = {
  ok?: boolean;
  deleted?: number;
  failed?: Array<{ invoiceId: string; error: string }>;
};

export type MoveResponse = {
  ok?: boolean;
  moved?: number;
  skipped?: Array<{ invoiceId: string; reason: string }>;
  failed?: Array<{ invoiceId: string; error: string; reverted: boolean }>;
};

function allUnconfirmed(sentIds: string[]): Map<string, BatchItemResult> {
  return new Map(
    sentIds.map((id) => [id, { status: "failed", message: UNCONFIRMED_MESSAGE }] as const)
  );
}

function allDone(sentIds: string[]): Map<string, BatchItemResult> {
  return new Map(sentIds.map((id) => [id, { status: "done" }] as const));
}

export function adaptDeleteResponse(
  sentIds: string[],
  body: DeleteResponse | null
): Map<string, BatchItemResult> {
  if (!body || body.ok !== true) return allUnconfirmed(sentIds);

  const map = allDone(sentIds);
  for (const f of body.failed ?? []) {
    map.set(f.invoiceId, { status: "failed", message: f.error });
  }
  return map;
}

export function adaptMoveResponse(
  sentIds: string[],
  body: MoveResponse | null
): Map<string, BatchItemResult> {
  if (!body || body.ok !== true) return allUnconfirmed(sentIds);

  const map = allDone(sentIds);
  for (const s of body.skipped ?? []) {
    map.set(s.invoiceId, { status: "skipped", message: SKIP_LABELS[s.reason] ?? s.reason });
  }
  for (const f of body.failed ?? []) {
    // `reverted: false` = la compensación LIFO tampoco pudo deshacer → revisión manual.
    map.set(f.invoiceId, { status: "failed", message: f.error, needsReview: !f.reverted });
  }
  return map;
}
