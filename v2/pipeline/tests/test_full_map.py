"""The full-page map (#143): site/map.html, the button that opens it from the district
map, and the shared code that keeps the two maps showing the same requests."""

import re
from pathlib import Path

SITE = Path(__file__).resolve().parents[2] / "site"
JS = SITE / "js"


def read(name: str) -> str:
    return (SITE / name).read_text(encoding="utf-8")


def test_map_page_has_the_map_key_back_link_and_filters_summary():
    html = read("map.html")
    for needed in ['id="map"', 'id="map-legend"', 'id="map-note"', 'id="back-link"', 'id="filters-summary"', 'class="skip-link"']:
        assert needed in html, needed
    assert "Back to the district page" in html
    assert 'src="js/fullmap.js?v=' in html  # stamped by stamp_assets.py, like every page
    assert "<!-- importmap:start -->" in html


def test_district_page_has_the_open_full_page_map_button():
    html = read("district.html")
    assert re.search(r'<a [^>]*id="fullmap-link" href="map\.html"[^>]*>Open full-page map</a>', html)
    assert 'id="map-legend"' in html
    assert 'id="fullmap-addr-note" hidden' in html
    # The address page has the map key too, but no full-page map button.
    assert 'id="map-legend"' in read("address.html")
    assert "fullmap-link" not in read("address.html")


def test_both_maps_share_one_link_format_one_sql_filter_and_one_map_builder():
    district = (JS / "district.js").read_text(encoding="utf-8")
    fullmap = (JS / "fullmap.js").read_text(encoding="utf-8")
    for src in (district, fullmap):
        assert "filtersFromParams" in src and "filtersToParams" in src
        assert "whereSql" in src
        assert "setupRequestMap" in src and "loadRequestPoints" in src and "mapNoteText" in src
        # No second copy of the SQL filter, the clustering, or the point cap.
        assert "agency = ${lit(" not in src
        assert "clusterRadius" not in src
        assert "60000" not in src
    assert "clusterRadius" in (JS / "requestmap.js").read_text(encoding="utf-8")


def test_the_link_updates_whenever_filters_are_applied():
    district = (JS / "district.js").read_text(encoding="utf-8")
    write_url = re.search(r"function writeUrl\(\) \{.*?\n\}", district, re.DOTALL).group(0)
    assert "updateFullMapLink(p)" in write_url
    # writeUrl runs on every refresh, which every Apply, shortcut and Reset goes through.
    refresh = re.search(r"async function refresh\(\) \{.*?\n\}", district, re.DOTALL).group(0)
    assert "writeUrl();" in refresh


def test_full_page_map_never_takes_an_address_from_its_link():
    assert "addr: ''" in (JS / "fullmap.js").read_text(encoding="utf-8")


def test_map_key_draws_circles_at_their_map_size():
    """QA #143: circle-radius is a radius, so the key's swatch is 2 x radius across."""
    src = (JS / "requestmap.js").read_text(encoding="utf-8")
    assert "width:${2 * s.radius}px;height:${2 * s.radius}px" in src
    assert "width:${2 * POINT_RADIUS}px" in src
    assert "'circle-radius': POINT_RADIUS" in src


def test_map_key_heading_fits_each_pages_outline():
    """map.html has no h2 above the key, so its key is an h2; the district page's is an h3."""
    assert "headingLevel: 2" in (JS / "fullmap.js").read_text(encoding="utf-8")
    assert "renderMapLegend($('map-legend'));" in (JS / "district.js").read_text(encoding="utf-8")
    assert "headingLevel = 3" in (JS / "requestmap.js").read_text(encoding="utf-8")


def test_both_pages_drop_an_unknown_status_with_the_same_helper():
    for name in ("district.js", "fullmap.js"):
        assert "keepKnownStatus(state," in (JS / name).read_text(encoding="utf-8"), name
