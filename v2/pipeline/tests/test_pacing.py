"""Polite Socrata pacing in Soda and the cheaper weekly count check (BoardStat #108).

2026-11-06: ~83 back-to-back per-month count(*) queries drew 27 HTTP 429s and 14 503s
in about 50 minutes, with an app token. These tests pin the fix.
"""

import datetime as dt
import gzip
import json
from unittest import mock

import pytest
import requests

import boardstat_build as bb
import boardstat_nightly as nightly


class FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.sleeps: list[float] = []

    def monotonic(self):
        return self.now

    def sleep(self, s):
        self.sleeps.append(s)
        self.now += s


@pytest.fixture
def clock(monkeypatch):
    c = FakeClock()
    monkeypatch.setattr(bb.time, "monotonic", c.monotonic)
    monkeypatch.setattr(bb.time, "sleep", c.sleep)
    monkeypatch.setattr(bb.random, "uniform", lambda a, b: 0.0)
    return c


def _resp(code=200, body="[]", headers=None):
    r = requests.Response()
    r.status_code = code
    r._content = body.encode()
    r.headers.update(headers or {})
    return r


def _soda(**kw):
    s = bb.Soda(base="https://example.test", **kw)
    s.session = mock.Mock()
    return s


def test_min_interval_between_requests(clock):
    s = _soda(min_interval=2.0)
    s.session.get.side_effect = [_resp(), _resp(), _resp()]
    for _ in range(3):
        s.get("/x")
    assert clock.sleeps == [2.0, 2.0]  # none before the first request


def test_no_wait_when_requests_are_already_slow(clock):
    s = _soda(min_interval=2.0)
    s.session.get.side_effect = lambda *a, **k: (setattr(clock, "now", clock.now + 30) or _resp())
    s.get("/x")
    s.get("/x")
    assert clock.sleeps == []


def test_429_doubles_gap_then_successes_decay_it(clock):
    s = _soda(min_interval=2.0, max_interval=60.0)
    s.session.get.side_effect = [_resp(429), _resp(429), _resp(), _resp(), _resp()]
    s.get("/x")
    assert s.gap == 4.0  # 2 -> 4 -> 8 after two 429s, halved once by the success
    s.get("/x")
    assert s.gap == 2.0
    s.get("/x")
    assert s.gap == 2.0  # never below the floor


def test_gap_is_capped(clock):
    s = _soda(min_interval=2.0, max_interval=5.0, max_tries=6)
    s.session.get.side_effect = [_resp(429)] * 5 + [_resp()]
    s.get("/x")
    assert s.gap == 2.5  # capped at 5, then halved by the success


def test_zero_min_interval_still_backs_off_after_429(clock):
    s = _soda(min_interval=0.0)
    s.session.get.side_effect = [_resp(429), _resp()]
    s.get("/x")
    assert s.gap == 0.5  # 429 widened it to 1 s; the success halved it


def test_retry_after_seconds_is_honored(clock):
    s = _soda(min_interval=0.0)
    s.session.get.side_effect = [_resp(429, headers={"Retry-After": "37"}), _resp()]
    s.get("/x")
    assert clock.sleeps[0] == 37.0


def test_retry_after_http_date_on_503(clock, monkeypatch):
    when = dt.datetime.now(dt.UTC) + dt.timedelta(seconds=90)
    hdr = when.strftime("%a, %d %b %Y %H:%M:%S GMT")
    s = _soda(min_interval=0.0)
    s.session.get.side_effect = [_resp(503, headers={"Retry-After": hdr}), _resp()]
    s.get("/x")
    assert 80 <= clock.sleeps[0] <= 91


def test_retry_after_is_capped(clock):
    s = _soda(min_interval=0.0)
    s.session.get.side_effect = [_resp(429, headers={"Retry-After": "99999"}), _resp()]
    s.get("/x")
    assert clock.sleeps[0] == bb.RETRY_AFTER_CAP


def test_without_retry_after_backoff_is_unchanged(clock):
    s = _soda(min_interval=0.0)
    s.session.get.side_effect = [_resp(503), _resp()]
    s.get("/x")
    assert clock.sleeps[0] == 2.0  # 2**attempt, jitter patched to 0


def test_no_sleep_after_the_last_failed_try(clock):
    s = _soda(min_interval=0.0, max_tries=2)
    s.session.get.side_effect = [_resp(503), _resp(503)]
    with pytest.raises(bb.PipelineError, match="after 2 tries"):
        s.get("/x")
    assert clock.sleeps == [2.0]


def test_env_configures_intervals(monkeypatch):
    monkeypatch.setenv("BOARDSTAT_SODA_MIN_INTERVAL", "0.5")
    monkeypatch.setenv("BOARDSTAT_SODA_MAX_INTERVAL", "10")
    s = bb.Soda(base="https://example.test")
    assert (s.min_interval, s.max_interval, s.gap) == (0.5, 10.0, 0.5)


def test_defaults(monkeypatch):
    monkeypatch.delenv("BOARDSTAT_SODA_MIN_INTERVAL", raising=False)
    monkeypatch.delenv("BOARDSTAT_SODA_MAX_INTERVAL", raising=False)
    s = bb.Soda(base="https://example.test")
    assert (s.min_interval, s.max_interval) == (bb.DEFAULT_MIN_INTERVAL, bb.DEFAULT_MAX_INTERVAL)


def test_bad_env_value_fails_loudly(monkeypatch):
    monkeypatch.setenv("BOARDSTAT_SODA_MIN_INTERVAL", "fast")
    with pytest.raises(bb.PipelineError, match="not a number"):
        bb.Soda(base="https://example.test")


# --------------------------------------------------------------------------- check_counts


def _cache_month(cache, start: dt.date, end: dt.date, rows: int):
    p = cache / f"{bb.DATASET_311}_{start.isoformat()}_{end.isoformat()}.csv.gz"
    p.write_bytes(gzip.compress(b"x\n"))
    p.with_suffix(".json").write_text(json.dumps({"rows": rows}))
    return p


def _grouped(counts: dict[str, int]) -> requests.Response:
    return _resp(body=json.dumps([{"m": f"{k}-01T00:00:00.000", "n": str(v)} for k, v in counts.items()]))


def _months(start: dt.date, n: int):
    out, cur = [], start
    for _ in range(n):
        nxt = (cur + dt.timedelta(days=32)).replace(day=1)
        out.append((cur, nxt))
        cur = nxt
    return out


@pytest.fixture
def counting_soda(clock):
    s = _soda(min_interval=0.0)
    return s


def test_check_counts_one_query_per_year_and_same_stale_months(tmp_path, counting_soda):
    cache, stale = tmp_path / "c", tmp_path / "stale"
    cache.mkdir()
    city = {}
    for a, b in _months(dt.date(2020, 1, 1), 24):  # 2020-01 .. 2021-12
        ours = 100 + a.month
        _cache_month(cache, a, b, ours)
        city[a.strftime("%Y-%m")] = ours
    city["2020-05"] += 1          # city has one more row: stale
    del city["2021-03"]           # city has none: absent from the grouped answer, still stale
    s = counting_soda
    s.session.get.side_effect = [
        _grouped({k: v for k, v in city.items() if k.startswith("2020")}),
        _grouped({k: v for k, v in city.items() if k.startswith("2021")}),
    ]
    moved = nightly.check_counts(s, cache, dt.date(2020, 1, 1), dt.date(2022, 1, 15), dt.date(2022, 1, 15), stale)
    assert moved == ["2020-05", "2021-03"]
    assert s.session.get.call_count == 2  # was 24
    params = s.session.get.call_args_list[0].kwargs["params"]
    assert params["$group"] == "m"
    assert "date_trunc_ym(created_date)" in params["$select"]
    assert params["$where"] == "created_date >= '2020-01-01T00:00:00' AND created_date < '2021-01-01T00:00:00'"
    assert sorted(p.name for p in stale.iterdir()) == sorted(
        f"2022-01-15_{bb.DATASET_311}_{m}{suffix}"
        for m in ("2020-05-01_2020-06-01", "2021-03-01_2021-04-01")
        for suffix in (".csv.gz", ".csv.json")  # the sidecar name check_counts has always used
    )
    assert len(list(stale.iterdir())) == 4


def test_check_counts_skips_current_month_and_uncached(tmp_path, counting_soda):
    cache, stale = tmp_path / "c", tmp_path / "stale"
    cache.mkdir()
    _cache_month(cache, dt.date(2022, 1, 1), dt.date(2022, 2, 1), 5)
    _cache_month(cache, dt.date(2022, 3, 1), dt.date(2022, 3, 10), 5)  # current month
    s = counting_soda
    s.session.get.side_effect = [_grouped({"2022-01": 5, "2022-02": 9})]
    moved = nightly.check_counts(s, cache, dt.date(2022, 1, 1), dt.date(2022, 3, 10), dt.date(2022, 3, 10), stale)
    assert moved == []
    assert s.session.get.call_count == 1
    where = s.session.get.call_args.kwargs["params"]["$where"]
    assert where.endswith("created_date < '2022-02-01T00:00:00'")  # only the cached month


def test_partial_first_month_keeps_its_own_exact_count(tmp_path, counting_soda):
    cache, stale = tmp_path / "c", tmp_path / "stale"
    cache.mkdir()
    _cache_month(cache, dt.date(2022, 1, 1), dt.date(2022, 2, 1), 7)  # month_files finds it by month
    _cache_month(cache, dt.date(2022, 2, 1), dt.date(2022, 3, 1), 8)
    s = counting_soda
    s.session.get.side_effect = [_resp(body='[{"n": "6"}]'), _grouped({"2022-02": 8})]
    moved = nightly.check_counts(s, cache, dt.date(2022, 1, 15), dt.date(2022, 3, 5), dt.date(2022, 3, 5), stale)
    assert moved == ["2022-01"]
    first = s.session.get.call_args_list[0].kwargs["params"]
    assert "$group" not in first
    assert first["$where"] == "created_date >= '2022-01-15T00:00:00' AND created_date < '2022-02-01T00:00:00'"


def test_heavy_year_falls_back_to_quarters(tmp_path, counting_soda):
    cache, stale = tmp_path / "c", tmp_path / "stale"
    cache.mkdir()
    city = {}
    for a, b in _months(dt.date(2023, 1, 1), 12):
        _cache_month(cache, a, b, 50)
        city[a.strftime("%Y-%m")] = 50
    city["2023-08"] = 49
    s = counting_soda
    q = lambda months: _grouped({m: city[m] for m in months})  # noqa: E731
    s.session.get.side_effect = [
        _resp(503), _resp(503),  # the year query, two tries
        q(["2023-01", "2023-02", "2023-03"]),
        q(["2023-04", "2023-05", "2023-06"]),
        q(["2023-07", "2023-08", "2023-09"]),
        q(["2023-10", "2023-11", "2023-12"]),
    ]
    moved = nightly.check_counts(s, cache, dt.date(2023, 1, 1), dt.date(2024, 1, 10), dt.date(2024, 1, 10), stale)
    assert moved == ["2023-08"]
    assert s.session.get.call_count == 6
    q3 = s.session.get.call_args_list[4].kwargs["params"]["$where"]
    assert q3 == "created_date >= '2023-07-01T00:00:00' AND created_date < '2023-10-01T00:00:00'"
