#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11,<3.16"
# dependencies = [
#     "duckdb>=2.0,<3",
#     "requests>=2.32,<3",
# ]
# ///
"""BoardStat 2.0 nightly refresh: pick up new AND changed 311 rows, rebuild, publish.

The city changes old rows every night (a request closes, a status changes, a
date is fixed). The month cache in ``boardstat_build.py`` re-downloads only
recent months, so on its own an old request that closes later would stay
"open". This script closes that gap (issue #107):

1. Ask the portal for every row whose Socrata system field ``:updated_at`` is
   newer than the last run (https://dev.socrata.com/docs/system-fields),
   from the fixed history start (2020-01-01, ``--start``) through today.
2. Patch those rows into the cached month files, replacing by ``unique_key``.
3. Save the night's diff (new rows, updated rows, old and new status).
4. Once a week, compare each cached month's row count with the city's and
   move aside any month that does not match, so the build re-downloads it
   (``:updated_at`` cannot show a row the city deleted).
5. Run the normal build into a local folder, add ``changes.json`` (what
   changed since the last publish, citywide and per district).
6. With ``--publish``: upload to ``data-next/`` on beta.nyc, then swap it with
   ``data/`` in one quick step, so visitors never see half-old, half-new data.
7. With ``--notify CHANNEL``: tell staff on Discord (Rosie) when something
   fails or looks wrong. Off by default.

Run from the repository root:

    uv run v2/pipeline/boardstat_nightly.py --publish --notify ops-website

Secrets come from the environment (``SOCRATA_APP_TOKEN``, ``DISCORD_TOKEN``);
``nightly.sh`` reads them from the macOS Keychain. Neither is ever logged.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boardstat_build as bb  # noqa: E402

SCRIPT = "boardstat_nightly"
NYC = ZoneInfo("America/New_York")
HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

# Server layout (see team hosting notes): the site lives in beta.nyc/boardstat/v2/.
SSH_KEY = Path.home() / ".ssh" / "id_ed25519_betanyc_dreampress"
SSH_HOST = "wp_iz4gh3@dp-6803fc88d2.dreamhostps.com"
REMOTE_DIR = "beta.nyc/boardstat/v2"
PUBLIC_MANIFEST = "https://www.beta.nyc/boardstat/v2/data/manifest.json"

# Rosie's poster lives in the BetaNYC AI workspace.
ROSIE = Path.home() / "Code" / "BetaNYC_AI_Workspace" / "scripts" / "discord_rosie_post.py"

# Alert thresholds.
SPIKE_ROWS = 200_000  # a catch-up night; publish, but say so
MAX_DROP = 0.05  # refuse to publish if total requests fall by more than 5%


def log(event: str, **fields: Any) -> None:
    rec = {"script": SCRIPT, "event": event, "ts": dt.datetime.now(dt.UTC).isoformat(timespec="seconds")}
    rec.update(fields)
    print(json.dumps(rec, default=str), file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- window and state


def rolling_window(today: dt.date, years: int = 3) -> tuple[dt.date, dt.date]:
    """First day of the same month ``years`` back, through today (only with ``--years``)."""
    return dt.date(today.year - years, today.month, 1), today


def run_window(today: dt.date, start: dt.date | None, years: int | None) -> tuple[dt.date, dt.date]:
    """The window to refresh: a fixed start (the default, 2020-01-01) through today.

    ``--years`` keeps the old rolling window for tests and one-off runs. A start
    before 2020 fails loudly: those months are in a dataset this job does not read.
    """
    if years is not None:
        win = rolling_window(today, years)
    else:
        win = (start or bb.HISTORY_START, today)
    bb.check_start(win[0])
    return win


def load_state(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text()) if path.exists() else {}


def save_state(path: Path, state: dict[str, Any]) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(path)


def initial_watermark(cache_311: Path) -> str:
    """Before the first nightly run: an hour before the oldest cached month was fetched.

    Re-applying a row that did not change is harmless, so erring early is safe.
    """
    stamps = [json.loads(p.read_text())["fetched_at_epoch"] for p in cache_311.glob(f"{bb.DATASET_311}_*.csv.json")]
    if not stamps:
        raise bb.PipelineError(f"No cached months in {cache_311}; run boardstat_build.py once first.")
    t = dt.datetime.fromtimestamp(min(stamps) - 3600, tz=dt.UTC)
    return t.strftime("%Y-%m-%dT%H:%M:%S")


# --------------------------------------------------------------------------- fetch changes


def fetch_changes(soda: bb.Soda, since: str, start: dt.date, end_inclusive: dt.date, out: Path) -> int:
    """Every row in the window changed after ``since`` (UTC), to a gzipped CSV.

    ``:updated_at`` is a Socrata system field (https://dev.socrata.com/docs/system-fields);
    paging is ordered by the row id ``:id`` so it stays stable while we page.
    """
    end_excl = end_inclusive + dt.timedelta(days=1)
    cols = bb.FIELDS_311 + [":updated_at"]
    where = (f":updated_at > '{since}' AND created_date >= {bb.soql_ts(start)} AND created_date < {bb.soql_ts(end_excl)}")
    tmp = out.with_suffix(".tmp")
    rows, offset, t0 = 0, 0, time.time()
    with gzip.open(tmp, "wt", newline="", encoding="utf-8", compresslevel=3) as fh:
        w = csv.writer(fh)
        w.writerow(bb.FIELDS_311 + ["updated_at"])
        while True:
            params = {"$select": ",".join(cols), "$where": where, "$order": ":id", "$limit": str(bb.PAGE_SIZE), "$offset": str(offset)}
            r = soda.get(f"/resource/{bb.DATASET_311}.csv", params=params)
            reader = csv.reader(io.StringIO(r.content.decode("utf-8")))
            header = next(reader, None)
            if header != cols:
                raise bb.PipelineError(f"Unexpected CSV header for changed rows: {header}")
            n = 0
            for row in reader:
                w.writerow(row)
                n += 1
            rows += n
            log("changes_page", offset=offset, rows=n, elapsed_s=round(time.time() - t0, 1))
            if n < bb.PAGE_SIZE:
                break
            offset += bb.PAGE_SIZE
    tmp.replace(out)
    return rows


def next_watermark(since: str, max_updated_at: str | None) -> str:
    """The watermark to save: the newest ``:updated_at`` fetched, to the second.

    Truncating the milliseconds means ``> watermark`` re-fetches the last batch
    (rows stamped within that second) every night. That is deliberate: patching
    is idempotent, and it leaves a one-second margin for rows the city stamps
    in the same second after we read. ``record_night`` therefore judges a quiet
    night by whether the watermark moved, not by how many rows came back.
    """
    if not max_updated_at:
        return since
    return max(since, max_updated_at.rstrip("Z")[:19])


def record_night(state: dict[str, Any], since: str, max_updated_at: str | None, diff_rows: int) -> str | None:
    """Advance the watermark and the quiet-run counter; return the stall warning, if any.

    A night is quiet when nothing moved: the watermark did not advance AND the
    diff is empty. The fetched row count is not used, because it is never zero
    once the last batch is re-fetched (see ``next_watermark``). A city catch-up
    night that re-stamps many rows without changing them advances the
    watermark, so it is not quiet: the city is publishing.
    """
    wm = next_watermark(since, max_updated_at)
    state["watermark"] = wm
    quiet = wm == since and diff_rows == 0
    state["quiet_runs"] = state.get("quiet_runs", 0) + 1 if quiet else 0
    if state["quiet_runs"] >= 2:
        return (f"No new or changed 311 rows, and the city's last update stamp ({wm} UTC) has not moved, "
                f"for {state['quiet_runs']} runs in a row; the city may not be publishing.")
    return None


# --------------------------------------------------------------------------- patch the month cache


def month_files(cache_311: Path, month_start: dt.date) -> list[Path]:
    """Cached files for one month, newest window end last (the current month is renamed nightly)."""
    return sorted(cache_311.glob(f"{bb.DATASET_311}_{month_start.isoformat()}_*.csv.gz"))


def newest_cached_month(cache_311: Path) -> dt.date | None:
    """First day of the newest month with a cached file, or None if the cache is empty."""
    starts = [dt.date.fromisoformat(p.name.split("_")[1]) for p in cache_311.glob(f"{bb.DATASET_311}_*.csv.gz")]
    return max(starts, default=None)


def patch_cache(con: duckdb.DuckDBPyConnection, changes_csv: Path, cache_311: Path, start: dt.date, end_inclusive: dt.date) -> None:
    """Replace changed rows in each cached month file and build the ``diff`` table.

    ``diff`` has one row per changed request: kind 'new' (not in our copy) or
    'updated' (some field differs from our copy), with the old and new status.
    Rows the city re-stamped without changing anything (a catch-up night touches
    hundreds of thousands) are patched but left out of the diff. Rows in a month we have no file for
    are left to the build, which downloads that month whole. They count as new only when the month
    is newer than every cached month (a new month starting). A missing month older than that is a
    backfill (the history start moved earlier) or a month the weekly count check set aside; its
    rows are not tonight's changes, so they stay out of ``changes.json`` (logged as
    ``month_backfill``).
    """
    cols = ", ".join(bb.FIELDS_311)
    con.execute(f"""
        CREATE OR REPLACE TABLE chg AS
        SELECT * FROM read_csv({bb.sql_str(str(changes_csv))}, header = true, all_varchar = true)
        QUALIFY row_number() OVER (PARTITION BY unique_key ORDER BY updated_at DESC) = 1
    """)
    con.execute("CREATE OR REPLACE TABLE diff (unique_key VARCHAR, created_date VARCHAR, kind VARCHAR, old_status VARCHAR, new_status VARCHAR)")
    newest_cached = newest_cached_month(cache_311)
    for win in bb.month_windows(start, end_inclusive):
        lo, hi = win.start.isoformat(), win.end.isoformat()
        in_month = f"TRY_CAST(created_date AS TIMESTAMP) >= DATE '{lo}' AND TRY_CAST(created_date AS TIMESTAMP) < DATE '{hi}'"
        n = con.execute(f"SELECT count(*) FROM chg WHERE {in_month}").fetchone()[0]
        if not n:
            continue
        files = month_files(cache_311, win.start.replace(day=1))
        if not files:
            if newest_cached is not None and win.start.replace(day=1) < newest_cached:
                log("month_backfill", month=win.label, changed=n)
                continue
            con.execute(f"INSERT INTO diff SELECT unique_key, created_date, 'new', NULL, status FROM chg WHERE {in_month}")
            log("month_not_cached", month=win.label, changed=n)
            continue
        path = files[-1]
        con.execute(f"CREATE OR REPLACE TEMP TABLE old AS SELECT * FROM read_csv({bb.sql_str(str(path))}, header = true, all_varchar = true)")
        same = " AND ".join(f"o.{f} IS NOT DISTINCT FROM c.{f}" for f in bb.FIELDS_311)
        con.execute(f"""
            INSERT INTO diff
            SELECT c.unique_key, c.created_date, CASE WHEN o.unique_key IS NULL THEN 'new' ELSE 'updated' END, o.status, c.status
            FROM (SELECT * FROM chg WHERE {in_month}) c LEFT JOIN old o USING (unique_key)
            WHERE o.unique_key IS NULL OR NOT ({same})
        """)
        tmp = path.with_name("." + path.name)  # hidden, so no glob mistakes it for a month file
        con.execute(f"""
            COPY (
                SELECT {cols} FROM old WHERE unique_key NOT IN (SELECT unique_key FROM chg WHERE {in_month})
                UNION ALL
                SELECT {cols} FROM chg WHERE {in_month}
                ORDER BY unique_key
            ) TO {bb.sql_str(str(tmp))} (FORMAT csv, HEADER true, COMPRESSION gzip)
        """)
        rows = con.execute(f"SELECT count(*) FROM read_csv({bb.sql_str(str(tmp))}, header = true, all_varchar = true)").fetchone()[0]
        tmp.replace(path)  # atomic: a half-written month never replaces a good one
        meta_path = path.with_suffix(".json")
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
        meta.update({"rows": rows, "patched_at_epoch": time.time()})
        meta_path.write_text(json.dumps(meta))
        log("month_patched", month=win.label, file=path.name, changed=n, rows=rows)


# --------------------------------------------------------------------------- weekly count check


def check_counts(soda: bb.Soda, cache_311: Path, start: dt.date, end_inclusive: dt.date, today: dt.date, stale_dir: Path) -> list[str]:
    """Compare full cached months with the city's row counts; move mismatches aside.

    Returns the months moved. The build then downloads them whole.
    """
    moved = []
    for win in bb.month_windows(start, end_inclusive):
        if win.end > today.replace(day=1):  # the current month is re-downloaded anyway
            continue
        files = month_files(cache_311, win.start.replace(day=1))
        if not files:
            continue
        path = files[-1]
        ours = json.loads(path.with_suffix(".json").read_text())["rows"]
        r = soda.get(f"/resource/{bb.DATASET_311}.json", params={
            "$select": "count(*) AS n",
            "$where": f"created_date >= {bb.soql_ts(win.start)} AND created_date < {bb.soql_ts(win.end)}",
        })
        theirs = int(r.json()[0]["n"])
        if theirs != ours:
            stale_dir.mkdir(parents=True, exist_ok=True)
            for p in (path, path.with_suffix(".json")):
                shutil.move(str(p), stale_dir / f"{today.isoformat()}_{p.name}")
            moved.append(win.label)
            log("month_count_mismatch", month=win.label, ours=ours, city=theirs)
    return moved


# --------------------------------------------------------------------------- what changed


def write_changes(con: duckdb.DuckDBPyConnection, diff_files: list[Path], out_dir: Path, since: str | None, now_iso: str) -> dict[str, Any]:
    """``changes.json``: new, updated and newly closed requests since the last publish.

    "Closed" counts requests whose status is now Closed and was not before
    (including new rows that arrive already closed). Districts come from the
    rebuilt detail files, so they match the rest of the site.
    """
    files = "[" + ",".join(bb.sql_str(str(p)) for p in diff_files) + "]"
    con.execute(f"""
        CREATE OR REPLACE TABLE d AS
        SELECT unique_key,
               arg_min(kind, run) AS kind,              -- first sighting decides new vs updated
               arg_min(old_status, run) AS old_status,  -- status before the first change
               arg_max(new_status, run) AS new_status   -- status after the last change
        FROM read_parquet({files}) GROUP BY unique_key
    """)
    con.execute(f"""
        CREATE OR REPLACE TABLE loc AS
        SELECT CAST(unique_key AS VARCHAR) AS unique_key, cd, cc
        FROM read_parquet({bb.sql_str(str(out_dir / 'detail' / 'cd' / '*.parquet'))})
    """)
    agg = """count(*) FILTER (WHERE kind = 'new') AS new,
             count(*) FILTER (WHERE kind = 'updated') AS updated,
             count(*) FILTER (WHERE new_status = 'Closed' AND old_status IS DISTINCT FROM 'Closed') AS closed"""
    city = con.execute(f"SELECT {agg} FROM d").fetchone()
    out: dict[str, Any] = {
        "generated_at": now_iso,
        "since": since,
        "city": dict(zip(("new", "updated", "closed"), city)),
    }
    for kind in ("cd", "cc"):
        rows = con.execute(f"SELECT {kind}, {agg} FROM d JOIN loc USING (unique_key) WHERE {kind} IS NOT NULL GROUP BY 1").fetchall()
        out[kind] = {str(r[0]): {"new": r[1], "updated": r[2], "closed": r[3]} for r in rows}
    (out_dir / "changes.json").write_text(json.dumps(out, indent=1))
    log("changes_written", since=since, **out["city"])
    return out


# --------------------------------------------------------------------------- publish


def ssh(cmd: str) -> str:
    r = subprocess.run(["ssh", "-i", str(SSH_KEY), "-o", "BatchMode=yes", SSH_HOST, cmd], capture_output=True, text=True, timeout=600)
    if r.returncode:
        raise bb.PipelineError(f"ssh failed ({r.returncode}): {r.stderr.strip()[:300]}")
    return r.stdout


def publish(out_dir: Path) -> None:
    """Upload to data-next/, then swap it with data/. Nothing is deleted on the server
    except stale files inside data-next/ itself; the previous data/ becomes the next data-next/.
    """
    t0 = time.time()
    r = subprocess.run([
        "rsync", "-a", "--delete", "--chmod=D755,F644", "--exclude", "basemap", "--exclude", ".gitkeep",
        "-e", f"ssh -i {SSH_KEY} -o BatchMode=yes",
        f"{out_dir}/", f"{SSH_HOST}:{REMOTE_DIR}/data-next/",
    ], capture_output=True, text=True, timeout=7200)
    if r.returncode:
        raise bb.PipelineError(f"rsync failed ({r.returncode}): {r.stderr.strip()[:300]}")
    log("uploaded", elapsed_s=round(time.time() - t0, 1))
    ssh(
        f"set -e; cd {REMOTE_DIR}; "
        "test -f data-next/manifest.json; test -d data/basemap; test ! -e data-old; "
        "mv data/basemap data-next/basemap; mv data data-old; mv data-next data; mv data-old data-next"
    )
    log("swapped")


def verify_live(generated_at: str) -> None:
    import requests

    for attempt in range(1, 6):
        try:
            r = requests.get(PUBLIC_MANIFEST, params={"nocache": str(time.time())}, timeout=60)
            if r.ok and r.json().get("generated_at") == generated_at:
                log("live_verified", generated_at=generated_at)
                return
        except (*bb.RETRYABLE, ValueError) as exc:  # ValueError: a half-written manifest that is not JSON yet
            log("http_retry", path=PUBLIC_MANIFEST, attempt=attempt, status=None, wait_s=10, error=str(exc)[:200])
        time.sleep(10)
    raise bb.PipelineError(f"Published, but {PUBLIC_MANIFEST} does not show generated_at {generated_at}")


# --------------------------------------------------------------------------- alerts


def notify(channel: str | None, text: str) -> None:
    """One plain-text line to staff via Rosie (kind 'failure' lands in the channel itself).
    Never raises: an alert that fails must not hide the real outcome."""
    log("notify", channel=channel, text=text)
    if not channel:
        return
    if not ROSIE.exists() or not os.environ.get("DISCORD_TOKEN"):
        log("notify_unavailable", rosie=str(ROSIE), token="set" if os.environ.get("DISCORD_TOKEN") else "unset")
        return
    try:
        subprocess.run(["uv", "run", "--quiet", "python", str(ROSIE), "--channel", channel, "--kind", "failure", "--text", text, "--live"],
                       cwd=str(ROSIE.parent.parent), capture_output=True, text=True, timeout=120, check=True)
    except Exception as exc:  # noqa: BLE001
        log("notify_failed", error=str(exc)[:300])


# --------------------------------------------------------------------------- main


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--cache", type=Path, default=HERE / ".cache")
    p.add_argument("--out", type=Path, default=REPO / "v2" / "data-nightly", help="local build folder (what gets uploaded)")
    p.add_argument("--type-map", type=Path, default=HERE / "complaint_type_map.csv")
    when = p.add_mutually_exclusive_group()
    when.add_argument("--start", type=dt.date.fromisoformat, default=None,
                      help=f"first created date (default {bb.HISTORY_START}, fixed; earlier fails until 2010-2019 is supported)")
    when.add_argument("--years", type=int, default=None, help="rolling window instead of a fixed start (tests, one-off runs)")
    p.add_argument("--today", type=dt.date.fromisoformat, default=None, help="override today's date (NYC), for tests")
    p.add_argument("--check-counts", choices=["auto", "yes", "no"], default="auto", help="weekly city count check; auto = Sundays")
    p.add_argument("--publish", action="store_true", help="upload to beta.nyc and swap it live")
    p.add_argument("--notify", metavar="CHANNEL", default=None, help="Discord channel name for alerts (off by default)")
    return p.parse_args(argv)


def run(args: argparse.Namespace) -> int:
    t0 = time.time()
    now = dt.datetime.now(dt.UTC)
    today = args.today or now.astimezone(NYC).date()
    start, end = run_window(today, args.start, args.years)
    nightly = args.cache / "nightly"
    nightly.mkdir(parents=True, exist_ok=True)
    state_path = nightly / "state.json"
    state = load_state(state_path)
    cache_311 = args.cache / "311"
    since = state.get("watermark") or initial_watermark(cache_311)
    token = os.environ.get("SOCRATA_APP_TOKEN") or None
    log("start", start=start, end=end, since=since, publish=args.publish, notify=args.notify, app_token="set" if token else "unset")
    soda = bb.Soda(token=token)
    con = duckdb.connect()
    warnings: list[str] = []

    # 1-3. Changed rows -> patched months -> the night's diff.
    run_id = now.strftime("%Y%m%dT%H%M%SZ")
    changes_csv = nightly / f"changes-{run_id}.csv.gz"
    changed = fetch_changes(soda, since, start, end, changes_csv)
    patch_cache(con, changes_csv, cache_311, start, end)
    diff_path = nightly / "diffs" / f"{run_id}.parquet"
    diff_path.parent.mkdir(exist_ok=True)
    con.execute(f"COPY (SELECT *, {bb.sql_str(run_id)} AS run FROM diff) TO {bb.sql_str(str(diff_path))} (FORMAT parquet)")
    kinds = dict(con.execute("SELECT kind, count(*) FROM diff GROUP BY 1").fetchall())
    diff_rows = sum(kinds.values())
    log("diff_saved", file=diff_path.name, changed=changed, diff_rows=diff_rows, **kinds)
    new_wm = con.execute("SELECT max(updated_at) FROM chg").fetchone()[0]
    changes_csv.unlink()  # the diff keeps what matters; the raw download is re-creatable
    stall = record_night(state, since, new_wm, diff_rows)
    state["last_run"] = now.isoformat(timespec="seconds")
    save_state(state_path, state)
    if stall:
        warnings.append(stall)
    if changed >= SPIKE_ROWS:
        warnings.append(f"{changed:,} 311 rows re-stamped by the city tonight ({kinds.get('updated', 0):,} actually changed), far more than usual; likely a city catch-up."
                        + (" Published anyway." if args.publish else ""))

    # 4. Weekly deletion check.
    if args.check_counts == "yes" or (args.check_counts == "auto" and today.weekday() == 6):
        moved = check_counts(soda, cache_311, start, end, today, nightly / "stale-months")
        if moved:
            warnings.append(f"Monthly counts differed from the city's for {', '.join(moved)}; re-downloaded those months.")

    # 5. Rebuild, then add changes.json.
    prev = None
    if (args.out / "manifest.json").exists():
        prev = json.loads((args.out / "manifest.json").read_text())
    rc = bb.main(["--start", start.isoformat(), "--end", end.isoformat(), "--out", str(args.out),
                  "--cache", str(args.cache), "--type-map", str(args.type_map)])
    if rc:
        raise bb.PipelineError(f"boardstat_build exited {rc}")
    manifest = json.loads((args.out / "manifest.json").read_text())
    total = sum(d["rows"] for d in manifest["districts"]["cd"])
    if prev:
        prev_total = sum(d["rows"] for d in prev["districts"]["cd"])
        if prev_total and total < prev_total * (1 - MAX_DROP):
            raise bb.PipelineError(f"Total located requests fell from {prev_total:,} to {total:,}; not publishing.")
    pending = sorted(p for p in (nightly / "diffs").glob("*.parquet") if p.stem > state.get("last_publish_run", ""))
    summary = write_changes(con, pending, args.out, state.get("last_publish_at"), now.isoformat(timespec="seconds"))

    # 6. Publish.
    if args.publish:
        publish(args.out)
        verify_live(manifest["generated_at"])
        state["last_publish_run"] = run_id
        state["last_publish_at"] = now.isoformat(timespec="seconds")
        save_state(state_path, state)

    for w in warnings:
        notify(args.notify, f"BoardStat nightly: {w}")
    log("done", elapsed_s=round(time.time() - t0, 1), published=args.publish, total_located=total, **summary["city"])
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return run(args)
    except Exception as exc:  # noqa: BLE001 - every failure must reach staff
        log("failed", error=str(exc)[:500])
        notify(args.notify, f"BoardStat nightly FAILED: {str(exc)[:300]}. The site still shows the last good data. Log: ~/Library/Logs/boardstat-nightly/")
        return 2


if __name__ == "__main__":
    sys.exit(main())
