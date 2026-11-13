// MapLibre helpers. The street map is a self-hosted Protomaps extract of NYC
// (OpenStreetMap data), built by pipeline/basemap_build.sh into data/basemap/.
// Only open-source software and open data; no street map is fetched from any
// other service (#141). If it cannot load, the map shows boundaries on a blank
// background with a visible message saying so.
// v6 ships as ES modules only; the worker is found from the module URL
// (https://maplibre.org/maplibre-gl-js/docs/).
import { MAPLIBRE_URL, PMTILES_URL, BASEMAPS_URL } from './lib.js';

let mlPromise = null;
export function loadMapLibre() {
  if (!mlPromise) mlPromise = import(MAPLIBRE_URL);
  return mlPromise;
}

const NYC_BOUNDS = [[-74.26, 40.49], [-73.69, 40.92]];
const FLAVOR = 'grayscale'; // quiet streets, so district colors and request dots stand out
const OSM_ATTRIBUTION = '<a href="https://protomaps.com">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// A style with only a background layer. A style needs version, sources and
// layers (https://maplibre.org/maplibre-style-spec/root/).
const BLANK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#F9FAFF' } }],
};

// Shown on the map when the street map cannot load, so a missing street map is
// never mistaken for a blank part of the city.
const BASEMAP_FAILED = 'The street map could not load. The rest of the map still works.';
const BASEMAP_TIMEOUT_MS = 5000;

/** Reject after ms, so a hung request or import can never stall the map. */
function withTimeout(promise, ms = BASEMAP_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** GET a URL with a timeout; throw unless the status is one of `ok`. */
async function mustFetch(url, ok = [200], headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(BASEMAP_TIMEOUT_MS) });
  if (!ok.includes(r.status)) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

/** Check every self-hosted basemap file the style needs before using it:
 *  basemap.json, the PMTiles header (magic "PMTiles", version 3, per
 *  https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md), the sprite,
 *  and one glyph range. Throws on any failure. */
async function checkBasemapFiles(base) {
  await mustFetch(base + 'basemap.json');
  const r = await mustFetch(base + 'nyc.pmtiles', [200, 206], { Range: 'bytes=0-7' });
  const head = new Uint8Array(await r.arrayBuffer()).slice(0, 8);
  if (new TextDecoder().decode(head.slice(0, 7)) !== 'PMTiles' || head[7] !== 3) throw new Error('nyc.pmtiles: not PMTiles v3');
  await mustFetch(base + 'sprites/' + FLAVOR + '.json');
  await mustFetch(base + 'fonts/Noto%20Sans%20Regular/0-255.pbf');
}

let protocolAdded = false;
/** Protomaps style per https://docs.protomaps.com/basemaps/maplibre, all assets self-hosted.
 *  Returns { style, failed }: on any failure or timeout, a blank style and failed = true. */
async function basemapStyle(ml) {
  try {
    const base = new URL('data/basemap/', location.href).href;
    const [, [{ Protocol }, basemaps]] = await Promise.all([
      checkBasemapFiles(base),
      withTimeout(Promise.all([import(PMTILES_URL), import(BASEMAPS_URL)])),
    ]);
    if (!protocolAdded) { // add once per page (https://docs.protomaps.com/pmtiles/maplibre)
      ml.addProtocol('pmtiles', new Protocol().tile);
      protocolAdded = true;
    }
    return {
      failed: false,
      base,
      style: {
        version: 8,
        glyphs: base + 'fonts/{fontstack}/{range}.pbf',
        sprite: base + 'sprites/' + FLAVOR,
        sources: {
          protomaps: { type: 'vector', url: 'pmtiles://' + base + 'nyc.pmtiles', attribution: OSM_ATTRIBUTION },
        },
        layers: basemaps.layers('protomaps', basemaps.namedFlavor(FLAVOR), { lang: 'en' }),
      },
    };
  } catch {
    return { style: BLANK_STYLE, failed: true };
  }
}

/** True if a map 'error' event came from the street map. MapLibre's ErrorEvent
 *  carries `error` plus extra data (src/util/evented.ts); `sourceId` and the
 *  failed request's `url` are not in the API docs, so both are checked, and
 *  checkBasemapFiles() above is the guard that does not depend on them. */
function isBasemapError(e, base) {
  if (e?.sourceId === 'protomaps') return true;
  const url = String(e?.error?.url ?? '');
  const msg = String(e?.error?.message ?? '');
  return (url && url.startsWith(base)) || msg.includes(base) || msg.includes('nyc.pmtiles');
}

/** Put a short, visible message on the map, once. */
function showBasemapError(container) {
  const box = typeof container === 'string' ? document.getElementById(container) : container;
  if (!box || box.querySelector('.map-error')) return;
  const p = document.createElement('p');
  p.className = 'map-error';
  p.setAttribute('role', 'status');
  p.textContent = BASEMAP_FAILED;
  box.append(p);
}

export async function makeMap(container, { bounds = NYC_BOUNDS } = {}) {
  const ml = await loadMapLibre();
  const { style, failed, base } = await basemapStyle(ml);
  const map = new ml.Map({
    container,
    style,
    bounds,
    fitBoundsOptions: { padding: 20 },
    // compact: false keeps the credits expanded at every width; OSMF asks that the
    // OpenStreetMap credit be visible without a click
    // (https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/AttributionControlOptions/).
    attributionControl: { compact: false, customAttribution: 'Boundaries: NYC Department of City Planning' },
  });
  if (!failed) map.on('error', (e) => { if (isBasemapError(e, base)) showBasemapError(container); });
  map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
  await new Promise((resolve) => map.on('load', resolve));
  if (failed) showBasemapError(container);
  return { ml, map };
}

/** First label layer, so district shapes sit under street and place names. */
function firstSymbolLayer(map) {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}

/** Add district polygons (fill + outline). selectedId is highlighted. */
export function addBoundaries(map, geojson, { selectedId = null, id = 'districts' } = {}) {
  const sel = ['==', ['get', 'id'], selectedId ?? -1];
  const before = firstSymbolLayer(map);
  map.addSource(id, { type: 'geojson', data: geojson, promoteId: 'id' });
  map.addLayer({
    id: `${id}-fill`, type: 'fill', source: id,
    paint: {
      'fill-color': ['case', sel, '#B8D6FF', '#2359a8'],
      // Light tints only, so the streets underneath stay readable.
      'fill-opacity': ['case', sel, 0.35, ['boolean', ['feature-state', 'hover'], false], 0.15, 0.02],
    },
  }, before);
  map.addLayer({
    id: `${id}-line`, type: 'line', source: id,
    paint: {
      'line-color': ['case', sel, '#2359a8', '#6b6b6b'],
      'line-width': ['case', sel, 3, 1.2],
    },
  }, before);
}

/** Bounding box of one feature's (Multi)Polygon coordinates. */
export function featureBounds(feature) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
    } else c.forEach(walk);
  };
  walk(feature.geometry.coordinates);
  return [[minX, minY], [maxX, maxY]];
}
