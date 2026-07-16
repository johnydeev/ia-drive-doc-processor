import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConsortiumFormModal } from "./ConsortiumFormModal";

function setup(overrides: Partial<React.ComponentProps<typeof ConsortiumFormModal>> = {}) {
  const props = {
    form: { canonicalName: "", cuit: "" },
    onChange: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    saving: false,
    error: null as string | null,
    success: null as string | null,
    ...overrides,
  };
  render(<ConsortiumFormModal {...props} />);
  return props;
}

describe("ConsortiumFormModal", () => {
  it("escribir el nombre dispara onChange con el patch", async () => {
    const props = setup();
    await userEvent.type(screen.getByPlaceholderText(/Consorcio Av/), "T");
    expect(props.onChange).toHaveBeenCalledWith({ canonicalName: "T" });
  });
  it("click en 'Crear consorcio' dispara onSubmit", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Crear consorcio/ }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
  it("muestra el mensaje de error", () => {
    setup({ error: "algo falló" });
    expect(screen.getByText("algo falló")).toBeInTheDocument();
  });
  it("saving deshabilita el submit y muestra 'Creando...'", () => {
    setup({ saving: true });
    expect(screen.getByRole("button", { name: /Creando/ })).toBeDisabled();
  });
});
