"""The live site's address is defined once (issue #118) and every user agrees."""

import importlib.util
from pathlib import Path

import boardstat_nightly as nightly
import site_location as loc


def _freshness():
    path = Path(__file__).resolve().parent.parent / "check" / "freshness.py"
    spec = importlib.util.spec_from_file_location("freshness", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_site_is_beta_nyc_boardstat_root():
    assert loc.SITE == "https://www.beta.nyc/boardstat/"
    assert loc.PUBLIC_MANIFEST == "https://www.beta.nyc/boardstat/data/manifest.json"
    assert loc.REMOTE_DIR == "beta.nyc/boardstat"


def test_public_manifest_and_remote_dir_agree():
    # The URL path under the site root must be the server folder under beta.nyc/.
    path = loc.SITE.split("www.beta.nyc", 1)[1].strip("/")
    assert loc.REMOTE_DIR == f"beta.nyc/{path}"
    assert loc.PUBLIC_MANIFEST.startswith(loc.SITE)


def test_nightly_and_freshness_use_the_one_definition():
    assert nightly.REMOTE_DIR == loc.REMOTE_DIR
    assert nightly.PUBLIC_MANIFEST == loc.PUBLIC_MANIFEST
    f = _freshness()
    assert f.MANIFEST == loc.PUBLIC_MANIFEST
    assert f.SITE == loc.SITE
