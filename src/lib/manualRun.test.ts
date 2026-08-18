import { describe, it, expect } from "vitest";
import {
  buildManualRunList,
  validateSelection,
  MAX_MANUAL_RUN_FILES,
  type ManualRunFile,
} from "@/lib/manualRun";

const files = [
  { id: "f1", name: "boleta-a.pdf", mimeType: "application/pdf" },
  { id: "f2", name: "boleta-b.pdf", mimeType: "application/pdf" },
  { id: "f3", name: "boleta-c.pdf", mimeType: "application/pdf" },
];

describe("buildManualRunList", () => {
  it("marca las encoladas y las ya cargadas, sin sacarlas de la lista", () => {
    const list = buildManualRunList(files, new Set(["f2"]), new Set(["f3"]));

    expect(list).toEqual([
      { id: "f1", name: "boleta-a.pdf", mimeType: "application/pdf", status: "available" },
      { id: "f2", name: "boleta-b.pdf", mimeType: "application/pdf", status: "queued" },
      { id: "f3", name: "boleta-c.pdf", mimeType: "application/pdf", status: "loaded" },
    ]);
  });

  it("una boleta encolada Y cargada se reporta como encolada", () => {
    const [file] = buildManualRunList([files[0]], new Set(["f1"]), new Set(["f1"]));

    expect(file.status).toBe("queued");
  });

  it("sin archivos devuelve lista vacía", () => {
    expect(buildManualRunList([], new Set(), new Set())).toEqual([]);
  });
});

describe("validateSelection", () => {
  const list: ManualRunFile[] = buildManualRunList(files, new Set(["f2"]), new Set(["f3"]));

  it("acepta una selección válida", () => {
    expect(validateSelection(["f1"], list)).toEqual({ ok: true, fileIds: ["f1"] });
  });

  it("deduplica ids repetidos", () => {
    expect(validateSelection(["f1", "f1"], list)).toEqual({ ok: true, fileIds: ["f1"] });
  });

  it("rechaza una selección vacía", () => {
    expect(validateSelection([], list)).toEqual({
      ok: false,
      error: "No se seleccionó ninguna boleta",
    });
  });

  it(`rechaza más de ${MAX_MANUAL_RUN_FILES} boletas`, () => {
    const many = Array.from({ length: MAX_MANUAL_RUN_FILES + 1 }, (_, i) => `id-${i}`);

    expect(validateSelection(many, list)).toEqual({
      ok: false,
      error: `Máximo ${MAX_MANUAL_RUN_FILES} boletas por corrida`,
    });
  });

  it("rechaza la corrida entera si un archivo ya no está en Pendientes", () => {
    const result = validateSelection(["f1", "fantasma"], list);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("refrescá la lista") });
  });

  it("rechaza una boleta que ya está encolada", () => {
    const result = validateSelection(["f2"], list);

    expect(result).toEqual({ ok: false, error: '"boleta-b.pdf" no se puede encolar (queued)' });
  });

  it("rechaza una boleta que ya tiene su Invoice cargada", () => {
    const result = validateSelection(["f3"], list);

    expect(result).toEqual({ ok: false, error: '"boleta-c.pdf" no se puede encolar (loaded)' });
  });
});
