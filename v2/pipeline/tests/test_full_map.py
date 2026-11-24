"""The full-page map (#143), in BetaNYC's shared map layout since #193 and #194: site/map.html,
the button that opens it from the district map, the shared code that keeps both pages
counting the same requests, and the SQL that piles requests by address and counts them by
month, run here against the browser tests' fixture data with DuckDB."""

import json
import re
import shutil
import subprocess
from pathlib import Path

import duckdb
import pytest

SITE = Path(__file__).resolve().parents[2] / "site"
JS = SITE / "js"
FIXTURE = Path(__file__).resolve().parents[2] / "tests-browser" / "fixture-data" / "detail" / "cd" / "480.parquet"


def read(name: str) -> str:
    return (SITE / name).read_text(encoding="utf-8")


def test_map_page_has_the_shared_layout_back_link_and_caveats():
    html = read("map.html")
    for needed in ['id="map"', 'role="region"', 'id="map-legend"', 'id="map-note"', 'id="back-link"', 'class="skip-link"',
                   '<aside class="fm-side" id="side"', '<section class="fm-bar" id="bar"', 'id="hide-side"', 'id="show-side"',
                   'id="hide-bar"', 'id="show-bar"', 'id="tilt" aria-pressed="false"', 'id="chart"', 'id="k-total"', 'id="k-open"', 'id="k-addr"']:
        assert needed in html, needed
    assert "Back to the district page" in html
    # BoardStat's caveats are always on screen, in the stats bar (#194).
    assert "311 counts are reports, not problems. Closed doesn't mean fixed.</strong> Not an official City report." in html
    assert 'src="js/fullmap.js?v=' in html and 'href="css/fullmap.css?v=' in html  # stamped by stamp_assets.py
    assert "<!-- importmap:start -->" in html
    # The layout's styles are the map page's own; no other page loads them.
    for page in SITE.glob("*.html"):
        if page.name != "map.html":
            assert "fullmap.css" not in page.read_text(encoding="utf-8"), page.name


def test_district_page_has_the_open_full_page_map_button():
    html = read("district.html")
    assert re.search(r'<a [^>]*id="fullmap-link" href="map\.html"[^>]*>Open full-page map</a>', html)
    assert 'id="map-legend"' in html
    assert 'id="fullmap-addr-note" hidden' in html
    # The address page has the map key too, but no full-page map button.
    assert 'id="map-legend"' in read("address.html")
    assert "fullmap-link" not in read("address.html")


def test_both_pages_share_one_link_format_and_one_sql_filter():
    district = (JS / "district.js").read_text(encoding="utf-8")
    fullmap = (JS / "fullmap.js").read_text(encoding="utf-8")
    for src in (district, fullmap):
        assert "filtersFromParams" in src and "filtersToParams" in src
        assert "whereSql" in src
        assert "agency = ${lit(" not in src
    # The district page keeps its clustered map (requestmap.js); the full-page map piles by
    # address (piles.js) and reuses only the place's lines, so it has no 60,000 cap (#193).
    assert "setupRequestMap" in district and "loadRequestPoints" in district
    assert "loadRequestPoints" not in fullmap and "MAP_CAP" not in fullmap and "LIMIT" not in fullmap
    assert "import * as P from './piles.js';" in fullmap
    assert "placeShapes" in fullmap and "addBoundaries" in fullmap
    assert "clusterRadius" in (JS / "requestmap.js").read_text(encoding="utf-8")
    assert "clusterRadius" not in fullmap


def test_the_link_updates_whenever_filters_are_applied():
    district = (JS / "district.js").read_text(encoding="utf-8")
    write_url = re.search(r"function writeUrl\(\) \{.*?\n\}", district, re.DOTALL).group(0)
    assert "updateFullMapLink(p)" in write_url
    # writeUrl runs on every refresh, which every Apply, shortcut and Reset goes through.
    refresh = re.search(r"async function refresh\(\) \{.*?\n\}", district, re.DOTALL).group(0)
    assert "writeUrl();" in refresh


def test_full_page_map_never_takes_an_address_from_its_link():
    src = (JS / "fullmap.js").read_text(encoding="utf-8")
    assert "addr: ''" in src
    # The popup links to the address page; the map's own link never gets an address.
    assert "addressParams(geo, geoId, state, defaults, pile.addr)" in src
    links = re.search(r"function writeLinks\(\) \{.*?\n\}", src, re.DOTALL).group(0)
    assert "addr" not in links


def test_map_key_draws_circles_at_their_map_size():
    """QA #143: circle-radius is a radius, so the key's swatch is 2 x radius across (district page)."""
    src = (JS / "requestmap.js").read_text(encoding="utf-8")
    assert "width:${2 * s.radius}px;height:${2 * s.radius}px" in src
    assert "width:${2 * POINT_RADIUS}px" in src
    assert "'circle-radius': POINT_RADIUS" in src


def test_district_map_key_heading():
    district = (JS / "district.js").read_text(encoding="utf-8")
    assert "renderMapLegend($('map-legend'), { borough: IS_BORO });" in district
    assert "headingLevel = 3" in (JS / "requestmap.js").read_text(encoding="utf-8")


def test_both_pages_drop_an_unknown_status_with_the_same_helper():
    for name in ("district.js", "fullmap.js"):
        assert "keepKnownStatus(state," in (JS / name).read_text(encoding="utf-8"), name


def test_map_page_redraws_on_apply_and_its_links_carry_its_filters():
    """#149: Apply on the map redraws it, rewrites its link, and the back link carries the
    same filters (one function writes both, from the same filtersToParams)."""
    src = (JS / "fullmap.js").read_text(encoding="utf-8")
    links = re.search(r"function writeLinks\(\) \{.*?\n\}", src, re.DOTALL).group(0)
    assert "history.replaceState" in links and "$('back-link').href" in links and "filtersToParams(geo, geoId, state, defaults)" in links
    assert "onApply: (s) => {\n      state = s;" in src
    redraw = re.search(r"async function redraw\(\) \{.*?\n\}", src, re.DOTALL).group(0)
    assert "writeLinks();" in redraw and "P.addressSql(where)" in redraw and "updateStats(where)" in redraw


def test_a_month_applies_through_the_form():
    """#194: a month in the chart applies its dates through the form (applyNow), so the
    form, the link and the back link all follow."""
    src = (JS / "fullmap.js").read_text(encoding="utf-8")
    pick = re.search(r"function pickMonth\(.*?\n\}", src, re.DOTALL).group(0)
    assert "form.applyNow(() => monthDates(m, manifest.window.start, manifest.window.end));" in pick
    assert "e.key === 'Enter' || e.key === ' '" in src


def test_map_page_is_phone_friendly_and_says_what_is_not_carried():
    html = read("map.html")
    assert "(keeps the filters set here)" in html
    css = (SITE / "css" / "fullmap.css").read_text(encoding="utf-8")
    assert "@media (max-width: 760px)" in css and "(max-width: 760px)" in (JS / "fullmap.js").read_text(encoding="utf-8")
    assert "@media (forced-colors: active)" in css
    for page in ("help.html", "glossary.html"):
        assert "change them there" not in read(page)
        assert "never carried between the two pages" in read(page), page


def test_resolution_text_is_read_on_demand_not_loaded():
    """Memory (#193): a borough page holds every district's rows, so the long resolution
    text is never in the loader's columns; a popup reads it for its 12 requests."""
    src = (JS / "fullmap.js").read_text(encoding="utf-8")
    cols = re.search(r"const MAP_COLUMNS = \[(.*?)\];", src, re.DOTALL).group(1)
    assert "resolution_description" not in cols and "'unique_key'" in cols
    assert "P.resolutionsSql(sourceSql(names), latest)" in src


# ---------------------------------------------------------------- the SQL, on real rows

def js_sql(expr: str) -> str:
    """Evaluate `expr` with P = piles.js and M = monthchart.js, and return the string."""
    code = (f"const P = await import({json.dumps((JS / 'piles.js').as_uri())});"
            f"const M = await import({json.dumps((JS / 'monthchart.js').as_uri())});"
            f"console.log(JSON.stringify({expr}));")
    r = subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True, timeout=60, check=True)
    return json.loads(r.stdout)


needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
STATE = "{start: '2025-11-01', end: '2026-11-22', agencies: [], types: [], descs: [], descEx: false, status: '', addr: ''}"


@pytest.fixture(scope="module")
def con():
    c = duckdb.connect()
    c.execute(f"CREATE TABLE req AS SELECT * FROM '{FIXTURE}'")
    return c


@needs_node
def test_address_piles_count_every_located_request_once(con):
    rows = con.execute(js_sql("P.addressSql('TRUE')")).fetchall()
    cols = [d[0] for d in con.description]
    piles = [dict(zip(cols, r)) for r in rows]
    located, not_closed = con.execute("""SELECT count(*), count(*) FILTER (WHERE status IS DISTINCT FROM 'Closed')
        FROM req WHERE latitude IS NOT NULL AND longitude IS NOT NULL""").fetchone()
    assert sum(p["n"] for p in piles) == located > 0
    assert sum(p["o"] for p in piles) == not_closed
    # One pile per normalized address.
    addrs = [p["k"] for p in piles if p["addr"]]
    assert len(addrs) == len(set(addrs)) == con.execute("SELECT count(DISTINCT address_norm) FROM req WHERE latitude IS NOT NULL").fetchone()[0]
    # The per-agency counts add up to the agency's located requests.
    dot = con.execute("SELECT count(*) FROM req WHERE agency = 'DOT' AND latitude IS NOT NULL").fetchone()[0]
    assert sum(p["g4"] for p in piles) == dot > 0  # g4 is DOT (piles.js GROUP_AGENCIES)


@needs_node
def test_a_pile_without_a_normalized_address_is_keyed_by_its_point_and_label(con):
    keys = con.execute(f"SELECT {js_sql('P.KEY_SQL')} AS k FROM req WHERE address_norm IS NULL AND latitude IS NOT NULL LIMIT 5").fetchall()
    assert keys and all(re.match(r"^-?\d+\.\d+,-?\d+\.\d+ \S", k) for (k,) in keys)


@needs_node
def test_monthly_counts_match_a_plain_count_and_ignore_the_applied_dates(con):
    sql = js_sql(f"M.monthlySql({{...{STATE}, start: '2026-03-01', end: '2026-03-31', agencies: ['DOT', 'NYPD']}}, '2025-11-01')")
    got = {}
    for m, g, n in con.execute(sql).fetchall():
        got[m] = got.get(m, 0) + n
        assert g in (1, 4)  # NYPD and DOT only
    want = dict(con.execute("""SELECT strftime(created_date, '%Y-%m'), count(*) FROM req
        WHERE agency IN ('DOT', 'NYPD') AND created_date >= DATE '2025-11-01' GROUP BY 1""").fetchall())
    assert got == want and len(want) > 1  # months outside March are counted too, to show faded


@needs_node
def test_group_sql_matches_the_js_rule(con):
    pairs = con.execute(f"SELECT DISTINCT agency, {js_sql('P.GROUP_SQL')} FROM req").fetchall()
    want = js_sql(f"Object.fromEntries({json.dumps([a for a, _ in pairs])}.map((a) => [a, P.groupOf(a)]))")
    assert {a: g for a, g in pairs} == want


@needs_node
def test_popup_queries_run(con):
    k = con.execute("SELECT address_norm FROM req WHERE address_norm IS NOT NULL AND latitude IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1").fetchone()[0]
    n = con.execute("SELECT count(*) FROM req WHERE address_norm = ? AND latitude IS NOT NULL", [k]).fetchone()[0]
    types = con.execute(js_sql(f"P.pileTypesSql('TRUE', {json.dumps(k)})")).fetchall()
    assert sum(t[1] for t in types) == n
    latest = con.execute(js_sql(f"P.pileLatestSql('TRUE', {json.dumps(k)}, 12)")).fetchall()
    assert len(latest) == min(12, n)
    rows = [{"id": r[0], "ts": r[2]} for r in latest]
    notes = con.execute(js_sql(f"P.resolutionsSql({json.dumps(repr(str(FIXTURE)))}, {json.dumps(rows)})")).fetchall()
    assert {r[0] for r in notes} == {r["id"] for r in rows}
