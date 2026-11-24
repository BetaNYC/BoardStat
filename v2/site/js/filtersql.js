// The SQL WHERE clause for a set of filters, shared by the district page and the
// full-page map (#143) so both count exactly the same requests. No DOM, so
// v2/tests-js can test it under Node.
import { NOT_CLOSED } from './filterstate.js';

/** SQL string literal: standard SQL doubling of single quotes. */
export function lit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** SQL test for a real tax lot, the same rule as isLot() in filterstate.js. */
export const LOT_SQL = `regexp_matches(bbl, '^[1-5][0-9]{9}$') AND substr(bbl, 2, 5) <> '00000' AND substr(bbl, 7, 4) <> '0000'`;

export const NOT_CLOSED_SQL = `status IS DISTINCT FROM 'Closed'`;
// A missing descriptor is shown and filtered as "(none)", as in the descriptor table.
export const DESC_SQL = `coalesce(descriptor, '(none)')`;

/** WHERE clause (without the word WHERE) for filters `s`; the skip options leave one filter out. */
export function whereSql(s, { skipType = false, skipDates = false, skipDesc = false, skipStatus = false, skipAgency = false } = {}) {
  const w = skipDates ? ['TRUE'] : [
    `created_date >= CAST(${lit(s.start)} AS DATE)`,
    `created_date < CAST(${lit(s.end)} AS DATE) + INTERVAL 1 DAY`,
  ];
  if (!skipType && s.types.length) w.push(`complaint_type IN (${s.types.map(lit).join(', ')})`);
  if (!skipAgency && s.agencies.length) w.push(`agency IN (${s.agencies.map(lit).join(', ')})`);
  if (!skipDesc && s.descs.length) w.push(`${DESC_SQL} ${s.descEx ? 'NOT IN' : 'IN'} (${s.descs.map(lit).join(', ')})`);
  if (!skipStatus && s.status) w.push(s.status === NOT_CLOSED ? NOT_CLOSED_SQL : `status = ${lit(s.status)}`);
  // A tax lot view keeps every request at its own address too (some have no bbl, or another one).
  if (s.bbl) w.push(s.addr ? `(bbl = ${lit(s.bbl)} OR address_norm = ${lit(s.addr)})` : `bbl = ${lit(s.bbl)}`);
  else if (s.addr) w.push(`address_norm = ${lit(s.addr)}`);
  return w.join(' AND ');
}
