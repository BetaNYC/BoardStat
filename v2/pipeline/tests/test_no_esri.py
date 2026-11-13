"""#141: every map uses the self-hosted Protomaps street map. No request may go to
ArcGIS or any other Esri service, and the map must credit OpenStreetMap."""

import re
from pathlib import Path

SITE = Path(__file__).resolve().parents[2] / "site"
CODE_SUFFIXES = {".js", ".mjs", ".html", ".css", ".json", ".webmanifest", ".txt", ".xml"}

# Any URL or hostname that points at ArcGIS or Esri (arcgis.com, arcgisonline.com,
# services.arcgis.com, tiles.arcgis.com, esri.com, ...).
ESRI = re.compile(r"(https?:)?//[^\s\"'<>`)]*(arcgis|esri)[^\s\"'<>`)]*|\b[\w.-]*(arcgis|esri)[\w-]*\.(com|net|org)\b", re.I)

# The URL map.js used before #141; the pattern must catch it.
OLD_URL = "https://tiles.arcgis.com/tiles/yG5s3afENB5iO9fj/arcgis/rest/services/NYC_Basemap_v3/VectorTileServer"


def site_code_files():
    for p in SITE.rglob("*"):
        if p.is_file() and p.suffix in CODE_SUFFIXES and "data" not in p.relative_to(SITE).parts[:1]:
            yield p


def test_pattern_catches_esri_urls():
    for url in (OLD_URL, "https://services.arcgisonline.com/x", "//js.arcgis.com/4.30/", "basemaps-api.arcgis.com", "https://www.esri.com/"):
        assert ESRI.search(url), url
    for ok in ("https://docs.protomaps.com/", "https://www.openstreetmap.org/copyright", "data/basemap/nyc.pmtiles"):
        assert not ESRI.search(ok), ok


def test_no_arcgis_or_esri_url_in_site_code():
    files = list(site_code_files())
    assert any(p.name == "map.js" for p in files), "site code not found"
    hits = []
    for p in files:
        for n, line in enumerate(p.read_text(errors="replace").splitlines(), 1):
            if ESRI.search(line):
                hits.append(f"{p.relative_to(SITE)}:{n}: {line.strip()[:120]}")
    assert not hits, "ArcGIS/Esri URL in site code (#141):\n" + "\n".join(hits)


def test_map_uses_self_hosted_protomaps_with_osm_credit():
    src = (SITE / "js" / "map.js").read_text()
    assert "data/basemap/" in src and "nyc.pmtiles" in src
    assert "https://www.openstreetmap.org/copyright" in src
    assert "OpenStreetMap" in src
