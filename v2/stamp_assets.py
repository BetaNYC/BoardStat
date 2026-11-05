#!/usr/bin/env python3
"""Stamp BoardStat 2.0's CSS and JS links with a content hash, so browsers fetch new code.

beta.nyc's server tells browsers to keep .js and .css files for 120 days
(cache-control: max-age=10368000; HTML pages get max-age=0). Without a version in
the URL, visitors would keep running old code after an upload.

What it does, for every site/*.html:
- css/x.css and js/x.js links get ?v=<hash of that file>.
- An import map is written between the importmap markers, mapping each
  ./js/<module>.js to ./js/<module>.js?v=<hash>. Modules import each other as
  './lib.js'; the browser resolves that to the same URL as the map key and then
  uses the stamped URL (https://html.spec.whatwg.org/multipage/webappapis.html#import-maps).

Safe to run again: it replaces old stamps. Run it before every upload.
Usage: python3 v2/stamp_assets.py
"""
import hashlib
import json
import re
from pathlib import Path

SITE = Path(__file__).resolve().parent / "site"
START, END = "<!-- importmap:start -->", "<!-- importmap:end -->"


def short_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:10]


def main() -> None:
    js = {p.name: short_hash(p) for p in sorted((SITE / "js").glob("*.js"))}
    css = {p.name: short_hash(p) for p in sorted((SITE / "css").glob("*.css"))}
    imports = {f"./js/{name}": f"./js/{name}?v={h}" for name, h in js.items()}
    block = f'{START}\n  <script type="importmap">{json.dumps({"imports": imports}, separators=(",", ":"))}</script>\n  {END}'

    for page in sorted(SITE.glob("*.html")):
        html = page.read_text()
        html = re.sub(r'href="css/([\w.-]+\.css)(\?v=\w+)?"', lambda m: f'href="css/{m[1]}?v={css[m[1]]}"' if m[1] in css else m[0], html)
        html = re.sub(r'src="js/([\w.-]+\.js)(\?v=\w+)?"', lambda m: f'src="js/{m[1]}?v={js[m[1]]}"' if m[1] in js else m[0], html)
        if START in html:
            html = re.sub(re.escape(START) + r".*?" + re.escape(END), block, html, flags=re.S)
        else:  # first run: the import map must come before any module script
            html = html.replace("</head>", f"  {block}\n</head>", 1)
        page.write_text(html)
        print(f"stamped {page.name}")


if __name__ == "__main__":
    main()
