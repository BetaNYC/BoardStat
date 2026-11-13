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

/** The first load: Closed rows from `from` on, then every row not yet Closed (in that order). */
export function initialLoadSql(src, cols, from) {
  // The Closed branch runs first: run the other way round, DuckDB-WASM fetched about
  // 20% more bytes (CC 11, 2020+ data, measured 2026-11-06), because the second scan's
  // read-ahead re-fetched ranges the first had already read.
  return `
    CREATE OR REPLACE TABLE req AS
    SELECT ${cols} FROM ${src} WHERE is_closed = true AND created_date >= CAST(${lit(from)} AS TIMESTAMP)
    UNION ALL
    SELECT ${cols} FROM ${src} WHERE is_closed = false`;
}

/** Append one file's Closed rows created in [from, to). */
export function extendSql(src, cols, from, to) {
  return `
    INSERT INTO req
    SELECT ${cols} FROM ${src} WHERE is_closed = true
      AND created_date >= CAST(${lit(from)} AS TIMESTAMP) AND created_date < CAST(${lit(to)} AS TIMESTAMP)`;
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

/**
 * The `req` table's loader. `exec(sql)` runs SQL; `sources[i]` is the SQL that reads file i
 * alone, `allSrc` reads every file. All changes to the table go through one queue.
 */
export function createLoader({ exec, sources, allSrc, cols }) {
  const fileFrom = sources.map(() => null);
  const serial = createSerial();
  let job = null; // the background load running now: { target, done }
  let lastError = null; // why the last background load failed, until the next one starts

  /** Foreground: make sure Closed rows from `target` on are loaded. Resolves true if the table changed. */
  function loadFor(target, onLoading = () => {}) {
    return serial.run(async () => {
      if (fileFrom.some((d) => d === null)) {
        onLoading(target);
        await exec(initialLoadSql(allSrc, cols, target));
        fileFrom.fill(target);
        return true;
      }
      const todo = missingRanges(fileFrom, target);
      if (todo.length) onLoading(target);
      for (const r of todo) {
        await exec(extendSql(sources[r.i], cols, r.from, r.to));
        fileFrom[r.i] = r.from;
      }
      return todo.length > 0;
    });
  }

  /**
   * Background: load Closed rows back to `target`, one file per queued step, so queries
   * for the page can run between files. Returns the running job, or null if there is
   * nothing to load. A job already reaching as far back keeps running; a job for an
   * earlier date replaces it (the older one stops after its current file).
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
          await serial.run(async () => {
            // Worked out again inside the queue: a foreground load may have filled it meanwhile.
            const r = missingRanges(fileFrom, mine.target).find((x) => x.i === next.i);
            if (!r) return;
            await exec(extendSql(sources[r.i], cols, r.from, r.to));
            fileFrom[r.i] = r.from;
          });
        }
        if (job === mine) job = null;
        return { ok: true };
      } catch (error) {
        if (job === mine) { job = null; lastError = error; }
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
  };
}
