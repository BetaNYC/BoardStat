// Landing page: choose a district kind, then a district (list, map, or address).
import { loadManifest, renderDataStatus, registerData, query, lit, el, setStatus, fmtInt, districtLabel } from './lib.js';
import { makeMap, addBoundaries } from './map.js';

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
const districtUrl = (geo, id) => `district.html?geo=${geo}&id=${encodeURIComponent(id)}`;

function fillSelect(geo) {
  const list = manifest.districts[geo].filter((d) => d.rows > 0);
  select.replaceChildren();
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
  ccNote.hidden = geo !== 'cc';
}

async function showMap(geo) {
  if (!geojson[geo]) geojson[geo] = await (await fetch(`data/boundaries/${geo}.geojson`)).json();
  if (!mapCtx) mapCtx = await makeMap('map');
  const { map } = mapCtx;
  for (const id of ['districts-fill', 'districts-line']) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource('districts')) map.removeSource('districts');
  addBoundaries(map, geojson[geo]);
}

function wireMap() {
  const { map } = mapCtx;
  let hovered = null;
  map.on('mousemove', 'districts-fill', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const f = e.features[0];
    if (hovered !== null) map.setFeatureState({ source: 'districts', id: hovered }, { hover: false });
    hovered = f.id;
    map.setFeatureState({ source: 'districts', id: hovered }, { hover: true });
    map.getCanvas().title = f.properties.label;
  });
  map.on('mouseleave', 'districts-fill', () => {
    map.getCanvas().style.cursor = '';
    if (hovered !== null) map.setFeatureState({ source: 'districts', id: hovered }, { hover: false });
    hovered = null;
  });
  map.on('click', 'districts-fill', (e) => {
    const id = e.features[0].properties.id;
    window.location.href = districtUrl(currentGeo(), id);
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
  if (q.length < 4) { setStatus(addrStatus, q ? 'Type at least 4 characters.' : ''); return; }
  setStatus(addrStatus, 'Searching addresses in 311 data…');
  addrReady ||= registerData('addresses.parquet', 'data/addresses.parquet');
  await addrReady;
  // The file is sorted by address, so a prefix range lets DuckDB skip row groups.
  const rows = await query(`
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
      el('a', { class: 'addr-main', href: `address.html?geo=cd&id=${encodeURIComponent(r.cd)}&addr=${encodeURIComponent(r.address)}` },
        `${r.address}${r.zip ? ` (${r.zip})` : ''}`), ` · ${fmtInt(r.n)} requests · in `,
      el('a', { href: districtUrl('cd', r.cd) + `&addr=${encodeURIComponent(r.address)}` }, districtLabel(manifest, 'cd', r.cd) || `CD ${r.cd}`),
      ' · ',
      el('a', { href: districtUrl('cc', r.cc) + `&addr=${encodeURIComponent(r.address)}` }, districtLabel(manifest, 'cc', r.cc) || `Council District ${r.cc}`),
    ));
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
  const v = manifest.sources?.council_districts?.version;
  if (v) document.querySelectorAll('.bver').forEach((n) => { n.textContent = v; });

  fillSelect(currentGeo());
  form.addEventListener('change', async (e) => {
    if (e.target.name === 'geo') {
      fillSelect(currentGeo());
      await showMap(currentGeo());
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (select.value) window.location.href = districtUrl(currentGeo(), select.value);
  });
  addrInput.addEventListener('input', () => {
    clearTimeout(addrTimer);
    addrTimer = setTimeout(() => searchAddress().catch((err) => setStatus(addrStatus, `Address search failed: ${err.message}`)), 300);
  });

  try {
    await showMap(currentGeo());
    wireMap();
  } catch (err) {
    document.getElementById('map').replaceChildren(el('p', { text: `The map could not load (${err.message}). Use the list above.` }));
  }
}

main();
