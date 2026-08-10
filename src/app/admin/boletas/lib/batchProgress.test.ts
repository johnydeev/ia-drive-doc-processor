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
