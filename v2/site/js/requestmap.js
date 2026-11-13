// The map of 311 requests: district lines, requests grouped into circles, a popup for
// each request, and the legend. Shared by the district page's map and the full-page
// map (map.html, #143), so both draw the same thing from the same query.
import { dataUrl, query, el, fmtInt } from './lib.js';
import { makeMap, addBoundaries, featureBounds } from './map.js';
import { boroughBySlug } from './place.js';

/** At most this many requests go on the map, the most recent first. */
export const MAP_CAP = 60000;

const BLUE = '#2359a8';
const POINT_RADIUS = 5;
const DARK = '#414141';
// Circle colors and sizes by how many requests a circle holds; the legend lists the same steps.
const CLUSTER_STEPS = [
  { min: 2, color: '#B8D6FF', radius: 10, label: 'A group of 2 to 99 nearby requests' },
  { min: 100, color: '#6f9bd6', radius: 16, label: 'A group of 100 to 999' },
  { min: 1000, color: BLUE, radius: 24, label: 'A group of 1,000 or more' },
];

/**
 * The boundary file and the shapes to highlight for a place: one district, or for a
 * borough (geo=boro, #144) every community district shape whose number starts with the
 * borough's digit (Joint Interest Areas included), drawn on the community district lines.
 */
export function placeShapes(geo, geoId, features) {
  if (geo === 'boro') {
    const b = boroughBySlug(geoId);
    const sel = b ? features.filter((f) => Math.floor(Number(f.properties.id) / 100) === b.code) : [];
    return { selected: sel, selectedId: sel.map((f) => f.properties.id) };
  }
  const f = features.find((x) => String(x.properties.id) === String(geoId));
  return { selected: f ? [f] : [], selectedId: Number(geoId) };
}

/** The boundary file a place's map draws: council lines for a council district, community district lines otherwise. */
export const boundaryFile = (geo) => (geo === 'cc' ? 'cc' : 'cd');

/**
 * Make the map in `container` for one district or borough: its lines, an empty request
 * layer, click to zoom into a circle, click a single request for its popup.
 * Returns { ml, map }.
 */
export async function setupRequestMap(container, { geo, geoId }) {
  const gj = await (await fetch(dataUrl(`data/boundaries/${boundaryFile(geo)}.geojson`))).json();
  const { selected, selectedId } = placeShapes(geo, geoId, gj.features);
  const ctx = await makeMap(container, selected.length ? { bounds: featureBounds(selected) } : {});
  const { map, ml } = ctx;
  addBoundaries(map, gj, { selectedId });
  // Clustering per https://maplibre.org/maplibre-gl-js/docs/examples/create-and-style-clusters/
  map.addSource('req', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, cluster: true, clusterMaxZoom: 15, clusterRadius: 40 });
  const [s0, s1, s2] = CLUSTER_STEPS;
  map.addLayer({
    id: 'clusters', type: 'circle', source: 'req', filter: ['has', 'point_count'],
    paint: {
      'circle-color': ['step', ['get', 'point_count'], s0.color, s1.min, s1.color, s2.min, s2.color],
      'circle-radius': ['step', ['get', 'point_count'], s0.radius, s1.min, s1.radius, s2.min, s2.radius],
      'circle-stroke-width': 1, 'circle-stroke-color': DARK, 'circle-opacity': 0.85,
    },
  });
  map.addLayer({
    id: 'point', type: 'circle', source: 'req', filter: ['!', ['has', 'point_count']],
    paint: { 'circle-color': BLUE, 'circle-radius': POINT_RADIUS, 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' },
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
  return ctx;
}

/**
 * Put the requests matching `where` (SQL, see filtersql.js) from `from` (a table or a
 * quoted file name) on the map: the MAP_CAP most recent with a location.
 * Returns { count, first }: how many are shown, and the newest one's [lng, lat].
 */
export async function loadRequestPoints(ctx, from, where) {
  const rows = await query(`
    SELECT longitude AS x, latitude AS y, complaint_type AS t, descriptor AS d, status AS s,
           strftime(created_date, '%Y-%m-%d') AS created,
           coalesce(incident_address, intersection_street_1 || ' & ' || intersection_street_2) AS addr
    FROM ${from} WHERE ${where} AND latitude IS NOT NULL ORDER BY created_date DESC LIMIT ${MAP_CAP}`);
  ctx.map.getSource('req').setData({
    type: 'FeatureCollection',
    features: rows.map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.x, r.y] }, properties: { t: r.t, d: r.d, s: r.s, created: r.created, addr: r.addr } })),
  });
  return { count: rows.length, first: rows.length ? [rows[0].x, rows[0].y] : null };
}

/** The line under the map: how many requests it shows out of how many match, and how to use it. */
export function mapNoteText(total, shown) {
  return (total > MAP_CAP ? `Showing the ${fmtInt(MAP_CAP)} most recent of ${fmtInt(total)} matching requests. ` : `Showing all ${fmtInt(shown)} matching requests. `) +
    'Circles group nearby requests; select one to zoom in, or select a single point for details.';
}

/** Fill `box` with the map's legend: circle sizes, a single request, and the district lines.
 *  The key is drawn at the map's own sizes (diameter = 2 × circle-radius). `headingLevel`
 *  fits the page's outline: 3 under the district page's h2, 2 on the full-page map.
 *  `borough` labels the highlighted lines as a borough's districts (#144). */
export function renderMapLegend(box, { headingLevel = 3, borough = false } = {}) {
  if (!box) return;
  const swatch = (cls, style) => el('span', { class: `swatch ${cls}`, 'aria-hidden': 'true', style });
  const items = [
    ...CLUSTER_STEPS.map((s) => [swatch('circle', `background:${s.color};width:${2 * s.radius}px;height:${2 * s.radius}px`), s.label]),
    [swatch('circle', `background:${BLUE};width:${2 * POINT_RADIUS}px;height:${2 * POINT_RADIUS}px`), 'One request'],
    [swatch('line selected', ''), borough ? 'Districts in this borough' : 'This district'],
    [swatch('line', ''), 'Other districts'],
  ];
  box.replaceChildren(
    el(`h${headingLevel}`, { class: 'legend-title', text: 'Map key' }),
    el('ul', {}, items.map(([sw, text]) => el('li', {}, sw, el('span', { text })))),
  );
}
