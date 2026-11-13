// Tests for site/js/filterform.js, the filter form the district, address and full-page
// map pages share (#149), and for the round trip district page -> map -> back.
// Run: node --test v2/tests-js/   (also run by `uv run pytest` in v2/pipeline)
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCheck, findChoice, pendingSummary, DATE_ORDER_MSG, PENDING_MSG } from '../site/js/filterform.js';
import { filtersFromParams, filtersToParams, copyFilters, patchBoth, keepKnownStatus } from '../site/js/filterstate.js';
import { whereSql } from '../site/js/filtersql.js';

const defaults = { start: '2025-11-01', end: '2026-11-13' };
const base = { ...defaults, types: [], descs: [], descEx: false, agency: '', status: '', addr: '' };
const fmt = (d) => d;

test('Apply checks the date order first, even with nothing changed (#142)', () => {
  const swapped = { ...base, start: '2026-12-01' };
  assert.equal(applyCheck({ draft: swapped, applied: swapped }), 'date-order');
  assert.match(DATE_ORDER_MSG, /From date is after the To date/);
});

test('an Apply with nothing changed reruns nothing, unless text was typed or the last run failed', () => {
  assert.equal(applyCheck({ draft: base, applied: base }), 'no-change');
  assert.equal(applyCheck({ draft: base, applied: base, typed: true }), 'apply');
  assert.equal(applyCheck({ draft: base, applied: base, lastFailed: true }), 'apply');
  assert.equal(applyCheck({ draft: { ...base, agency: 'NYPD' }, applied: base }), 'apply');
  // Chip order does not count as a change.
  assert.equal(applyCheck({ draft: { ...base, types: ['A', 'B'] }, applied: { ...base, types: ['B', 'A'] } }), 'no-change');
});

test('a typed problem name matches a choice whatever its case and spaces, and nothing else', () => {
  const list = ['Noise - Residential', 'HEAT/HOT WATER'];
  assert.equal(findChoice(list, '  noise - residential '), 'Noise - Residential');
  assert.equal(findChoice(list, 'heat/hot water'), 'HEAT/HOT WATER');
  assert.equal(findChoice(list, 'Noise'), undefined);
});

test('the form says what is not applied yet, per group', () => {
  const none = pendingSummary(base, base, base, fmt);
  assert.equal(none.pending, false);
  assert.equal(none.msg, '');
  assert.deepEqual(none.counts, { dates: '(2025-11-01 to 2026-11-13)', problem: '', agency: '' });
  const draft = { ...base, types: ['Noise - Residential'], agency: 'NYPD' };
  const s = pendingSummary(draft, base, base, fmt);
  assert.equal(s.pending, true);
  assert.equal(s.msg, PENDING_MSG);
  assert.equal(s.counts.problem, '(1 chosen, not applied yet)');
  assert.equal(s.counts.agency, '(1 chosen, not applied yet)');
  assert.equal(pendingSummary(draft, draft, base, fmt).counts.agency, '(1 chosen)');
});

// ---- the round trip: what each page's links carry (fullmap.js writeLinks, district.js writeUrl)

/** A page opened from `link` reads its filters, as both pages do. */
const open = (link) => filtersFromParams(new URL(link, 'https://example.org/').searchParams, defaults);
const linkFor = (page, geo, id, s) => `${page}?${filtersToParams(geo, id, s, defaults).toString()}`;

for (const [geo, id] of [['cd', '306'], ['cc', '33'], ['boro', 'brooklyn']]) {
  test(`${geo} ${id}: district page -> map -> change filters -> back keeps every filter`, () => {
    const onDistrict = { ...base, start: '2026-02-01', types: ['Noise - Residential'], descs: ['Loud Music/Party'], descEx: true };
    // "Open full-page map" carries the district page's filters.
    const onMap = open(linkFor('map.html', geo, id, onDistrict));
    assert.deepEqual(onMap, onDistrict);
    // Change filters on the map and Apply (a draft copied to applied, as the form does).
    const applied = copyFilters({ ...onMap, agency: 'NYPD', status: 'not_closed', end: '2026-10-31' });
    // The back link carries the map's filters; the district page opens with exactly them.
    const back = open(linkFor('district.html', geo, id, applied));
    assert.deepEqual(back, applied);
    assert.equal(whereSql(back), whereSql(applied)); // the same rows on both pages
    // And the district page's own link is the map's link with the other page name.
    assert.equal(linkFor('district.html', geo, id, back).split('?')[1], linkFor('map.html', geo, id, applied).split('?')[1]);
  });
}

test('an address filter is never carried: not into the map, not back', () => {
  const withAddr = { ...base, agency: 'DSNY', addr: '100 MAIN STREET' };
  const mapLink = linkFor('map.html', 'cd', '306', withAddr);
  assert.doesNotMatch(mapLink, /addr|MAIN/);
  assert.equal(open(mapLink).addr, '');
  assert.equal(open(mapLink).agency, 'DSNY');
  // Even a hand-made link with an address: the map page ignores it (fullmap.js sets addr: '').
  const onMap = { ...open('map.html?geo=cd&id=306&addr=100%20MAIN%20STREET'), addr: '' };
  assert.equal(onMap.addr, '');
});

test('a shortcut changes the applied filters and the form together, keeping other pending edits', () => {
  const draft = { ...base, status: 'Open' }; // edited in the form, not applied
  const { applied, draft: d2 } = patchBoth(base, draft, () => ({ agency: 'HPD' }));
  assert.equal(applied.agency, 'HPD');
  assert.equal(applied.status, '');
  assert.equal(d2.agency, 'HPD');
  assert.equal(d2.status, 'Open');
});

test('status=Closed is kept even when no Closed rows are loaded (#149 QA: a short period on the map)', () => {
  const s = { ...base, start: '2026-11-12', status: 'Closed' };
  assert.equal(keepKnownStatus(s, ['In Progress', 'Open']).status, 'Closed');
  assert.equal(keepKnownStatus({ ...s, status: 'Bogus' }, ['In Progress']).status, '');
  assert.equal(keepKnownStatus({ ...s, status: 'Open' }, ['Open']).status, 'Open');
});

test('a status the data does not have (status=Bogus) is dropped: checked against the data list, never the menu', async () => {
  const { statusChoices } = await import('../site/js/filterform.js');
  const known = ['In Progress', 'Open', 'Closed']; // what lists.statuses() returns
  const link = { ...base, status: 'Bogus' };
  assert.equal(keepKnownStatus(link, statusChoices(known)).status, '');
  assert.equal(keepKnownStatus({ ...link, status: 'Open' }, statusChoices(known)).status, 'Open');
  assert.equal(keepKnownStatus({ ...link, status: 'not_closed' }, statusChoices(known)).status, 'not_closed');
});

test('the lists offer rows in the applied dates or not yet closed, most requests in those dates first', async () => {
  const { listScopeSql, listOrderSql, tableLists } = await import('../site/js/filterform.js');
  const s = { ...base, start: '2026-06-01', end: '2026-11-13' };
  const scope = listScopeSql(s);
  assert.match(scope, /created_date >= CAST\('2026-06-01' AS DATE\)/);
  assert.match(scope, /OR status IS DISTINCT FROM 'Closed'/);
  assert.match(listOrderSql(s), /^count\(\*\) FILTER \(WHERE created_date >= CAST\('2026-06-01'/);
  // Every list query uses the scope and the order; "Closed" is always a status choice.
  const seen = [];
  const lists = tableLists(async (sql) => { seen.push(sql); return sql.includes('SELECT status') ? [{ status: 'Open' }] : []; }, () => s);
  await lists.problems(); await lists.agencies(); await lists.descriptions(['Noise']);
  assert.deepEqual(await lists.statuses(), ['Open', 'Closed']);
  for (const sql of seen) { assert.ok(sql.includes(scope), sql); assert.ok(sql.includes(listOrderSql(s)), sql); }
});
