// Full-page map (#143) in BetaNYC's shared map layout (#193, #194): the map fills the
// window, the district page's filter form sits in a blue panel on the right, and a white
// stats bar runs along the bottom; both hide. Requests are piled by address (js/piles.js):
// circles zoomed out, a chip per request zoomed in, discs in 3D. A pile's popup lists its
// problems and latest requests with the agency's resolution text.
//
// It reads the same link parameters as the district page (filterstate.js), runs the same
// WHERE clause (filtersql.js) and the same filter form (filterform.js): Apply redraws and
// rewrites the link, and the back link carries the filters set here. A month in the
// stats bar applies that month through the same form.
//
// Rows: the same loader as the district page (loadplan.js) builds a table of the columns
// the map and the filters use, in a compressed in-memory database, from the From date on
// (plus every request not yet closed). Piles and months are counted there in SQL, so every
// matching request is counted. The resolution text is read from the data files only when
// a popup opens.
import { loadManifest, renderDataStatus, registerData, reregisterData, query, el, setStatus, fmtDate, fmtInt, monthLabel, dataUrl } from './lib.js';
import { filtersFromParams, filtersToParams, keepKnownStatus, addressParams } from './filterstate.js';
import { whereSql, NOT_CLOSED_SQL } from './filtersql.js';
import { createFilterForm, tableLists, DATE_ORDER_MSG, matchMsg, formPartsReady, showPartsFailed } from './filterform.js';
import { placeShapes, boundaryFile } from './requestmap.js';
import { makeMap, addBoundaries, featureBounds } from './map.js';
import { parsePlace, resolvePlace, sourceNames, sourceSql } from './place.js';
import { periodFrom, createLoader, freshnessCheck, loadFailedText, filesNamedIn, DataChangedError } from './loadplan.js';
import { reportLinkHref } from './report.js';
import * as P from './piles.js';
import { monthsBetween, monthDates, inDates, monthlySql, monthBars } from './monthchart.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
// A community district, a council district, or a whole borough (geo=boro, #144).
const { geo, id: geoId } = parsePlace(params);
const IS_BORO = geo === 'boro';
const PLACE_PAGE = IS_BORO ? 'borough' : 'district';
const PHONE = '(max-width: 760px)';
const isPhone = () => window.matchMedia(PHONE).matches;

// The columns the piles, popups and filters use (filtersql.js, piles.js).
const MAP_COLUMNS = ['unique_key', 'created_date', 'complaint_type', 'descriptor', 'agency', 'agency_name', 'status', 'address_norm',
  'incident_address', 'intersection_street_1', 'intersection_street_2', 'latitude', 'longitude'];
const LATEST = 12; // requests listed in a popup
const TOP_PROBLEMS = 8;
const EMPTY = { type: 'FeatureCollection', features: [] };
const STACKS = Array.from({ length: P.FLAT_CAP }, (_, i) => `pile-chip-${i}`);
const LAYERS = { circles: ['pile-circles'], flat: [...STACKS, 'pile-label'], '3d': ['pile-discs', 'pile-col-label'] };
const HIT = ['pile-circles', ...STACKS, 'pile-discs'];
const FONT = ['Noto Sans Regular']; // a font the self-hosted basemap serves (map.js checkBasemapFiles)

let manifest, district, mapCtx, form, loader;
let names = [];
let state = {};
let defaults = {};
let total = 0;
let lastFailed = false;
let firstLoadDone = false;
let dataFiles = [];
let loadCount = 0;
let listsKey = null; // the loads and dates the form's lists were made for
let piles = [];
let bars = [];
let chartFrom = null;
let view = null; // 'circles', 'flat' or '3d'
let discZoom = -1;
let popup = null;
let focusMonth = null; // a month chosen by keyboard keeps focus after the redraw

/** The filters a link with no filters opens with (Reset's target). This page never has an address. */
const defaultFilters = () => ({ ...defaults, agencies: [], types: [], descs: [], descEx: false, status: '', addr: '', bbl: '' });

/** The form's lists, from this page's rows, for the applied dates (filterform.js tableLists). */
const formLists = tableLists(query, () => state);

/**
 * The link of this page, of the way back and of "Report a data problem" (report.js):
 * same place, same filters, never an address.
 */
function writeLinks() {
  const p = filtersToParams(geo, geoId, state, defaults);
  history.replaceState(null, '', `?${p.toString()}`);
  $('back-link').href = `district.html?${p.toString()}`;
  $('report-link').href = reportLinkHref('map.html', p);
}

/** Make sure the table has every row these filters need (Closed requests from the From date on). */
async function ensureLoaded() {
  const target = periodFrom(state, manifest.window.start) ?? (loader.loadedFrom() === null ? periodFrom({ start: defaults.start }, manifest.window.start) : null);
  if (target === null) return false;
  return loader.loadFor(target, (from, done, n) => setStatus($('status'),
    `Loading requests from ${fmtDate(from)} on…${n > 1 && done ? ` (${done} of ${n} districts loaded)` : ''}`));
}

/** After a failed read: register again only the files the error names (lib.js, loadplan.js). */
function freshDataFiles(err) {
  const failed = filesNamedIn(String(err?.message || err || ''), dataFiles);
  return loader.queue(async () => {
    for (const [name, path] of failed) {
      try { await reregisterData(name, path); } catch (e) { console.error(e); }
    }
  });
}

const dateRange = (s) => `${fmtDate(s.start)} – ${fmtDate(s.end)}`;

// ---------------------------------------------------------------- map

/** The map, the place's lines, and empty pile layers (piles.js). */
async function setupMap() {
  const gj = await (await fetch(dataUrl(`data/boundaries/${boundaryFile(geo)}.geojson`))).json();
  const { selected, selectedId } = placeShapes(geo, geoId, gj.features);
  const ctx = await makeMap('map', {
    ...(selected.length ? { bounds: featureBounds(selected) } : {}),
    padding: { top: 90, bottom: 20, left: 50, right: 20 }, navPosition: 'top-left', compass: true,
  });
  const { map } = ctx;
  addBoundaries(map, gj, { selectedId });
  for (const id of ['pile-circles', 'pile-chips', 'pile-discs', 'pile-points']) map.addSource(id, { type: 'geojson', data: EMPTY });
  const gcol = (key) => P.groupColorExpr(key, P.GCOL);
  map.addLayer({ id: 'pile-circles', type: 'circle', source: 'pile-circles',
    paint: { 'circle-radius': ['get', 'r'], 'circle-color': gcol('dom'), 'circle-opacity': 0.75, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
  STACKS.forEach((id, i) => map.addLayer({ id, type: 'circle', source: 'pile-chips', filter: ['==', ['get', 'i'], i], layout: { visibility: 'none' },
    paint: { 'circle-radius': 3.5, 'circle-color': gcol('g'), 'circle-stroke-color': '#fff', 'circle-stroke-width': 0.75,
      'circle-translate': [0, -i * P.STACK_STEP_PX], 'circle-translate-anchor': 'viewport' } }));
  map.addLayer({ id: 'pile-discs', type: 'fill-extrusion', source: 'pile-discs', layout: { visibility: 'none' },
    paint: { 'fill-extrusion-color': P.groupColorExpr('g', P.DCOL), 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 1 } });
  // Totals need the street map's fonts; with no street map (it failed, or the test fixture
  // has none) there are no labels, and the popup still gives every total.
  if (map.getStyle().glyphs) {
    const label = { 'text-field': ['to-string', ['get', 'n']], 'text-font': FONT, 'text-size': 11, 'text-allow-overlap': true };
    const paint = { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.5 };
    const filter = ['>=', ['get', 'n'], P.LABEL_MIN];
    map.addLayer({ id: 'pile-label', type: 'symbol', source: 'pile-points', filter, paint, layout: { ...label, visibility: 'none', 'text-anchor': 'top', 'text-offset': [0, 0.6] } });
    map.addLayer({ id: 'pile-col-label', type: 'symbol', source: 'pile-points', filter, paint,
      layout: { ...label, visibility: 'none', 'text-ignore-placement': true, 'symbol-height-offset': ['get', 'top'] } });
  }
  for (const l of HIT) {
    map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', (e) => {
    const box = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
    const layers = HIT.filter((l) => map.getLayoutProperty(l, 'visibility') !== 'none');
    const f = map.queryRenderedFeatures(box, { layers })[0];
    if (f) openPopup(f.properties.p, e.lngLat);
  });
  // Keyboard: Enter on the map opens the pile nearest its middle.
  map.getCanvas().addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const idx = P.pilesIn(piles, boundsOf(map, 0));
    const c = map.project(map.getCenter());
    const near = P.nearestPile(idx.map((i) => { const q = map.project([piles[i].x, piles[i].y]); return [q.x, q.y]; }), [c.x, c.y]);
    if (near >= 0) { e.preventDefault(); openPopup(idx[near]); }
  });
  map.on('pitch', () => { if (P.pickView(map.getZoom(), map.getPitch(), view) !== view) draw(); });
  map.on('moveend', () => draw(view !== 'circles'));
  $('tilt').addEventListener('click', () => {
    const up = map.getPitch() < P.TILT_ON;
    map.easeTo({ pitch: up ? 55 : 0, bearing: up ? -20 : 0, zoom: up ? Math.max(map.getZoom(), 16.5) : map.getZoom(), duration: 900 });
  });
  return ctx;
}

/** The map's bounds, widened by `pad` of its size on each side. */
function boundsOf(map, pad = 0.5) {
  const b = map.getBounds();
  const dx = (b.getEast() - b.getWest()) * pad;
  const dy = (b.getNorth() - b.getSouth()) * pad;
  return [[b.getWest() - dx, b.getSouth() - dy], [b.getEast() + dx, b.getNorth() + dy]];
}

/** Draw the piles for the view the zoom and tilt call for. Zoomed in, only the piles near the screen. */
function draw(force = false) {
  const map = mapCtx?.map;
  if (!map) return;
  const z = map.getZoom();
  const v = P.pickView(z, map.getPitch(), view);
  const resize = v === '3d' && Math.abs(z - discZoom) >= P.DISC_REBUILD_ZOOM;
  if (!force && v === view && !resize) return;
  view = v;
  const idx = v === 'circles' ? [] : P.pilesIn(piles, boundsOf(map));
  map.getSource('pile-circles').setData(v === 'circles' ? P.circlesData(piles) : EMPTY);
  map.getSource('pile-chips').setData(v === 'flat' ? P.chipsData(piles, idx) : EMPTY);
  map.getSource('pile-discs').setData(v === '3d' ? P.discsData(piles, z, idx) : EMPTY);
  map.getSource('pile-points').setData(v === 'circles' ? EMPTY : P.circlesData(piles, z, idx));
  discZoom = v === '3d' ? z : -1;
  for (const [k, ids] of Object.entries(LAYERS)) {
    for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', k === v ? 'visible' : 'none');
  }
  $('tilt').setAttribute('aria-pressed', String(map.getPitch() >= P.TILT_ON));
  $('map-note').textContent = v === 'circles'
    ? 'Each circle is one address, bigger for more requests and colored by the agency with the most. Zoom in to see one chip per request.'
    : `Each chip is one request, piled at its address and colored by agency. Piles of ${P.LABEL_MIN} or more show their total. `
      + `Flat piles stop at ${P.FLAT_CAP} chips and 3D columns at ${P.PILE_CAP}; the popup gives every total.${v === 'flat' ? ' Press 3D to tilt.' : ''}`;
}

// ---------------------------------------------------------------- popup

/** The popup for pile i: what is at this address for the applied filters, and what the agency wrote. */
async function openPopup(i, lngLat = null) {
  const pile = piles[i];
  if (!pile || !mapCtx) return;
  const { ml, map } = mapCtx;
  popup?.remove();
  const heading = el('h3', { text: pile.label, tabindex: '-1' });
  const box = el('div', { class: 'fm-pop', role: 'region', 'aria-label': `Requests at ${pile.label}` }, heading, el('p', { text: 'Loading…' }));
  const mine = new ml.Popup({ maxWidth: '340px' }).setLngLat(lngLat ?? [pile.x, pile.y]).setDOMContent(box).addTo(map);
  popup = mine;
  const where = whereSql(state);
  try {
    const types = await query(P.pileTypesSql(where, pile.k));
    const latest = await query(P.pileLatestSql(where, pile.k, LATEST));
    let notes = new Map();
    let notesFailed = false;
    if (latest.length) {
      try {
        notes = new Map((await query(P.resolutionsSql(sourceSql(names), latest))).map((r) => [r.id, r.r]));
      } catch (err) {
        console.error(err);
        notesFailed = true;
        freshDataFiles(err).catch((e) => console.error(e));
      }
    }
    if (popup !== mine) return;
    box.replaceChildren(heading, ...popupBody(pile, types, latest, notes, notesFailed));
    keepInView(mine);
  } catch (err) {
    console.error(err);
    if (popup === mine) box.replaceChildren(heading, el('p', { text: 'This address could not load. Close the popup and try again.' }));
  }
  heading.focus();
}

/** Move the map down if the popup runs under the header box or off the top. */
function keepInView(p) {
  const top = document.querySelector('.fm-head').getBoundingClientRect().bottom + 8;
  const r = p.getElement()?.getBoundingClientRect();
  if (r && r.top < top) mapCtx.map.panBy([0, r.top - top], { duration: 300 });
}

function popupBody(pile, types, latest, notes, notesFailed) {
  const shown = types.reduce((s, t) => s + t.n, 0);
  const rest = types.slice(TOP_PROBLEMS);
  const out = [
    el('p', {}, `311 requests, ${dateRange(state)}: `, el('b', { text: fmtInt(shown) }), pile.o ? ` (${fmtInt(pile.o)} not yet closed)` : ''),
    el('table', {}, el('caption', { class: 'sr-only', text: 'Requests by problem' }), el('tbody', {},
      types.slice(0, TOP_PROBLEMS).map((t) => el('tr', {}, el('td', { text: t.t }), el('td', { text: fmtInt(t.n) }))),
      rest.length ? el('tr', {}, el('td', { text: `${rest.length} more ${rest.length === 1 ? 'problem' : 'problems'}` }), el('td', { text: fmtInt(rest.reduce((s, t) => s + t.n, 0)) })) : null)),
    el('h4', { text: `Latest ${latest.length}${shown > latest.length ? ` of ${fmtInt(shown)}` : ''}` }),
    ...latest.map((r) => el('div', { class: 'req' },
      el('b', { text: r.d }), ` · ${r.t}${r.ds ? ` — ${r.ds}` : ''}`, el('br'),
      `${r.a} · `, r.s === 'Closed' ? 'Closed' : el('span', { class: 'open', text: r.s || 'No status' }),
      notes.get(r.id) ? [el('br'), el('span', { class: 'res', text: notes.get(r.id) })] : null)),
  ];
  if (notesFailed) out.push(el('p', { text: 'What the agencies wrote could not load. Close the popup and open it again to retry.' }));
  if (pile.addr) {
    const href = `address.html?${addressParams(geo, geoId, state, defaults, pile.addr).toString()}`;
    out.push(el('p', { class: 'open-link' }, el('a', { href, text: 'Open this address in BoardStat' })));
  }
  return out;
}

// ---------------------------------------------------------------- stats bar (#194)

/** Only the agency groups the chart holds; one group (or none) needs no legend, so the chart takes its room. */
function renderLegend() {
  const used = P.GROUP_LABELS.map((g, i) => i).filter((i) => bars.some((b) => b.parts[i] > 0));
  document.body.classList.toggle('one-group', used.length < 2);
  $('map-legend').replaceChildren(el('h2', { text: 'Agencies' }), el('ul', {},
    used.map((i) => el('li', {}, el('span', { class: 'sw', 'aria-hidden': 'true', style: `background:${P.GCOL[i]}` }), P.GROUP_LABELS[i]))));
}

/** The monthly chart: bars stacked by agency group, months outside the applied dates faded. Each month is a button. */
function drawChart() {
  const svg = $('chart');
  const box = svg.getBoundingClientRect();
  const w = Math.round(box.width) || 600;
  const h = Math.round(box.height) || 100;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const pad = 14;
  const max = Math.max(1, ...bars.map((b) => b.total));
  const bw = w / Math.max(1, bars.length);
  const last = manifest.window.last_created?.slice(0, 10);
  let out = '';
  let labelEnd = -Infinity; // right edge of the last month label drawn, so labels never overlap
  bars.forEach((b, k) => {
    const op = inDates(b.m, state) ? 1 : 0.3;
    let top = h - pad;
    b.parts.forEach((v, g) => {
      const bh = (v / max) * (h - pad - 12);
      if (bh > 0) { top -= bh; out += `<rect x="${k * bw + 2}" y="${top}" width="${Math.max(1, bw - 4)}" height="${bh}" fill="${P.GCOL[g]}" opacity="${op}" aria-hidden="true"/>`; }
    });
    if (bw > 30) out += `<text x="${k * bw + bw / 2}" y="${top - 3}" text-anchor="middle" aria-hidden="true">${fmtInt(b.total)}</text>`;
    const [y, m] = b.m.split('-').map(Number);
    if (m % 3 === 1 || k === 0) {
      const text = `${monthLabel(b.m).split(' ')[0]}${m === 1 || k === 0 ? ` '${String(y).slice(2)}` : ''}`;
      const tw = text.length * 6; // ponytail: estimated width at the 10px font; measure with getComputedTextLength if labels still collide
      const x = k ? k * bw + bw / 2 : 2;
      const left = k ? x - tw / 2 : x;
      if (left > labelEnd + 4) { out += `<text x="${x}" y="${h - 2}" text-anchor="${k ? 'middle' : 'start'}" aria-hidden="true">${text}</text>`; labelEnd = left + tw; }
    }
    const part = k === 0 && chartFrom.slice(8) !== '01' ? ` (from ${fmtDate(chartFrom)})` : k === bars.length - 1 && last ? ` (through ${fmtDate(last)})` : '';
    const label = `${monthLabel(b.m)}: ${fmtInt(b.total)} ${b.total === 1 ? 'request' : 'requests'}${part}${op === 1 ? ', in the dates shown' : ''}. Select to show this month.`;
    out += `<rect class="bar-hit" data-m="${b.m}" x="${k * bw}" y="0" width="${bw}" height="${h}" tabindex="0" role="button" aria-label="${label}"><title>${label}</title></rect>`;
  });
  // A redraw replaces every month; keep keyboard focus on the month that had it.
  if (svg.contains(document.activeElement)) focusMonth ??= document.activeElement.dataset.m;
  svg.innerHTML = out;
  if (focusMonth) { svg.querySelector(`[data-m="${focusMonth}"]`)?.focus(); focusMonth = null; }
}

/** A month in the chart applies its dates, through the form, so the link updates too. */
function pickMonth(target, byKey) {
  const m = target?.dataset?.m;
  if (!m) return;
  if (byKey) focusMonth = m;
  form.applyNow(() => monthDates(m, manifest.window.start, manifest.window.end));
}

async function updateStats(where) {
  const [t] = await query(`SELECT count(*)::INTEGER AS n, count(*) FILTER (WHERE ${NOT_CLOSED_SQL})::INTEGER AS o,
    count(*) FILTER (WHERE NOT (${P.LOCATED_SQL}))::INTEGER AS nl FROM req WHERE ${where}`);
  total = t.n;
  $('bar-h').textContent = `${district.label} · ${dateRange(state)}`;
  $('k-total').textContent = fmtInt(t.n);
  $('k-open').textContent = fmtInt(t.o);
  $('k-addr').textContent = fmtInt(piles.length);
  const last = manifest.window.last_created?.slice(0, 10) || manifest.window.end;
  $('caveat').replaceChildren(el('strong', { text: '311 counts are reports, not problems. Closed doesn\'t mean fixed.' }),
    ` Not an official City report. Data through ${fmtDate(last)}.`,
    t.nl ? ` ${fmtInt(t.nl)} of these ${t.nl === 1 ? 'request has' : 'requests have'} no location and ${t.nl === 1 ? 'is' : 'are'} not on the map.` : '');
  // Months from the first day the table holds every request for (loadplan.js), to the end of the data.
  chartFrom = [loader.loadedFrom() ?? state.start, state.start].sort()[0];
  const months = monthsBetween(chartFrom, manifest.window.end);
  bars = monthBars(await query(monthlySql(state, chartFrom)), months);
  renderLegend();
  if (!document.body.classList.contains('nobar')) drawChart();
}

// ---------------------------------------------------------------- panel and bar

/** Open or close the panel (noside) or the stats bar (nobar); the map takes the space. */
function showPart(cls, open, focus = true) {
  document.body.classList.toggle(cls, !open);
  const [hide, show] = cls === 'noside' ? ['hide-side', 'show-side'] : ['hide-bar', 'show-bar'];
  for (const id of [hide, show]) $(id).setAttribute('aria-expanded', String(open));
  mapCtx?.map.resize();
  if (cls === 'nobar' && open && bars.length) drawChart();
  if (focus) $(open ? hide : show).focus();
}

// ---------------------------------------------------------------- redraw

let seq = 0;
async function redraw() {
  const mine = ++seq;
  popup?.remove();
  writeLinks();
  form.render();
  setStatus($('status'), 'Updating…');
  try {
    let changed;
    try { changed = await ensureLoaded(); } catch (err) { err.boardstatLoad = true; throw err; }
    if (mine !== seq) return;
    // Lists again after a load, and whenever the applied dates change (they list the dates).
    const key = `${loadCount += changed ? 1 : 0}|${state.start}|${state.end}`;
    if (key !== listsKey) { listsKey = key; await form.fillLists(); }
    if (!firstLoadDone) {
      // Drop a status this place's data does not have, as the district page does
      // (keepKnownStatus), so both pages show the same requests for the same link.
      firstLoadDone = true;
      state = keepKnownStatus(state, form.statusChoices());
      form.set(state);
      writeLinks();
    }
    const where = whereSql(state);
    const next = P.toPiles(await query(P.addressSql(where)));
    if (mine !== seq) return;
    piles = next;
    draw(true);
    await updateStats(where);
    if (mine !== seq) return;
    setStatus($('status'), state.start > state.end ? DATE_ORDER_MSG : matchMsg(total));
    lastFailed = false;
  } catch (err) {
    console.error(err);
    lastFailed = true;
    if (!(err instanceof DataChangedError)) freshDataFiles(err).catch((e) => console.error(e));
    setStatus($('status'), err.boardstatLoad || err instanceof DataChangedError ? loadFailedText(err)
      : 'Something went wrong while updating the map. Press Apply filters to try again, or reload the page.');
  }
}

async function main() {
  // Panel open on a wide screen; on a phone it is a full-screen sheet behind the Filters button.
  showPart('noside', !isPhone(), false);
  $('hide-side').addEventListener('click', () => showPart('noside', false));
  $('show-side').addEventListener('click', () => showPart('noside', true));
  $('hide-bar').addEventListener('click', () => showPart('nobar', false));
  $('show-bar').addEventListener('click', () => showPart('nobar', true));
  $('chart').addEventListener('click', (e) => pickMonth(e.target, false));
  $('chart').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickMonth(e.target, true); }
  });
  // Redraw whenever the chart's own box changes: a window resize, or the panel opening or closing.
  new ResizeObserver(() => { if (bars.length && !document.body.classList.contains('nobar')) drawChart(); }).observe($('chart'));

  try {
    manifest = await loadManifest();
  } catch (err) {
    $('title').textContent = 'BoardStat · Data not available';
    console.error(err);
    $('status').textContent = 'BoardStat\'s data could not be loaded. Reload the page to try again.';
    return;
  }
  district = resolvePlace(manifest, geo, geoId);
  if (!district) {
    $('title').textContent = `BoardStat · ${IS_BORO ? 'Borough' : 'District'} not found`;
    $('status').replaceChildren(`No data for this ${PLACE_PAGE}. `, el('a', { href: './', text: 'Choose another place.' }));
    $('back-link').href = './';
    $('back-link').textContent = '← Choose a district or borough';
    $('filters').hidden = true;
    return;
  }
  if (IS_BORO) $('back-link').textContent = '← Back to the borough page';
  defaults = { start: manifest.window.default_start || manifest.window.start, end: manifest.window.end };
  // A link never carries an address (filtersToParams), and this page ignores one if it does.
  state = { ...filtersFromParams(params, defaults), addr: '', bbl: '' };

  document.title = `Map · ${district.label} · BoardStat 2.0 (prototype)`;
  $('title').textContent = `BoardStat · ${district.label} · 311 Requests`;
  $('map').setAttribute('aria-label', `Map of 311 requests in ${district.label}, piled by address. Select a pile, or press Enter on the map for the pile nearest its middle, to read its requests. The ${PLACE_PAGE} page has the same information in tables.`);
  renderDataStatus(manifest, $('as-of'), $('stale'));

  // The Agency, Problem and Description boxes, Exclude, Apply and Reset are UI SDK parts (#187).
  // The form sets their properties, so it waits until they are defined.
  if (!(await formPartsReady())) showPartsFailed();
  form = createFilterForm({
    defaults: defaultFilters,
    lists: formLists,
    onApply: (s) => {
      state = s;
      // On a phone the panel covers the map: close it after an Apply, and stay on its button.
      if (isPhone() && !document.body.classList.contains('noside')) showPart('noside', false);
      redraw();
    },
    lastFailed: () => lastFailed,
    matchText: () => matchMsg(total),
    setStatus: (msg) => setStatus($('status'), msg),
    onListOrder: writeLinks,
  });
  form.set(state);
  form.bind(manifest.window.start, manifest.window.end);
  form.openGroups();
  writeLinks();

  setStatus($('status'), IS_BORO ? 'Loading the map and the borough\'s requests…' : 'Loading the map and this district\'s requests…');
  // One file for a district; every district file of a borough (place.js).
  names = sourceNames(district);
  dataFiles = names.map((n, i) => [n, `data/${district.files[i]}`]);
  try {
    [mapCtx] = await Promise.all([
      setupMap(),
      ...names.map((n, i) => registerData(n, `data/${district.files[i]}`)),
    ]);
    // The same compressed in-memory database as the district page (district.js main()).
    await query(`ATTACH ':memory:' AS boardstat (COMPRESS true)`);
    await query('USE boardstat');
  } catch (err) {
    console.error(err);
    $('map').replaceChildren(el('p', { text: `The map could not load. Reload the page to try again; the ${PLACE_PAGE} page has the same information in tables.` }));
    setStatus($('status'), '');
    return;
  }
  loader = createLoader({ exec: query, sources: names.map((n) => sourceSql([n])), cols: MAP_COLUMNS.join(', '), checkFresh: freshnessCheck(manifest.generated_at) });
  await redraw();
}

main();
