// Tests for the full-page map's link handling (#143): the district page and map.html read
// and write the same link, and count the same requests.
// Run: node --test v2/tests-js/   (also run by `uv run pytest` in v2/pipeline)
import test from 'node:test';
import assert from 'node:assert/strict';
import { filtersFromParams, filtersToParams, describeFilters, NOT_CLOSED } from '../site/js/filterstate.js';
import { whereSql, lit } from '../site/js/filtersql.js';

const defaults = { start: '2025-11-01', end: '2026-11-04' };
const fmt = (d) => d; // dates as written, so the test does not depend on the locale

/** What clicking "Open full-page map" and then "Back to the district page" does to a link. */
function roundTrip(search) {
  const district = filtersFromParams(new URLSearchParams(search), defaults);
  const mapLink = filtersToParams('cd', '306', district, defaults).toString();
  const onMap = filtersFromParams(new URLSearchParams(mapLink), defaults);
  const backLink = filtersToParams('cd', '306', onMap, defaults).toString();
  return { district, mapLink, onMap, backLink };
}

test('a link with every filter comes back from the full-page map unchanged', () => {
  const search = 'geo=cd&id=306&start=2026-03-01&end=2026-09-30&type=Noise+-+Residential%7CIllegal+Parking'
    + '&desc=Loud+Music%2FParty&descx=1&agency=NYPD&status=not_closed';
  const { district, mapLink, onMap, backLink } = roundTrip(search);
  assert.deepEqual(onMap, district);
  assert.equal(mapLink, backLink);
  assert.equal(new URLSearchParams(mapLink).toString(), new URLSearchParams(search).toString());
  assert.deepEqual(onMap.types, ['Noise - Residential', 'Illegal Parking']);
});

test('both pages build the same SQL filter from the same link', () => {
  const { district, onMap } = roundTrip('geo=cc&id=33&type=Heat%2FHot+Water&status=Closed&agency=HPD');
  assert.equal(whereSql(onMap), whereSql(district));
});

test('default dates stay out of the link, and a link without dates opens with the defaults', () => {
  const { mapLink, onMap } = roundTrip('geo=cd&id=306&agency=DSNY');
  assert.equal(mapLink, 'geo=cd&id=306&agency=DSNY');
  assert.equal(onMap.start, defaults.start);
  assert.equal(onMap.end, defaults.end);
});

test('a street address is never written into a link', () => {
  const s = { ...filtersFromParams(new URLSearchParams('geo=cd&id=306'), defaults), addr: '5 BERKLEY PLACE' };
  const link = filtersToParams('cd', '306', s, defaults);
  assert.equal(link.has('addr'), false);
  assert.equal(link.toString(), 'geo=cd&id=306');
});

test('exclude is only written when there are descriptions', () => {
  const s = { ...filtersFromParams(new URLSearchParams(''), defaults), descEx: true };
  assert.equal(filtersToParams('cd', '306', s, defaults).has('descx'), false);
});

test('quotes in filter values are escaped in the SQL', () => {
  assert.equal(lit("O'Brien"), "'O''Brien'");
  const s = { ...filtersFromParams(new URLSearchParams(''), defaults), agency: "X' OR 1=1 --" };
  assert.match(whereSql(s), /agency = 'X'' OR 1=1 --'/);
});

test('the filters in words, as the full-page map lists them', () => {
  const s = { ...filtersFromParams(new URLSearchParams('type=Noise&status=' + NOT_CLOSED + '&desc=A&descx=1'), defaults) };
  assert.deepEqual(describeFilters(s, fmt), [
    'Requests created 2025-11-01 to 2026-11-04', 'problems: Noise', 'excluding descriptions: A', 'status: not yet closed',
  ]);
});
