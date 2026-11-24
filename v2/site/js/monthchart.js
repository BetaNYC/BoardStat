// The full-page map's stats bar (#194): requests per month, stacked by agency group, and
// what a click on a month does. No DOM, so v2/tests-js can test it.
import { lit, whereSql } from './filtersql.js';
import { GROUP_SQL, NG } from './piles.js';

/** 'YYYY-MM' of every month from the month of `from` through the month of `to` (YYYY-MM-DD). */
export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const last = to.slice(0, 7);
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym > last) return out;
    out.push(ym);
    if (++m > 12) { m = 1; y++; }
  }
}

/** The dates a click on month `ym` applies: its first to its last day, kept inside the data's [min, max]. */
export function monthDates(ym, min, max) {
  const [y, m] = ym.split('-').map(Number);
  const first = `${ym}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start: first < min ? min : first, end: lastDay > max ? max : lastDay };
}

/** Whether month `ym` overlaps the applied dates; the chart fades the months that do not. */
export const inDates = (ym, s) => ym >= s.start.slice(0, 7) && ym <= s.end.slice(0, 7);

/**
 * Requests per month and agency group for every filter but the dates, from `from` on
 * (the first day the table holds every request for: loadplan.js loads Closed requests
 * only from a date), so a month outside the applied dates can be shown, faded.
 */
export function monthlySql(s, from, table = 'req') {
  return `
    SELECT strftime(created_date, '%Y-%m') AS m, ${GROUP_SQL} AS g, count(*)::INTEGER AS n
    FROM ${table} WHERE ${whereSql(s, { skipDates: true })} AND created_date >= CAST(${lit(from)} AS DATE)
    GROUP BY 1, 2`;
}

/** monthlySql rows as one bar per month: { m, total, parts } with parts the count per group. */
export function monthBars(rows, months) {
  const at = new Map(months.map((m) => [m, { m, total: 0, parts: new Array(NG).fill(0) }]));
  for (const r of rows) {
    const b = at.get(r.m);
    if (!b) continue;
    b.parts[r.g] += r.n;
    b.total += r.n;
  }
  return [...at.values()];
}
