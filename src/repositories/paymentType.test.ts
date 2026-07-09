import { describe, it, expect } from "vitest";
import { PaymentType } from "@prisma/client";
import { resolvePaymentType } from "./payment.repository";

describe("resolvePaymentType", () => {
  it("con cuotas siempre es CUOTA (ignora el intento del caller)", () => {
    expect(
      resolvePaymentType({
        hasInstallments: true,
        requested: "TOTAL",
        isPaid: false,
        isFirstPayment: true,
      })
    ).toBe(PaymentType.CUOTA);
  });

  it("inline pidiendo TOTAL que salda la boleta → TOTAL", () => {
    expect(
      resolvePaymentType({
        hasInstallments: false,
        requested: "TOTAL",
        isPaid: true,
        isFirstPayment: true,
      })
    ).toBe(PaymentType.TOTAL);
  });

  it("modal pidiendo LIBRE (parcial) → LIBRE", () => {
    expect(
      resolvePaymentType({
        hasInstallments: false,
        requested: "LIBRE",
        isPaid: false,
        isFirstPayment: true,
      })
    ).toBe(PaymentType.LIBRE);
  });

  it("salvaguarda: TOTAL que NO saldó (dejó saldo) se degrada a LIBRE", () => {
    expect(
      resolvePaymentType({
        hasInstallments: false,
        requested: "TOTAL",
        isPaid: false,
        isFirstPayment: true,
      })
    ).toBe(PaymentType.LIBRE);
  });

  it("sin intento explícito: primer pago que salda todo → TOTAL", () => {
    expect(
      resolvePaymentType({
        hasInstallments: false,
        isPaid: true,
        isFirstPayment: true,
      })
    ).toBe(PaymentType.TOTAL);
  });

  it("sin intento explícito: pago que deja saldo → LIBRE", () => {
    expect(
      resolvePaymentType({
        hasInstallments: false,
        isPaid: false,
        isFirstPayment: true,
      })
    ).toBe(PaymentType.LIBRE);
  });

  it("un TOTAL que cierra el saldo tras un parcial previo sigue siendo TOTAL", () => {
    // isFirstPayment=false pero el caller (inline) pidió TOTAL y saldó → respeta el intento
    expect(
      resolvePaymentType({
        hasInstallments: false,
        requested: "TOTAL",
        isPaid: true,
        isFirstPayment: false,
      })
    ).toBe(PaymentType.TOTAL);
  });
});
