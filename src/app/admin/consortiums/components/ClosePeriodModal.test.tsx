import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClosePeriodModal } from "./ClosePeriodModal";

function setup(overrides: Partial<React.ComponentProps<typeof ClosePeriodModal>> = {}) {
  const props = {
    periodLabel: "Julio 2026",
    consortiumName: "THAMES 647",
    error: null as string | null,
    saving: false,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
  render(<ClosePeriodModal {...props} />);
  return props;
}

describe("ClosePeriodModal", () => {
  it("muestra el período y el consorcio", () => {
    setup();
    expect(screen.getByText("Julio 2026")).toBeInTheDocument();
    expect(screen.getByText("THAMES 647")).toBeInTheDocument();
  });
  it("click en 'Confirmar cierre' dispara onSubmit", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Confirmar cierre/ }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
  it("saving deshabilita y muestra 'Cerrando...'", () => {
    setup({ saving: true });
    expect(screen.getByRole("button", { name: /Cerrando/ })).toBeDisabled();
  });
  it("muestra el error", () => {
    setup({ error: "No se pudo" });
    expect(screen.getByText("No se pudo")).toBeInTheDocument();
  });
});
