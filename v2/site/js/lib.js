// Shared helpers for the BoardStat 2.0 prototype. Plain ES modules, no build step.
//
// Third-party libraries, all loaded from jsDelivr at pinned versions:
//   @duckdb/duckdb-wasm 1.32.0 (MIT)        https://duckdb.org/docs/2.0/clients/wasm/instantiation
//   maplibre-gl 6.16.0 (BSD-3-Clause)      https://maplibre.org/maplibre-gl-js/docs/
//   @observablehq/plot 0.6.18 (ISC)        https://observablehq.com/plot/getting-started
//   pmtiles 4.5.0 (BSD-3-Clause)           https://docs.protomaps.com/pmtiles/maplibre
//   @protomaps/basemaps 5.7.2 (BSD-3-Clause) https://docs.protomaps.com/basemaps/maplibre
// jsDelivr's "/+esm" endpoint serves an npm package as an ES module
// (https://www.jsdelivr.com/documentation#id-esm); Plot's own docs use it.

export const VERSIONS = { duckdb: '1.32.0', maplibre: '6.16.0', plot: '0.6.18', pmtiles: '4.5.0', basemaps: '5.7.2' };
export const DUCKDB_URL = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${VERSIONS.duckdb}/+esm`;
export const MAPLIBRE_URL = `https://cdn.jsdelivr.net/npm/maplibre-gl@${VERSIONS.maplibre}/dist/maplibre-gl.mjs`;
export const PLOT_URL = `https://cdn.jsdelivr.net/npm/@observablehq/plot@${VERSIONS.plot}/+esm`;
export const PMTILES_URL = `https://cdn.jsdelivr.net/npm/pmtiles@${VERSIONS.pmtiles}/+esm`;
export const BASEMAPS_URL = `https://cdn.jsdelivr.net/npm/@protomaps/basemaps@${VERSIONS.basemaps}/+esm`;

export const STALE_HOURS = 48;

// ---------------------------------------------------------------- DuckDB-WASM

let dbPromise = null;

/** Instantiate DuckDB-WASM once, exactly as the docs' jsDelivr example does. */
export function getDB() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const duckdb = await import(DUCKDB_URL);
      // https://duckdb.org/docs/2.0/clients/wasm/instantiation (cdn(jsdelivr) section)
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
      );
      const worker = new Worker(workerUrl);
      const logger = new duckdb.VoidLogger();
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      // Read Parquet over HTTP range requests, not whole files. DuckDB-WASM 1.32.0
      // defaults forceFullHTTPReads to TRUE (lib/src/io/web_filesystem.cc:
      // force_full_http_reads.value_or(true)), so every registered file was fetched
      // whole in one GET. With it off, DuckDB probes with HEAD + "Range: bytes=0-" and
      // reads only the footer and the row groups a query needs. allowFullHTTPReads
      // stays on (its default), so a server without Range support still works.
      // Config keys: DuckDBFilesystemConfig in the package's types/src/bindings/config.d.ts.
      await db.open({ filesystem: { forceFullHTTPReads: false } });
      URL.revokeObjectURL(workerUrl);
      const conn = await db.connect();
      return { duckdb, db, conn };
    })();
  }
  return dbPromise;
}

/**
 * Make a file under data/ readable by SQL as `name`.
 * registerFileURL(name, url, DuckDBDataProtocol.HTTP, directIO=false)
 * per https://duckdb.org/docs/2.0/clients/wasm/data_ingestion
 */
export async function registerData(name, relPath) {
  const { duckdb, db } = await getDB();
  const url = new URL(dataUrl(relPath), window.location.href).href;
  await db.registerFileURL(name, url, duckdb.DuckDBDataProtocol.HTTP, false);
}

/** Run SQL and return plain objects (Arrow rows -> toJSON(), BigInt -> Number). */
export async function query(sql) {
  const { conn } = await getDB();
  const result = await conn.query(sql);
  // https://duckdb.org/docs/2.0/clients/wasm/query ("Arrow Table to JSON")
  return result.toArray().map((row) => {
    const o = row.toJSON();
    for (const k of Object.keys(o)) if (typeof o[k] === 'bigint') o[k] = Number(o[k]);
    return o;
  });
}

// SQL string literal; defined in filtersql.js so Node tests can use it too.
export { lit } from './filtersql.js';

// ---------------------------------------------------------------- manifest

// Data files keep the same names on every rebuild and the server sends no cache
// rule for them, so a browser could reuse yesterday's copy next to today's
// manifest. Every data link carries the build time (?v=generated_at) instead.
let dataVersion = '';
export const dataUrl = (relPath) => (dataVersion ? `${relPath}?v=${encodeURIComponent(dataVersion)}` : relPath);

export async function loadManifest() {
  const r = await fetch('data/manifest.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`data/manifest.json returned HTTP ${r.status}. Run the pipeline first (see v2/README.md).`);
  const m = await r.json();
  dataVersion = m.generated_at || '';
  return m;
}

export function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3.6e6;
}

/** Fill the "Data as of" line and show the stale banner if the build is old. */
export function renderDataStatus(manifest, asOfEl, staleEl) {
  const gen = new Date(manifest.generated_at);
  const src = manifest.sources?.service_requests || {};
  const portal = src.rowsUpdatedAt_iso ? new Date(src.rowsUpdatedAt_iso) : null;
  asOfEl.textContent =
    `Data as of ${fmtDateTime(gen)} (built from NYC Open Data` +
    (portal ? `, portal last updated ${fmtDateTime(portal)}` : '') +
    `). Requests created ${fmtDate(manifest.window.start)} to ${fmtDate(manifest.window.end)}` +
    (manifest.window.last_created ? `; the newest request in the data was created ${fmtDateTime(manifest.window.last_created.replace(' ', 'T'))}, because the city publishes 311 data with a delay of a day or more.` : '.');
  const age = hoursSince(manifest.generated_at);
  if (staleEl && age > STALE_HOURS) {
    staleEl.hidden = false;
    staleEl.textContent =
      `Heads up: this data was built ${Math.floor(age / 24)} days ago and may be out of date. ` +
      `Newer 311 requests will not appear until the data is rebuilt.`;
  }
}

/**
 * "What changed since the last update" from data/changes.json, which the nightly
 * refresh writes (new requests, updated requests, requests that became Closed).
 * No file, no line: a one-off build has nothing to compare against.
 */
export async function renderChanges(target, where = null) {
  if (!target) return;
  let c;
  try {
    const r = await fetch('data/changes.json', { cache: 'no-cache' });
    if (!r.ok) return;
    c = await r.json();
  } catch { return; }
  const part = (x = {}) => `${fmtInt(x.new || 0)} new, ${fmtInt(x.updated || 0)} updated, ${fmtInt(x.closed || 0)} closed`;
  let text = `What changed ${c.since ? `since ${fmtDateTime(c.since)}` : 'in the latest update'}: citywide ${part(c.city)}`;
  if (where) text += `; ${where.label} ${part(c[where.geo]?.[String(where.id)])}`;
  target.textContent = `${text}.`;
  target.hidden = false;
}

// ---------------------------------------------------------------- formatting

const nf = new Intl.NumberFormat('en-US');
export const fmtInt = (n) => (n == null || Number.isNaN(n) ? '–' : nf.format(Math.round(n)));
export const fmtDays = (n) => (n == null || Number.isNaN(n) ? '–' : `${n < 10 ? n.toFixed(1) : Math.round(n)} days`);
export const fmtPct = (n) => (n == null || Number.isNaN(n) ? '–' : `${(n * 100).toFixed(1)}%`);
export function fmtDate(d) {
  const x = typeof d === 'string' && d.length === 10 ? new Date(`${d}T12:00:00`) : new Date(d);
  return x.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
export function fmtDateTime(d) {
  return new Date(d).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
}

// ---------------------------------------------------------------- DOM helpers

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

/**
 * Build an accessible table. columns: [{key, label, num?, fmt?}]
 * On narrow screens CSS turns each row into a card (class "stack"; each cell's
 * data-label is its column name). Changing a table's CSS display drops its table
 * meaning in some browsers, so the ARIA table roles are set explicitly.
 */
export function table(rows, columns, caption) {
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'stack', role: 'table' },
      caption ? el('caption', { text: caption }) : null,
      el('thead', { role: 'rowgroup' }, el('tr', { role: 'row' }, columns.map((c) => el('th', { scope: 'col', role: 'columnheader', class: c.num ? 'num' : null, text: c.label })))),
      el('tbody', { role: 'rowgroup' }, rows.map((r) => el('tr', { role: 'row' }, columns.map((c) => {
        const v = r[c.key];
        const content = c.render ? c.render(r) : (c.fmt ? c.fmt(v, r) : (v ?? ''));
        return el('td', { role: 'cell', class: c.num ? 'num' : null, 'data-label': c.label }, content);
      }))))));
}

/** A chart plus a "Show as table" disclosure carrying the same numbers. */
export function chartWithTable(container, chartNode, rows, columns, caption) {
  // A redraw (new filters, or a resize) keeps the table open if the reader had opened it.
  const wasOpen = container.querySelector(':scope > details.as-table')?.open;
  container.replaceChildren(
    el('figure', {}, chartNode),
    el('details', { class: 'as-table', open: wasOpen || null }, el('summary', { text: 'Show as table' }), table(rows, columns, caption)),
  );
}

export function setStatus(node, msg) {
  if (node) node.textContent = msg || '';
}

export function districtLabel(manifest, geo, id) {
  const d = manifest.districts[geo]?.find((x) => String(x.id) === String(id));
  return d ? d.label : null;
}
