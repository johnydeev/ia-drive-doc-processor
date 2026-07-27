import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CloseAllModal } from "./CloseAllModal";

const preview = { majorityMonth: "Julio 2026", nextMonth: "Agosto 2026", toClose: [{ id: "c1", canonicalName: "THAMES", currentPeriod: "Julio 2026" }], toSkip: [] };

describe("CloseAllModal", () => {
  it("preview: muestra el mes y dispara onExecute", async () => {
    const onExecute = vi.fn();
    render(<CloseAllModal step="preview" preview={preview} loading={false} result={null} error={null} onClose={vi.fn()} onExecute={onExecute} />);
    expect(screen.getByText("Julio 2026")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Confirmar/ }));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });
  it("result: muestra cerrados/salteados", () => {
    render(<CloseAllModal step="result" preview={null} loading={false} result={{ closed: 3, skipped: 1, warnings: [] }} error={null} onClose={vi.fn()} onExecute={vi.fn()} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
