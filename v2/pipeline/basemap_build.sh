#!/usr/bin/env bash
# Build BoardStat 2.0's self-hosted street basemap (Protomaps).
#
# Writes into site/data/basemap/ (gitignored, like the rest of site/data):
#   nyc.pmtiles   NYC-only extract of a Protomaps daily build (OpenStreetMap data, ODbL)
#   fonts/        Noto Sans glyph PBFs (SIL OFL)   from protomaps/basemaps-assets
#   sprites/      v4 sprite sheets                 from protomaps/basemaps-assets
#
# The site then makes no basemap calls to anyone else at runtime.
# Docs: https://docs.protomaps.com/guide/getting-started (extract),
#       https://docs.protomaps.com/basemaps/maplibre (glyphs, sprites).
# Needs: pmtiles CLI (brew install pmtiles), curl, unzip.
# Usage: bash v2/pipeline/basemap_build.sh [YYYYMMDD]   (default: yesterday's build)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../site/data/basemap"
build="${1:-$(date -v-1d +%Y%m%d 2>/dev/null || date -d yesterday +%Y%m%d)}"
# NYC plus enough margin to fill a wide map at citywide zoom; west,south,east,north.
bbox="-74.75,40.35,-73.15,41.15"

command -v pmtiles >/dev/null || { echo "pmtiles CLI not found: brew install pmtiles" >&2; exit 1; }
mkdir -p "$out"

echo "Extracting NYC from https://build.protomaps.com/$build.pmtiles ..."
pmtiles extract "https://build.protomaps.com/$build.pmtiles" "$out/nyc.pmtiles.tmp" --bbox="$bbox"
mv "$out/nyc.pmtiles.tmp" "$out/nyc.pmtiles"

echo "Fetching fonts and sprites from protomaps/basemaps-assets ..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL https://github.com/protomaps/basemaps-assets/archive/refs/heads/main.zip -o "$tmp/assets.zip"
unzip -q "$tmp/assets.zip" -d "$tmp"
rm -rf "$out/fonts" "$out/sprites"
mkdir -p "$out/fonts"
for f in "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic"; do
  cp -R "$tmp/basemaps-assets-main/fonts/$f" "$out/fonts/"
done
cp "$tmp/basemaps-assets-main/fonts/OFL.txt" "$out/fonts/"
cp -R "$tmp/basemaps-assets-main/sprites/v4" "$out/sprites"

printf '{"protomaps_build": "%s", "bbox": "%s", "built": "%s"}\n' \
  "$build" "$bbox" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/basemap.json"
du -sh "$out"/nyc.pmtiles "$out"/fonts "$out"/sprites
echo "Done: $out"
