// Full-page map (#143): the district page's map of requests, as big as the window.
// It reads the same link parameters as the district page (filterstate.js), runs the same
// WHERE clause (filtersql.js) and draws the same map (requestmap.js), so it shows the
// same requests. It has no filter form of its own: the "Back to the district page"
// link opens the district page with the same filters, where they can be changed.
import { loadManifest, renderDataStatus, registerData, query, el, setStatus, fmtDate } from './lib.js';
import { filtersFromParams, filtersToParams, describeFilters, keepKnownStatus } from './filterstate.js';
import { whereSql } from './filtersql.js';
import { setupRequestMap, loadRequestPoints, mapNoteText, renderMapLegend } from './requestmap.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const geo = params.get('geo') === 'cc' ? 'cc' : 'cd';
const geoId = params.get('id');

async function main() {
  let manifest;
  try {
    manifest = await loadManifest();
  } catch (err) {
    $('title').textContent = 'Data not available';
    $('status').textContent = String(err.message || err);
    return;
  }
  const district = manifest.districts[geo]?.find((d) => String(d.id) === String(geoId));
  if (!district || !district.file) {
    $('title').textContent = 'District not found';
    $('status').replaceChildren('No data for this district. ', el('a', { href: './', text: 'Choose another district.' }));
    $('back-link').href = './';
    $('back-link').textContent = '← Choose a district';
    return;
  }
  const defaults = { start: manifest.window.default_start || manifest.window.start, end: manifest.window.end };
  // A link never carries an address (filtersToParams), and this page ignores one if it does.
  let state = { ...filtersFromParams(params, defaults), addr: '' };
  const setBackLink = () => { $('back-link').href = `district.html?${filtersToParams(geo, geoId, state, defaults).toString()}`; };
  setBackLink();

  document.title = `Map · ${district.label} · BoardStat 2.0 (prototype)`;
  $('title').textContent = `Map of requests: ${district.label}`;
  const showSummary = () => { $('filters-summary').textContent = `${describeFilters(state, fmtDate).join('; ')}.`; };
  showSummary();
  renderDataStatus(manifest, $('as-of'), $('stale'));
  renderMapLegend($('map-legend'), { headingLevel: 2 });

  setStatus($('status'), 'Loading the map and this district\'s requests…');
  let mapCtx;
  try {
    [mapCtx] = await Promise.all([
      setupRequestMap('map', { geo, geoId }),
      registerData('d.parquet', `data/${district.file}`),
    ]);
  } catch (err) {
    console.error(err);
    $('map').replaceChildren(el('p', { text: `The map could not load (${err.message}). The district page has the same information in tables.` }));
    setStatus($('status'), '');
    return;
  }
  try {
    // Straight from the district's file: every request matching the filters is in it,
    // the same rows the district page's table holds for these dates.
    // Drop a status this district's data does not have, as the district page does
    // (keepKnownStatus), so both pages show the same requests for the same link.
    const known = (await query(`SELECT DISTINCT status FROM 'd.parquet' WHERE status IS NOT NULL`)).map((r) => r.status);
    state = keepKnownStatus(state, known);
    setBackLink();
    showSummary();
    const where = whereSql(state);
    const [{ n }] = await query(`SELECT count(*)::INTEGER AS n FROM 'd.parquet' WHERE ${where}`);
    const shown = await loadRequestPoints(mapCtx, `'d.parquet'`, where);
    $('map-note').textContent = mapNoteText(n, shown.count);
    setStatus($('status'), state.start > state.end
      ? 'The From date is after the To date, so no requests match. Go back to the district page to change the dates.'
      : '');
  } catch (err) {
    console.error(err);
    setStatus($('status'), `Something went wrong: ${err.message}`);
  }
}

main();
