import { describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
  periodStatus: "ACTIVE",
  rows: [
    { fixedExpenseId: "fx1", obligationId: "ob1", providerId: null, lspServiceId: "l1",
      facturas: "4804882", concepto: "EDESUR", fantasia: null, monto: 118000, aliasCbu: ["edesur.pago"],
      status: "RECEIVED", active: true, invoiceId: "inv1", carryOverRequested: false, carriedIn: false,
      invoiceUrl: "https://drive.google.com/file/d/ABC123/view?usp=drivesdk", extras: [], group: "SERVICIO",
      rubroId: "r3", coeficienteId: "cA" },
    { fixedExpenseId: "fx2", obligationId: "ob2", providerId: "p1", lspServiceId: null,
      facturas: null, concepto: "SEGURO LA CAJA", fantasia: null, monto: null, aliasCbu: [],
      status: "PENDING", active: true, invoiceId: null, carryOverRequested: false, carriedIn: false, invoiceUrl: null, extras: [], group: "PROVEEDOR",
      rubroId: "r3", coeficienteId: "cA" },
    { fixedExpenseId: "fx3", obligationId: "ob3", providerId: "p2", lspServiceId: null,
      facturas: null, concepto: "N.G. FUMIGACION", fantasia: "FUMIGACIONES MIGUEL", monto: null, aliasCbu: [],
      status: "SKIPPED", active: true, invoiceId: null, carryOverRequested: false, carriedIn: false, invoiceUrl: null, extras: [], group: "PROVEEDOR",
      rubroId: "r3", coeficienteId: "cA" },
  ],
  carried: [],
  others: [],
  rubros: [{ id: "r3", order: 3, name: "SERVICIOS PÚBLICOS" }],
  coefColumns: [{ id: "cA", code: "A" }],
};

function renderCard(overrides: Partial<React.ComponentProps<typeof SheetCard>> = {}) {
  const props = {
    sheet,
    onAdd: vi.fn(),
    onToggle: vi.fn(),
    onSetStatus: vi.fn(),
    onToggleCarryOver: vi.fn(),
    onUndoCarryOver: vi.fn(),
    onSetLateAmount: vi.fn(),
    onToggleOpen: vi.fn(),
    onSetLabels: vi.fn(),
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

  it("ofrece la vista previa del PDF sólo en las filas con boleta", async () => {
    renderCard();
    const botones = screen.getAllByRole("button", { name: /Vista previa de la boleta/ });
    expect(botones).toHaveLength(1);
    expect(botones[0]).toHaveAccessibleName("Vista previa de la boleta de EDESUR");

    await userEvent.click(botones[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTitle("Vista previa de boleta")).toHaveAttribute(
      "src",
      "https://drive.google.com/file/d/ABC123/preview"
    );
    expect(within(dialog).getByRole("link", { name: /Abrir en Drive/ })).toHaveAttribute(
      "href",
      "https://drive.google.com/file/d/ABC123/view?usp=drivesdk"
    );

    await userEvent.click(within(dialog).getByRole("button", { name: "Cerrar vista previa" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("dibuja las columnas de la planilla, con una columna por coeficiente bajo COEFICIENTE", () => {
    renderCard();
    for (const header of ["FACTURA/NRO CLIENTE", "PROVEEDOR/SERVICIO", "A", "ALIAS - CBU", "TÉCNICO O GESTOR", "TEL. CONTACTO"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    expect(screen.getByRole("columnheader", { name: "COEFICIENTE" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "MONTO" })).toBeNull();
  });

  it("muestra el nombre de fantasía en negrita debajo de la razón social, sólo cuando existe", () => {
    renderCard();
    const fantasia = screen.getByText("FUMIGACIONES MIGUEL");
    expect(fantasia.tagName).toBe("STRONG");
    expect(fantasia.closest("td")).toHaveTextContent("N.G. FUMIGACION");
    // Las filas sin fantasía no dejan ni un nodo vacío.
    const seguro = screen.getByText("SEGURO LA CAJA").closest("td")!;
    expect(within(seguro).queryByRole("strong")).toBeNull();
    expect(seguro.querySelector("strong")).toBeNull();
  });

  it("muestra el monto sólo cuando la boleta llegó, sin '$' (D8)", () => {
    renderCard();
    const edesur = screen.getByText("EDESUR").closest("tr")!;
    expect(within(edesur).getByText("118.000,00")).toBeInTheDocument();
    // SEGURO está pendiente: su celda de la columna A (índice 3) lleva la marca, no un monto (D12).
    const seguro = within(screen.getByText("SEGURO LA CAJA").closest("tr")!).getAllByRole("cell");
    expect(seguro[3].textContent).toBe("—");
    expect(seguro.map((c) => c.textContent).join("")).not.toMatch(/\$/);
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

  it("los desactivados van a un bloque plegado aparte, fuera de la tabla principal", () => {
    const mixta = {
      ...sheet,
      rows: [sheet.rows[0], { ...sheet.rows[1], active: false }, { ...sheet.rows[2], active: false }],
    };
    renderCard({ sheet: mixta });

    const bloque = screen.getByText("Desactivados (2)").closest("details")!;
    expect(bloque).not.toHaveAttribute("open");
    expect(within(bloque).getByText("SEGURO LA CAJA")).toBeInTheDocument();
    expect(within(bloque).getByText("N.G. FUMIGACION")).toBeInTheDocument();
    expect(within(bloque).getAllByRole("button", { name: "Activar" })).toHaveLength(2);

    const [principal] = screen.getAllByRole("table");
    expect(within(principal).getByText("EDESUR")).toBeInTheDocument();
    expect(within(principal).queryByText("SEGURO LA CAJA")).not.toBeInTheDocument();
  });

  it("sin desactivados no dibuja el bloque", () => {
    renderCard();
    expect(screen.queryByText(/Desactivados/)).not.toBeInTheDocument();
  });

  it("si todos están desactivados avisa que no hay activos y deja el bloque", () => {
    renderCard({ sheet: { ...sheet, rows: sheet.rows.map((r) => ({ ...r, active: false })) } });
    expect(screen.getByText(/sin gastos fijos activos/i)).toBeInTheDocument();
    expect(screen.getByText("Desactivados (3)").closest("details")).toBeInTheDocument();
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
      onToggleCarryOver: vi.fn(), onUndoCarryOver: vi.fn(), onSetLateAmount: vi.fn(),
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
          fromLabel: "agosto 2026", carryOverRequested: false, invoiceUrl: null },
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
    expect(screen.queryByText(/Vienen del mes anterior/i)).not.toBeInTheDocument();
  });

  it("el bloque de abajo muestra lo que vino del mes anterior", () => {
    renderCard({
      sheet: {
        ...sheet,
        carried: [
          { invoiceId: "inv9", facturas: null, concepto: "ASCENSORES POTENZA", monto: 118000,
            originalAmount: 118000, lateAmount: null, aliasCbu: [], fromLabel: "junio 2026", carryOverRequested: false, invoiceUrl: null },
        ],
      },
    });

    expect(screen.getByText("Vienen del mes anterior")).toBeInTheDocument();
    expect(screen.getByText("ASCENSORES POTENZA")).toBeInTheDocument();
    expect(screen.getByText("de junio 2026")).toBeInTheDocument();
  });

  it("ya no ofrece traer boletas de meses anteriores", async () => {
    // El traspaso se decide en el mes de ORIGEN, no tirando desde el destino.
    renderCard({
      sheet: {
        ...sheet,
        carried: [
          { invoiceId: "inv9", facturas: null, concepto: "ASCENSORES POTENZA", monto: 118000,
            originalAmount: 118000, lateAmount: null, aliasCbu: [], fromLabel: "junio 2026", carryOverRequested: false, invoiceUrl: null },
        ],
      },
    });

    expect(screen.queryByRole("button", { name: /pasar a este per/i })).not.toBeInTheDocument();
  });

  it("una boleta del mes se puede marcar para pasar al mes siguiente", async () => {
    const user = userEvent.setup();
    const props = renderCard();

    // Sólo la fila que YA tiene boleta ofrece la acción.
    await user.click(screen.getByRole("button", { name: "Mes siguiente" }));

    expect(props.onToggleCarryOver).toHaveBeenCalledWith("inv1", true);
  });

  it("una fila sin boleta no ofrece pasarla", () => {
    renderCard();

    // EDESUR tiene boleta; SEGURO LA CAJA no.
    expect(screen.getAllByRole("button", { name: "Mes siguiente" })).toHaveLength(1);
  });

  it("una boleta ya marcada ofrece quitar la marca", async () => {
    const user = userEvent.setup();
    const marked = {
      ...sheet,
      rows: [{ ...sheet.rows[0], carryOverRequested: true }],
    };
    const props = renderCard({ sheet: marked });

    await user.click(screen.getByRole("button", { name: /mes siguiente ✓/i }));

    expect(props.onToggleCarryOver).toHaveBeenCalledWith("inv1", false);
  });

  it("permite cargar el monto vencido de una que vino del mes anterior", async () => {
    const user = userEvent.setup();
    const props = renderCard({
      sheet: {
        ...sheet,
        carried: [
          { invoiceId: "inv9", facturas: null, concepto: "ASCENSORES POTENZA", monto: 118000,
            originalAmount: 118000, lateAmount: null, aliasCbu: [], fromLabel: "junio 2026", carryOverRequested: false, invoiceUrl: null },
        ],
      },
    });

    await user.click(screen.getByRole("button", { name: "Monto vencido" }));
    await user.type(screen.getByLabelText(/monto vencido de ASCENSORES POTENZA/i), "130000");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(props.onSetLateAmount).toHaveBeenCalledWith("inv9", 130000);
  });

  it("con monto vencido cargado muestra el 1° y el 2° pago", () => {
    renderCard({
      sheet: {
        ...sheet,
        carried: [
          { invoiceId: "inv9", facturas: null, concepto: "ASCENSORES POTENZA", monto: 130000,
            originalAmount: 118000, lateAmount: 130000, aliasCbu: [], fromLabel: "junio 2026", carryOverRequested: false, invoiceUrl: null },
        ],
      },
    });

    expect(screen.getByText(/1° pago .* · 2° pago/)).toBeInTheDocument();
  });

  it("un edificio sin período activo lo advierte", () => {
    renderCard({ sheet: { ...sheet, periodId: null, periodLabel: null } });
    expect(screen.getByText(/sin período abierto/i)).toBeInTheDocument();
  });

  it("una arrastrada se puede volver a pasar al mes siguiente (arrastre encadenado)", async () => {
    // El agujero que destapó la re-revisión: vino de julio, en agosto tampoco se
    // paga, y tiene que poder ir a septiembre.
    const user = userEvent.setup();
    const props = renderCard({
      sheet: {
        ...sheet,
        carried: [
          { invoiceId: "inv9", facturas: null, concepto: "ASCENSORES POTENZA", monto: 118000,
            originalAmount: 118000, lateAmount: null, aliasCbu: [], fromLabel: "junio 2026",
            carryOverRequested: false, invoiceUrl: null },
        ],
      },
    });

    const bloque = screen.getByText("Vienen del mes anterior").closest("div")!;
    await user.click(within(bloque).getByRole("button", { name: "Mes siguiente" }));

    expect(props.onToggleCarryOver).toHaveBeenCalledWith("inv9", true);
  });

  it("una arrastrada se puede devolver a su mes de origen", async () => {
    const user = userEvent.setup();
    const props = renderCard({
      sheet: {
        ...sheet,
        carried: [
          { invoiceId: "inv9", facturas: null, concepto: "ASCENSORES POTENZA", monto: 118000,
            originalAmount: 118000, lateAmount: null, aliasCbu: [], fromLabel: "junio 2026",
            carryOverRequested: false, invoiceUrl: null },
        ],
      },
    });

    await user.click(screen.getByRole("button", { name: "Devolver" }));

    expect(props.onUndoCarryOver).toHaveBeenCalledWith("inv9");
  });
});

describe("adicionales y otras boletas del mes", () => {
  const extra = (over: Partial<SheetData["rows"][number]["extras"][number]> = {}) => ({
    invoiceId: "inv2", ordinal: 2, monto: 54000, invoiceUrl: "https://drive.google.com/file/d/X2/view",
    carryOverRequested: false, carriedOutTo: null, ...over,
  });
  const other = (over: Partial<SheetData["others"][number]> = {}) => ({
    invoiceId: "o1", facturas: null, concepto: "PLOMERO JUAN", fantasia: "JUAN", monto: 32000,
    aliasCbu: ["juan.plomero"], invoiceUrl: "https://drive.google.com/file/d/O1/view",
    carryOverRequested: false, carriedOutTo: null, group: "PROVEEDOR" as const, ...over,
  });

  it("una adicional se dibuja debajo de su madre con su monto y ofrece pasarla al mes siguiente", async () => {
    const props = renderCard({ sheet: { ...sheet, rows: [{ ...sheet.rows[0], extras: [extra()] }] } });
    const fila = screen.getByText("↳ 2ª boleta").closest("tr")!;
    expect(within(fila).getByText(/54\.000/)).toBeInTheDocument();
    expect(within(fila).getByText("edesur.pago")).toBeInTheDocument();
    expect(within(fila).queryByRole("button", { name: /saltear/i })).toBeNull();
    expect(within(fila).queryByRole("button", { name: /desactivar/i })).toBeNull();
    await userEvent.click(within(fila).getByRole("button", { name: /mes siguiente/i }));
    expect(props.onToggleCarryOver).toHaveBeenCalledWith("inv2", true);
  });

  it("una adicional ofrece la vista previa de SU pdf", () => {
    renderCard({ sheet: { ...sheet, rows: [{ ...sheet.rows[0], extras: [extra()] }] } });
    expect(screen.getByRole("button", { name: /vista previa de la boleta de edesur — 2ª boleta/i })).toBeInTheDocument();
  });

  it("una adicional que pasó a otro mes lo dice y no tiene acciones", () => {
    renderCard({ sheet: { ...sheet, rows: [{ ...sheet.rows[0], extras: [extra({ carriedOutTo: "agosto 2026" })] }] } });
    const fila = screen.getByText("↳ 2ª boleta").closest("tr")!;
    expect(within(fila).getByText(/pasó a agosto 2026/i)).toBeInTheDocument();
    expect(within(fila).queryByRole("button", { name: /mes siguiente/i })).toBeNull();
  });

  it("una boleta eventual entra en su rubro con el distintivo 'eventual' y se puede pasar", async () => {
    const props = renderCard({ sheet: { ...sheet, others: [{ ...other(), rubroId: "r3", coeficienteId: "cA" }] } });
    const fila = screen.getByText("PLOMERO JUAN").closest("tr")!;
    expect(within(fila).getByText("eventual")).toBeInTheDocument();
    expect(within(fila).getByText("JUAN")).toBeInTheDocument();
    expect(within(fila).getByText(/32\.000/)).toBeInTheDocument();
    expect(within(fila).getByText("juan.plomero")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /otras boletas del mes/i })).toBeNull();
    await userEvent.click(within(fila).getByRole("button", { name: /mes siguiente/i }));
    expect(props.onToggleCarryOver).toHaveBeenCalledWith("o1", true);
  });

  it("un edificio sin gastos fijos pero con otras boletas no dice que no se va a imprimir", () => {
    const { container } = render(
      <SheetCard sheet={{ ...sheet, rows: [], others: [other()] }} onAdd={vi.fn()} onToggle={vi.fn()}
        onSetStatus={vi.fn()} onToggleCarryOver={vi.fn()} onUndoCarryOver={vi.fn()} onSetLateAmount={vi.fn()} />
    );
    expect(screen.getByText(/sin gastos fijos cargados/i)).toBeInTheDocument();
    expect(screen.queryByText(/no se va a imprimir/i)).toBeNull();
    expect(container.querySelector("section")?.getAttribute("data-printable")).toBe("true");
  });
});

describe("columnas alineadas entre la tabla del mes y los bloques", () => {
  it("un nro. de cliente largo se recorta y el completo queda en el tooltip", () => {
    renderCard({ sheet: { ...sheet, rows: [{ ...sheet.rows[0], facturas: "0048198374000123" }] } });
    const celda = screen.getByText("004819837400…");
    expect(celda).toHaveAttribute("title", "0048198374000123");
  });

  it("la tabla de rubros, la de 'Sin rubro' y la del total del mes comparten el mismo colgroup", () => {
    const { container } = render(
      <SheetCard sheet={{ ...sheet, others: [{ invoiceId: "o1", facturas: "77", concepto: "PLOMERO", fantasia: null,
        monto: 1, aliasCbu: [], invoiceUrl: null, carryOverRequested: false, carriedOutTo: null, group: "PROVEEDOR" }] }}
        onAdd={vi.fn()} onToggle={vi.fn()} onSetStatus={vi.fn()} onToggleCarryOver={vi.fn()}
        onUndoCarryOver={vi.fn()} onSetLateAmount={vi.fn()} />
    );
    // 3 tablas: rubros, "Sin rubro" y el total del mes (fuera del tfoot desde
    // el code review, para que siga sumando aunque "Sin rubro" esté plegado).
    const groups = container.querySelectorAll("table colgroup");
    expect(groups).toHaveLength(3);
    expect(groups[1].innerHTML).toBe(groups[0].innerHTML);
    expect(groups[2].innerHTML).toBe(groups[0].innerHTML);
  });
});

describe("encabezado: banco rotulado y acordeón", () => {
  it("rotula el banco como BANCO: <nombre>, y SIN BANCO si no tiene", () => {
    renderCard();
    expect(screen.getByText("BANCO: Santander")).toBeInTheDocument();
    cleanup();
    renderCard({ sheet: { ...sheet, bankId: null, bankName: "Sin banco" } });
    expect(screen.getByText("Sin banco")).toBeInTheDocument();
    expect(screen.queryByText(/BANCO:/)).toBeNull();
  });

  it("cerrada, esconde las tablas y el encabezado dice que está plegada", () => {
    renderCard({ open: false });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: /santander.*franklin 25/i })).toHaveAttribute("aria-expanded", "false");
  });

  it("abierta, muestra las tablas", () => {
    renderCard({ open: true });
    expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /santander.*franklin 25/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("el click en el encabezado avisa al padre con el consorcio (el padre decide cuál queda abierta)", async () => {
    const props = renderCard({ open: false });
    await userEvent.click(screen.getByRole("button", { name: /santander.*franklin 25/i }));
    expect(props.onToggleOpen).toHaveBeenCalledWith("c1");
  });

  it("el botón + no pliega ni despliega la hoja", async () => {
    const props = renderCard({ open: true });
    await userEvent.click(screen.getByRole("button", { name: /agregar gasto fijo/i }));
    expect(props.onAdd).toHaveBeenCalledWith("c1");
    expect(props.onToggleOpen).not.toHaveBeenCalled();
  });
});

describe("columna FACTURA/NRO CLIENTE de los sueldos", () => {
  const conSueldo: SheetData = {
    ...sheet,
    rows: [
      { fixedExpenseId: "fx9", obligationId: "ob9", providerId: "emp", lspServiceId: null,
        facturas: null, concepto: "CASTILLO JUAN CARLOS", fantasia: "encargado perm. c/v 3ra",
        monto: null, aliasCbu: [], status: "PENDING", active: true, invoiceId: null,
        carryOverRequested: false, carriedIn: false, invoiceUrl: null, extras: [], group: "EMPLEADO" },
    ],
  };

  it("rotula 'Empleado' la fila del encargado", () => {
    renderCard({ sheet: conSueldo });
    expect(screen.getByText("Empleado")).toBeInTheDocument();
  });

  it("no rotula nada en un proveedor sin nro. de cliente", () => {
    renderCard();
    expect(screen.queryByText("Empleado")).not.toBeInTheDocument();
  });
});

describe("secciones por rubro", () => {
  const dosRubros: SheetData = {
    ...sheet,
    rubros: [
      { id: "r3", order: 3, name: "SERVICIOS PÚBLICOS" },
      { id: "r4", order: 4, name: "ABONOS DE SERVICIOS" },
    ],
    coefColumns: [{ id: "cA", code: "A" }, { id: "cB", code: "B" }],
    rows: [
      { ...sheet.rows[0], coeficienteId: "cB" },          // EDESUR 118.000 → columna B
      { ...sheet.rows[1], rubroId: null },                 // SEGURO → Sin rubro
    ],
  };

  it("titula cada rubro con su número y cierra con su total", () => {
    renderCard({ sheet: dosRubros });
    expect(screen.getByText("3 SERVICIOS PÚBLICOS")).toBeInTheDocument();
    expect(screen.getByText("4 ABONOS DE SERVICIOS")).toBeInTheDocument();
    const total = screen.getByText("TOTAL RUBRO 3").closest("tr")!;
    const celdas = within(total).getAllByRole("cell").map((c) => c.textContent);
    expect(celdas.some((t) => /118\.000/.test(t ?? ""))).toBe(true);
  });

  // Code review: sin esto, en el papel `.previewCell` y `.rowActions` se
  // esconden por clase pero un colSpan que las incluyera correría el resto de
  // la fila una columna. La fila de total tiene que traer esas dos celdas
  // SUYAS, separadas del colSpan del medio.
  it("la fila de total de rubro separa preview y acciones en celdas propias (alineación al imprimir)", () => {
    renderCard({ sheet: dosRubros });
    const total = screen.getByText("TOTAL RUBRO 3").closest("tr")!;
    const celdas = within(total).getAllByRole("cell");
    expect(celdas[0].className).toMatch(/previewCell/);
    expect(celdas[celdas.length - 1].className).toMatch(/rowActions/);
  });

  // Code review, segunda vuelta (item c): con todas las secciones vacías, la
  // tabla de rubros imprimiría sólo su encabezado (todas sus filas son
  // `.sectionEmpty`) — sin esta clase, ocuparía espacio en el papel sin decir
  // nada.
  it("si todos los rubros están vacíos, la tabla de rubros lleva la clase que la esconde al imprimir", () => {
    const sinEtiquetar = { ...dosRubros, rows: dosRubros.rows.map((r) => ({ ...r, rubroId: null })) };
    const { container } = render(
      <SheetCard sheet={sinEtiquetar} onAdd={vi.fn()} onToggle={vi.fn()} onSetStatus={vi.fn()}
        onToggleCarryOver={vi.fn()} onUndoCarryOver={vi.fn()} onSetLateAmount={vi.fn()} />
    );
    const [rubroTable] = container.querySelectorAll("table");
    expect(rubroTable.className).toMatch(/rubroTableEmpty/);
  });

  // Tercera vuelta de revisión: con filas pero ninguna para el papel (la única está
  // salteada), la tabla de rubros también se esconde al imprimir — sino sale su
  // encabezado solo.
  it("si los rubros tienen filas pero ninguna imprimible, la tabla lleva la clase que la esconde al imprimir", () => {
    renderCard({ sheet: { ...dosRubros, rows: [{ ...sheet.rows[2], rubroId: "r3" }] } });
    const [rubroTable] = screen.getAllByRole("table");
    expect(rubroTable.className).toMatch(/rubroTableEmpty/);
  });

  it("'Sin rubro' con su única fila salteada se esconde al imprimir; la tabla de rubros con algo imprimible, no", () => {
    const { container } = render(
      <SheetCard sheet={{ ...dosRubros, rows: [dosRubros.rows[0], { ...sheet.rows[2], rubroId: null }] }}
        onAdd={vi.fn()} onToggle={vi.fn()} onSetStatus={vi.fn()}
        onToggleCarryOver={vi.fn()} onUndoCarryOver={vi.fn()} onSetLateAmount={vi.fn()} />
    );
    const bloque = screen.getByRole("button", { name: /sin rubro \(1\)/i }).parentElement!;
    expect(bloque.className).toMatch(/sinRubroBlockEmpty/);
    const [rubroTable] = container.querySelectorAll("table");
    expect(rubroTable.className).not.toMatch(/rubroTableEmpty/);
  });

  // Con contenido pero nada para el papel (la única fila está salteada), la
  // sección tiene que esconderse igual que una vacía de verdad: sino el papel
  // imprime un título y un total en blanco sin ninguna fila abajo.
  it("un rubro cuya única fila está salteada lleva la clase que lo esconde al imprimir", () => {
    const soloSalteada = { ...sheet, rows: [sheet.rows[2]] }; // N.G. FUMIGACION, status SKIPPED
    renderCard({ sheet: soloSalteada });
    const titulo = screen.getByText("3 SERVICIOS PÚBLICOS").closest("tr")!;
    expect(titulo.className).toMatch(/sectionEmpty/);
  });

  it("el monto va en la columna de su coeficiente", () => {
    renderCard({ sheet: dosRubros });
    const fila = screen.getByText("EDESUR").closest("tr")!;
    const celdas = within(fila).getAllByRole("cell");
    // preview, facturas, concepto, A, B, …
    expect(celdas[3].textContent).toBe("");
    expect(celdas[4].textContent).toMatch(/118\.000/);
  });

  it("una fila pendiente marca con '—' la columna de su coeficiente (D12)", () => {
    renderCard({ sheet: { ...dosRubros, rows: [{ ...dosRubros.rows[1], rubroId: "r3", coeficienteId: "cB" }] } });
    const celdas = within(screen.getByText("SEGURO LA CAJA").closest("tr")!).getAllByRole("cell");
    expect(celdas[3].textContent).toBe("");
    expect(celdas[4].textContent).toBe("—");
  });

  it("con una búsqueda activa no muestra los rubros vacíos (D13)", () => {
    renderCard({ sheet: dosRubros, hideEmptySections: true });
    expect(screen.getByText("3 SERVICIOS PÚBLICOS")).toBeInTheDocument();
    expect(screen.queryByText("4 ABONOS DE SERVICIOS")).toBeNull();
  });

  it("'Sin rubro' arranca plegado, dice cuántos tiene y se despliega", async () => {
    renderCard({ sheet: dosRubros });
    const toggle = screen.getByRole("button", { name: /sin rubro \(1\)/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /saltear periodo/i })).toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /saltear periodo/i })).toBeInTheDocument();
  });

  it("un edificio sin rubros asignados muestra 'Sin rubro' desplegado", () => {
    renderCard({ sheet: { ...sheet, rubros: [] } });
    expect(screen.getByRole("button", { name: /sin rubro \(3\)/i })).toHaveAttribute("aria-expanded", "true");
  });

  // Code review (item 3): generaliza la excepción de D1 — no sólo "sin
  // rubros", también "con rubros pero ninguno todavía cargado" (rollout de la
  // feature: las filas viejas no tienen etiqueta hasta que se editan a mano).
  it("con rubros asignados pero ninguna fila etiquetada, 'Sin rubro' arranca desplegado", () => {
    const sinEtiquetar = { ...dosRubros, rows: dosRubros.rows.map((r) => ({ ...r, rubroId: null })) };
    renderCard({ sheet: sinEtiquetar });
    expect(screen.getByRole("button", { name: /sin rubro \(2\)/i })).toHaveAttribute("aria-expanded", "true");
  });

  // Code review (item 2): con una búsqueda activa los rubros vacíos no se
  // dibujan (D13); si con eso no queda NINGÚN rubro visible, "Sin rubro" —que
  // es donde SÍ está el resultado de la búsqueda— no puede seguir plegado.
  it("con hideEmptySections y todas las filas sin rubro, 'Sin rubro' se muestra desplegado", () => {
    const sinEtiquetar = { ...dosRubros, rows: dosRubros.rows.map((r) => ({ ...r, rubroId: null })) };
    renderCard({ sheet: sinEtiquetar, hideEmptySections: true });
    expect(screen.getByRole("button", { name: /sin rubro \(2\)/i })).toHaveAttribute("aria-expanded", "true");
  });

  // Segunda vuelta de review (item b): la búsqueda fuerza "Sin rubro" abierto
  // SIEMPRE que esté activa, aunque algún rubro sí tenga contenido — el
  // resultado puede estar repartido entre uno y otro, y con el rubro visible
  // pero "Sin rubro" plegado el usuario no vería la mitad de lo que buscó.
  it("con hideEmptySections, aunque un rubro tenga contenido 'Sin rubro' se muestra desplegado", () => {
    // dosRubros ya tiene EDESUR en el rubro r3 y SEGURO sin rubro.
    renderCard({ sheet: dosRubros, hideEmptySections: true });
    expect(screen.getByRole("button", { name: /sin rubro \(1\)/i })).toHaveAttribute("aria-expanded", "true");
  });

  // Segunda vuelta de review (item a): el forzado no debe dejar el toggle
  // muerto — el usuario tiene que poder plegar "Sin rubro" aunque esté
  // forzado a abrir, y un segundo click lo vuelve a abrir.
  it("el toggle sigue funcionando estando forzado a abrir: un click lo pliega", async () => {
    const sinEtiquetar = { ...dosRubros, rows: dosRubros.rows.map((r) => ({ ...r, rubroId: null })) };
    renderCard({ sheet: sinEtiquetar });
    const toggle = screen.getByRole("button", { name: /sin rubro \(2\)/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("el total del mes suma todas las secciones, incluida 'Sin rubro'", () => {
    renderCard({ sheet: { ...dosRubros, rows: [dosRubros.rows[0], { ...dosRubros.rows[1], monto: 5000, invoiceId: "inv9" }] } });
    const total = screen.getByText("TOTAL DEL MES").closest("tr")!;
    const textos = within(total).getAllByRole("cell").map((c) => c.textContent ?? "");
    expect(textos.some((t) => /5\.000/.test(t))).toBe(true);
    expect(textos.some((t) => /118\.000/.test(t))).toBe(true);
  });

  // Con una búsqueda activa `sheet` ya llegó filtrado (`filterSheets`): el
  // total de abajo suma sólo lo visible, y el rótulo lo tiene que avisar.
  it("con una búsqueda activa el total del mes se rotula '(filtrado)'", () => {
    renderCard({ sheet: dosRubros });
    expect(screen.getByText("TOTAL DEL MES")).toBeInTheDocument();
    expect(screen.queryByText(/TOTAL DEL MES \(filtrado\)/)).toBeNull();
    cleanup();
    renderCard({ sheet: dosRubros, hideEmptySections: true });
    expect(screen.getByText("TOTAL DEL MES (filtrado)")).toBeInTheDocument();
  });

  it("editar el rubro de una fila con boleta escribe gasto fijo y boleta", async () => {
    const props = renderCard({ sheet: dosRubros });
    await userEvent.click(screen.getByRole("button", { name: /rubro y coeficiente de edesur/i }));
    await userEvent.selectOptions(screen.getByLabelText("Rubro de EDESUR"), "r4");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(props.onSetLabels).toHaveBeenCalledWith(
      { fixedExpenseId: "fx1", invoiceId: "inv1" },
      { rubroId: "r4", coeficienteId: "cB" }
    );
  });

  it("en una fila sin boleta, sólo el gasto fijo", async () => {
    const props = renderCard({ sheet: { ...dosRubros, rows: [{ ...dosRubros.rows[1], rubroId: "r3" }] } });
    await userEvent.click(screen.getByRole("button", { name: /rubro y coeficiente de seguro la caja/i }));
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(props.onSetLabels).toHaveBeenCalledWith({ fixedExpenseId: "fx2" }, { rubroId: "r3", coeficienteId: "cA" });
  });
});

// TÉCNICO O GESTOR y TEL. CONTACTO ocupan lugar valioso en una notebook de
// 1366px cuando hay muchas columnas de coeficiente: con 4 o más se esconden en
// pantalla (owner, 2026-09-27, D14). Siguen apareciendo al imprimir — se
// completan a mano en el papel — por eso NO se sacan del DOM ni se les pone
// `display: none` (romperían el colSpan de las filas de total/encabezado).
describe("columnas TÉCNICO/TEL compactadas con muchos coeficientes (D14)", () => {
  const conCoefs = (n: number): SheetData => ({
    ...sheet,
    coefColumns: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, code: String.fromCharCode(65 + i) })),
  });

  it("con 4 o más columnas de coeficiente marca la tarjeta como compacta", () => {
    const { container } = render(
      <SheetCard sheet={conCoefs(4)} onAdd={vi.fn()} onToggle={vi.fn()} onSetStatus={vi.fn()}
        onToggleCarryOver={vi.fn()} onUndoCarryOver={vi.fn()} onSetLateAmount={vi.fn()} />
    );
    expect(container.querySelector("section")).toHaveAttribute("data-compact", "true");
    const tecnico = screen.getByRole("columnheader", { name: "TÉCNICO O GESTOR" });
    expect(tecnico.className).toMatch(/contactCell/);
  });

  it("con 1 a 3 columnas de coeficiente no es compacta", () => {
    const { container } = render(
      <SheetCard sheet={conCoefs(1)} onAdd={vi.fn()} onToggle={vi.fn()} onSetStatus={vi.fn()}
        onToggleCarryOver={vi.fn()} onUndoCarryOver={vi.fn()} onSetLateAmount={vi.fn()} />
    );
    expect(container.querySelector("section")).toHaveAttribute("data-compact", "false");
  });

  it("con 3 columnas de coeficiente todavía no es compacta (el corte es en 4)", () => {
    const { container } = render(
      <SheetCard sheet={conCoefs(3)} onAdd={vi.fn()} onToggle={vi.fn()} onSetStatus={vi.fn()}
        onToggleCarryOver={vi.fn()} onUndoCarryOver={vi.fn()} onSetLateAmount={vi.fn()} />
    );
    expect(container.querySelector("section")).toHaveAttribute("data-compact", "false");
  });

  // La clase va SIEMPRE en esas dos celdas (el CSS es lo único que las
  // colapsa, y sólo en pantalla y sólo con la tarjeta compacta): sin esto en
  // el DOM, una fila de total con colSpan quedaría corrida al perder una
  // celda en el papel.
  it("una fila de datos, una adicional, una eventual y una arrastrada llevan exactamente 2 celdas contactCell", () => {
    const extra = { invoiceId: "inv2", ordinal: 2, monto: 54000, invoiceUrl: null, carryOverRequested: false, carriedOutTo: null };
    const other = { invoiceId: "o1", facturas: null, concepto: "PLOMERO JUAN", fantasia: null, monto: 32000,
      aliasCbu: [], invoiceUrl: null, carryOverRequested: false, carriedOutTo: null, group: "PROVEEDOR" as const };
    const carried = { invoiceId: "inv9", facturas: null, concepto: "ASCENSORES POTENZA", monto: 118000,
      originalAmount: 118000, lateAmount: null, aliasCbu: [], fromLabel: "junio 2026", carryOverRequested: false, invoiceUrl: null };

    renderCard({
      sheet: {
        ...sheet,
        rows: [{ ...sheet.rows[0], extras: [extra] }],
        others: [other],
        carried: [carried],
      },
    });

    const contactCellCount = (row: HTMLElement) => row.querySelectorAll('[class*="contactCell"]').length;

    expect(contactCellCount(screen.getByText("EDESUR").closest("tr")!)).toBe(2);
    expect(contactCellCount(screen.getByText("↳ 2ª boleta").closest("tr")!)).toBe(2);
    expect(contactCellCount(screen.getByText("PLOMERO JUAN").closest("tr")!)).toBe(2);
    expect(contactCellCount(screen.getByText("ASCENSORES POTENZA").closest("tr")!)).toBe(2);
  });
});
