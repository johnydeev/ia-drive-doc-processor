import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddFixedExpenseModal } from "./AddFixedExpenseModal";
import type { OverviewConsortium } from "../lib/sheetModel";

const consortium: OverviewConsortium = {
  consortiumId: "c1",
  consortiumName: "FRANKLIN 25",
  bankId: null, bankName: null, bankColor: null,
  periodId: "per1", periodLabel: "julio 2026",
  lspServices: [
    { id: "l1", providerName: "AYSA", clientNumber: "66757", description: null, providerId: null },
  ],
  fixedExpenses: [],
};

const providers = [
  { id: "p1", canonicalName: "SEGURO LA CAJA", paymentAlias: null },
  { id: "p2", canonicalName: "TECNOPAS ASC.", paymentAlias: null },
];

function renderModal(overrides: Partial<React.ComponentProps<typeof AddFixedExpenseModal>> = {}) {
  const props = {
    consortium,
    providers,
    onAdd: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<AddFixedExpenseModal {...props} />);
  return props;
}

describe("AddFixedExpenseModal", () => {
  it("lista servicios y proveedores disponibles", () => {
    renderModal();
    expect(screen.getByText("FRANKLIN 25")).toBeInTheDocument();
    expect(screen.getByLabelText("AYSA (66757)")).toBeInTheDocument();
    expect(screen.getByLabelText("SEGURO LA CAJA")).toBeInTheDocument();
  });

  it("el botón arranca deshabilitado y cuenta la selección", async () => {
    renderModal();
    expect(screen.getByRole("button", { name: /Agregar/ })).toBeDisabled();

    await userEvent.click(screen.getByLabelText("SEGURO LA CAJA"));
    await userEvent.click(screen.getByLabelText("AYSA (66757)"));

    expect(screen.getByRole("button", { name: "Agregar (2)" })).toBeEnabled();
  });

  it("manda la selección y cierra", async () => {
    const props = renderModal();
    await userEvent.click(screen.getByLabelText("TECNOPAS ASC."));
    await userEvent.click(screen.getByRole("button", { name: "Agregar (1)" }));

    expect(props.onAdd).toHaveBeenCalledWith("c1", [
      { kind: "provider", id: "p2", label: "TECNOPAS ASC." },
    ]);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("el buscador recorta las opciones", async () => {
    renderModal();
    await userEvent.type(screen.getByPlaceholderText(/Buscar/), "aysa");
    expect(screen.getByLabelText("AYSA (66757)")).toBeInTheDocument();
    expect(screen.queryByLabelText("SEGURO LA CAJA")).not.toBeInTheDocument();
  });

  it("sin nada disponible avisa", () => {
    renderModal({
      consortium: {
        ...consortium,
        fixedExpenses: [
          { id: "a", providerId: "p1", lspServiceId: null, description: null, active: true, obligation: null },
          { id: "b", providerId: "p2", lspServiceId: null, description: null, active: true, obligation: null },
          { id: "c", providerId: null, lspServiceId: "l1", description: null, active: true, obligation: null },
        ],
      },
    });
    expect(screen.getByText(/Ya están cargados todos/i)).toBeInTheDocument();
  });
});
