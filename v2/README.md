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
 v2/site/  index.html + district.html + map.html (ES modules, no build step)
   DuckDB-WASM ── queries ONE district's Parquet file in the browser, loading only
                  the dates the view needs (see "Loading only what the view needs")
   MapLibre GL ── self-hosted Protomaps street map, district boundaries, clustered points
   Observable Plot ── monthly line, agency × status, compare chart
   Page features: filters (dates, problem, description with exclude, agency, status
   incl. "not yet closed", address) in groups that open and close, run by an Apply
   button and kept in the URL; at-a-glance numbers; top problems
   and descriptions; monthly chart; agency responsiveness table; older requests
   still open; map with a key; full-page map; top addresses; compare; request list
   with days open; CSV; print
```

**Full-page map (`site/map.html`, #143).** The district map's "Open full-page map"
button opens the same map as big as the window, for the same district, dates and
filters. Everything is in the link (`geo`, `id`, `start`, `end`, `type`, `desc`,
`descx`, `agency`, `status`, the same parameters as `district.html`), so the link
can be shared, and "Back to the district page" carries them back. The two pages
share code so they cannot drift: `js/filterstate.js` reads and writes the link
(`filtersFromParams`, `filtersToParams`), `js/filtersql.js` builds the SQL filter
(`whereSql`), and `js/requestmap.js` draws the map (lines, grouped circles, popups,
the map key) and its "Showing ..." line, with the same 60,000 most-recent cap. The
full-page map reads the district's Parquet file directly instead of loading the
district page's table, and has no filter form of its own: it lists the filters in
use and sends people back to the district page to change them. The address filter
never goes into a link (see the analytics notes below), so the full-page map shows
the whole district; the district page says so when an address filter is on.

## How to run

From the repository root (needs [uv](https://docs.astral.sh/uv/) and network
access to data.cityofnewyork.us):

```sh
# Optional: a Socrata app token raises rate limits. Never commit it.
# export SOCRATA_APP_TOKEN=...   (or set it in your Claude Code env)

uv run v2/pipeline/boardstat_build.py --start 2026-01-01 --out v2/site/data
#   default --start is 2020-01-01 (fixed; the full history), --end is today.
#   The full history is about 23 million rows: the first download takes 1 to 2.5
#   hours, so pass a later --start for a quick local build.
#   A --start before 2020-01-01 fails: 2010-2019 is a separate city dataset (#108).
#   --refresh-all ignores the download cache

bash v2/pipeline/basemap_build.sh
#   street map: cuts NYC out of a Protomaps daily build into v2/site/data/basemap/
#   (about 240 MB; needs the pmtiles CLI: brew install pmtiles). Optional: without
#   it the map shows district outlines on a blank background.

python3 v2/serve.py
#   then open http://localhost:8000/   (add --bind 0.0.0.0 to reach it from other devices)
#   Use this, not `python3 -m http.server`: the street map needs HTTP range requests.
```

Publishing to the demo at https://www.beta.nyc/boardstat/ (DreamPress; access in
the workspace's `team/engineering/hosting/README.md`):

```sh
python3 v2/whats_changed.py check WHATS-CHANGED.md --release
#   fails while WHATS-CHANGED.md has an "## Unreleased:" entry. Before uploading, change that
#   heading to today's date (same title), rebuild the page with the render command below,
#   and merge that change, so the page never says "Not released yet" about something live.
python3 v2/whats_changed.py render WHATS-CHANGED.md --format fragment \
  --into v2/site/whats-changed.html --site-prefix v2/site/ --repo-url https://github.com/BetaNYC/BoardStat
#   the What's changed page (site/whats-changed.html) is built from WHATS-CHANGED.md at the
#   top of the repository. CI (.github/workflows/whats-changed.yml) fails if it is stale.
python3 v2/stamp_assets.py
#   adds ?v=<hash> to CSS/JS links and writes an import map. beta.nyc tells browsers
#   to keep .js/.css for 120 days, so without this visitors keep old code.
rsync -a --chmod=D755,F644 --exclude .gitkeep --exclude /data/ -e "ssh -i ~/.ssh/id_ed25519_betanyc_dreampress" \
  v2/site/ wp_iz4gh3@dp-6803fc88d2.dreamhostps.com:beta.nyc/boardstat/
```

> ⚠️ Keep `--exclude /data/`. The nightly job publishes the live `data/` folder; without
> the exclude, this upload replaces it with whatever stale files sit in `v2/site/data`.

Data files keep the same names on every rebuild and beta.nyc sends no cache rule
for them, so the site adds the build time to every data link (`?v=generated_at`,
see `dataUrl()` in `site/js/lib.js`). A new build is never mixed with old files.

## Nightly refresh (#107)

The city changes old 311 rows every night (a request closes, a status changes),
so the nightly job picks up **changed** rows as well as new ones.
`pipeline/boardstat_nightly.py`:

1. Asks the portal for every row whose `:updated_at` (a Socrata system field,
   https://dev.socrata.com/docs/system-fields) is newer than the last run, from
   a **fixed start, 2020-01-01**, through today. The start never rolls forward,
   so the history only grows. `--start DATE` changes it (a date before 2020
   fails loudly); `--years N` gives the old rolling window, for tests.
2. Patches those rows into the cached month files, replacing by `unique_key`.
   A changed row in a month with no cached file counts as **new** only if that
   month is newer than every cached month (a new month starting). An older
   missing month is a backfill, so its rows are left out of `changes.json` and
   logged as `month_backfill`; the build downloads that month whole.
3. Saves the night's diff (`pipeline/.cache/nightly/diffs/*.parquet`: new or
   updated, old and new status).
4. On Sundays, compares each cached month's row count with the city's and moves
   mismatched months to `pipeline/.cache/nightly/stale-months/`, so the build
   downloads them again (`:updated_at` cannot show a row the city deleted).
5. Runs the normal build into `v2/data-nightly/` and writes `changes.json`:
   new, updated and newly closed requests since the last publish, citywide and
   per district. The site shows it as "What changed since …".
6. `--publish`: uploads to `data-next/` on beta.nyc, then swaps it with `data/`
   in one step (the street map folder moves across). It refuses to publish if
   total requests fell by more than 5%, then checks the live manifest.
7. `--notify CHANNEL`: posts failures and warnings (nothing moved for 2 runs,
   a spike over 200,000 rows, count mismatches) to Discord through Rosie, the
   BetaNYC bot (`scripts/discord_rosie_post.py` in the BetaNYC AI workspace).
   "Nothing moved" means the city's newest `:updated_at` did not advance and
   no row was new or different. The row count alone can't tell: the watermark
   is kept to the second, so each night re-fetches the city's last batch.

8. `--skip-if-published-today` (launchd passes it): exits quietly if a run
   already published today (New York date). launchd starts the job at 5:30 AM
   and again at 8:30 AM, so the 8:30 run is a retry for a morning NYC Open
   Data was down (429/503 on 2026-11-08 and 11-09) and can never publish
   twice. If the retry fails too, its post says "FAILED again (try 2 today)".

State (the `:updated_at` watermark, the last publish, and today's try count)
is in `pipeline/.cache/nightly/state.json`.

**Where it runs:** the office Mac mini, as a launchd job, outside Claude Code.
It runs the code in this checkout, so keep the checkout on `master`.

```sh
# one time: secrets go in the login Keychain, never a file
security add-generic-password -U -s boardstat-socrata-app-token -a boardstat -w   # prompts
security add-generic-password -U -s boardstat-rosie-discord-token -a boardstat -w # prompts (Rosie's DISCORD_TOKEN)

bash v2/pipeline/launchd/install.sh ops-website   # 5:30 AM nightly, 8:30 AM retry; alerts to #ops-website
launchctl kickstart gui/$(id -u)/nyc.betanyc.boardstat-nightly   # run now (skips if today already published)
tail -f ~/Library/Logs/boardstat-nightly/$(date +%F).log         # watch it
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/nyc.betanyc.boardstat-nightly.plist  # stop it
```

Run it by hand without publishing: `uv run v2/pipeline/boardstat_nightly.py`.

### One-time backfill to January 2020 (#108)

Moving the start from 2023-11 to 2020-01 adds 46 months (about 12 million rows).
Download them **by hand, once, before the nightly job runs the new code.** If the
job meets those months first, it downloads them inside the 5:30 run (1 to 2.5
hours), and the site's "What changed" line would be wrong for that night. (The
`month_backfill` guard above keeps those rows out of `changes.json`, but the
manual run also keeps the long download out of the live job.)

On the office Mac, in the live checkout, after the PR is merged:

```sh
cd /Volumes/Home_Remote/noneck_remote/Code/BoardStat
tail -3 ~/Library/Logs/boardstat-nightly/$(date +%F).log      # wait for today's "done" first

# 1. Pause the nightly job.
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/nyc.betanyc.boardstat-nightly.plist

# 2. Get the new code.
git switch master && git pull

# 3. Backfill: fills v2/pipeline/.cache/311 with 2020-01 to 2023-10. 1 to 2.5 hours.
#    The output folder is a scratch build; the nightly job writes its own.
export SOCRATA_APP_TOKEN="$(security find-generic-password -s boardstat-socrata-app-token -w)"
/usr/bin/time -l uv run v2/pipeline/boardstat_build.py --start 2020-01-01 --out v2/data-backfill
#    Check: requests per year roughly match the city's (2020 2.94M, 2021 3.22M,
#    2022 3.17M, 2023 3.22M, minus requests with no location), and the council
#    agreement in v2/data-backfill/build-log.md is lower before 2024 (old lines).
#    complaint_type_map.csv gains new unreviewed names: commit it on a branch.

# 4. One nightly run without publishing: changes.json should show a normal night,
#    not millions of "new" requests.
uv run v2/pipeline/boardstat_nightly.py --check-counts yes
python3 -c "import json; print(json.load(open('v2/data-nightly/changes.json'))['city'])"

# 5. Upload the new site code (it also works with the old 3-year data).
python3 v2/stamp_assets.py   # then the rsync under "Publishing", above

# 6. Turn the job back on. The next 5:30 run publishes 2020 onward.
bash v2/pipeline/launchd/install.sh ops-website
```

The build uses up to 8 GB of memory (`BOARDSTAT_DUCKDB_MEMORY` changes that) and
spills to `v2/pipeline/.cache/duckdb-tmp/` beyond it. A 2-month test build
(2020-01 and 2020-02, 368,393 rows) peaked at 1.9 GB.

Requests to NYC Open Data are paced: at least 2 seconds between requests, doubled after
each HTTP 429 (up to 60 seconds) and halved again after each success. A `Retry-After`
header is honored. Socrata publishes no request-rate number
(https://dev.socrata.com/docs/app-tokens), so these come from our own logs.
`BOARDSTAT_SODA_MIN_INTERVAL` and `BOARDSTAT_SODA_MAX_INTERVAL` (seconds) change them.
The Sunday count check asks one grouped question per year (four per year if the portal
finds a year too heavy) instead of one per month.

### Loading only what the view needs (#108)

With six years of data, the largest district (Council District 11, about one
million requests) would take about 700 MB of browser memory if loaded whole. So
the district and address pages load only:

- every request **not yet Closed**, of any age (the "Still open from before this
  period" panel and the "not yet closed" filter need them all), and
- **Closed** requests from 12 months before the From date on (the "same month a
  year earlier" line needs that year).

Moving the From date earlier reloads; a status filter other than Closed never
needs to. The page opens on `manifest.window.default_start`: **the last 12 full
months plus the current month**, so a link without dates shows about a year. The
date pickers still reach back to 2020-01-01. Only the columns the page shows are
kept in memory; the CSV download reads every column straight from the file.

To make that cheap, `boardstat_build.py` writes each detail file with the Closed
requests first, in `created_date` order, then every not-yet-Closed request at the
end, with an `is_closed` column, in 50,000-row groups. So the rows a view needs
are one run of row groups that ends at the end of the file. A file built before
this change has no `default_start` in its manifest; the page then loads it whole,
as before.

Measured on 2026-11-06 for Council District 11 (DuckDB-WASM 1.32.0 in headless
Chromium, `duckdb_memory()`, table memory). The 2020+ file is synthetic: today's
real rows plus shifted copies to fill 2020-01 to 2023-10 (1,020,624 rows, 30 MB).

| Case | Rows in memory | Memory |
|---|---:|---:|
| Before: today's 3 years, whole file | 461,073 | 317 MB |
| Before: 2020 onward, whole file | 1,020,624 | 694 MB |
| **After: default view (Nov 2025 on)** | 347,922 | **115 MB** |
| After: From date moved to June 2021 | 985,457 | 330 MB |

Numbers on the page matched a whole-file count exactly in every case checked.

### What a browser downloads

DuckDB-WASM 1.32.0 defaults `forceFullHTTPReads` to **true**
(`lib/src/io/web_filesystem.cc` in duckdb-wasm: `force_full_http_reads.value_or(true)`),
so it fetched every registered file whole. `lib.js` now opens the database with
`{ filesystem: { forceFullHTTPReads: false } }`. DuckDB then checks with
`HEAD` + `Range: bytes=0-` (beta.nyc and `v2/serve.py` both answer `206`) and
reads only the footer and the row groups a query needs. A server without range
support still works: `allowFullHTTPReads` stays on, so it falls back to one GET.

Its read-ahead grows each read ×4, from 16 KB up to 16 MB. A run of row groups
that ends at the end of the file therefore costs little more than the run, which
is why open requests now sit last. Reading the run in the middle of a file
overshoots by up to 16 MB.

Measured on 2026-11-06, Council District 11 (the largest), real 2020+ data
(`data-backfill`, 940,801 rows, 28.1 MB file), headless Chromium, bytes counted
at a local server that answers ranges. "Page data" is every file under `data/`.

| Case | Page data | CC 11 file | Compare panel (`agg`) | Table memory |
|---|---:|---:|---:|---:|
| Before (whole-file reads) | 30.0 MB | 28.1 MB | 1.57 MB | 113 MB |
| **After: default view** | **13.8 MB** | **12.8 MB** | 0.71 MB | 112 MB |
| After, file still in the old open-first layout | 19.6 MB | 18.6 MB | 0.71 MB | 112 MB |
| After: link opened at 2020-01-01 | 30.9 MB | 29.9 MB | 0.71 MB | 299 MB |
| After: default, then From moved to June 2021 | +28.6 MB | +28.6 MB | — | 292 MB |

The CSV download now fetches 0.7 MB more instead of nothing (it reads the long
text columns from the file). The tradeoff: before, the whole file was already
in the browser, so moving the From date back cost no download; now it costs
about one more file's worth. If that proves common, split files by year.

## Whole-borough view (#144)

`district.html?geo=boro&id=<slug>` (and `map.html` with the same parameters)
shows a whole borough with the same panels, map, list and filters as a district.
Slugs: `manhattan`, `bronx`, `brooklyn`, `queens`, `staten-island`
(`js/place.js`). The index page has a "A whole borough" choice; every community
district page links to its borough with the current filters.

**What it counts.** A borough is every community district file whose number
starts with the borough's digit, Joint Interest Areas included (Brooklyn:
301–318, 355, 356). That is the rule the pipeline already uses for the
`borough` rows of `agg/month_type.parquet` (`cd // 100`), so the page and the
Compare panel agree: verified exactly for all five boroughs against `agg`, and
for filtered views against DuckDB in Python (2026-11-13). Requests with no
usable location are in no district file and so on no borough page; the page
states how many of those the city's own records assign to the borough.
Council districts are never used, because they cross borough lines.

**How it reads the data (no pipeline change).** The page registers each
district file and reads them as one table with
`read_parquet(['d-301.parquet', ...])`
([DuckDB: reading multiple files](https://duckdb.org/docs/stable/data/multiple_files/overview)).
Range loading works per file, as on a district page. A single prebuilt
borough file was measured too (a scratch Brooklyn file built from the same
rows, same sort and row groups) and downloaded the same bytes in the same
time, so the pipeline writes nothing new.

**Two-step load on borough pages (#144 follow-up, `js/loadplan.js`).** A
borough page first loads the Closed requests from the From date on (plus every
request not yet Closed, as before) and draws every panel; Requests per month
shows "This period" with the note "Loading the same months a year earlier…".
Then it loads the 12 months before the From date in the background, one district
file at a time, appends them to the table, and draws only Requests per month
again. Each file remembers how far back it is loaded, so no row is loaded twice;
Apply, Reset and a From date moved earlier wait for at most the file being read,
then load only what is still missing. If the background load fails, the page
says so under the chart, leaves the year-earlier line out, registers the files
again (a failed range read can leave DuckDB-WASM 1.32.0 serving a bad read-ahead
buffer; seen as "TProtocolException: Invalid data" on the retry) and tries again
on the next draw.

The second step costs extra bytes. It starts mid-file, and DuckDB-WASM's
read-ahead grows fourfold on each contiguous read up to 16 MB
(`lib/include/duckdb/web/io/readahead_buffer.h` in duckdb-wasm 1.32.0), so it
runs on to the end of each file and fetches the first step's bytes again, with
the unselected columns. Two steps cost about the one-step bytes plus the first
step's. That is worth it for a borough and not for a district, so district,
council district and address pages keep the one-step load (`TWO_STEP` in
`district.js`). Any page now appends only the missing older rows when the From
date moves earlier, instead of reloading the whole table.

Measured 2026-11-13, default view (Nov 2025 on), cold browser, headless
Chromium, 2020+ nightly data, bytes counted at a local range-answering server;
"50 Mbps" paces that server to 50 Mbit/s shared across connections. "Drawn" is
every panel drawn; "Year earlier" is when the year-earlier series appears.

| Page | Load | Page data | Rows loaded | DuckDB memory | Drawn (local / 50 Mbps) | Year earlier (50 Mbps) |
|---|---|---:|---:|---:|---:|---:|
| Brooklyn CD 6 | one step (unchanged) | 7.8 MB | 119,332 | 38 MB | 2.7 s / 4.2 s | 4.2 s |
| Staten Island | one step (before) | 18.3 MB | 301,898 | 103 MB | 3.2 s / 7.4 s | 7.4 s |
| Staten Island | two steps | 17 + 6 = 23.1 MB | 228,896, then 301,898 | 93, then 113 MB | 3.0 s / 6.6 s | 8.1 s |
| **Brooklyn** | one step (before) | 133.4 MB | 2,364,674 | 768 MB | 7.0 s / 36.6 s | 36.6 s |
| **Brooklyn** | **two steps** | **89 + 93 = 182.3 MB** | **1,317,062, then 2,364,674** | **about 490, then 553 MB** | **5.1 s / 25.7 s** | **49.2 s** |
| Brooklyn, one prebuilt file | one step | 132.9 MB | 2,364,674 | 760 MB | 6.6 s / — | — |

The first step alone, run as a query, reads 89.2 MB for Brooklyn; the page-level
counts include the first background file. Totals (1,246,567 for Brooklyn,
160,915 for Staten Island) and every year-earlier value are the same as with the
one-step load. Apply with an earlier From date during the background load drew
in 17 s after the first draw at 50 Mbps (Brooklyn).

So Brooklyn draws about 11 s sooner and the year-earlier line arrives about 13 s
later, for 49 MB more. If that trade is wrong, the other ways to make Brooklyn
faster are: open borough pages with a shorter default period, or have the
pipeline write per-borough summaries for the charts and read detail only for the
list and map (a layout with the previous year in its own files would also remove
the re-fetch).

## Traffic measurement (Google Analytics)

Every page loads `site/js/analytics.js`, which adds the beta.nyc Google tag
(`GT-MQ7Q7VP`) **only on beta.nyc** (never on localhost). Rules, as promised on
the About page:

- Before the tag loads, `page_location`, `page_referrer` and `page_title` are
  replaced with cleaned copies for every event: only the `geo`, `id`, `start`
  and `end` parameters survive. Addresses, coordinates, searches and filter
  values are dropped; the address page gets a fixed title.
- The automatic page view is off (`send_page_view: false`); one cleaned
  `page_view` is sent by hand.
- Events, all without free text: `district_selected`, `address_viewed`,
  `date_range_changed` (length in months, start year), `filter_changed` (the
  filter's name only), `csv_download`, `print_page`.
- GA's "page changes based on browser history events" setting can only be
  turned off in the GA property, not in code. So BoardStat never writes an
  address into the URL after load: the address page never rewrites its URL, and
  the district page no longer keeps the address filter in its link. The Boundaries
  Map link is a button (`noopener,noreferrer`), so Google's outbound-click event
  never sees the address in it.
- Recommended in GA (someone with access): turn off "Page changes based on
  browser history events" for the beta.nyc stream, or BoardStat filter changes
  count as page views.

Tests: `node --test v2/tests-js/` (also run by `uv run pytest`).

**If the Mac is off, the job can't alert anyone, so a second check runs on
GitHub.** `.github/workflows/boardstat-freshness.yml` runs every day at 14:00 UTC
(9 AM EST / 10 AM EDT) and reads the live `manifest.json`. If the data is more
than 26 hours old (or the manifest can't be read), it opens one issue labeled
`data-freshness` (repo watchers are notified), comments daily while it stays
stale, and closes it when the data is fresh again. Run it by hand from the
Actions tab ("BoardStat data freshness" → Run workflow). The script is
`pipeline/check/freshness.py` (standard library plus `gh`). GitHub pauses
scheduled workflows after 60 days with no repository activity; re-enable it
from the Actions tab if that happens.

Tests (offline except for the one-time DuckDB spatial extension download):

```sh
cd v2/pipeline && uv run pytest
```

## Data sources

| What | Dataset | Notes |
|---|---|---|
| 311 Service Requests from 2020 to Present | [`erm2-nwe9`](https://data.cityofnewyork.us/d/erm2-nwe9) | Updated daily. Pulled month by month, from 2020-01-01. |
| 311 Service Requests 2010–2019 | [`76ig-c548`](https://data.cityofnewyork.us/d/76ig-c548) | Same 48 columns. **Not used yet** (phase 2 of #108). |
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
   maximum, but a page bounds the cost of a retry. 429, 5xx, connection
   errors, and a connection reset while the body is downloading retry with
   exponential backoff; other 4xx stop the build. Raw months are cached gzipped in `v2/pipeline/.cache/`.
   Months that ended more than 60 days ago are reused; recent months are
   refetched after 12 hours because statuses and close dates keep changing.
   Consequence: statuses on older cached months can lag until `--refresh-all`.
7. **One Parquet file per district, queried by DuckDB-WASM.** Each is a
   few MB (zstd). Since #108 the page loads only the rows a view needs (see
   "Loading only what the view needs"). The browser never touches citywide detail. `v2/serve.py`
   answers HTTP range requests (the street map needs them); any real static host
   does too.
8. **Address lookup is a list of addresses that already appear in 311 data,**
   sorted so a prefix search can skip row groups. It is labeled as not a
   geocoder. No Geoclient / Geosupport call is made.
9. **Street map: self-hosted Protomaps, open source only (#141).** Every map uses
   one street map: `pipeline/basemap_build.sh` extracts
   NYC plus a margin from a [Protomaps daily build](https://docs.protomaps.com/guide/getting-started)
   (OpenStreetMap data, ODbL) into one `nyc.pmtiles` file, and copies the
   Noto Sans glyphs (SIL OFL) and v4 sprites from
   [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets).
   The style is `@protomaps/basemaps` in the `grayscale` flavor, so district
   colors and request dots stand out. The map credits "Protomaps © OpenStreetMap",
   linked to openstreetmap.org/copyright, and stays expanded at every width. The
   map tiles, fonts and sprites are all served from BoardStat's own folder; only
   the map's code libraries load from jsDelivr, at pinned versions. From
   2026-11-04 until this change (#141), the map first tried NYC OTI's basemap on
   ArcGIS; `pipeline/tests/test_no_esri.py` now fails if an ArcGIS or Esri URL
   comes back into the site code. At low zoom (z0-z7) the Protomaps build also
   carries Natural Earth land and water (public domain) and Daylight landcover
   (z0-z7, per [the Protomaps layer docs](https://docs.protomaps.com/basemaps/layers)),
   which Daylight derives from ESA WorldCover 2020
   ([Daylight's landcover release](https://daylightmap.org/2023/10/11/landcover.html);
   license CC BY 4.0, per [ESA WorldCover](https://esa-worldcover.org/en/data-access)).
   The About page credits both. District shapes sit under the street labels. Before
   using the street map, `map.js` checks `basemap.json`, the `nyc.pmtiles`
   header, the sprite and one glyph file (5-second timeout each); if any fails, or
   a street-map error comes later, the map keeps the outlines and requests on
   blank and shows a short message saying the street map could not load.
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
- The nightly job depends on one Mac being on. A GitHub check opens an issue
  when the data is more than 26 hours old, and the site shows a stale banner
  after 48 hours.
- Detail files for the busiest districts are the largest downloads; on slow
  connections the first load of a district takes a few seconds.
- The map shows at most the 60,000 most recent matching requests.
- A borough page (#144) downloads far more than a district page: see
  "Whole-borough view" below.
- "Same month a year earlier" only exists where the data covers both months
  (none before January 2021).
- Boundary simplification (about 10 m) is per polygon, so hairline gaps can show
  between neighbors at high zoom. Assignment uses the full-resolution shapes.
- Problem-name groupings are all `reviewed=false` until a person reviews them.
- Address search needs the city's spelling (`5 AVENUE`, not `Fifth Ave`).

## What's next

- **Vector tiles for points** with tippecanoe → PMTiles, so the map can show
  every request without shipping GeoJSON to the browser.
- **Historical backfill, phase 2:** `76ig-c548` (2010–2019), re-mapped to
  current lines (#108).
- **Move the nightly job to GitHub Actions** if the Mac mini proves unreliable.
- **Hosting:** Cloudflare R2 + Pages, or GitHub Pages for the site with data on
  object storage (range requests would then let DuckDB-WASM read partial files).
- Review `complaint_type_map.csv` with the people who will use it.

## License

- **Code:** MIT License ([`LICENSE`](../LICENSE)).
- **Data outputs** (everything the pipeline writes to `site/data/`, published at
  https://www.beta.nyc/boardstat/data/): Open Database License (ODbL) 1.0,
  https://opendatacommons.org/licenses/odbl/1-0/. The underlying records come
  from NYC Open Data and stay subject to the City's terms. Attribution line and
  source datasets: [`LICENSE-DATA.md`](../LICENSE-DATA.md).
- Every build copies `LICENSE-DATA.md` into the output folder as `LICENSE.txt`
  and adds a `license` block to `manifest.json`, so the published `data/`
  folder always carries the notice (#134). It is `.txt` because beta.nyc serves
  `.md` files as downloads. The build and the nightly job stop before any
  download if the file is missing.

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

Data: NYC Open Data (data.cityofnewyork.us), subject to the portal's terms of use. The exact terms page was not reachable from the build machine (HTTP 403), so it is not linked here yet ([#136](https://github.com/BetaNYC/BoardStat/issues/136)).
