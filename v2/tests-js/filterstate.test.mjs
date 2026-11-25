// Tests for site/js/filterstate.js: the form's draft filters vs. the applied filters (#142).
// Run: node --test v2/tests-js/   (also run by `uv run pytest` in v2/pipeline)
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFilters, changedFields, patchBoth, sectionCount, filtersFromParams, filtersToParams, describeFilters, listOrderFromParams, setListOrder } from '../site/js/filterstate.js';
import { whereSql } from '../site/js/filtersql.js';

const base = { start: '2025-11-01', end: '2026-11-04', types: [], descs: [], descEx: false, agencies: [], status: '', addr: '' };

test('a copy shares no lists with the original, so editing the form never changes the page', () => {
  const applied = { ...base, types: ['Noise'] };
  const draft = copyFilters(applied);
  draft.types.push('Heat');
  assert.deepEqual(applied.types, ['Noise']);
  assert.deepEqual(changedFields(draft, applied), ['types']);
});

test('nothing pending when the form matches the page; chip order does not count', () => {
  assert.deepEqual(changedFields({ ...base, types: ['A', 'B'] }, { ...base, types: ['B', 'A'] }), []);
});

test('each changed field is reported', () => {
  const d = { ...base, start: '2026-01-01', agencies: ['NYPD'], status: 'not_closed' };
  assert.deepEqual(changedFields(d, base), ['start', 'status', 'agencies']);
});

test('Exclude only counts as a change when there are descriptions to exclude', () => {
  assert.deepEqual(changedFields({ ...base, descEx: true }, base), []);
  assert.deepEqual(changedFields({ ...base, descs: ['Loud Music/Party'], descEx: true }, { ...base, descs: ['Loud Music/Party'] }), ['descEx']);
});

test('a shortcut applies at once and keeps other edits waiting in the form', () => {
  const applied = { ...base };
  const draft = { ...base, status: 'Closed' }; // changed in the form, not applied yet
  const out = patchBoth(applied, draft, () => ({ agencies: ['DSNY'] }));
  assert.deepEqual(out.applied.agencies, ['DSNY']);
  assert.equal(out.applied.status, '');
  assert.deepEqual(out.draft.agencies, ['DSNY']);
  assert.equal(out.draft.status, 'Closed');
  assert.deepEqual(changedFields(out.draft, out.applied), ['status']);
});

test('a shortcut that adds to a list works from each copy', () => {
  const applied = { ...base, descs: ['A'] };
  const draft = { ...base, descs: ['A', 'B'] };
  const add = (s) => ({ descs: s.descs.includes('C') ? s.descs : [...s.descs, 'C'] });
  const out = patchBoth(applied, draft, add);
  assert.deepEqual(out.applied.descs, ['A', 'C']);
  assert.deepEqual(out.draft.descs, ['A', 'B', 'C']);
  assert.deepEqual(applied.descs, ['A']); // inputs untouched
});

test('section counts for the group headings', () => {
  const s = { ...base, end: '2026-06-30', types: ['Noise'], descs: ['X', 'Y'], agencies: ['NYPD'], status: 'not_closed' };
  // #192: status sits with the dates, agencies with problems and descriptions.
  assert.equal(sectionCount(s, base, 'dates'), 2);
  assert.equal(sectionCount(s, base, 'problem'), 4);
  assert.equal(sectionCount(base, base, 'dates'), 0);
  assert.equal(sectionCount(base, base, 'problem'), 0);
});

test('agencies compare as a set, and a copy shares no agency list (#192)', () => {
  assert.deepEqual(changedFields({ ...base, agencies: ['NYPD', 'DSNY'] }, { ...base, agencies: ['DSNY', 'NYPD'] }), []);
  assert.deepEqual(changedFields({ ...base, agencies: ['NYPD'] }, { ...base, agencies: ['NYPD', 'DSNY'] }), ['agencies']);
  const applied = { ...base, agencies: ['NYPD'] };
  copyFilters(applied).agencies.push('HPD');
  assert.deepEqual(applied.agencies, ['NYPD']);
});

test('several agencies round-trip through a link; an old one-agency link opens the same view (#192)', () => {
  const defaults = { start: base.start, end: base.end };
  const s = { ...base, agencies: ['NYPD', 'DSNY'] };
  const link = filtersToParams('cd', '306', s, defaults);
  assert.equal(link.toString(), 'geo=cd&id=306&agency=NYPD%7CDSNY');
  assert.deepEqual(filtersFromParams(link, defaults).agencies, ['NYPD', 'DSNY']);
  // A link made before #192 carries one agency=; it reads as a list of one and writes back unchanged.
  const old = new URLSearchParams('geo=cd&id=306&agency=DSNY');
  const opened = filtersFromParams(old, defaults);
  assert.deepEqual(opened.agencies, ['DSNY']);
  assert.equal(filtersToParams('cd', '306', opened, defaults).toString(), old.toString());
  assert.match(whereSql(opened), /agency IN \('DSNY'\)/);
  // No agency, no parameter and no SQL.
  assert.deepEqual(filtersFromParams(new URLSearchParams('geo=cd&id=306&agency='), defaults).agencies, []);
  assert.doesNotMatch(whereSql({ ...base }), /agency/);
  assert.deepEqual(describeFilters(s, (d) => d).slice(1), ['agencies: NYPD, DSNY']);
  assert.deepEqual(describeFilters(opened, (d) => d).slice(1), ['agency: DSNY']);
});

test('the link carries Sort suggestions only when it is Most requests (#199)', () => {
  const d = { start: '2025-11-01', end: '2026-11-24' };
  const s = { ...d, types: [], descs: [], descEx: false, agencies: [], status: '' };
  assert.equal(listOrderFromParams(new URLSearchParams('sort=count')), 'count');
  for (const q of ['', 'sort=az', 'sort=junk']) assert.equal(listOrderFromParams(new URLSearchParams(q)), 'az');
  setListOrder('count');
  assert.equal(filtersToParams('cd', 309, s, d).toString(), 'geo=cd&id=309&sort=count');
  setListOrder('az');
  assert.equal(filtersToParams('cd', 309, s, d).toString(), 'geo=cd&id=309');
});
