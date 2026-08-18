import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useManualRun } from "./useManualRun";

type FetchResponse = { ok: boolean; status?: number; body: unknown };

/** Enruta cada endpoint del hook a una respuesta, registrando las llamadas. */
function mockFetch(routes: {
  files?: FetchResponse;
  enqueue?: FetchResponse;
  status?: FetchResponse[];
}) {
  const calls: string[] = [];
  let statusIndex = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);

      const pick = (): FetchResponse => {
        if (url.endsWith("/files")) return routes.files!;
        if (init?.method === "POST") return routes.enqueue!;
        const list = routes.status ?? [];
        const response = list[Math.min(statusIndex, list.length - 1)];
        statusIndex += 1;
        return response;
      };

      const response = pick();
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        json: async () => response.body,
      } as Response;
    })
  );

  return calls;
}

const filesBody = {
  ok: true,
  max: 10,
  files: Array.from({ length: 12 }, (_, i) => ({
    id: `f${i}`,
    name: `boleta-${i}.pdf`,
    mimeType: "application/pdf",
    status: "available" as const,
  })),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useManualRun", () => {
  it("no carga la lista mientras el modal está cerrado", async () => {
    const calls = mockFetch({ files: { ok: true, body: filesBody } });

    renderHook(() => useManualRun(false));

    expect(calls).toEqual([]);
  });

  it("carga las boletas de Pendientes al abrirse", async () => {
    mockFetch({ files: { ok: true, body: filesBody } });

    const { result } = renderHook(() => useManualRun(true));

    await waitFor(() => expect(result.current.files).toHaveLength(12));
  });

  it("no deja seleccionar más del tope", async () => {
    mockFetch({ files: { ok: true, body: filesBody } });
    const { result } = renderHook(() => useManualRun(true));
    await waitFor(() => expect(result.current.files).toHaveLength(12));

    act(() => {
      for (let i = 0; i < 12; i += 1) result.current.toggle(`f${i}`);
    });

    expect(result.current.selected.size).toBe(10);
    expect(result.current.selected.has("f10")).toBe(false);
  });

  it("destildar libera lugar para elegir otra", async () => {
    mockFetch({ files: { ok: true, body: filesBody } });
    const { result } = renderHook(() => useManualRun(true));
    await waitFor(() => expect(result.current.files).toHaveLength(12));

    act(() => {
      for (let i = 0; i < 10; i += 1) result.current.toggle(`f${i}`);
    });
    act(() => result.current.toggle("f0"));
    act(() => result.current.toggle("f11"));

    expect(result.current.selected.has("f0")).toBe(false);
    expect(result.current.selected.has("f11")).toBe(true);
    expect(result.current.selected.size).toBe(10);
  });

  it("encola la selección y arranca a seguir el avance", async () => {
    const progressFile = {
      fileId: "f0", fileName: "boleta-0.pdf", status: "COMPLETED",
      result: "ok", reason: null, errorMessage: null,
    };
    const calls = mockFetch({
      files: { ok: true, body: filesBody },
      enqueue: { ok: true, body: { ok: true, runId: "run-1", queued: 1 } },
      status: [
        { ok: true, body: { ok: true, done: true, files: [progressFile], report: { jsonUrl: "u.json", markdownUrl: "u.md" } } },
      ],
    });

    const { result } = renderHook(() => useManualRun(true));
    await waitFor(() => expect(result.current.files).toHaveLength(12));

    act(() => result.current.toggle("f0"));
    await act(async () => { await result.current.enqueue(); });

    await waitFor(() => expect(result.current.done).toBe(true));
    expect(result.current.runId).toBe("run-1");
    expect(result.current.progress).toEqual([progressFile]);
    expect(result.current.report).toEqual({ jsonUrl: "u.json", markdownUrl: "u.md" });
    expect(calls).toContain("POST /api/client/manual-run");
  });

  it("deja de consultar cuando la corrida terminó", async () => {
    const calls = mockFetch({
      files: { ok: true, body: filesBody },
      enqueue: { ok: true, body: { ok: true, runId: "run-1", queued: 1 } },
      status: [{ ok: true, body: { ok: true, done: true, files: [], report: null } }],
    });

    const { result } = renderHook(() => useManualRun(true));
    await waitFor(() => expect(result.current.files).toHaveLength(12));
    act(() => result.current.toggle("f0"));
    await act(async () => { await result.current.enqueue(); });
    await waitFor(() => expect(result.current.done).toBe(true));

    const afterDone = calls.filter((c) => c.includes("/manual-run/run-1")).length;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls.filter((c) => c.includes("/manual-run/run-1")).length).toBe(afterDone);
  });

  it("expone el error del server sin encolar", async () => {
    mockFetch({
      files: { ok: true, body: filesBody },
      enqueue: { ok: false, status: 400, body: { ok: false, error: "Máximo 10 boletas por corrida" } },
    });

    const { result } = renderHook(() => useManualRun(true));
    await waitFor(() => expect(result.current.files).toHaveLength(12));
    act(() => result.current.toggle("f0"));
    await act(async () => { await result.current.enqueue(); });

    expect(result.current.error).toBe("Máximo 10 boletas por corrida");
    expect(result.current.runId).toBeNull();
  });
});
