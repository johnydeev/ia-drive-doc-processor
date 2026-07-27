import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnassignedModal } from "./UnassignedModal";

describe("UnassignedModal", () => {
  it("preview con archivos: lista y dispara onRequeue", async () => {
    const onRequeue = vi.fn();
    render(<UnassignedModal step="preview" files={[{ id: "f1", name: "a.pdf" }]} folderConfigured={true} result={null} loading={false} onClose={vi.fn()} onRequeue={onRequeue} />);
    expect(screen.getByText("a.pdf")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Mover a Pendientes/ }));
    expect(onRequeue).toHaveBeenCalledTimes(1);
  });
  it("carpeta no configurada", () => {
    render(<UnassignedModal step="preview" files={[]} folderConfigured={false} result={null} loading={false} onClose={vi.fn()} onRequeue={vi.fn()} />);
    expect(screen.getByText(/no está configurada/)).toBeInTheDocument();
  });
  it("result: muestra el resumen", () => {
    render(<UnassignedModal step="result" files={[]} folderConfigured={true} result={{ moved: 2, failed: 0 }} loading={false} onClose={vi.fn()} onRequeue={vi.fn()} />);
    expect(screen.getByText(/2 archivo\(s\) movidos/)).toBeInTheDocument();
  });
});
