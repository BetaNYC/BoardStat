// Landing page: Step 1 picks what to look at (community district, council district, a whole
// borough, or an address); Step 2 shows the matching chooser. An address opens address.html directly.
import { loadManifest, renderDataStatus, renderChanges, dataUrl, registerData, query, lit, el, setStatus, fmtInt, districtLabel } from './lib.js';
import { makeMap, addBoundaries } from './map.js';
import { BOROUGHS, boroughParts, boroughOfCd, boroughUrl } from './place.js';

const form = document.getElementById('chooser');
const select = document.getElementById('district-select');
const ccNote = document.getElementById('cc-note');
const addrInput = document.getElementById('addr');
const addrStatus = document.getElementById('addr-status');
const addrResults = document.getElementById('addr-results');

let manifest;
const geojson = {};
let mapCtx = null;

const currentGeo = () => form.querySelector('input[name="geo"]:checked').value;
const districtUrl = (geo, id) => (geo === 'boro' ? boroughUrl(id) : `district.html?geo=${geo}&id=${encodeURIComponent(id)}`);
// A borough is chosen on the community district map (#144): every shape is a district, and
// selecting one opens its borough.
const boundaryKind = (geo) => (geo === 'cc' ? 'cc' : 'cd');
const addressUrl = (r) => `address.html?geo=cd&id=${encodeURIComponent(r.cd)}&addr=${encodeURIComponent(r.address)}`;
const titleCase = (s) => (s ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '');
let lastResults = [];

/** Show the Step 2 that matches Step 1: a district list and map, or the address box. */
async function applyMode() {
  const geo = currentGeo();
  const isAddr = geo === 'addr';
  document.getElementById('step-district').hidden = isAddr;
  document.getElementById('step-addr').hidden = !isAddr;
  document.getElementById('map-panel').hidden = isAddr;
  ccNote.hidden = geo !== 'cc';
  document.getElementById('boro-note').hidden = geo !== 'boro';
  history.replaceState(null, '', isAddr ? '#addr' : location.pathname + location.search);
  if (isAddr) { addrInput.focus(); return; }
  const isBoro = geo === 'boro';
  document.getElementById('district-legend').textContent = isBoro ? 'Step 2: Pick a borough' : `Step 2: Pick your ${geo === 'cc' ? 'council' : 'community'} district`;
  document.querySelector('label[for="district-select"]').textContent = isBoro ? 'Borough' : 'District';
  document.getElementById('show-btn').textContent = isBoro ? 'Show this borough' : 'Show this district';
  document.getElementById('map-hint').textContent = isBoro ? 'Or select any district in the borough on the map below.' : 'Or select a district on the map below.';
  fillSelect(geo);
  try { await showMap(geo); } catch (err) {
    document.getElementById('map').replaceChildren(el('p', { text: `The map could not load (${err.message}). Use the list above.` }));
  }
}

function fillSelect(geo) {
  select.replaceChildren();
  if (geo === 'boro') {
    for (const b of BOROUGHS) {
      if (boroughParts(manifest, b.slug).length) select.append(el('option', { value: b.slug, text: b.name }));
    }
    return;
  }
  const list = manifest.districts[geo].filter((d) => d.rows > 0);
  if (geo === 'cd') {
    for (const boro of manifest.boroughs) {
      const group = el('optgroup', { label: boro });
      for (const d of list.filter((x) => x.borough === boro)) {
        group.append(el('option', { value: d.id, text: d.jia ? `${d.label} (park or other area outside every district)` : d.label }));
      }
      select.append(group);
    }
  } else {
    for (const d of list) select.append(el('option', { value: d.id, text: d.label + (d.borough ? ` (mostly ${d.borough})` : '') }));
  }
}

async function showMap(mode) {
  const geo = boundaryKind(mode);
  if (!geojson[geo]) geojson[geo] = await (await fetch(dataUrl(`data/boundaries/${geo}.geojson`))).json();
  const first = !mapCtx;
  if (first) mapCtx = await makeMap('map');
  const { map } = mapCtx;
  map.resize(); // the map may have been hidden while the address box was showing
  for (const id of ['districts-fill', 'districts-line']) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource('districts')) map.removeSource('districts');
  addBoundaries(map, geojson[geo]);
  if (first) wireMap();
}

function wireMap() {
  const { map } = mapCtx;
  // In borough mode, hovering any district lights up its whole borough.
  let hovered = [];
  const setHover = (ids, on) => ids.forEach((id) => map.setFeatureState({ source: 'districts', id }, { hover: on }));
  const sameBorough = (id) => {
    const b = boroughOfCd(id);
    return geojson.cd.features.map((f) => f.properties.id).filter((x) => boroughOfCd(x) === b);
  };
  map.on('mousemove', 'districts-fill', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const f = e.features[0];
    const boro = currentGeo() === 'boro';
    setHover(hovered, false);
    hovered = boro ? sameBorough(f.properties.id) : [f.id];
    setHover(hovered, true);
    map.getCanvas().title = boro ? boroughOfCd(f.properties.id)?.name || '' : f.properties.label;
  });
  map.on('mouseleave', 'districts-fill', () => {
    map.getCanvas().style.cursor = '';
    setHover(hovered, false);
    hovered = [];
  });
  map.on('click', 'districts-fill', (e) => {
    const id = e.features[0].properties.id;
    const geo = currentGeo();
    if (geo === 'boro') { const b = boroughOfCd(id); if (b) window.location.href = boroughUrl(b.slug); return; }
    window.location.href = districtUrl(geo, id);
  });
}

// ------------------------------------------------------------- address lookup

let addrReady = null;
let addrTimer = null;
// Common street-type abbreviations, expanded only as the last word ("ST MARKS PLACE" keeps ST).
const SUFFIXES = {
  AVE: 'AVENUE', AV: 'AVENUE', ST: 'STREET', STR: 'STREET', RD: 'ROAD', BLVD: 'BOULEVARD', PL: 'PLACE',
  DR: 'DRIVE', PKWY: 'PARKWAY', LN: 'LANE', CT: 'COURT', TER: 'TERRACE', TERR: 'TERRACE', HWY: 'HIGHWAY',
  EXPY: 'EXPRESSWAY', SQ: 'SQUARE', PLZ: 'PLAZA', CIR: 'CIRCLE', TPKE: 'TURNPIKE', BLV: 'BOULEVARD',
};
const DIRECTIONS = { E: 'EAST', W: 'WEST', N: 'NORTH', S: 'SOUTH' };

/**
 * Turn what people type into the city's spelling: "114 Nassau Ave, Brooklyn, NY 11222"
 * becomes { street: "114 NASSAU AVENUE", zip: "11222" }. Ordinals lose their ending
 * (5th → 5), and E/W/N/S right after the house number are spelled out.
 */
function normalizeAddress(s) {
  let t = s.toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const zip = (t.match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || null;
  t = t.split(',')[0].trim();
  if (zip) t = t.replace(new RegExp(`\\s*${zip}(?:-\\d{4})?$`), '').trim();
  const words = t.split(' ').filter(Boolean).map((w) => w.replace(/^(\d+)(ST|ND|RD|TH)$/, '$1'));
  if (words.length > 2 && /^\d/.test(words[0]) && DIRECTIONS[words[1]]) words[1] = DIRECTIONS[words[1]];
  // Only a finished word is expanded (one followed by a space or ending a comma-cut address),
  // so typing "114 NASSAU AV" still prefix-matches while the user is mid-word.
  const finished = s.includes(',') || /\s$/.test(s) || zip;
  const last = words.length - 1;
  if (last > 0 && finished && SUFFIXES[words[last]]) words[last] = SUFFIXES[words[last]];
  else if (last > 0 && SUFFIXES[words[last]] && words[last].length > 2) words[last] = SUFFIXES[words[last]];
  return { street: words.join(' '), zip };
}

async function searchAddress() {
  const { street: q, zip } = normalizeAddress(addrInput.value);
  addrResults.replaceChildren();
  lastResults = [];
  if (q.length < 4) { setStatus(addrStatus, q ? 'Type at least 4 characters.' : ''); return; }
  setStatus(addrStatus, 'Searching addresses in 311 data…');
  addrReady ||= registerData('addresses.parquet', 'data/addresses.parquet');
  await addrReady;
  // The file is sorted by address, so a prefix range lets DuckDB skip row groups.
  const rows = lastResults = await query(`
    SELECT address, zip, cd, cc, borough, n FROM 'addresses.parquet'
    WHERE address >= ${lit(q)} AND address < ${lit(q + '￿')}${zip ? ` AND zip = ${lit(zip)}` : ''}
    ORDER BY n DESC LIMIT 15`);
  if (!rows.length) {
    setStatus(addrStatus, `No 311 request in this data uses an address starting with “${q}”. Try the city's spelling (for example 5 AVENUE, WEST 4 STREET) or pick from the list.`);
    return;
  }
  setStatus(addrStatus, `${rows.length} matching address${rows.length === 1 ? '' : 'es'} found.`);
  for (const r of rows) {
    addrResults.append(el('li', {},
      el('a', { class: 'addr-main', href: addressUrl(r) }, `${r.address}${r.zip ? ` (${r.zip})` : ''}`),
      el('span', { class: 'muted', text: ` · ${titleCase(r.borough)} · ${fmtInt(r.n)} requests` })));
  }
}

// ------------------------------------------------------------- boot

async function main() {
  try {
    manifest = await loadManifest();
  } catch (err) {
    document.getElementById('as-of').textContent = String(err.message || err);
    return;
  }
  renderDataStatus(manifest, document.getElementById('as-of'), document.getElementById('stale'));
  renderChanges(document.getElementById('changes'));
  const v = manifest.sources?.council_districts?.version;
  if (v) document.querySelectorAll('.bver').forEach((n) => { n.textContent = v; });

  if (location.hash === '#addr') form.querySelector('input[value="addr"]').checked = true;
  form.addEventListener('change', (e) => { if (e.target.name === 'geo') applyMode(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (currentGeo() === 'addr') { if (lastResults.length) window.location.href = addressUrl(lastResults[0]); return; }
    if (select.value) window.location.href = districtUrl(currentGeo(), select.value);
  });
  addrInput.addEventListener('input', () => {
    clearTimeout(addrTimer);
    addrTimer = setTimeout(() => searchAddress().catch((err) => setStatus(addrStatus, `Address search failed: ${err.message}`)), 300);
  });
  addrInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (lastResults.length) window.location.href = addressUrl(lastResults[0]); }
  });

  await applyMode();
}

main();
