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


def test_a_failed_slim_file_is_retried_then_falls_back_only_on_a_wide_screen():
    """#151 QA round 2: the slim file is re-registered and retried by Apply; only a second
    failure in a row falls back to the district files, and never at 640 px or less."""
    src = (JS / "district.js").read_text()
    assert "dataFiles.push(['b.parquet', `data/${slimFile}`]);" in src
    failed = re.search(r"function slimFailed\(\) \{.*?\n\}", src, re.DOTALL).group(0)
    assert "slimFailures++;" in failed
    assert "if (phoneLike() || slimFailures < 2) { syncRowPanels(); return SLIM_RETRY_MSG; }" in failed
    assert failed.index("phoneLike()") < failed.index("fallBackToDistrictFiles();")
    assert "if (SLIM) { slimFailures = 0; showSlimNote(''); } else if (fellBack) showSlimNote(SLIM_FALLBACK_DONE_MSG);" in src
    fb = re.search(r"function fallBackToDistrictFiles\(\) \{.*?\n\}", src, re.DOTALL).group(0)
    assert "SLIM = false;" in fb and "DROP TABLE IF EXISTS rows" in fb
    # The term is "quick-loading file", never "summary file".
    for page in ("district.html", "help.html", "glossary.html"):
        assert "summary file" not in (SITE / page).read_text(), page
    assert "summary file" not in src


def test_a_failed_section_clears_itself_and_says_so_inside():
    src = (JS / "district.js").read_text()
    for panel, text in (("map", "The map could not load."), ("addresses", "The addresses could not load."),
                        ("detail", "The list of requests could not load.")):
        assert f"{panel}: '{text} Press Apply filters to try again, or reload the page.'" in src
        assert f'id="{panel}-error" role="status" hidden' in (SITE / "district.html").read_text()
    sync = re.search(r"function syncRowPanels\(\) \{.*?\n\}", src, re.DOTALL).group(0)
    assert "$('addresses').replaceChildren()" in sync and "$('detail').replaceChildren()" in sync and "$('map').hidden = !show;" in sync
    assert "rowsFailedText" not in src and "err.message" not in src
    assert "err.message" not in (JS / "fullmap.js").read_text()
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


def test_a_phone_held_sideways_is_still_a_phone():
    """#151 QA round 3: no automatic fallback on a phone, however it is held: a coarse
    pointer or a screen whose shorter side is 640 px or less; never the window width."""
    src = (JS / "district.js").read_text()
    assert ("const phoneLike = () => window.matchMedia('(pointer: coarse)').matches"
            " || Math.min(window.screen.width, window.screen.height) <= 640;") in src
    assert "max-width: 640px" not in src[src.index("let slimFailures"):src.index("function fallBackToDistrictFiles")]


def test_a_failed_page_load_clears_every_section():
    """#151 QA round 3: after a failed load of the page's rows, the charts, Compare and every
    open map, addresses or list are cleared (sections say so inside, buttons back)."""
    src = (JS / "district.js").read_text()
    assert "'compare', 'cmp-note'" in src
    failed = re.search(r"function slimFailed\(\) \{.*?\n\}", src, re.DOTALL).group(0)
    assert "slimLoadFailed = true;" in failed and failed.count("syncRowPanels();") == 2
    assert "const failed = (slimLoadFailed && (opened[panel] || !SLIM)) || (SLIM && opened[panel] && Boolean(rowsError));" in src
    assert "const rowsOpen = (panel) => !slimLoadFailed && (" in src
