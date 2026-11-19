// Tests for address pages by tax lot (BBL): one building, every spelling 311 used for it.
// Run: node --test v2/tests-js/
import test from 'node:test';
import assert from 'node:assert/strict';
import { filtersFromParams, describeFilters } from '../site/js/filterstate.js';
import { whereSql } from '../site/js/filtersql.js';

const defaults = { start: '2025-11-01', end: '2026-11-04' };
const open = (q) => filtersFromParams(new URLSearchParams(q), defaults);

test('a bbl in the link matches the whole lot instead of the exact address', () => {
  const s = open('addr=100%20MAIN%20STREET&bbl=1000010001');
  assert.equal(s.bbl, '1000010001');
  assert.match(whereSql(s), /bbl = '1000010001'/);
  assert.doesNotMatch(whereSql(s), /address_norm/);
  assert.deepEqual(describeFilters(s, (d) => d).slice(-1), ['tax lot (BBL): 1000010001']);
});

test('without a bbl the page still matches the exact address', () => {
  const s = open('addr=100%20MAIN%20STREET');
  assert.equal(s.bbl, '');
  assert.match(whereSql(s), /address_norm = '100 MAIN STREET'/);
});

test('a bbl that is not 10 digits is ignored, so it can never reach the SQL', () => {
  for (const bad of ["1000010001' OR 1=1 --", '12345', '10000100010', 'abcdefghij']) {
    assert.equal(open(`addr=X&bbl=${encodeURIComponent(bad)}`).bbl, '');
  }
});
