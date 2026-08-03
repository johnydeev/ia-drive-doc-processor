import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BanksModal } from "./BanksModal";
import type { Bank } from "../lib/types";

const banks: Bank[] = [
  { id: "b1", name: "Santander", color: "red", _count: { consortiums: 2 } },
  { id: "b2", name: "Galicia", color: "amber", _count: { consortiums: 0 } },
];

function setup(overrides: Partial<ComponentProps<typeof BanksModal>> = {}) {
  const props: ComponentProps<typeof BanksModal> = {
    banks,
    form: { name: "", color: "slate" },
    error: null,
    confirmDeleteId: null,
    editingId: null,
    onChangeForm: vi.fn(),
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onConfirmDelete: vi.fn(),
    onEdit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<BanksModal {...props} />);
  return props;
}

describe("BanksModal", () => {
  it("lista los bancos con su contador de edificios", () => {
    setup();
    expect(screen.getByText("Santander")).toBeInTheDocument();
    expect(screen.getByText("Galicia")).toBeInTheDocument();
    expect(screen.getByText("2 edificios")).toBeInTheDocument();
    expect(screen.getByText("Sin edificios")).toBeInTheDocument();
  });

  it("dispara onCreate al agregar", async () => {
    const props = setup({ form: { name: "BBVA", color: "sky" } });
    await userEvent.click(screen.getByRole("button", { name: /agregar/i }));
    expect(props.onCreate).toHaveBeenCalled();
  });

  it("pide confirmación antes de borrar", async () => {
    const props = setup();
    await userEvent.click(screen.getAllByRole("button", { name: /eliminar/i })[0]);
    expect(props.onConfirmDelete).toHaveBeenCalledWith("b1");
  });

  it("avisa cuántos edificios quedan sin banco al confirmar el borrado", () => {
    setup({ confirmDeleteId: "b1" });
    expect(screen.getByText(/2 edificios quedarán sin banco/i)).toBeInTheDocument();
  });

  it("muestra el error", () => {
    setup({ error: "Ya existe un banco con ese nombre" });
    expect(screen.getByText("Ya existe un banco con ese nombre")).toBeInTheDocument();
  });

  it("al editar muestra los campos de la fila y guarda con onUpdate", async () => {
    const props = setup({ editingId: "b1" });
    const input = screen.getByDisplayValue("Santander");
    await userEvent.clear(input);
    await userEvent.type(input, "Santander Río");
    await userEvent.click(screen.getByRole("button", { name: /^guardar$/i }));
    expect(props.onUpdate).toHaveBeenCalledWith("b1", { name: "Santander Río", color: "red" });
  });

  it("dispara onEdit al tocar Editar", async () => {
    const props = setup();
    await userEvent.click(screen.getAllByRole("button", { name: /editar/i })[0]);
    expect(props.onEdit).toHaveBeenCalledWith("b1");
  });
});
