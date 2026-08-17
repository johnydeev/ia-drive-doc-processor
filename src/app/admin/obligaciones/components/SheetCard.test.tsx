import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SheetCard } from "./SheetCard";
import type { SheetData } from "../lib/sheetModel";

const sheet: SheetData = {
  consortiumId: "c1",
  consortiumName: "FRANKLIN 25",
  bankId: "b1",
  bankName: "Santander",
  bankColor: "red",
  periodId: "per1",
  periodLabel: "julio 2026",
  rows: [
    { fixedExpenseId: "fx1", obligationId: "ob1", providerId: null, lspServiceId: "l1",
      facturas: "4804882", concepto: "EDESUR", monto: 118000, aliasCbu: ["edesur.pago"],
      status: "RECEIVED", active: true },
    { fixedExpenseId: "fx2", obligationId: "ob2", providerId: "p1", lspServiceId: null,
      facturas: null, concepto: "SEGURO LA CAJA", monto: null, aliasCbu: [],
      status: "PENDING", active: true },
    { fixedExpenseId: "fx3", obligationId: "ob3", providerId: "p2", lspServiceId: null,
      facturas: null, concepto: "N.G. FUMIGACION", monto: null, aliasCbu: [],
      status: "SKIPPED", active: true },
  ],
  carried: [],
};

function renderCard(overrides: Partial<React.ComponentProps<typeof SheetCard>> = {}) {
  const props = {
    sheet,
    onAdd: vi.fn(),
    onToggle: vi.fn(),
    onSetStatus: vi.fn(),
    onCarryOver: vi.fn(),
    onSetLateAmount: vi.fn(),
    ...overrides,
  };
  render(<SheetCard {...props} />);
  return props;
}

describe("SheetCard", () => {
  it("muestra edificio, banco y período", () => {
    renderCard();
    expect(screen.getByText("FRANKLIN 25")).toBeInTheDocument();
    expect(screen.getByText(/Santander/)).toBeInTheDocument();
    expect(screen.getByText(/julio 2026/)).toBeInTheDocument();
  });

  it("dibuja las seis columnas de la planilla", () => {
    renderCard();
    for (const header of ["FACTURAS", "PROVEEDORES Y SERVICIOS", "MONTO", "ALIAS - CBU", "TÉCNICO O GESTOR", "TEL. CONTACTO"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
  });

  it("muestra el monto formateado sólo cuando la boleta llegó", () => {
    renderCard();
    expect(screen.getByText(/118\.000/)).toBeInTheDocument();
    const seguroRow = screen.getByText("SEGURO LA CAJA").closest("tr")!;
    expect(seguroRow.textContent).not.toMatch(/\$/);
  });

  it("una fila pendiente ofrece saltear el periodo y desactivar", async () => {
    const props = renderCard();
    const pendiente = screen.getByText("SEGURO LA CAJA").closest("tr")!;

    expect(within(pendiente).getByRole("button", { name: "Desactivar" })).toBeInTheDocument();
    await userEvent.click(within(pendiente).getByRole("button", { name: "Saltear periodo" }));
    expect(props.onSetStatus).toHaveBeenCalledWith("ob2", "SKIPPED");
  });

  // Una acción por estado: la única que se ofrece es la que lo revierte.
  it("una fila salteada sólo ofrece agregarla al periodo", async () => {
    const props = renderCard();
    const salteada = screen.getByText("N.G. FUMIGACION").closest("tr")!;

    expect(within(salteada).queryByRole("button", { name: "Desactivar" })).not.toBeInTheDocument();
    expect(within(salteada).queryByRole("button", { name: "Saltear periodo" })).not.toBeInTheDocument();

    await userEvent.click(within(salteada).getByRole("button", { name: "Agregar al periodo" }));
    expect(props.onSetStatus).toHaveBeenCalledWith("ob3", "PENDING");
  });

  it("una fila con boleta recibida no ofrece saltear el periodo", () => {
    renderCard();
    const recibida = screen.getByText("EDESUR").closest("tr")!;
    expect(within(recibida).queryByRole("button", { name: "Saltear periodo" })).not.toBeInTheDocument();
    expect(within(recibida).getByRole("button", { name: "Desactivar" })).toBeInTheDocument();
  });

  it("el botón + dispara onAdd con el consorcio", async () => {
    const props = renderCard();
    await userEvent.click(screen.getByRole("button", { name: /Agregar gasto fijo/ }));
    expect(props.onAdd).toHaveBeenCalledWith("c1");
  });

  // El borrado físico arrastra las obligaciones de todos los períodos
  // (`onDelete: Cascade`): el historial tiene que sobrevivir para una rendición
  // de cuentas. La baja se hace desactivando.
  it("no ofrece borrar un gasto fijo en ninguna fila", () => {
    renderCard();
    expect(screen.queryByRole("button", { name: /Eliminar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Quitar/i })).not.toBeInTheDocument();
  });

  it("una fila desactivada sólo ofrece Activar", async () => {
    const inactiva = {
      ...sheet,
      rows: [{ ...sheet.rows[1], active: false }],
    };
    const props = renderCard({ sheet: inactiva });

    expect(screen.queryByRole("button", { name: "Saltear periodo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desactivar" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Activar" }));
    expect(props.onToggle).toHaveBeenCalledWith("c1", "fx2", true);
  });

  // Feedback de carga: convención del proyecto para toda acción async.
  it("mientras la acción corre, el botón se deshabilita y avisa que está ocupado", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    const onSetStatus = vi.fn().mockReturnValue(gate);

    renderCard({ onSetStatus });
    const fila = screen.getByText("SEGURO LA CAJA").closest("tr")!;
    const boton = within(fila).getByRole("button", { name: "Saltear periodo" });

    await userEvent.click(boton);

    expect(within(fila).getByRole("button", { name: /Salteando/ })).toBeDisabled();
    expect(within(fila).getByRole("button", { name: /Salteando/ })).toHaveAttribute("aria-busy", "true");

    await act(async () => { release(); await gate; });
    expect(onSetStatus).toHaveBeenCalledTimes(1);
  });

  it("el doble click no dispara la acción dos veces", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    const onToggle = vi.fn().mockReturnValue(gate);

    renderCard({ onToggle });
    const fila = screen.getByText("SEGURO LA CAJA").closest("tr")!;
    const boton = within(fila).getByRole("button", { name: "Desactivar" });

    await userEvent.click(boton);
    await userEvent.click(boton);

    expect(onToggle).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await gate; });
  });

  it("desactivar también da feedback de carga", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    const onToggle = vi.fn().mockReturnValue(gate);

    renderCard({ onToggle });
    const fila = screen.getByText("SEGURO LA CAJA").closest("tr")!;
    await userEvent.click(within(fila).getByRole("button", { name: "Desactivar" }));

    expect(within(fila).getByRole("button", { name: /Desactivando/ })).toBeDisabled();
    await act(async () => { release(); await gate; });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("marca la tarjeta como imprimible sólo si le queda alguna fila para el papel", () => {
    const noop = {
      onAdd: vi.fn(), onToggle: vi.fn(), onSetStatus: vi.fn(),
      onCarryOver: vi.fn(), onSetLateAmount: vi.fn(),
    };

    const { container, unmount } = render(<SheetCard sheet={sheet} {...noop} />);
    expect(container.querySelector("section")).toHaveAttribute("data-printable", "true");
    unmount();

    // Todo salteado y sin impagas → no queda nada que imprimir.
    const nadaQueImprimir = {
      ...sheet,
      rows: sheet.rows.map((r) => ({ ...r, status: "SKIPPED" as const })),
    };
    const { container: c2, unmount: unmount2 } = render(<SheetCard sheet={nadaQueImprimir} {...noop} />);
    expect(c2.querySelector("section")).toHaveAttribute("data-printable", "false");
    unmount2();

    // Pero una impaga pendiente SÍ se imprime, aunque no haya gastos del mes.
    const soloImpaga = {
      ...nadaQueImprimir,
      carried: [
        { invoiceId: "inv-ago", facturas: null, concepto: "EDESUR S.A.", monto: 980000,
          originalAmount: 980000, lateAmount: null, aliasCbu: [],
          fromLabel: "agosto 2026", alreadyCarried: false, canCarry: true },
      ],
    };
    const { container: c3 } = render(<SheetCard sheet={soloImpaga} {...noop} />);
    expect(c3.querySelector("section")).toHaveAttribute("data-printable", "true");
  });

  it("un edificio sin gastos fijos avisa y no dibuja tabla", () => {
    renderCard({ sheet: { ...sheet, rows: [] } });
    expect(screen.getByText(/sin gastos fijos cargados/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("un edificio sin impagas no dibuja el bloque", () => {
    renderCard();
    expect(screen.queryByText(/Impagas de meses anteriores/i)).not.toBeInTheDocument();
  });

  it("una impaga pasable muestra el bloque y ofrece pasarla", async () => {
    const props = renderCard({
      sheet: {
        ...sheet,
        carried: [
          { invoiceId: "inv-ago", facturas: "4804882", concepto: "EDESUR S.A.", monto: 980000,
            originalAmount: 980000, lateAmount: null, aliasCbu: ["edesur.pago"],
            fromLabel: "agosto 2026", alreadyCarried: false, canCarry: true },
        ],
      },
    });

    expect(screen.getByText(/Impagas de meses anteriores/i)).toBeInTheDocument();
    expect(screen.getByText(/de agosto 2026/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Pasar a este período" }));
    expect(props.onCarryOver).toHaveBeenCalledWith("inv-ago");
  });

  it("una impaga que no es del mes anterior no se puede pasar", () => {
    renderCard({
      sheet: {
        ...sheet,
        carried: [
          { invoiceId: "inv-jun", facturas: null, concepto: "AYSA", monto: 5000,
            originalAmount: 5000, lateAmount: null, aliasCbu: [],
            fromLabel: "junio 2026", alreadyCarried: false, canCarry: false },
        ],
      },
    });
    expect(screen.getByRole("button", { name: "Pasar a este período" })).toBeDisabled();
  });

  it("una ya pasada muestra el badge y permite cargar el monto vencido", async () => {
    const props = renderCard({
      sheet: {
        ...sheet,
        carried: [
          { invoiceId: "inv-ago", facturas: null, concepto: "EDESUR S.A.", monto: 980000,
            originalAmount: 980000, lateAmount: null, aliasCbu: [],
            fromLabel: "agosto 2026", alreadyCarried: true, canCarry: false },
        ],
      },
    });

    expect(screen.getByText(/pasada a este período/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Cargar monto vencido/ }));
    await userEvent.type(screen.getByLabelText(/Monto vencido de EDESUR/), "1050000");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));

    expect(props.onSetLateAmount).toHaveBeenCalledWith("inv-ago", 1050000);
  });

  it("con monto vencido cargado muestra el 1° y el 2° pago", () => {
    renderCard({
      sheet: {
        ...sheet,
        carried: [
          { invoiceId: "inv-ago", facturas: null, concepto: "EDESUR S.A.", monto: 1050000,
            originalAmount: 980000, lateAmount: 1050000, aliasCbu: [],
            fromLabel: "agosto 2026", alreadyCarried: true, canCarry: false },
        ],
      },
    });
    expect(screen.getByText(/1° pago/)).toBeInTheDocument();
    expect(screen.getByText(/2° pago/)).toBeInTheDocument();
  });

  it("un edificio sin período activo lo advierte", () => {
    renderCard({ sheet: { ...sheet, periodId: null, periodLabel: null } });
    expect(screen.getByText(/sin período abierto/i)).toBeInTheDocument();
  });
});
