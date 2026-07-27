import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InvoiceModal } from "./InvoiceModal";
import { EMPTY_INVOICE_FORM } from "../lib/constants";
import type { Provider } from "../lib/types";

const providers: Provider[] = [{ id: "pr1", canonicalName: "EDESUR", cuit: "30-65511651-2", paymentAlias: null }];

function setup(overrides: Partial<React.ComponentProps<typeof InvoiceModal>> = {}) {
  const props: React.ComponentProps<typeof InvoiceModal> = {
    consortiumName: "THAMES 647",
    periodLabel: "Julio 2026",
    scanning: false,
    scanFile: null,
    scanWarning: null,
    matchedProvider: null,
    form: EMPTY_INVOICE_FORM,
    setField: vi.fn(),
    providers,
    coeficientes: [],
    rubros: [],
    error: null,
    saving: false,
    fileInputRef: createRef<HTMLInputElement>(),
    onFileChange: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
  render(<InvoiceModal {...props} />);
  return props;
}

describe("InvoiceModal", () => {
  it("muestra consorcio, período y el proveedor en el select", () => {
    setup();
    expect(screen.getByText("THAMES 647")).toBeInTheDocument();
    expect(screen.getByText("Julio 2026")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /EDESUR/ })).toBeInTheDocument();
  });
  it("click en 'Guardar boleta' dispara onSubmit", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Guardar boleta/ }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
  it("saving deshabilita el submit y muestra 'Guardando...'", () => {
    setup({ saving: true });
    expect(screen.getByRole("button", { name: /Guardando/ })).toBeDisabled();
  });
});
