// Tests for the whole-borough view (#144): reading geo=boro from a link, which district
// files make up a borough, and the SQL that reads them as one table.
// Run: node --test v2/tests-js/   (also run by `uv run pytest` in v2/pipeline)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOROUGHS, boroughBySlug, boroughOfCd, parsePlace, boroughParts, resolvePlace, sourceNames, sourceSql, boroughUrl,
} from '../site/js/place.js';
import { filtersFromParams, filtersToParams } from '../site/js/filterstate.js';
import { whereSql } from '../site/js/filtersql.js';
import { placeShapes, boundaryFile } from '../site/js/requestmap.js';

// The real district list: 59 community districts and 12 Joint Interest Areas.
const CD_IDS = [
  ...Array.from({ length: 12 }, (_, i) => 101 + i), 164,
  ...Array.from({ length: 12 }, (_, i) => 201 + i), 226, 227, 228,
  ...Array.from({ length: 18 }, (_, i) => 301 + i), 355, 356,
  ...Array.from({ length: 14 }, (_, i) => 401 + i), 480, 481, 482, 483, 484,
  501, 502, 503, 595,
];
const JIA = new Set([164, 226, 227, 228, 355, 356, 480, 481, 482, 483, 484, 595]);
const manifest = {
  districts: {
    cd: CD_IDS.map((id) => ({
      id, rows: 10, file: `detail/cd/${id}.parquet`, jia: JIA.has(id), unlocated_city_assigned: 1,
      borough: BOROUGHS.find((b) => b.code === Math.floor(id / 100)).name,
      label: `${BOROUGHS.find((b) => b.code === Math.floor(id / 100)).name} ${JIA.has(id) ? 'Joint Interest Area' : 'CD'} ${JIA.has(id) ? id : id % 100}`,
    })),
    cc: [{ id: 33, rows: 10, file: 'detail/cc/33.parquet', label: 'Council District 33', borough: 'Brooklyn' }],
  },
};

test('geo=boro is read from a link, with any spelling of the borough name', () => {
  assert.deepEqual(parsePlace(new URLSearchParams('geo=boro&id=brooklyn')), { geo: 'boro', id: 'brooklyn' });
  assert.deepEqual(parsePlace(new URLSearchParams('geo=boro&id=Staten%20Island')), { geo: 'boro', id: 'staten-island' });
  assert.deepEqual(parsePlace(new URLSearchParams('geo=boro&id=STATEN-ISLAND')), { geo: 'boro', id: 'staten-island' });
  // Unknown boroughs stay as given, so the page can say it was not found.
  assert.deepEqual(parsePlace(new URLSearchParams('geo=boro&id=atlantis')), { geo: 'boro', id: 'atlantis' });
  // District links read as before.
  assert.deepEqual(parsePlace(new URLSearchParams('geo=cc&id=33')), { geo: 'cc', id: '33' });
  assert.deepEqual(parsePlace(new URLSearchParams('geo=xx&id=306')), { geo: 'cd', id: '306' });
  assert.deepEqual(parsePlace(new URLSearchParams('id=306')), { geo: 'cd', id: '306' });
});

test('every borough is the community districts with its digit, Joint Interest Areas included', () => {
  const ids = (slug) => boroughParts(manifest, slug).map((d) => d.id);
  assert.deepEqual(ids('brooklyn'), [...Array.from({ length: 18 }, (_, i) => 301 + i), 355, 356]);
  assert.deepEqual(ids('staten-island'), [501, 502, 503, 595]);
  assert.deepEqual(ids('manhattan').at(-1), 164);
  assert.equal(ids('queens').length, 19);
  assert.equal(ids('bronx').length, 15);
  // All five together are every district file, each exactly once.
  const all = BOROUGHS.flatMap((b) => ids(b.slug)).sort((a, b) => a - b);
  assert.deepEqual(all, [...CD_IDS].sort((a, b) => a - b));
  // A district file that was not written (no rows) is left out.
  const m2 = { districts: { cd: manifest.districts.cd.map((d) => (d.id === 356 ? { ...d, file: null } : d)) } };
  assert.equal(boroughParts(m2, 'brooklyn').length, 19);
});

test('resolvePlace describes a borough and a district the same way', () => {
  const bk = resolvePlace(manifest, 'boro', 'brooklyn');
  assert.equal(bk.label, 'Brooklyn (whole borough)');
  assert.equal(bk.borough, 'Brooklyn');
  assert.equal(bk.files.length, 20);
  assert.equal(bk.files[0], 'detail/cd/301.parquet');
  assert.equal(bk.unlocated, 20);
  assert.equal(resolvePlace(manifest, 'boro', 'atlantis'), null);
  const cd = resolvePlace(manifest, 'cd', '306');
  assert.deepEqual([cd.label, cd.files, cd.unlocated, cd.jia], ['Brooklyn CD 6', ['detail/cd/306.parquet'], 1, false]);
  const cc = resolvePlace(manifest, 'cc', '33');
  assert.equal(cc.unlocated, null);
  assert.equal(resolvePlace(manifest, 'cd', '999'), null);
});

test('a district reads one file as before; a borough reads all of its files as one table', () => {
  const cd = resolvePlace(manifest, 'cd', '306');
  assert.deepEqual(sourceNames(cd), ['d.parquet']);
  assert.equal(sourceSql(sourceNames(cd)), "'d.parquet'");
  const si = resolvePlace(manifest, 'boro', 'staten-island');
  assert.deepEqual(sourceNames(si), ['d-501.parquet', 'd-502.parquet', 'd-503.parquet', 'd-595.parquet']);
  assert.equal(sourceSql(sourceNames(si)), "read_parquet(['d-501.parquet', 'd-502.parquet', 'd-503.parquet', 'd-595.parquet'])");
});

test('the borough of a district, and the borough link', () => {
  assert.equal(boroughOfCd(306).name, 'Brooklyn');
  assert.equal(boroughOfCd('355').name, 'Brooklyn');
  assert.equal(boroughOfCd(595).slug, 'staten-island');
  assert.equal(boroughOfCd(999), null);
  assert.equal(boroughBySlug('nowhere'), null);
  assert.equal(boroughUrl('staten-island'), 'district.html?geo=boro&id=staten-island');
});

test('a borough link keeps its filters through the full-page map and back', () => {
  const defaults = { start: '2025-11-01', end: '2026-11-13' };
  const search = 'geo=boro&id=brooklyn&start=2026-01-01&agency=NYPD&status=not_closed';
  const p = new URLSearchParams(search);
  const place = parsePlace(p);
  const s = filtersFromParams(p, defaults);
  const mapLink = filtersToParams(place.geo, place.id, s, defaults).toString();
  assert.equal(mapLink, search);
  const back = filtersFromParams(new URLSearchParams(mapLink), defaults);
  assert.equal(whereSql(back), whereSql(s));
  assert.match(whereSql(s), /agency = 'NYPD'/);
});

test('the borough map highlights all of its district shapes on the community district lines', () => {
  const features = CD_IDS.map((id) => ({ properties: { id } }));
  const bk = placeShapes('boro', 'brooklyn', features);
  assert.equal(bk.selected.length, 20);
  assert.ok(Array.isArray(bk.selectedId) && bk.selectedId.includes(355) && !bk.selectedId.includes(401));
  const cd = placeShapes('cd', '306', features);
  assert.equal(cd.selected.length, 1);
  assert.equal(cd.selectedId, 306);
  assert.equal(boundaryFile('boro'), 'cd');
  assert.equal(boundaryFile('cc'), 'cc');
  assert.equal(placeShapes('boro', 'atlantis', features).selected.length, 0);
});
