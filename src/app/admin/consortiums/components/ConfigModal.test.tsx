import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigModal } from "./ConfigModal";
import type { Bank, Provider } from "../lib/types";

const providers: Provider[] = [{ id: "pr1", canonicalName: "EDESUR", cuit: "30-65511651-2", paymentAlias: null }];
const banks: Bank[] = [{ id: "b1", name: "Santander", color: "red" }];

function setup(overrides: Partial<React.ComponentProps<typeof ConfigModal>> = {}) {
  const props: React.ComponentProps<typeof ConfigModal> = {
    consortiumName: "THAMES 647",
    saving: false,
    openSection: null,
    onToggleSection: vi.fn(),
    onClose: vi.fn(),
    providers,
    banks,
    bank: {
      form: {
        bankId: "", bankAlias: "", cbu: "", accountNumber: "",
        branch: "", accountType: "", accountHolder: "",
      },
      msg: null,
      onChangeForm: vi.fn(),
      onSave: vi.fn(),
    },
    matchNames: {
      editing: false, value: "ALT 1", msg: null,
      onChangeValue: vi.fn(), onStartEdit: vi.fn(), onCancelEdit: vi.fn(), onSave: vi.fn(),
    },
    lsp: {
      services: [], form: { provider: "", clientNumber: "", description: "" },
      error: null, confirmDeleteId: null,
      onChangeForm: vi.fn(), onConfirmDelete: vi.fn(), onAdd: vi.fn(), onDelete: vi.fn(),
    },
    fixed: {
      list: [], target: "", error: null,
      onChangeTarget: vi.fn(), onAdd: vi.fn(), onToggle: vi.fn(), onDelete: vi.fn(),
    },
    ...overrides,
  };
  render(<ConfigModal {...props} />);
  return props;
}

describe("ConfigModal", () => {
  it("muestra el consorcio y las 4 secciones del acordeón colapsadas", () => {
    setup();
    expect(screen.getByText(/THAMES 647/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Nombres alternativos/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /Banco y cuenta/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /Servicios públicos/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /Gastos fijos/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("con openSection='bank' muestra el select de bancos y los campos de cuenta", async () => {
    const props = setup({
      openSection: "bank",
      bank: {
        form: {
          bankId: "b1", bankAlias: "BROWN.706.CONS", cbu: "0720500220000000294986",
          accountNumber: "500-002949/8", branch: "016",
          accountType: "Cuenta Corriente", accountHolder: "Consorcio A. Brown 706",
        },
        msg: null,
        onChangeForm: vi.fn(),
        onSave: vi.fn(),
      },
    });
    expect(screen.getByDisplayValue("0720500220000000294986")).toBeInTheDocument();
    expect(screen.getByDisplayValue("500-002949/8")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Santander" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Guardar$/ }));
    expect(props.bank.onSave).toHaveBeenCalledTimes(1);
  });

  it("click en la cabecera de LSP dispara onToggleSection('lsp')", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Servicios públicos/ }));
    expect(props.onToggleSection).toHaveBeenCalledWith("lsp");
  });

  it("con openSection='lsp' lista los servicios y 'Agregar' dispara lsp.onAdd", async () => {
    const props = setup({
      openSection: "lsp",
      lsp: {
        services: [{ id: "l1", providerName: "EDESUR", clientNumber: "12345", description: "Edificio" }],
        form: { provider: "AYSA", clientNumber: "9", description: "" },
        error: null, confirmDeleteId: null,
        onChangeForm: vi.fn(), onConfirmDelete: vi.fn(), onAdd: vi.fn(), onDelete: vi.fn(),
      },
    });
    expect(screen.getByText("12345")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Agregar$/ }));
    expect(props.lsp.onAdd).toHaveBeenCalledTimes(1);
  });

  it("click en 'Cerrar' dispara onClose", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /^Cerrar$/ }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
