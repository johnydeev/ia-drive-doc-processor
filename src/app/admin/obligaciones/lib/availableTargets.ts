import type { OverviewConsortium, OverviewPayload } from "./sheetModel";

export type TargetOption = {
  kind: "provider" | "lsp";
  id: string;
  label: string;
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
  const usedProviderIds = new Set(
    consortium.fixedExpenses.map((fx) => fx.providerId).filter((id): id is string => Boolean(id))
  );
  const usedLspIds = new Set(
    consortium.fixedExpenses.map((fx) => fx.lspServiceId).filter((id): id is string => Boolean(id))
  );

  const q = norm(query);
  const matches = (label: string) => !q || norm(label).includes(q);

  const lsp: TargetOption[] = consortium.lspServices
    .filter((l) => !usedLspIds.has(l.id))
    .map((l) => ({ kind: "lsp" as const, id: l.id, label: `${l.providerName} (${l.clientNumber})` }))
    .filter((o) => matches(o.label))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));

  const provs: TargetOption[] = providers
    .filter((p) => !usedProviderIds.has(p.id))
    .map((p) => ({ kind: "provider" as const, id: p.id, label: p.canonicalName }))
    .filter((o) => matches(o.label))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));

  return { lsp, providers: provs };
}
