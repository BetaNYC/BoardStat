"""#151: a borough page draws its charts from the borough's slim file and reads the
district files only for the map, the list, top addresses and an address filter."""

import re
from pathlib import Path

import pytest

SITE = Path(__file__).resolve().parents[2] / "site"
JS = SITE / "js"


def test_row_level_panels_wait_behind_a_button():
    html = (SITE / "district.html").read_text()
    for panel, label in (("map", "Show the map"), ("addresses", "Show the addresses")):
        assert re.search(rf'<p class="rows-open" id="{panel}-open" hidden><button type="button" class="secondary" id="{panel}-show">{label}</button>', html)
    assert 'id="rows-note" hidden' in html
    assert '<summary>Show the list of requests</summary>' in html


def test_charts_read_the_chart_table_and_row_panels_read_rows():
    src = (JS / "district.js").read_text()
    # Panels name no table directly: charts read T(), row-level panels ROWS(). Only the
    # address page's own panels read req, and an address page is never a borough page.
    address_only = [re.search(rf"async function {fn}\(\) \{{.*?\n\}}", src, re.DOTALL).group(0)
                     for fn in ("renderTimeline", "renderAddressCompare", "renderAddressLinks")]
    rest = src
    for body in address_only:
        rest = rest.replace(body, "")
    assert not re.search(r"FROM req\b", rest), re.findall(r".*FROM req\b.*", rest)[:3]
    for fn in ("renderAddresses", "renderDetail"):
        body = re.search(rf"async function {fn}\(\) \{{.*?\n\}}", src, re.DOTALL).group(0)
        assert "rowsOpen(" in body and "${ROWS()}" in body, fn
    assert "loadRequestPoints(mapCtx, ROWS(), where())" in src
    for fn in ("renderKpis", "renderTop", "renderAgencyResponse", "renderBacklog", "renderAgency"):
        body = re.search(rf"async function {fn}\(\) \{{.*?\n\}}", src, re.DOTALL).group(0)
        assert "FROM ${T()}" in body, fn


def test_slim_mode_only_with_the_manifests_file_and_rows_through_the_loader():
    src = (JS / "district.js").read_text()
    assert "const slimFileFor" not in src and "slimFileFor(manifest, district.id)" in src
    assert "table: 'rows'" in src
    assert "const T = () => (SLIM && state.addr ? 'rows' : 'req');" in src


def test_a_failed_slim_file_is_retried_and_falls_back_to_the_district_files():
    """#151 QA: the slim file is re-registered after a failed read, and the page then reads
    the district files, with a plain note."""
    src = (JS / "district.js").read_text()
    assert "dataFiles.push(['b.parquet', `data/${slimFile}`]);" in src
    fb = re.search(r"function fallBackToDistrictFiles\(\) \{.*?\n\}", src, re.DOTALL).group(0)
    assert "SLIM = false;" in fb and "$('slim-note').hidden = false;" in fb
    assert "if (err.boardstatSlim && !(err instanceof DataChangedError)) fallBackToDistrictFiles();" in src
    assert 'id="slim-note" hidden' in (SITE / "district.html").read_text()


def test_a_failed_section_names_the_section_never_the_error():
    src = (JS / "district.js").read_text()
    fn = re.search(r"function rowsFailedText\(\) \{.*?\n\}", src, re.DOTALL).group(0)
    assert "could not load. Press Apply filters to try again, or reload the page." in fn and "message" not in fn
    assert "lastRefreshFailed = Boolean(rowsError);" in src


def test_redraws_wait_for_both_loaders():
    src = (JS / "district.js").read_text()
    assert src.count("loader?.loadPending() || rowsLoader?.loadPending()") == 2
    assert "if (loader.loadPending() || rowsLoader?.loadPending()) return;" in src


@pytest.mark.parametrize("text", [
    "The map needs each request's location, so it loads much more data for a whole borough. On a phone it can be slow, or make the page reload.",
    "Addresses come from each request's details, so this loads much more data for a whole borough. On a phone it can be slow, or make the page reload.",
    "The list comes from each request's details, so it loads much more data for a whole borough. On a phone it can be slow, or make the page reload.",
    "On a phone, a whole borough's map can be slow or make the page reload.",
])
def test_phone_warnings(text):
    assert text in (SITE / "district.html").read_text()
