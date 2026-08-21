/**
 * Meses de la vista de obligaciones.
 *
 * La vista es por MES CALENDARIO, no por "período activo": se elige un mes y se
 * muestran todos los edificios que tienen período de ese mes, esté abierto o
 * cerrado. Eso es lo que permite navegar hacia atrás y decidir qué pasa al mes
 * siguiente (spec 2026-08-20).
 *
 * Lógica pura, sin Prisma: la usan el endpoint y la UI.
 */

export interface YearMonth {
  year: number;
  month: number;
}

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export function periodLabel(year: number, month: number): string {
  return `${MONTHS[month - 1] ?? month} ${year}`;
}

/** Mes siguiente, envolviendo diciembre → enero. */
export function nextMonth({ year, month }: YearMonth): YearMonth {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** Mes anterior, envolviendo enero → diciembre. */
export function previousMonth({ year, month }: YearMonth): YearMonth {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export function sameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month;
}

/** ¿`a` es el mes inmediatamente anterior a `b`? */
export function isPreviousMonth(a: YearMonth, b: YearMonth): boolean {
  return sameMonth(nextMonth(a), b);
}

/**
 * Mes pedido por querystring, o `null` si no vino (o vino mal).
 *
 * Se valida acá y no en el endpoint para que un `?month=13` o un texto no llegue
 * nunca a la consulta.
 */
export function parseMonthParam(
  monthRaw: string | null,
  yearRaw: string | null
): YearMonth | null {
  if (!monthRaw || !yearRaw) return null;
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return { year, month };
}

/**
 * Mes mayoritario entre los períodos dados. Es el mes al que cae la vista cuando
 * no se pide uno: los períodos de los edificios pueden estar desalineados, y el
 * mayoritario es el que representa "el mes en curso" de la cartera.
 *
 * Ante empate gana el más reciente, que es hacia donde va el trabajo.
 */
export function majorityMonth(periods: readonly YearMonth[]): YearMonth | null {
  if (periods.length === 0) return null;

  const freq = new Map<string, { ym: YearMonth; count: number }>();
  for (const p of periods) {
    const key = `${p.year}-${p.month}`;
    const hit = freq.get(key);
    if (hit) hit.count += 1;
    else freq.set(key, { ym: p, count: 1 });
  }

  let best: { ym: YearMonth; count: number } | null = null;
  for (const entry of freq.values()) {
    if (
      !best ||
      entry.count > best.count ||
      (entry.count === best.count && entry.ym.year * 100 + entry.ym.month > best.ym.year * 100 + best.ym.month)
    ) {
      best = entry;
    }
  }
  return best?.ym ?? null;
}
