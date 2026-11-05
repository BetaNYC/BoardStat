"""Offline tests for the nightly refresh: patching cached months and the diff."""

import csv
import datetime as dt
import gzip
import json

import duckdb

import boardstat_build as bb
import boardstat_nightly as nightly


def row(key, created, status, closed=""):
    r = {f: "" for f in bb.FIELDS_311}
    r.update(unique_key=key, created_date=created, status=status, closed_date=closed, complaint_type="Noise")
    return r


def write_month(cache, start, end, rows, fetched=1_000_000.0):
    path = cache / f"{bb.DATASET_311}_{start}_{end}.csv.gz"
    with gzip.open(path, "wt", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=bb.FIELDS_311)
        w.writeheader()
        w.writerows(rows)
    path.with_suffix(".json").write_text(json.dumps({"rows": len(rows), "fetched_at_epoch": fetched}))
    return path


def write_changes(path, rows):
    with gzip.open(path, "wt", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=bb.FIELDS_311 + ["updated_at"])
        w.writeheader()
        for r, ts in rows:
            w.writerow({**r, "updated_at": ts})


def read_month(path):
    with gzip.open(path, "rt", newline="") as fh:
        return {r["unique_key"]: r for r in csv.DictReader(fh)}


def test_rolling_window():
    assert nightly.rolling_window(dt.date(2026, 11, 6)) == (dt.date(2023, 11, 1), dt.date(2026, 11, 6))


def test_initial_watermark_is_an_hour_before_oldest_fetch(tmp_path):
    write_month(tmp_path, "2026-01-01", "2026-02-01", [], fetched=7200.0)
    write_month(tmp_path, "2026-02-01", "2026-03-01", [], fetched=9000.0)
    assert nightly.initial_watermark(tmp_path) == "1970-01-01T01:00:00"


def test_patch_replaces_changed_rows_and_records_diff(tmp_path):
    cache = tmp_path / "311"
    cache.mkdir()
    jan = write_month(cache, "2026-01-01", "2026-02-01", [
        row("1", "2026-01-05T10:00:00.000", "Open"),
        row("2", "2026-01-06T10:00:00.000", "Closed", "2026-01-07T10:00:00.000"),
    ])
    changes = tmp_path / "chg.csv.gz"
    write_changes(changes, [
        (row("1", "2026-01-05T10:00:00.000", "Open"), "2026-11-05T01:00:00.000Z"),
        (row("1", "2026-01-05T10:00:00.000", "Closed", "2026-11-04T09:00:00.000"), "2026-11-05T02:00:00.000Z"),  # newest wins
        (row("3", "2026-01-20T10:00:00.000", "Open"), "2026-11-05T02:00:00.000Z"),  # new row in an old month
        (row("4", "2026-03-02T10:00:00.000", "Open"), "2026-11-05T02:00:00.000Z"),  # month not cached
        (row("2", "2026-01-06T10:00:00.000", "Closed", "2026-01-07T10:00:00.000"), "2026-11-05T02:00:00.000Z"),  # re-stamped, same
    ])
    con = duckdb.connect()
    nightly.patch_cache(con, changes, cache, dt.date(2026, 1, 1), dt.date(2026, 3, 31))

    rows = read_month(jan)
    assert set(rows) == {"1", "2", "3"}
    assert rows["1"]["status"] == "Closed" and rows["1"]["closed_date"] == "2026-11-04T09:00:00.000"
    assert rows["2"]["status"] == "Closed"  # untouched row kept
    assert json.loads(jan.with_suffix(".json").read_text())["rows"] == 3

    diff = {k: (kind, old, new) for k, kind, old, new in con.execute("SELECT unique_key, kind, old_status, new_status FROM diff").fetchall()}
    assert diff == {"1": ("updated", "Open", "Closed"), "3": ("new", None, "Open"), "4": ("new", None, "Open")}


def test_write_changes_counts_city_and_districts(tmp_path):
    out = tmp_path / "out"
    (out / "detail" / "cd").mkdir(parents=True)
    con = duckdb.connect()
    con.execute(f"""COPY (SELECT * FROM (VALUES (1, 301, 33), (2, 301, 33), (3, 105, 4)) t(unique_key, cd, cc))
                   TO '{out / 'detail' / 'cd' / 'x.parquet'}' (FORMAT parquet)""")
    d1 = tmp_path / "20261105T060000Z.parquet"
    d2 = tmp_path / "20261106T060000Z.parquet"
    con.execute(f"""COPY (SELECT * FROM (VALUES ('1', 'x', 'updated', 'Open', 'In Progress', '20261105T060000Z'),
                                                ('3', 'x', 'new', NULL, 'Closed', '20261105T060000Z'))
                   t(unique_key, created_date, kind, old_status, new_status, run)) TO '{d1}' (FORMAT parquet)""")
    con.execute(f"""COPY (SELECT * FROM (VALUES ('1', 'x', 'updated', 'In Progress', 'Closed', '20261106T060000Z'),
                                                ('2', 'x', 'updated', 'Closed', 'Closed', '20261106T060000Z'))
                   t(unique_key, created_date, kind, old_status, new_status, run)) TO '{d2}' (FORMAT parquet)""")
    s = nightly.write_changes(con, [d1, d2], out, "2026-11-04T06:00:00+00:00", "2026-11-06T06:00:00+00:00")
    # Key 1: Open -> Closed across two nights counts once as closed; key 2 was already Closed.
    assert s["city"] == {"new": 1, "updated": 2, "closed": 2}
    assert s["cd"]["301"] == {"new": 0, "updated": 2, "closed": 1}
    assert s["cd"]["105"] == {"new": 1, "updated": 0, "closed": 1}
    assert s["cc"]["33"]["updated"] == 2
    assert json.loads((out / "changes.json").read_text())["since"] == "2026-11-04T06:00:00+00:00"
