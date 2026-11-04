// District page: every query runs in DuckDB-WASM over ONE district's Parquet file.
import {
  PLOT_URL, loadManifest, renderDataStatus, registerData, query, lit, el, table, chartWithTable,
  setStatus, fmtInt, fmtDays, fmtPct, fmtDate, fmtDateTime, monthLabel,
} from './lib.js';
import { makeMap, addBoundaries, featureBounds } from './map.js';

const $ = (id) => document.getElementById(id);
const PAGE = 50;
const MAP_CAP = 60000;
const BLUE = '#2359a8';
const GRAY = '#949494';
const DARK = '#414141';
const STATUS_COLORS = [BLUE, '#B8D6FF', DARK, GRAY, '#EEF4FF', '#F1F1F1'];
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

let manifest, district, Plot;
let state = {};
let page = 0;
let total = 0;
let mapCtx = null;
let selectedType = null;
let asOfSql = null; // build time as an NYC-local TIMESTAMP literal; "days open" is measured to it

// ------------------------------------------------------------- state <-> URL

function readState() {
  return {
    start: params.get('start') || manifest.window.start,
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
  if (state.start !== manifest.window.start) p.set('start', state.start);
  if (state.end !== manifest.window.end) p.set('end', state.end);
  if (state.types.length) p.set('type', state.types.join('|'));
  if (state.descs.length) p.set('desc', state.descs.join('|'));
  if (state.descs.length && state.descEx) p.set('descx', '1');
  if (state.agency) p.set('agency', state.agency);
  if (state.status) p.set('status', state.status);
  if (state.addr) p.set('addr', state.addr);
  history.replaceState(null, '', `?${p.toString()}`);
}

function where({ skipType = false, skipDates = false, skipDesc = false, skipStatus = false } = {}) {
  const w = skipDates ? ['TRUE'] : [
    `created_date >= CAST(${lit(state.start)} AS DATE)`,
    `created_date < CAST(${lit(state.end)} AS DATE) + INTERVAL 1 DAY`,
  ];
  if (!skipType && state.types.length) w.push(`complaint_type IN (${state.types.map(lit).join(', ')})`);
  if (state.agency) w.push(`agency = ${lit(state.agency)}`);
  if (!skipDesc && state.descs.length) w.push(`${DESC_SQL} ${state.descEx ? 'NOT IN' : 'IN'} (${state.descs.map(lit).join(', ')})`);
  if (!skipStatus && state.status) w.push(state.status === NOT_CLOSED ? NOT_CLOSED_SQL : `status = ${lit(state.status)}`);
  if (state.addr) w.push(`address_norm = ${lit(state.addr)}`);
  return w.join(' AND ');
}

// ------------------------------------------------------------- filter controls

let allTypes = [];
function renderChips() {
  $('type-chips').replaceChildren(...state.types.map((t) => el('li', {},
    el('button', { type: 'button', 'aria-label': `Remove problem filter ${t}`, onclick: () => { state.types = state.types.filter((x) => x !== t); refresh(); } }, `${t} ×`))));
  $('desc-chips').classList.toggle('exclude', state.descEx);
  $('desc-chips').setAttribute('aria-label', state.descEx ? 'Excluded descriptions' : 'Selected descriptions');
  $('desc-chips').replaceChildren(...state.descs.map((d) => el('li', {},
    el('button', { type: 'button', 'aria-label': `Remove description filter ${d}`, onclick: () => { state.descs = state.descs.filter((x) => x !== d); refresh(); } },
      `${state.descEx ? 'Not: ' : ''}${d} ×`))));
  $('addr-filter').hidden = !state.addr;
  $('addr-value').textContent = state.addr;
}

/** Put the form controls back in line with `state` (after a reset or a shortcut button). */
function syncForm() {
  $('f-start').value = state.start;
  $('f-end').value = state.end;
  $('f-agency').value = state.agency;
  $('f-status').value = state.status;
  $('f-desc-ex').checked = state.descEx;
}

let allDescs = [];
let descOptionsKey = null;
/** The Description list offers only descriptors of the selected problems (all if none). */
async function updateDescOptions() {
  const key = state.types.join('|');
  if (key === descOptionsKey) return;
  descOptionsKey = key;
  const rows = await query(`
    SELECT ${DESC_SQL} AS d, count(*) AS n FROM req
    ${state.types.length ? `WHERE complaint_type IN (${state.types.map(lit).join(', ')})` : ''}
    GROUP BY 1 ORDER BY 2 DESC, 1`);
  allDescs = rows.map((r) => r.d);
  $('desc-options').replaceChildren(...allDescs.map((d) => el('option', { value: d })));
}

function addDesc(d) {
  const match = allDescs.find((x) => x.toLowerCase() === String(d).trim().toLowerCase());
  if (match && !state.descs.includes(match)) { state.descs = [...state.descs, match]; refresh(); }
  $('f-desc').value = '';
}

function addType(t) {
  const match = allTypes.find((x) => x.toLowerCase() === t.trim().toLowerCase());
  if (match && !state.types.includes(match)) { state.types = [...state.types, match]; refresh(); }
  $('f-type').value = '';
}

async function setupFilters() {
  const { start, end } = manifest.window;
  for (const id of ['f-start', 'f-end']) { $(id).min = start; $(id).max = end; }
  $('f-start').value = state.start;
  $('f-end').value = state.end;
  allTypes = (await query(`SELECT complaint_type AS t, count(*) AS n FROM req GROUP BY 1 ORDER BY 2 DESC`)).map((r) => r.t);
  $('type-options').replaceChildren(...allTypes.map((t) => el('option', { value: t })));
  for (const r of await query(`SELECT agency, any_value(agency_name) AS agency_label, count(*) AS n FROM req GROUP BY 1 ORDER BY 3 DESC`)) {
    $('f-agency').append(el('option', { value: r.agency, text: `${r.agency}${r.agency_label ? ` (${r.agency_label})` : ''}` }));
  }
  for (const r of await query(`SELECT status, count(*) AS n FROM req WHERE status IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)) {
    $('f-status').append(el('option', { value: r.status, text: r.status }));
  }
  if (state.status && ![...$('f-status').options].some((o) => o.value === state.status)) state.status = '';
  syncForm();

  $('f-start').addEventListener('change', (e) => { if (e.target.value) { state.start = e.target.value; refresh(); } });
  $('f-end').addEventListener('change', (e) => { if (e.target.value) { state.end = e.target.value; refresh(); } });
  $('f-agency').addEventListener('change', (e) => { state.agency = e.target.value; refresh(); });
  $('f-status').addEventListener('change', (e) => { state.status = e.target.value; refresh(); });
  $('f-type').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addType(e.target.value); } });
  $('f-type').addEventListener('change', (e) => { if (allTypes.includes(e.target.value)) addType(e.target.value); });
  $('f-desc').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addDesc(e.target.value); } });
  $('f-desc').addEventListener('change', (e) => { if (allDescs.includes(e.target.value)) addDesc(e.target.value); });
  $('f-desc-ex').addEventListener('change', (e) => { state.descEx = e.target.checked; refresh(); });
  $('addr-clear').addEventListener('click', () => { state.addr = ''; refresh(); });
  $('reset').addEventListener('click', () => {
    state = { start, end, types: [], descs: [], descEx: false, agency: '', status: '', addr: '' };
    refresh();
  });
  $('print').addEventListener('click', () => window.print());
  window.addEventListener('beforeprint', describeFiltersForPrint);
  $('prev').addEventListener('click', () => { if (page > 0) { page--; renderDetail(); } });
  $('next').addEventListener('click', () => { if ((page + 1) * PAGE < total) { page++; renderDetail(); } });
  $('download').addEventListener('click', downloadCsv);
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
          : el('button', { type: 'button', class: 'link', 'aria-label': `${verb} description ${r.d} ${state.descEx ? 'from' : 'to'} the filter`, onclick: () => { state.descs = [...state.descs, r.d]; refresh(); } }, r.d)),
      },
      { key: 'n', label: 'Requests', num: true, fmt: fmtInt },
    ], `Select a description to ${state.descEx ? 'exclude it' : 'add it to the filter'}. The description filter does not narrow this table.`),
    ...(state.types.includes(selectedType) ? []
      : [el('p', {}, el('button', { type: 'button', class: 'secondary', onclick: () => { state.types = [...state.types, selectedType]; refresh(); } }, `Filter the page to ${selectedType}`))]),
  );
}

async function renderMonthly() {
  // The year-earlier series applies every filter except From/To, shifted back 12 months.
  const rows = await query(`
    WITH m AS (
      SELECT year_month AS ym, count(*)::INTEGER AS n FROM req WHERE ${where()} GROUP BY 1
    ), prev_year AS (
      SELECT strftime(created_date + INTERVAL 12 MONTH, '%Y-%m') AS ym, count(*)::INTEGER AS n_prior
      FROM req WHERE ${where({ skipDates: true })}
        AND created_date >= CAST(${lit(state.start)} AS DATE) - INTERVAL 12 MONTH
        AND created_date < CAST(${lit(state.end)} AS DATE) + INTERVAL 1 DAY - INTERVAL 12 MONTH
      GROUP BY 1
    )
    SELECT m.ym, m.n, prev_year.n_prior FROM m LEFT JOIN prev_year USING (ym) ORDER BY m.ym`);
  const data = [];
  for (const r of rows) {
    const date = new Date(`${r.ym}-01T12:00:00`);
    data.push({ date, ym: r.ym, series: 'This period', n: r.n });
    if (r.n_prior != null) data.push({ date, ym: r.ym, series: 'Same month a year earlier', n: r.n_prior });
  }
  const hasPrior = data.some((d) => d.series !== 'This period');
  const chart = Plot.plot({
    ariaLabel: 'Requests per month',
    ariaDescription: 'Line chart of requests per month for the filtered requests' + (hasPrior ? ', with the same month a year earlier where available.' : '.'),
    height: 260,
    marginLeft: 56,
    x: { type: 'utc', label: null, ticks: 6, tickFormat: '%b %Y' },
    y: { label: 'Requests', grid: true, tickFormat: '~s' },
    color: { domain: ['This period', 'Same month a year earlier'], range: [BLUE, GRAY], legend: hasPrior },
    marks: [
      Plot.ruleY([0]),
      Plot.lineY(data, { x: 'date', y: 'n', stroke: 'series', strokeWidth: 2 }),
      Plot.dot(data, { x: 'date', y: 'n', stroke: 'series', fill: 'white', symbol: 'series', tip: true, title: (d) => `${monthLabel(d.ym)}: ${fmtInt(d.n)} (${d.series})` }),
    ],
  });
  chartWithTable($('monthly'), chart, rows, [
    { key: 'ym', label: 'Month', fmt: monthLabel },
    { key: 'n', label: 'Requests', num: true, fmt: fmtInt },
    { key: 'n_prior', label: 'Same month a year earlier', num: true, fmt: (v) => (v == null ? 'not in data' : fmtInt(v)) },
  ], 'Requests per month');
  const end = new Date(`${manifest.window.end}T12:00:00`);
  const endIsMonthEnd = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate() === end.getDate();
  if (!endIsMonthEnd && rows.length && rows[rows.length - 1].ym === manifest.window.end.slice(0, 7)) {
    const through = manifest.window.last_created ? fmtDate(manifest.window.last_created.replace(' ', 'T')) : fmtDate(manifest.window.end);
    $('monthly').append(el('p', { class: 'muted', text: `The last month is partial: the newest request in the data is from ${through}. Its year-earlier value covers the selected dates one year earlier, so it can include days the current month does not have yet.` }));
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
          onclick: () => { state.agency = state.agency === r.agency ? '' : r.agency; refresh(); },
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
  const before = state.start;
  state.end = dayBefore(before);
  state.start = manifest.window.start;
  state.status = NOT_CLOSED;
  if (agency) state.agency = agency;
  refresh();
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
  const statuses = [...new Set(rows.map((r) => r.status))].sort((a, b) => (a === 'Closed' ? -1 : b === 'Closed' ? 1 : a.localeCompare(b)));
  const chart = Plot.plot({
    ariaLabel: 'Requests by agency and status',
    ariaDescription: 'Stacked horizontal bars: one bar per agency (top 8), split by request status.',
    marginLeft: 70,
    height: 40 + 34 * new Set(rows.map((r) => r.agency)).size,
    x: { label: 'Requests', grid: true, tickFormat: '~s' },
    y: { label: null },
    color: { domain: statuses, range: STATUS_COLORS, legend: true },
    marks: [
      Plot.barX(rows, { y: 'agency', x: 'n', fill: 'status', stroke: DARK, strokeWidth: 0.5, sort: { y: '-x' }, tip: true }),
      Plot.ruleX([0]),
    ],
  });
  chartWithTable($('agency'), chart, rows, [
    { key: 'agency', label: 'Agency' }, { key: 'status', label: 'Status' }, { key: 'n', label: 'Requests', num: true, fmt: fmtInt },
  ], 'Requests by agency and status (top 8 agencies)');
}

async function renderAddresses() {
  const rows = await query(`
    SELECT address_norm AS a, count(*)::INTEGER AS n, mode(complaint_type) AS top_type
    FROM req WHERE ${where()} AND address_norm IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`);
  $('addresses').replaceChildren(table(rows, [
    { key: 'a', label: 'Address', render: (r) => el('button', { type: 'button', class: 'link', 'aria-label': `Filter to ${r.a}`, onclick: () => { state.addr = r.a; refresh(); } }, r.a) },
    { key: 'n', label: 'Requests', num: true, fmt: fmtInt },
    { key: 'top_type', label: 'Most common problem' },
  ], 'Select an address to filter the page to it'));
}

async function renderCompare() {
  const boro = district.borough;
  const ymStart = state.start.slice(0, 7);
  const ymEnd = state.end.slice(0, 7);
  $('cmp-note').textContent = `Share of each problem among all located requests, ${monthLabel(ymStart)} to ${monthLabel(ymEnd)} (whole months). ` +
    `Compared with ${boro || 'the borough'}${geo === 'cc' ? ' (the borough where most of this district\'s requests are)' : ''} and the whole city. Problem, agency, status and address filters do not apply here.`;
  const rows = await query(`
    WITH a AS (
      SELECT geo_kind, complaint_type AS t, sum(n) AS n FROM 'agg.parquet'
      WHERE year_month BETWEEN ${lit(ymStart)} AND ${lit(ymEnd)}
        AND ((geo_kind = ${lit(geo)} AND geo_id = ${lit(geoId)}) OR (geo_kind = 'borough' AND geo_id = ${lit(boro || '')}) OR geo_kind = 'city')
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
  setStatus($('status'), 'Preparing CSV…');
  const sel = CSV_COLUMNS.map((c) => (c.endsWith('_date') ? `strftime(${c}, '%Y-%m-%dT%H:%M:%S') AS ${c}` : c)).join(', ');
  const rows = await query(`SELECT ${sel} FROM req WHERE ${where()} ORDER BY created_date, unique_key`);
  const lines = [CSV_COLUMNS.join(',')].concat(rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(',')));
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `boardstat-${geo}-${geoId}-${state.start}-to-${state.end}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  setStatus($('status'), `Downloaded ${fmtInt(rows.length)} requests as CSV.`);
}

// ------------------------------------------------------------- map

async function setupMap() {
  const gj = await (await fetch(`data/boundaries/${geo}.geojson`)).json();
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
  mapCtx.map.getSource('req').setData({
    type: 'FeatureCollection',
    features: rows.map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.x, r.y] }, properties: { t: r.t, d: r.d, s: r.s, created: r.created, addr: r.addr } })),
  });
  $('map-note').textContent = (total > MAP_CAP ? `Showing the ${fmtInt(MAP_CAP)} most recent of ${fmtInt(total)} matching requests. ` : `Showing all ${fmtInt(rows.length)} matching requests. `) +
    'Circles group nearby requests; select one to zoom in, or select a single point for details. Basemap: decision pending (OpenFreeMap or self-hosted Protomaps PMTiles).';
}

// ------------------------------------------------------------- about

function renderAbout() {
  const c = manifest.counts;
  const a = manifest.agreement;
  const s = manifest.sources;
  const unloc = geo === 'cd' ? district.unlocated_city_assigned : null;
  $('about').replaceChildren(
    el('ul', {},
      el('li', {}, 'Source: ', el('a', { href: s.service_requests.url, text: s.service_requests.name || '311 Service Requests' }), ` (dataset ${s.service_requests.id}) on NYC Open Data.`),
      el('li', {}, `Boundaries: Department of City Planning Community Districts (${s.community_districts.id}, release ${s.community_districts.version || 'unknown'}) and City Council Districts (${s.council_districts.id}, release ${s.council_districts.version || 'unknown'}).`),
      el('li', {}, `Every request with a location was placed in a district by BoardStat, using where it happened and today's boundary lines. Requests are re-mapped to current lines even if they were made under older ones.`),
      el('li', {}, `${fmtInt(c.without_coords)} of ${fmtInt(c.total)} requests citywide (${fmtPct(c.without_coords / c.total)}) have no usable location, so they are not in any district page.` +
        (unloc ? ` The city's own records assign ${fmtInt(unloc)} of those to this community district.` : '')),
      el('li', {}, `How often our district matches the city's own fields: council district ${fmtPct(a.council.share)} of ${fmtInt(a.council.compared)} requests; community district ${fmtPct(a.community_district.share)} of ${fmtInt(a.community_district.compared)}.` +
        ' Small differences are expected where a request sits near a boundary line. For requests made before the 2023 redistricting (not in this window yet), the city\'s council field uses the old lines, so the gap will grow once older years are added.'),
      el('li', {}, `Problem names are grouped regardless of capitalization (for example PLUMBING and Plumbing). ${manifest.complaint_types.unreviewed} of ${manifest.complaint_types.groups} groupings have not yet been reviewed by a person.`),
      el('li', {}, `Time to close (days to close) is the close date minus the created date, in days. It counts only requests marked Closed. Requests with no close date, closed before they were opened (${fmtInt(c.closed_before_created)} citywide) or with a close date in the future (${fmtInt(c.closed_in_future)}) are left out, and so are the few requests that carry a close date but whose status is not Closed.`),
      el('li', {}, `"Not yet closed" means any status other than Closed (for example Open, In Progress, Assigned). Days open are counted from when a request was created to when this data was built (${fmtDateTime(manifest.generated_at)}), not to today.`),
      el('li', {}, '311 counts reflect who reports problems and how, not only how many problems exist. A higher count can mean more engaged neighbors, not a worse block.'),
    ),
  );
}

// ------------------------------------------------------------- refresh / boot

let refreshSeq = 0;
async function refresh() {
  const seq = ++refreshSeq;
  writeUrl();
  syncForm();
  renderChips();
  describeFiltersForPrint();
  page = 0;
  setStatus($('status'), 'Updating…');
  try {
    await updateDescOptions();
    await renderKpis();
    if (seq !== refreshSeq) return;
    await Promise.all([renderTop(), renderDescriptors(), renderMonthly(), renderAgencyResponse(), renderAgency(), renderBacklog(), renderAddresses(), renderCompare(), renderDetail(), renderMap()]);
    if (seq === refreshSeq) setStatus($('status'), `${fmtInt(total)} requests match.`);
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
  document.title = `${district.label} · BoardStat 2.0 (prototype)`;
  $('title').textContent = district.label;
  renderDataStatus(manifest, $('as-of'), $('stale'));
  asOfSql = `CAST(${lit(nycLocal(manifest.generated_at))} AS TIMESTAMP)`;
  const b = geo === 'cd' ? manifest.sources.community_districts : manifest.sources.council_districts;
  $('boundary-note').textContent = `Boundary: ${geo === 'cd' ? 'Community District' : 'City Council District'} lines, Department of City Planning release ${b.version || 'unknown'}.` +
    (district.jia ? ' This is a Joint Interest Area (a park or other area outside every community district), not a community district.' : '');
  if (geo === 'cc') { $('cc-banner').hidden = false; document.querySelectorAll('.bver').forEach((n) => { n.textContent = b.version || ''; }); }
  renderAbout();

  setStatus($('status'), 'Loading the query engine and this district\'s data…');
  [Plot] = await Promise.all([
    import(PLOT_URL),
    registerData('d.parquet', `data/${district.file}`).then(() => query(`CREATE TABLE req AS SELECT * FROM 'd.parquet'`)),
    registerData('agg.parquet', 'data/agg/month_type.parquet'),
  ]);
  state = readState();
  await setupFilters();
  try { await setupMap(); } catch (err) {
    console.error(err);
    $('map').replaceChildren(el('p', { text: `The map could not load (${err.message}). Every number on this page is also in the tables.` }));
  }
  await refresh();
}

main();
