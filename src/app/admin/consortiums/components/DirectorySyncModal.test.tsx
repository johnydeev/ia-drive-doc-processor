import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DirectorySyncModal } from "./DirectorySyncModal";
import type { DirectorySyncReport } from "../lib/types";

const vacio = { created: 0, updated: 0, orphans: [] };

const base: DirectorySyncReport = {
  consortiums: { created: 1, updated: 2, orphans: [{ id: "c9", name: "VIEJO 1", invoices: 5 }] },
  providers: vacio,
  rubros: vacio,
  coeficientes: vacio,
  lspServices: vacio,
  oficios: { created: 3, updated: 0, orphans: [] },
  pendingRenames: [],
  ambiguous: [],
  duplicates: [],
  warnings: [],
};

const conRenombre: DirectorySyncReport = {
  ...base,
  pendingRenames: [
    {
      entity: "consortium",
      id: "c1",
      from: "FRIAS 320",
      to: "FRIAS 324",
      cuit: "30-11111111-1",
      invoices: 37,
      periods: 6,
    },
  ],
};

describe("DirectorySyncModal", () => {
  it("muestra el resumen por entidad y los sobrantes con sus boletas", () => {
    render(<DirectorySyncModal report={base} onClose={vi.fn()} onApplyRenames={vi.fn()} />);
    expect(screen.getByText(/1 nuevos, 2 actualizados/)).toBeInTheDocument();
    expect(screen.getByText(/1 en la base que no están en el ALTA/)).toBeInTheDocument();
    expect(screen.getByText("VIEJO 1")).toBeInTheDocument();
    expect(screen.getByText("5 boleta(s)")).toBeInTheDocument();
  });

  // Regresión: la entidad estaba en el reporte del backend pero faltaba en la
  // tabla del modal, así que el sync de oficios corría sin verse.
  it("lista las seis entidades, incluida Oficios", () => {
    render(<DirectorySyncModal report={base} onClose={vi.fn()} onApplyRenames={vi.fn()} />);
    for (const etiqueta of ["Edificios", "Proveedores", "Rubros", "Coeficientes", "Servicios", "Oficios"]) {
      expect(screen.getByText(etiqueta)).toBeInTheDocument();
    }
    expect(screen.getByText(/3 nuevos, 0 actualizados/)).toBeInTheDocument();
  });

  it("sin renombres no ofrece el botón de aplicar", () => {
    render(<DirectorySyncModal report={base} onClose={vi.fn()} onApplyRenames={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /renombre/i })).not.toBeInTheDocument();
  });

  it("muestra el renombre con sus conteos y lo manda al confirmar", async () => {
    const onApplyRenames = vi.fn().mockResolvedValue(undefined);
    render(<DirectorySyncModal report={conRenombre} onClose={vi.fn()} onApplyRenames={onApplyRenames} />);

    expect(screen.getByText(/37 boleta\(s\) · 6 período\(s\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Aplicar 1 renombre/ }));

    expect(onApplyRenames).toHaveBeenCalledWith([{ entity: "consortium", id: "c1", to: "FRIAS 324" }]);
  });

  it("destildar el único renombre deshabilita el botón", async () => {
    render(<DirectorySyncModal report={conRenombre} onClose={vi.fn()} onApplyRenames={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: /Aplicar 0 renombre/ })).toBeDisabled();
  });

  it("cerrar no aplica nada", async () => {
    const onApplyRenames = vi.fn();
    const onClose = vi.fn();
    render(<DirectorySyncModal report={conRenombre} onClose={onClose} onApplyRenames={onApplyRenames} />);
    await userEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(onClose).toHaveBeenCalled();
    expect(onApplyRenames).not.toHaveBeenCalled();
  });

  it("el botón de aplicar da feedback de carga y corta el doble click", async () => {
    let resolver: () => void = () => {};
    const onApplyRenames = vi.fn().mockImplementation(
      () => new Promise<void>((res) => { resolver = res; })
    );
    render(<DirectorySyncModal report={conRenombre} onClose={vi.fn()} onApplyRenames={onApplyRenames} />);

    const boton = screen.getByRole("button", { name: /Aplicar 1 renombre/ });
    await userEvent.click(boton);
    expect(screen.getByText("Aplicando…")).toBeInTheDocument();

    await userEvent.click(boton);
    expect(onApplyRenames).toHaveBeenCalledTimes(1);

    resolver?.();
  });
});

describe("DirectorySyncModal — filas repetidas en el ALTA", () => {
  it("avisa el CUIT repetido con los nombres involucrados", () => {
    render(
      <DirectorySyncModal
        report={{
          ...base,
          duplicates: [
            { entity: "provider", kind: "cuit", value: "20-16654129-9", names: ["ROMERO MIGUEL A", "ROMERO MIGUEL ANGEL"] },
          ],
        }}
        onClose={vi.fn()}
        onApplyRenames={vi.fn()}
      />
    );

    expect(screen.getByText(/no se aplicaron/i)).toBeInTheDocument();
    expect(screen.getByText(/CUIT 20-16654129-9 repetido en: ROMERO MIGUEL A · ROMERO MIGUEL ANGEL/)).toBeInTheDocument();
  });

  it("avisa la razón social repetida", () => {
    render(
      <DirectorySyncModal
        report={{
          ...base,
          duplicates: [
            { entity: "provider", kind: "name", value: "ROMERO RENZI CAMILA", names: ["ROMERO RENZI CAMILA"] },
          ],
        }}
        onClose={vi.fn()}
        onApplyRenames={vi.fn()}
      />
    );

    expect(screen.getByText(/Razón social repetida: ROMERO RENZI CAMILA/)).toBeInTheDocument();
  });

  it("sin repetidos no muestra el bloque", () => {
    render(<DirectorySyncModal report={base} onClose={vi.fn()} onApplyRenames={vi.fn()} />);

    expect(screen.queryByText(/no se aplicaron/i)).not.toBeInTheDocument();
  });
});
