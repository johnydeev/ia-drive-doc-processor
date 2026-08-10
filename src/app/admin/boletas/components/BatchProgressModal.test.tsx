import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BatchProgressModal } from "./BatchProgressModal";
import type { BatchItem } from "../lib/batchProgress";
import { summarizeBatch } from "../lib/batchProgress";

const items: BatchItem[] = [
  { id: "i1", label: "ARENALES 2154", status: "done" },
  { id: "i2", label: "THAMES 647", status: "running" },
  { id: "i3", label: "CASTILLO 246", status: "pending" },
  { id: "i4", label: "MITRE 1225", status: "skipped", message: "ya estaba en el período destino" },
  { id: "i5", label: "SAN ANTONIO 345", status: "failed", message: "Drive timeout", needsReview: true },
];

function renderModal(overrides: Partial<React.ComponentProps<typeof BatchProgressModal>> = {}) {
  const props = {
    title: "Borrando boletas",
    items,
    summary: summarizeBatch(items),
    isRunning: true,
    etaMs: 120_000,
    onCancel: vi.fn(),
    onRetryFailed: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<BatchProgressModal {...props} />);
  return props;
}

describe("BatchProgressModal", () => {
  it("muestra el título, el contador y el ETA mientras corre", () => {
    renderModal();
    expect(screen.getByText("Borrando boletas")).toBeInTheDocument();
    expect(screen.getByText(/3 de 5/)).toBeInTheDocument();
    expect(screen.getByText(/≈ 2 min/)).toBeInTheDocument();
  });

  it("lista cada boleta con su etiqueta y el motivo cuando lo hay", () => {
    renderModal();
    expect(screen.getByText("ARENALES 2154")).toBeInTheDocument();
    expect(screen.getByText(/ya estaba en el período destino/)).toBeInTheDocument();
    expect(screen.getByText(/Drive timeout/)).toBeInTheDocument();
  });

  it("destaca la boleta que necesita revisión manual", () => {
    renderModal();
    expect(screen.getByText(/revisar manualmente/i)).toBeInTheDocument();
  });

  it("mientras corre ofrece Cancelar y no Cerrar", async () => {
    const props = renderModal();
    await userEvent.click(screen.getByRole("button", { name: /Cancelar/ }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^Cerrar$/ })).not.toBeInTheDocument();
  });

  it("al terminar ofrece Reintentar fallidas y Cerrar", async () => {
    const props = renderModal({ isRunning: false, etaMs: null });
    await userEvent.click(screen.getByRole("button", { name: /Reintentar fallidas/ }));
    expect(props.onRetryFailed).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: /^Cerrar$/ }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("sin fallidas no ofrece reintentar", () => {
    const allDone: BatchItem[] = [{ id: "i1", label: "ARENALES 2154", status: "done" }];
    renderModal({ items: allDone, summary: summarizeBatch(allDone), isRunning: false });
    expect(screen.queryByRole("button", { name: /Reintentar fallidas/ })).not.toBeInTheDocument();
  });
});
