import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  it("es un switch: prendido en modo oscuro, apagado en claro", () => {
    const { rerender } = render(<ThemeToggle theme="dark" onToggle={() => {}} />);
    expect(screen.getByRole("switch", { name: /modo oscuro/i })).toHaveAttribute("aria-checked", "true");
    rerender(<ThemeToggle theme="light" onToggle={() => {}} />);
    expect(screen.getByRole("switch", { name: /modo oscuro/i })).toHaveAttribute("aria-checked", "false");
  });

  it("el tooltip dice a qué modo se pasa", () => {
    const { rerender } = render(<ThemeToggle theme="dark" onToggle={() => {}} />);
    expect(screen.getByRole("switch")).toHaveAttribute("title", "Cambiar a modo claro");
    rerender(<ThemeToggle theme="light" onToggle={() => {}} />);
    expect(screen.getByRole("switch")).toHaveAttribute("title", "Cambiar a modo oscuro");
  });

  it("el click dispara onToggle", async () => {
    const onToggle = vi.fn();
    render(<ThemeToggle theme="dark" onToggle={onToggle} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("deshabilitado no dispara", async () => {
    const onToggle = vi.fn();
    render(<ThemeToggle theme="dark" onToggle={onToggle} disabled />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
