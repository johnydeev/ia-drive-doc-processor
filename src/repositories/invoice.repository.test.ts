import { describe, expect, it } from "vitest";
import { InvoiceRepository } from "@/repositories/invoice.repository";

/**
 * `deriveDocumentHash` es puro (no toca la base), así que se testea directo.
 * Existe porque `Invoice` tiene unique `(clientId, documentHash)`: las N boletas
 * de un mismo Liquidación de Sueldos comparten el PDF y lo violarían.
 */
describe("InvoiceRepository.deriveDocumentHash", () => {
  const repo = new InvoiceRepository();

  it("deriva un hash distinto por CUIL", () => {
    const a = repo.deriveDocumentHash("abc123", "27-18116846-9");
    const b = repo.deriveDocumentHash("abc123", "20-24883768-4");
    expect(a).not.toBe(b);
  });

  it("es estable entre corridas", () => {
    expect(repo.deriveDocumentHash("abc123", "27-18116846-9")).toBe(
      repo.deriveDocumentHash("abc123", "27-18116846-9")
    );
  });

  it("ignora el formato del CUIL", () => {
    expect(repo.deriveDocumentHash("abc123", "27-18116846-9")).toBe(
      repo.deriveDocumentHash("abc123", "27181168469")
    );
  });

  it("cambia si cambia el archivo", () => {
    expect(repo.deriveDocumentHash("abc123", "27-18116846-9")).not.toBe(
      repo.deriveDocumentHash("otro-hash", "27-18116846-9")
    );
  });

  it("nunca coincide con el hash del archivo pelado", () => {
    expect(repo.deriveDocumentHash("abc123", "27-18116846-9")).not.toBe("abc123");
  });
});
