"""Local static server for the BoardStat 2.0 prototype, with HTTP Range support.

`python3 -m http.server` ignores Range headers. The street basemap (PMTiles) reads
small byte ranges of one large file, so it needs a server that answers 206 Partial
Content (RFC 9110 section 14). Standard library only.

Usage: python3 v2/serve.py [--port 8000] [--bind 127.0.0.1]
"""
import argparse
import os
import re
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


class RangeHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.translate_path(self.path)
        match = RANGE_RE.match(self.headers.get("Range", "").strip())
        if not match or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        first, last = match.groups()
        if first == "":  # suffix range: the last N bytes
            if last == "" or int(last) == 0:
                return super().send_head()
            start, end = max(size - int(last), 0), size - 1
        else:
            start = int(first)
            end = min(int(last), size - 1) if last else size - 1
        if start >= size or start > end:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        f = open(path, "rb")
        f.seek(start)
        self._remaining = end - start + 1
        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(self._remaining))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        self._remaining = None
        while remaining > 0:
            chunk = source.read(min(65536, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def end_headers(self):
        if self.headers.get("Range") is None:
            self.send_header("Accept-Ranges", "bytes")
        super().end_headers()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--bind", default="127.0.0.1")
    args = ap.parse_args()
    handler = partial(RangeHandler, directory=SITE)
    with ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        print(f"Serving {SITE} at http://{args.bind}:{args.port}/")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
