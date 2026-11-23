"""Shared setup for the browser tests (#186).

- The site is served by v2/serve.py's own handler, on 127.0.0.1 and a free port, with
  `fixture-data/` at /data/ (a small slice of the published build; see make_fixture.py).
- Chromium starts with every host name resolving to nothing except localhost
  (--host-resolver-rules), so a request that is not served locally fails instead of
  reaching the internet. NYC Open Data and every other service are out of reach.
- The pinned libraries the pages load from cdn.jsdelivr.net (DuckDB-WASM, Plot, MapLibre,
  UI SDK), and the Parquet extension DuckDB-WASM loads from extensions.duckdb.org, are
  answered from a local cache, `.vendor/`, by Playwright's request routing (which also
  sees the DuckDB worker's requests).
  Fill it once, with network access, by running the tests with BOARDSTAT_RECORD_VENDOR=1.
  That run fetches from those two hosts only; every other host stays blocked.
- A test fails if the page asked for anything outside localhost and the cache, or logged a
  console error (QA round 1), except the one listed in ALLOWED_CONSOLE_ERRORS.
- A test can refuse a URL on purpose (`network.refuse`), to check what the page does
  without it.
"""
import hashlib
import json
import os
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from playwright.sync_api import Page, sync_playwright

HERE = Path(__file__).resolve().parent
V2 = HERE.parent
FIXTURE = HERE / "fixture-data"
VENDOR = HERE / ".vendor"
VENDOR_HOSTS = {"cdn.jsdelivr.net", "extensions.duckdb.org"}  # extensions.duckdb.org: DuckDB-WASM loads its Parquet reader from there
LOCAL_HOSTS = {"127.0.0.1", "localhost"}
RECORD = os.environ.get("BOARDSTAT_RECORD_VENDOR") == "1"
# Chromium's DNS: every name fails except localhost. Routing still answers CDN URLs from
# the cache, because Playwright fulfills a routed request before any DNS lookup.
OFFLINE_ARGS = ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1"]

sys.path.insert(0, str(V2))
import serve  # noqa: E402  (v2/serve.py)

# Console errors a test may log without failing, matched against the message and its URL.
# The fixture has no street map (data/basemap/, about 240 MB, README "How to run"), so
# map.js's first check of basemap.json answers 404, and the map falls back to district
# outlines on a blank background, as the README says it does.
ALLOWED_CONSOLE_ERRORS = ["/data/basemap/basemap.json"]

# The fixture district: Queens Joint Interest Area 480 (see make_fixture.py).
DISTRICT_PATH = "district.html?geo=cd&id=480"
MAP_PATH = "map.html?geo=cd&id=480"
ADDRESS_PATH = "address.html?geo=cd&id=480&addr=LA%20GUARDIA%20AIRPORT"


def vendor_file(url: str) -> Path:
    parts = urlsplit(url)
    key = hashlib.sha256(url.encode()).hexdigest()[:16]
    name = parts.path.strip("/").replace("/", "__").replace("+", "plus")[-120:]
    return VENDOR / parts.hostname / f"{key}-{name}"


@pytest.fixture(scope="session")
def base_url():
    handler = serve.make_handler(serve.SITE, FIXTURE)
    handler.func.log_message = lambda *a: None  # keep test output quiet
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}/"
    httpd.shutdown()


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch(args=[] if RECORD else OFFLINE_ARGS)
        yield b
        b.close()


class Network:
    """What the page asked for outside localhost: served from the cache, or blocked."""

    def __init__(self):
        self.blocked: list[str] = []
        self.vendor: list[tuple[str, int]] = []  # (url, bytes) answered from the cache
        self.refuse: list[str] = []  # URL parts a test refuses on purpose
        self.refused: list[str] = []  # the URLs it refused

    def handle(self, route):
        url = route.request.url
        host = urlsplit(url).hostname or ""
        if any(part in url for part in self.refuse):
            self.refused.append(url)
            return route.abort("connectionrefused")
        if host in LOCAL_HOSTS:
            return route.continue_()
        if host in VENDOR_HOSTS:
            path = vendor_file(url)
            meta = path.with_suffix(path.suffix + ".json")
            if RECORD and not path.exists():
                resp = route.fetch()
                if resp.ok:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(resp.body())
                    meta.write_text(json.dumps({"url": url, "status": resp.status, "content-type": resp.headers.get("content-type", "")}))
            if path.exists():
                info = json.loads(meta.read_text())
                body = path.read_bytes()
                self.vendor.append((url, len(body)))
                return route.fulfill(status=info["status"], body=body, headers={
                    "content-type": info["content-type"], "access-control-allow-origin": "*",
                })
        self.blocked.append(url)
        return route.abort("internetdisconnected")


@pytest.fixture()
def network():
    return Network()


@pytest.fixture()
def context(browser, network):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    ctx.route("**/*", network.handle)
    yield ctx
    ctx.close()
    missing = [u for u in network.blocked if urlsplit(u).hostname in VENDOR_HOSTS]
    assert not missing, (
        "These library files are not in v2/tests-browser/.vendor/. Run the tests once with "
        "BOARDSTAT_RECORD_VENDOR=1 (needs network access to cdn.jsdelivr.net):\n" + "\n".join(missing)
    )
    assert not network.blocked, "The page asked for something outside localhost:\n" + "\n".join(network.blocked)


@pytest.fixture()
def page(context) -> Page:
    p = context.new_page()
    errors: list[str] = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.errors = errors
    console: list[str] = []
    p.on("console", lambda m: m.type == "error" and console.append(f"{m.text} ({m.location.get('url', '')})"))
    p.console_errors = console
    p.allow_console = list(ALLOWED_CONSOLE_ERRORS)  # a test may add to it
    yield p
    unexpected = [c for c in console if not any(a in c for a in p.allow_console)]
    assert not unexpected, "The page logged console errors:\n" + "\n".join(unexpected)


def wait_for_data(page: Page, timeout: float = 60_000) -> None:
    """The district or map page has loaded its rows and counted them ("N requests match.")."""
    page.wait_for_function(
        "() => /requests? match/.test(document.getElementById('status')?.textContent || '')",
        timeout=timeout,
    )


@pytest.fixture()
def district(page, base_url) -> Page:
    page.goto(base_url + DISTRICT_PATH)
    wait_for_data(page)
    return page
