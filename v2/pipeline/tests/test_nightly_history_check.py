"""#166: the nightly's weekly check on the 2010-2019 data (76ig-c548). Offline; nothing posts."""

import datetime as dt
import subprocess
from pathlib import Path

import boardstat_build as bb
import boardstat_nightly as nightly

SUNDAY = dt.date(2026, 11, 22)
MONDAY = dt.date(2026, 11, 23)
PULLED_AT = 1766600348  # 2025-12-24T18:19:08Z, what the cache was pulled at
NIGHTLY_SH = Path(nightly.__file__).resolve().parent / "launchd" / "nightly.sh"


class FakeSoda:
    def __init__(self, rows_updated_at=PULLED_AT, error=None):
        self.rows_updated_at = rows_updated_at
        self.error = error
        self.calls = []

    def metadata(self, dataset_id):
        self.calls.append(dataset_id)
        if self.error:
            raise self.error
        return {"rowsUpdatedAt": self.rows_updated_at}


def cache_with_state(tmp_path, rows_updated_at=PULLED_AT):
    cache = tmp_path / "history-cache"
    cache.mkdir()
    bb.write_history_state(cache, {"dataset": bb.DATASET_311_HISTORIC, "rowsUpdatedAt": rows_updated_at})
    return cache


def test_due_only_on_sundays_with_a_cache_folder(tmp_path):
    assert nightly.history_check_due("auto", tmp_path, SUNDAY)
    assert not nightly.history_check_due("auto", tmp_path, MONDAY)
    assert not nightly.history_check_due("auto", None, SUNDAY)
    assert nightly.history_check_due("yes", tmp_path, MONDAY)
    assert not nightly.history_check_due("yes", None, MONDAY)
    assert not nightly.history_check_due("no", tmp_path, SUNDAY)


def test_unchanged_data_is_quiet(tmp_path):
    soda = FakeSoda()
    assert nightly.check_history(soda, cache_with_state(tmp_path)) is None
    assert soda.calls == [bb.DATASET_311_HISTORIC]


def test_changed_data_gives_a_warning_with_the_refresh_steps(tmp_path):
    cache = cache_with_state(tmp_path)
    warning = nightly.check_history(FakeSoda(rows_updated_at=PULLED_AT + 86_400), cache)
    assert warning is not None
    assert bb.DATASET_311_HISTORIC in warning
    assert "2025-12-24" in warning and "2025-12-25" in warning
    assert f"fetch-history --cache {cache}" in warning
    assert "BetaNAS" in warning


def test_compares_with_the_cache_state_not_the_built_in_date(tmp_path):
    """A cache refreshed after a City change is the new baseline: no alert for that change again."""
    later = PULLED_AT + 30 * 86_400
    assert nightly.check_history(FakeSoda(rows_updated_at=later), cache_with_state(tmp_path, later)) is None


def test_a_failed_call_is_a_warning_never_an_exception(tmp_path):
    warning = nightly.check_history(FakeSoda(error=bb.PipelineError("HTTP 503")), cache_with_state(tmp_path))
    assert warning is not None and "Could not check" in warning and "HTTP 503" in warning


def test_a_missing_cache_folder_is_a_warning_and_makes_no_call(tmp_path):
    soda = FakeSoda()
    warning = nightly.check_history(soda, tmp_path / "gone")
    assert warning is not None and "missing" in warning
    assert soda.calls == []


def test_flags_parse_and_default_to_off_without_a_cache():
    args = nightly.parse_args([])
    assert args.history_cache is None and args.check_history == "auto"
    args = nightly.parse_args(["--history-cache", "/tmp/x", "--check-history", "yes"])
    assert args.history_cache == Path("/tmp/x") and args.check_history == "yes"


def test_the_warning_reaches_rosie_untagged(monkeypatch, tmp_path):
    poster = tmp_path / "discord_rosie_post.py"
    poster.write_text("# stand-in\n")
    monkeypatch.setattr(nightly, "ROSIE", poster)
    monkeypatch.setenv("DISCORD_TOKEN", "test-not-real")
    calls = []
    monkeypatch.setattr(nightly.subprocess, "run",
                        lambda cmd, **kw: calls.append(cmd) or subprocess.CompletedProcess(cmd, 0, "", ""))
    warning = nightly.check_history(FakeSoda(rows_updated_at=PULLED_AT + 1), cache_with_state(tmp_path))
    nightly.notify("ops-website", f"BoardStat nightly: {warning}")
    assert len(calls) == 1 and "--tag" not in calls[0]


def test_nightly_sh_passes_the_cache_only_when_the_folder_exists():
    text = NIGHTLY_SH.read_text()
    assert 'HISTORY_CACHE="$HOME/Backups/BetaNYC/nyc-open-data/311/cache"' in text
    assert '[ -d "$HISTORY_CACHE" ] && args+=(--history-cache "$HISTORY_CACHE")' in text
    assert subprocess.run(["bash", "-n", str(NIGHTLY_SH)]).returncode == 0
