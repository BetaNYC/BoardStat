// Filter state helpers for the district and address pages (#142). No DOM and no imports,
// so v2/tests-js can test them under Node.
//
// The page keeps two copies of the filters: `applied` (what every panel shows, and what
// the link carries) and `draft` (what the form shows). Changing a control changes only
// the draft; the Apply button copies the draft to applied and runs the queries.

/** Field names, in the order a person reads the form. */
export const FILTER_FIELDS = ['start', 'end', 'status', 'agencies', 'types', 'descs', 'descEx', 'addr', 'bbl'];

/** The filters held as lists (chips), compared as sets. */
const LIST_FIELDS = ['agencies', 'types', 'descs'];

/** A copy that shares no arrays with the original. */
export function copyFilters(s) {
  return { ...s, agencies: [...(s.agencies || [])], types: [...(s.types || [])], descs: [...(s.descs || [])] };
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
    if (LIST_FIELDS.includes(k)) return !sameList(a[k], b[k]);
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
  dates: ['start', 'end', 'status'],
  problem: ['agencies', 'types', 'descs'],
};

/** How many filters of a section differ from the defaults (a date pair counts once, each chip once). */
export function sectionCount(s, defaults, section) {
  const changed = new Set(changedFields(s, defaults));
  if (section === 'dates') return (changed.has('start') || changed.has('end') ? 1 : 0) + (changed.has('status') ? 1 : 0);
  return LIST_FIELDS.reduce((n, k) => n + (s[k]?.length || 0), 0);
}

// ------------------------------------------------------------- filters <-> link (#143)
//
// The district page and the full-page map read and write the same link parameters, so a
// link copied from either one opens the other with the same filters:
//   geo, id   which district (cd or cc, and its id)
//   start, end   dates, YYYY-MM-DD; left out when they are the page's default dates
//   agency, type, desc   agencies, problems and descriptions, joined with | (#192: a link
//                        made before then has one agency, which reads as a list of one)
//   descx=1   exclude the descriptions instead of keeping only them
//   status   one value; status=not_closed means any status but Closed

/** Status value meaning "any status but Closed" (including a missing status). */
export const NOT_CLOSED = 'not_closed';

/** True for a real calendar date written YYYY-MM-DD (not 2026-02-30, not "garbage"). */
export function isIsoDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Filters from a page's link. `defaults` gives { start, end } for a link without dates,
 * or with a date that is not a real YYYY-MM-DD date.
 */
export function filtersFromParams(params, defaults) {
  const date = (k) => (isIsoDate(params.get(k)) ? params.get(k) : defaults[k]);
  return {
    start: date('start'),
    end: date('end'),
    types: (params.get('type') || '').split('|').filter(Boolean),
    descs: (params.get('desc') || '').split('|').filter(Boolean),
    descEx: params.get('descx') === '1',
    agencies: (params.get('agency') || '').split('|').filter(Boolean),
    status: params.get('status') || '',
    addr: params.get('addr') || '',
    // A tax lot (borough-block-lot): every request on the address's lot, whatever address was typed.
    bbl: isLot(params.get('bbl')) ? params.get('bbl') : '',
  };
}

/**
 * Whether `b` is a real tax lot (BBL): borough 1 to 5, then a 5-digit block and a 4-digit
 * lot, neither all zeros. 311 uses 0000000000 as a placeholder on some requests.
 */
export function isLot(b) {
  return /^[1-5]\d{9}$/.test(b || '') && b.slice(1, 6) !== '00000' && b.slice(6) !== '0000';
}

/**
 * Link parameters for an address page: the district and the applied filters (as
 * filtersToParams makes them), the address, and a tax lot when given. For links the
 * address page draws itself; it never rewrites its own URL.
 */
export function addressParams(geo, id, s, defaults, addr, bbl = '') {
  const p = filtersToParams(geo, id, s, defaults);
  p.set('addr', addr);
  if (bbl) p.set('bbl', bbl);
  return p;
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
  if (s.agencies?.length) p.set('agency', s.agencies.join('|'));
  if (s.status) p.set('status', s.status);
  return p;
}

/**
 * The filters with a status the district's data does not have dropped, so a link with
 * status=anything-else shows every status on both pages. `known` lists the statuses in
 * the data; '' (any status) and NOT_CLOSED are always allowed.
 */
export function keepKnownStatus(s, known) {
  // "Closed" is always kept: a page lists the statuses of the rows it has loaded, and it
  // loads Closed rows only from the From date on, so a short period can have none even
  // though the data does (#149 QA). Every other status is on a request not yet Closed,
  // and those are always loaded (detail files keep them together at the end), so the
  // list is complete for them.
  if (!s.status || s.status === NOT_CLOSED || s.status === 'Closed' || known.includes(s.status)) return s;
  return { ...s, status: '' };
}

/** The applied filters in words, one part per filter; `fmtDate` formats a YYYY-MM-DD date. */
export function describeFilters(s, fmtDate) {
  const parts = [`Requests created ${fmtDate(s.start)} to ${fmtDate(s.end)}`];
  if (s.types?.length) parts.push(`problems: ${s.types.join(', ')}`);
  if (s.agencies?.length) parts.push(`${s.agencies.length === 1 ? 'agency' : 'agencies'}: ${s.agencies.join(', ')}`);
  if (s.descs?.length) parts.push(`${s.descEx ? 'excluding descriptions' : 'descriptions'}: ${s.descs.join(', ')}`);
  if (s.status) parts.push(`status: ${s.status === NOT_CLOSED ? 'not yet closed' : s.status}`);
  if (s.bbl) parts.push(`address: ${s.addr} and its tax lot (BBL ${s.bbl})`);
  else if (s.addr) parts.push(`address: ${s.addr}`);
  return parts;
}
