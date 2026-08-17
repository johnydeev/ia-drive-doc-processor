import { describe, expect, it } from "vitest";
import { parseProviderType } from "./providerType";

describe("parseProviderType", () => {
  it("reconoce SERVICIO", () => {
    expect(parseProviderType("SERVICIO")).toBe("SERVICIO");
  });

  it("reconoce EMPLEADO", () => {
    expect(parseProviderType("EMPLEADO")).toBe("EMPLEADO");
  });

  it("ignora mayúsculas y espacios de la celda", () => {
    expect(parseProviderType("  servicio ")).toBe("SERVICIO");
    expect(parseProviderType(" Empleado")).toBe("EMPLEADO");
  });

  it("celda vacía o ausente cae a PROVEEDOR", () => {
    expect(parseProviderType("")).toBe("PROVEEDOR");
    expect(parseProviderType(undefined)).toBe("PROVEEDOR");
    expect(parseProviderType(null)).toBe("PROVEEDOR");
  });

  // Sesgo conservador: un valor que no entendemos NO convierte al proveedor en
  // otra cosa. PROVEEDOR es el default de la columna en la base.
  it("texto no reconocido cae a PROVEEDOR", () => {
    expect(parseProviderType("PRESTADOR")).toBe("PROVEEDOR");
  });
});
