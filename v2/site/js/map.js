// MapLibre helpers. Street basemap: a self-hosted Protomaps extract of NYC
// (OpenStreetMap data), built by pipeline/basemap_build.sh into data/basemap/.
// If that folder is missing, the map falls back to boundaries on a blank background.
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

let protocolAdded = false;
/** Protomaps style per https://docs.protomaps.com/basemaps/maplibre, all assets self-hosted. */
async function basemapStyle(ml) {
  const base = new URL('data/basemap/', location.href).href;
  const head = await fetch(base + 'basemap.json', { method: 'HEAD' }).catch(() => null);
  if (!head || !head.ok) return BLANK_STYLE;
  const [{ Protocol }, basemaps] = await Promise.all([import(PMTILES_URL), import(BASEMAPS_URL)]);
  if (!protocolAdded) { // add once per page (https://docs.protomaps.com/pmtiles/maplibre)
    ml.addProtocol('pmtiles', new Protocol().tile);
    protocolAdded = true;
  }
  return {
    version: 8,
    glyphs: base + 'fonts/{fontstack}/{range}.pbf',
    sprite: base + 'sprites/' + FLAVOR,
    sources: {
      protomaps: { type: 'vector', url: 'pmtiles://' + base + 'nyc.pmtiles', attribution: OSM_ATTRIBUTION },
    },
    layers: basemaps.layers('protomaps', basemaps.namedFlavor(FLAVOR), { lang: 'en' }),
  };
}

export async function makeMap(container, { bounds = NYC_BOUNDS } = {}) {
  const ml = await loadMapLibre();
  const map = new ml.Map({
    container,
    style: await basemapStyle(ml),
    bounds,
    fitBoundsOptions: { padding: 20 },
    attributionControl: { compact: true, customAttribution: 'Boundaries: NYC Department of City Planning' },
  });
  map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
  await new Promise((resolve) => map.on('load', resolve));
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
