// Tests for site/js/analytics.js: no address, search or coordinates ever reaches the Google tag.
// Run: node --test v2/tests-js/   (also run by `uv run pytest` in v2/pipeline)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const a = require(path.join(__dirname, '..', 'site', 'js', 'analytics.js'));

const BASE = 'https://www.beta.nyc/boardstat/v2/';
const ADDR = '114 NASSAU AVENUE';

test('address page: the searched address is removed, the district is kept', () => {
  const href = `${BASE}address.html?geo=cd&id=301&addr=${encodeURIComponent(ADDR)}`;
  const out = a.sanitizeUrl(href);
  assert.equal(out, `${BASE}address.html?geo=cd&id=301`);
  assert.ok(!out.includes('NASSAU'));
});

test('any address, search or coordinate parameter is removed, whatever its name', () => {
  const href = `${BASE}district.html?geo=cc&id=33&addr=1+MAIN+ST&address=x&q=home&lat=40.7&lng=-73.9&lon=-73.9&latitude=1&longitude=2&ll=40,-73&zip=11222&utm_source=a`;
  assert.equal(a.sanitizeUrl(href), `${BASE}district.html?geo=cc&id=33`);
});

test('only the district and the dates stay; filter values and the fragment are dropped', () => {
  const href = `${BASE}district.html?geo=cd&id=105&start=2025-01-01&end=2025-12-31&type=Noise|Heat&agency=DSNY&status=not_closed&desc=Loud+Music&descx=1#addr=${encodeURIComponent(ADDR)}`;
  assert.equal(a.sanitizeUrl(href), `${BASE}district.html?geo=cd&id=105&start=2025-01-01&end=2025-12-31`);
});

test('the landing page #addr fragment never reaches Google', () => {
  assert.equal(a.sanitizeUrl(`${BASE}#addr`), BASE);
});

test('referrers: same-site referrers are cleaned, other sites cut to their origin', () => {
  const ref = `${BASE}address.html?geo=cd&id=301&addr=${encodeURIComponent(ADDR)}`;
  assert.equal(a.sanitizeReferrer(ref, 'www.beta.nyc'), `${BASE}address.html?geo=cd&id=301`);
  assert.equal(a.sanitizeReferrer('https://beta.nyc/boardstat/v2/address.html?addr=1+MAIN+ST', 'www.beta.nyc'), 'https://beta.nyc/boardstat/v2/address.html');
  assert.equal(a.sanitizeReferrer('https://www.google.com/search?q=114+nassau+avenue', 'www.beta.nyc'), 'https://www.google.com/');
  assert.equal(a.sanitizeReferrer('', 'www.beta.nyc'), '');
  assert.equal(a.sanitizeReferrer('not a url', 'www.beta.nyc'), '');
});

test('titles: the address page always gets a fixed title', () => {
  const href = `${BASE}address.html?geo=cd&id=301&addr=${encodeURIComponent(ADDR)}`;
  assert.equal(a.sanitizeTitle(`${ADDR} · BoardStat 2.0 (prototype)`, href), 'Address · BoardStat 2.0 (prototype)');
});

test('titles: an address carried in the URL is cut out of any other title', () => {
  const href = `${BASE}district.html?geo=cd&id=301&addr=${encodeURIComponent(ADDR)}`;
  const t = a.sanitizeTitle(`Brooklyn CD 1, ${ADDR} · BoardStat`, href);
  assert.ok(!t.includes('NASSAU'), t);
  assert.equal(a.sanitizeTitle('Brooklyn CD 1 · BoardStat 2.0 (prototype)', `${BASE}district.html?geo=cd&id=301`), 'Brooklyn CD 1 · BoardStat 2.0 (prototype)');
});

test('event parameters: only short codes pass, never free text or an address', () => {
  assert.deepEqual(a.cleanParams({ geo: 'cd', district_id: '301', filter: 'type' }), { geo: 'cd', district_id: '301', filter: 'type' });
  assert.deepEqual(a.cleanParams({ months: 13, start_year: '2024' }), { months: 13, start_year: '2024' });
  assert.deepEqual(a.cleanParams({ address: ADDR, geo: ADDR, filter: 'Noise complaint', district_id: '301 NASSAU', q: 'x' }), {});
  assert.deepEqual(a.cleanParams(null), {});
});

test('the tag id is the beta.nyc Google tag', () => {
  assert.equal(a.TAG_ID, 'GT-MQ7Q7VP');
});
