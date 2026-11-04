// MapLibre helpers. No third-party basemap: district boundaries are the base layer.
// v6 ships as ES modules only; the worker is found from the module URL
// (https://maplibre.org/maplibre-gl-js/docs/).
import { MAPLIBRE_URL } from './lib.js';

let mlPromise = null;
export function loadMapLibre() {
  if (!mlPromise) mlPromise = import(MAPLIBRE_URL);
  return mlPromise;
}

const NYC_BOUNDS = [[-74.26, 40.49], [-73.69, 40.92]];

// A style with only a background layer. A style needs version, sources and
// layers (https://maplibre.org/maplibre-style-spec/root/). We add no symbol
// layers, so no glyphs (font) server is needed.
const BLANK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#F9FAFF' } }],
};

export async function makeMap(container, { bounds = NYC_BOUNDS } = {}) {
  const ml = await loadMapLibre();
  const map = new ml.Map({
    container,
    style: BLANK_STYLE,
    bounds,
    fitBoundsOptions: { padding: 20 },
    attributionControl: { compact: true, customAttribution: 'Boundaries: NYC Department of City Planning' },
  });
  map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
  await new Promise((resolve) => map.on('load', resolve));
  return { ml, map };
}

/** Add district polygons (fill + outline). selectedId is highlighted. */
export function addBoundaries(map, geojson, { selectedId = null, id = 'districts' } = {}) {
  map.addSource(id, { type: 'geojson', data: geojson, promoteId: 'id' });
  map.addLayer({
    id: `${id}-fill`, type: 'fill', source: id,
    paint: {
      'fill-color': ['case', ['==', ['get', 'id'], selectedId ?? -1], '#B8D6FF', ['boolean', ['feature-state', 'hover'], false], '#EEF4FF', '#FFFFFF'],
      'fill-opacity': 0.9,
    },
  });
  map.addLayer({
    id: `${id}-line`, type: 'line', source: id,
    paint: {
      'line-color': ['case', ['==', ['get', 'id'], selectedId ?? -1], '#2359a8', '#949494'],
      'line-width': ['case', ['==', ['get', 'id'], selectedId ?? -1], 2.5, 1],
    },
  });
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
