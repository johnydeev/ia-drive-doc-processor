import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ViewPaymentsModal } from "./ViewPaymentsModal";
import type { Invoice, PaymentRecord } from "../lib/types";

const inv = { id: "i1", provider: "EDESUR", boletaNumber: "0001", amount: 1000 } as Invoice;
const pago: PaymentRecord = {
  id: "p1", amount: 500, paymentDate: "2026-07-01T00:00:00.000Z", installmentNumber: 1,
  totalInstallments: 2, paymentType: "CUOTA", paymentMethod: "Transferencia", driveFileUrl: null, observation: null,
};

describe("ViewPaymentsModal", () => {
  it("lista los pagos", () => {
    render(<ViewPaymentsModal invoice={inv} list={[pago]} loading={false} onClose={vi.fn()} />);
    expect(screen.getByText("Historial de pagos")).toBeInTheDocument();
    expect(screen.getByText("Cuota 1/2")).toBeInTheDocument();
  });
  it("empty-state cuando no hay pagos", () => {
    render(<ViewPaymentsModal invoice={inv} list={[]} loading={false} onClose={vi.fn()} />);
    expect(screen.getByText("Esta boleta no tiene pagos registrados.")).toBeInTheDocument();
  });
  it("Cerrar dispara onClose", async () => {
    const onClose = vi.fn();
    render(<ViewPaymentsModal invoice={inv} list={[]} loading={false} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /Cerrar/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
