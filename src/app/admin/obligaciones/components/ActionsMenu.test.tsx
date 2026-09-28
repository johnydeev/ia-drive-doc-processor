import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionsMenu } from "./ActionsMenu";

function renderMenu() {
  const omitir = vi.fn();
  const desactivar = vi.fn();
  render(
    <div>
      <p>afuera</p>
      <ActionsMenu
        concepto="EDESUR"
        items={[
          { label: "Omitir", onSelect: omitir },
          { label: "Desactivar", onSelect: desactivar, danger: true },
        ]}
      />
    </div>,
  );
  const boton = screen.getByRole("button", { name: "Acciones de EDESUR" });
  return { omitir, desactivar, boton };
}

describe("ActionsMenu", () => {
  it("arranca cerrado y el botón anuncia que abre un menú", () => {
    const { boton } = renderMenu();
    expect(boton).toHaveAttribute("aria-haspopup", "menu");
    expect(boton).toHaveAttribute("aria-expanded", "false");
    expect(boton).toHaveTextContent("Acciones ▾");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("el click abre y cierra el menú", async () => {
    const { boton } = renderMenu();
    await userEvent.click(boton);
    expect(boton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Omitir", "Desactivar"]);
    await userEvent.click(boton);
    expect(boton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Escape lo cierra", async () => {
    const { boton } = renderMenu();
    await userEvent.click(boton);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(boton).toHaveAttribute("aria-expanded", "false");
  });

  it("un click afuera lo cierra sin elegir nada", async () => {
    const { boton, omitir, desactivar } = renderMenu();
    await userEvent.click(boton);
    await userEvent.click(screen.getByText("afuera"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(omitir).not.toHaveBeenCalled();
    expect(desactivar).not.toHaveBeenCalled();
  });

  it("al abrir, el foco va al primer item y el botón apunta al menú con aria-controls", async () => {
    const { boton } = renderMenu();
    await userEvent.click(boton);
    const menu = screen.getByRole("menu");
    expect(menu.id).not.toBe("");
    expect(boton).toHaveAttribute("aria-controls", menu.id);
    expect(screen.getByRole("menuitem", { name: "Omitir" })).toHaveFocus();
  });

  it("las flechas recorren los items en círculo", async () => {
    const { boton } = renderMenu();
    await userEvent.click(boton);
    const omitir = screen.getByRole("menuitem", { name: "Omitir" });
    const desactivar = screen.getByRole("menuitem", { name: "Desactivar" });
    await userEvent.keyboard("{ArrowDown}");
    expect(desactivar).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(omitir).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(desactivar).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(omitir).toHaveFocus();
  });

  it("Escape devuelve el foco al botón", async () => {
    const { boton } = renderMenu();
    await userEvent.click(boton);
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(boton).toHaveFocus();
    expect(boton).not.toHaveAttribute("aria-controls");
  });

  it("con el teclado: Enter abre y Enter sobre el item lo elige", async () => {
    const { boton, omitir } = renderMenu();
    boton.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Omitir" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(omitir).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("elegir un item llama a su onSelect y cierra el menú", async () => {
    const { boton, omitir, desactivar } = renderMenu();
    await userEvent.click(boton);
    await userEvent.click(screen.getByRole("menuitem", { name: "Desactivar" }));
    expect(desactivar).toHaveBeenCalledTimes(1);
    expect(omitir).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(boton).toHaveAttribute("aria-expanded", "false");
  });

  it("un item sincrónico no deja el botón ocupado", async () => {
    const { boton } = renderMenu();
    await userEvent.click(boton);
    await userEvent.click(screen.getByRole("menuitem", { name: "Omitir" }));
    expect(boton).toBeEnabled();
    expect(boton).toHaveAttribute("aria-busy", "false");
    expect(boton).toHaveTextContent("Acciones ▾");
  });

  it("un item async deja el botón deshabilitado con spinner y su pendingLabel hasta que resuelve", async () => {
    let resolver!: () => void;
    const pasar = vi.fn(() => new Promise<void>((r) => { resolver = r; }));
    render(
      <ActionsMenu
        concepto="EDESUR"
        items={[{ label: "Pasar al mes siguiente", pendingLabel: "Marcando…", onSelect: pasar }]}
      />,
    );
    const boton = screen.getByRole("button", { name: "Acciones de EDESUR" });
    await userEvent.click(boton);
    await userEvent.click(screen.getByRole("menuitem", { name: "Pasar al mes siguiente" }));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(boton).toBeDisabled();
    expect(boton).toHaveAttribute("aria-busy", "true");
    expect(boton).toHaveTextContent("Marcando…");
    expect(boton.querySelector(".asyncSpinner")).not.toBeNull();

    // Deshabilitado, no se puede volver a abrir: una segunda elección no dispara.
    await userEvent.click(boton);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(pasar).toHaveBeenCalledTimes(1);

    await act(async () => resolver());
    expect(boton).toBeEnabled();
    expect(boton).toHaveAttribute("aria-busy", "false");
    expect(boton).toHaveTextContent("Acciones ▾");
    expect(boton.querySelector(".asyncSpinner")).toBeNull();
  });

  it("sin pendingLabel, un item async muestra «Procesando…»", async () => {
    let resolver!: () => void;
    render(
      <ActionsMenu
        concepto="EDESUR"
        items={[{ label: "Devolver", onSelect: () => new Promise<void>((r) => { resolver = r; }) }]}
      />,
    );
    const boton = screen.getByRole("button", { name: "Acciones de EDESUR" });
    await userEvent.click(boton);
    await userEvent.click(screen.getByRole("menuitem", { name: "Devolver" }));
    expect(boton).toHaveTextContent("Procesando…");
    await act(async () => resolver());
    expect(boton).toHaveTextContent("Acciones ▾");
  });
});
