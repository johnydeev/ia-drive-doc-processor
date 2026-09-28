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
      status: "RECEIVED", active: true, invoiceId: "inv1", carryOverRequested: false, carriedIn: false, carriedOutTo: null,
      invoiceUrl: "https://drive.google.com/file/d/ABC123/view?usp=drivesdk", extras: [], group: "SERVICIO",
      rubroId: "r3", coeficienteId: "cA" },
    { fixedExpenseId: "fx2", obligationId: "ob2", providerId: "p1", lspServiceId: null,
      facturas: null, concepto: "SEGURO LA CAJA", fantasia: null, monto: null, aliasCbu: [],
      status: "PENDING", active: true, invoiceId: null, carryOverRequested: false, carriedIn: false, carriedOutTo: null, invoiceUrl: null, extras: [], group: "PROVEEDOR",
      rubroId: "r3", coeficienteId: "cA" },
    { fixedExpenseId: "fx3", obligationId: "ob3", providerId: "p2", lspServiceId: null,
      facturas: null, concepto: "N.G. FUMIGACION", fantasia: "FUMIGACIONES MIGUEL", monto: null, aliasCbu: [],
      status: "SKIPPED", active: true, invoiceId: null, carryOverRequested: false, carriedIn: false, carriedOutTo: null, invoiceUrl: null, extras: [], group: "PROVEEDOR",
      rubroId: "r3", coeficienteId: "cA" },
  ],
  carried: [],
  others: [],
  rubros: [{ id: "r3", order: 3, name: "SERVICIOS PÚBLICOS" }],
  coefColumns: [{ id: "cA", code: "A" }],
};

/** Impaga arrastrada del mes anterior; por defecto en el rubro 3, columna A. */
function arrastrada(over: Partial<SheetData["carried"][number]> = {}): SheetData["carried"][number] {
  return {
    invoiceId: "inv9", facturas: null, concepto: "ASCENSORES POTENZA", monto: 118000,
    originalAmount: 118000, lateAmount: null, aliasCbu: [], fromLabel: "junio 2026",
    carryOverRequested: false, invoiceUrl: null, rubroId: "r3", coeficienteId: "cA", ...over,
  };
}

/** Abre el menú «Acciones ▾» de la fila del concepto y elige un item. */
async function elegirAccion(concepto: string, item: string) {
  const fila = screen.getByText(concepto).closest("tr")!;
  await userEvent.click(within(fila).getByRole("button", { name: `Acciones de ${concepto}` }));
  await userEvent.click(within(fila).getByRole("menuitem", { name: item }));
}

/** Items del menú «Acciones ▾» de la fila (abre el menú y lo deja abierto). */
async function itemsDelMenu(concepto: string) {
  const fila = screen.getByText(concepto).closest("tr")!;
  await userEvent.click(within(fila).getByRole("button", { name: `Acciones de ${concepto}` }));
  return within(fila).getAllByRole("menuitem").map((i) => i.textContent);
}

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
    for (const header of ["FACTURA/NRO CLIENTE", "PROVEEDOR/SERVICIO", "A", "ALIAS - CBU"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    // Se sacaron de la pantalla (owner, 2026-09-27): sólo van en el PDF.
    expect(screen.queryByRole("columnheader", { name: "TÉCNICO O GESTOR" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "TEL. CONTACTO" })).toBeNull();
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

  it("una fila pendiente ofrece omitir y desactivar desde el menú Acciones", async () => {
    const props = renderCard();

    expect(await itemsDelMenu("SEGURO LA CAJA")).toEqual(["Omitir", "Desactivar"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Omitir" }));
    // Elegir cierra el menú. Primero pregunta y explica; recién al confirmar ejecuta.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(props.onSetStatus).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: /omitir seguro la caja en julio 2026/i });
    expect(dialog).toHaveTextContent(/no sale en el PDF del banco/i);
    expect(dialog).toHaveTextContent(/Incluir/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Omitir" }));
    expect(props.onSetStatus).toHaveBeenCalledWith("ob2", "SKIPPED");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Omitir es para "este mes no corresponde"; la boleta impaga va por Mes siguiente.
  it("el diálogo de omitir deriva la boleta impaga a «Mes siguiente»", async () => {
    renderCard();
    await elegirAccion("SEGURO LA CAJA", "Omitir");
    expect(screen.getByRole("dialog")).toHaveTextContent(/usá «Mes siguiente»/);
  });

  it("desactivar pregunta, explica que no se borra nada, y Cancelar no ejecuta", async () => {
    const props = renderCard();
    await elegirAccion("SEGURO LA CAJA", "Desactivar");
    const dialog = screen.getByRole("dialog", { name: /desactivar seguro la caja/i });
    expect(dialog).toHaveTextContent(/No se borra nada/);
    // El foco arranca en Cancelar: un Enter de más no confirma.
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(props.onToggle).not.toHaveBeenCalled();
  });

  it("Escape cierra la confirmación sin ejecutar", async () => {
    const props = renderCard();
    await elegirAccion("SEGURO LA CAJA", "Omitir");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(props.onSetStatus).not.toHaveBeenCalled();
  });

  // Una acción por estado: la única que se ofrece es la que lo revierte.
  it("una fila omitida sólo ofrece Incluir, sin menú de acciones", async () => {
    const props = renderCard();
    const salteada = screen.getByText("N.G. FUMIGACION").closest("tr")!;

    expect(within(salteada).queryByRole("button", { name: /Acciones de/ })).not.toBeInTheDocument();
    expect(within(salteada).queryByRole("button", { name: "Desactivar" })).not.toBeInTheDocument();

    await userEvent.click(within(salteada).getByRole("button", { name: "Incluir" }));
    expect(props.onSetStatus).toHaveBeenCalledWith("ob3", "PENDING");
  });

  // Verificación del comportamiento real de "Omitir": la fila omitida queda
  // tachada/atenuada (`rowSkipped`), baja al final de su rubro y no lleva la
  // marca "—" de pendiente.
  it("una fila salteada queda tachada, al final de su rubro y sin marca de pendiente", () => {
    renderCard();
    const salteada = screen.getByText("N.G. FUMIGACION").closest("tr")!;
    expect(salteada.className).toMatch(/rowSkipped/);
    expect(within(salteada).queryByText("—")).toBeNull();
    const filas = within(salteada.closest("tbody")!).getAllByRole("row");
    // la última es el total; la anterior, la salteada
    expect(filas[filas.length - 2]).toBe(salteada);
  });

  it("una fila con boleta recibida no ofrece omitir: el menú sólo trae Desactivar", async () => {
    renderCard();
    expect(await itemsDelMenu("EDESUR")).toEqual(["Desactivar"]);
  });

  it("en la celda de acciones, «Acciones ▾» va al final, después de Mes siguiente", () => {
    renderCard();
    const recibida = screen.getByText("EDESUR").closest("tr")!;
    const botones = within(recibida).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(botones).toContain("Mes siguiente");
    expect(botones[botones.length - 1]).toBe("Acciones de EDESUR");
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

    expect(screen.queryByRole("button", { name: /Acciones de/ })).not.toBeInTheDocument();

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
    await elegirAccion("SEGURO LA CAJA", "Omitir");
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Omitir" }));

    expect(within(dialog).getByRole("button", { name: /Omitiendo/ })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /Omitiendo/ })).toHaveAttribute("aria-busy", "true");

    await act(async () => { release(); await gate; });
    expect(onSetStatus).toHaveBeenCalledTimes(1);
  });

  it("el doble click no dispara la acción dos veces", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    const onToggle = vi.fn().mockReturnValue(gate);

    renderCard({ onToggle });
    await elegirAccion("SEGURO LA CAJA", "Desactivar");
    const boton = within(screen.getByRole("dialog")).getByRole("button", { name: "Desactivar" });

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
    await elegirAccion("SEGURO LA CAJA", "Desactivar");
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Desactivar" }));

    expect(within(dialog).getByRole("button", { name: /Desactivando/ })).toBeDisabled();
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
      carried: [arrastrada({ invoiceId: "inv-ago", concepto: "EDESUR S.A.", monto: 980000, originalAmount: 980000, fromLabel: "agosto 2026" })],
    };
    const { container: c3 } = render(<SheetCard sheet={soloImpaga} {...noop} />);
    expect(c3.querySelector("section")).toHaveAttribute("data-printable", "true");
  });

  it("un edificio sin gastos fijos avisa y no dibuja tabla", () => {
    renderCard({ sheet: { ...sheet, rows: [] } });
    expect(screen.getByText(/sin gastos fijos cargados/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("ya no existe el bloque aparte «Vienen del mes anterior»", () => {
    renderCard({ sheet: { ...sheet, carried: [arrastrada()] } });
    expect(screen.queryByText(/Vienen del mes anterior/i)).not.toBeInTheDocument();
  });

  it("la arrastrada va dentro de su rubro, con «de junio» (sin año), y suma en el total del rubro y del mes", () => {
    renderCard({ sheet: { ...sheet, carried: [arrastrada()] } });
    const fila = screen.getByText("ASCENSORES POTENZA").closest("tr")!;
    expect(fila.closest("tbody")).toBe(screen.getByText("3 SERVICIOS PÚBLICOS").closest("tbody"));
    expect(fila.className).toMatch(/rowCarried/);
    expect(within(fila).getByText("de junio")).toBeInTheDocument();
    expect(within(fila).queryByText(/2026/)).toBeNull();
    // Columna A (índice 3): su monto.
    expect(within(fila).getAllByRole("cell")[3].textContent).toMatch(/118\.000/);
    // EDESUR 118.000 + arrastrada 118.000.
    const total = within(screen.getByText("TOTAL RUBRO 3").closest("tr")!).getAllByRole("cell");
    expect(total[2].textContent).toBe("236.000,00");
    const mes = within(screen.getByText("TOTAL DEL MES").closest("tr")!).getAllByRole("cell");
    expect(mes[2].textContent).toBe("236.000,00");
  });

  it("una arrastrada sin rubro va a 'Sin rubro'", async () => {
    renderCard({ sheet: { ...sheet, carried: [arrastrada({ rubroId: null })] } });
    await userEvent.click(screen.getByRole("button", { name: /sin rubro \(1\)/i }));
    const fila = screen.getByText("ASCENSORES POTENZA").closest("tr")!;
    expect(fila.closest("tbody")).not.toBe(screen.getByText("3 SERVICIOS PÚBLICOS").closest("tbody"));
    expect(within(fila.closest("tbody")!).getByText("TOTAL SIN RUBRO")).toBeInTheDocument();
  });

  it("un edificio que sólo tiene arrastradas dibuja su sección y el total del mes", () => {
    renderCard({ sheet: { ...sheet, rows: [], carried: [arrastrada()] } });
    expect(screen.getByText("3 SERVICIOS PÚBLICOS")).toBeInTheDocument();
    expect(screen.getByText("ASCENSORES POTENZA")).toBeInTheDocument();
    expect(screen.getByText("TOTAL DEL MES")).toBeInTheDocument();
  });

  it("ya no ofrece traer boletas de meses anteriores", async () => {
    // El traspaso se decide en el mes de ORIGEN, no tirando desde el destino.
    renderCard({ sheet: { ...sheet, carried: [arrastrada()] } });

    expect(screen.queryByRole("button", { name: /pasar a este per/i })).not.toBeInTheDocument();
  });

  it("en el origen, la fila cuya boleta pasó dice «pasó a agosto», queda atenuada y sin acciones", () => {
    renderCard({
      sheet: { ...sheet, rows: [{ ...sheet.rows[0], status: "CARRIED_OVER", carriedOutTo: "agosto 2026" }] },
    });
    const fila = screen.getByText("EDESUR").closest("tr")!;
    expect(fila.className).toMatch(/rowCarriedOut/);
    expect(within(fila).getByText("pasó a agosto")).toBeInTheDocument();
    expect(within(fila).queryAllByRole("button").filter((b) => !/vista previa/i.test(b.getAttribute("aria-label") ?? "")))
      .toEqual([]);
    // No suma: el total del rubro queda vacío.
    const total = within(screen.getByText("TOTAL RUBRO 3").closest("tr")!).getAllByRole("cell");
    expect(total[2].textContent).toBe("");
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
    const props = renderCard({ sheet: { ...sheet, carried: [arrastrada()] } });

    await user.click(screen.getByRole("button", { name: "Monto vencido" }));
    await user.type(screen.getByLabelText(/monto vencido de ASCENSORES POTENZA/i), "130000");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(props.onSetLateAmount).toHaveBeenCalledWith("inv9", 130000);
  });

  it("con monto vencido cargado muestra el 1° y el 2° pago", () => {
    renderCard({ sheet: { ...sheet, carried: [arrastrada({ monto: 130000, lateAmount: 130000 })] } });

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
    const props = renderCard({ sheet: { ...sheet, carried: [arrastrada()] } });

    const fila = screen.getByText("ASCENSORES POTENZA").closest("tr")!;
    await user.click(within(fila).getByRole("button", { name: "Mes siguiente" }));

    expect(props.onToggleCarryOver).toHaveBeenCalledWith("inv9", true);
  });

  it("una arrastrada se puede devolver a su mes de origen", async () => {
    const user = userEvent.setup();
    const props = renderCard({ sheet: { ...sheet, carried: [arrastrada()] } });

    await user.click(screen.getByRole("button", { name: "Devolver" }));

    expect(props.onUndoCarryOver).toHaveBeenCalledWith("inv9");
  });

  it("una arrastrada ofrece el editor de etiqueta y guarda sobre su boleta", async () => {
    // Sin etiqueta (vinculada antes del 2026-09-27 y sin respaldo): cae en
    // "Sin rubro", y desde acá el owner la acomoda sin esperar al mes de origen.
    const props = renderCard({ sheet: { ...sheet, carried: [arrastrada({ rubroId: null, coeficienteId: null })] } });
    await userEvent.click(screen.getByRole("button", { name: /sin rubro \(1\)/i }));
    const fila = screen.getByText("ASCENSORES POTENZA").closest("tr")!;
    await userEvent.click(within(fila).getByRole("button", { name: "Rubro y coeficiente de ASCENSORES POTENZA" }));
    await userEvent.selectOptions(screen.getByLabelText("Rubro de ASCENSORES POTENZA"), "r3");
    await userEvent.selectOptions(screen.getByLabelText("Coeficiente de ASCENSORES POTENZA"), "cA");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(props.onSetLabels).toHaveBeenCalledWith({ invoiceId: "inv9" }, { rubroId: "r3", coeficienteId: "cA" });
  });
});

describe("adicionales y otras boletas del mes", () => {
  const extra = (over: Partial<SheetData["rows"][number]["extras"][number]> = {}) => ({
    invoiceId: "inv2", facturas: null, monto: 54000, invoiceUrl: "https://drive.google.com/file/d/X2/view",
    carryOverRequested: false, carriedOutTo: null, ...over,
  });
  const other = (over: Partial<SheetData["others"][number]> = {}) => ({
    invoiceId: "o1", facturas: null, concepto: "PLOMERO JUAN", fantasia: "JUAN", monto: 32000,
    aliasCbu: ["juan.plomero"], invoiceUrl: "https://drive.google.com/file/d/O1/view",
    carryOverRequested: false, carriedOutTo: null, group: "PROVEEDOR" as const, ...over,
  });

  /** La 2ª fila con el nombre de la madre: la adicional (la 1ª es la madre). */
  const filaExtra = (concepto = "EDESUR") => screen.getAllByText(concepto)[1].closest("tr")!;

  it("una adicional se dibuja debajo de su madre con su monto y ofrece pasarla al mes siguiente", async () => {
    const props = renderCard({ sheet: { ...sheet, rows: [{ ...sheet.rows[0], extras: [extra()] }] } });
    expect(screen.queryByText(/2ª boleta/)).toBeNull();
    const fila = filaExtra();
    expect(fila.previousElementSibling).toBe(screen.getAllByText("EDESUR")[0].closest("tr"));
    expect(within(fila).getByText(/54\.000/)).toBeInTheDocument();
    expect(within(fila).getByText("edesur.pago")).toBeInTheDocument();
    expect(within(fila).queryByRole("button", { name: /acciones de/i })).toBeNull();
    expect(within(fila).queryByRole("button", { name: /desactivar/i })).toBeNull();
    await userEvent.click(within(fila).getByRole("button", { name: /mes siguiente/i }));
    expect(props.onToggleCarryOver).toHaveBeenCalledWith("inv2", true);
  });

  it("una adicional ofrece la vista previa de SU pdf", async () => {
    renderCard({ sheet: { ...sheet, rows: [{ ...sheet.rows[0], extras: [extra()] }] } });
    await userEvent.click(within(filaExtra()).getByRole("button", { name: /vista previa de la boleta de edesur/i }));
    expect(within(screen.getByRole("dialog")).getByTitle("Vista previa de boleta")).toHaveAttribute(
      "src", expect.stringContaining("X2")
    );
  });

  it("una adicional muestra su propio nro. de factura", () => {
    renderCard({ sheet: { ...sheet, rows: [{ ...sheet.rows[0], extras: [extra({ facturas: "0003-00001234" })] }] } });
    expect(within(filaExtra()).getByText("0003-00001234")).toBeInTheDocument();
  });

  it("una adicional con coeficiente propio va en esa columna y se edita como boleta suelta", async () => {
    const conCoefs: SheetData = {
      ...sheet,
      coefColumns: [{ id: "cA", code: "A" }, { id: "cB", code: "B" }],
      rows: [{ ...sheet.rows[0], coeficienteId: "cA", extras: [extra({ coeficienteId: "cB" })] }],
    };
    const props = renderCard({ sheet: conCoefs });
    const celdas = within(filaExtra()).getAllByRole("cell");
    expect(celdas[3].textContent).toBe("");
    expect(celdas[4].textContent).toMatch(/54\.000/);
    await userEvent.click(within(filaExtra()).getByRole("button", { name: /rubro y coeficiente de edesur/i }));
    await userEvent.selectOptions(screen.getByLabelText("Coeficiente de EDESUR"), "cA");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(props.onSetLabels).toHaveBeenCalledWith({ invoiceId: "inv2" }, { rubroId: "r3", coeficienteId: "cA" });
  });

  it("una adicional que pasó a otro mes lo dice y no tiene acciones", () => {
    renderCard({ sheet: { ...sheet, rows: [{ ...sheet.rows[0], extras: [extra({ carriedOutTo: "agosto 2026" })] }] } });
    const fila = filaExtra();
    expect(within(fila).getByText("pasó a agosto")).toBeInTheDocument();
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
    const celda = screen.getByText("00481983740001…");
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
        carryOverRequested: false, carriedIn: false, carriedOutTo: null, invoiceUrl: null, extras: [], group: "EMPLEADO" },
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
    const total = screen.getByText("TOTAL RUBRO 3").closest("tr")!;
    const celdas = within(total).getAllByRole("cell").map((c) => c.textContent);
    expect(celdas.some((t) => /118\.000/.test(t ?? ""))).toBe(true);
  });

  it("un rubro sin nada cargado no se dibuja", () => {
    renderCard({ sheet: dosRubros });
    expect(screen.queryByText("4 ABONOS DE SERVICIOS")).toBeNull();
    expect(screen.queryByText("TOTAL RUBRO 4")).toBeNull();
  });

  it("cada rubro es un bloque propio (un tbody con fondo)", () => {
    renderCard({ sheet: { ...dosRubros, rows: [dosRubros.rows[0], { ...dosRubros.rows[1], rubroId: "r4" }] } });
    const bloque3 = screen.getByText("3 SERVICIOS PÚBLICOS").closest("tbody")!;
    const bloque4 = screen.getByText("4 ABONOS DE SERVICIOS").closest("tbody")!;
    expect(bloque3).not.toBe(bloque4);
    expect(bloque3.className).toMatch(/rubroBlock/);
    expect(within(bloque3).getByText("TOTAL RUBRO 3")).toBeInTheDocument();
  });

  it("un total en cero deja la celda vacía", () => {
    renderCard({ sheet: dosRubros });
    const celdas = within(screen.getByText("TOTAL RUBRO 3").closest("tr")!).getAllByRole("cell");
    // preview, rótulo, A (0), B (118.000), …
    expect(celdas[2].textContent).toBe("");
    expect(celdas[3].textContent).toMatch(/118\.000/);
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
    expect(celdas[celdas.length - 1].className).toMatch(/actionsCell/);
  });

  // Un `td` con `display: flex` deja de ser celda y su borde queda desfasado
  // del de la fila: el flex vive en un div de adentro.
  it("las acciones van dentro de un div, no en el flex del td", () => {
    renderCard({ sheet: dosRubros });
    const fila = screen.getByText("EDESUR").closest("tr")!;
    const acciones = within(fila).getByRole("button", { name: "Acciones de EDESUR" }).closest("td")!;
    expect(acciones.className).toMatch(/actionsCell/);
    expect(acciones.firstElementChild!.className).toMatch(/rowActions/);
  });

  it("si todos los rubros están vacíos, la tabla de rubros no se dibuja", () => {
    const sinEtiquetar = { ...dosRubros, rows: dosRubros.rows.map((r) => ({ ...r, rubroId: null })) };
    renderCard({ sheet: sinEtiquetar });
    expect(screen.queryByText("3 SERVICIOS PÚBLICOS")).toBeNull();
    expect(screen.getByRole("button", { name: /sin rubro \(2\)/i })).toHaveAttribute("aria-expanded", "true");
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
    const bloque = screen.getByText("3 SERVICIOS PÚBLICOS").closest("tbody")!;
    expect(bloque.className).toMatch(/sectionEmpty/);
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
    expect(screen.queryByRole("button", { name: "Acciones de SEGURO LA CAJA" })).toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Acciones de SEGURO LA CAJA" })).toBeInTheDocument();
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
