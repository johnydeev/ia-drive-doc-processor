import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LabelEditor, type Labels } from "./LabelEditor";

const rubros = [
  { id: "r3", order: 3, name: "SERVICIOS PÚBLICOS" },
  { id: "r4", order: 4, name: "ABONOS DE SERVICIOS" },
];
const coefColumns = [{ id: "cA", code: "A" }, { id: "cB", code: "B" }];

function setup(value: Labels = { rubroId: "r3", coeficienteId: "cA" }, onSave = vi.fn()) {
  render(<LabelEditor rubros={rubros} coefColumns={coefColumns} value={value} concepto="EDESUR" onSave={onSave} />);
  return onSave;
}

describe("LabelEditor", () => {
  it("cargado muestra número de rubro y código de coeficiente", () => {
    setup();
    expect(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i })).toHaveTextContent("3 · A");
  });

  it("vacío muestra 'Rubro · Coef'", () => {
    setup({ rubroId: null, coeficienteId: null });
    expect(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i })).toHaveTextContent("Rubro · Coef");
  });

  it("al editar ofrece sólo lo del edificio y guarda lo elegido", async () => {
    const onSave = setup();
    await userEvent.click(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i }));
    const rubroSelect = screen.getByLabelText("Rubro de EDESUR");
    const coefSelect = screen.getByLabelText("Coeficiente de EDESUR");
    expect(within(rubroSelect).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual([
      "",
      "r3",
      "r4",
    ]);
    expect(within(coefSelect).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual([
      "",
      "cA",
      "cB",
    ]);
    await userEvent.selectOptions(rubroSelect, "r4");
    await userEvent.selectOptions(coefSelect, "cB");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSave).toHaveBeenCalledWith({ rubroId: "r4", coeficienteId: "cB" });
  });

  it("elegir 'Sin rubro' manda null", async () => {
    const onSave = setup();
    await userEvent.click(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i }));
    await userEvent.selectOptions(screen.getByLabelText("Rubro de EDESUR"), "");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSave).toHaveBeenCalledWith({ rubroId: null, coeficienteId: "cA" });
  });

  it("cancelar no guarda", async () => {
    const onSave = setup();
    await userEvent.click(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i })).toBeInTheDocument();
  });

  it("mientras guarda, el botón se deshabilita y muestra 'Guardando…'", async () => {
    let resolve!: () => void;
    setup(undefined, vi.fn(() => new Promise<void>((r) => { resolve = r; })));
    await userEvent.click(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i }));
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    const btn = screen.getByRole("button", { name: "Guardando…" });
    expect(btn).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    await act(async () => resolve());
    expect(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i })).toBeInTheDocument();
  });
});
