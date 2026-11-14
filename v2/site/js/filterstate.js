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
