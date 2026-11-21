// Tests for address pages by tax lot (BBL): one building, every spelling 311 used for it.
// Run: node --test v2/tests-js/
import test from 'node:test';
import assert from 'node:assert/strict';
import { filtersFromParams, filtersToParams, describeFilters, isLot, addressParams } from '../site/js/filterstate.js';
import { whereSql } from '../site/js/filtersql.js';

const defaults = { start: '2025-11-01', end: '2026-11-04' };
const open = (q) => filtersFromParams(new URLSearchParams(q), defaults);

test('a lot view keeps every request at its own address plus every request on the lot', () => {
  const s = open('addr=100%20MAIN%20STREET&bbl=1000010001');
  assert.equal(s.bbl, '1000010001');
  assert.match(whereSql(s), /\(bbl = '1000010001' OR address_norm = '100 MAIN STREET'\)/);
  assert.deepEqual(describeFilters(s, (d) => d).slice(-1), ['address: 100 MAIN STREET and its tax lot (BBL 1000010001)']);
});

test('without a bbl the page still matches the exact address', () => {
  const s = open('addr=100%20MAIN%20STREET');
  assert.equal(s.bbl, '');
  assert.match(whereSql(s), /address_norm = '100 MAIN STREET'/);
  assert.doesNotMatch(whereSql(s), /bbl/);
});

test('only a real tax lot is accepted, so a bad link never reaches the SQL', () => {
  for (const ok of ['1001220001', '5079990100']) assert.equal(isLot(ok), true, ok);
  // 0000000000 is 311's placeholder; block 00000 or lot 0000 is not a lot; borough is 1 to 5.
  for (const bad of ['0000000000', '1000000001', '1001220000', '6001220001', '12345', '10012200010',
    "1001220001' OR 1=1 --", 'abcdefghij', '', null]) {
    assert.equal(isLot(bad), false, String(bad));
    assert.equal(open(`addr=X&bbl=${encodeURIComponent(bad ?? '')}`).bbl, '');
  }
});

test('lot links carry the applied filters, not the ones the page was opened with', () => {
  const applied = { ...open('addr=X&start=2020-01-01&type=Noise'), start: defaults.start, types: ['Heat'] };
  const p = addressParams('cd', 101, applied, defaults, 'CITY HALL', '1001220001');
  assert.equal(p.get('start'), null); // back at the default date
  assert.equal(p.get('type'), 'Heat');
  assert.equal(p.get('addr'), 'CITY HALL');
  assert.equal(p.get('bbl'), '1001220001');
  assert.equal(addressParams('cd', 101, applied, defaults, 'CITY HALL').get('bbl'), null);
});

test('district links never carry an address or a tax lot', () => {
  const p = filtersToParams('cd', 101, open('addr=CITY%20HALL&bbl=1001220001'), defaults);
  assert.equal(p.get('addr'), null);
  assert.equal(p.get('bbl'), null);
});
