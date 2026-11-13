// Filter state helpers for the district and address pages (#142). No DOM and no imports,
// so v2/tests-js can test them under Node.
//
// The page keeps two copies of the filters: `applied` (what every panel shows, and what
// the link carries) and `draft` (what the form shows). Changing a control changes only
// the draft; the Apply button copies the draft to applied and runs the queries.

/** Field names, in the order a person reads the form. */
export const FILTER_FIELDS = ['start', 'end', 'types', 'descs', 'descEx', 'agency', 'status', 'addr'];

/** A copy that shares no arrays with the original. */
export function copyFilters(s) {
  return { ...s, types: [...(s.types || [])], descs: [...(s.descs || [])] };
}

function sameList(a = [], b = []) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/**
 * Fields whose value differs between two filter states. Lists compare as sets (the order
 * chips were added in does not change the query). descEx only counts when there are
 * descriptions, because with none it changes nothing.
 */
export function changedFields(a, b) {
  return FILTER_FIELDS.filter((k) => {
    if (k === 'types' || k === 'descs') return !sameList(a[k], b[k]);
    if (k === 'descEx') return (a.descs?.length || b.descs?.length) ? Boolean(a.descEx) !== Boolean(b.descEx) : false;
    return (a[k] ?? '') !== (b[k] ?? '');
  });
}

/**
 * Apply one change to both copies: `fn(s)` returns the fields to set, worked out from
 * that copy. Used by the shortcut buttons in the panels (select an agency, a description,
 * an address), which apply at once without discarding edits still waiting in the form.
 */
export function patchBoth(applied, draft, fn) {
  return { applied: { ...copyFilters(applied), ...fn(applied) }, draft: { ...copyFilters(draft), ...fn(draft) } };
}

/** The form's sections and the fields each holds, for the "n set" counts on each summary. */
export const SECTIONS = {
  dates: ['start', 'end'],
  problem: ['types', 'descs'],
  agency: ['agency', 'status'],
};

/** How many fields of a section differ from the defaults (a date pair counts once). */
export function sectionCount(s, defaults, section) {
  const changed = new Set(changedFields(s, defaults));
  if (section === 'dates') return changed.has('start') || changed.has('end') ? 1 : 0;
  if (section === 'problem') return (s.types?.length || 0) + (s.descs?.length || 0);
  return SECTIONS[section].filter((k) => changed.has(k)).length;
}

// ------------------------------------------------------------- filters <-> link (#143)
//
// The district page and the full-page map read and write the same link parameters, so a
// link copied from either one opens the other with the same filters:
//   geo, id   which district (cd or cc, and its id)
//   start, end   dates, YYYY-MM-DD; left out when they are the page's default dates
//   type, desc   problems and descriptions, joined with |
//   descx=1   exclude the descriptions instead of keeping only them
//   agency, status   one value each; status=not_closed means any status but Closed

/** Status value meaning "any status but Closed" (including a missing status). */
export const NOT_CLOSED = 'not_closed';

/** Filters from a page's link. `defaults` gives { start, end } for a link without dates. */
export function filtersFromParams(params, defaults) {
  return {
    start: params.get('start') || defaults.start,
    end: params.get('end') || defaults.end,
    types: (params.get('type') || '').split('|').filter(Boolean),
    descs: (params.get('desc') || '').split('|').filter(Boolean),
    descEx: params.get('descx') === '1',
    agency: params.get('agency') || '',
    status: params.get('status') || '',
    addr: params.get('addr') || '',
  };
}

/**
 * Link parameters for a district and its filters, leaving out what matches `defaults`.
 * Never the address: a street address is never written into a link after a page loads
 * (see district.js writeUrl and analytics.js).
 */
export function filtersToParams(geo, id, s, defaults) {
  const p = new URLSearchParams({ geo, id: String(id) });
  if (s.start !== defaults.start) p.set('start', s.start);
  if (s.end !== defaults.end) p.set('end', s.end);
  if (s.types?.length) p.set('type', s.types.join('|'));
  if (s.descs?.length) p.set('desc', s.descs.join('|'));
  if (s.descs?.length && s.descEx) p.set('descx', '1');
  if (s.agency) p.set('agency', s.agency);
  if (s.status) p.set('status', s.status);
  return p;
}

/** The applied filters in words, one part per filter; `fmtDate` formats a YYYY-MM-DD date. */
export function describeFilters(s, fmtDate) {
  const parts = [`Requests created ${fmtDate(s.start)} to ${fmtDate(s.end)}`];
  if (s.types?.length) parts.push(`problems: ${s.types.join(', ')}`);
  if (s.agency) parts.push(`agency: ${s.agency}`);
  if (s.descs?.length) parts.push(`${s.descEx ? 'excluding descriptions' : 'descriptions'}: ${s.descs.join(', ')}`);
  if (s.status) parts.push(`status: ${s.status === NOT_CLOSED ? 'not yet closed' : s.status}`);
  if (s.addr) parts.push(`address: ${s.addr}`);
  return parts;
}
