/**
 * VEP (Volante Electrónico de Pago) de ARCA — el cupón con el que un consorcio
 * paga las cargas sociales de su encargado.
 *
 * Prompt propio y no `buildArcaPrompt`: ese está escrito para la declaración
 * jurada F931 de dos páginas, donde el importe vive en la página 2. Un VEP es un
 * cupón simple con todos sus campos rotulados.
 *
 * Ver `docs/superpowers/specs/2026-09-03-vep-arca-como-gasto-design.md`.
 */
export function buildVepPrompt(text: string): string {
  return [
    "Sos un extractor de datos de un VEP (Volante Electrónico de Pago) de ARCA, Argentina.",
    "Devolvé SOLO JSON con esta forma:",
    '{ "boletaNumber": "...", "provider": "ARCA", "providerTaxId": null,',
    '  "consortium": null, "amount": 0, "dueDate": "YYYY-MM-DD|null",',
    '  "detail": "...", "observation": "...", "clientNumber": null,',
    '  "paymentMethod": null, "allTaxIds": ["XX-XXXXXXXX-X"], "isBoleta": true }',
    "",
    "- boletaNumber: el valor de 'Nro. VEP'.",
    '- provider: SIEMPRE la cadena "ARCA". No la deduzcas del papel.',
    "- providerTaxId: SIEMPRE null. ARCA no imprime su CUIT en el VEP.",
    "- consortium: SIEMPRE null. El VEP no imprime la dirección del inmueble; el edificio",
    "  se resuelve por el CUIT del contribuyente.",
    "- amount: el valor de 'Importe total a pagar' (el total, no los conceptos sueltos).",
    "- dueDate: el valor de 'Día de Expiración'.",
    "- detail: 'Descripción Reducida' y 'Período', separados por ' · '.",
    "- observation: el 'Período' de la obligación, tal como figura.",
    "- clientNumber: SIEMPRE null. Un VEP no tiene número de cliente; el 'Nro. VEP' ya va",
    "  en boletaNumber.",
    "- paymentMethod: null.",
    "",
    "- allTaxIds: SOLO el CUIT rotulado 'CUIT:' — es el del CONTRIBUYENTE, o sea el",
    "  consorcio que paga. Es el único CUIT que hay que devolver.",
    "- **NO uses ni devuelvas el número que figura en 'Generado por el Usuario'.** Es el",
    "  CUIT de quien generó el trámite (la administradora), NO el del contribuyente, y",
    "  aparece en todos los VEP. Confundirlos imputa el gasto a la persona equivocada.",
    "",
    "Texto del VEP:",
    text,
  ].join("\n");
}
