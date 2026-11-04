#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11,<3.16"
# dependencies = [
#     "duckdb>=2.0,<3",
#     "requests>=2.32,<3",
# ]
# ///
"""BoardStat 2.0 prototype pipeline.

Pulls NYC 311 service requests from the NYC Open Data portal (Socrata),
assigns every located request to a Community District and a City Council
District with our own point-in-polygon join against the current DCP
boundaries, and writes small per-district Parquet files plus a manifest for
the static site in ``v2/site``.

Run from the repository root:

    uv run v2/pipeline/boardstat_build.py --start 2025-11-01 --end 2026-11-04 --out v2/site/data

Only data.cityofnewyork.us is contacted. An app token is read from the
``SOCRATA_APP_TOKEN`` environment variable if set and sent as the
``X-App-Token`` header (https://dev.socrata.com/docs/app-tokens). The token
is never logged.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import os
import random
import re
import sys
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import duckdb
import requests

SCRIPT = "boardstat_build"
PORTAL = "https://data.cityofnewyork.us"

DATASET_311 = "erm2-nwe9"  # 311 Service Requests from 2020 to Present
DATASET_311_HISTORIC = "76ig-c548"  # 2010-2019, not used by the prototype yet
DATASET_CD = "5crt-au7u"  # DCP Community Districts (59 CDs + 12 JIAs)
DATASET_CC = "872g-cjhh"  # DCP City Council Districts (51)

# The columns we pull. All of them must exist in the dataset's metadata or the
# build stops (see check_schema).
FIELDS_311 = [
    "unique_key",
    "created_date",
    "closed_date",
    "agency",
    "agency_name",
    "complaint_type",
    "descriptor",
    "descriptor_2",
    "status",
    "incident_address",
    "street_name",
    "intersection_street_1",
    "intersection_street_2",
    "incident_zip",
    "bbl",
    "borough",
    "community_board",
    "council_district",
    "latitude",
    "longitude",
    "resolution_description",
]
FIELDS_CD = ["boro_cd", "the_geom"]
FIELDS_CC = ["coundist", "the_geom"]

# SODA 2.1 endpoints have no $limit maximum (https://dev.socrata.com/docs/queries/limit),
# but we still page so that one failed request costs one page, not one month.
PAGE_SIZE = 200_000

BOROUGHS = {1: "Manhattan", 2: "Bronx", 3: "Brooklyn", 4: "Queens", 5: "Staten Island"}
BOROUGH_CODE_BY_NAME = {v.upper(): k for k, v in BOROUGHS.items()}
# Highest real community district number per borough. Any boro_cd above this is a
# Joint Interest Area (a park, airport, or other area outside every CD).
MAX_CD = {1: 12, 2: 12, 3: 18, 4: 14, 5: 3}

# Generous NYC bounding box; coordinates outside it are treated as "no location".
NYC_BBOX = {"lon_min": -74.30, "lon_max": -73.65, "lat_min": 40.45, "lat_max": 40.95}


# --------------------------------------------------------------------------- logging


def log(event: str, **fields: Any) -> None:
    """One structured JSON line per event on stderr. Never pass secrets here."""
    rec = {"script": SCRIPT, "event": event, "ts": dt.datetime.now(dt.UTC).isoformat(timespec="seconds")}
    rec.update(fields)
    print(json.dumps(rec, default=str), file=sys.stderr, flush=True)


class PipelineError(RuntimeError):
    """A failure the operator must see. Raised instead of continuing silently."""


# --------------------------------------------------------------------------- HTTP


class Soda:
    """Minimal client for the documented SODA endpoints we use.

    - /api/views/<id>.json : dataset metadata (columns, rowsUpdatedAt)
    - /resource/<id>.csv and /resource/<id>.geojson : rows in CSV / GeoJSON
      (https://dev.socrata.com/docs/formats/)
    - $select / $where / $order / $limit / $offset SoQL parameters
      ($order is required for stable paging: https://dev.socrata.com/docs/queries/order)
    - 429 means throttled (https://dev.socrata.com/docs/app-tokens); we retry with backoff,
      and also retry 5xx and connection errors.
    """

    def __init__(self, base: str = PORTAL, token: str | None = None, max_tries: int = 6, timeout: int = 180):
        self.base = base.rstrip("/")
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "BetaNYC-BoardStat-v2-prototype"
        if token:
            self.session.headers["X-App-Token"] = token
        self.max_tries = max_tries
        self.timeout = timeout

    def get(self, path: str, params: dict[str, str] | None = None) -> requests.Response:
        url = f"{self.base}{path}"
        last: Exception | None = None
        for attempt in range(1, self.max_tries + 1):
            try:
                r = self.session.get(url, params=params, timeout=self.timeout)
                if r.status_code == 429 or r.status_code >= 500:
                    raise requests.HTTPError(f"HTTP {r.status_code}", response=r)
                r.raise_for_status()
                return r
            except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as exc:
                status = getattr(getattr(exc, "response", None), "status_code", None)
                if status is not None and status < 500 and status != 429:
                    raise PipelineError(f"{url} returned HTTP {status}: {exc.response.text[:300]}") from exc
                last = exc
                wait = min(120, 2**attempt) + random.uniform(0, 1)
                log("http_retry", path=path, attempt=attempt, status=status, wait_s=round(wait, 1), error=str(exc)[:200])
                time.sleep(wait)
        raise PipelineError(f"Giving up on {url} after {self.max_tries} tries: {last}")

    def metadata(self, dataset_id: str) -> dict[str, Any]:
        return self.get(f"/api/views/{dataset_id}.json").json()


# --------------------------------------------------------------------------- schema


def check_schema(meta: dict[str, Any], expected: Iterable[str], dataset_id: str, name_hint: str | None = None) -> None:
    """Fail loudly if the dataset no longer has the columns we depend on."""
    have = {c.get("fieldName") for c in meta.get("columns", [])}
    missing = [f for f in expected if f not in have]
    if missing:
        raise PipelineError(
            f"Schema check failed for {dataset_id} ({meta.get('name')!r}): missing fields {missing}. "
            "The portal dataset changed; update FIELDS_* in boardstat_build.py after reading its new data dictionary."
        )
    if name_hint and name_hint.lower() not in str(meta.get("name", "")).lower():
        raise PipelineError(
            f"Dataset {dataset_id} is now named {meta.get('name')!r}, expected it to contain {name_hint!r}. "
            "Check the portal before trusting this id."
        )


def boundary_version(meta: dict[str, Any]) -> str | None:
    """DCP states the release in the description, e.g. 'Current version: 26c'."""
    text = json.dumps(meta)
    m = re.search(r"[Cc]urrent version:?\s*([0-9]{2}[a-z])\b", text)
    if m:
        return m.group(1)
    found = sorted(set(re.findall(r"\b(2[0-9][a-d])\b", text)))
    return found[-1] if found else None


def epoch_to_iso(ts: Any) -> str | None:
    if ts is None:
        return None
    return dt.datetime.fromtimestamp(int(ts), tz=dt.UTC).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- windows


@dataclass(frozen=True)
class Window:
    start: dt.date  # inclusive
    end: dt.date  # exclusive

    @property
    def label(self) -> str:
        return self.start.strftime("%Y-%m")


def month_windows(start: dt.date, end_inclusive: dt.date) -> list[Window]:
    """Split [start, end_inclusive] into calendar-month windows (end exclusive)."""
    if end_inclusive < start:
        raise PipelineError(f"--end {end_inclusive} is before --start {start}")
    out: list[Window] = []
    cur = start
    stop = end_inclusive + dt.timedelta(days=1)
    while cur < stop:
        nxt = (cur.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
        out.append(Window(cur, min(nxt, stop)))
        cur = nxt
    return out


def default_window(today: dt.date) -> tuple[dt.date, dt.date]:
    """Last 12 full months plus the current month to date."""
    y, m = today.year, today.month - 12
    if m <= 0:
        y, m = y - 1, m + 12
    return dt.date(y, m, 1), today


# --------------------------------------------------------------------------- fetching


def soql_ts(d: dt.date) -> str:
    # Floating timestamps are ISO 8601 without offset
    # (https://dev.socrata.com/docs/datatypes/floating_timestamp.html).
    return f"'{d.isoformat()}T00:00:00'"


def fetch_month(soda: Soda, win: Window, cache_dir: Path, today: dt.date, max_age_h: float) -> Path:
    """Fetch one month of 311 rows to a gzipped CSV in the cache.

    Months that ended more than 60 days ago are reused from cache indefinitely
    (their statuses may lag; pass --refresh-all to refetch). Recent months are
    refetched when the cache is older than ``max_age_h`` hours, because closed
    dates and statuses keep changing.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"{DATASET_311}_{win.start.isoformat()}_{win.end.isoformat()}.csv.gz"
    meta_path = path.with_suffix(".json")
    if path.exists() and meta_path.exists():
        meta = json.loads(meta_path.read_text())
        age_h = (time.time() - meta["fetched_at_epoch"]) / 3600
        old_month = (today - win.end).days > 60
        if old_month or age_h < max_age_h:
            log("month_cached", month=win.label, rows=meta["rows"], age_h=round(age_h, 1))
            return path

    t0 = time.time()
    tmp = path.with_suffix(".tmp")
    rows = 0
    with gzip.open(tmp, "wt", newline="", encoding="utf-8", compresslevel=3) as fh:
        writer = csv.writer(fh)
        writer.writerow(FIELDS_311)
        offset = 0
        while True:
            params = {
                "$select": ",".join(FIELDS_311),
                "$where": f"created_date >= {soql_ts(win.start)} AND created_date < {soql_ts(win.end)}",
                "$order": "unique_key",
                "$limit": str(PAGE_SIZE),
                "$offset": str(offset),
            }
            r = soda.get(f"/resource/{DATASET_311}.csv", params=params)
            reader = csv.reader(io.StringIO(r.content.decode("utf-8")))
            header = next(reader, None)
            if header != FIELDS_311:
                raise PipelineError(f"Unexpected CSV header for {win.label}: {header}")
            n = 0
            for row in reader:
                writer.writerow(row)
                n += 1
            rows += n
            log("page_fetched", month=win.label, offset=offset, rows=n, elapsed_s=round(time.time() - t0, 1))
            if n < PAGE_SIZE:
                break
            offset += PAGE_SIZE
    tmp.replace(path)  # atomic: a half-written month never looks complete
    meta_path.write_text(json.dumps({"rows": rows, "fetched_at_epoch": time.time(), "window": [win.start.isoformat(), win.end.isoformat()]}))
    log("month_fetched", month=win.label, rows=rows, elapsed_s=round(time.time() - t0, 1))
    return path


def fetch_boundary(soda: Soda, dataset_id: str, cache_dir: Path) -> tuple[Path, dict[str, Any]]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    r = soda.get(f"/resource/{dataset_id}.geojson", params={"$limit": "5000"})
    gj = r.json()
    if gj.get("type") != "FeatureCollection" or not gj.get("features"):
        raise PipelineError(f"Boundary {dataset_id} did not return a GeoJSON FeatureCollection")
    path = cache_dir / f"{dataset_id}.geojson"
    path.write_text(json.dumps(gj))
    return path, gj


# --------------------------------------------------------------------------- normalization


def type_key(raw: str | None) -> str:
    """Case- and whitespace-insensitive key for a complaint type."""
    return re.sub(r"\s+", " ", (raw or "").strip()).lower()


def choose_display(variants: dict[str, int]) -> str:
    """Pick one display form for a group of raw spellings.

    Prefer the most common spelling that is not ALL CAPS (plain language reads
    better); fall back to the most common spelling. Ties break alphabetically so
    the result is deterministic.
    """
    if not variants:
        return ""
    cleaned: dict[str, int] = {}
    for k, v in variants.items():
        k2 = re.sub(r"\s+", " ", k.strip())
        cleaned[k2] = cleaned.get(k2, 0) + v
    ranked = sorted(cleaned.items(), key=lambda kv: (-kv[1], kv[0]))
    mixed = [k for k, _ in ranked if k != k.upper()]
    return mixed[0] if mixed else ranked[0][0]


MAP_COLUMNS = ["type_key", "display", "reviewed", "raw_variants"]


def merge_type_map(existing: list[dict[str, str]], counts_by_raw: dict[str, int]) -> list[dict[str, str]]:
    """Merge newly seen raw complaint types into the reviewed mapping.

    Existing rows keep their display and reviewed flag (a human may have edited
    them). New keys are appended with reviewed=false. raw_variants is the union.
    Output is sorted by type_key so reruns are byte-identical.
    """
    by_key: dict[str, dict[str, str]] = {r["type_key"]: dict(r) for r in existing}
    groups: dict[str, dict[str, int]] = {}
    for raw, n in counts_by_raw.items():
        if raw is None or not raw.strip():
            continue
        groups.setdefault(type_key(raw), {})[raw] = n
    for key, variants in groups.items():
        if key in by_key:
            row = by_key[key]
            seen = set(filter(None, row.get("raw_variants", "").split("|")))
            row["raw_variants"] = "|".join(sorted(seen | set(variants)))
        else:
            by_key[key] = {
                "type_key": key,
                "display": choose_display(variants),
                "reviewed": "false",
                "raw_variants": "|".join(sorted(variants)),
            }
    return [by_key[k] for k in sorted(by_key)]


def read_type_map(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def write_type_map(path: Path, rows: list[dict[str, str]]) -> bool:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=MAP_COLUMNS, lineterminator="\n")
    w.writeheader()
    for r in rows:
        w.writerow({k: r.get(k, "") for k in MAP_COLUMNS})
    new = buf.getvalue()
    if path.exists() and path.read_text(encoding="utf-8") == new:
        return False
    path.write_text(new, encoding="utf-8")
    return True


# --------------------------------------------------------------------------- labels


def cd_label(boro_cd: int) -> tuple[str, bool, str]:
    boro, num = divmod(int(boro_cd), 100)
    name = BOROUGHS.get(boro, f"Borough {boro}")
    if num > MAX_CD.get(boro, 18):
        return f"{name} Joint Interest Area {boro_cd}", True, name
    return f"{name} CD {num}", False, name


def cc_label(coundist: int) -> str:
    return f"Council District {int(coundist)}"


def parse_city_board(text: str | None) -> int | None:
    """'02 BROOKLYN' -> 302. 'Unspecified BROOKLYN' / '0 Unspecified' -> None."""
    if not text:
        return None
    m = re.match(r"^\s*(\d{1,2})\s+(MANHATTAN|BRONX|BROOKLYN|QUEENS|STATEN ISLAND)\s*$", text.upper())
    if not m:
        return None
    num = int(m.group(1))
    if num == 0:
        return None
    return BOROUGH_CODE_BY_NAME[m.group(2)] * 100 + num


# --------------------------------------------------------------------------- SQL pieces

# days_to_close: fractional days between created and closed, NULL when the
# request is open, or when the dates are impossible (closed before it was
# created, or closed in the future). The reason goes in close_flag.
DAYS_TO_CLOSE_SQL = """
    CASE
        WHEN closed_date IS NULL OR created_date IS NULL THEN NULL
        WHEN closed_date < created_date THEN NULL
        WHEN closed_date > {now} THEN NULL
        ELSE (epoch(closed_date) - epoch(created_date)) / 86400.0
    END
"""
CLOSE_FLAG_SQL = """
    CASE
        WHEN closed_date IS NULL THEN NULL
        WHEN created_date IS NOT NULL AND closed_date < created_date THEN 'closed_before_created'
        WHEN closed_date > {now} THEN 'closed_in_future'
        ELSE NULL
    END
"""


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    # https://duckdb.org/docs/stable/core_extensions/spatial/overview
    con.sql("INSTALL spatial; LOAD spatial;")
    return con


def load_boundaries(con: duckdb.DuckDBPyConnection, cd_path: Path, cc_path: Path) -> None:
    # ST_Read is a table function that reads any GDAL format, GeoJSON included
    # (https://duckdb.org/docs/2.0/core_extensions/spatial/functions.html#st_read).
    con.execute(f"CREATE OR REPLACE TABLE cd_poly AS SELECT CAST(boro_cd AS INTEGER) AS id, geom FROM ST_Read({sql_str(str(cd_path))})")
    con.execute(f"CREATE OR REPLACE TABLE cc_poly AS SELECT CAST(coundist AS INTEGER) AS id, geom FROM ST_Read({sql_str(str(cc_path))})")


def assign_points(con: duckdb.DuckDBPyConnection, point_table: str = "pts") -> None:
    """Point-in-polygon for distinct (lon, lat) pairs.

    ST_Contains(polygon, point) per https://duckdb.org/docs/2.0/core_extensions/spatial/functions.html#st_contains.
    A point on a shared edge can fall in two polygons; we take the lowest id so
    the result is deterministic.
    """
    con.execute(f"""
        CREATE OR REPLACE TABLE pt_assign AS
        WITH g AS (SELECT lon, lat, ST_Point(lon, lat) AS geom FROM {point_table}),
        a AS (SELECT g.lon, g.lat, min(c.id) AS cd FROM g JOIN cd_poly c ON ST_Contains(c.geom, g.geom) GROUP BY ALL),
        b AS (SELECT g.lon, g.lat, min(c.id) AS cc FROM g JOIN cc_poly c ON ST_Contains(c.geom, g.geom) GROUP BY ALL)
        SELECT p.lon, p.lat, a.cd, b.cc
        FROM {point_table} p
        LEFT JOIN a USING (lon, lat)
        LEFT JOIN b USING (lon, lat)
    """)


def sql_str(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def build(
    csv_paths: list[Path],
    cd_path: Path,
    cc_path: Path,
    type_map_path: Path,
    out_dir: Path,
    start: dt.date,
    end_inclusive: dt.date,
    sources: dict[str, Any],
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    """Everything after the download. Offline; the tests call this directly."""
    t0 = time.time()
    now = now or dt.datetime.now(dt.UTC)
    # created/closed dates are floating NYC local time; compare "now" in the same frame.
    now_local_naive = now.astimezone(ZoneInfo("America/New_York")).replace(tzinfo=None)
    now_sql = f"TIMESTAMP '{now_local_naive.isoformat(sep=' ', timespec='seconds')}'"

    con = connect()
    load_boundaries(con, cd_path, cc_path)

    files = "[" + ",".join(sql_str(str(p)) for p in csv_paths) + "]"
    end_excl = end_inclusive + dt.timedelta(days=1)
    con.execute(f"""
        CREATE OR REPLACE TABLE raw AS
        SELECT * FROM read_csv({files}, header = true, all_varchar = true)
        WHERE TRY_CAST(created_date AS TIMESTAMP) >= DATE '{start}'
          AND TRY_CAST(created_date AS TIMESTAMP) <  DATE '{end_excl}'
        QUALIFY row_number() OVER (PARTITION BY unique_key ORDER BY closed_date DESC NULLS LAST) = 1
    """)
    total = con.execute("SELECT count(*) FROM raw").fetchone()[0]
    log("rows_loaded", rows=total, elapsed_s=round(time.time() - t0, 1))
    if total == 0:
        raise PipelineError("No 311 rows in the requested window; refusing to write empty outputs.")

    # Complaint type mapping (reviewed CSV, seeded automatically).
    counts = dict(con.execute("SELECT complaint_type, count(*) FROM raw GROUP BY 1").fetchall())
    merged = merge_type_map(read_type_map(type_map_path), counts)
    changed = write_type_map(type_map_path, merged)
    con.execute("CREATE OR REPLACE TABLE type_map (raw VARCHAR, display VARCHAR)")
    pairs = []
    by_key = {r["type_key"]: r["display"] for r in merged}
    for raw in counts:
        if raw is not None and raw.strip():
            pairs.append((raw, by_key[type_key(raw)]))
    if pairs:
        con.executemany("INSERT INTO type_map VALUES (?, ?)", pairs)
    unreviewed = sum(1 for r in merged if r.get("reviewed", "false").lower() != "true")
    log("type_map", keys=len(merged), raw_spellings=len(pairs), file_changed=changed, unreviewed=unreviewed)

    con.execute(f"""
        CREATE OR REPLACE TABLE pts AS
        SELECT DISTINCT TRY_CAST(longitude AS DOUBLE) AS lon, TRY_CAST(latitude AS DOUBLE) AS lat
        FROM raw
        WHERE TRY_CAST(longitude AS DOUBLE) BETWEEN {NYC_BBOX['lon_min']} AND {NYC_BBOX['lon_max']}
          AND TRY_CAST(latitude AS DOUBLE)  BETWEEN {NYC_BBOX['lat_min']} AND {NYC_BBOX['lat_max']}
    """)
    t1 = time.time()
    assign_points(con)
    log("points_assigned", distinct_points=con.execute("SELECT count(*) FROM pts").fetchone()[0], elapsed_s=round(time.time() - t1, 1))

    # City community_board text -> boro_cd, parsed in Python (one place, tested) for the few distinct values.
    boards = [r[0] for r in con.execute("SELECT DISTINCT community_board FROM raw WHERE community_board IS NOT NULL").fetchall()]
    con.execute("CREATE OR REPLACE TABLE board_map (community_board VARCHAR, city_cd INTEGER)")
    if boards:
        con.executemany("INSERT INTO board_map VALUES (?, ?)", [(b, parse_city_board(b)) for b in boards])
    con.execute(f"""
        CREATE OR REPLACE TABLE req AS
        WITH r AS (
            SELECT
                unique_key,
                TRY_CAST(created_date AS TIMESTAMP) AS created_date,
                TRY_CAST(closed_date AS TIMESTAMP) AS closed_date,
                agency, agency_name,
                coalesce(m.display, nullif(trim(raw.complaint_type), ''), '(none)') AS complaint_type,
                raw.complaint_type AS complaint_type_raw,
                descriptor, descriptor_2, status,
                incident_address, street_name, intersection_street_1, intersection_street_2,
                incident_zip, bbl, borough, community_board,
                TRY_CAST(council_district AS INTEGER) AS council_district,
                TRY_CAST(latitude AS DOUBLE) AS latitude,
                TRY_CAST(longitude AS DOUBLE) AS longitude,
                resolution_description
            FROM raw LEFT JOIN type_map m ON raw.complaint_type = m.raw
        )
        SELECT r.*,
            a.cd, a.cc,
            {DAYS_TO_CLOSE_SQL.format(now=now_sql)} AS days_to_close,
            {CLOSE_FLAG_SQL.format(now=now_sql)} AS close_flag,
            bm.city_cd,
            nullif(upper(regexp_replace(trim(incident_address), '\\s+', ' ', 'g')), '') AS address_norm,
            strftime(created_date, '%Y-%m') AS year_month
        FROM r LEFT JOIN pt_assign a ON r.longitude = a.lon AND r.latitude = a.lat
               LEFT JOIN board_map bm ON r.community_board = bm.community_board
        ORDER BY created_date, unique_key
    """)
    con.execute("DROP TABLE raw")

    out_dir.mkdir(parents=True, exist_ok=True)
    for sub in ("boundaries", "detail/cd", "detail/cc", "agg"):
        (out_dir / sub).mkdir(parents=True, exist_ok=True)
    # Remove stale detail files from an earlier run so the folder matches the manifest.
    for old in list((out_dir / "detail").rglob("*.parquet")):
        old.unlink()

    detail_cols = """unique_key, created_date, closed_date, agency, agency_name, complaint_type, complaint_type_raw,
        descriptor, descriptor_2, status, incident_address, street_name, intersection_street_1, intersection_street_2,
        incident_zip, bbl, borough, community_board, council_district, latitude, longitude, resolution_description,
        cd, cc, city_cd, days_to_close, close_flag, address_norm, year_month"""
    # COPY ... TO with FORMAT parquet: https://duckdb.org/docs/stable/data/parquet/overview#writing-to-parquet-files
    parquet_opts = "(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 50000)"

    districts: dict[str, list[dict[str, Any]]] = {"cd": [], "cc": []}
    cd_ids = [r[0] for r in con.execute("SELECT id FROM cd_poly ORDER BY id").fetchall()]
    cc_ids = [r[0] for r in con.execute("SELECT id FROM cc_poly ORDER BY id").fetchall()]
    unlocated_city = dict(con.execute("SELECT city_cd, count(*) FROM req WHERE cd IS NULL AND city_cd IS NOT NULL GROUP BY 1").fetchall())
    for kind, ids in (("cd", cd_ids), ("cc", cc_ids)):
        for gid in ids:
            n = con.execute(f"SELECT count(*) FROM req WHERE {kind} = ?", [gid]).fetchone()[0]
            path = out_dir / "detail" / kind / f"{gid}.parquet"
            if n:
                con.execute(f"COPY (SELECT {detail_cols} FROM req WHERE {kind} = {int(gid)} ORDER BY created_date, unique_key) TO {sql_str(str(path))} {parquet_opts}")
            entry: dict[str, Any] = {"id": gid, "rows": n, "file": f"detail/{kind}/{gid}.parquet" if n else None}
            if kind == "cd":
                label, jia, boro = cd_label(gid)
                entry.update(label=label, jia=jia, borough=boro, unlocated_city_assigned=unlocated_city.get(gid, 0))
            else:
                entry.update(label=cc_label(gid))
                dom = con.execute(
                    "SELECT cd // 100 AS b, count(*) FROM req WHERE cc = ? AND cd IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1", [gid]
                ).fetchone()
                entry["borough"] = BOROUGHS.get(dom[0]) if dom else None
            districts[kind].append(entry)
    log("detail_written", cd_files=sum(1 for d in districts["cd"] if d["file"]), cc_files=sum(1 for d in districts["cc"] if d["file"]))

    # Aggregates for the Compare panel. Located rows only, so district, borough
    # and city shares are computed over the same population.
    boro_case = "CASE cd // 100 " + " ".join(f"WHEN {k} THEN {sql_str(v)}" for k, v in BOROUGHS.items()) + " END"
    con.execute(f"""
        COPY (
            SELECT 'cd' AS geo_kind, CAST(cd AS VARCHAR) AS geo_id, year_month, complaint_type, count(*) AS n FROM req WHERE cd IS NOT NULL GROUP BY ALL
            UNION ALL
            SELECT 'cc', CAST(cc AS VARCHAR), year_month, complaint_type, count(*) FROM req WHERE cc IS NOT NULL GROUP BY ALL
            UNION ALL
            SELECT 'borough', {boro_case}, year_month, complaint_type, count(*) FROM req WHERE cd IS NOT NULL GROUP BY ALL
            UNION ALL
            SELECT 'city', 'nyc', year_month, complaint_type, count(*) FROM req WHERE cd IS NOT NULL GROUP BY ALL
            ORDER BY 1, 2, 3, 4
        ) TO {sql_str(str(out_dir / 'agg' / 'month_type.parquet'))} {parquet_opts}
    """)

    # Address lookup: addresses exactly as they appear in 311 data. NOT a geocoder.
    con.execute(f"""
        COPY (
            SELECT address_norm AS address, incident_zip AS zip,
                   mode(cd) AS cd, mode(cc) AS cc, mode({boro_case}) AS borough, count(*) AS n
            FROM req WHERE address_norm IS NOT NULL AND cd IS NOT NULL
            GROUP BY ALL ORDER BY address, zip
        ) TO {sql_str(str(out_dir / 'addresses.parquet'))} {parquet_opts}
    """)

    write_boundaries(con, out_dir / "boundaries")

    stats = con.execute(f"""
        SELECT count(*) AS total,
               count(*) FILTER (WHERE latitude BETWEEN {NYC_BBOX['lat_min']} AND {NYC_BBOX['lat_max']}
                                  AND longitude BETWEEN {NYC_BBOX['lon_min']} AND {NYC_BBOX['lon_max']}) AS with_coords,
               count(*) FILTER (WHERE cd IS NULL) AS no_cd,
               count(*) FILTER (WHERE cc IS NULL) AS no_cc,
               count(*) FILTER (WHERE close_flag = 'closed_before_created') AS closed_before_created,
               count(*) FILTER (WHERE close_flag = 'closed_in_future') AS closed_in_future,
               count(*) FILTER (WHERE closed_date IS NULL) AS open_no_close_date,
               min(created_date), max(created_date)
        FROM req
    """).fetchone()
    agreement = agreement_report(con)
    manifest = {
        "generated_at": now.astimezone(dt.UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "generator": f"{SCRIPT} (duckdb {duckdb.__version__})",
        "window": {"start": start.isoformat(), "end": end_inclusive.isoformat(),
                   "first_created": str(stats[7]), "last_created": str(stats[8])},
        "sources": sources,
        "counts": {
            "total": stats[0],
            "with_coords": stats[1],
            "without_coords": stats[0] - stats[1],
            "not_in_any_cd": stats[2],
            "not_in_any_cc": stats[3],
            "closed_before_created": stats[4],
            "closed_in_future": stats[5],
            "no_close_date": stats[6],
        },
        "agreement": agreement,
        "complaint_types": {"groups": len(merged), "unreviewed": unreviewed},
        "districts": districts,
        "boroughs": list(BOROUGHS.values()),
        "notes": [
            "Every located request is assigned to a Community District and a Council District by our own point-in-polygon join against the current DCP boundaries listed in sources.",
            "Requests without usable coordinates are counted but not placed in any district file.",
            "311 counts reflect who reports problems and how, not only how many problems exist.",
        ],
    }
    manifest["files"] = {str(p.relative_to(out_dir)): p.stat().st_size for p in sorted(out_dir.rglob("*")) if p.is_file() and p.suffix in (".parquet", ".geojson")}
    validate_manifest(manifest)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str))
    (out_dir / "build-log.md").write_text(agreement_markdown(manifest))
    log("build_done", elapsed_s=round(time.time() - t0, 1), total=stats[0])
    return manifest


def agreement_report(con: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    cc = con.execute("""
        SELECT count(*) FILTER (WHERE cc IS NOT NULL AND council_district IS NOT NULL),
               count(*) FILTER (WHERE cc IS NOT NULL AND council_district IS NOT NULL AND cc = council_district),
               count(*) FILTER (WHERE cc IS NOT NULL AND council_district IS NULL)
        FROM req
    """).fetchone()
    cd = con.execute("""
        SELECT count(*) FILTER (WHERE cd IS NOT NULL AND city_cd IS NOT NULL),
               count(*) FILTER (WHERE cd IS NOT NULL AND city_cd IS NOT NULL AND cd = city_cd),
               count(*) FILTER (WHERE cd IS NOT NULL AND city_cd IS NULL)
        FROM req
    """).fetchone()
    by_month = con.execute("""
        SELECT year_month,
               count(*) FILTER (WHERE cc IS NOT NULL AND council_district IS NOT NULL) AS cmp,
               count(*) FILTER (WHERE cc IS NOT NULL AND council_district IS NOT NULL AND cc = council_district) AS ok
        FROM req GROUP BY 1 ORDER BY 1
    """).fetchall()

    def share(ok: int, n: int) -> float | None:
        return round(ok / n, 4) if n else None

    return {
        "council": {"compared": cc[0], "matches": cc[1], "share": share(cc[1], cc[0]), "city_value_missing": cc[2],
                    "by_month": [{"year_month": m, "compared": n, "share": share(o, n)} for m, n, o in by_month]},
        "community_district": {"compared": cd[0], "matches": cd[1], "share": share(cd[1], cd[0]), "city_value_missing": cd[2]},
    }


def agreement_markdown(m: dict[str, Any]) -> str:
    a = m["agreement"]
    lines = [
        "# BoardStat 2.0 build log",
        "",
        f"Generated {m['generated_at']} for {m['window']['start']} to {m['window']['end']}.",
        "",
        "## Agreement with the city's own district fields",
        "",
        "| Field | Rows compared | Match | Share | City field blank |",
        "|---|---:|---:|---:|---:|",
        f"| Council district (ours vs `council_district`) | {a['council']['compared']:,} | {a['council']['matches']:,} | {fmt_share(a['council']['share'])} | {a['council']['city_value_missing']:,} |",
        f"| Community district (ours vs `community_board`) | {a['community_district']['compared']:,} | {a['community_district']['matches']:,} | {fmt_share(a['community_district']['share'])} | {a['community_district']['city_value_missing']:,} |",
        "",
        "Council agreement by month:",
        "",
        "| Month | Compared | Share |",
        "|---|---:|---:|",
    ]
    for r in a["council"]["by_month"]:
        lines.append(f"| {r['year_month']} | {r['compared']:,} | {fmt_share(r['share'])} |")
    c = m["counts"]
    lines += ["", "## Counts", "", *[f"- {k}: {v:,}" for k, v in c.items()], ""]
    return "\n".join(lines)


def fmt_share(s: float | None) -> str:
    return "n/a" if s is None else f"{s * 100:.2f}%"


def write_boundaries(con: duckdb.DuckDBPyConnection, out: Path, tolerance: float = 0.0001) -> None:
    """Simplified web boundaries. ~0.0001 degrees is about 10 m.

    ST_SimplifyPreserveTopology keeps each polygon valid but simplifies
    neighbors independently, so shared edges may show hairline gaps at high
    zoom. ST_ReducePrecision trims coordinates to ~1 m.
    (https://duckdb.org/docs/2.0/core_extensions/spatial/functions.html)
    """
    for kind, table in (("cd", "cd_poly"), ("cc", "cc_poly")):
        feats = []
        rows = con.execute(f"""
            SELECT id, ST_AsGeoJSON(ST_ReducePrecision(ST_SimplifyPreserveTopology(geom, {tolerance}), 0.00001))
            FROM {table} ORDER BY id
        """).fetchall()
        for gid, geom in rows:
            if kind == "cd":
                label, jia, boro = cd_label(gid)
                props = {"id": gid, "label": label, "jia": jia, "borough": boro}
            else:
                props = {"id": gid, "label": cc_label(gid), "jia": False}
            feats.append({"type": "Feature", "id": gid, "properties": props, "geometry": json.loads(geom)})
        (out / f"{kind}.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))


REQUIRED_MANIFEST_KEYS = {
    "generated_at": str,
    "window": dict,
    "sources": dict,
    "counts": dict,
    "agreement": dict,
    "districts": dict,
    "files": dict,
}
REQUIRED_COUNT_KEYS = ("total", "with_coords", "without_coords")


def validate_manifest(m: dict[str, Any]) -> None:
    for k, t in REQUIRED_MANIFEST_KEYS.items():
        if k not in m or not isinstance(m[k], t):
            raise PipelineError(f"manifest missing or malformed key {k!r}")
    for k in REQUIRED_COUNT_KEYS:
        if k not in m["counts"]:
            raise PipelineError(f"manifest.counts missing {k!r}")
    for k in ("council", "community_district"):
        if k not in m["agreement"]:
            raise PipelineError(f"manifest.agreement missing {k!r}")


# --------------------------------------------------------------------------- main


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    today = dt.date.today()
    d_start, d_end = default_window(today)
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--start", type=dt.date.fromisoformat, default=d_start, help=f"first created date, inclusive (default {d_start})")
    p.add_argument("--end", type=dt.date.fromisoformat, default=d_end, help=f"last created date, inclusive (default {d_end})")
    p.add_argument("--out", type=Path, default=here.parent / "site" / "data")
    p.add_argument("--cache", type=Path, default=here / ".cache")
    p.add_argument("--type-map", type=Path, default=here / "complaint_type_map.csv")
    p.add_argument("--max-age-hours", type=float, default=12.0, help="refetch recent months older than this")
    p.add_argument("--refresh-all", action="store_true", help="ignore the month cache")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    t0 = time.time()
    token = os.environ.get("SOCRATA_APP_TOKEN") or None
    log("start", start=args.start, end=args.end, out=args.out, app_token="set" if token else "unset")
    soda = Soda(token=token)

    # 1. Schema check: never trust a dataset id silently.
    meta_311 = soda.metadata(DATASET_311)
    check_schema(meta_311, FIELDS_311, DATASET_311, name_hint="311 Service Requests")
    meta_cd = soda.metadata(DATASET_CD)
    check_schema(meta_cd, FIELDS_CD, DATASET_CD, name_hint="Community Districts")
    meta_cc = soda.metadata(DATASET_CC)
    check_schema(meta_cc, FIELDS_CC, DATASET_CC, name_hint="Council Districts")
    log("schema_ok", datasets=[DATASET_311, DATASET_CD, DATASET_CC])

    # 2. Boundaries.
    bdir = args.cache / "boundaries"
    cd_path, cd_gj = fetch_boundary(soda, DATASET_CD, bdir)
    cc_path, cc_gj = fetch_boundary(soda, DATASET_CC, bdir)
    log("boundaries", cd_features=len(cd_gj["features"]), cc_features=len(cc_gj["features"]))

    # 3. 311 rows, month by month.
    today = dt.date.today()
    max_age = 0.0 if args.refresh_all else args.max_age_hours
    paths = []
    for win in month_windows(args.start, args.end):
        if args.refresh_all:
            for p in args.cache.glob(f"311/{DATASET_311}_{win.start.isoformat()}_*"):
                p.unlink()
        paths.append(fetch_month(soda, win, args.cache / "311", today, max_age))
    log("download_done", months=len(paths), elapsed_s=round(time.time() - t0, 1))

    def src(meta: dict[str, Any], did: str, **extra: Any) -> dict[str, Any]:
        return {"id": did, "name": meta.get("name"), "url": f"{PORTAL}/d/{did}",
                "rowsUpdatedAt": meta.get("rowsUpdatedAt"), "rowsUpdatedAt_iso": epoch_to_iso(meta.get("rowsUpdatedAt")), **extra}

    sources = {
        "service_requests": src(meta_311, DATASET_311),
        "community_districts": src(meta_cd, DATASET_CD, version=boundary_version(meta_cd), features=len(cd_gj["features"])),
        "council_districts": src(meta_cc, DATASET_CC, version=boundary_version(meta_cc), features=len(cc_gj["features"])),
    }
    manifest = build(paths, cd_path, cc_path, args.type_map, args.out, args.start, args.end, sources)
    manifest_elapsed = round(time.time() - t0, 1)
    print(agreement_markdown(manifest))
    log("done", total_elapsed_s=manifest_elapsed)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PipelineError as exc:
        log("failed", error=str(exc))
        print(f"\nBoardStat build FAILED: {exc}", file=sys.stderr)
        sys.exit(2)
