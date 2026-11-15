"""`fetch-history` and `check-history`: the 2010-2019 cache from 76ig-c548 (#162).

The pull publishes nothing, needs the app token, resumes, and refetches cached months only
when the City changed the rows (rowsUpdatedAt). Superseded months are moved, never deleted.
"""

import csv
import datetime as dt
import gzip
import io
import json

import pytest

import boardstat_build as bb

BASE = bb.HISTORIC_BASELINE_ROWS_UPDATED_AT
TODAY = dt.date(2026, 11, 15)


class FakeResponse:
    def __init__(self, text: str):
        self.content = text.encode("utf-8")


class FakeSoda:
    """Stands in for bb.Soda: metadata plus one CSV page per month request."""

    def __init__(self, rows_updated=BASE, rows_per_month=2, updated_after=None):
        self.rows_updated = rows_updated
        self.updated_after = updated_after  # rowsUpdatedAt to report from the second metadata call on
        self.rows_per_month = rows_per_month
        self.meta_calls = 0
        self.gets: list[tuple[str, dict]] = []

    def metadata(self, dataset_id):
        assert dataset_id == bb.DATASET_311_HISTORIC
        self.meta_calls += 1
        ts = self.updated_after if (self.updated_after and self.meta_calls > 1) else self.rows_updated
        return {"name": "311 Service Requests from 2010 to 2019", "rowsUpdatedAt": ts,
                "columns": [{"fieldName": f} for f in bb.FIELDS_311]}

    def get(self, path, params=None):
        self.gets.append((path, params))
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(bb.FIELDS_311)
        for i in range(self.rows_per_month):
            w.writerow([f"{len(self.gets)}{i}"] + [""] * (len(bb.FIELDS_311) - 1))
        return FakeResponse(buf.getvalue())


def month_files(cache):
    return sorted(p.name for p in cache.glob(f"{bb.DATASET_311_HISTORIC}_*.csv.gz"))


# --- the range guard ---
@pytest.mark.parametrize("start,end", [
    (dt.date(2009, 12, 1), dt.date(2010, 1, 31)),
    (dt.date(2019, 12, 1), dt.date(2020, 1, 31)),
    (dt.date(2015, 2, 1), dt.date(2015, 1, 1)),
])
def test_history_range_is_2010_through_2019(start, end):
    with pytest.raises(bb.PipelineError, match="fetch-history covers"):
        bb.check_history_range(start, end)


def test_site_guard_still_refuses_pre_2020_builds():
    with pytest.raises(bb.PipelineError, match="76ig-c548"):
        bb.check_start(dt.date(2019, 12, 1))
    assert bb.HISTORY_START == dt.date(2020, 1, 1)


# --- fetch_month for another dataset ---
def test_fetch_month_names_and_requests_the_historic_dataset(tmp_path):
    soda = FakeSoda()
    win = bb.Window(dt.date(2015, 3, 1), dt.date(2015, 4, 1))
    path = bb.fetch_month(soda, win, tmp_path, TODAY, 0.0, dataset=bb.DATASET_311_HISTORIC)
    assert path.name == "76ig-c548_2015-03-01_2015-04-01.csv.gz"
    assert path.with_suffix(".json").exists()
    assert soda.gets[0][0] == "/resource/76ig-c548.csv"
    assert soda.gets[0][1]["$where"] == "created_date >= '2015-03-01T00:00:00' AND created_date < '2015-04-01T00:00:00'"
    with gzip.open(path, "rt") as fh:
        assert next(csv.reader(fh)) == bb.FIELDS_311


def test_fetch_month_default_dataset_is_unchanged(tmp_path):
    path = bb.fetch_month(FakeSoda(), bb.Window(dt.date(2024, 3, 1), dt.date(2024, 4, 1)), tmp_path, TODAY, 0.0)
    assert path.name.startswith(f"{bb.DATASET_311}_")


# --- the pull ---
def test_fetch_history_fills_the_cache_and_records_state(tmp_path):
    soda = FakeSoda()
    state = bb.fetch_history(soda, tmp_path, dt.date(2010, 1, 1), dt.date(2010, 3, 31), today=TODAY)
    assert month_files(tmp_path) == [
        "76ig-c548_2010-01-01_2010-02-01.csv.gz",
        "76ig-c548_2010-02-01_2010-03-01.csv.gz",
        "76ig-c548_2010-03-01_2010-04-01.csv.gz",
    ]
    assert state["complete"] is True and state["rows"] == 6 and state["rowsUpdatedAt"] == BASE
    assert json.loads((tmp_path / bb.HISTORY_STATE_FILE).read_text())["months"] == {"2010-01": 2, "2010-02": 2, "2010-03": 2}


def test_fetch_history_resumes_without_refetching(tmp_path):
    bb.fetch_history(FakeSoda(), tmp_path, dt.date(2010, 1, 1), dt.date(2010, 2, 28), today=TODAY)
    soda = FakeSoda()
    bb.fetch_history(soda, tmp_path, dt.date(2010, 1, 1), dt.date(2010, 4, 30), today=TODAY)
    fetched = [p["$where"] for _, p in soda.gets]
    assert len(fetched) == 2 and "2010-03-01" in fetched[0] and "2010-04-01" in fetched[1]


def test_fetch_history_refetches_only_when_rows_changed_and_keeps_the_old_files(tmp_path):
    bb.fetch_history(FakeSoda(), tmp_path, dt.date(2010, 1, 1), dt.date(2010, 1, 31), today=TODAY)
    unchanged = FakeSoda()
    bb.fetch_history(unchanged, tmp_path, dt.date(2010, 1, 1), dt.date(2010, 1, 31), today=TODAY)
    assert unchanged.gets == []

    changed = FakeSoda(rows_updated=BASE + 86400)
    state = bb.fetch_history(changed, tmp_path, dt.date(2010, 1, 1), dt.date(2010, 1, 31), today=TODAY)
    assert len(changed.gets) == 1 and state["rowsUpdatedAt"] == BASE + 86400
    kept = list((tmp_path / "superseded").rglob("76ig-c548_2010-01-01_2010-02-01.csv.gz"))
    assert len(kept) == 1 and "2025-12-24T181908" in str(kept[0])
    assert month_files(tmp_path) == ["76ig-c548_2010-01-01_2010-02-01.csv.gz"]


def test_fetch_history_stops_if_rows_change_during_the_pull(tmp_path):
    soda = FakeSoda(updated_after=BASE + 60)
    with pytest.raises(bb.PipelineError, match="during the pull"):
        bb.fetch_history(soda, tmp_path, dt.date(2010, 1, 1), dt.date(2010, 1, 31), today=TODAY)
    assert json.loads((tmp_path / bb.HISTORY_STATE_FILE).read_text())["complete"] is False


def test_fetch_history_stops_when_a_column_is_gone(tmp_path):
    soda = FakeSoda()
    soda.metadata = lambda d: {"name": "311 Service Requests from 2010 to 2019", "rowsUpdatedAt": BASE,
                               "columns": [{"fieldName": "unique_key"}]}
    with pytest.raises(bb.PipelineError, match="Schema check failed"):
        bb.fetch_history(soda, tmp_path, dt.date(2010, 1, 1), dt.date(2010, 1, 31), today=TODAY)
    assert month_files(tmp_path) == []


# --- the change check ---
def test_history_status_against_the_2025_12_24_baseline():
    assert bb.epoch_to_iso(BASE) == "2025-12-24T18:19:08+00:00"
    assert bb.history_status({"rowsUpdatedAt": BASE}, None)["changed"] is False
    s = bb.history_status({"rowsUpdatedAt": BASE + 1}, None)
    assert s["changed"] is True and s["baseline_from"] == "HISTORIC_BASELINE_ROWS_UPDATED_AT"


def test_history_status_prefers_the_cache_state():
    state = {"rowsUpdatedAt": BASE + 500}
    assert bb.history_status({"rowsUpdatedAt": BASE + 500}, state)["changed"] is False
    assert bb.history_status({"rowsUpdatedAt": BASE}, state)["changed"] is True


def test_history_status_without_rows_updated_at_fails():
    with pytest.raises(bb.PipelineError, match="rowsUpdatedAt"):
        bb.history_status({}, None)


@pytest.mark.parametrize("rows_updated,code", [(BASE, 0), (BASE + 3600, bb.HISTORY_CHANGED_EXIT)])
def test_check_history_exit_code(monkeypatch, capsys, rows_updated, code):
    monkeypatch.setattr(bb, "Soda", lambda token=None: FakeSoda(rows_updated=rows_updated))
    assert bb.main(["check-history"]) == code
    out = json.loads(capsys.readouterr().out)
    assert out["changed"] is (code != 0) and out["baseline_iso"] == "2025-12-24T18:19:08+00:00"


# --- the command line ---
def test_fetch_history_command_runs_the_pull(tmp_path, monkeypatch, capsys):
    soda = FakeSoda()
    monkeypatch.setattr(bb, "Soda", lambda token=None: soda)
    assert bb.main(["fetch-history", "--cache", str(tmp_path), "--start", "2011-05-01", "--end", "2011-05-31"]) == 0
    assert json.loads(capsys.readouterr().out)["rows"] == 2
    assert month_files(tmp_path) == ["76ig-c548_2011-05-01_2011-06-01.csv.gz"]


@pytest.mark.parametrize("command", [["fetch-history", "--cache", "X"], ["check-history"]])
@pytest.mark.parametrize("value", [None, "", "  "])
def test_history_commands_need_the_token_before_any_network_call(tmp_path, monkeypatch, command, value):
    if value is None:
        monkeypatch.delenv("SOCRATA_APP_TOKEN", raising=False)
    else:
        monkeypatch.setenv("SOCRATA_APP_TOKEN", value)

    def boom(*a, **k):
        raise AssertionError("network call before the app token check")
    monkeypatch.setattr(bb, "Soda", boom)
    monkeypatch.setattr(bb.requests.Session, "get", boom)
    argv = [str(tmp_path / "c") if a == "X" else a for a in command]
    with pytest.raises(bb.PipelineError, match="SOCRATA_APP_TOKEN is missing or empty"):
        bb.main(argv)
    assert not (tmp_path / "c").exists()


def test_fetch_history_needs_a_cache_folder():
    with pytest.raises(SystemExit):
        bb.main(["fetch-history"])


def test_fetch_history_refuses_a_2020_end_before_any_network_call(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("network call")
    monkeypatch.setattr(bb.requests.Session, "get", boom)
    with pytest.raises(bb.PipelineError, match="fetch-history covers"):
        bb.main(["fetch-history", "--cache", str(tmp_path), "--end", "2020-01-31"])


def test_build_command_line_is_unchanged():
    args = bb.parse_args(["--start", "2020-01-01", "--end", "2026-11-01", "--out", "x"])
    assert args.start == dt.date(2020, 1, 1) and str(args.out) == "x"
