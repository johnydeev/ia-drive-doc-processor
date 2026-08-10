/**
 * Estado de una corrida masiva (borrar / mover boletas) modelado como datos
 * puros, sin React. El hook `useBatchRunner` lo usa como reducer y el modal lo
 * consume para pintar. Al ser puro se testea sin red ni DOM.
 */

export type BatchItemStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** Una boleta dentro de la corrida. `label` es lo que ve el usuario en la lista. */
export type BatchItem = {
  id: string;
  label: string;
  status: BatchItemStatus;
  message?: string;
  /**
   * Sólo en fallos de "mover": la compensación LIFO no pudo revertir y la boleta
   * quedó a medias. Es el único caso que exige revisión manual.
   */
  needsReview?: boolean;
};

/** Lo que devuelve el adaptador de cada endpoint por cada boleta enviada. */
export type BatchItemResult =
  | { status: "done" }
  | { status: "skipped"; message: string }
  | { status: "failed"; message: string; needsReview?: boolean };

export type BatchSummary = {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  /** Todavía sin resultado (incluye las que están corriendo ahora). */
  pending: number;
  /** Con resultado definitivo: done + failed + skipped. */
  processed: number;
  /** 0-100, redondeado. */
  percent: number;
};

export function initBatchItems(entries: Array<{ id: string; label: string }>): BatchItem[] {
  return entries.map((e) => ({ id: e.id, label: e.label, status: "pending" }));
}

/** Marca en `running` las boletas de la tanda que está por dispararse. */
export function markRunning(items: BatchItem[], ids: string[]): BatchItem[] {
  const set = new Set(ids);
  return items.map((item) => (set.has(item.id) ? { ...item, status: "running" } : item));
}

export function applyItemResult(
  items: BatchItem[],
  id: string,
  result: BatchItemResult
): BatchItem[] {
  return items.map((item) => {
    if (item.id !== id) return item;
    if (result.status === "done") return { ...item, status: "done", message: undefined };
    if (result.status === "skipped") return { ...item, status: "skipped", message: result.message };
    return {
      ...item,
      status: "failed",
      message: result.message,
      needsReview: result.needsReview,
    };
  });
}

export function summarizeBatch(items: BatchItem[]): BatchSummary {
  const total = items.length;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of items) {
    if (item.status === "done") done += 1;
    else if (item.status === "failed") failed += 1;
    else if (item.status === "skipped") skipped += 1;
  }
  const processed = done + failed + skipped;
  return {
    total,
    done,
    failed,
    skipped,
    pending: total - processed,
    processed,
    percent: total === 0 ? 0 : Math.round((processed / total) * 100),
  };
}

/**
 * Tiempo restante estimado por el promedio **medido en esta corrida** (no una
 * constante): si la conexión va más rápido de lo previsto, la estimación
 * acompaña. `null` mientras no haya ninguna boleta procesada.
 */
export function estimateRemainingMs(
  processed: number,
  total: number,
  elapsedMs: number
): number | null {
  if (processed <= 0) return null;
  const avg = elapsedMs / processed;
  return Math.max(0, Math.round(avg * (total - processed)));
}

export function formatEta(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 60_000) return `≈ ${Math.round(ms / 1000)} s`;
  return `≈ ${Math.ceil(ms / 60_000)} min`;
}
