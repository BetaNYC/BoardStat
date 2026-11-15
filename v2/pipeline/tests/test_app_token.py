"""SOCRATA_APP_TOKEN is required: both entry points stop before any network call without it.

Before this, a missing or empty token (say, a failed Keychain lookup in launchd/nightly.sh)
made both entry points run keyless, with only ``app_token="unset"`` in the log."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

import boardstat_build as bb
import boardstat_nightly as nightly

FAKE = "test-token-not-real"
MISSING = [pytest.param(None, id="unset"), pytest.param("", id="empty"), pytest.param("  \n", id="whitespace")]


def _set_token(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("SOCRATA_APP_TOKEN", raising=False)
    else:
        monkeypatch.setenv("SOCRATA_APP_TOKEN", value)


@pytest.fixture
def no_network(monkeypatch):
    """Any Soda client or HTTP request fails the test."""
    def boom(*a, **k):
        raise AssertionError("network call before the app token check")
    monkeypatch.setattr(bb, "Soda", boom)
    monkeypatch.setattr(bb.requests.Session, "get", boom)


# --- the shared helper ---
@pytest.mark.parametrize("value", MISSING)
def test_require_app_token_refuses_missing_or_empty(monkeypatch, value):
    _set_token(monkeypatch, value)
    with pytest.raises(bb.PipelineError) as exc:
        bb.require_app_token()
    msg = str(exc.value)
    assert "SOCRATA_APP_TOKEN" in msg and "boardstat-socrata-app-token" in msg


def test_require_app_token_returns_the_token(monkeypatch):
    monkeypatch.setenv("SOCRATA_APP_TOKEN", FAKE)
    assert bb.require_app_token() == FAKE


# --- boardstat_build.main ---
@pytest.mark.parametrize("value", MISSING)
def test_build_main_stops_before_any_network_call_without_a_token(tmp_path, monkeypatch, no_network, value):
    _set_token(monkeypatch, value)
    with pytest.raises(bb.PipelineError, match="SOCRATA_APP_TOKEN is missing or empty"):
        bb.main(["--out", str(tmp_path / "out"), "--cache", str(tmp_path / "cache")])
    assert not (tmp_path / "out").exists()


def test_build_script_exits_nonzero_without_a_token(tmp_path):
    """The real command line: exit 2 and a FAILED line naming the variable, no traceback."""
    env = {k: v for k, v in os.environ.items() if k != "SOCRATA_APP_TOKEN"}
    env["HTTPS_PROXY"] = env["HTTP_PROXY"] = "http://127.0.0.1:9"  # a regression fails fast, offline
    r = subprocess.run([sys.executable, str(Path(bb.__file__)), "--out", str(tmp_path / "out"),
                        "--cache", str(tmp_path / "cache")], env=env, capture_output=True, text=True, timeout=120, check=False)
    assert r.returncode == 2
    assert "BoardStat build FAILED: SOCRATA_APP_TOKEN is missing or empty" in r.stderr
    assert "Traceback" not in r.stderr


class _Stop(Exception):
    pass


def _capture_soda(monkeypatch, seen):
    real = bb.Soda

    def make(*a, token=None, **k):
        seen.append(real(base="https://example.test", token=token))
        raise _Stop  # stop before the first request
    monkeypatch.setattr(bb, "Soda", make)


def test_build_main_sends_the_token_as_x_app_token(tmp_path, monkeypatch):
    monkeypatch.setenv("SOCRATA_APP_TOKEN", FAKE)
    seen = []
    _capture_soda(monkeypatch, seen)
    with pytest.raises(_Stop):
        bb.main(["--out", str(tmp_path / "out"), "--cache", str(tmp_path / "cache")])
    assert seen[0].session.headers["X-App-Token"] == FAKE


def test_soda_stays_token_optional():
    assert "X-App-Token" not in bb.Soda(base="https://example.test").session.headers


# --- boardstat_nightly ---
@pytest.mark.parametrize("value", MISSING)
def test_nightly_run_stops_before_any_network_call_without_a_token(tmp_path, monkeypatch, no_network, value):
    _set_token(monkeypatch, value)
    args = nightly.parse_args(["--cache", str(tmp_path / "cache"), "--out", str(tmp_path / "out")])
    with pytest.raises(bb.PipelineError, match="SOCRATA_APP_TOKEN is missing or empty"):
        nightly.run(args)
    assert not (tmp_path / "cache").exists()  # stopped before touching the cache, too


@pytest.mark.parametrize("value", MISSING)
def test_nightly_main_fails_and_alerts_without_a_token(tmp_path, monkeypatch, no_network, value):
    """The launchd path: main() returns 2 and posts the failure through Rosie, tagging Noel."""
    _set_token(monkeypatch, value)
    poster = tmp_path / "discord_rosie_post.py"
    poster.write_text("# stand-in\n")
    monkeypatch.setattr(nightly, "ROSIE", poster)
    monkeypatch.setenv("DISCORD_TOKEN", "test-not-real")
    calls = []
    monkeypatch.setattr(nightly.subprocess, "run",
                        lambda cmd, **kw: calls.append(cmd) or subprocess.CompletedProcess(cmd, 0, "", ""))
    published = []
    monkeypatch.setattr(nightly, "publish", lambda out: published.append(out))
    rc = nightly.main(["--publish", "--notify", "ops-website", "--today", "2026-11-15",
                       "--cache", str(tmp_path / "cache"), "--out", str(tmp_path / "out")])
    assert rc == 2
    assert published == []
    assert len(calls) == 1
    cmd = calls[0]
    assert cmd[cmd.index("--kind") + 1] == "failure"
    assert cmd[cmd.index("--tag") + 1] == "noel"
    text = cmd[cmd.index("--text") + 1]
    assert "BoardStat nightly FAILED: SOCRATA_APP_TOKEN is missing or empty" in text
    assert "boardstat-socrata-app-token" in text


def test_nightly_run_sends_the_token_as_x_app_token(tmp_path, monkeypatch):
    monkeypatch.setenv("SOCRATA_APP_TOKEN", FAKE)
    monkeypatch.setattr(nightly, "initial_watermark", lambda cache: "2026-11-12T00:00:00")
    seen = []
    _capture_soda(monkeypatch, seen)
    args = nightly.parse_args(["--cache", str(tmp_path / "cache"), "--out", str(tmp_path / "out")])
    with pytest.raises(_Stop):
        nightly.run(args)
    assert seen[0].session.headers["X-App-Token"] == FAKE


# --- launchd/nightly.sh never exports an empty token ---
NIGHTLY_SH = Path(nightly.__file__).parent / "launchd" / "nightly.sh"


def _run_nightly_sh(tmp_path, security_body):
    """Run the real nightly.sh with `security`, `uv` and `git` replaced by exported bash
    functions (they take precedence over the PATH the script sets). The `uv` stand-in
    reports whether SOCRATA_APP_TOKEN reached it unset, empty or set, never its value."""
    home = tmp_path / "home"
    home.mkdir()
    script = f"""
security() {{ {security_body} }}
uv() {{ if [ -z "${{SOCRATA_APP_TOKEN+x}}" ]; then echo token=unset; elif [ -z "$SOCRATA_APP_TOKEN" ]; then echo token=empty; else echo token=set; fi; return 7; }}
git() {{ echo stub; }}
export -f security uv git
exec /bin/bash {NIGHTLY_SH}
"""
    env = {"HOME": str(home), "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "BOARDSTAT_NOTIFY": ""}
    r = subprocess.run(["/bin/bash", "-c", script], env=env, capture_output=True, text=True, timeout=60, check=False)
    logs = list((home / "Library" / "Logs" / "boardstat-nightly").glob("*.log"))
    return r.returncode, logs[0].read_text()


def test_nightly_sh_leaves_the_token_unset_and_says_so_when_the_keychain_lookup_fails(tmp_path):
    rc, log = _run_nightly_sh(tmp_path, 'echo "item not found" >&2; return 44;')
    assert rc == 7  # the nightly's own exit code, after it has reported the failure
    assert "token=unset" in log and "token=empty" not in log
    assert "STOP: Keychain item boardstat-socrata-app-token is missing or empty" in log


def test_nightly_sh_treats_an_empty_keychain_item_as_missing(tmp_path):
    rc, log = _run_nightly_sh(tmp_path, 'echo ""; return 0;')
    assert rc == 7
    assert "token=unset" in log
    assert "STOP: Keychain item boardstat-socrata-app-token" in log


def test_nightly_sh_exports_the_token_when_present(tmp_path):
    rc, log = _run_nightly_sh(tmp_path, 'echo "test-token-not-real"; return 0;')
    assert rc == 7
    assert "token=set" in log
    assert "STOP:" not in log
    assert "test-token-not-real" not in log  # never logged
