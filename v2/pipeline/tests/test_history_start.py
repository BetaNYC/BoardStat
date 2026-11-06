"""The nightly job's fixed 2020 start and the backfill guard for changes.json (#108)."""

import datetime as dt

import duckdb
import pytest
from test_nightly import row, write_changes, write_month

import boardstat_build as bb
import boardstat_nightly as nightly


def test_fixed_start_does_not_roll():
    for today in (dt.date(2026, 11, 6), dt.date(2027, 2, 1), dt.date(2031, 1, 15)):
        assert nightly.run_window(today, None, None) == (dt.date(2020, 1, 1), today)
    assert nightly.parse_args([]).start is None and nightly.parse_args([]).years is None


def test_start_before_erm_floor_fails_loudly():
    with pytest.raises(bb.PipelineError, match="76ig-c548"):
        nightly.run_window(dt.date(2026, 11, 6), dt.date(2019, 11, 1), None)
    # --years 7 would start on 2019-11-01: also refused, instead of two silent empty months.
    with pytest.raises(bb.PipelineError, match="2019-11-01"):
        nightly.run_window(dt.date(2026, 11, 6), None, 7)


def test_years_still_rolls_when_asked():
    assert nightly.run_window(dt.date(2026, 11, 6), None, 3) == (dt.date(2023, 11, 1), dt.date(2026, 11, 6))


def test_years_and_start_are_exclusive():
    with pytest.raises(SystemExit):
        nightly.parse_args(["--start", "2020-01-01", "--years", "3"])


def test_backfilled_months_are_not_reported_as_new(tmp_path):
    # The cache already holds 2023-11 onward; the history start moved back to 2020.
    # Rows the city changed tonight in 2021 are not "new since the last update".
    cache = tmp_path / "311"
    cache.mkdir()
    write_month(cache, "2023-11-01", "2023-12-01", [row("10", "2023-11-02T10:00:00.000", "Open")])
    write_month(cache, "2026-10-01", "2026-11-01", [])
    changes = tmp_path / "chg.csv.gz"
    write_changes(changes, [
        (row("1", "2021-03-05T10:00:00.000", "Closed", "2026-11-05T09:00:00.000"), "2026-11-05T02:00:00.000Z"),  # uncached old month
        (row("10", "2023-11-02T10:00:00.000", "Closed", "2026-11-05T09:00:00.000"), "2026-11-05T02:00:00.000Z"),  # cached month
        (row("2", "2026-11-04T10:00:00.000", "Open"), "2026-11-05T02:00:00.000Z"),  # newer than every cached month
    ])
    con = duckdb.connect()
    nightly.patch_cache(con, changes, cache, dt.date(2020, 1, 1), dt.date(2026, 11, 5))
    diff = {k: kind for k, kind in con.execute("SELECT unique_key, kind FROM diff").fetchall()}
    assert diff == {"10": "updated", "2": "new"}
    assert not list(cache.glob(f"{bb.DATASET_311}_2021-03-01_*"))  # left to the build to download whole


def test_newest_cached_month(tmp_path):
    assert nightly.newest_cached_month(tmp_path) is None
    write_month(tmp_path, "2026-10-01", "2026-11-01", [])
    write_month(tmp_path, "2026-11-01", "2026-11-05", [])
    assert nightly.newest_cached_month(tmp_path) == dt.date(2026, 11, 1)
