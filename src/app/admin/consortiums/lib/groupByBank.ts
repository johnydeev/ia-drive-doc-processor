// Agrupación de la vista nivel 0: consorcios bajo la card de su banco.
// Lógica pura, sin React: se testea sin montar nada.
import { normName } from "./match";
import type { Bank, BankGroup, Consortium } from "./types";

/** Id centinela del grupo de consorcios sin banco asignado. */
export const UNASSIGNED_BANK_ID = "__unassigned__";

/**
 * Arma los grupos de la grilla de bancos.
 *
 * Reglas de búsqueda (`query`):
 * - Si el nombre del BANCO matchea, el grupo se muestra con todos sus consorcios.
 * - Si no, el grupo se muestra sólo si alguno de sus consorcios matchea, y en ese
 *   caso se recorta a los que matchean.
 * - Los bancos sin consorcios se muestran igual (con query vacío), para que un
 *   banco recién creado sea visible.
 */
export function groupByBank(banks: Bank[], consortiums: Consortium[], query: string): BankGroup[] {
  const q = normName(query);
  const matchesConsortium = (c: Consortium) =>
    !q || normName(c.rawName).includes(q) || normName(c.canonicalName).includes(q);

  const groups: BankGroup[] = [];

  for (const bank of banks) {
    const own = consortiums.filter((c) => c.bankId === bank.id);
    const bankMatches = !q || normName(bank.name).includes(q);
    const visible = bankMatches ? own : own.filter(matchesConsortium);

    if (!bankMatches && visible.length === 0) continue;
    groups.push({ id: bank.id, name: bank.name, color: bank.color, consortiums: visible });
  }

  const orphans = consortiums.filter((c) => !c.bankId).filter(matchesConsortium);
  if (orphans.length > 0) {
    groups.push({ id: UNASSIGNED_BANK_ID, name: "Sin banco", color: "slate", consortiums: orphans });
  }

  return groups;
}
