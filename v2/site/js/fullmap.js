// Full-page map (#143): the district page's map of requests, as big as the window.
// It reads the same link parameters as the district page (filterstate.js), runs the same
// WHERE clause (filtersql.js), draws the same map (requestmap.js) and, since #149, has the
// same filter form (filterform.js): Apply redraws the map and rewrites the link, and the
// "Back to the district page" link carries the filters set here.
//
// Rows: the same loader as the district page (loadplan.js) builds a table of the columns
// the map and the filters use, in a compressed in-memory database, from the From date on
// (plus every request not yet closed). Moving the From date earlier appends only what is
// missing, so a change of filters reads nothing again.
import { loadManifest, renderDataStatus, registerData, reregisterData, query, el, setStatus, fmtDate, fmtInt } from './lib.js';
import { filtersFromParams, filtersToParams, keepKnownStatus } from './filterstate.js';
import { whereSql } from './filtersql.js';
import { createFilterForm, tableLists, DATE_ORDER_MSG } from './filterform.js';
import { setupRequestMap, loadRequestPoints, mapNoteText, renderMapLegend } from './requestmap.js';
import { parsePlace, resolvePlace, sourceNames, sourceSql } from './place.js';
import { periodFrom, createLoader, freshnessCheck, loadFailedText, filesNamedIn, DataChangedError } from './loadplan.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
// A community district, a council district, or a whole borough (geo=boro, #144).
const { geo, id: geoId } = parsePlace(params);
const IS_BORO = geo === 'boro';
const PLACE_PAGE = IS_BORO ? 'borough' : 'district';

// The columns the map and the filters use (filtersql.js, requestmap.js).
const MAP_COLUMNS = ['created_date', 'complaint_type', 'descriptor', 'agency', 'agency_name', 'status', 'address_norm',
  'incident_address', 'intersection_street_1', 'intersection_street_2', 'latitude', 'longitude'];

let manifest, district, mapCtx, form, loader;
let state = {};
let defaults = {};
let total = 0;
let lastFailed = false;
let firstLoadDone = false;
let dataFiles = [];
let loadCount = 0;
let listsKey = null; // the loads and dates the form's lists were made for

/** The filters a link with no filters opens with (Reset's target). This page never has an address. */
const defaultFilters = () => ({ ...defaults, types: [], descs: [], descEx: false, agency: '', status: '', addr: '' });

/** The form's lists, from this page's rows, for the applied dates (filterform.js tableLists). */
const formLists = tableLists(query, () => state);

/** The link of this page and of the way back: same place, same filters, never an address. */
function writeLinks() {
  const p = filtersToParams(geo, geoId, state, defaults);
  history.replaceState(null, '', `?${p.toString()}`);
  $('back-link').href = `district.html?${p.toString()}`;
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

let seq = 0;
async function redraw() {
  const mine = ++seq;
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
    [{ n: total }] = await query(`SELECT count(*)::INTEGER AS n FROM req WHERE ${where}`);
    const shown = await loadRequestPoints(mapCtx, 'req', where);
    if (mine !== seq) return;
    $('map-note').textContent = mapNoteText(total, shown.count);
    setStatus($('status'), state.start > state.end ? DATE_ORDER_MSG : `${fmtInt(total)} requests match.`);
    lastFailed = false;
    // The panel closes after Apply at every width here, focus on its toggle (filterform.js).
    form.afterRedraw();
  } catch (err) {
    console.error(err);
    lastFailed = true;
    if (!(err instanceof DataChangedError)) freshDataFiles(err).catch((e) => console.error(e));
    setStatus($('status'), err.boardstatLoad || err instanceof DataChangedError ? loadFailedText(err)
      : 'Something went wrong while updating the map. Press Apply filters to try again, or reload the page.');
  }
}
async function main() {
  try {
    manifest = await loadManifest();
  } catch (err) {
    $('title').textContent = 'Data not available';
    $('status').textContent = String(err.message || err);
    return;
  }
  district = resolvePlace(manifest, geo, geoId);
  if (!district) {
    $('title').textContent = IS_BORO ? 'Borough not found' : 'District not found';
    $('status').replaceChildren(`No data for this ${IS_BORO ? 'borough' : 'district'}. `, el('a', { href: './', text: 'Choose another place.' }));
    $('back-link').href = './';
    $('back-link').textContent = '← Choose a district or borough';
    $('filters').hidden = true;
    $('filters-toggle').hidden = true;
    return;
  }
  if (IS_BORO) $('back-link').textContent = '← Back to the borough page';
  defaults = { start: manifest.window.default_start || manifest.window.start, end: manifest.window.end };
  // A link never carries an address (filtersToParams), and this page ignores one if it does.
  state = { ...filtersFromParams(params, defaults), addr: '' };

  document.title = `Map · ${district.label} · BoardStat 2.0 (prototype)`;
  $('title').textContent = `Map of requests: ${district.label}`;
  renderDataStatus(manifest, $('as-of'), $('stale'));
  renderMapLegend($('map-legend'), { headingLevel: 2, borough: IS_BORO });

  form = createFilterForm({
    defaults: defaultFilters,
    lists: formLists,
    onApply: (s) => { state = s; redraw(); },
    lastFailed: () => lastFailed,
    matchText: () => `${fmtInt(total)} requests match.`,
    setStatus: (msg) => setStatus($('status'), msg),
  });
  form.set(state);
  form.bind(manifest.window.start, manifest.window.end);
  form.openGroups({ compact: true });
  // Closed at every width, with the summary line above it (filterform.js setupPanel).
  form.setupPanel({ mapPage: true, scrollTo: $('main') });
  writeLinks();

  setStatus($('status'), IS_BORO ? 'Loading the map and the borough\'s requests…' : 'Loading the map and this district\'s requests…');
  // One file for a district; every district file of a borough (place.js).
  const names = sourceNames(district);
  dataFiles = names.map((n, i) => [n, `data/${district.files[i]}`]);
  try {
    [mapCtx] = await Promise.all([
      setupRequestMap('map', { geo, geoId }),
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
