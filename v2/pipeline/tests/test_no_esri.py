"""#141: every map uses the self-hosted Protomaps street map. No request may go to
ArcGIS or any other Esri service, and the map must credit OpenStreetMap."""

import re
from pathlib import Path

SITE = Path(__file__).resolve().parents[2] / "site"
CODE_SUFFIXES = {".js", ".mjs", ".html", ".css", ".json", ".webmanifest", ".txt", ".xml"}

# Any URL or hostname that points at ArcGIS or Esri (arcgis.com, arcgisonline.com,
# services.arcgis.com, tiles.arcgis.com, esri.com, ...).
# Any URL whose text mentions arcgis/esri, or any bare hostname with an arcgis/esri
# label under any top-level domain (arcgis.com, esri.ca, arcgis.io, esri.com.au ...).
ESRI = re.compile(
    r"(https?:)?//[^\s\"'<>`)]*(arcgis|esri)[^\s\"'<>`)]*"
    r"|\b[\w-]*(arcgis|esri)[\w-]*(\.[a-z0-9-]+)*\.[a-z]{2,}\b",
    re.I,
)

# The URL map.js used before #141; the pattern must catch it.
OLD_URL = "https://tiles.arcgis.com/tiles/yG5s3afENB5iO9fj/arcgis/rest/services/NYC_Basemap_v3/VectorTileServer"


def site_code_files():
    for p in SITE.rglob("*"):
        if p.is_file() and p.suffix in CODE_SUFFIXES and "data" not in p.relative_to(SITE).parts[:1]:
            yield p


def test_pattern_catches_esri_urls():
    for url in (OLD_URL, "https://services.arcgisonline.com/x", "//js.arcgis.com/4.30/", "basemaps-api.arcgis.com", "https://www.esri.com/",
                "cdn.arcgis.io", "esri.ca", "services.esri.com.au", "fetch('//static.arcgis.app/x')"):
        assert ESRI.search(url), url
    for ok in ("https://docs.protomaps.com/", "https://www.openstreetmap.org/copyright", "data/basemap/nyc.pmtiles", "js/series.js", "Desriptive"):
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


def strip_js_comments(src: str) -> str:
    """Drop // and /* */ comments so a comment can never satisfy a check."""
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(?m)(^|[^:'\"])//.*$", r"\1", src)


def map_js() -> str:
    return strip_js_comments((SITE / "js" / "map.js").read_text())


def test_strip_js_comments():
    assert "OpenStreetMap" not in strip_js_comments("// OpenStreetMap\n/* OpenStreetMap */ const a = 1;")
    assert "https://x" in strip_js_comments("const u = 'https://x'; // note")


def test_protomaps_source_credits_openstreetmap():
    src = map_js()
    const = re.search(r"const OSM_ATTRIBUTION\s*=\s*'([^']*)'", src)
    assert const, "OSM_ATTRIBUTION constant not found"
    credit = const.group(1)
    assert 'href="https://www.openstreetmap.org/copyright"' in credit and "OpenStreetMap" in credit
    source = re.search(r"protomaps:\s*\{([^}]*)\}", src)
    assert source, "protomaps source not found"
    body = source.group(1)
    assert "type: 'vector'" in body and "nyc.pmtiles" in body
    assert re.search(r"attribution:\s*OSM_ATTRIBUTION\b", body), "protomaps source must carry the OSM credit"


def test_street_map_is_self_hosted():
    src = map_js()
    assert "new URL('data/basemap/', location.href)" in src
    assert "'pmtiles://' + base + 'nyc.pmtiles'" in src


def test_attribution_is_never_collapsed():
    # OSMF attribution guidelines: the credit should be visible without a click.
    assert re.search(r"attributionControl:\s*\{[^}]*compact:\s*false", map_js())


def test_street_map_failure_is_shown_with_a_timeout():
    src = map_js()
    assert "AbortSignal.timeout(" in src and "withTimeout(" in src
    assert "map.on('error'" in src and "showBasemapError(" in src


def test_pmtiles_header_check_never_reads_the_whole_file():
    # A host that ignores Range answers 200 with the whole file; read a few bytes, then cancel.
    src = map_js()
    assert "arrayBuffer()" not in src
    assert "getReader()" in src and "reader.cancel()" in src
