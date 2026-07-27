import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PayModal } from "./PayModal";
import type { Invoice } from "../lib/types";

const inv = { id: "i1", provider: "EDESUR", boletaNumber: "0001", amount: 1000, remainingBalance: 1000, isPaid: false } as Invoice;

function setup(overrides: Partial<React.ComponentProps<typeof PayModal>> = {}) {
  const props: React.ComponentProps<typeof PayModal> = {
    invoice: inv,
    loadingExisting: false,
    isFirstPayment: true,
    activeMode: null,
    mode: "libre",
    installmentsLocked: null,
    currentInstallmentNumber: null,
    isLastInstallment: false,
    existingPaymentsCount: 0,
    computedAmount: 0,
    form: { amount: "1000", paymentDate: "2026-07-16", totalInstallments: "", paymentMethod: "", observation: "" },
    onFieldChange: vi.fn(),
    onModeChange: vi.fn(),
    file: null,
    onFileChange: vi.fn(),
    error: null,
    saving: false,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
  render(<PayModal {...props} />);
  return props;
}

describe("PayModal", () => {
  it("primer pago: muestra el toggle de modo", () => {
    setup();
    expect(screen.getByRole("button", { name: /Pago libre/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cuotas fijas/ })).toBeInTheDocument();
  });
  it("click en 'Cuotas fijas' dispara onModeChange", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Cuotas fijas/ }));
    expect(props.onModeChange).toHaveBeenCalledWith("cuotas");
  });
  it("Registrar pago dispara onSubmit", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Registrar pago/ }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
  it("muestra el error", () => {
    setup({ error: "Faltan campos" });
    expect(screen.getByText("Faltan campos")).toBeInTheDocument();
  });
  it("saving deshabilita el submit y muestra 'Guardando...'", () => {
    setup({ saving: true });
    expect(screen.getByRole("button", { name: /Guardando/ })).toBeDisabled();
  });
});
