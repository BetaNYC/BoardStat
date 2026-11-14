"""#151: a borough page draws its charts from the borough's slim file and reads the
district files only for the map, the list, top addresses and an address filter."""

import re
from pathlib import Path

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
