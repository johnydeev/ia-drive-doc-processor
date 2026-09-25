import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigModal } from "./ConfigModal";
import type { Bank } from "../lib/types";

const banks: Bank[] = [{ id: "b1", name: "Santander", color: "red" }];

function setup(overrides: Partial<React.ComponentProps<typeof ConfigModal>> = {}) {
  const props: React.ComponentProps<typeof ConfigModal> = {
    consortiumName: "THAMES 647",
    saving: false,
    openSection: null,
    onToggleSection: vi.fn(),
    onClose: vi.fn(),
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
    fixed: { list: [] },
    catalogos: {
      rubros: [],
      coeficientes: [],
      rubroIds: [],
      coeficienteIds: [],
      msg: null,
      confirmMsg: null,
      onToggleRubro: vi.fn(),
      onToggleCoeficiente: vi.fn(),
      onSave: vi.fn(),
      onSaveConfirmed: vi.fn(),
      onCancelConfirm: vi.fn(),
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

  it("la sección de gastos fijos es de solo lectura y linkea a Obligaciones", () => {
    setup({
      openSection: "fixed",
      fixed: {
        list: [
          { id: "fx1", providerId: "p1", lspServiceId: null, description: null, active: true },
          { id: "fx2", providerId: "p2", lspServiceId: null, description: null, active: false },
        ],
      },
    });

    expect(screen.getByText(/1 gasto\(s\) fijo\(s\) activo\(s\) de 2/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Obligaciones" })).toHaveAttribute("href", "/admin/obligaciones");
    expect(screen.queryByRole("button", { name: /^Agregar$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Desactivar/ })).not.toBeInTheDocument();
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

describe("ConfigModal — sección Rubros y coeficientes", () => {
  const catalogos = {
    rubros: [
      { id: "r3", name: "SERVICIOS PÚBLICOS", order: 3 },
      { id: "r5", name: "MANTENIMIENTO", order: 5 },
    ],
    coeficientes: [
      { id: "cA", code: "A", name: "GASTO A", value: null },
      { id: "cB", code: "B", name: "CALDERA", value: null },
    ],
    rubroIds: ["r3"],
    coeficienteIds: [] as string[],
    msg: null,
    confirmMsg: null,
    onToggleRubro: vi.fn(),
    onToggleCoeficiente: vi.fn(),
    onSave: vi.fn(),
    onSaveConfirmed: vi.fn(),
    onCancelConfirm: vi.fn(),
  };

  it("marca las casillas de lo que el edificio ya tiene asignado", () => {
    setup({ openSection: "catalogos", catalogos });
    expect(screen.getByRole("checkbox", { name: /SERVICIOS PÚBLICOS/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /MANTENIMIENTO/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /CALDERA/ })).not.toBeChecked();
  });

  it("muestra el número del rubro y el código del coeficiente", () => {
    setup({ openSection: "catalogos", catalogos });
    expect(screen.getByRole("checkbox", { name: "3 SERVICIOS PÚBLICOS" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "B — CALDERA" })).toBeInTheDocument();
  });

  it("tildar una casilla avisa cuál se tocó", async () => {
    const props = setup({ openSection: "catalogos", catalogos });
    await userEvent.click(screen.getByRole("checkbox", { name: /MANTENIMIENTO/ }));
    expect(props.catalogos.onToggleRubro).toHaveBeenCalledWith("r5");
  });

  it("la sección colapsada no muestra las casillas", () => {
    setup({ openSection: null, catalogos });
    expect(screen.queryByRole("checkbox", { name: /SERVICIOS PÚBLICOS/ })).not.toBeInTheDocument();
  });
});

describe("ConfigModal — confirmación al desasignar", () => {
  // Mocks frescos por test: compartir un `vi.fn()` entre casos hace que un
  // `not.toHaveBeenCalled()` vea la llamada del test anterior.
  const base = () => ({
    rubros: [{ id: "r3", name: "SERVICIOS PÚBLICOS", order: 3 }],
    coeficientes: [],
    rubroIds: [] as string[],
    coeficienteIds: [] as string[],
    msg: null,
    onToggleRubro: vi.fn(),
    onToggleCoeficiente: vi.fn(),
    onSave: vi.fn(),
    onSaveConfirmed: vi.fn(),
    onCancelConfirm: vi.fn(),
  });

  it("sin aviso pendiente, el botón guarda normal", () => {
    setup({ openSection: "catalogos", catalogos: { ...base(), confirmMsg: null } });
    expect(screen.getByRole("button", { name: "Guardar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar igual" })).not.toBeInTheDocument();
  });

  // Desasignar es destructivo e irreversible: volver a tildar el rubro no le
  // devuelve la etiqueta a los gastos fijos.
  it("con aviso pendiente, pide confirmar y dice qué se pierde", async () => {
    const props = setup({
      openSection: "catalogos",
      catalogos: { ...base(), confirmMsg: "4 gastos fijos quedarán sin rubro. Volver a asignarlos no recupera las etiquetas." },
    });
    expect(screen.getByText(/4 gastos fijos quedarán sin rubro/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Guardar igual" }));
    expect(props.catalogos.onSaveConfirmed).toHaveBeenCalled();
  });

  it("cancelar el aviso no guarda", async () => {
    const props = setup({
      openSection: "catalogos",
      catalogos: { ...base(), confirmMsg: "2 quedarán sin coeficiente." },
    });
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(props.catalogos.onCancelConfirm).toHaveBeenCalled();
    expect(props.catalogos.onSaveConfirmed).not.toHaveBeenCalled();
  });
});
