import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_MANUAL_RUN_FILES, type ManualRunFile } from "@/lib/manualRun";

/** Estado de una boleta dentro de la corrida, tal como lo devuelve el endpoint. */
export type ManualRunJobStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface ManualRunProgressFile {
  fileId: string;
  fileName: string | null;
  status: ManualRunJobStatus;
  result: string | null;
  reason: string | null;
  errorMessage: string | null;
}

export interface ManualRunReport {
  jsonUrl: string | null;
  markdownUrl: string | null;
}

const POLL_MS = 2000;

/**
 * Corrida selectiva: elegir hasta 10 boletas de Pendientes, encolarlas y seguir su
 * avance hasta que el worker deja el reporte de diagnóstico en Drive.
 *
 * No procesa nada en el navegador: encola y consulta. El polling se corta solo
 * cuando la corrida termina.
 */
export function useManualRun(enabled: boolean) {
  const [files, setFiles] = useState<ManualRunFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ManualRunProgressFile[]>([]);
  const [done, setDone] = useState(false);
  const [report, setReport] = useState<ManualRunReport | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/client/manual-run/files");
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setFiles(data.files as ManualRunFile[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void loadFiles();
  }, [enabled, loadFiles]);

  /** Alterna una boleta. El tope de 10 se respeta acá y también en el server. */
  const toggle = useCallback((fileId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
        return next;
      }
      if (next.size >= MAX_MANUAL_RUN_FILES) return prev;
      next.add(fileId);
      return next;
    });
  }, []);

  const enqueue = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/client/manual-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileIds: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRunId(data.runId as string);
      setDone(false);
      setReport(null);
      setProgress([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    }
  }, [selected]);

  // Polling del avance. Se detiene solo cuando la corrida termina: sin esto el
  // modal seguiría consultando para siempre con la pestaña abierta.
  useEffect(() => {
    if (!runId || done) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/client/manual-run/${runId}`);
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && data.ok) {
          setProgress(data.files as ManualRunProgressFile[]);
          setDone(Boolean(data.done));
          setReport((data.report as ManualRunReport | null) ?? null);
        }
      } catch {
        // Un fallo puntual de red no corta el seguimiento: se reintenta.
      }
      if (!cancelled) timerRef.current = setTimeout(() => void poll(), POLL_MS);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [runId, done]);

  const reset = useCallback(() => {
    setRunId(null);
    setProgress([]);
    setDone(false);
    setReport(null);
    setSelected(new Set());
  }, []);

  return {
    files, selected, loading, error,
    runId, progress, done, report,
    max: MAX_MANUAL_RUN_FILES,
    loadFiles, toggle, enqueue, reset,
  };
}
