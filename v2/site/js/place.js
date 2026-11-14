// Which place a page shows (#144): one community district (geo=cd), one council district
// (geo=cc), or a whole borough (geo=boro). Plain functions, no DOM, so Node tests can use them.
//
// A borough is the community districts whose number starts with the borough's digit,
// Joint Interest Areas included (Brooklyn: 301-318 plus 355 and 356). That is the same rule
// the pipeline uses for the borough rows of agg/month_type.parquet (cd // 100 in
// boardstat_build.py), so a borough page and the Compare panel count the same requests:
// every request BoardStat placed inside the borough's lines. A request with no usable
// location is in no district file, so it is in no borough page either. Council districts
// cross borough lines, so a borough is never built from council districts.
import { lit } from './filtersql.js';

export const BOROUGHS = [
  { slug: 'manhattan', name: 'Manhattan', code: 1 },
  { slug: 'bronx', name: 'Bronx', code: 2 },
  { slug: 'brooklyn', name: 'Brooklyn', code: 3 },
  { slug: 'queens', name: 'Queens', code: 4 },
  { slug: 'staten-island', name: 'Staten Island', code: 5 },
];

/** The borough for a link id ("brooklyn", "Staten Island", "staten-island"), or null. */
export function boroughBySlug(id) {
  const s = String(id ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return BOROUGHS.find((b) => b.slug === s) || null;
}

/** The borough a community district (or Joint Interest Area) number is in, or null. */
export function boroughOfCd(id) {
  const code = Math.floor(Number(id) / 100);
  return BOROUGHS.find((b) => b.code === code) || null;
}

/** { geo, id } from a page's link. Anything but cc or boro is a community district. */
export function parsePlace(params) {
  const g = params.get('geo');
  const geo = g === 'cc' || g === 'boro' ? g : 'cd';
  let id = params.get('id');
  if (geo === 'boro') id = boroughBySlug(id)?.slug ?? id;
  return { geo, id };
}

/** The community district entries (manifest.districts.cd) with data that make up a borough, by number. */
export function boroughParts(manifest, slug) {
  const b = boroughBySlug(slug);
  if (!b) return [];
  return (manifest.districts?.cd || [])
    .filter((d) => d.file && Math.floor(Number(d.id) / 100) === b.code)
    .sort((x, y) => Number(x.id) - Number(y.id));
}

/**
 * Everything a page needs to know about the place in its link, or null if there is no
 * data for it: { geo, id, label, borough, jia, parts, files, unlocated }.
 * `files` are the data files to read (paths under data/); `parts` the districts behind
 * them; `unlocated` how many requests with no usable location the city assigns to the
 * place's community district(s) (null for a council district).
 */
export function resolvePlace(manifest, geo, id) {
  if (geo === 'boro') {
    const b = boroughBySlug(id);
    const parts = b ? boroughParts(manifest, b.slug) : [];
    if (!parts.length) return null;
    return {
      geo, id: b.slug, label: `${b.name} (whole borough)`, borough: b.name, jia: false, parts,
      files: parts.map((d) => d.file),
      unlocated: parts.reduce((s, d) => s + (d.unlocated_city_assigned || 0), 0),
    };
  }
  const d = manifest.districts?.[geo]?.find((x) => String(x.id) === String(id));
  if (!d || !d.file) return null;
  return {
    geo, id: String(d.id), label: d.label, borough: d.borough || null, jia: Boolean(d.jia), parts: [d],
    files: [d.file], unlocated: geo === 'cd' ? (d.unlocated_city_assigned || 0) : null,
  };
}

/**
 * Names to register the place's files under in DuckDB-WASM, in the order of place.files.
 * One file keeps the name a district page always used ('d.parquet'); a borough gets one
 * name per district file ('d-301.parquet', ...).
 */
export function sourceNames(place) {
  return place.files.length === 1 ? ['d.parquet'] : place.files.map((f) => `d-${f.split('/').pop()}`);
}

/**
 * The SQL that reads the place's rows: the one file, or every file of a borough read as
 * one table with read_parquet([...]) (https://duckdb.org/docs/stable/data/multiple_files/overview).
 * All district files have the same columns, so no union_by_name is needed.
 */
export function sourceSql(names) {
  return names.length === 1 ? lit(names[0]) : `read_parquet([${names.map(lit).join(', ')}])`;
}

/** Link to a borough's page. */
export const boroughUrl = (slug) => `district.html?geo=boro&id=${encodeURIComponent(slug)}`;

/**
 * The columns a borough page's charts and tables read (#151): what a borough slim file
 * (boardstat_build.py BOROUGH_SLIM_COLUMNS) must have for the page to draw from it.
 */
export const SLIM_COLUMNS = ['created_date', 'complaint_type', 'descriptor', 'agency', 'agency_name', 'status', 'days_to_close', 'year_month'];

/**
 * The slim file the manifest lists for a borough (`manifest.borough_files`, #151), or null:
 * an older build has none, and a file missing a column the page needs is not used.
 */
export function slimFileFor(manifest, slug) {
  const bf = manifest?.borough_files;
  const f = bf?.files?.[slug];
  if (!f?.file || !Array.isArray(bf.columns) || !SLIM_COLUMNS.every((c) => bf.columns.includes(c))) return null;
  return f.file;
}
