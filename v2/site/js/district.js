// District page: every query runs in DuckDB-WASM over ONE district's Parquet file, or,
// for a whole borough (geo=boro, #144), over all of its community districts' files at once.
import {
  PLOT_URL, loadManifest, renderDataStatus, renderChanges, dataUrl, registerData, reregisterData, query, lit, el, table, chartWithTable,
  setStatus, fmtInt, fmtDays, fmtPct, fmtDate, fmtDateTime, monthLabel,
} from './lib.js';
import { setupRequestMap, loadRequestPoints, mapNoteText, renderMapLegend } from './requestmap.js';
import {
  NOT_CLOSED, filtersFromParams, filtersToParams, describeFilters, keepKnownStatus,
} from './filterstate.js';
import { whereSql, NOT_CLOSED_SQL, DESC_SQL } from './filtersql.js';
import { createFilterForm, tableLists, DATE_ORDER_MSG } from './filterform.js';
import { parsePlace, resolvePlace, sourceNames, sourceSql, boroughOfCd, boroughUrl } from './place.js';
import {
  periodFrom, priorFrom, priorCoverStart, createLoader, latestOnly, DataChangedError, filesNamedIn, freshnessCheck, loadFailedText,
} from './loadplan.js';

const $ = (id) => document.getElementById(id);
const PAGE = 50;
const BLUE = '#2359a8';
const GRAY = '#949494';
const DARK = '#414141';
const STATUS_COLORS = [BLUE, '#B8D6FF', DARK, GRAY, '#EEF4FF', '#F1F1F1'];
// Problems over time (address page): six colors that stay visible as bar fills; the last is "Other".
const PROBLEM_COLORS = [BLUE, '#7fa8e0', DARK, '#c27c0e', '#3f8f5b', '#c8c8c8'];
// Status shortcut NOT_CLOSED, NOT_CLOSED_SQL and DESC_SQL: filterstate.js and filtersql.js.
// Time to close counts only requests marked Closed. days_to_close is already NULL
// when there is no close date or the close date is impossible (see README decision 5);
// this also drops the few not-Closed requests that carry a close date.
const CLOSED_DAYS = `CASE WHEN status = 'Closed' THEN days_to_close END`;

const params = new URLSearchParams(window.location.search);
// geo is cd, cc or boro (a whole borough, #144); for boro the id is the borough's slug.
const { geo, id: geoId } = parsePlace(params);
const IS_BORO = geo === 'boro';
// address.html reuses this page for one address: the address filter is fixed,
// and the district-wide panels (top addresses, compare) are left out.
const ADDRESS_MODE = document.body.dataset.mode === 'address';

let manifest, district, Plot;
// The SQL that reads this page's rows: 'd.parquet', or read_parquet([...]) for a borough (place.js).
let SRC = `'d.parquet'`;
// `state` is the applied filters: what every panel shows and the link carries. The form
// (filterform.js) keeps its own draft; only Apply, Reset and shortcuts change `state` (#142).
let state = {};
let page = 0;
let total = 0;
let mapCtx = null;
let selectedType = null;
let addrInfo = null; // address page: { zip, cd, cc, boro, lng, lat } of the address
let asOfSql = null; // build time as an NYC-local TIMESTAMP literal; "days open" is measured to it
let viewStart = null; // the From date a link without dates opens with (manifest.window.default_start)
let loader = null; // loads the req table (loadplan.js); null when the file is loaded whole
let loadedFrom = null; // Closed requests created before this date are not (all) in the req table
let tableLoads = 0; // counts loads made before a draw, so the filter lists are refilled after one

// ------------------------------------------------------------- loading only what the view needs
//
// Detail files hold the Closed requests first, in created_date order, then every
// request not yet Closed at the very end, in 50,000-row groups (boardstat_build.py).
// The page loads every request not yet Closed ("Still open from before this period"
// needs all of them) plus the Closed requests from LOAD_BACK_MONTHS before the From
// date: the "same month a year earlier" series needs that year. So the rows a page
// needs are one run of row groups at the end of each file. DuckDB-WASM reads only the
// row groups whose min/max statistics match, over HTTP range requests (lib.js turns off
// forceFullHTTPReads; https://duckdb.org/docs/stable/data/parquet/overview#partial-reading).
// Its read-ahead grows each read fourfold while reads stay contiguous, up to 16 MB
// (duckdb-wasm 1.32.0, lib/include/duckdb/web/io/readahead_buffer.h), so a run that
// ends at the end of the file costs about the raw bytes from its first row group to
// the end of the file, unselected columns included. The Closed branch of the load
// runs first (firstLoadSql in loadplan.js says why). Loads read up to five district
// files per statement, into an in-memory database stored compressed (see main()): a
// whole borough from 2020 in one uncompressed statement ran DuckDB-WASM out of memory.
//
// A borough page loads in two steps instead (#144, loadplan.js): Closed requests from
// the From date on, then draw, then the year before in the background, file by file,
// and draw Requests per month again. That second read starts mid-file, so read-ahead
// runs on to the end of the file and fetches the first step's bytes again: two steps
// cost the one-step bytes plus the first step's. Measured 2026-11-13 at 50 Mbit/s,
// Brooklyn draws in 26 s instead of 37 s for 49 MB more; a community district (CD 306)
// draws 0.4 s sooner for 4.7 MB more (+60%), so district, council district and
// address pages keep the one-step load. TWO_STEP below switches it.
//
// Moving the From date earlier appends only the missing older Closed rows.
const TWO_STEP = IS_BORO;
// The columns the page's panels use. The CSV download reads every column straight
// from the file instead, so the long text fields never sit in memory.
const LOAD_COLUMNS = ['unique_key', 'created_date', 'closed_date', 'agency', 'agency_name', 'complaint_type', 'descriptor', 'status',
  'incident_address', 'intersection_street_1', 'intersection_street_2', 'incident_zip', 'borough', 'latitude', 'longitude',
  'cd', 'cc', 'days_to_close', 'address_norm', 'year_month'];
// Files built before range loading have no is_closed column or default_start; load those whole.
const rangeLoading = () => Boolean(manifest.window.default_start);

/** Before a draw: make sure the req table holds every row the current filters' period needs. */
async function ensureLoaded() {
  if (!loader) {
    if (loadedFrom === null) { await query(`CREATE TABLE req AS SELECT * FROM ${SRC}`); loadedFrom = manifest.window.start; tableLoads++; }
    return;
  }
  // A status other than Closed needs no Closed rows; the first load still takes the
  // default view's, so that switching back to every status is quick.
  const firstFrom = (s) => (TWO_STEP ? periodFrom : priorFrom)(s, manifest.window.start);
  const target = firstFrom(state) ?? (loadedFrom === null ? firstFrom({ start: viewStart }) : null);
  if (target === null) return;
  const changed = await loader.loadFor(target, (from, done, n) => setStatus($('status'),
    `Loading requests from ${fmtDate(from)} on…${n > 1 && done ? ` (${done} of ${n} districts loaded)` : ''}`));
  loadedFrom = loader.loadedFrom();
  if (changed) tableLoads++;
}

/**
 * After a draw: load the year before the From date in the background, then draw
 * Requests per month again. A failure leaves the rest of the page as it is.
 */
function loadPriorYear() {
  if (!loader || !TWO_STEP) return;
  const job = loader.loadInBackground(priorFrom(state, manifest.window.start));
  if (!job || job.watched) return;
  job.watched = true;
  job.done.then(async (r) => {
    loadedFrom = loader.loadedFrom();
    if (r.superseded) return; // the job that replaced it draws (and reports) instead
    if (!r.ok) {
      console.error(r.error);
      priorFailure = r.error;
      if (!(r.error instanceof DataChangedError)) await freshDataFiles(r.error);
    }
    // A load for newer filters is still running: its refresh draws Requests per month
    // once the table is complete, so drawing now would count a half-loaded table.
    if (loader.loadPending()) return;
    await renderMonthly();
    announcePrior(r.ok ? 'Requests per month now shows the same months a year earlier.' : priorFailureText(r.error));
  }).catch((err) => console.error(err));
}

/** Say once, to screen readers, that the year-earlier line arrived or failed (not on every redraw). */
function announcePrior(text) {
  const live = $('monthly-live');
  if (live) live.textContent = text;
}

/** The note under Requests per month when the year before could not be added. */
function priorFailureText(err) {
  return err instanceof DataChangedError
    ? 'BoardStat updated its data after this page opened, so the same months a year earlier were not added. Reload the page to see them with the new data.'
    : 'The same months a year earlier could not be loaded, so that line is left out. Everything else on this page is complete. Reload the page, or change a filter and press Apply filters, to try again.';
}


// Why the last background load failed; cleared when the page draws again, which retries it.
let priorFailure = null;
let dataFiles = []; // [name, path] of each detail file this page reads
/**
 * After a failed read: register again only the files the error names, so a retry does
 * not reuse a bad buffer (lib.js). Files that were read without trouble are left alone:
 * re-registering one of those made its next read fail ("Failed to open file", #144 QA).
 */
function freshDataFiles(err) {
  const failed = filesNamedIn(String(err?.message || err || ''), dataFiles);
  if (!failed.length) return Promise.resolve();
  const redo = async () => {
    for (const [name, path] of failed) {
      try { await reregisterData(name, path); } catch (e) { console.error(e); }
    }
  };
  return loader ? loader.queue(redo) : redo();
}

// ------------------------------------------------------------- state <-> URL

/** The page's default dates: what a link without start or end opens with. */
const defaultDates = () => ({ start: viewStart, end: manifest.window.end });

function readState() {
  return filtersFromParams(params, defaultDates());
}

function writeUrl() {
  // Street addresses never go back into the URL bar after the page loads, so no
  // later history entry (or analytics page view; see analytics.js) can carry one.
  // The address page keeps the address it was opened with and does not rewrite its
  // URL at all; the district page's address filter is not kept in the link
  // (filtersToParams never writes it).
  if (ADDRESS_MODE) return;
  const p = filtersToParams(geo, geoId, state, defaultDates());
  history.replaceState(null, '', `?${p.toString()}`);
  updateFullMapLink(p);
}

/** The "Open full-page map" link carries the same district, dates and filters (#143). */
function updateFullMapLink(p) {
  const a = $('fullmap-link');
  if (!a) return;
  a.href = `map.html?${p.toString()}`;
  // The link to the whole borough keeps the dates and filters too (#144).
  const bl = $('boro-link');
  const b = geo === 'cd' ? boroughOfCd(geoId) : null;
  if (bl && b) bl.href = `district.html?${filtersToParams('boro', b.slug, state, defaultDates()).toString()}`;
  // The address filter never goes into a link, so the full-page map cannot show it.
  const note = $('fullmap-addr-note');
  if (note) {
    note.hidden = !state.addr;
    if (IS_BORO) note.textContent = note.textContent.replace('the whole district', 'the whole borough');
  }
}

function where(opts = {}) {
  return whereSql(state, opts);
}

// ------------------------------------------------------------- filter controls
//
// The form itself is shared with the full-page map (filterform.js, #149). This page
// supplies its lists, from the rows it has loaded, and redraws on Apply.

let form = null;

/** The filters a link with no filters opens with (the Reset button's target). */
function defaultFilters() {
  return { start: viewStart, end: manifest.window.end, types: [], descs: [], descEx: false, agency: '', status: '', addr: ADDRESS_MODE ? state.addr : '' };
}

/** Shortcut buttons in the panels (an agency, a description, an address) apply at once. */
function applyNow(fn) {
  form.applyNow(fn);
}

/** The form's lists, from this page's rows, for the applied dates (filterform.js tableLists). */
const formLists = tableLists(query, () => state);

/** Fill the problem, agency and status lists: again after a load, and whenever the applied dates change. */
let optionsFrom;
async function fillFilterOptions() {
  const key = `${tableLoads}|${state.start}|${state.end}`;
  if (optionsFrom === key) return;
  optionsFrom = key;
  await form.fillLists();
}

/**
 * What the page needs once, right after its first load works: the filter lists, a
 * status the data does not have dropped from the link, and the address page's links.
 * main() runs it; if the first load failed, the first refresh that loads runs it.
 */
let firstLoadDone = false;
async function afterFirstLoad() {
  firstLoadDone = true;
  await fillFilterOptions();
  state = keepKnownStatus(state, form.statusChoices());
  form.set(state);
  if (ADDRESS_MODE) await renderAddressLinks();
}

function setupFilters() {
  form.bind(manifest.window.start, manifest.window.end);
  form.set(state);
  form.openGroups();
  $('print').addEventListener('click', () => { window.boardstatTrack?.('print_page', { geo, district_id: geoId }); window.print(); });
  window.addEventListener('beforeprint', describeFiltersForPrint);
  $('prev').addEventListener('click', () => { if (page > 0) { page--; renderDetail(); } });
  $('next').addEventListener('click', () => { if ((page + 1) * PAGE < total) { page++; renderDetail(); } });
  $('download').addEventListener('click', downloadCsv);
}

function describeFiltersForPrint() {
  const parts = describeFilters(state, fmtDate);
  $('print-filters').textContent = `${parts.join('; ')}. Printed ${fmtDate(new Date())} from BoardStat 2.0 (prototype).`;
}

// ------------------------------------------------------------- panels

async function renderKpis() {
  const [k] = await query(`
    SELECT count(*)::INTEGER AS n,
           count(*) FILTER (WHERE status IS DISTINCT FROM 'Closed')::INTEGER AS open_n,
           median(${CLOSED_DAYS}) AS med, avg(${CLOSED_DAYS}) AS avg
    FROM req WHERE ${where()}`);
  total = k.n;
  const items = [
    ['Requests', fmtInt(k.n)],
    ['Not yet closed', fmtInt(k.open_n)],
    ['Median time to close', fmtDays(k.med)],
    ['Average time to close', fmtDays(k.avg)],
  ];
  $('kpis').replaceChildren(...items.map(([label, value]) => el('div', { class: 'kpi' }, el('span', { class: 'value', text: value }), el('span', { class: 'label', text: label }))));
}

async function renderTop() {
  const rows = await query(`
    SELECT complaint_type AS t, count(*)::INTEGER AS n, median(${CLOSED_DAYS}) AS med
    FROM req WHERE ${where()} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`);
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (!rows.length) { $('top').replaceChildren(el('p', { text: 'No requests match these filters.' })); return; }
  const list = el('ol', { class: 'barlist', 'aria-label': 'Top 10 request types by number of requests' },
    rows.map((r) => el('li', {}, el('button', {
      type: 'button', 'aria-pressed': String(selectedType === r.t),
      'aria-label': `${r.t}: ${fmtInt(r.n)} requests. Show descriptions.`,
      onclick: () => { selectedType = selectedType === r.t ? null : r.t; renderTop(); renderDescriptors(); },
    }, el('span', { text: r.t }), el('span', { class: 'bar', style: `width:${(100 * r.n) / max}%`, 'aria-hidden': 'true' }), el('span', { class: 'num', text: fmtInt(r.n) })))));
  $('top').replaceChildren(list, el('details', { class: 'as-table' }, el('summary', { text: 'Show as table' }),
    table(rows, [
      { key: 't', label: 'Problem' }, { key: 'n', label: 'Requests', num: true, fmt: fmtInt },
      { key: 'med', label: 'Median time to close', num: true, fmt: fmtDays },
    ], 'Top 10 request types')));
}

async function renderDescriptors() {
  if (!selectedType) { $('descriptors').replaceChildren(); return; }
  // The description filter is left off here so every description stays visible and selectable.
  const rows = await query(`
    SELECT ${DESC_SQL} AS d, count(*)::INTEGER AS n
    FROM req WHERE ${where({ skipDesc: true })} AND complaint_type = ${lit(selectedType)} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`);
  const verb = state.descEx ? 'Exclude' : 'Add';
  $('descriptors').replaceChildren(
    el('h3', { text: `What people described: ${selectedType}` }),
    table(rows, [
      {
        key: 'd', label: 'Description (descriptor)',
        render: (r) => (state.descs.includes(r.d)
          ? el('span', {}, r.d, el('span', { class: 'muted', text: state.descEx ? ' (excluded)' : ' (in the filter)' }))
          : el('button', { type: 'button', class: 'link', 'aria-label': `${verb} description ${r.d} ${state.descEx ? 'from' : 'to'} the filter`,
            onclick: () => applyNow((s) => ({ descs: s.descs.includes(r.d) ? s.descs : [...s.descs, r.d] })) }, r.d)),
      },
      { key: 'n', label: 'Requests', num: true, fmt: fmtInt },
    ], `Select a description to ${state.descEx ? 'exclude it' : 'add it to the filter'}. The description filter does not narrow this table.`),
    ...(state.types.includes(selectedType) ? []
      : [el('p', {}, el('button', { type: 'button', class: 'secondary', onclick: () => { const t = selectedType; applyNow((s) => ({ types: s.types.includes(t) ? s.types : [...s.types, t] })); } }, `Filter the page to ${selectedType}`))]),
  );
}

/** Last calendar day with data: the newest created date, or the window end. */
function lastDataDay() {
  const lc = manifest.window.last_created;
  const d = lc ? lc.slice(0, 10) : manifest.window.end;
  return d < manifest.window.end ? d : manifest.window.end;
}

/** Days of a month (YYYY-MM) that the chosen dates and the data cover, or null if the whole month. */
function partialSpan(ym, from, to) {
  const [y, m] = ym.split('-').map(Number);
  const first = `${ym}-01`;
  const last = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  const a = from > first ? from : first;
  const b = to < last ? to : last;
  return a === first && b === last ? null : [a, b];
}

/**
 * Draw a chart as wide as the box it goes in. Plot's default width is a fixed 640px and
 * Plot does not resize on its own (https://observablehq.com/plot/features/plots, "The
 * default width is 640"), so charts are redrawn when the page width changes (see
 * watchChartWidth). Below `min` the chart is drawn at `min` and scaled down by CSS
 * (figure svg { max-width: 100% }), so long labels still fit on a phone.
 */
const chartWidth = (id, min = 320) => Math.max(min, Math.floor($(id)?.clientWidth || 640));

/** Y-axis ticks for small counts: whole numbers only (no "0.5 requests"). */
const countY = (max) => (max <= 8 ? { ticks: Array.from({ length: Math.max(1, max) + 1 }, (_, i) => i), tickFormat: 'd' } : { tickFormat: '~s' });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Newest year first: strong blue, then lighter, so the newest year stands out.
const YEAR_COLORS = [BLUE, '#6f9bd6', GRAY, '#c8c8c8'];

/** Requests per month as one line per calendar year (used for ranges over 13 months). */
function yearChart(rows, title, spanText, width) {
  const pts = rows.map((r) => ({
    year: r.ym.slice(0, 4), month: MONTHS[Number(r.ym.slice(5, 7)) - 1], ym: r.ym, n: r.n,
    partial: !!r.span, span: r.span, series: r.ym.slice(0, 4),
  }));
  const years = [...new Set(pts.map((d) => d.year))].sort().reverse();
  const range = years.map((_, i) => YEAR_COLORS[Math.min(i, YEAR_COLORS.length - 1)]);
  const full = pts.filter((d) => !d.partial);
  const part = pts.filter((d) => d.partial);
  const marks = [Plot.ruleY([0])];
  // Oldest first, so the newest year is drawn on top.
  for (const y of [...years].reverse()) {
    const newest = y === years[0];
    const line = full.filter((d) => d.year === y);
    marks.push(
      Plot.lineY(line, { x: 'month', y: 'n', stroke: 'year', strokeWidth: newest ? 3 : 1.5 }),
      Plot.dot(line, { x: 'month', y: 'n', stroke: 'year', fill: 'white', r: newest ? 3.5 : 2.5, tip: true, title }),
    );
  }
  marks.push(
    Plot.dot(part, { x: 'month', y: 'n', stroke: 'year', fill: 'none', strokeDasharray: '2,2', r: 5, tip: true, title }),
    Plot.text(part, { x: 'month', y: 'n', text: () => 'partial', textAnchor: 'end', dx: -8, dy: -8, fill: DARK, fontSize: 11 }),
  );
  return Plot.plot({
    ariaLabel: 'Requests per month, one line per year',
    ariaDescription: `Line chart with one line per calendar year (${[...years].reverse().join(', ')}), months January to December along the bottom. The newest year is the thickest line.` +
      (part.length ? ' Months with only some days are shown as separate hollow dots, not joined to the line.' : ''),
    width,
    height: 280,
    marginLeft: 56,
    x: { type: 'point', domain: MONTHS, label: null },
    y: { label: 'Requests', grid: true, ...countY(Math.max(...pts.map((d) => d.n))) },
    color: { type: 'ordinal', domain: years, range, legend: true },
    marks,
  });
}

// Only the newest Requests per month draw is shown: the background load of the year
// before (loadPriorYear) draws it again, and must never overwrite a newer view.
const monthlyDraw = latestOnly();

async function renderMonthly() {
  // A month is "partial" when the From/To dates or the end of the data cut it short.
  // Partial months are shown as hollow dots off the line, so a short month never
  // looks like a drop. The year-earlier series uses exactly the same days, shifted
  // back 12 months (every filter except From/To applies).
  // While a load for new filters runs the table is half filled; that load's refresh draws.
  if (loader?.loadPending()) return;
  const draw = monthlyDraw.next();
  // Year-earlier counts are complete only from coverFrom on: what is loaded when the
  // query runs (rows are only ever added, so reading it first is safe).
  const coverFrom = priorCoverStart(state, loadedFrom, manifest.window.start);
  const priorFailed = priorFailure;
  const effEnd = state.end < lastDataDay() ? state.end : lastDataDay();
  // When the dates reach the end of the data, the year-earlier series stops at the
  // same minute as the newest request, since the last day is usually only partly in.
  const lc = manifest.window.last_created;
  const cutAtNewest = lc && effEnd === lastDataDay();
  const prevEndSql = cutAtNewest
    ? `created_date <= CAST(${lit(lc)} AS TIMESTAMP) - INTERVAL 12 MONTH`
    : `created_date < CAST(${lit(effEnd)} AS DATE) + INTERVAL 1 DAY - INTERVAL 12 MONTH`;
  const rows = await query(`
    WITH months AS (
      -- Every month in the range, so a month with no requests shows as 0, not a gap.
      SELECT strftime(d, '%Y-%m') AS ym FROM range(date_trunc('month', CAST(${lit(state.start)} AS DATE)),
        CAST(${lit(effEnd)} AS DATE) + INTERVAL 1 DAY, INTERVAL 1 MONTH) AS t(d)
    ), counts AS (
      SELECT year_month AS ym, count(*)::INTEGER AS n FROM req WHERE ${where()} GROUP BY 1
    ), m AS (
      SELECT ym, coalesce(n, 0)::INTEGER AS n FROM months LEFT JOIN counts USING (ym)
    ), prev_year AS (
      SELECT strftime(created_date + INTERVAL 12 MONTH, '%Y-%m') AS ym, count(*)::INTEGER AS n_prior
      FROM req WHERE ${where({ skipDates: true })}
        AND created_date >= CAST(${lit(state.start)} AS DATE) - INTERVAL 12 MONTH
        AND ${prevEndSql}
        AND created_date >= CAST(${lit(manifest.window.start)} AS DATE)
      GROUP BY 1
    )
    SELECT m.ym, m.n, prev_year.n_prior FROM m LEFT JOIN prev_year USING (ym) ORDER BY m.ym`);
  if (!monthlyDraw.isLatest(draw)) return;
  // A year-earlier month is only shown if the data covers all of its matching days,
  // and the page has loaded them (the year before loads after the first draw).
  const priorStartOf = (ym) => {
    const [y, mo] = ym.split('-').map(Number);
    const span = partialSpan(ym, state.start, effEnd) || [`${ym}-01`, null];
    return `${y - 1}-${String(mo).padStart(2, '0')}-${span[0].slice(8)}`;
  };
  let priorMissing = 0;
  for (const r of rows) {
    r.span = partialSpan(r.ym, state.start, effEnd);
    const priorStart = priorStartOf(r.ym);
    if (priorStart < manifest.window.start) r.n_prior = null;
    else if (priorStart < coverFrom) { r.n_prior = null; r.priorWait = true; priorMissing++; }
  }
  const spanText = (sp) => (sp ? `partial month: ${fmtDate(sp[0])}${sp[0] === sp[1] ? '' : ` to ${fmtDate(sp[1])}`} only` : '');
  const data = [];
  for (const r of rows) {
    const date = new Date(`${r.ym}-01T12:00:00`);
    data.push({ date, ym: r.ym, series: 'This period', n: r.n, partial: !!r.span, span: r.span });
    if (r.n_prior != null) data.push({ date, ym: r.ym, series: 'Same month a year earlier', n: r.n_prior, partial: !!r.span, span: r.span });
  }
  // Until every year-earlier month is loaded, the chart shows This period only, with the
  // legend already in place (one key), so the line and its key appear together and
  // nothing below moves. The table shows each month's value as it is.
  const shown = priorMissing ? data.filter((d) => d.series === 'This period') : data;
  const full = shown.filter((d) => !d.partial);
  const part = shown.filter((d) => d.partial);
  const hasPrior = shown.some((d) => d.series !== 'This period');
  const title = (d) => `${monthLabel(d.ym)}: ${fmtInt(d.n)} (${d.series}${d.partial ? `; ${spanText(d.span)}` : ''})`;
  // More than 13 months: one line per calendar year, Jan to Dec along the bottom,
  // so years sit on top of each other instead of one long line plus a shifted copy.
  const byYear = rows.length > 13;
  const width = chartWidth('monthly');
  const chart = byYear ? yearChart(rows, title, spanText, width) : Plot.plot({
    ariaLabel: 'Requests per month',
    ariaDescription: 'Line chart of requests per month for the filtered requests' + (hasPrior ? ', with the same month a year earlier where available' : '') +
      (part.length ? '. Months with only some days are shown as separate hollow dots, not joined to the line.' : '.'),
    width,
    height: 260,
    marginLeft: 56,
    x: { type: 'utc', label: null, ticks: 6, tickFormat: '%b %Y' },
    y: { label: 'Requests', grid: true, ...countY(Math.max(0, ...shown.map((d) => d.n))) },
    color: { domain: priorMissing ? ['This period'] : ['This period', 'Same month a year earlier'], range: [BLUE, GRAY], legend: hasPrior || priorMissing > 0 },
    marks: [
      Plot.ruleY([0]),
      Plot.lineY(full, { x: 'date', y: 'n', stroke: 'series', strokeWidth: 2 }),
      Plot.dot(full, { x: 'date', y: 'n', stroke: 'series', fill: 'white', symbol: 'series', tip: true, title }),
      Plot.dot(part, { x: 'date', y: 'n', stroke: 'series', fill: 'none', strokeDasharray: '2,2', r: 5, tip: true, title }),
      Plot.text(part.filter((d) => d.series === 'This period'), { x: 'date', y: 'n', text: () => 'partial', textAnchor: 'end', dx: -8, dy: -8, fill: DARK, fontSize: 11 }),
    ],
  });
  chartWithTable($('monthly'), chart, rows, [
    { key: 'ym', label: 'Month', fmt: (v, r) => (r.span ? `${monthLabel(v)} (${spanText(r.span)})` : monthLabel(v)) },
    { key: 'n', label: 'Requests', num: true, fmt: fmtInt },
    { key: 'n_prior', label: 'Same days a year earlier', num: true,
      fmt: (v, r) => (v != null ? fmtInt(v) : !r.priorWait ? 'not in data' : priorFailed ? 'not loaded' : 'loading…') },
  ], 'Requests per month');
  if (priorMissing) {
    // No live role here: the note is redrawn with the chart. announcePrior says it once.
    $('monthly').append(priorFailed
      ? el('p', { class: 'muted prior-failed', text: priorFailureText(priorFailed) })
      : el('p', { class: 'muted prior-loading', text: 'Loading the same months a year earlier…' }));
  }
  if (byYear) $('monthly').append(el('p', { class: 'muted', text: 'Each line is one calendar year, so you can compare the same month across years. The newest year is the thickest line. The table lists every month.' }));
  if (part.length) {
    const list = rows.filter((r) => r.span).map((r) => `${monthLabel(r.ym)} (${spanText(r.span).replace('partial month: ', '')})`).join(' and ');
    $('monthly').append(el('p', { class: 'muted', text: `Hollow dots are partial months, so they are lower than a full month would be: ${list}. The newest request in the data is from ${lc ? fmtDateTime(lc.replace(' ', 'T')) : fmtDate(lastDataDay())}, because the city publishes 311 data with a delay.${priorMissing ? '' : ' Year-earlier values cover the same days, up to the same time, one year earlier.'}` }));
  }
}

const fmtDayNum = (v) => (v == null ? '–' : v.toFixed(1));

async function renderAgencyResponse() {
  const rows = await query(`
    SELECT agency, any_value(agency_name) AS agency_name, count(*)::INTEGER AS n,
           count(*) FILTER (WHERE ${NOT_CLOSED_SQL})::INTEGER AS open_n,
           count(*) FILTER (WHERE status = 'Closed')::INTEGER AS closed_n,
           median(${CLOSED_DAYS}) AS med, avg(${CLOSED_DAYS}) AS avg
    FROM req WHERE ${where()} GROUP BY 1 ORDER BY 3 DESC, 1`);
  if (!rows.length) { $('agency-resp').replaceChildren(el('p', { text: 'No requests match these filters.' })); return; }
  $('agency-resp').replaceChildren(table(rows, [
    {
      key: 'agency', label: 'Agency',
      render: (r) => el('span', {},
        el('button', {
          type: 'button', class: 'link', 'aria-pressed': String(state.agency === r.agency),
          'aria-label': state.agency === r.agency ? `Stop filtering to ${r.agency}` : `Filter the page to ${r.agency}`,
          onclick: () => { const agency = state.agency === r.agency ? '' : r.agency; applyNow(() => ({ agency })); },
        }, r.agency),
        r.agency_name ? el('span', { class: 'muted', text: ` ${r.agency_name}` }) : null),
    },
    { key: 'n', label: 'Requests', num: true, fmt: fmtInt },
    { key: 'open_n', label: 'Not yet closed', num: true, fmt: fmtInt },
    { key: 'closed_n', label: 'Closed', num: true, fmt: fmtInt },
    { key: 'med', label: 'Median days to close (closed only)', num: true, fmt: fmtDayNum },
    { key: 'avg', label: 'Average days to close (closed only)', num: true, fmt: fmtDayNum },
  ], 'Requests and time to close, by agency'));
}

function dayBefore(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Show the requests created before the From date that are still not closed. */
function showBacklog(agency) {
  const patch = { end: dayBefore(state.start), start: manifest.window.start, status: NOT_CLOSED, ...(agency ? { agency } : {}) };
  applyNow(() => patch);
  $('filters-bar').scrollIntoView({ block: 'start' });
}

async function renderBacklog() {
  const first = manifest.window.start;
  if (state.start <= first) {
    $('backlog').replaceChildren(el('p', {
      text: `The data starts on ${fmtDate(first)}, the same day as the From date, so there is nothing earlier to show. Move the From date later to see older requests that are still open.`,
    }));
    return;
  }
  // Every filter except From/To and Status applies.
  const rows = await query(`
    SELECT agency, any_value(agency_name) AS agency_name, count(*)::INTEGER AS n,
           strftime(min(created_date), '%Y-%m-%d') AS oldest
    FROM req WHERE ${where({ skipDates: true, skipStatus: true })}
      AND created_date < CAST(${lit(state.start)} AS DATE) AND ${NOT_CLOSED_SQL}
    GROUP BY 1 ORDER BY 3 DESC, 1`);
  const n = rows.reduce((a, r) => a + r.n, 0);
  const lead = `${fmtInt(n)} ${n === 1 ? 'request' : 'requests'} created between ${fmtDate(first)} (when the data starts) and ${fmtDate(dayBefore(state.start))} ${n === 1 ? 'was' : 'were'} still not closed when this data was built. Problem, description, agency and address filters apply.`;
  if (!n) { $('backlog').replaceChildren(el('p', { text: lead })); return; }
  $('backlog').replaceChildren(
    el('p', {}, lead, ' ', el('button', { type: 'button', class: 'secondary no-print', onclick: () => showBacklog() }, 'Show these requests')),
    table(rows, [
      {
        key: 'agency', label: 'Agency',
        render: (r) => el('span', {},
          el('button', { type: 'button', class: 'link', 'aria-label': `Show the ${fmtInt(r.n)} older requests for ${r.agency} that are still open`, onclick: () => showBacklog(r.agency) }, r.agency),
          r.agency_name ? el('span', { class: 'muted', text: ` ${r.agency_name}` }) : null),
      },
      { key: 'n', label: 'Still not closed', num: true, fmt: fmtInt },
      { key: 'oldest', label: 'Oldest created', fmt: (v) => fmtDate(v) },
    ], 'Older requests still open, by agency'),
  );
}

async function renderAgency() {
  const rows = await query(`
    WITH top_agencies AS (SELECT agency FROM req WHERE ${where()} GROUP BY 1 ORDER BY count(*) DESC LIMIT 8)
    SELECT agency, coalesce(status, 'Unknown') AS status, count(*)::INTEGER AS n
    FROM req WHERE ${where()} AND agency IN (SELECT agency FROM top_agencies) GROUP BY ALL ORDER BY agency, status`);
  // Only 6 colors can be told apart, so keep Closed plus the 4 most common other
  // statuses and group the rest as "Other statuses" (the table keeps every status).
  const totals = new Map();
  for (const r of rows) totals.set(r.status, (totals.get(r.status) || 0) + r.n);
  const keep = new Set(['Closed', ...[...totals].filter(([st]) => st !== 'Closed').sort((x, y) => y[1] - x[1]).slice(0, STATUS_COLORS.length - 2).map(([st]) => st)]);
  const OTHER = 'Other statuses';
  const chartRows = rows.map((r) => (keep.has(r.status) ? r : { ...r, status: OTHER }));
  const statuses = [...new Set(chartRows.map((r) => r.status))].sort((a, b) => (a === 'Closed' ? -1 : b === 'Closed' ? 1 : a === OTHER ? 1 : b === OTHER ? -1 : a.localeCompare(b)));
  const chart = Plot.plot({
    ariaLabel: 'Requests by agency and status',
    ariaDescription: 'Stacked horizontal bars: one bar per agency (top 8), split by request status.',
    width: chartWidth('agency'),
    marginLeft: 70,
    height: 40 + 34 * new Set(rows.map((r) => r.agency)).size,
    x: { label: 'Requests', grid: true, tickFormat: '~s' },
    y: { label: null },
    color: { domain: statuses, range: STATUS_COLORS, legend: true },
    marks: [
      Plot.barX(chartRows, { y: 'agency', x: 'n', fill: 'status', stroke: DARK, strokeWidth: 0.5, sort: { y: '-x' }, tip: true }),
      Plot.ruleX([0]),
    ],
  });
  chartWithTable($('agency'), chart, rows, [
    { key: 'agency', label: 'Agency' }, { key: 'status', label: 'Status' }, { key: 'n', label: 'Requests', num: true, fmt: fmtInt },
  ], 'Requests by agency and status (top 8 agencies)');
}

/** Address page: requests per month, split by the five most common problems. */
async function renderTimeline() {
  const OTHER = 'Other problems';
  const rows = await query(`
    WITH top AS (SELECT complaint_type AS t FROM req WHERE ${where()} GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 5)
    SELECT year_month AS ym, CASE WHEN complaint_type IN (SELECT t FROM top) THEN complaint_type ELSE ${lit(OTHER)} END AS t, count(*)::INTEGER AS n
    FROM req WHERE ${where()} GROUP BY ALL ORDER BY 1, 2`);
  if (!rows.length) { $('timeline').replaceChildren(el('p', { text: 'No requests match these filters.' })); return; }
  const totals = new Map();
  for (const r of rows) totals.set(r.t, (totals.get(r.t) || 0) + r.n);
  const types = [...totals].sort((a, b) => (a[0] === OTHER ? 1 : b[0] === OTHER ? -1 : b[1] - a[1])).map(([t]) => t);
  const data = rows.map((r) => ({ ...r, date: new Date(`${r.ym}-01T00:00:00Z`) }));
  const d3sum = (ds) => { const m = new Map(); for (const d of ds) m.set(d.ym, (m.get(d.ym) || 0) + d.n); return m.values(); };
  const chart = Plot.plot({
    ariaLabel: 'Requests at this address per month, by problem',
    ariaDescription: `Stacked bars, one per month, split into ${types.join(', ')}.`,
    width: chartWidth('timeline'),
    height: 280,
    marginLeft: 56,
    x: { type: 'utc', label: null, tickFormat: '%b %Y', ticks: 6 },
    y: { label: 'Requests', grid: true, ...countY(Math.max(...[...d3sum(data)])) },
    color: { domain: types, range: types.map((t, i) => (t === OTHER ? PROBLEM_COLORS[5] : PROBLEM_COLORS[Math.min(i, 4)])), legend: true },
    marks: [
      Plot.rectY(data, { x: 'date', interval: 'month', y: 'n', fill: 't', stroke: DARK, strokeWidth: 0.5, inset: 0.5, tip: true,
        title: (d) => `${monthLabel(d.ym)}: ${fmtInt(d.n)} ${d.t}` }),
      Plot.ruleY([0]),
    ],
  });
  chartWithTable($('timeline'), chart, rows, [
    { key: 'ym', label: 'Month', fmt: (v) => monthLabel(v) },
    { key: 't', label: 'Problem' },
    { key: 'n', label: 'Requests', num: true, fmt: fmtInt },
  ], 'Requests at this address per month, by problem');
}

/**
 * Address page: this address's mix of problems next to its community district and
 * council district. Only the dates apply (like the district Compare panel), and the
 * districts use whole months from the aggregate file.
 */
async function renderAddressCompare() {
  const cd = addrInfo?.cd != null ? String(addrInfo.cd) : null;
  const cc = addrInfo?.cc != null ? String(addrInfo.cc) : null;
  const label = (g, id) => manifest.districts[g]?.find((x) => String(x.id) === id)?.label || `${g.toUpperCase()} ${id}`;
  const cdLabel = cd ? label('cd', cd) : null;
  const ccLabel = cc ? label('cc', cc) : null;
  const keep = new URLSearchParams();
  if (state.start !== viewStart) keep.set('start', state.start);
  if (state.end !== manifest.window.end) keep.set('end', state.end);
  const extra = keep.toString() ? `&${keep}` : '';
  $('acmp-links').replaceChildren(
    ...(cd ? [el('li', {}, el('a', { class: 'button', href: `district.html?geo=cd&id=${encodeURIComponent(cd)}${extra}` }, `Open ${cdLabel}`))] : []),
    ...(cc ? [el('li', {}, el('a', { class: 'button secondary', href: `district.html?geo=cc&id=${encodeURIComponent(cc)}${extra}` }, `Open ${ccLabel}`))] : []),
  );
  const ymStart = state.start.slice(0, 7);
  const ymEnd = state.end.slice(0, 7);
  $('acmp-note').textContent = `Share of each problem among requests at this address, next to the same share across ${[cdLabel, ccLabel].filter(Boolean).join(' and ') || 'its districts'}. ` +
    `The address uses your From and To dates; the districts use whole months, ${monthLabel(ymStart)} to ${monthLabel(ymEnd)}. Problem, description, agency and status filters do not apply here.`;
  const rows = await query(`
    WITH a AS (
      SELECT complaint_type AS t, count(*) AS n FROM req
      WHERE ${where({ skipType: true, skipDesc: true, skipStatus: true, skipAgency: true })}
      GROUP BY 1
    ), ash AS (SELECT t, n / sum(n) OVER () AS a_share FROM a),
    g AS (
      SELECT geo_kind, complaint_type AS t, sum(n) AS n
      FROM ${aggRows(ymStart, ymEnd, [['cd', cd || ''], ['cc', cc || '']])}
      GROUP BY ALL
    ), gs AS (SELECT geo_kind, t, n / sum(n) OVER (PARTITION BY geo_kind) AS g_share FROM g),
    top AS (SELECT t, a_share FROM ash ORDER BY a_share DESC, t LIMIT 10)
    SELECT top.t, top.a_share AS a,
      max(g_share) FILTER (WHERE geo_kind = 'cd') AS d,
      max(g_share) FILTER (WHERE geo_kind = 'cc') AS c
    FROM top LEFT JOIN gs USING (t) GROUP BY top.t, top.a_share ORDER BY a DESC, top.t`);
  if (!rows.length) { $('acmp').replaceChildren(el('p', { text: 'No requests at this address in these dates.' })); return; }
  const names = ['This address', cdLabel || 'Community district', ccLabel || 'Council district'];
  const long = rows.flatMap((r) => [
    { t: r.t, where: names[0], share: r.a ?? 0 },
    { t: r.t, where: names[1], share: r.d ?? 0 },
    { t: r.t, where: names[2], share: r.c ?? 0 },
  ]);
  const chart = Plot.plot({
    ariaLabel: 'Share of top request types: this address, its community district, its council district',
    ariaDescription: 'Dot chart comparing each top request type\'s share of requests at this address, in its community district, and in its council district.',
    width: chartWidth('acmp', 420),
    marginLeft: 180,
    height: 50 + 30 * rows.length,
    x: { label: 'Share of requests', tickFormat: '.0%', grid: true },
    y: { label: null, domain: rows.map((r) => r.t) },
    color: { domain: names, range: [BLUE, DARK, GRAY], legend: true },
    symbol: { domain: names, range: ['circle', 'square', 'triangle'] },
    marks: [Plot.dot(long, { x: 'share', y: 't', fill: 'where', symbol: 'where', r: 5, tip: true })],
  });
  chartWithTable($('acmp'), chart, rows, [
    { key: 't', label: 'Problem' },
    { key: 'a', label: 'This address', num: true, fmt: fmtPct },
    { key: 'd', label: names[1], num: true, fmt: fmtPct },
    { key: 'c', label: names[2], num: true, fmt: fmtPct },
  ], 'Share of requests by problem: this address and its districts');
}

async function renderAddresses() {
  const rows = await query(`
    SELECT address_norm AS a, count(*)::INTEGER AS n, mode(complaint_type) AS top_type
    FROM req WHERE ${where()} AND address_norm IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`);
  $('addresses').replaceChildren(table(rows, [
    { key: 'a', label: 'Address', render: (r) => el('button', { type: 'button', class: 'link', 'aria-label': `Filter to ${r.a}`, onclick: () => applyNow(() => ({ addr: r.a })) }, r.a) },
    { key: 'n', label: 'Requests', num: true, fmt: fmtInt },
    { key: 'top_type', label: 'Most common problem' },
  ], 'Select an address to filter the page to it'));
}

/**
 * Rows of agg/month_type.parquet for the given (geo_kind, geo_id) pairs and months, as a
 * parenthesized subquery. One UNION ALL branch per pair, because DuckDB prunes row groups
 * with min/max statistics only for AND-ed filters; an OR across geo_kind and geo_id made
 * every Compare query read the whole file. The file is sorted by geo_kind, geo_id,
 * year_month (boardstat_build.py), so each branch touches one or two row groups.
 * A null geo_id matches the kind alone ('city' has a single id).
 */
function aggRows(ymStart, ymEnd, pairs) {
  return '(' + pairs.map(([kind, id]) => `
      SELECT geo_kind, complaint_type, n FROM 'agg.parquet'
      WHERE geo_kind = ${lit(kind)}${id === null ? '' : ` AND geo_id = ${lit(id)}`}
        AND year_month BETWEEN ${lit(ymStart)} AND ${lit(ymEnd)}`).join('\n      UNION ALL') + ')';
}

async function renderCompare() {
  const boro = district.borough;
  const ymStart = state.start.slice(0, 7);
  const ymEnd = state.end.slice(0, 7);
  // A borough page compares the borough with the city only (no "borough vs itself", #144).
  const series = IS_BORO
    ? [{ key: 'd', kind: 'borough', id: boro, name: `${boro} (this borough)`, color: BLUE, symbol: 'circle' }]
    : [{ key: 'd', kind: geo, id: geoId, name: 'This district', color: BLUE, symbol: 'circle' },
      { key: 'b', kind: 'borough', id: boro || '', name: boro || 'Borough', color: DARK, symbol: 'square' }];
  series.push({ key: 'c', kind: 'city', id: null, name: 'New York City', color: GRAY, symbol: 'triangle' });
  $('cmp-note').textContent = `Share of each problem among all located requests, ${monthLabel(ymStart)} to ${monthLabel(ymEnd)} (whole months). ` +
    (IS_BORO ? 'Compared with the whole city.'
      : `Compared with ${boro || 'the borough'}${geo === 'cc' ? ' (the borough where most of this district\'s requests are)' : ''} and the whole city.`) +
    ' Problem, agency, status and address filters do not apply here.';
  const first = series[0].kind;
  const rows = await query(`
    WITH a AS (
      SELECT geo_kind, complaint_type AS t, sum(n) AS n
      FROM ${aggRows(ymStart, ymEnd, series.map((x) => [x.kind, x.id]))}
      GROUP BY ALL
    ), s AS (SELECT geo_kind, t, n / sum(n) OVER (PARTITION BY geo_kind) AS share FROM a),
    top_types AS (SELECT t FROM s WHERE geo_kind = ${lit(first)} ORDER BY share DESC LIMIT 10)
    SELECT top_types.t,
      ${series.map((x) => `max(share) FILTER (WHERE geo_kind = ${lit(x.kind)}) AS ${x.key}`).join(',\n      ')}
    FROM top_types LEFT JOIN s USING (t) GROUP BY top_types.t ORDER BY d DESC`);
  const long = rows.flatMap((r) => series.map((x) => ({ t: r.t, where: x.name, share: r[x.key] ?? 0 })));
  const names = series.map((x) => x.name);
  const chart = Plot.plot({
    ariaLabel: IS_BORO ? 'Share of top request types: borough, city' : 'Share of top request types: district, borough, city',
    ariaDescription: IS_BORO
      ? 'Dot chart comparing each top request type\'s share of requests in this borough and the city.'
      : 'Dot chart comparing each top request type\'s share of requests in this district, its borough, and the city.',
    width: chartWidth('compare', 420),
    marginLeft: 180,
    height: 50 + 30 * rows.length,
    x: { label: 'Share of requests', tickFormat: '.0%', grid: true },
    y: { label: null, domain: rows.map((r) => r.t) },
    color: { domain: names, range: series.map((x) => x.color), legend: true },
    symbol: { domain: names, range: series.map((x) => x.symbol) },
    marks: [Plot.dot(long, { x: 'share', y: 't', fill: 'where', symbol: 'where', r: 5, tip: true })],
  });
  chartWithTable($('compare'), chart, rows, [
    { key: 't', label: 'Problem' },
    ...series.map((x) => ({ key: x.key, label: x.name, num: true, fmt: fmtPct })),
  ], 'Share of requests by problem');
}

async function renderDetail() {
  const rows = await query(`
    SELECT strftime(created_date, '%Y-%m-%d %H:%M') AS created, complaint_type AS t, descriptor AS d, status AS s, agency AS a,
           coalesce(incident_address, intersection_street_1 || ' & ' || intersection_street_2) AS addr,
           strftime(closed_date, '%Y-%m-%d') AS closed, ${CLOSED_DAYS} AS dtc,
           CASE WHEN ${NOT_CLOSED_SQL} THEN greatest(0, epoch(${asOfSql}) - epoch(created_date)) / 86400.0 END AS dopen,
           unique_key AS k
    FROM req WHERE ${where()} ORDER BY created_date DESC, unique_key LIMIT ${PAGE} OFFSET ${page * PAGE}`);
  $('detail').replaceChildren(table(rows, [
    { key: 'created', label: 'Created' }, { key: 't', label: 'Problem' }, { key: 'd', label: 'Description' },
    { key: 's', label: 'Status' }, { key: 'a', label: 'Agency' }, { key: 'addr', label: 'Address' },
    { key: 'closed', label: 'Closed' }, { key: 'dtc', label: 'Days to close', num: true, fmt: (v) => (v == null ? '' : v.toFixed(1)) },
    { key: 'dopen', label: 'Days open (not closed)', num: true, fmt: (v) => (v == null ? '' : v.toFixed(1)) },
    { key: 'k', label: '311 number' },
  ], `Newest first. Days open are counted to when this data was built, ${fmtDateTime(manifest.generated_at)}.`));
  const from = total ? page * PAGE + 1 : 0;
  $('page-label').textContent = `Showing ${fmtInt(from)}–${fmtInt(Math.min(total, (page + 1) * PAGE))} of ${fmtInt(total)}`;
  $('prev').disabled = page === 0;
  $('next').disabled = (page + 1) * PAGE >= total;
}

const CSV_COLUMNS = ['unique_key', 'created_date', 'closed_date', 'agency', 'agency_name', 'complaint_type', 'complaint_type_raw', 'descriptor', 'descriptor_2', 'status',
  'incident_address', 'street_name', 'intersection_street_1', 'intersection_street_2', 'incident_zip', 'bbl', 'borough', 'community_board', 'council_district',
  'latitude', 'longitude', 'resolution_description', 'cd', 'cc', 'days_to_close', 'close_flag'];

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function downloadCsv() {
  window.boardstatTrack?.('csv_download', { geo, district_id: geoId, page_type: ADDRESS_MODE ? 'address' : 'district' });
  setStatus($('status'), 'Preparing CSV…');
  const sel = CSV_COLUMNS.map((c) => (c.endsWith('_date') ? `strftime(${c}, '%Y-%m-%dT%H:%M:%S') AS ${c}` : c)).join(', ');
  // Straight from the file, so every column is there without keeping it in memory.
  const rows = await query(`SELECT ${sel} FROM ${SRC} WHERE ${where()} ORDER BY created_date, unique_key`);
  const lines = [CSV_COLUMNS.join(',')].concat(rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(',')));
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `boardstat-${geo}-${geoId}-${state.start}-to-${state.end}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  setStatus($('status'), `Downloaded ${fmtInt(rows.length)} requests as CSV.`);
}

// ------------------------------------------------------------- map

async function setupMap() {
  mapCtx = await setupRequestMap('map', { geo, geoId });
  renderMapLegend($('map-legend'), { borough: IS_BORO });
}

async function renderMap() {
  if (!mapCtx) return;
  const shown = await loadRequestPoints(mapCtx, 'req', where());
  if (ADDRESS_MODE && shown.first) mapCtx.map.jumpTo({ center: shown.first, zoom: 17 });
  $('map-note').textContent = mapNoteText(total, shown.count);
}

// ------------------------------------------------------------- about

function renderAbout() {
  const unloc = !ADDRESS_MODE ? district.unlocated : null;
  const text = IS_BORO
    ? boroughCountsText(district, unloc)
    : 'Every request with a location was placed in this district by BoardStat, using where it happened and today\'s boundary lines.' +
      (unloc ? ` Not counted: ${fmtInt(unloc)} requests since ${longDate(manifest.window.start)} (all dates, not only the ones chosen above) that have no usable location but that the city's own records assign to this community district.` : '');
  $('about').replaceChildren(
    el('p', {}, ADDRESS_MODE ? 'This page shows only requests whose address matches exactly, as the city spelled it. ' : '', text),
    el('ul', { class: 'more-links' },
      el('li', {}, el('a', { class: 'button', href: 'about.html', text: 'About BoardStat: sources and history' })),
      el('li', {}, el('a', { class: 'button secondary', href: 'glossary.html', text: 'Glossary: terms and how numbers are counted' }))),
  );
}

/**
 * Links between a district and its borough (#144). A community district page links to its
 * borough; a borough page lists its districts. Council districts cross borough lines, so a
 * council district page gets no borough link.
 */
function renderBoroughLink() {
  const box = $('place-links');
  if (!box || ADDRESS_MODE) return;
  if (IS_BORO) {
    const link = (d) => el('a', { href: `district.html?geo=cd&id=${encodeURIComponent(d.id)}` }, d.jia ? `Joint Interest Area ${d.id}` : d.label.replace(`${district.borough} `, ''));
    const out = ['Districts in this borough: '];
    district.parts.forEach((d, i) => { if (i) out.push(', '); out.push(link(d)); });
    box.replaceChildren(...out, '.');
    box.hidden = false;
  } else if (geo === 'cd') {
    const b = boroughOfCd(geoId);
    if (!b) return;
    box.replaceChildren(el('a', { id: 'boro-link', href: boroughUrl(b.slug) }, `See all of ${b.name}`), el('span', { class: 'muted', text: ' (every community district in the borough, plus its parks and other areas, with the same charts, map and list)' }));
    box.hidden = false;
  }
}

/** A date as "January 1, 2020". */
const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

/** What a borough page counts (#144), in words: the same sentence the glossary explains. */
function boroughCountsText(place, unloc) {
  const cds = place.parts.filter((d) => !d.jia);
  const jias = place.parts.filter((d) => d.jia);
  return `This page counts every request with a location that BoardStat placed inside ${place.borough}: ` +
    `its ${cds.length} community districts` +
    (jias.length ? ` and ${jias.length === 1 ? 'its Joint Interest Area' : `its ${jias.length} Joint Interest Areas`} (parks and other areas outside every community district: ${jias.map((d) => d.id).join(', ')})` : '') +
    '. These are the same requests the district pages count, added together, and the same requests the Compare panel uses for the borough.' +
    (unloc ? ` Not counted: ${fmtInt(unloc)} requests since ${longDate(manifest.window.start)} (all dates, not only the ones chosen above) that have no usable location but that the city's own records assign to one of ${place.borough}'s community districts, and requests with no location and no district at all.` : ' Requests with no usable location are not counted.');
}

/** Address page: the ZIP code and the two districts the address is in, with links. */
async function renderAddressLinks() {
  const [a] = await query(`
    SELECT mode(incident_zip) AS zip, mode(cd) AS cd, mode(cc) AS cc, mode(borough) AS boro,
           median(longitude) AS lng, median(latitude) AS lat FROM req WHERE address_norm = ${lit(state.addr)}`);
  addrInfo = a || null;
  const link = (g, id) => {
    const d = manifest.districts[g]?.find((x) => String(x.id) === String(id));
    return el('a', { href: `district.html?geo=${g}&id=${encodeURIComponent(id)}` }, d ? d.label : `${g.toUpperCase()} ${id}`);
  };
  const parts = [];
  if (a?.zip) parts.push(`ZIP ${a.zip}`);
  if (a?.cd != null) parts.push(link('cd', a.cd));
  if (a?.cc != null) parts.push(link('cc', a.cc));
  const out = [];
  parts.forEach((p, i) => { if (i) out.push(' · '); out.push(p); });
  const boro = a?.boro && a.boro !== 'Unspecified' ? a.boro.charAt(0) + a.boro.slice(1).toLowerCase().replace(/ (\w)/g, (m, c) => ` ${c.toUpperCase()}`) : null;
  // Cross-reference: BetaNYC's Boundaries Map (github.com/BetaNYC/nyc-boundaries) lists the
  // political and administrative districts at a point. On load it reads lng/lat (not addr),
  // so the link carries the middle of this address's 311 locations; addr is kept as a label.
  const bq = new URLSearchParams({ addr: [state.addr, boro, a?.zip].filter(Boolean).join(', ') });
  if (a?.lng != null && a?.lat != null) { bq.set('lng', a.lng.toFixed(6)); bq.set('lat', a.lat.toFixed(6)); }
  // A button that opens the map, not a link: the Google tag's automatic "outbound click"
  // event would otherwise send the link, with this address in it, to Google (analytics.js).
  // noreferrer keeps this page's URL (also with the address) out of the request.
  const bUrl = `https://boundaries.beta.nyc/?${bq}`;
  const bLink = el('button', { type: 'button', class: 'link', onclick: () => window.open(bUrl, '_blank', 'noopener,noreferrer') },
    'See the boundaries around this address on the BetaNYC Boundaries Map');
  $('addr-links').replaceChildren(...(out.length ? ['In ', ...out, '. Select a district to see all of it.'] : []));
  $('addr-links').after(el('p', { class: 'no-print' }, bLink, el('span', { class: 'muted', text: ' (political and administrative districts, opens in a new tab)' })));
  $('boundary-note').textContent = 'Every request whose address matches this one exactly, as the city spelled it. Requests that gave only a cross street are not included.';
}

// ------------------------------------------------------------- refresh / boot

// Traffic events (analytics.js): filter names and short codes only, never values typed or an address.
let lastTracked = null;
let trackTimer = null;
function trackFilters() {
  const key = { dates: `${state.start}|${state.end}`, type: state.types.join('|'), desc: `${state.descs.join('|')}|${state.descEx}`, agency: state.agency, status: state.status, address: state.addr };
  const prev = lastTracked;
  lastTracked = key;
  if (!prev) return; // the first render is the page view itself
  const changed = Object.keys(key).filter((k) => key[k] !== prev[k]);
  clearTimeout(trackTimer);
  trackTimer = setTimeout(() => {
    for (const filter of changed) {
      if (filter === 'dates') {
        const months = Math.round((new Date(state.end) - new Date(state.start)) / (30.44 * 864e5));
        window.boardstatTrack?.('date_range_changed', { geo, district_id: geoId, months, start_year: state.start.slice(0, 4) });
      } else {
        window.boardstatTrack?.('filter_changed', { geo, district_id: geoId, filter });
      }
    }
  }, 1500);
}

// Redraw the charts (only the charts) when the page gets wider or narrower, e.g. a
// window resize or a phone turned sideways. lastChartWidth is set after each refresh.
let lastChartWidth = null;
const chartWidthKey = () => document.querySelector('main')?.clientWidth || 0;
function watchChartWidth() {
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (lastChartWidth === null || chartWidthKey() === lastChartWidth) return;
      if (loader?.loadPending()) return; // the refresh after that load draws at the new width
      lastChartWidth = chartWidthKey();
      try {
        await Promise.all([renderMonthly(), renderAgency(), ...(ADDRESS_MODE ? [renderTimeline(), renderAddressCompare()] : [renderCompare()])]);
      } catch (err) { console.error(err); }
    }, 250);
  });
}

let refreshSeq = 0;
let lastRefreshFailed = false; // Apply always reruns after a failed refresh
async function refresh() {
  const seq = ++refreshSeq;
  trackFilters();
  writeUrl();
  form.render();
  describeFiltersForPrint();
  page = 0;
  priorFailure = null; // this refresh retries a failed background load (loadPriorYear)
  setStatus($('status'), 'Updating…');
  try {
    try { await ensureLoaded(); } catch (err) { err.boardstatLoad = true; throw err; }
    if (seq !== refreshSeq) return;
    if (firstLoadDone) await fillFilterOptions(); // a no-op unless the rows or the dates changed
    // A page whose first load failed finishes its setup after the first load that works.
    if (!firstLoadDone) await afterFirstLoad();
    setStatus($('status'), 'Updating…');
    await renderKpis();
    if (seq !== refreshSeq) return;
    await Promise.all([renderTop(), renderDescriptors(), renderMonthly(), renderAgencyResponse(), renderAgency(), renderBacklog(), renderDetail(), renderMap(),
      ...(ADDRESS_MODE ? [renderTimeline(), renderAddressCompare()] : [renderAddresses(), renderCompare()])]);
    // A link can carry dates in the wrong order: say so instead of just "0 requests match."
    if (seq === refreshSeq) setStatus($('status'), state.start > state.end ? DATE_ORDER_MSG : `${fmtInt(total)} requests match.`);
    lastRefreshFailed = false;
    lastChartWidth = chartWidthKey();
    // After the form's own Apply or Reset on a phone: close the panel, focus its toggle.
    if (seq === refreshSeq) form.afterRedraw();
    // Only once the page has drawn, so it never waits for the year before.
    if (seq === refreshSeq) loadPriorYear();
  } catch (err) {
    console.error(err);
    lastRefreshFailed = true;
    if (!(err instanceof DataChangedError)) freshDataFiles(err).catch((e) => console.error(e));
    // The error itself stays in the console; the page says what to do.
    setStatus($('status'), err.boardstatLoad || err instanceof DataChangedError ? loadFailedText(err)
      : 'Something went wrong while updating the page. Press Apply filters to try again, or reload the page.');
  }
}

/** An instant as NYC local "floating" time, matching how 311 timestamps are stored (README decision 14). */
function nycLocal(iso) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** A page with nothing to show (no data, no such place, no address): no filter panel, no dead toggle. */
function hideFilters() {
  $('filters-bar').hidden = true;
  $('filters').hidden = true;
}

async function main() {
  try {
    manifest = await loadManifest();
  } catch (err) {
    $('title').textContent = 'Data not available';
    $('as-of').textContent = String(err.message || err);
    hideFilters();
    return;
  }
  district = resolvePlace(manifest, geo, geoId);
  if (!district || (ADDRESS_MODE && IS_BORO)) {
    $('title').textContent = IS_BORO ? 'Borough not found' : 'District not found';
    $('as-of').replaceChildren(`No data for this ${IS_BORO ? 'borough' : 'district'}. `, el('a', { href: './', text: 'Choose another place.' }));
    hideFilters();
    return;
  }
  if (ADDRESS_MODE && !params.get('addr')) {
    $('title').textContent = 'No address chosen';
    $('as-of').replaceChildren(el('a', { href: './#addr', text: 'Search for an address.' }));
    hideFilters();
    return;
  }
  const label = ADDRESS_MODE ? params.get('addr') : district.label;
  document.title = `${label} · BoardStat 2.0 (prototype)`;
  $('title').textContent = label;
  renderDataStatus(manifest, $('as-of'), $('stale'));
  renderChanges($('changes'), {
    geo: IS_BORO ? 'cd' : geo, ids: district.parts.map((d) => d.id),
    label: ADDRESS_MODE ? `in ${district.label}` : IS_BORO ? 'in this borough' : 'in this district',
  });
  asOfSql = `CAST(${lit(nycLocal(manifest.generated_at))} AS TIMESTAMP)`;
  const b = geo === 'cc' ? manifest.sources.council_districts : manifest.sources.community_districts;
  $('boundary-note').textContent = IS_BORO
    ? `The whole borough: all ${district.parts.length} of its Community District and Joint Interest Area shapes, Department of City Planning release ${b.version || 'unknown'}.`
    : `Boundary: ${geo === 'cd' ? 'Community District' : 'City Council District'} lines, Department of City Planning release ${b.version || 'unknown'}.` +
      (district.jia ? ' This is a Joint Interest Area (a park or other area outside every community district), not a community district.' : '');
  renderBoroughLink();
  if (geo === 'cc') { $('cc-banner').hidden = false; document.querySelectorAll('.bver').forEach((n) => { n.textContent = b.version || ''; }); }
  renderAbout();

  setStatus($('status'), IS_BORO
    ? `Loading the query engine and the borough's data (all ${district.parts.length} districts; this takes longer than one district)…`
    : 'Loading the query engine and this district\'s data…');
  const names = sourceNames(district);
  SRC = sourceSql(names);
  dataFiles = names.map((n, i) => [n, `data/${district.files[i]}`]);
  if (rangeLoading()) loader = createLoader({ exec: query, sources: names.map((n) => sourceSql([n])), cols: LOAD_COLUMNS.join(', '), checkFresh: freshnessCheck(manifest.generated_at) });
  try {
    [Plot] = await Promise.all([
      import(PLOT_URL),
      ...names.map((n, i) => registerData(n, `data/${district.files[i]}`)),
      registerData('agg.parquet', 'data/agg/month_type.parquet'),
    ]);
    // The page's table lives in an in-memory database stored compressed ("COMPRESS: whether
    // the database is compressed. Only applicable for in-memory databases",
    // https://duckdb.org/docs/1.4/sql/statements/attach). Brooklyn's default view takes
    // about 140 MB instead of 770 MB, and a whole borough from 2020 fits at all.
    await query(`ATTACH ':memory:' AS boardstat (COMPRESS true)`);
    await query('USE boardstat');
  } catch (err) {
    console.error(err);
    setStatus($('status'), 'BoardStat could not start: the query engine or the charts did not load. This can happen if the connection drops. Reload the page to try again.');
    return;
  }
  viewStart = manifest.window.default_start || manifest.window.start;
  window.boardstatTrack?.(ADDRESS_MODE ? 'address_viewed' : 'district_selected', { geo, district_id: geoId, page_type: ADDRESS_MODE ? 'address' : 'district' });
  state = readState();
  form = createFilterForm({
    defaults: defaultFilters,
    lists: formLists,
    onApply: (s) => { state = s; refresh(); },
    lastFailed: () => lastRefreshFailed,
    matchText: () => `${fmtInt(total)} requests match.`,
    setStatus: (msg) => setStatus($('status'), msg),
    lockAddress: ADDRESS_MODE,
  });
  form.set(state);
  // Open on a wide screen, closed on a phone (filterform.js setupPanel, #149). Before the
  // first load, so the panel is in its place and the toggle works while the rows load.
  form.setupPanel({ scrollTo: $('filters-bar') });
  if (!ADDRESS_MODE) updateFullMapLink(filtersToParams(geo, geoId, state, defaultDates()));
  // A failed first load must never leave the page waiting: say so, and let Apply retry.
  let loaded = true;
  let loadError = null;
  try {
    await ensureLoaded();
  } catch (err) {
    console.error(err);
    loaded = false;
    loadError = err;
    lastRefreshFailed = true;
    await freshDataFiles(err);
  }
  if (loaded) await afterFirstLoad();
  setupFilters();
  try { await setupMap(); } catch (err) {
    console.error(err);
    $('map').replaceChildren(el('p', { text: `The map could not load (${err.message}). Every number on this page is also in the tables.` }));
  }
  watchChartWidth();
  if (loaded) await refresh();
  else setStatus($('status'), loadFailedText(loadError));
}


main();
