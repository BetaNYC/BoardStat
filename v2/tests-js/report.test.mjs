// Tests for the Help page's "Report a data problem" form (js/report.js): the exact payload the
// data-issue endpoint accepts, length limits, which page address is sent, and what the visitor
// is told for every answer. No network: every send uses a fake fetch.
// Run: node --test v2/tests-js/   (also run by `uv run pytest` in v2/pipeline)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_ENDPOINT, LIMITS, PAGE_PARAMS, charCount, choosePageUrl, validateReport, buildPayload,
  retryWait, describeResult, sendReport, MESSAGES, REPORT_FROM_PAGES, reportLinkHref,
} from '../site/js/report.js';
import { filtersToParams } from '../site/js/filterstate.js';

const HELP = 'https://www.beta.nyc/boardstat/help.html';
const DISTRICT = 'https://www.beta.nyc/boardstat/district.html?geo=cd&id=306&start=2025-01-01&type=Noise%20-%20Residential&agency=NYPD&status=not_closed';

/** A fake fetch that records its calls and answers with `status` and optional headers. */
function fakeFetch(status, headers = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { status, headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null }, json: async () => ({ ok: status === 201 }) };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------- payload

test('the payload has exactly the allowed keys, and no contact fields', () => {
  const p = buildPayload({ description: '  The count looks doubled  ', record: ' 12345678 ', website: '', pageUrl: HELP });
  assert.deepEqual(Object.keys(p).sort(), ['description', 'kind', 'page_url', 'record', 'schema', 'tool', 'website']);
  assert.deepEqual(p, {
    schema: 'betanyc-data-issue/1', tool: 'boardstat', kind: 'problem-report',
    page_url: HELP, description: 'The count looks doubled', website: '', record: '12345678',
  });
  for (const k of ['contact', 'credit_ok', 'client_id', 'dataset', 'batch_id', 'answers']) assert.ok(!(k in p), k);
});

test('an empty record is left out of the payload', () => {
  for (const record of ['', '   ', undefined]) {
    const p = buildPayload({ description: 'x', record, pageUrl: HELP });
    assert.deepEqual(Object.keys(p).sort(), ['description', 'kind', 'page_url', 'schema', 'tool', 'website']);
  }
});

test('the honeypot is sent as typed: empty for people, filled for bots (the server then files nothing)', () => {
  assert.equal(buildPayload({ description: 'x', pageUrl: HELP }).website, '');
  assert.equal(buildPayload({ description: 'x', website: 'http://spam.example', pageUrl: HELP }).website, 'http://spam.example');
});

// ---------------------------------------------------------------- lengths

test('description is required and at most 2000 characters', () => {
  assert.equal(validateReport({ description: '' }).ok, false);
  assert.match(validateReport({ description: '   \n ' }).errors.description, /say what looks wrong/);
  assert.equal(validateReport({ description: 'a'.repeat(LIMITS.description) }).ok, true);
  const long = validateReport({ description: 'a'.repeat(LIMITS.description + 1) });
  assert.equal(long.ok, false);
  assert.match(long.errors.description, /2,001 characters.*2,000 or fewer/);
  // Surrounding spaces do not count, as on the server.
  assert.equal(validateReport({ description: `  ${'a'.repeat(LIMITS.description)}  ` }).ok, true);
});

test('record is optional and at most 300 characters', () => {
  assert.equal(validateReport({ description: 'x', record: '' }).ok, true);
  assert.equal(validateReport({ description: 'x', record: 'r'.repeat(300) }).ok, true);
  const r = validateReport({ description: 'x', record: 'r'.repeat(301) });
  assert.equal(r.ok, false);
  assert.match(r.errors.record, /301 characters.*300 or fewer/);
  assert.equal(r.errors.description, undefined);
});

test('characters are counted as the server counts them: code points, after NFKC', () => {
  assert.equal(charCount('😀😀'), 2); // two code points, four UTF-16 units
  assert.equal(charCount('ﬁ'), 2); // NFKC turns the ligature into "fi"
  // 2000 ligatures pass the textarea's maxlength but are 4000 characters to the server.
  assert.equal(validateReport({ description: 'ﬁ'.repeat(2000) }).ok, false);
});

// ---------------------------------------------------------------- page_url

test('a BoardStat page on the same site is used, with its place and filters', () => {
  assert.equal(choosePageUrl(HELP, DISTRICT), DISTRICT);
  assert.equal(choosePageUrl(HELP, 'https://www.beta.nyc/boardstat/'), 'https://www.beta.nyc/boardstat/');
  assert.equal(choosePageUrl(HELP, 'https://www.beta.nyc/boardstat/map.html?geo=boro&id=brooklyn#x'),
    'https://www.beta.nyc/boardstat/map.html?geo=boro&id=brooklyn');
  // Local preview: same rule, built from location.origin and the site's folder.
  assert.equal(choosePageUrl('http://localhost:8000/help.html', 'http://localhost:8000/district.html?geo=cc&id=33'),
    'http://localhost:8000/district.html?geo=cc&id=33');
});

test('no referrer, or this page, gives the help page address', () => {
  assert.equal(choosePageUrl(HELP, ''), HELP);
  assert.equal(choosePageUrl(`${HELP}#feedback`, undefined), HELP);
  assert.equal(choosePageUrl(HELP, 'not a url'), HELP);
});

test('a referrer from another site is never used, look-alike hosts included', () => {
  for (const ref of [
    'https://www.beta.nyc.evil.example/boardstat/district.html?geo=cd&id=306',
    'https://evil.example/boardstat/district.html',
    'https://beta.nyc/boardstat/district.html?geo=cd&id=306', // other host on the same site name
    'http://www.beta.nyc/boardstat/district.html?geo=cd&id=306', // other scheme
    'https://www.beta.nyc:8443/boardstat/district.html',
    'https://www.beta.nyc@evil.example/boardstat/',
    'https://www.google.com/search?q=boardstat',
  ]) assert.equal(choosePageUrl(HELP, ref), HELP, ref);
});

test('a page on the same host but outside BoardStat is not used', () => {
  assert.equal(choosePageUrl(HELP, 'https://www.beta.nyc/blog/some-post/'), HELP);
  assert.equal(choosePageUrl(HELP, 'https://www.beta.nyc/boardstatx/district.html'), HELP);
});

test('no street address can reach page_url: only place, date and filter parameters survive', () => {
  const addr = 'https://www.beta.nyc/boardstat/address.html?geo=cd&id=301&addr=114%20NASSAU%20AVENUE%2C%20Brooklyn%2C%2011222';
  const got = choosePageUrl(HELP, addr);
  assert.equal(got, 'https://www.beta.nyc/boardstat/address.html?geo=cd&id=301');
  assert.ok(!/NASSAU|addr=|11222/i.test(got));
  // An old district link that still carries addr=, plus coordinates and a search.
  const old = choosePageUrl(HELP, 'https://www.beta.nyc/boardstat/district.html?geo=cd&id=306&addr=5%20AVENUE&lat=40.7&lng=-73.9&q=5%20ave&agency=DOT');
  assert.equal(old, 'https://www.beta.nyc/boardstat/district.html?geo=cd&id=306&agency=DOT');
  assert.ok(!PAGE_PARAMS.includes('addr'));
});

test('page_url over 500 characters falls back to the address without its query string', () => {
  const long = `https://www.beta.nyc/boardstat/district.html?geo=cd&id=306&desc=${encodeURIComponent('Loud Music/Party|'.repeat(40))}`;
  assert.ok(long.length > LIMITS.page_url);
  assert.equal(choosePageUrl(HELP, long), 'https://www.beta.nyc/boardstat/district.html');
});

test('page_url never contains whitespace', () => {
  const got = choosePageUrl(HELP, 'https://www.beta.nyc/boardstat/district.html?geo=cd&id=306&type=Noise - Residential');
  assert.ok(!/\s/.test(got), got);
});

// ---------------------------------------------------------------- the data pages' link (hand-off)

const DEFAULTS = { start: '2025-11-01', end: '2026-11-15' };
const NO_FILTERS = { ...DEFAULTS, types: [], descs: [], descEx: false, agency: '', status: '', addr: '' };

test('the link carries the page and the same parameters as the page\'s own links', () => {
  const s = { ...NO_FILTERS, start: '2025-01-01', types: ['Noise - Residential'], agency: 'NYPD', status: 'not_closed' };
  const p = filtersToParams('cd', '306', s, DEFAULTS);
  const href = reportLinkHref('district.html', p);
  assert.equal(href, `help.html?from=district.html&${p.toString()}#report-h`);
  assert.equal(href, 'help.html?from=district.html&geo=cd&id=306&start=2025-01-01&type=Noise+-+Residential&agency=NYPD&status=not_closed#report-h');
  assert.equal(reportLinkHref('map.html', filtersToParams('boro', 'brooklyn', NO_FILTERS, DEFAULTS)),
    'help.html?from=map.html&geo=boro&id=brooklyn#report-h');
  assert.deepEqual(REPORT_FROM_PAGES, ['district.html', 'map.html', 'address.html']);
});

test('the address page\'s link carries the place and filters, never the address', () => {
  // The address page's state holds the address; filtersToParams leaves it out.
  const s = { ...NO_FILTERS, addr: '114 NASSAU AVENUE, Brooklyn, 11222', agency: 'DOT' };
  const href = reportLinkHref('address.html', filtersToParams('cd', '301', s, DEFAULTS));
  assert.equal(href, 'help.html?from=address.html&geo=cd&id=301&agency=DOT#report-h');
  // Even if handed parameters with an address, coordinates or a search, only the report's survive.
  const leaky = new URLSearchParams({ geo: 'cd', id: '301', addr: '114 NASSAU AVENUE', lat: '40.7', lng: '-73.9', q: 'nassau', from: 'evil.html' });
  const h2 = reportLinkHref('address.html', leaky);
  assert.equal(h2, 'help.html?from=address.html&geo=cd&id=301#report-h');
  assert.ok(!/NASSAU|addr=|lat=|lng=|q=|evil/i.test(h2), h2);
});

test('an unknown page gets the plain link', () => {
  for (const page of ['evil.html', 'help.html', '../district.html', '', undefined]) {
    assert.equal(reportLinkHref(page, new URLSearchParams({ geo: 'cd', id: '306' })), 'help.html#report-h', String(page));
  }
});

test('the hand-off wins over the referrer, and is read back as the same page and filters', () => {
  const p = filtersToParams('cd', '306', { ...NO_FILTERS, types: ['Noise - Residential'], agency: 'NYPD' }, DEFAULTS);
  const help = new URL(reportLinkHref('district.html', p), HELP).href;
  const got = choosePageUrl(help, 'https://www.beta.nyc/boardstat/map.html?geo=cd&id=101');
  assert.equal(got, 'https://www.beta.nyc/boardstat/district.html?geo=cd&id=306&type=Noise+-+Residential&agency=NYPD');
  // The same with no referrer at all.
  assert.equal(choosePageUrl(help, ''), got);
  // Read back, it gives the same filters the page had.
  assert.equal(new URL(got).searchParams.get('type'), 'Noise - Residential');
  // Local preview: built from this page's own folder.
  assert.equal(choosePageUrl('http://localhost:8137/help.html?from=map.html&geo=cc&id=33#report-h', ''),
    'http://localhost:8137/map.html?geo=cc&id=33');
});

test('from itself is never sent, and only the report\'s parameters are copied', () => {
  const got = choosePageUrl(`${HELP}?from=address.html&geo=cd&id=301&addr=114%20NASSAU%20AVENUE&lat=40.7&q=x&utm_source=y`, '');
  assert.equal(got, 'https://www.beta.nyc/boardstat/address.html?geo=cd&id=301');
  assert.ok(!/from=|NASSAU|addr=|lat=|utm_/i.test(got), got);
  assert.equal(choosePageUrl(`${HELP}?from=map.html`, ''), 'https://www.beta.nyc/boardstat/map.html');
});

test('an unknown from is ignored: the referrer, else the help page, is used', () => {
  for (const from of ['evil.html', '../x', 'https://evil.example', 'https://evil.example/district.html', 'district.html/../x',
    '//evil.example/district.html', 'District.html', 'district.html?x', 'district.html#x', ' district.html', 'help.html', '']) {
    const help = `${HELP}?from=${encodeURIComponent(from)}&geo=cd&id=306`;
    assert.equal(choosePageUrl(help, ''), HELP, from);
    assert.equal(choosePageUrl(help, DISTRICT), DISTRICT, from);
  }
});

test('a hand-off over 500 characters falls back to the page without its query string', () => {
  const help = `${HELP}?from=district.html&geo=cd&id=306&desc=${encodeURIComponent('Loud Music/Party|'.repeat(40))}`;
  assert.equal(choosePageUrl(help, ''), 'https://www.beta.nyc/boardstat/district.html');
});

// ---------------------------------------------------------------- answers

test('201: thank you', () => {
  assert.deepEqual(describeResult({ status: 201 }), { kind: 'sent', message: MESSAGES.sent });
});

test('429: try again later, with a rough wait from Retry-After', () => {
  assert.match(describeResult({ status: 429, retryAfter: '180' }).message, /try again in about 3 minutes\.$/);
  assert.match(describeResult({ status: 429, retryAfter: '30' }).message, /in about 1 minute\.$/);
  assert.match(describeResult({ status: 429, retryAfter: '3600' }).message, /in about 60 minutes\.$/);
  assert.match(describeResult({ status: 429, retryAfter: '86400' }).message, /in about 24 hours\.$/);
  assert.match(describeResult({ status: 429, retryAfter: null }).message, /try again later\.$/);
  assert.match(describeResult({ status: 429, retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' }).message, /try again later\.$/);
  assert.equal(describeResult({ status: 429 }).kind, 'busy');
  assert.equal(retryWait('-5'), null);
});

test('every other answer, and no answer, says it did not go through and points to email', () => {
  for (const status of [200, 400, 403, 404, 500, 503]) {
    const r = describeResult({ status });
    assert.equal(r.kind, 'failed', String(status));
    assert.match(r.message, /did not go through/);
    assert.match(r.message, /Email boardstat@beta\.nyc button/);
    assert.match(r.message, /still here/);
  }
  assert.equal(describeResult({ networkError: true }).kind, 'failed');
});

test('copy stays plain: no exclamation marks, no "anonymous", no promise of a fix', () => {
  const all = [MESSAGES.sent, MESSAGES.failed, describeResult({ status: 429, retryAfter: '60' }).message].join(' ');
  assert.ok(!all.includes('!'));
  assert.ok(!/anonym|we will fix|will be fixed/i.test(all));
});

// ---------------------------------------------------------------- sending, with a fake fetch

test('sendReport POSTs JSON to the endpoint, once', async () => {
  const f = fakeFetch(201);
  const payload = buildPayload({ description: 'Wrong count', pageUrl: HELP });
  const r = await sendReport(payload, { fetchImpl: f });
  assert.equal(r.kind, 'sent');
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, REPORT_ENDPOINT);
  assert.equal(url, 'https://www.beta.nyc/wp-json/betanyc-data/v1/report');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(init.body), payload);
});

test('sendReport turns each status into the right message', async () => {
  assert.equal((await sendReport({}, { fetchImpl: fakeFetch(201) })).kind, 'sent');
  const busy = await sendReport({}, { fetchImpl: fakeFetch(429, { 'Retry-After': '600' }) });
  assert.equal(busy.kind, 'busy');
  assert.match(busy.message, /about 10 minutes/);
  for (const s of [400, 403, 503]) assert.equal((await sendReport({}, { fetchImpl: fakeFetch(s) })).kind, 'failed');
});

test('sendReport never throws on a network failure', async () => {
  const r = await sendReport({}, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual(r, { kind: 'failed', message: MESSAGES.failed });
});

test('sendReport does not send a body over 64 KB', async () => {
  const f = fakeFetch(201);
  const r = await sendReport({ description: 'x'.repeat(LIMITS.body_bytes) }, { fetchImpl: f });
  assert.equal(r.kind, 'failed');
  assert.equal(f.calls.length, 0);
});
