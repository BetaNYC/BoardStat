// Tests for site/js/filterstate.js: the form's draft filters vs. the applied filters (#142).
// Run: node --test v2/tests-js/   (also run by `uv run pytest` in v2/pipeline)
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFilters, changedFields, patchBoth, sectionCount } from '../site/js/filterstate.js';

const base = { start: '2025-11-01', end: '2026-11-04', types: [], descs: [], descEx: false, agency: '', status: '', addr: '' };

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
  const d = { ...base, start: '2026-01-01', agency: 'NYPD', status: 'not_closed' };
  assert.deepEqual(changedFields(d, base), ['start', 'agency', 'status']);
});

test('Exclude only counts as a change when there are descriptions to exclude', () => {
  assert.deepEqual(changedFields({ ...base, descEx: true }, base), []);
  assert.deepEqual(changedFields({ ...base, descs: ['Loud Music/Party'], descEx: true }, { ...base, descs: ['Loud Music/Party'] }), ['descEx']);
});

test('a shortcut applies at once and keeps other edits waiting in the form', () => {
  const applied = { ...base };
  const draft = { ...base, status: 'Closed' }; // changed in the form, not applied yet
  const out = patchBoth(applied, draft, () => ({ agency: 'DSNY' }));
  assert.equal(out.applied.agency, 'DSNY');
  assert.equal(out.applied.status, '');
  assert.equal(out.draft.agency, 'DSNY');
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
  const s = { ...base, end: '2026-06-30', types: ['Noise'], descs: ['X', 'Y'], agency: 'NYPD', status: 'not_closed' };
  assert.equal(sectionCount(s, base, 'dates'), 1);
  assert.equal(sectionCount(s, base, 'problem'), 3);
  assert.equal(sectionCount(s, base, 'agency'), 2);
  assert.equal(sectionCount(base, base, 'agency'), 0);
});
