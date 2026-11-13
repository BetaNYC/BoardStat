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
