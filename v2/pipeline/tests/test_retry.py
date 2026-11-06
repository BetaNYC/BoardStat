"""Soda.get retries a connection that breaks mid-body (BoardStat #108, 2026-11-06 backfill crash)."""

from unittest import mock

import pytest
import requests
from urllib3.exceptions import ProtocolError

import boardstat_build as bb
import boardstat_nightly as nightly


def _ok(text: str = "ok") -> requests.Response:
    r = requests.Response()
    r.status_code = 200
    r._content = text.encode()
    return r


def _status(code: int) -> requests.Response:
    r = _ok("nope")
    r.status_code = code
    return r


def _broken_body() -> requests.exceptions.ChunkedEncodingError:
    # What requests raises when urllib3 loses the connection while reading the body.
    return requests.exceptions.ChunkedEncodingError(
        ProtocolError("Connection broken: ConnectionResetError(54, 'Connection reset by peer')")
    )


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(bb.time, "sleep", lambda s: None)
    monkeypatch.setattr(nightly.time, "sleep", lambda s: None)


@pytest.fixture
def soda():
    s = bb.Soda(base="https://example.test", max_tries=3)
    s.session = mock.Mock()
    return s


def test_chunked_encoding_error_is_retried_then_succeeds(soda, capsys):
    soda.session.get.side_effect = [_broken_body(), _ok("hello")]
    r = soda.get("/resource/x.csv")
    assert r.content == b"hello"
    assert soda.session.get.call_count == 2
    assert '"event": "http_retry"' in capsys.readouterr().err


def test_content_decoding_error_is_retried(soda):
    soda.session.get.side_effect = [requests.exceptions.ContentDecodingError("bad gzip"), _ok()]
    assert soda.get("/x").status_code == 200
    assert soda.session.get.call_count == 2


def test_broken_body_every_time_gives_up_with_pipeline_error(soda):
    soda.session.get.side_effect = [_broken_body() for _ in range(3)]
    with pytest.raises(bb.PipelineError, match="after 3 tries"):
        soda.get("/x")
    assert soda.session.get.call_count == 3


def test_4xx_is_still_not_retried(soda):
    soda.session.get.side_effect = [_status(404), _ok()]
    with pytest.raises(bb.PipelineError, match="HTTP 404"):
        soda.get("/x")
    assert soda.session.get.call_count == 1


def test_verify_live_survives_a_broken_body(monkeypatch):
    good = _ok('{"generated_at": "T"}')
    get = mock.Mock(side_effect=[_broken_body(), good])
    monkeypatch.setattr(requests, "get", get)
    nightly.verify_live("T")
    assert get.call_count == 2
