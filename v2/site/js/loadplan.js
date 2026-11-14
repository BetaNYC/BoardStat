// Which Closed requests the page loads into its `req` table, and when (#144). No DOM, so
// v2/tests-js can test it under Node; district.js passes in the function that runs SQL.
//
// Detail files hold the Closed requests first, in created_date order, then every
// request not yet Closed at the very end (boardstat_build.py). Every request that is not
// Closed is always loaded: "Still open from before this period" needs all of them.
// Closed requests load in two steps:
//
//   1. Before the first draw: Closed requests from the From date on. Every panel can
//      draw from that, except the "same month a year earlier" series.
//   2. After the first draw, in the background: the 12 months of Closed requests before
//      the From date, appended to the table, one file at a time. Then only the
//      Requests per month panel draws again.
//
// Each file keeps its own "loaded from" date, so no row is loaded twice: a load only
// asks for the Closed rows between the wanted date and what that file already has.
// (DuckDB-WASM's read-ahead still re-fetches bytes; district.js says where and how much.)
// district.js uses the two steps on borough pages only, and createLoader for every page.

import { lit } from './filtersql.js';

export const LOAD_BACK_MONTHS = 12;

/** The first day of the month `n` months before the month of `iso` (YYYY-MM-DD). */
export function monthsBefore(iso, n) {
  const d = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

const notBefore = (d, first) => (d > first ? d : first);

// A status filter other than Closed (including "not yet closed") never needs Closed rows.
const needsClosed = (state) => !state.status || state.status === 'Closed';

/** The earliest created date of Closed requests the period itself needs, or null for none. */
export function periodFrom(state, windowStart) {
  return needsClosed(state) ? notBefore(state.start, windowStart) : null;
}

/** The earliest created date of Closed requests the year-earlier series needs, or null for none. */
export function priorFrom(state, windowStart) {
  return needsClosed(state) ? notBefore(monthsBefore(state.start, LOAD_BACK_MONTHS), windowStart) : null;
}

/**
 * The date from which every file's Closed rows are loaded (the latest of the files'
 * dates), or null while any file has nothing loaded.
 */
export function loadedBound(fileFrom) {
  if (!fileFrom.length || fileFrom.some((d) => d === null)) return null;
  return fileFrom.reduce((a, b) => (a > b ? a : b));
}

/** Closed rows each file still lacks to reach `target`: [{ i, from, to }], `to` exclusive. */
export function missingRanges(fileFrom, target) {
  if (target === null) return [];
  return fileFrom.flatMap((d, i) => (d !== null && d > target ? [{ i, from: target, to: d }] : []));
}

/**
 * The earliest day for which year-earlier counts are complete, given what is loaded
 * (`loadedFrom` is loadedBound()). A status filter other than Closed reads only requests
 * that are always loaded, so then only the start of the data limits it.
 */
export function priorCoverStart(state, loadedFrom, windowStart) {
  if (!needsClosed(state) || loadedFrom === null) return windowStart;
  return notBefore(loadedFrom, windowStart);
}

/**
 * First load of a group of files: for each file, its Closed rows from `from` on, then its
 * rows not yet Closed (in that order). The first group creates the table; later groups
 * are appended. A whole borough from 2020 in one statement ran DuckDB-WASM out of
 * memory (#144 QA); groups of FILES_PER_STATEMENT files did not, and cost no more time.
 */
export function firstLoadSql(srcs, cols, from, create, table = 'req') {
  // The Closed branch runs first: run the other way round, DuckDB-WASM fetched about
  // 20% more bytes (CC 11, 2020+ data, measured 2026-11-06), because the second scan's
  // read-ahead re-fetched ranges the first had already read.
  return `
    ${create ? `CREATE OR REPLACE TABLE ${table} AS` : `INSERT INTO ${table}`}
    ${srcs.map((src) => `SELECT ${cols} FROM ${src} WHERE is_closed = true AND created_date >= CAST(${lit(from)} AS TIMESTAMP)
    UNION ALL
    SELECT ${cols} FROM ${src} WHERE is_closed = false`).join('\n    UNION ALL\n    ')}`;
}

/** Append Closed rows created in [from, to) of each { src, from, to }. */
export function extendSql(parts, cols, table = 'req') {
  return `
    INSERT INTO ${table}
    ${parts.map(({ src, from, to }) => `SELECT ${cols} FROM ${src} WHERE is_closed = true
      AND created_date >= CAST(${lit(from)} AS TIMESTAMP) AND created_date < CAST(${lit(to)} AS TIMESTAMP)`).join('\n    UNION ALL\n    ')}`;
}

/** How many files one load statement reads (measured on Brooklyn, 2026-11-13). */
export const FILES_PER_STATEMENT = 5;

/** Split a list into runs of at most n. */
export function chunks(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * The [name, path] entries of `files` that an error message names, by registered name
 * ('d-312.parquet') or by URL path ('detail/cd/312.parquet'). DuckDB-WASM names the
 * file either way, depending on whether opening it or reading a range failed.
 */
export function filesNamedIn(message, files) {
  return files.filter(([name, path]) => message.includes(`'${name}'`) || message.includes(`/${path}`) || message.includes(`${path}?`));
}

/** Run async functions one at a time, in the order they were queued. A failure does not stop the queue. */
export function createSerial() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const p = tail.then(fn);
      tail = p.catch(() => {});
      return p;
    },
  };
}

/**
 * Only the newest call may draw: `const t = guard.next(); await ...; if (!guard.isLatest(t)) return;`
 * keeps an older, slower query from overwriting a newer view.
 */
export function latestOnly() {
  let n = 0;
  return { next: () => ++n, isLatest: (t) => t === n };
}

/** Thrown when the data was rebuilt after the page opened: appending would mix two builds. */
export class DataChangedError extends Error {
  constructor() {
    super('The data was rebuilt after this page opened');
    this.name = 'DataChangedError';
  }
}

/**
 * Before anything is added to the table: the nightly build replaces the files in place,
 * so rows added after it would come from a different build than the rest (#144 QA).
 * Returns the loader's checkFresh for a page opened on the build `generatedAt`.
 */
export function freshnessCheck(generatedAt, getManifest = async () => {
  const r = await fetch('data/manifest.json', { cache: 'no-cache' });
  return r.ok ? r.json() : null;
}) {
  return async () => {
    let m;
    try { m = await getManifest(); } catch { return; }
    if (!m) return; // cannot tell; the read itself will fail if the files are gone
    if (m.generated_at !== generatedAt) throw new DataChangedError();
  };
}

/** The status line when the requests could not be loaded (district, address and map pages). */
export function loadFailedText(err) {
  if (err instanceof DataChangedError) return 'BoardStat updated its data after this page opened. Reload the page to see the new data.';
  return 'The requests could not be loaded. This can happen if the connection drops or the browser runs low on memory. Press Apply filters to try again, or reload the page.';
}

/**
 * The `req` table's loader. `exec(sql)` runs SQL; `sources[i]` is the SQL that reads file
 * i. All changes to the table go through one queue: the page's own loads in statements
 * of up to `perStatement` files, the background load one file per statement, so the
 * page's queries can run in between. `table` names the table it builds (default req; a
 * borough page also builds `rows` on demand, #151).
 * `checkFresh()` runs before anything is added to an existing table and throws
 * DataChangedError if the files are no longer the ones the table came from (the nightly
 * build replaces them in place).
 */
export function createLoader({ exec, sources, cols, checkFresh = async () => {}, perStatement = FILES_PER_STATEMENT, table = 'req' }) {
  const fileFrom = sources.map(() => null);
  const serial = createSerial();
  let created = false; // the req table exists
  let job = null; // the background load running now: { target, done }
  let lastError = null; // why the last background load failed, until the next one starts
  let pending = 0; // foreground loads queued or running

  /** Bring the files `ids` back to `target`, in one statement per kind. Returns true if rows were added. */
  async function loadFiles(ids, target) {
    const first = ids.filter((i) => fileFrom[i] === null);
    const more = ids.filter((i) => fileFrom[i] !== null && fileFrom[i] > target);
    if (first.length) {
      if (created) await checkFresh();
      await exec(firstLoadSql(first.map((i) => sources[i]), cols, target, !created, table));
      created = true;
      for (const i of first) fileFrom[i] = target;
    }
    if (more.length) {
      await checkFresh();
      await exec(extendSql(more.map((i) => ({ src: sources[i], from: target, to: fileFrom[i] })), cols, table));
      for (const i of more) fileFrom[i] = target;
    }
    return first.length + more.length > 0;
  }

  /** Foreground: make sure every file has Closed rows from `target` on. Resolves true if the table changed. */
  function loadFor(target, onLoading = () => {}) {
    pending++;
    return serial.run(async () => {
      let changed = false;
      try {
        const todo = sources.map((_, i) => i).filter((i) => fileFrom[i] === null || fileFrom[i] > target);
        let done = 0;
        for (const ids of chunks(todo, perStatement)) {
          onLoading(target, done, todo.length);
          if (await loadFiles(ids, target)) changed = true;
          done += ids.length;
        }
      } finally {
        pending--;
      }
      return changed;
    });
  }

  /**
   * Background: load Closed rows back to `target`, one file per queued step, so queries
   * for the page can run between files. Returns the running job, or null if there is
   * nothing to load. A job already reaching as far back keeps running; a job for an
   * earlier date replaces it (the older one stops after its current file). A replaced
   * job reports `superseded`, whether it then succeeded or failed.
   */
  function loadInBackground(target) {
    if (target === null || fileFrom.some((d) => d === null) || !missingRanges(fileFrom, target).length) return null;
    if (job && job.target <= target) return job;
    const mine = { target };
    job = mine;
    lastError = null;
    mine.done = (async () => {
      try {
        for (;;) {
          if (job !== mine) return { ok: true, superseded: true };
          const next = missingRanges(fileFrom, mine.target)[0];
          if (!next) break;
          // Worked out again inside the queue: a foreground load may have filled it meanwhile.
          await serial.run(() => loadFiles([next.i], mine.target));
        }
        if (job === mine) job = null;
        return { ok: true };
      } catch (error) {
        if (job !== mine) return { ok: false, error, superseded: true };
        job = null;
        lastError = error;
        return { ok: false, error };
      }
    })();
    return mine;
  }

  return {
    loadFor,
    loadInBackground,
    /** Run `fn` in the same queue as the loads (no load is running while it runs). */
    queue: (fn) => serial.run(fn),
    loadedFrom: () => loadedBound(fileFrom),
    fileFrom: () => [...fileFrom],
    running: () => job,
    lastError: () => lastError,
    /** True while a foreground load is queued or running: the table is not yet what the page needs. */
    loadPending: () => pending > 0,
  };
}
