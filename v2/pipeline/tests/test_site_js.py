"""Run the site's JavaScript tests (Node's built-in runner) as part of `uv run pytest`."""

import shutil
import subprocess
from pathlib import Path

import pytest

JS_TESTS = Path(__file__).resolve().parents[2] / "tests-js"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_site_javascript():
    r = subprocess.run(["node", "--test", str(JS_TESTS)], capture_output=True, text=True, timeout=120, check=False)
    assert r.returncode == 0, r.stdout + r.stderr
