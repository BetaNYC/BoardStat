"""serve.py --data (#186): a folder served at /data/ instead of site/data, with ranges."""
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

V2 = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(V2))
import serve  # noqa: E402


def test_data_folder_is_served_at_data(tmp_path):
    (tmp_path / "manifest.json").write_text('{"ok": true}')
    (tmp_path / "detail").mkdir()
    (tmp_path / "detail" / "x.bin").write_bytes(bytes(range(10)))
    handler = serve.make_handler(serve.SITE, tmp_path)
    handler.func.log_message = lambda *a: None
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        assert urllib.request.urlopen(f"{base}/data/manifest.json?v=1").read() == b'{"ok": true}'
        req = urllib.request.Request(f"{base}/data/detail/x.bin", headers={"Range": "bytes=2-4"})
        with urllib.request.urlopen(req) as r:
            assert r.status == 206 and r.read() == bytes([2, 3, 4])
        # Site files still come from the site folder.
        assert b"<html" in urllib.request.urlopen(f"{base}/district.html").read()
    finally:
        httpd.shutdown()
