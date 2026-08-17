import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PagosView } from "./PagosView";
import type { Invoice } from "../lib/types";

const baseInvoice = (over: Partial<Invoice>): Invoice => ({
  id: "i1", boletaNumber: "0001", provider: "EDESUR", providerTaxId: "30-65511651-2",
  detail: null, observation: null, issueDate: null, dueDate: null, amount: 1000,
  isDuplicate: false, isManual: false, sourceFileUrl: null, tipoGasto: "ORDINARIO",
  tipoComprobante: null, createdAt: "2026-07-01T00:00:00.000Z", coeficienteRef: null,
  rubroRef: null, isPaid: false, remainingBalance: null, lspServiceId: null, ...over,
});

const noop = { onPagoGuardado: vi.fn(), onPagar: vi.fn(), onVerPagos: vi.fn(), onEliminarUltimoPago: vi.fn() };

describe("PagosView", () => {
  it("con boletas: muestra métricas y la boleta no duplicada", () => {
    render(<PagosView invoices={[baseInvoice({ id: "i1", provider: "EDESUR" })]} {...noop} />);
    expect(screen.getByText("Pagos registrados")).toBeInTheDocument();
    expect(screen.getByText("PROVEEDOR")).toBeInTheDocument();
    expect(screen.getByText("EDESUR")).toBeInTheDocument();
  });
  it("filtra las boletas duplicadas", () => {
    render(<PagosView invoices={[baseInvoice({ id: "i2", provider: "AYSA-DUP", isDuplicate: true })]} {...noop} />);
    expect(screen.queryByText("AYSA-DUP")).not.toBeInTheDocument();
  });
  // SERVICIO es un proveedor común a los fines del pago: se paga parcial y tiene
  // input de monto. Sólo EMPLEADO se paga por el total.
  it("una boleta de un proveedor SERVICIO se paga como proveedor, no como empleado", () => {
    render(
      <PagosView
        invoices={[baseInvoice({ id: "i3", provider: "EDESUR", providerType: "SERVICIO", amount: 1000 })]}
        {...noop}
      />
    );
    expect(screen.getByPlaceholderText("1.000,00")).toBeInTheDocument();
  });

  it("una boleta de un EMPLEADO no ofrece input de monto parcial", () => {
    render(
      <PagosView
        invoices={[baseInvoice({ id: "i4", provider: "JUAN PEREZ", providerType: "EMPLEADO", amount: 1000 })]}
        {...noop}
      />
    );
    expect(screen.queryByPlaceholderText("1.000,00")).not.toBeInTheDocument();
  });

  it("sin boletas: muestra el empty-state", () => {
    render(<PagosView invoices={[]} {...noop} />);
    expect(screen.getByText("No hay boletas para este período.")).toBeInTheDocument();
  });
});
