import { describe, it, expect } from "vitest";
import { AiCircuitBreaker } from "@/lib/aiCircuitBreaker";

const COOLDOWN = 30 * 60 * 1000;

/**
 * Reloj controlable. El spec del 2026-08-24 había descartado meter tiempo en el
 * estado justamente por el test que depende del reloj; acá el reloj se inyecta,
 * así que el test no espera tiempo real.
 */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("AiCircuitBreaker", () => {
  it("arranca cerrado", () => {
    const breaker = new AiCircuitBreaker(fakeClock().now, COOLDOWN);
    expect(breaker.isOpen("client-1")).toBe(false);
    expect(breaker.reasonFor("client-1")).toBeNull();
  });

  it("queda abierto despues de trip", () => {
    const breaker = new AiCircuitBreaker(fakeClock().now, COOLDOWN);
    breaker.trip("client-1", "todos los proveedores caidos");
    expect(breaker.isOpen("client-1")).toBe(true);
  });

  it("conserva el motivo mientras esta abierto", () => {
    const breaker = new AiCircuitBreaker(fakeClock().now, COOLDOWN);
    breaker.trip("client-1", "todos los proveedores caidos");
    expect(breaker.reasonFor("client-1")).toBe("todos los proveedores caidos");
  });

  it("es por cliente: abrir uno no afecta al otro", () => {
    const breaker = new AiCircuitBreaker(fakeClock().now, COOLDOWN);
    breaker.trip("client-1", "caida");
    expect(breaker.isOpen("client-1")).toBe(true);
    expect(breaker.isOpen("client-2")).toBe(false);
  });

  it("sigue abierto justo antes de que venza el cooldown", () => {
    const clock = fakeClock();
    const breaker = new AiCircuitBreaker(clock.now, COOLDOWN);
    breaker.trip("client-1", "caida");
    clock.advance(COOLDOWN - 1);
    expect(breaker.isOpen("client-1")).toBe(true);
  });

  it("se cierra solo al vencer el cooldown", () => {
    const clock = fakeClock();
    const breaker = new AiCircuitBreaker(clock.now, COOLDOWN);
    breaker.trip("client-1", "caida");
    clock.advance(COOLDOWN);
    expect(breaker.isOpen("client-1")).toBe(false);
    expect(breaker.reasonFor("client-1")).toBeNull();
  });

  it("un trip nuevo extiende el cooldown desde ese momento", () => {
    const clock = fakeClock();
    const breaker = new AiCircuitBreaker(clock.now, 1000);
    breaker.trip("client-1", "primera");
    clock.advance(900);
    breaker.trip("client-1", "segunda");
    // 1100 ms desde el primer trip, pero solo 200 desde el segundo.
    clock.advance(200);
    expect(breaker.isOpen("client-1")).toBe(true);
    expect(breaker.reasonFor("client-1")).toBe("segunda");
  });

  it("usa 30 minutos por defecto", () => {
    const clock = fakeClock();
    const breaker = new AiCircuitBreaker(clock.now);
    breaker.trip("client-1", "caida");
    clock.advance(30 * 60 * 1000 - 1);
    expect(breaker.isOpen("client-1")).toBe(true);
    clock.advance(1);
    expect(breaker.isOpen("client-1")).toBe(false);
  });
});
