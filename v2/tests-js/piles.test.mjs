// Tests for the full-page map's piles (#193) and stats bar (#194): js/piles.js and js/monthchart.js.
// Run: node --test v2/tests-js/   (also run by `uv run pytest` in v2/pipeline)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../site/js/piles.js';
import { monthsBetween, monthDates, inDates, monthBars, monthlySql } from '../site/js/monthchart.js';

const row = (k, n, groups, extra = {}) => ({ k, label: k, addr: k, x: -73.95, y: 40.67, n, o: 0, ...Object.fromEntries(groups.map((v, i) => [`g${i}`, v])), ...extra });

test('a pile counts each agency group, with every other agency as Other', () => {
  const [p] = P.toPiles([row('1 MAIN ST', 10, [3, 0, 2, 0, 0, 0, 0, 0])]);
  assert.deepEqual(p.c, [3, 0, 2, 0, 0, 0, 0, 0, 5]);
  assert.equal(P.topGroup(p.c), P.OTHER);
  assert.equal(P.groupOf('HPD'), 0);
  assert.equal(P.groupOf('TLC'), P.OTHER);
  assert.equal(P.GROUP_LABELS.length, P.GCOL.length);
  assert.equal(P.GCOL.length, P.DCOL.length);
  assert.equal(P.toPiles([{ k: 'x', label: 'x', addr: null, x: 0, y: 0, n: 1, o: 1 }])[0].addr, '');
});

test('a pile under the cap gets one chip per request, bottom first by group', () => {
  assert.deepEqual(P.chipGroups([2, 0, 1, 0, 0, 0, 0, 0, 0]), [0, 0, 2]);
});

test('a pile over the cap is scaled per agency, keeps every agency, and stops at the cap', () => {
  const c = [900, 90, 0, 0, 0, 0, 0, 0, 10];
  const chips = P.chipGroups(c, P.FLAT_CAP);
  assert.equal(chips.length, P.FLAT_CAP);
  assert.ok(chips.includes(P.OTHER)); // 10 of 1,000 still shows
  assert.ok(chips.filter((g) => g === 0).length > chips.filter((g) => g === 1).length);
  assert.equal(P.chipGroups(c).length, P.PILE_CAP);
  const flat = P.chipsData([{ x: 0, y: 0, c, n: 1000 }]);
  assert.equal(flat.features.length, P.FLAT_CAP);
  assert.deepEqual(flat.features.map((f) => f.properties.i), [...Array(P.FLAT_CAP).keys()]);
  const discs = P.discsData([{ x: -73.95, y: 40.67, c, n: 1000 }], 17);
  assert.equal(discs.features.length, P.PILE_CAP);
  const [d0, d1] = discs.features.map((f) => f.properties);
  assert.ok(d0.b === 0 && d0.h > 0 && d1.b > d0.h); // discs stack with a gap
});

test('circles: one per pile, biggest first, sized by count with a ceiling', () => {
  const piles = P.toPiles([row('a', 4, [4]), row('b', 900, [0, 900])]);
  const f = P.circlesData(piles).features.map((x) => x.properties);
  assert.deepEqual(f.map((x) => x.p), [1, 0]);
  assert.equal(f[0].dom, 1);
  assert.equal(P.circleRadius(4), 5);
  assert.equal(P.circleRadius(10000), 26);
  // Only some piles: each feature still points at its pile in the full list.
  assert.deepEqual(P.circlesData(piles, 16, [1]).features.map((x) => x.properties.p), [1]);
});

test('the view: circles zoomed out, chips zoomed in, 3D when tilted, no flicker in between', () => {
  assert.equal(P.pickView(14, 0), 'circles');
  assert.equal(P.pickView(16, 0, 'circles'), 'flat');
  assert.equal(P.pickView(16, 30, 'flat'), '3d');
  assert.equal(P.pickView(16, 7, '3d'), '3d');
  assert.equal(P.pickView(16, 7, 'flat'), 'flat');
  assert.equal(P.pickView(16, 7, 'circles'), 'flat');
  assert.equal(P.pickView(14, 50, '3d'), 'circles');
});

test('only the piles on screen, and the one nearest a point', () => {
  const piles = [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 1, y: 1 }];
  assert.deepEqual(P.pilesIn(piles, [[-0.5, -0.5], [2, 2]]), [0, 2]);
  assert.equal(P.nearestPile([[0, 0], [10, 10], [4, 4]], [5, 5]), 2);
  assert.equal(P.nearestPile([], [5, 5]), -1);
});

test('the SQL groups by address and filters by the pile key safely', () => {
  const sql = P.addressSql("agency IN ('DOT')");
  assert.match(sql, /GROUP BY 1/);
  assert.match(sql, /WHERE agency IN \('DOT'\) AND latitude IS NOT NULL/);
  assert.doesNotMatch(sql, /LIMIT/); // every matching request is counted (#193: no 60,000 cap)
  assert.match(P.pileTypesSql('TRUE', "O'BRIEN PLACE"), /= 'O''BRIEN PLACE'/);
  const r = P.resolutionsSql("'d.parquet'", [{ id: '2', ts: '2026-01-02 00:00:00' }, { id: '1', ts: '2025-12-01 10:00:00' }]);
  assert.match(r, /created_date >= CAST\('2025-12-01 10:00:00' AS TIMESTAMP\)/);
  assert.match(r, /unique_key IN \('2', '1'\)/);
});

test('months between two dates, across a new year', () => {
  assert.deepEqual(monthsBetween('2025-11-15', '2026-02-01'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(monthsBetween('2026-03-01', '2026-03-31'), ['2026-03']);
});

test('a click on a month applies that month, kept inside the data', () => {
  assert.deepEqual(monthDates('2026-02', '2020-01-01', '2026-11-22'), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(monthDates('2024-02', '2020-01-01', '2026-11-22'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(monthDates('2026-11', '2020-01-01', '2026-11-22'), { start: '2026-11-01', end: '2026-11-22' });
});

test('months outside the applied dates are the ones faded', () => {
  const s = { start: '2026-02-15', end: '2026-04-01' };
  assert.deepEqual(['2026-01', '2026-02', '2026-04', '2026-05'].map((m) => inDates(m, s)), [false, true, true, false]);
});

test('monthly rows become one bar per month, empty months included', () => {
  const bars = monthBars([{ m: '2026-01', g: 0, n: 3 }, { m: '2026-01', g: 8, n: 2 }, { m: '2026-03', g: 1, n: 1 }, { m: '2025-01', g: 1, n: 9 }],
    ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(bars.map((b) => b.total), [5, 0, 1]);
  assert.equal(bars[0].parts[8], 2);
  assert.equal(bars[0].parts.length, P.NG);
});

test('the monthly query keeps every filter but the dates', () => {
  const sql = monthlySql({ start: '2026-03-01', end: '2026-03-31', agencies: ['DOT'], types: [], descs: [], descEx: false, status: 'not_closed' }, '2025-11-01');
  assert.match(sql, /agency IN \('DOT'\)/);
  assert.match(sql, /status IS DISTINCT FROM 'Closed'/);
  assert.doesNotMatch(sql, /2026-03-01/);
  assert.match(sql, /created_date >= CAST\('2025-11-01' AS DATE\)/);
});
