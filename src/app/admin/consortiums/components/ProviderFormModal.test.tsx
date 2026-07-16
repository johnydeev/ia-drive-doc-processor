import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderFormModal } from "./ProviderFormModal";

function setup(overrides: Partial<React.ComponentProps<typeof ProviderFormModal>> = {}) {
  const props = {
    form: { canonicalName: "", cuit: "", paymentAlias: "" },
    onChange: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    saving: false,
    error: null as string | null,
    success: null as string | null,
    ...overrides,
  };
  render(<ProviderFormModal {...props} />);
  return props;
}

describe("ProviderFormModal", () => {
  it("escribir el CUIT dispara onChange con el patch", async () => {
    const props = setup();
    await userEvent.type(screen.getByPlaceholderText("20-12345678-9"), "2");
    expect(props.onChange).toHaveBeenCalledWith({ cuit: "2" });
  });
  it("click en 'Crear proveedor' dispara onSubmit", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Crear proveedor/ }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
  it("saving deshabilita el submit y muestra 'Guardando...'", () => {
    setup({ saving: true });
    expect(screen.getByRole("button", { name: /Guardando/ })).toBeDisabled();
  });
});
