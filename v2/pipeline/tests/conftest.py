import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def _fake_app_token(monkeypatch):
    """Every test sees a fake SOCRATA_APP_TOKEN, never the operator's real one, so a test
    that reaches ``require_app_token`` passes it. Tests of the missing-token path
    delete or blank it themselves (test_app_token.py)."""
    monkeypatch.setenv("SOCRATA_APP_TOKEN", "test-token-not-real")
