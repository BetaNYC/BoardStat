# BoardStat 2.0 (prototype)

**This is a working prototype, not a production service.** It lives on the `v2`
branch next to the original BoardStat (the files at the repository root, which
still serve boardstat.beta.nyc from `gh-pages` and are untouched here).

BoardStat 2.0 shows NYC 311 service requests for any community district or
council district: the most common problems, how long they take to close, where
they happen, and how the district compares with its borough and the city. It is
built almost entirely from open-source tools and runs as static files: there is
no server and no database to operate.

Research behind it: *BoardStat 2.0 rebuild scoping, 2026-11-04* (BetaNYC
internal reports, in Noel's private vault).

## Architecture

```
 NYC Open Data (Socrata SODA 2.1, data.cityofnewyork.us)
   ├─ /api/views/<id>.json          metadata: schema check + rowsUpdatedAt
   ├─ /resource/5crt-au7u.geojson   Community Districts (DCP)
   ├─ /resource/872g-cjhh.geojson   City Council Districts (DCP)
   └─ /resource/erm2-nwe9.csv       311 requests, one month per window, paged
                │
                ▼
 v2/pipeline/boardstat_build.py   (Python 3.11+, uv, DuckDB + spatial extension)
   1. schema check (fail loudly)        4. normalize problem names (reviewed CSV)
   2. download boundaries               5. days_to_close + data-quality flags
   3. fetch + cache monthly CSV.gz      6. point-in-polygon: our own cd and cc
                │                       7. write Parquet / GeoJSON / manifest
                ▼
 v2/site/data/   (git-ignored, regenerated)
   manifest.json · boundaries/{cd,cc}.geojson · detail/{cd,cc}/<id>.parquet
   agg/month_type.parquet · addresses.parquet · build-log.md
                │  plain HTTP, any static host
                ▼
 v2/site/  index.html + district.html (ES modules, no build step)
   DuckDB-WASM ── queries ONE district's Parquet file in the browser
   MapLibre GL ── self-hosted Protomaps street map, district boundaries, clustered points
   Observable Plot ── monthly line, agency × status, compare chart
   Page features: filters (dates, problem, description with exclude, agency, status
   incl. "not yet closed", address) in the URL; at-a-glance numbers; top problems
   and descriptions; monthly chart; agency responsiveness table; older requests
   still open; map; top addresses; compare; request list with days open; CSV; print
```

## How to run

From the repository root (needs [uv](https://docs.astral.sh/uv/) and network
access to data.cityofnewyork.us):

```sh
# Optional: a Socrata app token raises rate limits. Never commit it.
# export SOCRATA_APP_TOKEN=...   (or set it in your Claude Code env)

uv run v2/pipeline/boardstat_build.py --out v2/site/data
#   defaults: last 12 full months + the current month to date
#   e.g. --start 2025-11-01 --end 2026-11-04
#   --refresh-all ignores the download cache

bash v2/pipeline/basemap_build.sh
#   street map: cuts NYC out of a Protomaps daily build into v2/site/data/basemap/
#   (about 240 MB; needs the pmtiles CLI: brew install pmtiles). Optional: without
#   it the map shows district outlines on a blank background.

python3 v2/serve.py
#   then open http://localhost:8000/   (add --bind 0.0.0.0 to reach it from other devices)
#   Use this, not `python3 -m http.server`: the street map needs HTTP range requests.
```

Tests (offline except for the one-time DuckDB spatial extension download):

```sh
cd v2/pipeline && uv run pytest
```

## Data sources

| What | Dataset | Notes |
|---|---|---|
| 311 Service Requests from 2020 to Present | [`erm2-nwe9`](https://data.cityofnewyork.us/d/erm2-nwe9) | Updated daily. Pulled month by month. |
| 311 Service Requests 2010–2019 | [`76ig-c548`](https://data.cityofnewyork.us/d/76ig-c548) | Same 48 columns. **Not used yet** (historical backfill is a next step). |
| Community Districts (DCP) | [`5crt-au7u`](https://data.cityofnewyork.us/d/5crt-au7u) | 71 features: 59 CDs + 12 Joint Interest Areas. Release 26c at build time. |
| City Council Districts (DCP) | [`872g-cjhh`](https://data.cityofnewyork.us/d/872g-cjhh) | 51 features. Release 26c at build time. |

The exact `rowsUpdatedAt` of each source at build time is recorded in
`v2/site/data/manifest.json`.

## Results of the first full run (2026-11-04)

Run on office-mac, 2026-11-04, with an app token, default window.

- **Window requested:** 2025-11-01 to 2026-11-04 (12 full months + November to
  date). The full 12-month window ran inside the time budget, so no reduction
  to 6 or 3 months was needed. **The newest request in the portal was created
  2026-11-01 02:06** (the portal's `rowsUpdatedAt` was 2026-11-02 02:37 UTC),
  so the data effectively ends there.
- **Run time:** 22 min 50 s total. Almost all of it is download (13 monthly
  windows, 66–186 s each, 200k-row pages). The DuckDB build itself took 22 s
  for 3.98 million rows; point-in-polygon on 603,387 distinct points took 3 s.
  Reruns reuse the cache and take well under a minute for months older than 60
  days.
- **Rows:** 3,976,313 requests; 3,892,956 with usable coordinates; 83,357
  (2.1%) without. 84,101 are in no district (no coordinates, or outside every
  polygon, e.g. on the water). 1,365 closed before they were created, 1 closed
  in the future; 186,281 have no close date.
- **Problem names:** 197 raw spellings grouped into 194 display names (three
  case pairs: ELEVATOR/Elevator, PLUMBING/Plumbing, SAFETY/Safety). All 194
  rows are `reviewed=false`.
- **Agreement with the city's own fields** (rows where both are present):
  - Council district: 3,857,103 of 3,873,836 = **99.57%** (monthly 99.40% to
    99.87%). About 94% of the 16,733 mismatches lie within roughly 50 m of a
    council boundary (rough degree-to-meter conversion), so they are edge
    cases, not a systematic shift. This window is entirely after the 2023
    redistricting; the old-lines problem will appear when older years are
    backfilled.
  - Community district: 3,860,121 of 3,873,805 = **99.65%**.
- **Output sizes:** `site/data/` 292 MB total. Detail Parquet (zstd): 287 MB
  across 122 files; community district files 16 KB (JIA 484) to 4.2 MB
  (Queens CD 12), median 2.2 MB; council files 1.4 MB to 4.5 MB, median
  2.9 MB. `addresses.parquet` 4.2 MB (604,766 address/ZIP rows).
  `agg/month_type.parquet` 244 KB (155,874 rows). Boundaries 504 KB for both
  layers. Download cache (`pipeline/.cache/`): 372 MB of gzipped CSV.

## Decisions made while building (2026-11-04) and why

1. **Re-map every request ourselves.** The city's `council_district` field
   keeps pre-2023 lines on older records, so the council view would mix two
   maps. Every located request gets `cd` and `cc` from our own point-in-polygon
   join against the current DCP layers. The city's `community_board` and
   `council_district` are kept alongside and the agreement is reported.
2. **Joint Interest Areas are their own "districts".** A point in Central Park
   lands in JIA 164, not in a neighboring CD. They appear in the list, flagged,
   because that is where those requests actually are. A point on a shared edge
   goes to the lowest id, deterministically.
3. **Requests without usable coordinates are counted, not placed.** About 1%.
   Coordinates outside a generous NYC bounding box count as missing. The city's
   own `community_board` for those rows is reported per CD on the About panel.
4. **Problem-name normalization is a reviewed CSV**,
   `v2/pipeline/complaint_type_map.csv`. The build groups spellings
   case-insensitively (PLUMBING / Plumbing), picks the most common spelling that
   is not ALL CAPS as the display form, and appends new groups with
   `reviewed=false`. Human edits to `display` and `reviewed` survive reruns. The
   site shows how many groups are still unreviewed. It does not merge
   differently worded types (that is an editorial call for a person).
5. **`days_to_close`** = closed − created in fractional days. Null while open.
   Also null, with a `close_flag`, when the close date is before the created
   date or in the future, so those rows do not distort medians.
6. **Monthly download windows, paged at 200,000 rows with `$order=unique_key`.**
   The portal times out on year-long aggregates; SODA 2.1 has no `$limit`
   maximum, but a page bounds the cost of a retry. 429 and 5xx retry with
   exponential backoff. Raw months are cached gzipped in `v2/pipeline/.cache/`.
   Months that ended more than 60 days ago are reused; recent months are
   refetched after 12 hours because statuses and close dates keep changing.
   Consequence: statuses on older cached months can lag until `--refresh-all`.
7. **One Parquet file per district, loaded whole into DuckDB-WASM.** Each is a
   few MB (zstd). The browser never touches citywide detail. `v2/serve.py`
   answers HTTP range requests (the street map needs them); any real static host
   does too.
8. **Address lookup is a list of addresses that already appear in 311 data,**
   sorted so a prefix search can skip row groups. It is labeled as not a
   geocoder. No Geoclient / Geosupport call is made.
9. **Self-hosted Protomaps street map.** `pipeline/basemap_build.sh` extracts
   NYC plus a margin from a [Protomaps daily build](https://docs.protomaps.com/guide/getting-started)
   (OpenStreetMap data, ODbL) into one `nyc.pmtiles` file, and copies the
   Noto Sans glyphs (SIL OFL) and v4 sprites from
   [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets).
   The style is `@protomaps/basemaps` in the `grayscale` flavor, so district
   colors and request dots stand out. Nothing basemap-related is fetched from
   anyone else at runtime. District shapes sit under the street labels. If
   `data/basemap/` is missing, the map falls back to outlines on blank.
   Refresh the extract a few times a year.
10. **Comparisons are located-only and whole-month.** `agg/month_type.parquet`
    counts only requests with a district, so district, borough and city shares
    use the same population. The Compare panel ignores problem/agency/status
    filters (the aggregate does not carry them) and says so.
11. **Council districts get a "borough" for comparison** = the borough where
    most of that district's requests fall (some cross borough lines).
12. **Pinned CDN versions:** `@duckdb/duckdb-wasm@1.32.0` (the newest
    non-prerelease; npm's `latest` tag currently points at a `-dev` build),
    `maplibre-gl@6.16.0` (ESM-only), `@observablehq/plot@0.6.18`,
    `pmtiles@4.5.0`, `@protomaps/basemaps@5.7.2`. The pipeline
    uses `duckdb>=2.0,<3`; Parquet written by DuckDB 2.0 read fine in
    DuckDB-WASM 1.32.0 in testing.
13. **Fonts:** brand fonts (Poppins, Roboto) are used only if installed
    locally; no font CDN is loaded. Colors follow the BetaNYC brand tokens;
    status colors in the agency chart reuse brand blues and grays with an
    outline, and every chart has a "Show as table" alternative.
14. **Timestamps are NYC local "floating" time** as published; "now" for
    future-date checks is computed in America/New_York.

15. **Board-report features (2026-11-04).** Three additions on the district page,
    from what v1 users did by hand:
    - **Description filter** (the 311 `descriptor` field), multi-select with an
      "exclude these" toggle, kept in the URL (`desc=a|b`, `descx=1`) and applied
      to every panel, the map, the request list and the CSV. Its list offers only
      descriptions of the selected problems (all if none). A missing descriptor
      is shown and filtered as `(none)`. Selecting a row in the "What people
      described" table adds it. The table itself ignores the description filter
      so every option stays visible. `descriptor_2` (a sub-description on about
      half of all rows) is not filtered; it is in the CSV.
    - **Agency responsiveness table**: every agency in the filtered set with
      requests, not yet closed, closed, and median and average days to close.
      Selecting an agency toggles the agency filter. It prints; the agency ×
      status chart still does not.
    - **Not yet closed**: a Status shortcut (`status=not_closed`, every status
      other than Closed, including a missing one); a "Days open" column in the
      request list, counted to the build time in `manifest.json` (as NYC local
      time), not the browser clock; and a "Still open from before this period"
      panel: requests created before the From date that are still not closed,
      by agency, with buttons that set the filters to show them. It carries a
      note that older months' statuses can lag (decision 6).
16. **"Closed" means `status = 'Closed'` everywhere.** Median and average time to
    close (headline, top problems, agency table) count only requests marked
    Closed with a usable `days_to_close`. Some requests carry a close date while
    their status is still Open, Assigned or In Progress (254 of 58,636 in
    Brooklyn CD 6, 0.4%; not measured citywide); they count as not yet closed and are left out of
    time to close, so the "Closed" count and the time-to-close numbers describe
    the same requests. Before this change the headline median included them.

## Known limits

- Prototype quality: no automated browser tests; verified by hand in Chromium
  (Playwright) on 2026-11-04, including the description, agency-responsiveness
  and still-open features (counts cross-checked against DuckDB in Python).
- Data is a snapshot. A stale banner appears when the build is more than 48
  hours old; there is no scheduled job yet.
- Detail files for the busiest districts are the largest downloads; on slow
  connections the first load of a district takes a few seconds.
- The map shows at most the 60,000 most recent matching requests.
- "Same month a year earlier" only exists where the window covers both months
  (with the default 13-month window, only the first month).
- Boundary simplification (about 10 m) is per polygon, so hairline gaps can show
  between neighbors at high zoom. Assignment uses the full-resolution shapes.
- Problem-name groupings are all `reviewed=false` until a person reviews them.
- Address search needs the city's spelling (`5 AVENUE`, not `Fifth Ave`).

## What's next

- **Vector tiles for points** with tippecanoe → PMTiles, so the map can show
  every request without shipping GeoJSON to the browser.
- **Historical backfill** from `76ig-c548` (2010–2019) and the rest of
  `erm2-nwe9`, re-mapped to current lines.
- **GitHub Actions daily job** to rebuild and publish (and refresh recent
  months' statuses).
- **Hosting:** Cloudflare R2 + Pages, or GitHub Pages for the site with data on
  object storage (range requests would then let DuckDB-WASM read partial files).
- **License decision:** this repository has **no LICENSE file**. One was not
  added on purpose; Noel must choose the license (code and data outputs may
  want different ones).
- Review `complaint_type_map.csv` with the people who will use it.

## Third-party software

| Package | Version | License | Used for |
|---|---|---|---|
| [DuckDB](https://duckdb.org) (Python) | >=2.0,<3 (2.0.0 locked) | MIT | Pipeline SQL engine |
| DuckDB [spatial extension](https://duckdb.org/docs/stable/core_extensions/spatial/overview) | matches DuckDB | MIT (bundles GDAL, GEOS, PROJ under their own open licenses) | Boundary reading, point-in-polygon, simplification |
| [requests](https://requests.readthedocs.io) | >=2.32,<3 | Apache-2.0 | HTTP to the portal |
| [pytest](https://pytest.org) | >=8.3,<10 (dev) | MIT | Tests |
| [@duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm) | 1.32.0 | MIT | In-browser queries |
| [maplibre-gl](https://maplibre.org) | 6.16.0 | BSD-3-Clause | Map |
| [@observablehq/plot](https://observablehq.com/plot/) | 0.6.18 | ISC | Charts (pulls in D3, ISC) |
| [pmtiles](https://docs.protomaps.com/pmtiles/) | 4.5.0 (JS), CLI 1.31.2 | BSD-3-Clause | Reading / extracting the street map file |
| [@protomaps/basemaps](https://docs.protomaps.com/basemaps/maplibre) | 5.7.2 | BSD-3-Clause | Street map style |
| [basemaps-assets](https://github.com/protomaps/basemaps-assets) | main | Noto Sans: SIL OFL 1.1 | Map labels' fonts and icons |

Street map data: © OpenStreetMap contributors (ODbL), via Protomaps; credited in the map's attribution.

Data: NYC Open Data (data.cityofnewyork.us), subject to the portal's terms of use. The exact terms page was not reachable from the build machine (HTTP 403), so it is not linked here; confirm it before publishing.
