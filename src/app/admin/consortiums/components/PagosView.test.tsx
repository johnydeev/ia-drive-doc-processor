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
  it("sin boletas: muestra el empty-state", () => {
    render(<PagosView invoices={[]} {...noop} />);
    expect(screen.getByText("No hay boletas para este período.")).toBeInTheDocument();
  });
});
