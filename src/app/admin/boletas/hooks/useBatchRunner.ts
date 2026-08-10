"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  applyItemResult,
  estimateRemainingMs,
  initBatchItems,
  markRunning,
  summarizeBatch,
  type BatchItem,
  type BatchItemResult,
  type BatchSummary,
} from "../lib/batchProgress";

/**
 * Tamaño de tanda de EJECUCIÓN.
 *
 * Cada request procesa hasta 5 boletas y lee la planilla de Sheets una sola vez
 * para las 5. Con 5 el sobrecosto de tiempo es ~8% frente al viejo lote de 10, y
 * la barra avanza cada ~46 s. Con 1 sería ~70% (ver §3.1 del spec).
 *
 * Es una perilla: si en producción resulta lento, subirlo a 10 lo revierte a
 * costa de perder el avance intermedio.
 */
export const RUN_CHUNK = 5;

export type BatchEntry = { id: string; label: string };

type Options<T extends BatchEntry> = {
  /** Procesa una tanda y devuelve un resultado por cada id enviado. */
  runChunk: (entries: T[]) => Promise<Map<string, BatchItemResult>>;
  chunkSize?: number;
};

export type BatchRunner = {
  items: BatchItem[];
  summary: BatchSummary;
  isRunning: boolean;
  etaMs: number | null;
  start: (entries: BatchEntry[]) => Promise<void>;
  cancel: () => void;
  retryFailed: () => Promise<void>;
  reset: () => void;
};

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Corre una operación masiva en tandas secuenciales, exponiendo el avance real.
 *
 * Un fallo nunca corta la corrida: la boleta queda marcada y se sigue con la
 * siguiente (los endpoints son idempotentes, así que `retryFailed` es seguro).
 */
export function useBatchRunner<T extends BatchEntry>({
  runChunk,
  chunkSize = RUN_CHUNK,
}: Options<T>): BatchRunner {
  const [items, setItems] = useState<BatchItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [etaMs, setEtaMs] = useState<number | null>(null);

  // Refs y no estado: el bucle async los lee EN VIVO. Un `useState` quedaría
  // capturado con su valor viejo dentro del `for` (el Cancelar no tendría
  // efecto, y `retryFailed` leería una lista desactualizada).
  const cancelRef = useRef(false);
  const runningRef = useRef(false);
  const entriesRef = useRef<T[]>([]);
  const itemsRef = useRef<BatchItem[]>([]);

  /** Única puerta de escritura: mantiene el ref y el estado en sincronía. */
  const writeItems = useCallback((next: BatchItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const runEntries = useCallback(
    async (toRun: T[]) => {
      if (runningRef.current) return; // guard anti doble-arranque
      runningRef.current = true;
      cancelRef.current = false;
      setIsRunning(true);

      const started = Date.now();
      const total = toRun.length;
      let processed = 0;

      try {
        for (const batch of chunk(toRun, chunkSize)) {
          if (cancelRef.current) break;

          const ids = batch.map((e) => e.id);
          writeItems(markRunning(itemsRef.current, ids));

          const results = await runChunk(batch);

          let next = itemsRef.current;
          for (const id of ids) {
            next = applyItemResult(next, id, results.get(id) ?? { status: "done" });
          }
          writeItems(next);

          processed += batch.length;
          setEtaMs(estimateRemainingMs(processed, total, Date.now() - started));
        }
      } finally {
        runningRef.current = false;
        cancelRef.current = false;
        setIsRunning(false);
        setEtaMs(null);
      }
    },
    [chunkSize, runChunk, writeItems]
  );

  const start = useCallback(
    async (entries: BatchEntry[]) => {
      if (runningRef.current) return;
      entriesRef.current = entries as T[];
      writeItems(initBatchItems(entries));
      setEtaMs(null);
      await runEntries(entries as T[]);
    },
    [runEntries, writeItems]
  );

  const retryFailed = useCallback(async () => {
    if (runningRef.current) return;

    const failedIds = new Set(
      itemsRef.current.filter((item) => item.status === "failed").map((item) => item.id)
    );
    if (failedIds.size === 0) return;

    // Las fallidas vuelven a `pending` antes de re-correrlas, así la barra no
    // arranca el reintento con la corrida anterior ya al 100%.
    writeItems(
      itemsRef.current.map((item) =>
        failedIds.has(item.id)
          ? { ...item, status: "pending", message: undefined, needsReview: undefined }
          : item
      )
    );

    await runEntries(entriesRef.current.filter((e) => failedIds.has(e.id)));
  }, [runEntries, writeItems]);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const reset = useCallback(() => {
    writeItems([]);
    setEtaMs(null);
    entriesRef.current = [];
  }, [writeItems]);

  const summary = useMemo(() => summarizeBatch(items), [items]);

  return { items, summary, isRunning, etaMs, start, cancel, retryFailed, reset };
}
