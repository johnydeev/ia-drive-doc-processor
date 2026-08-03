import styles from "../page.module.css";
import type { BankGroup, Consortium } from "../lib/types";

type Props = {
  groups: BankGroup[];
  onSelectBank: (bankId: string) => void;
  onSelectConsortium: (c: Consortium) => void;
};

/**
 * Nivel 0 de la vista general: una card por banco con sus edificios como badges.
 * Al elegir un banco se entra al nivel 1, que es la grilla de edificios de siempre.
 *
 * La card es un `<div>` (no un `<button>`) porque los badges son botones: anidar
 * controles interactivos rompe la semántica y la navegación por teclado.
 */
export function BankGrid({ groups, onSelectBank, onSelectConsortium }: Props) {
  return (
    <div className={styles.cardGrid}>
      {groups.map((group) => (
        <div key={group.id} className={styles.bankCard} data-bank-color={group.color}>
          <button
            type="button"
            className={styles.bankCardHeader}
            onClick={() => onSelectBank(group.id)}
          >
            <span className={styles.cardIcon} aria-hidden="true">🏦</span>
            <span className={styles.cardName}>{group.name}</span>
            <span className={styles.bankCardCount}>
              {group.consortiums.length === 1 ? "1 edificio" : `${group.consortiums.length} edificios`}
            </span>
          </button>

          {group.consortiums.length > 0 ? (
            <div className={styles.bankBadges}>
              {group.consortiums.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={styles.bankBadge}
                  onClick={() => onSelectConsortium(c)}
                >
                  {c.rawName}
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.lspEmpty}>Sin edificios asignados</p>
          )}
        </div>
      ))}
    </div>
  );
}
