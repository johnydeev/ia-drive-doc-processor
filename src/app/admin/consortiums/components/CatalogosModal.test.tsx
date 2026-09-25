import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CatalogosModal } from "./CatalogosModal";

function setup(overrides: Partial<React.ComponentProps<typeof CatalogosModal>> = {}) {
  const props: React.ComponentProps<typeof CatalogosModal> = {
    rubros: [
      { id: "r3", name: "SERVICIOS PÚBLICOS", order: 3 },
      { id: "rz", name: "SIN NUMERO", order: null },
    ],
    coeficientes: [{ id: "cA", code: "A", name: "GASTO A", value: null }],
    rubroForm: { name: "", order: "" },
    coeficienteForm: { code: "", name: "" },
    error: null,
    confirmDeleteRubroId: null,
    confirmDeleteCoefId: null,
    editingRubroId: null,
    editingCoefId: null,
    onChangeRubroForm: vi.fn(),
    onChangeCoeficienteForm: vi.fn(),
    onCreateRubro: vi.fn(),
    onCreateCoeficiente: vi.fn(),
    onUpdateRubro: vi.fn(),
    onUpdateCoeficiente: vi.fn(),
    onEditRubro: vi.fn(),
    onEditCoef: vi.fn(),
    onRemoveRubro: vi.fn(),
    onRemoveCoeficiente: vi.fn(),
    onConfirmDeleteRubro: vi.fn(),
    onConfirmDeleteCoef: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<CatalogosModal {...props} />);
  return props;
}

describe("CatalogosModal", () => {
  it("muestra el número del rubro delante del nombre", () => {
    setup();
    const fila = screen.getByText("SERVICIOS PÚBLICOS").closest("tr")!;
    expect(within(fila).getByText("3")).toBeInTheDocument();
  });

  // El número sale del catálogo: si no tiene, la celda va vacía. Un edificio sin
  // empleado propio arranca en el 2 y nadie renumera nada.
  it("un rubro sin número no inventa uno", () => {
    setup();
    const fila = screen.getByText("SIN NUMERO").closest("tr")!;
    expect(fila.textContent).not.toMatch(/\d/);
  });

  it("lista los coeficientes por código y nombre", () => {
    setup();
    const fila = screen.getByText("GASTO A").closest("tr")!;
    expect(within(fila).getByText("A")).toBeInTheDocument();
  });

  it("el alta de rubro pide nombre y número", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: "Agregar rubro" }));
    expect(props.onCreateRubro).toHaveBeenCalled();
  });

  it("borrar un rubro pide confirmación antes de llamar", async () => {
    const props = setup();
    const fila = screen.getByText("SERVICIOS PÚBLICOS").closest("tr")!;
    await userEvent.click(within(fila).getByRole("button", { name: "Eliminar" }));
    expect(props.onConfirmDeleteRubro).toHaveBeenCalledWith("r3");
    expect(props.onRemoveRubro).not.toHaveBeenCalled();
  });

  it("con la confirmación abierta, el sí borra", async () => {
    cleanup();
    const props = setup({ confirmDeleteRubroId: "r3" });
    const fila = screen.getByText("SERVICIOS PÚBLICOS").closest("tr")!;
    await userEvent.click(within(fila).getByRole("button", { name: "Sí" }));
    expect(props.onRemoveRubro).toHaveBeenCalledWith("r3");
  });

  it("muestra el error del catálogo", () => {
    cleanup();
    setup({ error: "Ya existe un rubro con ese nombre" });
    expect(screen.getByText("Ya existe un rubro con ese nombre")).toBeInTheDocument();
  });
});

// El número del rubro es el eje vertical de la liquidación: si no se puede
// corregir desde la UI, un error de carga queda clavado.
describe("CatalogosModal — edición", () => {
  it("editar un rubro abre la fila con su número y su nombre", async () => {
    cleanup();
    const props = setup();
    const fila = screen.getByText("SERVICIOS PÚBLICOS").closest("tr")!;
    await userEvent.click(within(fila).getByRole("button", { name: "Editar" }));
    expect(props.onEditRubro).toHaveBeenCalledWith("r3");
  });

  it("en edición, guardar manda el borrador", async () => {
    cleanup();
    const props = setup({ editingRubroId: "r3" });
    const input = screen.getByLabelText("Número del rubro");
    await userEvent.clear(input);
    await userEvent.type(input, "4");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(props.onUpdateRubro).toHaveBeenCalledWith("r3", { name: "SERVICIOS PÚBLICOS", order: "4" });
  });

  it("cancelar no guarda nada", async () => {
    cleanup();
    const props = setup({ editingRubroId: "r3" });
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(props.onEditRubro).toHaveBeenCalledWith(null);
    expect(props.onUpdateRubro).not.toHaveBeenCalled();
  });

  it("un rubro sin número entra en edición con el campo vacío", async () => {
    cleanup();
    setup({ editingRubroId: "rz" });
    expect(screen.getByLabelText("Número del rubro")).toHaveValue("");
  });

  it("el coeficiente también se edita", async () => {
    cleanup();
    const props = setup({ editingCoefId: "cA" });
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(props.onUpdateCoeficiente).toHaveBeenCalledWith("cA", { code: "A", name: "GASTO A" });
  });
});
