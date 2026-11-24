// Requests piled by address on the full-page map (#193). No DOM, so v2/tests-js can test it.
//
// Zoomed out, each address is one circle, sized by its number of requests and colored by
// the agency with the most. Zoomed in, each request is a chip, piled at its address. Tilted
// (the 3D button), each chip becomes a disc standing up off the street (a fill-extrusion
// layer). The per-address counts come from DuckDB (addressSql), so every matching request
// is counted; only the drawing is capped.
//
// Ported from SLAM's site/src/lib/c311Display.js (BetaNYC/SLAM, branch
// feature/pops-style-map, commit 708b933, 2026-11-24): TILT_ON/TILT_OFF and chipView,
// metersPerPixel, the disc sizes, discSize, discRing and columnTop, which SLAM took from
// Crash Mapper (BetaNYC/crash-mapper-nyc#77). Changed for BoardStat: a pile is a count per
// agency group rather than one feature per request, so a pile over the cap keeps each
// agency's share (chipGroups); flat piles stop at FLAT_CAP and 3D columns at PILE_CAP
// (Noel's approved prototype, 2026-11-24); New York's latitude is 40.66 as there.
// MapLibre GL JS 6.16.0 style spec: fill-extrusion-base and -height are data-driven, in
// meters, on Polygons; symbol-height-offset (layout, meters) lifts a label above a column
// (https://maplibre.org/maplibre-style-spec/layers/).
import { lit } from './filtersql.js';

/** The agencies with a color of their own, in legend order; every other agency is gray. */
export const GROUP_AGENCIES = ['HPD', 'NYPD', 'DSNY', 'DEP', 'DOT', 'DOB', 'DOHMH', 'DPR'];
const GROUP_NAMES = { HPD: 'Housing', NYPD: 'Police', DSNY: 'Sanitation', DEP: 'Environmental Protection', DOT: 'Transportation', DOB: 'Buildings', DOHMH: 'Health', DPR: 'Parks' };
export const GROUP_LABELS = [...GROUP_AGENCIES.map((a) => `${GROUP_NAMES[a]} (${a})`), 'Other agencies'];
export const OTHER = GROUP_AGENCIES.length;
export const NG = GROUP_LABELS.length;
/** Chip and circle colors, by group (the Okabe-Ito set, then two more, then gray). */
export const GCOL = ['#D55E00', '#0072B2', '#009E73', '#56B4E9', '#E69F00', '#8E44AD', '#CC79A7', '#6B8E23', '#6E7F80'];
/** 3D tops start darker: the map's light brightens them back to about GCOL (SLAM discColor). */
export const DCOL = ['#A84A00', '#005A8C', '#007A5A', '#3E8DBA', '#B37C00', '#6E3589', '#A35E86', '#536E1B', '#56666A'];

/** A request's group index from its agency code. */
export const groupOf = (agency) => { const i = GROUP_AGENCIES.indexOf(agency); return i < 0 ? OTHER : i; };

/** The same rule in SQL: the group index of a row. */
export const GROUP_SQL = `CASE agency ${GROUP_AGENCIES.map((a, i) => `WHEN ${lit(a)} THEN ${i}`).join(' ')} ELSE ${OTHER} END`;

/** What a pile is called: the normalized address, else the address or intersection 311 gave. */
export const LABEL_SQL = `coalesce(address_norm, incident_address, CASE WHEN intersection_street_1 IS NOT NULL AND intersection_street_2 IS NOT NULL
  THEN intersection_street_1 || ' & ' || intersection_street_2 END, 'No address given')`;
/** Which pile a request is in: its normalized address, else its point (5 decimals, about 1 m) and label. */
export const KEY_SQL = `coalesce(address_norm, concat(round(latitude, 5), ',', round(longitude, 5), ' ', ${LABEL_SQL}))`;
/** Only requests with a location are piled. */
export const LOCATED_SQL = 'latitude IS NOT NULL AND longitude IS NOT NULL';

/** One row per address for the requests matching `where` (filtersql.js whereSql): its counts, by group. */
export function addressSql(where, table = 'req') {
  return `
    SELECT ${KEY_SQL} AS k, any_value(${LABEL_SQL}) AS label, any_value(address_norm) AS addr,
           avg(longitude) AS x, avg(latitude) AS y, count(*)::INTEGER AS n,
           count(*) FILTER (WHERE status IS DISTINCT FROM 'Closed')::INTEGER AS o,
           ${GROUP_AGENCIES.map((a, i) => `count(*) FILTER (WHERE agency = ${lit(a)})::INTEGER AS g${i}`).join(',\n           ')}
    FROM ${table} WHERE ${where} AND ${LOCATED_SQL}
    GROUP BY 1`;
}

/** addressSql rows as piles: { k, label, addr, x, y, n, o, c } with c the count per group (Other last). */
export function toPiles(rows) {
  return rows.map((r) => {
    const c = GROUP_AGENCIES.map((_, i) => r[`g${i}`] || 0);
    c.push(r.n - c.reduce((a, b) => a + b, 0));
    return { k: r.k, label: r.label, addr: r.addr || '', x: r.x, y: r.y, n: r.n, o: r.o, c };
  });
}

/** Index of the largest count (ties go to the earlier group). */
export const topGroup = (c) => c.indexOf(Math.max(...c));

// ---- drawing sizes
/** Below this zoom an address is one circle; at or above it, a pile of chips. */
export const CHIP_ZOOM = 15.5;
/** Flat piles stop here, so they don't hide the streets; 3D columns go to PILE_CAP. The label gives the full total. */
export const FLAT_CAP = 25;
export const PILE_CAP = 50;
export const STACK_STEP_PX = 2;
/** Piles of this many or more show their total. */
export const LABEL_MIN = 10;
/** Circle radius in pixels for an address with n requests. */
export const circleRadius = (n) => Math.min(26, 3 + Math.sqrt(n));

/**
 * The group of each chip in a pile, bottom first, at most `cap`: over the cap each group
 * is scaled to its share (at least one chip for any group present).
 */
// ponytail: a building with 1,000 heat complaints would otherwise need 1,000 map layers; the label carries the real total.
export function chipGroups(c, cap = PILE_CAP) {
  const t = c.reduce((x, y) => x + y, 0);
  const k = t > cap ? cap / t : 1;
  const n = c.map((v) => (v ? Math.max(1, Math.round(v * k)) : 0));
  // Rounding can go over the cap: take the extra chips from the biggest group, so a small
  // group keeps its one chip (the prototype cut the last group instead).
  for (let over = n.reduce((x, y) => x + y, 0) - cap; over > 0; over--) n[n.indexOf(Math.max(...n))]--;
  return n.flatMap((v, g) => Array(v).fill(g));
}

// ---- tilt (SLAM c311Display.js)
export const TILT_ON = 10;
export const TILT_OFF = 5;
/** '3d' or 'flat' for a pitch, given what is shown now; two numbers so a map near the line does not flicker. */
export function chipView(pitch, now = 'flat') {
  if (pitch >= TILT_ON) return '3d';
  if (pitch <= TILT_OFF) return 'flat';
  return now;
}
/** 'circles', 'flat' or '3d' for a zoom and pitch, given the view shown now. */
export function pickView(zoom, pitch, now = 'circles') {
  if (zoom < CHIP_ZOOM) return 'circles';
  return chipView(pitch, now === 'circles' ? 'flat' : now);
}

const COS_NYC = Math.cos((40.66 * Math.PI) / 180);
/** Meters per screen pixel at a zoom, in New York: MapLibre's world is 512 px wide at zoom 0. */
export const metersPerPixel = (z) => (40075016.686 * COS_NYC) / (512 * 2 ** z);
export const DISC_RADIUS_PX = 5;
export const DISC_HEIGHT_PX = 2;
export const DISC_GAP_PX = 1.5;
export const DISC_SIDES = 16;
/** Discs are sized in pixels at the zoom they are built for, so they are rebuilt when the zoom moves this much. */
export const DISC_REBUILD_ZOOM = 0.5;
const round2 = (v) => Math.round(v * 100) / 100;
/** { r, h, step } in meters for discs built at zoom z. */
export function discSize(z) {
  const m = metersPerPixel(z);
  return { r: DISC_RADIUS_PX * m, h: DISC_HEIGHT_PX * m, step: (DISC_HEIGHT_PX + DISC_GAP_PX) * m };
}
/** Height in meters of the label above a column of n discs (capped at PILE_CAP). */
export const columnTop = (n, z) => round2(Math.min(n, PILE_CAP) * discSize(z).step + 8 * metersPerPixel(z));
/** A closed ring of DISC_SIDES points, r meters around [lon, lat]. */
export function discRing(lon, lat, r) {
  const dLat = r / 111320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const ring = [];
  for (let j = 0; j < DISC_SIDES; j++) {
    const a = (2 * Math.PI * j) / DISC_SIDES;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}

// ---- GeoJSON for each view. Every feature carries `p`, its pile's index, for the popup.
const point = (x, y, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties });
const fc = (features) => ({ type: 'FeatureCollection', features });

/** One point per pile: total n, circle radius r, top group dom, label height top (3D). Biggest first, so small circles stay on top. */
export function circlesData(piles, z = 16, idx = piles.map((_, i) => i)) {
  const f = idx.map((i) => { const p = piles[i]; return point(p.x, p.y, { p: i, n: p.n, r: circleRadius(p.n), dom: topGroup(p.c), top: columnTop(p.n, z) }); });
  return fc(f.sort((a, b) => b.properties.n - a.properties.n));
}
/** One point per chip: level i (0 = bottom) and group g, at most FLAT_CAP a pile. */
export function chipsData(piles, idx = piles.map((_, i) => i)) {
  return fc(idx.flatMap((i) => chipGroups(piles[i].c, FLAT_CAP).map((g, level) => point(piles[i].x, piles[i].y, { p: i, i: level, g }))));
}
/** One disc (a polygon) per chip, up to PILE_CAP a pile, with its base b and top h in meters. */
export function discsData(piles, z, idx = piles.map((_, i) => i)) {
  const { r, h, step } = discSize(z);
  return fc(idx.flatMap((i) => {
    const ring = discRing(piles[i].x, piles[i].y, r);
    return chipGroups(piles[i].c).map((g, level) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { p: i, i: level, g, b: round2(level * step), h: round2(level * step + h) } }));
  }));
}

/** Indexes of the piles inside [[w, s], [e, n]], so a zoomed-in borough draws only the chips on screen. */
export function pilesIn(piles, [[w, s], [e, n]]) {
  const out = [];
  piles.forEach((p, i) => { if (p.x >= w && p.x <= e && p.y >= s && p.y <= n) out.push(i); });
  return out;
}

/** The index of the pile nearest [x, y] (screen pixels), from each pile's projected point, or -1. */
export function nearestPile(points, [x, y]) {
  let best = -1;
  let d = Infinity;
  points.forEach((q, i) => {
    const dd = (q[0] - x) ** 2 + (q[1] - y) ** 2;
    if (dd < d) { d = dd; best = i; }
  });
  return best;
}

/** MapLibre "match" on a group property, colored from `cols`. */
export const groupColorExpr = (key, cols) => ['match', ['get', key], ...cols.slice(0, -1).flatMap((c, i) => [i, c]), cols.at(-1)];

// ---- a pile's popup: queried when it is opened
/** The pile's requests matching `where`, by problem, most first. */
export const pileTypesSql = (where, k, table = 'req') => `
  SELECT complaint_type AS t, count(*)::INTEGER AS n FROM ${table}
  WHERE ${where} AND ${LOCATED_SQL} AND ${KEY_SQL} = ${lit(k)} GROUP BY 1 ORDER BY 2 DESC, 1`;
/** The pile's latest `limit` requests matching `where`, newest first. */
export const pileLatestSql = (where, k, limit, table = 'req') => `
  SELECT unique_key AS id, strftime(created_date, '%Y-%m-%d') AS d, strftime(created_date, '%Y-%m-%d %H:%M:%S') AS ts,
         complaint_type AS t, descriptor AS ds, status AS s, agency AS a
  FROM ${table} WHERE ${where} AND ${LOCATED_SQL} AND ${KEY_SQL} = ${lit(k)} ORDER BY created_date DESC, unique_key LIMIT ${Number(limit)}`;
/**
 * The agency's resolution text for these requests ({ id, ts } from pileLatestSql), read from
 * the data files on demand, so the in-memory table never holds it (a borough page holds
 * every district's rows). The created_date range lets DuckDB skip row groups: detail files
 * are sorted by created_date (boardstat_build.py).
 */
export function resolutionsSql(src, rows) {
  const ts = rows.map((r) => r.ts).sort();
  return `
  SELECT unique_key AS id, resolution_description AS r FROM ${src}
  WHERE created_date >= CAST(${lit(ts[0])} AS TIMESTAMP) AND created_date < CAST(${lit(ts.at(-1))} AS TIMESTAMP) + INTERVAL 1 SECOND
    AND unique_key IN (${rows.map((r) => lit(r.id)).join(', ')})`;
}
