// src/test/jsdom-smoke.test.tsx — valida que el entorno jsdom + testing-library + jest-dom funciona.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

describe("infra jsdom", () => {
  it("renderiza un componente y expone matchers de jest-dom", () => {
    render(<div>hola jsdom</div>);
    expect(screen.getByText("hola jsdom")).toBeInTheDocument();
  });
});
