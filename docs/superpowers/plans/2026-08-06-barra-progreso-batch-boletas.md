# Barra de progreso para acciones masivas de Boletas — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: usar `superpowers:subagent-driven-development`
> (recomendado) o `superpowers:executing-plans` para implementar tarea por tarea. Los pasos usan
> checkboxes (`- [ ]`) para seguimiento.

> **⚠️ REGLA DEL PROYECTO — NO COMMITEAR.** Claude nunca ejecuta `git commit`, `git add` ni
> `git push`. El owner commitea con GitLens. Por eso cada tarea cierra con un paso de
> **verificación**, no de commit. No sugerir mensajes de commit ni preparar staging.

**Goal:** Que "Borrar seleccionadas" y "Mover al período siguiente" de `/admin/boletas` procesen
cualquier cantidad de boletas en tandas automáticas de 5, mostrando una barra de progreso con el
estado real de cada boleta, sin tocar el backend ni la base de datos.

**Architecture:** Un runner genérico en el frontend parte la selección en tandas de
`RUN_CHUNK = 5` y las manda en secuencia a los endpoints existentes (que ya aceptan hasta 10 y ya
son idempotentes). Tres piezas nuevas siguiendo el patrón del proyecto: lógica pura en `lib/`, un
hook en `hooks/`, un componente presentacional en `components/`. `page.tsx` sólo cablea.

**Tech Stack:** Next.js 15 (App Router, client components), TypeScript, React 19, Vitest con dos
proyectos (`node` para `*.test.ts`, `jsdom` para `*.test.tsx`), `@testing-library/react` +
`user-event`.

**Spec:** `docs/superpowers/specs/2026-08-06-barra-progreso-batch-boletas-design.md`

---

## Contexto que el implementador necesita saber

**El dominio.** Una "boleta" es una factura en PDF ya procesada. Borrarla o moverla de período
implica tres sistemas externos por boleta: Google Drive (mover el PDF), Google Sheets (borrar o
editar su fila) y PostgreSQL. Por eso cada boleta tarda ~8,5 s y por eso existían topes de 10.

**Por qué tandas de 5.** El endpoint lee la planilla entera de Google Sheets **una vez por request**
y resuelve las filas en memoria. Tandas chicas pierden esa amortización. Con 5 el sobrecosto es ~8%;
con 1 sería ~70%. Detalle en la §3.1 del spec.

**Los endpoints ya son idempotentes.** Reintentar la misma lista no duplica trabajo. Eso es lo que
habilita el botón "Reintentar fallidas" sin salvaguardas extra.

**Convenciones del repo que hay que respetar:**
- PowerShell: **no usar `&&`**, comandos separados.
- Tests: lógica pura → `.test.ts` (proyecto `node`); hooks y componentes → `.test.tsx`
  (proyecto `jsdom`). Correr todo con `npx vitest run`.
- Los archivos de `admin/boletas/` usan **estilos inline** en los modales (ver `page.tsx:410-565`).
  Mantener ese estilo ahí; no introducir un CSS Module nuevo para este trabajo.
- El proyecto escribe comentarios y textos de UI en **castellano**.

**Baseline verificado:** working tree limpio en `379d6f6`, **456 tests** verdes,
`src/app/admin/boletas/page.tsx` en **568 líneas**.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/app/admin/boletas/lib/batchProgress.ts` **(crear)** | Estado de la corrida como datos puros: tipos, transiciones, contadores, ETA |
| `src/app/admin/boletas/lib/batchProgress.test.ts` **(crear)** | Tests tier 0 de lo anterior |
| `src/app/admin/boletas/lib/batchAdapters.ts` **(crear)** | Normaliza las respuestas de los 2 endpoints a un resultado por `invoiceId`. Incluye `SKIP_LABELS` |
| `src/app/admin/boletas/lib/batchAdapters.test.ts` **(crear)** | Tests tier 0 de los adaptadores |
| `src/app/admin/boletas/hooks/useBatchRunner.ts` **(crear)** | Bucle secuencial por tandas, cancelación, reintento |
| `src/app/admin/boletas/hooks/useBatchRunner.test.tsx` **(crear)** | Tests tier 1 del hook |
| `src/app/admin/boletas/components/BatchProgressModal.tsx` **(crear)** | Modal presentacional: barra, ETA, lista de filas, botones |
| `src/app/admin/boletas/components/BatchProgressModal.test.tsx` **(crear)** | Tests tier 2 del componente |
| `src/app/admin/boletas/page.tsx` **(modificar)** | Cablea las piezas; elimina topes de selección y el estado `unknown` |

---

## Task 1: Estado de la corrida (lógica pura)

**Files:**
- Create: `src/app/admin/boletas/lib/batchProgress.ts`
- Test: `src/app/admin/boletas/lib/batchProgress.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/app/admin/boletas/lib/batchProgress.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  initBatchItems,
  markRunning,
  applyItemResult,
  summarizeBatch,
  estimateRemainingMs,
  formatEta,
} from "./batchProgress";

const entries = [
  { id: "i1", label: "ARENALES 2154 — junio-2026" },
  { id: "i2", label: "THAMES 647 — junio-2026" },
  { id: "i3", label: "CASTILLO 246 — junio-2026" },
];

describe("initBatchItems", () => {
  it("arranca todo en pending conservando el orden", () => {
    const items = initBatchItems(entries);
    expect(items.map((i) => i.id)).toEqual(["i1", "i2", "i3"]);
    expect(items.every((i) => i.status === "pending")).toBe(true);
  });
});

describe("markRunning", () => {
  it("marca en running sólo los ids pedidos", () => {
    const items = markRunning(initBatchItems(entries), ["i1", "i2"]);
    expect(items.map((i) => i.status)).toEqual(["running", "running", "pending"]);
  });

  it("no muta el array original", () => {
    const original = initBatchItems(entries);
    markRunning(original, ["i1"]);
    expect(original[0].status).toBe("pending");
  });
});

describe("applyItemResult", () => {
  it("aplica done", () => {
    const items = applyItemResult(initBatchItems(entries), "i2", { status: "done" });
    expect(items[1].status).toBe("done");
    expect(items[0].status).toBe("pending");
  });

  it("aplica skipped con motivo", () => {
    const items = applyItemResult(initBatchItems(entries), "i1", {
      status: "skipped",
      message: "ya estaba en el período destino",
    });
    expect(items[0].status).toBe("skipped");
    expect(items[0].message).toBe("ya estaba en el período destino");
  });

  it("aplica failed con needsReview", () => {
    const items = applyItemResult(initBatchItems(entries), "i3", {
      status: "failed",
      message: "Drive falló",
      needsReview: true,
    });
    expect(items[2].status).toBe("failed");
    expect(items[2].needsReview).toBe(true);
  });

  it("ignora un id desconocido sin romper", () => {
    const items = applyItemResult(initBatchItems(entries), "nope", { status: "done" });
    expect(items.every((i) => i.status === "pending")).toBe(true);
  });
});

describe("summarizeBatch", () => {
  it("cuenta cada estado y calcula el porcentaje sobre lo procesado", () => {
    let items = initBatchItems(entries);
    items = applyItemResult(items, "i1", { status: "done" });
    items = applyItemResult(items, "i2", { status: "failed", message: "x" });

    const s = summarizeBatch(items);
    expect(s).toMatchObject({
      total: 3, done: 1, failed: 1, skipped: 0, pending: 1, processed: 2,
    });
    expect(s.percent).toBe(67);
  });

  it("no divide por cero con la lista vacía", () => {
    expect(summarizeBatch([]).percent).toBe(0);
  });

  it("running cuenta como pendiente, no como procesado", () => {
    const items = markRunning(initBatchItems(entries), ["i1"]);
    expect(summarizeBatch(items).processed).toBe(0);
    expect(summarizeBatch(items).pending).toBe(3);
  });
});

describe("estimateRemainingMs", () => {
  it("sin nada procesado no puede estimar", () => {
    expect(estimateRemainingMs(0, 50, 1000)).toBeNull();
  });

  it("extrapola por el promedio medido", () => {
    // 10 procesadas en 100 s → 10 s c/u → faltan 40 → 400 s
    expect(estimateRemainingMs(10, 50, 100_000)).toBe(400_000);
  });

  it("al terminar da cero", () => {
    expect(estimateRemainingMs(50, 50, 100_000)).toBe(0);
  });
});

describe("formatEta", () => {
  it("sin estimación muestra un guión", () => {
    expect(formatEta(null)).toBe("—");
  });

  it("bajo el minuto usa segundos", () => {
    expect(formatEta(45_000)).toBe("≈ 45 s");
  });

  it("desde el minuto usa minutos redondeando hacia arriba", () => {
    expect(formatEta(400_000)).toBe("≈ 7 min");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/boletas/lib/batchProgress.test.ts
```

Esperado: FAIL — `Failed to resolve import "./batchProgress"`.

- [ ] **Step 3: Escribir la implementación mínima**

Crear `src/app/admin/boletas/lib/batchProgress.ts`:

```ts
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
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/boletas/lib/batchProgress.test.ts
```

Esperado: PASS, 16 tests.

- [ ] **Step 5: Verificar tipos**

```bash
npm run typecheck
```

Esperado: 0 errores. **No commitear** — el owner lo hace.

---

## Task 2: Adaptadores de respuesta (lógica pura)

Los dos endpoints devuelven los éxitos como **número** (`deleted`, `moved`), no como lista de ids.
Sólo `skipped[]` y `failed[]` traen `invoiceId`. Por eso la regla es: *todo id enviado que no vuelve
en `skipped[]` ni en `failed[]` se marca `done`*.

**Files:**
- Create: `src/app/admin/boletas/lib/batchAdapters.ts`
- Test: `src/app/admin/boletas/lib/batchAdapters.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/app/admin/boletas/lib/batchAdapters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SKIP_LABELS,
  UNCONFIRMED_MESSAGE,
  adaptDeleteResponse,
  adaptMoveResponse,
} from "./batchAdapters";

describe("adaptDeleteResponse", () => {
  it("marca done todo id que no vuelve en failed", () => {
    const map = adaptDeleteResponse(["i1", "i2", "i3"], {
      ok: true,
      deleted: 2,
      failed: [{ invoiceId: "i2", error: "La boleta tiene 1 pago(s) registrado(s)" }],
    });
    expect(map.get("i1")).toEqual({ status: "done" });
    expect(map.get("i3")).toEqual({ status: "done" });
    expect(map.get("i2")).toEqual({
      status: "failed",
      message: "La boleta tiene 1 pago(s) registrado(s)",
    });
  });

  it("respuesta nula → todas sin confirmar", () => {
    const map = adaptDeleteResponse(["i1", "i2"], null);
    expect(map.get("i1")).toEqual({ status: "failed", message: UNCONFIRMED_MESSAGE });
    expect(map.get("i2")).toEqual({ status: "failed", message: UNCONFIRMED_MESSAGE });
  });

  it("ok:false → todas sin confirmar", () => {
    const map = adaptDeleteResponse(["i1"], { ok: false });
    expect(map.get("i1")).toEqual({ status: "failed", message: UNCONFIRMED_MESSAGE });
  });

  it("devuelve una entrada por cada id enviado", () => {
    expect(adaptDeleteResponse(["i1", "i2", "i3"], { ok: true, deleted: 3, failed: [] }).size).toBe(3);
  });
});

describe("adaptMoveResponse", () => {
  it("tanda mixta: done + skipped traducido + failed", () => {
    const map = adaptMoveResponse(["i1", "i2", "i3", "i4", "i5"], {
      ok: true,
      moved: 2,
      skipped: [{ invoiceId: "i3", reason: "ya_en_destino" }],
      failed: [
        { invoiceId: "i4", error: "Drive timeout", reverted: true },
        { invoiceId: "i5", error: "Sheets falló", reverted: false },
      ],
    });
    expect(map.get("i1")).toEqual({ status: "done" });
    expect(map.get("i2")).toEqual({ status: "done" });
    expect(map.get("i3")).toEqual({
      status: "skipped",
      message: SKIP_LABELS["ya_en_destino"],
    });
    expect(map.get("i4")).toEqual({
      status: "failed",
      message: "Drive timeout",
      needsReview: false,
    });
    expect(map.get("i5")).toEqual({
      status: "failed",
      message: "Sheets falló",
      needsReview: true,
    });
  });

  it("un motivo de skip desconocido se muestra tal cual", () => {
    const map = adaptMoveResponse(["i1"], {
      ok: true, moved: 0,
      skipped: [{ invoiceId: "i1", reason: "motivo_nuevo" }],
      failed: [],
    });
    expect(map.get("i1")).toEqual({ status: "skipped", message: "motivo_nuevo" });
  });

  it("respuesta nula → las 5 sin confirmar", () => {
    const map = adaptMoveResponse(["i1", "i2", "i3", "i4", "i5"], null);
    expect(map.size).toBe(5);
    expect([...map.values()].every((r) => r.status === "failed")).toBe(true);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/boletas/lib/batchAdapters.test.ts
```

Esperado: FAIL — `Failed to resolve import "./batchAdapters"`.

- [ ] **Step 3: Escribir la implementación mínima**

Crear `src/app/admin/boletas/lib/batchAdapters.ts`:

```ts
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
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/boletas/lib/batchAdapters.test.ts
```

Esperado: PASS, 7 tests.

- [ ] **Step 5: Verificar tipos**

```bash
npm run typecheck
```

Esperado: 0 errores. **No commitear.**

---

## Task 3: El runner (hook)

**Files:**
- Create: `src/app/admin/boletas/hooks/useBatchRunner.ts`
- Test: `src/app/admin/boletas/hooks/useBatchRunner.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/app/admin/boletas/hooks/useBatchRunner.test.tsx`:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/boletas/hooks/useBatchRunner.test.tsx
```

Esperado: FAIL — `Failed to resolve import "./useBatchRunner"`.

- [ ] **Step 3: Escribir la implementación mínima**

Crear `src/app/admin/boletas/hooks/useBatchRunner.ts`:

```ts
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

  // Refs y no estado: el bucle los lee en vivo. Un `useState` quedaría capturado
  // con su valor viejo dentro del `for` y el Cancelar no tendría efecto.
  const cancelRef = useRef(false);
  const runningRef = useRef(false);
  const entriesRef = useRef<T[]>([]);

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
          setItems((prev) => markRunning(prev, ids));

          const results = await runChunk(batch);

          setItems((prev) => {
            let next = prev;
            for (const id of ids) {
              next = applyItemResult(next, id, results.get(id) ?? { status: "done" });
            }
            return next;
          });

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
    [chunkSize, runChunk]
  );

  const start = useCallback(
    async (entries: BatchEntry[]) => {
      if (runningRef.current) return;
      entriesRef.current = entries as T[];
      setItems(initBatchItems(entries));
      setEtaMs(null);
      await runEntries(entries as T[]);
    },
    [runEntries]
  );

  const retryFailed = useCallback(async () => {
    if (runningRef.current) return;
    const failedIds = new Set(
      // `items` se lee del estado más reciente vía el setter para evitar closures viejas.
      [] as string[]
    );
    // Snapshot sincrónico del estado actual.
    let snapshot: BatchItem[] = [];
    setItems((prev) => { snapshot = prev; return prev; });
    for (const item of snapshot) if (item.status === "failed") failedIds.add(item.id);
    if (failedIds.size === 0) return;

    const toRun = entriesRef.current.filter((e) => failedIds.has(e.id));
    setItems((prev) =>
      prev.map((item) => (failedIds.has(item.id)
        ? { ...item, status: "pending", message: undefined, needsReview: undefined }
        : item))
    );
    await runEntries(toRun);
  }, [runEntries]);

  const cancel = useCallback(() => { cancelRef.current = true; }, []);

  const reset = useCallback(() => {
    setItems([]);
    setEtaMs(null);
    entriesRef.current = [];
  }, []);

  const summary = useMemo(() => summarizeBatch(items), [items]);

  return { items, summary, isRunning, etaMs, start, cancel, retryFailed, reset };
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/boletas/hooks/useBatchRunner.test.tsx
```

Esperado: PASS, 5 tests.

Si `retryFailed` falla por leer un snapshot vacío, reemplazar el truco del setter por un
`itemsRef` mantenido en paralelo (`useRef<BatchItem[]>([])` actualizado en cada `setItems`) y leer
de ahí. Es el mismo patrón de `cancelRef`: refs para lo que el bucle lee en vivo.

- [ ] **Step 5: Verificar tipos y lint**

```bash
npm run typecheck
```

```bash
npm run lint
```

Esperado: 0 errores en ambos. **No commitear.**

---

## Task 4: El modal de progreso (componente)

**Files:**
- Create: `src/app/admin/boletas/components/BatchProgressModal.tsx`
- Test: `src/app/admin/boletas/components/BatchProgressModal.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/app/admin/boletas/components/BatchProgressModal.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BatchProgressModal } from "./BatchProgressModal";
import type { BatchItem } from "../lib/batchProgress";
import { summarizeBatch } from "../lib/batchProgress";

const items: BatchItem[] = [
  { id: "i1", label: "ARENALES 2154", status: "done" },
  { id: "i2", label: "THAMES 647", status: "running" },
  { id: "i3", label: "CASTILLO 246", status: "pending" },
  { id: "i4", label: "MITRE 1225", status: "skipped", message: "ya estaba en el período destino" },
  { id: "i5", label: "SAN ANTONIO 345", status: "failed", message: "Drive timeout", needsReview: true },
];

function renderModal(overrides: Partial<React.ComponentProps<typeof BatchProgressModal>> = {}) {
  const props = {
    title: "Borrando boletas",
    items,
    summary: summarizeBatch(items),
    isRunning: true,
    etaMs: 120_000,
    onCancel: vi.fn(),
    onRetryFailed: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<BatchProgressModal {...props} />);
  return props;
}

describe("BatchProgressModal", () => {
  it("muestra el título, el contador y el ETA mientras corre", () => {
    renderModal();
    expect(screen.getByText("Borrando boletas")).toBeInTheDocument();
    expect(screen.getByText(/3 de 5/)).toBeInTheDocument();
    expect(screen.getByText(/≈ 2 min/)).toBeInTheDocument();
  });

  it("lista cada boleta con su etiqueta y el motivo cuando lo hay", () => {
    renderModal();
    expect(screen.getByText("ARENALES 2154")).toBeInTheDocument();
    expect(screen.getByText(/ya estaba en el período destino/)).toBeInTheDocument();
    expect(screen.getByText(/Drive timeout/)).toBeInTheDocument();
  });

  it("destaca la boleta que necesita revisión manual", () => {
    renderModal();
    expect(screen.getByText(/revisar manualmente/i)).toBeInTheDocument();
  });

  it("mientras corre ofrece Cancelar y no Cerrar", async () => {
    const props = renderModal();
    await userEvent.click(screen.getByRole("button", { name: /Cancelar/ }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^Cerrar$/ })).not.toBeInTheDocument();
  });

  it("al terminar ofrece Reintentar fallidas y Cerrar", async () => {
    const props = renderModal({ isRunning: false, etaMs: null });
    await userEvent.click(screen.getByRole("button", { name: /Reintentar fallidas/ }));
    expect(props.onRetryFailed).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: /^Cerrar$/ }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("sin fallidas no ofrece reintentar", () => {
    const allDone: BatchItem[] = [{ id: "i1", label: "ARENALES 2154", status: "done" }];
    renderModal({ items: allDone, summary: summarizeBatch(allDone), isRunning: false });
    expect(screen.queryByRole("button", { name: /Reintentar fallidas/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx vitest run src/app/admin/boletas/components/BatchProgressModal.test.tsx
```

Esperado: FAIL — `Failed to resolve import "./BatchProgressModal"`.

- [ ] **Step 3: Escribir la implementación mínima**

Crear `src/app/admin/boletas/components/BatchProgressModal.tsx`. Usa estilos inline igual que los
modales que ya viven en `boletas/page.tsx`:

```tsx
import styles from "../../invoices/page.module.css";
import { formatEta, type BatchItem, type BatchSummary } from "../lib/batchProgress";

type Props = {
  title: string;
  items: BatchItem[];
  summary: BatchSummary;
  isRunning: boolean;
  etaMs: number | null;
  onCancel: () => void;
  onRetryFailed: () => void;
  onClose: () => void;
};

const STATUS_COLOR: Record<BatchItem["status"], string> = {
  pending: "#9ca3af",
  running: "#3b82f6",
  done: "#16a34a",
  skipped: "#b45309",
  failed: "#b91c1c",
};

const STATUS_ICON: Record<BatchItem["status"], string> = {
  pending: "○",
  running: "◐",
  done: "✓",
  skipped: "—",
  failed: "✕",
};

/**
 * Progreso de una corrida masiva. Presentacional puro: todo el estado vive en
 * `useBatchRunner`. Al terminar, esta misma lista ES el resumen — no hay salto a
 * otra pantalla.
 */
export function BatchProgressModal({
  title, items, summary, isRunning, etaMs, onCancel, onRetryFailed, onClose,
}: Props) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "#111827", color: "#f9fafb", borderRadius: 12, padding: 24,
          maxWidth: 620, width: "90%", maxHeight: "80vh", display: "flex", flexDirection: "column",
        }}
      >
        <h2 style={{ marginTop: 0 }}>{title}</h2>

        <p style={{ margin: "4px 0 8px" }}>
          <strong>{summary.processed} de {summary.total}</strong>
          {isRunning && <> · restante {formatEta(etaMs)}</>}
        </p>

        {/* Barra */}
        <div
          role="progressbar"
          aria-valuenow={summary.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.12)", overflow: "hidden" }}
        >
          <div
            style={{
              width: `${summary.percent}%`, height: "100%",
              background: summary.failed > 0 ? "#b45309" : "#2563eb",
              transition: "width 240ms ease",
            }}
          />
        </div>

        <p style={{ fontSize: 13, opacity: 0.8, margin: "8px 0" }}>
          {summary.done} hecha(s) · {summary.skipped} salteada(s) · {summary.failed} con error
        </p>

        <ul style={{ flex: 1, overflowY: "auto", listStyle: "none", padding: 0, margin: "8px 0" }}>
          {items.map((item) => (
            <li
              key={item.id}
              style={{
                display: "flex", gap: 8, alignItems: "baseline",
                padding: "4px 0", fontSize: 13,
                borderBottom: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <span style={{ color: STATUS_COLOR[item.status], width: 16, flexShrink: 0 }}>
                {STATUS_ICON[item.status]}
              </span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.message && (
                <span style={{ color: STATUS_COLOR[item.status], textAlign: "right" }}>
                  {item.message}
                  {item.needsReview && " — revisar manualmente"}
                </span>
              )}
            </li>
          ))}
        </ul>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          {isRunning ? (
            <button type="button" className={styles.ghostBtn} onClick={onCancel}>
              Cancelar (termina la tanda en curso)
            </button>
          ) : (
            <>
              {summary.failed > 0 && (
                <button
                  type="button"
                  className={styles.ghostBtn}
                  style={{ background: "#2563eb", borderColor: "#2563eb", color: "#fff" }}
                  onClick={onRetryFailed}
                >
                  Reintentar fallidas ({summary.failed})
                </button>
              )}
              <button type="button" className={styles.ghostBtn} onClick={onClose}>
                Cerrar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
npx vitest run src/app/admin/boletas/components/BatchProgressModal.test.tsx
```

Esperado: PASS, 6 tests.

- [ ] **Step 5: Verificar tipos y lint**

```bash
npm run typecheck
```

```bash
npm run lint
```

Esperado: 0 errores. **No commitear.**

---

## Task 5: Cablear el borrado masivo

**Files:**
- Modify: `src/app/admin/boletas/page.tsx`

Ver el estado actual en `page.tsx:147-182` (`handleDeleteSelected`) y `page.tsx:11-14` (constantes).

- [ ] **Step 1: Reemplazar las constantes de tope**

En `page.tsx`, borrar:

```ts
/** Tope de boletas por tanda al mover de período (evita el timeout de ~100s del túnel). */
const MAX_MOVE_BATCH = 10;
/** Tope de boletas por tanda al borrar (mismo motivo: varias llamadas a Drive/Sheets por boleta). */
const MAX_DELETE_BATCH = 10;
```

y poner:

```ts
/**
 * Tamaño de tanda del PREVIEW de "mover" (read-only: no toca Drive ni Sheets,
 * por eso puede ser mayor que el de ejecución, que vive en `useBatchRunner`).
 */
const PREVIEW_CHUNK = 10;
/** Segundos que tarda una boleta en promedio; sólo para estimar antes de arrancar. */
const SECONDS_PER_INVOICE = 9;
```

- [ ] **Step 2: Agregar los imports**

Junto a los imports que ya están arriba de `page.tsx`:

```tsx
import { useBatchRunner, type BatchEntry } from "./hooks/useBatchRunner";
import { BatchProgressModal } from "./components/BatchProgressModal";
import { adaptDeleteResponse, adaptMoveResponse, SKIP_LABELS } from "./lib/batchAdapters";
import type { BatchItemResult } from "./lib/batchProgress";
```

Y **borrar** el `SKIP_LABELS` inline que hoy vive en `page.tsx:184-190` (ahora viene del import).

- [ ] **Step 3: Agregar el helper de estimación y el estado del modal**

Arriba del componente, junto a los otros helpers de formato:

```tsx
/** "≈ 8 min" a partir de la cantidad de boletas, para avisar antes de arrancar. */
function estimateRunLabel(count: number): string {
  const seconds = count * SECONDS_PER_INVOICE;
  return seconds < 60 ? `≈ ${seconds} s` : `≈ ${Math.ceil(seconds / 60)} min`;
}
```

Dentro del componente, junto a los otros `useState`:

```tsx
const [batchTitle, setBatchTitle] = useState<string | null>(null);
```

- [ ] **Step 4: Crear el runner de borrado**

Dentro del componente, después de `fetchInvoices`:

```tsx
const deleteRunner = useBatchRunner<BatchEntry>({
  runChunk: useCallback(
    async (batch: BatchEntry[]): Promise<Map<string, BatchItemResult>> => {
      const ids = batch.map((e) => e.id);
      try {
        const res = await guardedFetch("/api/client/invoices/bulk-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invoiceIds: ids }),
        });
        const data = await res.json().catch(() => null);
        return adaptDeleteResponse(ids, res.ok ? data : null);
      } catch {
        return adaptDeleteResponse(ids, null);
      }
    },
    [guardedFetch]
  ),
});
```

- [ ] **Step 5: Reescribir `handleDeleteSelected`**

Reemplazar el cuerpo entero de `handleDeleteSelected` (`page.tsx:147-182`) por:

```tsx
const handleDeleteSelected = useCallback(async () => {
  if (selectedCount === 0) return;

  const ok = window.confirm(
    `¿Borrar ${selectedCount} boleta(s)?  (${estimateRunLabel(selectedCount)})\n\n` +
    `Se quitan del Sheet y de la base, y los PDFs vuelven a Pendientes para reprocesarse.`
  );
  if (!ok) return;

  setError(null);
  setNotice(null);
  setBatchTitle("Borrando boletas");

  const entries: BatchEntry[] = [...selected].map((id) => {
    const inv = invoices.find((i) => i.id === id);
    return {
      id,
      label: `${inv?.consortium ?? "(sin consorcio)"} — ${inv?.provider ?? "(sin proveedor)"}`,
    };
  });

  await deleteRunner.start(entries);
  setSelected(new Set());
  await fetchInvoices();
}, [selected, selectedCount, invoices, deleteRunner, fetchInvoices]);
```

Se eliminan el guard de `MAX_DELETE_BATCH`, el `setDeleting`, el `try/catch` y el `setNotice` del
resumen — el modal cumple esa función. El `useState` `deleting` queda sin uso: **borrarlo** y
reemplazar sus lecturas en los botones (`page.tsx:307` y `:311`) por `deleteRunner.isRunning`.

- [ ] **Step 6: Renderizar el modal**

Antes del cierre `</div>` final del componente (después del modal de preview de Drive):

```tsx
{batchTitle && (
  <BatchProgressModal
    title={batchTitle}
    items={deleteRunner.items}
    summary={deleteRunner.summary}
    isRunning={deleteRunner.isRunning}
    etaMs={deleteRunner.etaMs}
    onCancel={deleteRunner.cancel}
    onRetryFailed={() => void deleteRunner.retryFailed()}
    onClose={() => { setBatchTitle(null); deleteRunner.reset(); void fetchInvoices(); }}
  />
)}
```

- [ ] **Step 7: Verificar**

```bash
npx vitest run
```

Esperado: PASS, 456 + 34 = **490 tests** (16 + 7 + 5 + 6 nuevos de las tareas 1 a 4).

```bash
npm run typecheck
```

```bash
npm run lint
```

Esperado: 0 errores. **No commitear.**

---

## Task 6: Cablear el movimiento de período y eliminar el estado `unknown`

**Files:**
- Modify: `src/app/admin/boletas/page.tsx`

- [ ] **Step 1: Chunkear el preview**

Reemplazar el cuerpo del `try` de `openMoveModal` (`page.tsx:202-216`) por una versión que mande en
tandas de `PREVIEW_CHUNK` y concatene, y borrar el guard de `MAX_MOVE_BATCH` (`page.tsx:194-197`):

```tsx
const ids = [...selected];
const batches: string[][] = [];
for (let i = 0; i < ids.length; i += PREVIEW_CHUNK) batches.push(ids.slice(i, i + PREVIEW_CHUNK));

const collected: MovePreviewItem[] = [];
for (const batch of batches) {
  const res = await guardedFetch("/api/client/invoices/bulk-move-period/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoiceIds: batch }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  collected.push(...(data.items as MovePreviewItem[]));
}
setMovePreview(collected);
setMoveStep("preview");
```

- [ ] **Step 2: Crear el runner de movimiento**

Junto al `deleteRunner`:

```tsx
const [moveTargets, setMoveTargets] = useState<Map<string, string>>(new Map());

const moveRunner = useBatchRunner<BatchEntry>({
  runChunk: useCallback(
    async (batch: BatchEntry[]): Promise<Map<string, BatchItemResult>> => {
      const ids = batch.map((e) => e.id);
      const moves = ids
        .map((id) => ({ invoiceId: id, targetPeriodId: moveTargets.get(id) ?? "" }))
        .filter((m) => m.targetPeriodId !== "");
      try {
        const res = await guardedFetch("/api/client/invoices/bulk-move-period", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ moves }),
        });
        const data = await res.json().catch(() => null);
        return adaptMoveResponse(ids, res.ok ? data : null);
      } catch {
        return adaptMoveResponse(ids, null);
      }
    },
    [guardedFetch, moveTargets]
  ),
});
```

- [ ] **Step 3: Reescribir `confirmMove`**

Reemplazar `confirmMove` (`page.tsx:256-261`) y **borrar** `runMove` (`page.tsx:219-254`) entero:

```tsx
const confirmMove = useCallback(async () => {
  const movable = movePreview.filter((i) => i.movable && i.targetPeriodId);
  if (movable.length === 0) return;

  setMoveTargets(new Map(movable.map((i) => [i.invoiceId, i.targetPeriodId!])));
  setMoveStep(null);
  setBatchTitle("Moviendo boletas al período siguiente");

  const entries: BatchEntry[] = movable.map((i) => ({
    id: i.invoiceId,
    label: `${i.consortium ?? "(sin consorcio)"} — ${i.fromLabel} → ${i.toLabel}`,
  }));

  await moveRunner.start(entries);
  setSelected(new Set());
  await fetchInvoices();
}, [movePreview, moveRunner, fetchInvoices]);
```

- [ ] **Step 4: Eliminar el estado `unknown` y su maquinaria**

Borrar de `page.tsx`:
- Los `useState`: `moving`, `moveResult`, `pendingMoves`, `pendingItems` (líneas ~80-85).
- El tipo `MoveSummary` (línea 33) si queda sin uso.
- `invoiceById`, `doneCount`, `stillPendingCount` (líneas ~274-276).
- Del tipo de `moveStep`: dejarlo en `null | "preview"` (se van `"result"` y `"unknown"`).
- Los bloques JSX `{moveStep === "result" && ...}` (líneas ~507-538) y
  `{moveStep === "unknown" && ...}` (líneas ~539-562).

En los botones que leían `moving`, usar `moveRunner.isRunning`. En el `Confirmar` del preview, sumar
la estimación:

```tsx
<button type="button" className={styles.ghostBtn}
  style={{ background: "#2563eb", borderColor: "#2563eb", color: "#fff", opacity: movableCount > 0 ? 1 : 0.5 }}
  disabled={movableCount === 0} onClick={() => void confirmMove()}>
  Confirmar ({movableCount}) · {estimateRunLabel(movableCount)}
</button>
```

- [ ] **Step 5: Apuntar el modal al runner correcto**

El modal de progreso ahora sirve a las dos acciones. Reemplazar el bloque agregado en la Task 5 por:

```tsx
{batchTitle && (() => {
  const runner = batchTitle.startsWith("Borrando") ? deleteRunner : moveRunner;
  return (
    <BatchProgressModal
      title={batchTitle}
      items={runner.items}
      summary={runner.summary}
      isRunning={runner.isRunning}
      etaMs={runner.etaMs}
      onCancel={runner.cancel}
      onRetryFailed={() => void runner.retryFailed()}
      onClose={() => { setBatchTitle(null); runner.reset(); void fetchInvoices(); }}
    />
  );
})()}
```

- [ ] **Step 6: Verificar la suite completa**

```bash
npx vitest run
```

Esperado: PASS, **490 tests**.

```bash
npm run typecheck
```

```bash
npm run lint
```

Esperado: 0 errores (el único warning de baseline conocido del repo es `uploadingReceiptId` en
`consortiums/page.tsx`, ajeno a este trabajo). **No commitear.**

---

## Task 7: Verificación final y documentación

**Files:**
- Modify: `docs/progreso.md`
- Modify: `docs/decisiones.md`
- Modify: `CHANGELOG.md`

La regla de documentación del proyecto (ver `CLAUDE.md`) es obligatoria: sin estos tres archivos
actualizados, el trabajo no está terminado.

- [ ] **Step 1: Correr la verificación completa**

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npx vitest run
```

```bash
npm run build
```

```bash
npm run build:jobs
```

Esperado: los cinco en verde. `npm run build` es el que detecta errores de CSS Modules impuros — no
aplica acá porque este trabajo usa estilos inline, pero se corre igual.

- [ ] **Step 2: Contar las líneas de `page.tsx`**

```bash
npx wc -l src/app/admin/boletas/page.tsx
```

Esperado: menos de 568 (se sumaron ~60 líneas de cableado y se restaron ~110 entre el estado
`unknown`, `runMove` y los guards de tope).

- [ ] **Step 3: Escribir la entrada de `docs/decisiones.md`**

Agregar arriba de todo, con fecha **2026-08-06**, cubriendo: el problema (tope de 10 + cero feedback),
la decisión (`RUN_CHUNK = 5` con la aritmética de la §3.1 del spec), las alternativas descartadas
(tanda de 1 por +70%; cola persistida en `ProcessingJob` por requerir migración) y el impacto
(archivos nuevos, eliminación del estado `unknown`, backend intacto).

- [ ] **Step 4: Escribir la entrada de `docs/progreso.md`**

Agregar la sección nueva arriba de todo con el estado verificado (tests, typecheck, lint, builds),
que **no requiere migración**, y el pendiente del owner: smoke visual post-deploy — seleccionar >10
boletas y borrarlas viendo avanzar la barra; probar Cancelar a mitad; forzar una fallida (borrar una
boleta con pagos registrados) y usar Reintentar fallidas.

- [ ] **Step 5: Escribir la entrada de `CHANGELOG.md`**

En `## [Unreleased]`, agregar bajo `### Added`:

```markdown
- **Barra de progreso en tiempo real para las acciones masivas de Boletas entrantes (2026-08-06)**.
  "Borrar seleccionadas" y "Mover al período siguiente" dejan de estar limitadas a 10 boletas por
  tanda: ahora aceptan cualquier cantidad y el frontend las parte en tandas automáticas de
  `RUN_CHUNK = 5`, mostrando un modal con barra de progreso, contador, tiempo restante estimado por
  promedio medido en vivo, y la lista de boletas con su estado real (pendiente / en curso / hecha /
  salteada / fallida). Un fallo no corta la corrida: se marca en rojo y al terminar hay botón
  **Reintentar fallidas** (seguro — los endpoints ya eran idempotentes). Botón **Cancelar** que frena
  antes de la tanda siguiente. Piezas nuevas: `boletas/lib/batchProgress` + `boletas/lib/batchAdapters`
  (tier 0), `boletas/hooks/useBatchRunner` (tier 1), `boletas/components/BatchProgressModal` (tier 2).
  +34 tests (456 → 490). **Sin migración y sin cambios de backend** — los `.max(10)` de los endpoints
  siguen vigentes y se les mandan 5. Ver `docs/decisiones.md` (2026-08-06).
```

Y bajo `### Removed`:

```markdown
- **Estado `unknown` del modal de mover boletas (2026-08-06)**. Existía sólo para sobrevivir al
  timeout 524 del túnel con lotes de 10 (~85 s contra un techo de 100 s). Con tandas de 5 cada
  request dura ~46 s y, sobre todo, el manejo de error por boleta lo cubre mejor: una tanda sin
  respuesta interpretable marca esas 5 en rojo con "resultado no confirmado" y el botón Reintentar
  las reconcilia. Se fueron `pendingMoves`, `pendingItems`, `doneCount`, `stillPendingCount` y el
  paso `moveStep === "unknown"`.
```

- [ ] **Step 6: Avisar al owner**

Informar: "listo para commitear", con el resumen de archivos tocados y el pendiente de smoke visual.
**No preparar staging ni sugerir mensaje de commit** — el owner usa GitLens.

---

## Notas de riesgo para el implementador

1. **`retryFailed` y las closures.** Es la parte más delicada del hook. Si el snapshot de `items`
   sale vacío, pasar a un `itemsRef` paralelo (indicado en la Task 3, Step 4).
2. **`moveTargets` en las dependencias de `runChunk`.** El `useCallback` del `moveRunner` depende de
   `moveTargets`; se setea **antes** de llamar a `start()`, pero React puede no haber re-renderizado
   todavía. Si en la prueba manual las boletas salen todas salteadas por `targetPeriodId` vacío,
   mover `moveTargets` a un `useRef` y leerlo desde ahí.
3. **No tocar el backend.** Los tres `.max(10)` de los endpoints siguen vigentes y se les mandan 5.
   Si algún test o el typecheck empuja a modificarlos, es señal de que algo se desvió del plan.
4. **Verificar antes de afirmar.** No declarar ninguna tarea terminada sin haber corrido el comando
   y visto la salida.
