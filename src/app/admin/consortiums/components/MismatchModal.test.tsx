import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MismatchModal } from "./MismatchModal";

describe("MismatchModal", () => {
  it("muestra el consorcio encontrado y dispara onDismiss", async () => {
    const onDismiss = vi.fn();
    render(<MismatchModal consortiumName="OTRO CONSORCIO" onDismiss={onDismiss} />);
    expect(screen.getByText("OTRO CONSORCIO")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /cancelar carga/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
