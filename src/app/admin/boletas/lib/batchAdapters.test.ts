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
