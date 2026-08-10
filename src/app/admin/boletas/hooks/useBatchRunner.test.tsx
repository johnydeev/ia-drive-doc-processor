import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useBatchRunner } from "./useBatchRunner";
import type { BatchItemResult } from "../lib/batchProgress";

type Entry = { id: string; label: string };

const entries: Entry[] = [
  { id: "i1", label: "uno" },
  { id: "i2", label: "dos" },
  { id: "i3", label: "tres" },
  { id: "i4", label: "cuatro" },
  { id: "i5", label: "cinco" },
];

/** Devuelve todo `done`, registrando qué tandas recibió. */
function okRunner(seen: string[][]) {
  return async (batch: Entry[]): Promise<Map<string, BatchItemResult>> => {
    seen.push(batch.map((e) => e.id));
    return new Map(batch.map((e) => [e.id, { status: "done" } as BatchItemResult]));
  };
}

describe("useBatchRunner", () => {
  it("agrupa las entradas en tandas del tamaño pedido, en orden", async () => {
    const seen: string[][] = [];
    const { result } = renderHook(() =>
      useBatchRunner<Entry>({ runChunk: okRunner(seen), chunkSize: 2 })
    );

    await act(async () => { await result.current.start(entries); });

    expect(seen).toEqual([["i1", "i2"], ["i3", "i4"], ["i5"]]);
    expect(result.current.summary.done).toBe(5);
    expect(result.current.isRunning).toBe(false);
  });

  it("una tanda con fallos no corta el resto", async () => {
    const runChunk = async (batch: Entry[]): Promise<Map<string, BatchItemResult>> =>
      new Map(
        batch.map((e) => [
          e.id,
          e.id === "i2"
            ? ({ status: "failed", message: "boom" } as BatchItemResult)
            : ({ status: "done" } as BatchItemResult),
        ])
      );

    const { result } = renderHook(() => useBatchRunner<Entry>({ runChunk, chunkSize: 2 }));
    await act(async () => { await result.current.start(entries); });

    expect(result.current.summary.done).toBe(4);
    expect(result.current.summary.failed).toBe(1);
    expect(result.current.items.find((i) => i.id === "i2")?.message).toBe("boom");
  });

  it("cancel frena antes de la tanda siguiente pero registra la que estaba en vuelo", async () => {
    const seen: string[][] = [];
    const run = okRunner(seen);
    const { result } = renderHook(() =>
      useBatchRunner<Entry>({
        runChunk: async (batch) => {
          const out = await run(batch);
          result.current.cancel(); // cancelar durante la primera tanda
          return out;
        },
        chunkSize: 2,
      })
    );

    await act(async () => { await result.current.start(entries); });

    expect(seen).toEqual([["i1", "i2"]]);
    expect(result.current.summary.done).toBe(2);
    expect(result.current.summary.pending).toBe(3);
    expect(result.current.isRunning).toBe(false);
  });

  it("retryFailed re-corre sólo las fallidas", async () => {
    let failFirstPass = true;
    const seen: string[][] = [];
    const runChunk = async (batch: Entry[]): Promise<Map<string, BatchItemResult>> => {
      seen.push(batch.map((e) => e.id));
      return new Map(
        batch.map((e) => [
          e.id,
          failFirstPass && e.id === "i3"
            ? ({ status: "failed", message: "temporal" } as BatchItemResult)
            : ({ status: "done" } as BatchItemResult),
        ])
      );
    };

    const { result } = renderHook(() => useBatchRunner<Entry>({ runChunk, chunkSize: 2 }));
    await act(async () => { await result.current.start(entries); });
    expect(result.current.summary.failed).toBe(1);

    failFirstPass = false;
    seen.length = 0;
    await act(async () => { await result.current.retryFailed(); });

    expect(seen).toEqual([["i3"]]);
    expect(result.current.summary.failed).toBe(0);
    expect(result.current.summary.done).toBe(5);
  });

  it("no arranca una segunda corrida mientras hay una en curso", async () => {
    const seen: string[][] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });

    const { result } = renderHook(() =>
      useBatchRunner<Entry>({
        runChunk: async (batch) => {
          seen.push(batch.map((e) => e.id));
          await gate;
          return new Map(batch.map((e) => [e.id, { status: "done" } as BatchItemResult]));
        },
        chunkSize: 5,
      })
    );

    let first: Promise<void>;
    act(() => { first = result.current.start(entries); });
    await waitFor(() => expect(result.current.isRunning).toBe(true));

    await act(async () => { await result.current.start(entries); }); // segundo intento: ignorado
    await act(async () => { release(); await first!; });

    expect(seen).toHaveLength(1);
  });
});
