import { describe, expect, it } from "vitest";
import { AiRequestCounter } from "./aiRequestCounter";

describe("AiRequestCounter", () => {
  it("arranca vacío", () => {
    const c = new AiRequestCounter();
    expect(c.total()).toBe(0);
    expect(c.snapshot()).toEqual({});
  });

  it("cuenta por provider:model", () => {
    const c = new AiRequestCounter();
    c.record("gemini", "gemini-2.5-flash-lite");
    c.record("gemini", "gemini-2.5-flash-lite");
    c.record("gemini", "gemini-2.5-flash");
    expect(c.total()).toBe(3);
    expect(c.snapshot()).toEqual({
      "gemini:gemini-2.5-flash-lite": 2,
      "gemini:gemini-2.5-flash": 1,
    });
  });

  it("separa proveedores distintos", () => {
    const c = new AiRequestCounter();
    c.record("gemini", "gemini-2.5-flash-lite");
    c.record("cerebras", "gpt-oss-120b");
    expect(c.total()).toBe(2);
    expect(c.snapshot()["cerebras:gpt-oss-120b"]).toBe(1);
  });

  it("usa 'unknown' cuando no hay modelo", () => {
    const c = new AiRequestCounter();
    c.record("openai", "");
    expect(c.snapshot()).toEqual({ "openai:unknown": 1 });
  });

  it("snapshot devuelve una copia, no la referencia interna", () => {
    const c = new AiRequestCounter();
    c.record("gemini", "x");
    const snap = c.snapshot();
    snap["gemini:x"] = 99;
    expect(c.snapshot()["gemini:x"]).toBe(1);
  });
});
