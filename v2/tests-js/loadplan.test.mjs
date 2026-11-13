// Tests for site/js/loadplan.js: the page draws from the From date on, then loads the
// year before in the background (#144). Includes the races: Apply, Reset and date
// changes while the background load runs, and a background load that fails.
// Run: node --test v2/tests-js/   (also run by `uv run pytest` in v2/pipeline)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOAD_BACK_MONTHS, monthsBefore, periodFrom, priorFrom, loadedBound, missingRanges, priorCoverStart,
  firstLoadSql, extendSql, createSerial, latestOnly, createLoader, DataChangedError, filesNamedIn, freshnessCheck, loadFailedText,
} from '../site/js/loadplan.js';

const W = '2020-01-01';
const base = { start: '2025-11-01', end: '2026-11-04', status: '' };

test('monthsBefore goes back to the first of the month', () => {
  assert.equal(monthsBefore('2025-11-15', 12), '2024-11-01');
  assert.equal(monthsBefore('2025-01-31', 1), '2024-12-01');
  assert.equal(LOAD_BACK_MONTHS, 12);
});

test('the period needs Closed rows from the From date; the year earlier from 12 months before', () => {
  assert.equal(periodFrom(base, W), '2025-11-01');
  assert.equal(priorFrom(base, W), '2024-11-01');
  assert.equal(periodFrom({ ...base, status: 'Closed' }, W), '2025-11-01');
});

test('neither goes before the start of the data', () => {
  assert.equal(periodFrom({ ...base, start: '2019-05-01' }, W), W);
  assert.equal(priorFrom({ ...base, start: '2020-06-10' }, W), W);
});

test('a status other than Closed never needs Closed rows', () => {
  for (const status of ['not_closed', 'In Progress', 'Open']) {
    assert.equal(periodFrom({ ...base, status }, W), null);
    assert.equal(priorFrom({ ...base, status }, W), null);
  }
});

test('loadedBound is the latest file date, and null until every file has loaded', () => {
  assert.equal(loadedBound([]), null);
  assert.equal(loadedBound(['2025-11-01', null]), null);
  assert.equal(loadedBound(['2024-11-01', '2025-11-01', '2024-11-01']), '2025-11-01');
});

test('missingRanges asks each file only for what it lacks', () => {
  assert.deepEqual(missingRanges(['2025-11-01', '2024-11-01'], '2024-11-01'), [{ i: 0, from: '2024-11-01', to: '2025-11-01' }]);
  assert.deepEqual(missingRanges(['2024-11-01'], '2025-03-01'), []);
  assert.deepEqual(missingRanges(['2024-11-01'], null), []);
  assert.deepEqual(missingRanges([null], '2024-11-01'), []);
});

test('year-earlier counts are complete from what is loaded, or from the data start for statuses other than Closed', () => {
  assert.equal(priorCoverStart(base, '2025-11-01', W), '2025-11-01');
  assert.equal(priorCoverStart(base, '2024-11-01', W), '2024-11-01');
  assert.equal(priorCoverStart({ ...base, status: 'not_closed' }, '2025-11-01', W), W);
  assert.equal(priorCoverStart(base, null, W), W); // file loaded whole
});

test('the SQL: Closed branch first, and the background load appends Closed rows of one date range only', () => {
  const first = firstLoadSql(["'d.parquet'"], 'a, b', '2025-11-01', true);
  assert.match(first, /CREATE OR REPLACE TABLE req AS/);
  assert.ok(first.indexOf('is_closed = true') < first.indexOf('is_closed = false'));
  // Several files: each file's Closed rows, then its open rows, file after file.
  const next = firstLoadSql(["'d-301.parquet'", "'d-302.parquet'"], 'a, b', '2025-11-01', false);
  assert.match(next, /^\s*INSERT INTO req/);
  const at = (t) => next.indexOf(t);
  assert.ok(at("FROM 'd-301.parquet' WHERE is_closed = true") < at("FROM 'd-301.parquet' WHERE is_closed = false"));
  assert.ok(at("FROM 'd-301.parquet' WHERE is_closed = false") < at("FROM 'd-302.parquet' WHERE is_closed = true"));
  const more = extendSql([{ src: "'d-301.parquet'", from: '2024-11-01', to: '2025-11-01' }], 'a, b');
  assert.match(more, /INSERT INTO req/);
  assert.match(more, /created_date >= CAST\('2024-11-01' AS TIMESTAMP\) AND created_date < CAST\('2025-11-01' AS TIMESTAMP\)/);
  assert.doesNotMatch(more, /is_closed = false/);
});

test('createSerial runs one at a time, in order, and keeps going after a failure', async () => {
  const s = createSerial();
  const log = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = s.run(async () => { log.push('a+'); await wait(20); log.push('a-'); });
  const b = s.run(async () => { log.push('b+'); throw new Error('no'); });
  const c = s.run(async () => { log.push('c+'); return 3; });
  await a;
  await assert.rejects(b, /no/);
  assert.equal(await c, 3);
  assert.deepEqual(log, ['a+', 'a-', 'b+', 'c+']);
});

test('latestOnly: an older draw finishing late is dropped', () => {
  const g = latestOnly();
  const t1 = g.next();
  const t2 = g.next();
  assert.equal(g.isLatest(t1), false);
  assert.equal(g.isLatest(t2), true);
});

// ---- the loader, against a fake database that records what it is asked to read

/**
 * A fake `exec`. `log` gets one entry per file a statement reads Closed rows from:
 * [kind, file, from(, to)], where kind is 'create' or 'insert' for the whole statement.
 * `statements` counts statements. `hold()` keeps the next statement waiting until released.
 */
function fakeDb() {
  const log = [];
  const gates = [];
  let failNext = null;
  let statements = 0;
  const exec = async (sql) => {
    statements++;
    const kind = sql.includes('CREATE') ? 'create' : 'insert';
    for (const m of sql.matchAll(/FROM (\S+) WHERE is_closed = true\s+(?:AND created_date >= CAST\('([\d-]+)' AS TIMESTAMP\))(?: AND created_date < CAST\('([\d-]+)' AS TIMESTAMP\))?/g)) {
      log.push([kind, m[1], m[2], ...(m[3] ? [m[3]] : [])]);
    }
    if (gates.length) await gates.shift();
    if (failNext) { const e = failNext; failNext = null; throw e; }
  };
  return {
    exec, log, statements: () => statements,
    hold() { let release; gates.push(new Promise((r) => { release = r; })); return () => release(); },
    failOnce(e) { failNext = e; },
  };
}

const sources = ["'d-301.parquet'", "'d-302.parquet'", "'d-355.parquet'"];
// Two files per statement, so the three files take two statements.
const mk = (db, checkFresh, perStatement = 2) => createLoader({ exec: db.exec, sources, cols: 'a', checkFresh, perStatement });
const FIRST = [
  ['create', "'d-301.parquet'", '2025-11-01'],
  ['create', "'d-302.parquet'", '2025-11-01'],
  ['insert', "'d-355.parquet'", '2025-11-01'],
];
const tick = () => new Promise((r) => setTimeout(r, 0));

test('first load reads from the From date only, one file per statement; the background then appends the year before, file by file', async () => {
  const db = fakeDb();
  const L = mk(db);
  assert.equal(await L.loadFor('2025-11-01'), true);
  assert.equal(L.loadedFrom(), '2025-11-01');
  const job = L.loadInBackground('2024-11-01');
  assert.equal(L.running(), job);
  assert.deepEqual(await job.done, { ok: true });
  assert.equal(L.running(), null);
  assert.equal(L.loadedFrom(), '2024-11-01');
  assert.deepEqual(db.log, [
    ...FIRST,
    ['insert', "'d-301.parquet'", '2024-11-01', '2025-11-01'],
    ['insert', "'d-302.parquet'", '2024-11-01', '2025-11-01'],
    ['insert', "'d-355.parquet'", '2024-11-01', '2025-11-01'],
  ]);
  // Nothing left to do: no second load of the same rows.
  assert.equal(L.loadInBackground('2024-11-01'), null);
  assert.equal(await L.loadFor('2025-11-01'), false);
  assert.equal(db.log.length, 6);
  assert.equal(db.statements(), 5); // two statements for the first load (two files per statement), one per file after
});

test('no background load before the first load, or when nothing is needed', async () => {
  const L = mk(fakeDb());
  assert.equal(L.loadInBackground('2024-11-01'), null);
  await L.loadFor('2020-01-01');
  assert.equal(L.loadInBackground('2020-01-01'), null); // From date at the data start
  assert.equal(L.loadInBackground(null), null); // a status other than Closed
});

test('Apply while the background load runs: the page\'s own load goes before the remaining files, and nothing loads twice', async () => {
  const db = fakeDb();
  const L = mk(db);
  await L.loadFor('2025-11-01');
  const release = db.hold(); // hold the first background file
  const job = L.loadInBackground('2024-11-01');
  await tick();
  // The user moves the From date to 2025-03-01: the page needs that before drawing.
  const fg = L.loadFor('2025-03-01');
  release();
  assert.equal(await fg, true);
  await job.done;
  assert.equal(L.loadedFrom(), '2024-11-01');
  assert.deepEqual(db.log.slice(3), [
    ['insert', "'d-301.parquet'", '2024-11-01', '2025-11-01'], // background, already running
    ['insert', "'d-302.parquet'", '2025-03-01', '2025-11-01'], // the page's load, next in line
    ['insert', "'d-355.parquet'", '2025-03-01', '2025-11-01'],
    ['insert', "'d-302.parquet'", '2024-11-01', '2025-03-01'], // background: only the rest
    ['insert', "'d-355.parquet'", '2024-11-01', '2025-03-01'],
  ]);
  // Every file holds exactly [2024-11-01, ...): no gap, no overlap.
  assert.deepEqual(L.fileFrom(), ['2024-11-01', '2024-11-01', '2024-11-01']);
});

test('a From date earlier than the background target: the page loads it first and the background has nothing left', async () => {
  const db = fakeDb();
  const L = mk(db);
  await L.loadFor('2025-11-01');
  const release = db.hold();
  const job = L.loadInBackground('2024-11-01');
  await tick();
  const fg = L.loadFor('2023-01-01');
  release();
  await fg;
  assert.deepEqual(await job.done, { ok: true });
  assert.deepEqual(L.fileFrom(), ['2023-01-01', '2023-01-01', '2023-01-01']);
  const keys = db.log.slice(3).map((e) => e.join());
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(db.log.slice(3), [
    ['insert', "'d-301.parquet'", '2024-11-01', '2025-11-01'],
    ['insert', "'d-301.parquet'", '2023-01-01', '2024-11-01'],
    ['insert', "'d-302.parquet'", '2023-01-01', '2025-11-01'],
    ['insert', "'d-355.parquet'", '2023-01-01', '2025-11-01'],
  ]);
});

test('a newer background target replaces the running one; an older one keeps the running job', async () => {
  const db = fakeDb();
  const L = mk(db);
  await L.loadFor('2025-11-01');
  const release = db.hold();
  const job1 = L.loadInBackground('2024-11-01');
  await tick();
  assert.equal(L.loadInBackground('2025-02-01'), job1); // Reset to a later From date: already covered
  const job2 = L.loadInBackground('2023-06-01'); // an earlier From date
  assert.notEqual(job2, job1);
  release();
  assert.deepEqual(await job1.done, { ok: true, superseded: true });
  assert.deepEqual(await job2.done, { ok: true });
  assert.deepEqual(L.fileFrom(), ['2023-06-01', '2023-06-01', '2023-06-01']);
  assert.deepEqual(db.log.slice(3), [
    ['insert', "'d-301.parquet'", '2024-11-01', '2025-11-01'],
    ['insert', "'d-301.parquet'", '2023-06-01', '2024-11-01'],
    ['insert', "'d-302.parquet'", '2023-06-01', '2025-11-01'],
    ['insert', "'d-355.parquet'", '2023-06-01', '2025-11-01'],
  ]);
});

test('a failed background load keeps what loaded, reports the error, and a later call retries only the rest', async () => {
  const db = fakeDb();
  const L = mk(db);
  await L.loadFor('2025-11-01');
  const release0 = db.hold();
  const release1 = db.hold();
  const job = L.loadInBackground('2024-11-01');
  await tick();
  release0();
  await tick();
  db.failOnce(new Error('network')); // the second file's read fails
  release1();
  const r = await job.done;
  assert.equal(r.ok, false);
  assert.match(r.error.message, /network/);
  assert.equal(L.running(), null);
  assert.match(L.lastError().message, /network/);
  assert.deepEqual(L.fileFrom(), ['2024-11-01', '2025-11-01', '2025-11-01']);
  assert.equal(L.loadedFrom(), '2025-11-01'); // the year-earlier series stays absent
  // The page still works: a foreground load right after the failure succeeds.
  assert.equal(await L.loadFor('2025-11-01'), false);
  const retry = L.loadInBackground('2024-11-01');
  assert.equal(L.lastError(), null);
  assert.deepEqual(await retry.done, { ok: true });
  assert.equal(L.loadedFrom(), '2024-11-01');
  assert.equal(db.log.filter((e) => e[1] === "'d-301.parquet'").length, 2); // first load + its year before, once each
});

test('a failed first load leaves nothing marked as loaded, so the next try loads again', async () => {
  const db = fakeDb();
  const L = mk(db);
  db.failOnce(new Error('offline'));
  await assert.rejects(L.loadFor('2025-11-01'), /offline/);
  assert.equal(L.loadedFrom(), null);
  assert.equal(L.loadInBackground('2024-11-01'), null);
  assert.equal(await L.loadFor('2025-11-01'), true);
  assert.equal(db.log.filter((e) => e[0] === 'create').length, 4); // the CREATE (two files) ran twice
});

test('a first load that fails part way keeps the files it loaded and goes on from the failed one', async () => {
  const db = fakeDb();
  const L = mk(db, undefined, 1);
  const release0 = db.hold();
  const release1 = db.hold();
  const fg = L.loadFor('2020-01-01');
  await tick();
  release0();
  await tick();
  db.failOnce(new Error('too small to be a Parquet file'));
  release1();
  await assert.rejects(fg, /too small/);
  assert.deepEqual(L.fileFrom(), ['2020-01-01', null, null]);
  assert.equal(L.loadedFrom(), null);
  assert.equal(L.loadInBackground('2019-01-01'), null); // nothing in the background until the first load is whole
  assert.equal(await L.loadFor('2020-01-01'), true);
  assert.deepEqual(db.log.map((e) => e.slice(0, 2)), [
    ['create', "'d-301.parquet'"], ['insert', "'d-302.parquet'"], // failed
    ['insert', "'d-302.parquet'"], ['insert', "'d-355.parquet'"], // the retry: no CREATE, 301 not read again
  ]);
});

test('loadPending is true while a foreground load waits or runs, so a redraw can wait for it', async () => {
  const db = fakeDb();
  const L = mk(db);
  await L.loadFor('2025-11-01');
  const release = db.hold();
  const job = L.loadInBackground('2024-11-01');
  await tick();
  assert.equal(L.loadPending(), false); // a background load alone does not count
  const fg = L.loadFor('2025-03-01');
  assert.equal(L.loadPending(), true);
  release();
  await fg;
  assert.equal(L.loadPending(), false);
  await job.done;
});

test('a replaced background load that then fails reports superseded, so no failure note is shown for it', async () => {
  const db = fakeDb();
  const L = mk(db);
  await L.loadFor('2025-11-01');
  const release = db.hold();
  const job1 = L.loadInBackground('2024-11-01');
  await tick();
  const job2 = L.loadInBackground('2023-06-01');
  db.failOnce(new Error('network'));
  release();
  const r1 = await job1.done;
  assert.equal(r1.ok, false);
  assert.equal(r1.superseded, true);
  assert.equal(L.lastError(), null);
  assert.deepEqual(await job2.done, { ok: true });
});

test('after a nightly rebuild nothing is appended: the first load still runs, appends stop with DataChangedError', async () => {
  const db = fakeDb();
  let rebuilt = false;
  const checks = [];
  const L = mk(db, async () => { checks.push(db.log.length); if (rebuilt) throw new DataChangedError(); });
  await L.loadFor('2025-11-01');
  assert.deepEqual(checks, [2]); // before the appended statement, not before the CREATE (two files)
  rebuilt = true;
  const r = await L.loadInBackground('2024-11-01').done;
  assert.equal(r.ok, false);
  assert.ok(r.error instanceof DataChangedError);
  await assert.rejects(L.loadFor('2025-03-01'), DataChangedError);
  assert.equal(db.statements(), 2); // no rows from the new build were mixed in
  assert.deepEqual(L.fileFrom(), ['2025-11-01', '2025-11-01', '2025-11-01']);
});

test('filesNamedIn finds the failed file by registered name or by URL, and nothing else', () => {
  const files = [['d-31.parquet', 'data/detail/cd/31.parquet'], ['d-302.parquet', 'data/detail/cd/302.parquet'], ['d-312.parquet', 'data/detail/cd/312.parquet']];
  const open = "Invalid Error: Opening file 'd-312.parquet' failed with error: NetworkError";
  const range = 'Range request for http://127.0.0.1:8791/data/detail/cd/312.parquet?v=2026-11-13T10%3A42%3A22Z failed with error';
  assert.deepEqual(filesNamedIn(open, files).map((f) => f[0]), ['d-312.parquet']);
  assert.deepEqual(filesNamedIn(range, files).map((f) => f[0]), ['d-312.parquet']);
  assert.deepEqual(filesNamedIn('TProtocolException: Invalid data', files), []);
  assert.deepEqual(filesNamedIn("Opening file 'd.parquet' failed", [['d.parquet', 'data/detail/cd/306.parquet']]).map((f) => f[0]), ['d.parquet']);
});

test('freshnessCheck: same build passes, a new build throws, an unreadable manifest is not a rebuild', async () => {
  await freshnessCheck('A', async () => ({ generated_at: 'A' }))();
  await assert.rejects(freshnessCheck('A', async () => ({ generated_at: 'B' }))(), DataChangedError);
  await freshnessCheck('A', async () => null)();
  await freshnessCheck('A', async () => { throw new Error('offline'); })();
});

test('loadFailedText is plain, and names a rebuild only when there was one', () => {
  assert.match(loadFailedText(new Error('TProtocolException')), /could not be loaded/);
  assert.doesNotMatch(loadFailedText(new Error('TProtocolException')), /TProtocol/);
  assert.match(loadFailedText(new DataChangedError()), /updated its data/);
});
