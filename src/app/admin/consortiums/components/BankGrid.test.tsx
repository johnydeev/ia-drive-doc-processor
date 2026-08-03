import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BankGrid } from "./BankGrid";
import { UNASSIGNED_BANK_ID } from "../lib/groupByBank";
import type { BankGroup, Consortium } from "../lib/types";

function consortium(id: string, rawName: string): Consortium {
  return {
    id, canonicalName: rawName, rawName, cuit: null, cutoffDay: 5,
    matchNames: null, statementsFolderUrl: null,
    bankId: null, bank: null,
    bankAlias: null, cbu: null, accountNumber: null,
    branch: null, accountType: null, accountHolder: null,
    periods: [], _count: { invoices: 0 },
    activePeriodInvoiceCount: 0, activePeriodDebt: 0, totalDebt: 0,
  };
}

const groups: BankGroup[] = [
  {
    id: "b1", name: "Santander", color: "red",
    consortiums: [consortium("c1", "ARENALES 2154"), consortium("c2", "THAMES 647")],
  },
  {
    id: UNASSIGNED_BANK_ID, name: "Sin banco", color: "slate",
    consortiums: [consortium("c3", "MITRE 1225")],
  },
];

describe("BankGrid", () => {
  it("renderiza una card por grupo con sus badges", () => {
    render(<BankGrid groups={groups} onSelectBank={vi.fn()} onSelectConsortium={vi.fn()} />);
    expect(screen.getByText("Santander")).toBeInTheDocument();
    expect(screen.getByText("Sin banco")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ARENALES 2154" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "THAMES 647" })).toBeInTheDocument();
  });

  it("muestra la cantidad de edificios de cada grupo", () => {
    render(<BankGrid groups={groups} onSelectBank={vi.fn()} onSelectConsortium={vi.fn()} />);
    expect(screen.getByText("2 edificios")).toBeInTheDocument();
    expect(screen.getByText("1 edificio")).toBeInTheDocument();
  });

  it("al clickear el título del banco entra al nivel de edificios", async () => {
    const onSelectBank = vi.fn();
    render(<BankGrid groups={groups} onSelectBank={onSelectBank} onSelectConsortium={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Santander/ }));
    expect(onSelectBank).toHaveBeenCalledWith("b1");
  });

  it("al clickear un badge entra directo a ese consorcio", async () => {
    const onSelectConsortium = vi.fn();
    render(<BankGrid groups={groups} onSelectBank={vi.fn()} onSelectConsortium={onSelectConsortium} />);
    await userEvent.click(screen.getByRole("button", { name: "THAMES 647" }));
    expect(onSelectConsortium).toHaveBeenCalledWith(groups[0].consortiums[1]);
  });

  it("aplica el color del grupo con data-bank-color", () => {
    const { container } = render(<BankGrid groups={groups} onSelectBank={vi.fn()} onSelectConsortium={vi.fn()} />);
    expect(container.querySelector('[data-bank-color="red"]')).not.toBeNull();
  });

  it("avisa cuando un banco no tiene edificios", () => {
    render(
      <BankGrid
        groups={[{ id: "b2", name: "Galicia", color: "amber", consortiums: [] }]}
        onSelectBank={vi.fn()}
        onSelectConsortium={vi.fn()}
      />
    );
    expect(screen.getByText("Sin edificios asignados")).toBeInTheDocument();
  });
});
