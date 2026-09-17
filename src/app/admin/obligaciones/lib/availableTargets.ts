import { firstMatchName, type OverviewConsortium, type OverviewPayload } from "./sheetModel";

export type TargetOption = {
  kind: "provider" | "lsp";
  id: string;
  label: string;
  /** FACTURA o RETENCION (spec 2026-09-17). Los LSP son siempre FACTURA. */
  expenseKind: "FACTURA" | "RETENCION";
};

export type AvailableTargets = {
  lsp: TargetOption[];
  providers: TargetOption[];
};

function norm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // saca los acentos: "FUMIGACIÓN" matchea con "fumigacion"
    .toLowerCase()
    .trim();
}

/**
 * Etiqueta del proveedor en el selector: razón social y, si tiene, el primer
 * nombre de fantasía entre paréntesis. La búsqueda filtra sobre la etiqueta
 * completa, así "popular" encuentra a "REY MONICA ALEJANDRA (LA POPULAR)".
 */
function providerLabel(p: OverviewPayload["providers"][number]): string {
  const fantasia = firstMatchName(p.matchNames);
  return fantasia ? `${p.canonicalName} (${fantasia})` : p.canonicalName;
}

/**
 * Qué puede agregarse todavía a este consorcio.
 *
 * Saca de las listas lo que ya está cargado — **incluidos los gastos fijos
 * desactivados**, porque el índice único de la base es por objetivo y no mira
 * `active`: ofrecerlos llevaría a un 409. Para volver a usar uno desactivado,
 * el camino es reactivarlo desde la fila.
 */
export function availableTargets(
  consortium: OverviewConsortium,
  providers: OverviewPayload["providers"],
  query: string
): AvailableTargets {
  // Un proveedor puede estar cargado dos veces, una por tipo: lo usado se mira por
  // (proveedor, tipo), así la retención sigue ofreciéndose con la factura ya cargada.
  const usedProvider = new Set(
    consortium.fixedExpenses.filter((fx) => fx.providerId).map((fx) => `${fx.providerId}:${fx.kind}`)
  );
  const usedLspIds = new Set(
    consortium.fixedExpenses.map((fx) => fx.lspServiceId).filter((id): id is string => Boolean(id))
  );

  const q = norm(query);
  const matches = (label: string) => !q || norm(label).includes(q);

  const lsp: TargetOption[] = consortium.lspServices
    .filter((l) => !usedLspIds.has(l.id))
    .map((l) => ({ kind: "lsp" as const, id: l.id, label: `${l.providerName} (${l.clientNumber})`, expenseKind: "FACTURA" as const }))
    .filter((o) => matches(o.label))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));

  // Cada proveedor ofrece su factura y, aparte, su retención (spec 2026-09-17):
  // "X" y "X — Retención". El sort por etiqueta deja la retención debajo de la factura.
  const provs: TargetOption[] = providers
    .flatMap((p) => [
      { kind: "provider" as const, id: p.id, label: providerLabel(p), expenseKind: "FACTURA" as const },
      { kind: "provider" as const, id: p.id, label: `${providerLabel(p)} — Retención`, expenseKind: "RETENCION" as const },
    ])
    .filter((o) => !usedProvider.has(`${o.id}:${o.expenseKind}`))
    .filter((o) => matches(o.label))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));

  return { lsp, providers: provs };
}
