/**
 * Lógica pura del "Cerrar Periodo General". Decide, a partir de los períodos
 * ACTIVE de un cliente, cuáles se cierran (los del mes mayoritario) y cuál es el
 * mes siguiente. Se comparte entre el preview (solo lectura) y la ejecución
 * (set-based), evitando duplicar el cálculo del mes mayoritario.
 */

export interface ActivePeriodLite {
  id: string;
  consortiumId: string;
  year: number;
  month: number;
}

export interface CloseAllPlan {
  majorityYear: number;
  majorityMonth: number;
  nextYear: number;
  nextMonth: number;
  /** Ids de los períodos a cerrar (los del mes mayoritario). */
  toCloseIds: string[];
  /** Consorcios cuyos períodos se cierran (para crear su período siguiente). */
  toCloseConsortiumIds: string[];
  /** Períodos ACTIVE que NO son del mes mayoritario (se saltean). */
  skipCount: number;
}

/** +1 mes, envolviendo diciembre → enero del año siguiente. */
export function nextMonthOf(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/**
 * Calcula el plan de cierre. Retorna null si no hay períodos ACTIVE.
 * El mes mayoritario es el más frecuente entre los períodos ACTIVE; ante empate
 * gana el que aparece primero (orden de `active`), replicando el comportamiento
 * previo del endpoint.
 */
export function planCloseAll(active: ActivePeriodLite[]): CloseAllPlan | null {
  if (active.length === 0) return null;

  const freq = new Map<string, number>();
  for (const p of active) {
    const key = `${p.year}-${p.month}`;
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }

  let majorityKey = "";
  let majorityCount = 0;
  for (const [key, count] of freq) {
    if (count > majorityCount) {
      majorityKey = key;
      majorityCount = count;
    }
  }

  const [majorityYear, majorityMonth] = majorityKey.split("-").map(Number);
  const { year: nextYear, month: nextMonth } = nextMonthOf(majorityYear, majorityMonth);

  const toClose = active.filter((p) => p.year === majorityYear && p.month === majorityMonth);
  const toCloseIds = toClose.map((p) => p.id);
  const toCloseConsortiumIds = toClose.map((p) => p.consortiumId);

  return {
    majorityYear,
    majorityMonth,
    nextYear,
    nextMonth,
    toCloseIds,
    toCloseConsortiumIds,
    skipCount: active.length - toClose.length,
  };
}
