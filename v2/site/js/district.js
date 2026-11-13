// District page: every query runs in DuckDB-WASM over ONE district's Parquet file.
import {
  PLOT_URL, loadManifest, renderDataStatus, renderChanges, dataUrl, registerData, query, lit, el, table, chartWithTable,
  setStatus, fmtInt, fmtDays, fmtPct, fmtDate, fmtDateTime, monthLabel,
} from './lib.js';
import { makeMap, addBoundaries, featureBounds } from './map.js';
import { copyFilters, changedFields, patchBoth, sectionCount, SECTIONS } from './filterstate.js';

const $ = (id) => document.getElementById(id);
const PAGE = 50;
const MAP_CAP = 60000;
const BLUE = '#2359a8';
const GRAY = '#949494';
const DARK = '#414141';
const STATUS_COLORS = [BLUE, '#B8D6FF', DARK, GRAY, '#EEF4FF', '#F1F1F1'];
// Problems over time (address page): six colors that stay visible as bar fills; the last is "Other".
const PROBLEM_COLORS = [BLUE, '#7fa8e0', DARK, '#c27c0e', '#3f8f5b', '#c8c8c8'];
// Status shortcut: every status other than Closed (including a missing status).
const NOT_CLOSED = 'not_closed';
const NOT_CLOSED_SQL = `status IS DISTINCT FROM 'Closed'`;
// A missing descriptor is shown and filtered as "(none)", as in the descriptor table.
const DESC_SQL = `coalesce(descriptor, '(none)')`;
// Time to close counts only requests marked Closed. days_to_close is already NULL
// when there is no close date or the close date is impossible (see README decision 5);
// this also drops the few not-Closed requests that carry a close date.
const CLOSED_DAYS = `CASE WHEN status = 'Closed' THEN days_to_close END`;

const params = new URLSearchParams(window.location.search);
const geo = params.get('geo') === 'cc' ? 'cc' : 'cd';
const geoId = params.get('id');
// address.html reuses this page for one address: the address filter is fixed,
// and the district-wide panels (top addresses, compare) are left out.
const ADDRESS_MODE = document.body.dataset.mode === 'address';

let manifest, district, Plot;
// `state` is the applied filters: what every panel shows and the link carries.
// `draft` is what the filter form shows; only the Apply button copies it to `state` (#142).
let state = {};
let draft = {};
let page = 0;
let total = 0;
let mapCtx = null;
let selectedType = null;
let addrInfo = null; // address page: { zip, cd, cc, boro, lng, lat } of the address
let asOfSql = null; // build time as an NYC-local TIMESTAMP literal; "days open" is measured to it
let viewStart = null; // the From date a link without dates opens with (manifest.window.default_start)
let loadedFrom = null; // closed requests created before this date are not in the req table

// ------------------------------------------------------------- loading only what the view needs
//
// Detail files hold the Closed requests first, in created_date order, then every
// request not yet Closed at the very end, in 50,000-row groups (boardstat_build.py).
// The page loads all open requests plus Closed ones from LOAD_BACK_MONTHS before the
// From date: the "same month a year earlier" series needs that year, and "Still open
// from before this period" needs every older open request. So the rows a page needs
// are one run of row groups at the end of the file. DuckDB-WASM reads only the row
// groups whose min/max statistics match, over HTTP range requests (lib.js turns off
// forceFullHTTPReads; https://duckdb.org/docs/stable/data/parquet/overview#partial-reading).
// Its read-ahead grows each read up to 16 MB, so a contiguous run that ends at the
// end of the file costs little more than the run itself. The Closed branch of the
// load runs first: run the other way round, DuckDB-WASM fetched about 20% more bytes
// (CC 11, 2020+ data, measured 2026-11-06), because the second scan's read-ahead
// re-fetched ranges the first had already read.
// Moving the From date earlier than that reloads the table.
const LOAD_BACK_MONTHS = 12;
// The columns the page's panels use. The CSV download reads every column straight
// from the file instead, so the long text fields never sit in memory.
const LOAD_COLUMNS = ['unique_key', 'created_date', 'closed_date', 'agency', 'agency_name', 'complaint_type', 'descriptor', 'status',
  'incident_address', 'intersection_street_1', 'intersection_street_2', 'incident_zip', 'borough', 'latitude', 'longitude',
  'cd', 'cc', 'days_to_close', 'address_norm', 'year_month'];
// Files built before range loading have no is_closed column or default_start; load those whole.
const rangeLoading = () => Boolean(manifest.window.default_start);

function monthsBefore(iso, n) {
  const d = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

/** The earliest created date the current filters need for Closed requests, or null for none. */
function neededFrom() {
  // Every request whose status is not Closed is always loaded, so a status filter
  // other than Closed (including "not yet closed") never needs older Closed rows.
  if (state.status && state.status !== 'Closed') return null;
  const from = monthsBefore(state.start, LOAD_BACK_MONTHS);
  return from > manifest.window.start ? from : manifest.window.start;
}

/** (Re)build the req table if the view needs Closed requests older than what is loaded. */
async function ensureLoaded() {
  if (!rangeLoading()) {
    if (loadedFrom === null) { await query(`CREATE TABLE req AS SELECT * FROM 'd.parquet'`); loadedFrom = manifest.window.start; }
    return;
  }
  const need = neededFrom();
  if (loadedFrom !== null && (need === null || need >= loadedFrom)) return;
  const from = need === null ? monthsBefore(viewStart, LOAD_BACK_MONTHS) : need;
  const cols = LOAD_COLUMNS.join(', ');
  setStatus($('status'), `Loading requests from ${fmtDate(from > manifest.window.start ? from : manifest.window.start)} on…`);
  await query(`
    CREATE OR REPLACE TABLE req AS
    SELECT ${cols} FROM 'd.parquet' WHERE is_closed = true AND created_date >= CAST(${lit(from)} AS TIMESTAMP)
    UNION ALL
    SELECT ${cols} FROM 'd.parquet' WHERE is_closed = false`);
  loadedFrom = from;
}

// ------------------------------------------------------------- state <-> URL

function readState() {
  return {
    start: params.get('start') || viewStart,
    end: params.get('end') || manifest.window.end,
    types: (params.get('type') || '').split('|').filter(Boolean),
    descs: (params.get('desc') || '').split('|').filter(Boolean),
    descEx: params.get('descx') === '1',
    agency: params.get('agency') || '',
    status: params.get('status') || '',
    addr: params.get('addr') || '',
  };
}

function writeUrl() {
  const p = new URLSearchParams({ geo, id: geoId });
  if (state.start !== viewStart) p.set('start', state.start);
  if (state.end !== manifest.window.end) p.set('end', state.end);
  if (state.types.length) p.set('type', state.types.join('|'));
  if (state.descs.length) p.set('desc', state.descs.join('|'));
  if (state.descs.length && state.descEx) p.set('descx', '1');
  if (state.agency) p.set('agency', state.agency);
  if (state.status) p.set('status', state.status);
  // Street addresses never go back into the URL bar after the page loads, so no
  // later history entry (or analytics page view; see analytics.js) can carry one.
  // The address page keeps the address it was opened with and does not rewrite its
  // URL at all; the district page's address filter is not kept in the link.
  if (ADDRESS_MODE) return;
  history.replaceState(null, '', `?${p.toString()}`);
}

function where({ skipType = false, skipDates = false, skipDesc = false, skipStatus = false, skipAgency = false } = {}) {
  const w = skipDates ? ['TRUE'] : [
    `created_date >= CAST(${lit(state.start)} AS DATE)`,
    `created_date < CAST(${lit(state.end)} AS DATE) + INTERVAL 1 DAY`,
  ];
  if (!skipType && state.types.length) w.push(`complaint_type IN (${state.types.map(lit).join(', ')})`);
  if (!skipAgency && state.agency) w.push(`agency = ${lit(state.agency)}`);
  if (!skipDesc && state.descs.length) w.push(`${DESC_SQL} ${state.descEx ? 'NOT IN' : 'IN'} (${state.descs.map(lit).join(', ')})`);
  if (!skipStatus && state.status) w.push(state.status === NOT_CLOSED ? NOT_CLOSED_SQL : `status = ${lit(state.status)}`);
  if (state.addr) w.push(`address_norm = ${lit(state.addr)}`);
  return w.join(' AND ');
}

// ------------------------------------------------------------- filter controls

let allTypes = [];
function renderChips() {
  $('type-chips').replaceChildren(...draft.types.map((t) => el('li', {},
    el('button', { type: 'button', 'aria-label': `Remove problem filter ${t}`, onclick: () => { draft.types = draft.types.filter((x) => x !== t); formChanged(); } }, `${t} ×`))));
  $('desc-chips').classList.toggle('exclude', draft.descEx);
  $('desc-chips').setAttribute('aria-label', draft.descEx ? 'Excluded descriptions' : 'Selected descriptions');
  $('desc-chips').replaceChildren(...draft.descs.map((d) => el('li', {},
    el('button', { type: 'button', 'aria-label': `Remove description filter ${d}`, onclick: () => { draft.descs = draft.descs.filter((x) => x !== d); formChanged(); } },
      `${draft.descEx ? 'Not: ' : ''}${d} ×`))));
  $('addr-filter').hidden = ADDRESS_MODE || !draft.addr;
  $('addr-value').textContent = draft.addr;
}

/** Put the form controls back in line with `draft` (after a reset or a shortcut button). */
function syncForm() {
  $('f-start').value = draft.start;
  $('f-end').value = draft.end;
  $('f-agency').value = draft.agency;
  $('f-status').value = draft.status;
  $('f-desc-ex').checked = draft.descEx;
}

/** The filters a link with no filters opens with (the Reset button's target). */
function defaultFilters() {
  return { start: viewStart, end: manifest.window.end, types: [], descs: [], descEx: false, agency: '', status: '', addr: ADDRESS_MODE ? state.addr : '' };
}

/** Show whether the form holds changes the page does not show yet, and what each group has set. */
function renderPending() {
  const changed = changedFields(draft, state);
  const pending = changed.length > 0;
  $('apply').classList.toggle('is-pending', pending);
  const msg = pending ? 'Filters changed. Press Apply filters to update the page.' : '';
  if ($('pending').textContent !== msg) $('pending').textContent = msg;
  const defaults = defaultFilters();
  for (const section of Object.keys(SECTIONS)) {
    const node = document.querySelector(`[data-count-for="${section}"]`);
    if (!node) continue;
    const n = sectionCount(draft, defaults, section);
    const edited = changed.some((k) => SECTIONS[section].includes(k) || (section === 'problem' && k === 'descEx'));
    const parts = [];
    if (section === 'dates') parts.push(`${fmtDate(draft.start)} to ${fmtDate(draft.end)}`);
    else if (n) parts.push(`${n} set`);
    if (edited) parts.push('not applied');
    node.textContent = parts.length ? `(${parts.join(', ')})` : '';
  }
}

/** A form control changed the draft: redraw the form, never the panels. */
function formChanged() {
  renderChips();
  renderPending();
  updateDescOptions().catch((err) => console.error(err));
}

/** Copy the form's filters to the page and run the queries. */
function applyFilters() {
  // Text typed but not yet added as a chip is added first, if it matches a choice.
  if ($('f-type').value.trim()) addType($('f-type').value);
  if ($('f-desc').value.trim()) addDesc($('f-desc').value);
  if (draft.start > draft.end) {
    setStatus($('status'), 'The From date is after the To date. Change one of them, then press Apply filters.');
    $('f-start').focus();
    return;
  }
  state = copyFilters(draft);
  refresh();
}

/**
 * Shortcut buttons in the panels (an agency, a description, an address, "Show them")
 * apply at once. The same change goes into the form, and any other edits still waiting
 * in the form stay there, unapplied.
 */
function applyNow(fn) {
  ({ applied: state, draft } = patchBoth(state, draft, fn));
  refresh();
}

let allDescs = [];
let descOptionsKey = null;
/** The Description list offers only descriptors of the selected problems (all if none). */
async function updateDescOptions() {
  const key = draft.types.join('|');
  if (key === descOptionsKey) return;
  descOptionsKey = key;
  const rows = await query(`
    SELECT ${DESC_SQL} AS d, count(*) AS n FROM req
    ${draft.types.length ? `WHERE complaint_type IN (${draft.types.map(lit).join(', ')})` : ''}
    GROUP BY 1 ORDER BY 2 DESC, 1`);
  allDescs = rows.map((r) => r.d);
  $('desc-options').replaceChildren(...allDescs.map((d) => el('option', { value: d })));
}

function addDesc(d) {
  const match = allDescs.find((x) => x.toLowerCase() === String(d).trim().toLowerCase());
  if (match && !draft.descs.includes(match)) { draft.descs = [...draft.descs, match]; formChanged(); }
  $('f-desc').value = '';
}

function addType(t) {
  const match = allTypes.find((x) => x.toLowerCase() === t.trim().toLowerCase());
  if (match && !draft.types.includes(match)) { draft.types = [...draft.types, match]; formChanged(); }
  $('f-type').value = '';
}

/** Fill the problem, agency and status lists from what is loaded (again after a reload). */
let optionsFrom;
async function fillFilterOptions() {
  if (optionsFrom === loadedFrom) return;
  optionsFrom = loadedFrom;
  allTypes = (await query(`SELECT complaint_type AS t, count(*) AS n FROM req GROUP BY 1 ORDER BY 2 DESC`)).map((r) => r.t);
  $('type-options').replaceChildren(...allTypes.map((t) => el('option', { value: t })));
  // Keep the fixed first options ("All agencies", "Any status", "Not yet closed"); replace the rest.
  $('f-agency').replaceChildren($('f-agency').options[0], ...(await query(`SELECT agency, any_value(agency_name) AS agency_label, count(*) AS n FROM req GROUP BY 1 ORDER BY 3 DESC, 1`))
    .map((r) => el('option', { value: r.agency, text: `${r.agency}${r.agency_label ? ` (${r.agency_label})` : ''}` })));
  const fixedStatus = [...$('f-status').options].filter((o) => o.value === '' || o.value === NOT_CLOSED);
  $('f-status').replaceChildren(...fixedStatus, ...(await query(`SELECT status, count(*) AS n FROM req WHERE status IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`))
    .map((r) => el('option', { value: r.status, text: r.status })));
  syncForm();
}

async function setupFilters() {
  const { start, end } = manifest.window;
  for (const id of ['f-start', 'f-end']) { $(id).min = start; $(id).max = end; }
  $('f-start').value = state.start;
  $('f-end').value = state.end;
  await fillFilterOptions();
  if (state.status && ![...$('f-status').options].some((o) => o.value === state.status)) state.status = '';
  draft = copyFilters(state);
  syncForm();
  setupGroups();

  // Changing a control changes only the form (#142). Apply filters, or Enter in a text
  // or date box, runs the queries.
  $('f-start').addEventListener('change', (e) => { if (e.target.value) { draft.start = e.target.value; formChanged(); } });
  $('f-end').addEventListener('change', (e) => { if (e.target.value) { draft.end = e.target.value; formChanged(); } });
  $('f-agency').addEventListener('change', (e) => { draft.agency = e.target.value; formChanged(); });
  $('f-status').addEventListener('change', (e) => { draft.status = e.target.value; formChanged(); });
  // Enter with text in the box adds it as a chip; Enter in an empty box applies the filters.
  $('f-type').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value.trim()) { e.preventDefault(); addType(e.target.value); } });
  $('f-type').addEventListener('change', (e) => { if (allTypes.includes(e.target.value)) addType(e.target.value); });
  $('f-desc').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value.trim()) { e.preventDefault(); addDesc(e.target.value); } });
  $('f-desc').addEventListener('change', (e) => { if (allDescs.includes(e.target.value)) addDesc(e.target.value); });
  $('f-desc-ex').addEventListener('change', (e) => { draft.descEx = e.target.checked; formChanged(); });
  $('addr-clear').addEventListener('click', () => { draft.addr = ''; formChanged(); });
  $('filters').addEventListener('submit', (e) => { e.preventDefault(); applyFilters(); });
  // Reset is a deliberate "start over", so it applies at once.
  $('reset').addEventListener('click', () => {
    state = defaultFilters();
    draft = copyFilters(state);
    refresh();
  });
  $('print').addEventListener('click', () => { window.boardstatTrack?.('print_page', { geo, district_id: geoId }); window.print(); });
  window.addEventListener('beforeprint', describeFiltersForPrint);
  $('prev').addEventListener('click', () => { if (page > 0) { page--; renderDetail(); } });
  $('next').addEventListener('click', () => { if ((page + 1) * PAGE < total) { page++; renderDetail(); } });
  $('download').addEventListener('click', downloadCsv);
}

/**
 * Filter groups open and close with native <details>/<summary>, which keyboards and
 * screen readers already handle. On a phone only groups with something set start open.
 * On a wider screen Dates and Problem start open, and Agency and status opens if set.
 */
function setupGroups() {
  const phone = window.matchMedia('(max-width: 640px)').matches;
  const defaults = defaultFilters();
  for (const d of document.querySelectorAll('#filters details.filter-group')) {
    const set = sectionCount(state, defaults, d.dataset.section) > 0;
    d.open = set || (!phone && d.dataset.section !== 'agency');
  }
  renderPending();
}

function describeFiltersForPrint() {
  const parts = [`Requests created ${fmtDate(state.start)} to ${fmtDate(state.end)}`];
  if (state.types.length) parts.push(`problems: ${state.types.join(', ')}`);
  if (state.agency) parts.push(`agency: ${state.agency}`);
  if (state.descs.length) parts.push(`${state.descEx ? 'excluding descriptions' : 'descriptions'}: ${state.descs.join(', ')}`);
  if (state.status) parts.push(`status: ${state.status === NOT_CLOSED ? 'not yet closed' : state.status}`);
  if (state.addr) parts.push(`address: ${state.addr}`);
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
  const list = el('ol', { class: 'barlist', 'aria-label': 'Top 10 problems by number of requests' },
    rows.map((r) => el('li', {}, el('button', {
      type: 'button', 'aria-pressed': String(selectedType === r.t),
      'aria-label': `${r.t}: ${fmtInt(r.n)} requests. Show descriptions.`,
      onclick: () => { selectedType = selectedType === r.t ? null : r.t; renderTop(); renderDescriptors(); },
    }, el('span', { text: r.t }), el('span', { class: 'bar', style: `width:${(100 * r.n) / max}%`, 'aria-hidden': 'true' }), el('span', { class: 'num', text: fmtInt(r.n) })))));
  $('top').replaceChildren(list, el('details', { class: 'as-table' }, el('summary', { text: 'Show as table' }),
    table(rows, [
      { key: 't', label: 'Problem' }, { key: 'n', label: 'Requests', num: true, fmt: fmtInt },
      { key: 'med', label: 'Median time to close', num: true, fmt: fmtDays },
    ], 'Top 10 problems')));
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
            onclick: () => applyNow((s) => ({ descs: s.descs.includes(r.d) ? s.descs : [...s.descs, r.d], descEx: state.descEx })) }, r.d)),
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

async function renderMonthly() {
  // A month is "partial" when the From/To dates or the end of the data cut it short.
  // Partial months are shown as hollow dots off the line, so a short month never
  // looks like a drop. The year-earlier series uses exactly the same days, shifted
  // back 12 months (every filter except From/To applies).
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
  // A year-earlier month is only shown if the data covers all of its matching days.
  const priorCovered = (ym) => {
    const [y, mo] = ym.split('-').map(Number);
    const span = partialSpan(ym, state.start, effEnd) || [`${ym}-01`, null];
    const priorStart = `${y - 1}-${String(mo).padStart(2, '0')}-${span[0].slice(8)}`;
    return priorStart >= manifest.window.start;
  };
  for (const r of rows) {
    r.span = partialSpan(r.ym, state.start, effEnd);
    if (!priorCovered(r.ym)) r.n_prior = null;
  }
  const spanText = (sp) => (sp ? `partial month: ${fmtDate(sp[0])}${sp[0] === sp[1] ? '' : ` to ${fmtDate(sp[1])}`} only` : '');
  const data = [];
  for (const r of rows) {
    const date = new Date(`${r.ym}-01T12:00:00`);
    data.push({ date, ym: r.ym, series: 'This period', n: r.n, partial: !!r.span, span: r.span });
    if (r.n_prior != null) data.push({ date, ym: r.ym, series: 'Same month a year earlier', n: r.n_prior, partial: !!r.span, span: r.span });
  }
  const full = data.filter((d) => !d.partial);
  const part = data.filter((d) => d.partial);
  const hasPrior = data.some((d) => d.series !== 'This period');
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
    y: { label: 'Requests', grid: true, ...countY(Math.max(0, ...data.map((d) => d.n))) },
    color: { domain: ['This period', 'Same month a year earlier'], range: [BLUE, GRAY], legend: hasPrior },
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
    { key: 'n_prior', label: 'Same days a year earlier', num: true, fmt: (v) => (v == null ? 'not in data' : fmtInt(v)) },
  ], 'Requests per month');
  if (byYear) $('monthly').append(el('p', { class: 'muted', text: 'Each line is one calendar year, so you can compare the same month across years. The newest year is the thickest line. The table lists every month.' }));
  if (part.length) {
    const list = rows.filter((r) => r.span).map((r) => `${monthLabel(r.ym)} (${spanText(r.span).replace('partial month: ', '')})`).join(' and ');
    $('monthly').append(el('p', { class: 'muted', text: `Hollow dots are partial months, so they are lower than a full month would be: ${list}. The newest request in the data is from ${lc ? fmtDateTime(lc.replace(' ', 'T')) : fmtDate(lastDataDay())}, because the city publishes 311 data with a delay. Year-earlier values cover the same days, up to the same time, one year earlier.` }));
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
  $('filters-h').scrollIntoView({ block: 'start' });
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
    ariaLabel: 'Share of top problems: this address, its community district, its council district',
    ariaDescription: 'Dot chart comparing each top problem\'s share of requests at this address, in its community district, and in its council district.',
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
  $('cmp-note').textContent = `Share of each problem among all located requests, ${monthLabel(ymStart)} to ${monthLabel(ymEnd)} (whole months). ` +
    `Compared with ${boro || 'the borough'}${geo === 'cc' ? ' (the borough where most of this district\'s requests are)' : ''} and the whole city. Problem, agency, status and address filters do not apply here.`;
  const rows = await query(`
    WITH a AS (
      SELECT geo_kind, complaint_type AS t, sum(n) AS n
      FROM ${aggRows(ymStart, ymEnd, [[geo, geoId], ['borough', boro || ''], ['city', null]])}
      GROUP BY ALL
    ), s AS (SELECT geo_kind, t, n / sum(n) OVER (PARTITION BY geo_kind) AS share FROM a),
    top_types AS (SELECT t FROM s WHERE geo_kind = ${lit(geo)} ORDER BY share DESC LIMIT 10)
    SELECT top_types.t,
      max(share) FILTER (WHERE geo_kind = ${lit(geo)}) AS d,
      max(share) FILTER (WHERE geo_kind = 'borough') AS b,
      max(share) FILTER (WHERE geo_kind = 'city') AS c
    FROM top_types LEFT JOIN s USING (t) GROUP BY top_types.t ORDER BY d DESC`);
  const long = rows.flatMap((r) => [
    { t: r.t, where: 'This district', share: r.d ?? 0 },
    { t: r.t, where: boro || 'Borough', share: r.b ?? 0 },
    { t: r.t, where: 'New York City', share: r.c ?? 0 },
  ]);
  const chart = Plot.plot({
    ariaLabel: 'Share of top problems: district, borough, city',
    ariaDescription: 'Dot chart comparing each top problem\'s share of requests in this district, its borough, and the city.',
    width: chartWidth('compare', 420),
    marginLeft: 180,
    height: 50 + 30 * rows.length,
    x: { label: 'Share of requests', tickFormat: '.0%', grid: true },
    y: { label: null, domain: rows.map((r) => r.t) },
    color: { domain: ['This district', boro || 'Borough', 'New York City'], range: [BLUE, DARK, GRAY], legend: true },
    symbol: { domain: ['This district', boro || 'Borough', 'New York City'], range: ['circle', 'square', 'triangle'] },
    marks: [Plot.dot(long, { x: 'share', y: 't', fill: 'where', symbol: 'where', r: 5, tip: true })],
  });
  chartWithTable($('compare'), chart, rows, [
    { key: 't', label: 'Problem' },
    { key: 'd', label: 'This district', num: true, fmt: fmtPct },
    { key: 'b', label: boro || 'Borough', num: true, fmt: fmtPct },
    { key: 'c', label: 'New York City', num: true, fmt: fmtPct },
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
  const rows = await query(`SELECT ${sel} FROM 'd.parquet' WHERE ${where()} ORDER BY created_date, unique_key`);
  const lines = [CSV_COLUMNS.join(',')].concat(rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(',')));
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `boardstat-${geo}-${geoId}-${state.start}-to-${state.end}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  setStatus($('status'), `Downloaded ${fmtInt(rows.length)} requests as CSV.`);
}

// ------------------------------------------------------------- map

async function setupMap() {
  const gj = await (await fetch(dataUrl(`data/boundaries/${geo}.geojson`))).json();
  const feature = gj.features.find((f) => String(f.properties.id) === String(geoId));
  mapCtx = await makeMap('map', feature ? { bounds: featureBounds(feature) } : {});
  const { map, ml } = mapCtx;
  addBoundaries(map, gj, { selectedId: Number(geoId) });
  // Clustering per https://maplibre.org/maplibre-gl-js/docs/examples/create-and-style-clusters/
  map.addSource('req', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, cluster: true, clusterMaxZoom: 15, clusterRadius: 40 });
  map.addLayer({
    id: 'clusters', type: 'circle', source: 'req', filter: ['has', 'point_count'],
    paint: {
      'circle-color': ['step', ['get', 'point_count'], '#B8D6FF', 100, '#6f9bd6', 1000, BLUE],
      'circle-radius': ['step', ['get', 'point_count'], 10, 100, 16, 1000, 24],
      'circle-stroke-width': 1, 'circle-stroke-color': DARK, 'circle-opacity': 0.85,
    },
  });
  map.addLayer({
    id: 'point', type: 'circle', source: 'req', filter: ['!', ['has', 'point_count']],
    paint: { 'circle-color': BLUE, 'circle-radius': 5, 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' },
  });
  map.on('click', 'clusters', async (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0];
    const zoom = await map.getSource('req').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom });
  });
  map.on('click', 'point', (e) => {
    const f = e.features[0];
    const p = f.properties;
    // setDOMContent avoids injecting 311 text as HTML.
    const box = el('div', {}, el('strong', { text: p.t }), el('br'), p.d || '', el('br'),
      `${p.created} · ${p.s}`, el('br'), p.addr || '(no address)');
    new ml.Popup().setLngLat(f.geometry.coordinates.slice()).setDOMContent(box).addTo(map);
  });
  for (const layer of ['clusters', 'point']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
}

async function renderMap() {
  if (!mapCtx) return;
  const rows = await query(`
    SELECT longitude AS x, latitude AS y, complaint_type AS t, descriptor AS d, status AS s,
           strftime(created_date, '%Y-%m-%d') AS created,
           coalesce(incident_address, intersection_street_1 || ' & ' || intersection_street_2) AS addr
    FROM req WHERE ${where()} AND latitude IS NOT NULL ORDER BY created_date DESC LIMIT ${MAP_CAP}`);
  if (ADDRESS_MODE && rows.length) mapCtx.map.jumpTo({ center: [rows[0].x, rows[0].y], zoom: 17 });
  mapCtx.map.getSource('req').setData({
    type: 'FeatureCollection',
    features: rows.map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.x, r.y] }, properties: { t: r.t, d: r.d, s: r.s, created: r.created, addr: r.addr } })),
  });
  $('map-note').textContent = (total > MAP_CAP ? `Showing the ${fmtInt(MAP_CAP)} most recent of ${fmtInt(total)} matching requests. ` : `Showing all ${fmtInt(rows.length)} matching requests. `) +
    'Circles group nearby requests; select one to zoom in, or select a single point for details.';
}

// ------------------------------------------------------------- about

function renderAbout() {
  const unloc = geo === 'cd' && !ADDRESS_MODE ? district.unlocated_city_assigned : null;
  $('about').replaceChildren(
    el('p', {}, ADDRESS_MODE ? 'This page shows only requests whose address matches exactly, as the city spelled it. ' : '', 'Every request with a location was placed in this district by BoardStat, using where it happened and today\'s boundary lines.' +
      (unloc ? ` ${fmtInt(unloc)} requests that have no usable location are assigned to this community district by the city's own records; they are not counted on this page.` : '')),
    el('ul', { class: 'more-links' },
      el('li', {}, el('a', { class: 'button', href: 'about.html', text: 'About BoardStat: sources and history' })),
      el('li', {}, el('a', { class: 'button secondary', href: 'glossary.html', text: 'Glossary: terms and how numbers are counted' }))),
  );
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
      lastChartWidth = chartWidthKey();
      try {
        await Promise.all([renderMonthly(), renderAgency(), ...(ADDRESS_MODE ? [renderTimeline(), renderAddressCompare()] : [renderCompare()])]);
      } catch (err) { console.error(err); }
    }, 250);
  });
}

let refreshSeq = 0;
async function refresh() {
  const seq = ++refreshSeq;
  trackFilters();
  writeUrl();
  syncForm();
  renderChips();
  renderPending();
  describeFiltersForPrint();
  page = 0;
  setStatus($('status'), 'Updating…');
  try {
    const before = loadedFrom;
    await ensureLoaded();
    if (seq !== refreshSeq) return;
    if (loadedFrom !== before) { descOptionsKey = null; await fillFilterOptions(); }
    setStatus($('status'), 'Updating…');
    await updateDescOptions();
    await renderKpis();
    if (seq !== refreshSeq) return;
    await Promise.all([renderTop(), renderDescriptors(), renderMonthly(), renderAgencyResponse(), renderAgency(), renderBacklog(), renderDetail(), renderMap(),
      ...(ADDRESS_MODE ? [renderTimeline(), renderAddressCompare()] : [renderAddresses(), renderCompare()])]);
    if (seq === refreshSeq) setStatus($('status'), `${fmtInt(total)} requests match.`);
    lastChartWidth = chartWidthKey();
  } catch (err) {
    console.error(err);
    setStatus($('status'), `Something went wrong: ${err.message}`);
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

async function main() {
  try {
    manifest = await loadManifest();
  } catch (err) {
    $('title').textContent = 'Data not available';
    $('as-of').textContent = String(err.message || err);
    return;
  }
  district = manifest.districts[geo]?.find((d) => String(d.id) === String(geoId));
  if (!district || !district.file) {
    $('title').textContent = 'District not found';
    $('as-of').replaceChildren('No data for this district. ', el('a', { href: './', text: 'Choose another district.' }));
    return;
  }
  if (ADDRESS_MODE && !params.get('addr')) {
    $('title').textContent = 'No address chosen';
    $('as-of').replaceChildren(el('a', { href: './#addr', text: 'Search for an address.' }));
    return;
  }
  const label = ADDRESS_MODE ? params.get('addr') : district.label;
  document.title = `${label} · BoardStat 2.0 (prototype)`;
  $('title').textContent = label;
  renderDataStatus(manifest, $('as-of'), $('stale'));
  renderChanges($('changes'), { geo, id: geoId, label: ADDRESS_MODE ? `in ${district.label}` : 'in this district' });
  asOfSql = `CAST(${lit(nycLocal(manifest.generated_at))} AS TIMESTAMP)`;
  const b = geo === 'cd' ? manifest.sources.community_districts : manifest.sources.council_districts;
  $('boundary-note').textContent = `Boundary: ${geo === 'cd' ? 'Community District' : 'City Council District'} lines, Department of City Planning release ${b.version || 'unknown'}.` +
    (district.jia ? ' This is a Joint Interest Area (a park or other area outside every community district), not a community district.' : '');
  if (geo === 'cc') { $('cc-banner').hidden = false; document.querySelectorAll('.bver').forEach((n) => { n.textContent = b.version || ''; }); }
  renderAbout();

  setStatus($('status'), 'Loading the query engine and this district\'s data…');
  [Plot] = await Promise.all([
    import(PLOT_URL),
    registerData('d.parquet', `data/${district.file}`),
    registerData('agg.parquet', 'data/agg/month_type.parquet'),
  ]);
  viewStart = manifest.window.default_start || manifest.window.start;
  window.boardstatTrack?.(ADDRESS_MODE ? 'address_viewed' : 'district_selected', { geo, district_id: geoId, page_type: ADDRESS_MODE ? 'address' : 'district' });
  state = readState();
  await ensureLoaded();
  if (ADDRESS_MODE) await renderAddressLinks();
  await setupFilters();
  try { await setupMap(); } catch (err) {
    console.error(err);
    $('map').replaceChildren(el('p', { text: `The map could not load (${err.message}). Every number on this page is also in the tables.` }));
  }
  watchChartWidth();
  await refresh();
}

main();
