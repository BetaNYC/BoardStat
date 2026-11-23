"""Build the browser tests' fixture (#186) from already-published BoardStat data files.

The fixture is a small, real slice of the published build: Queens Joint Interest Area
480 (8,273 requests, 2020 to the build date), the community district boundaries, the
manifest, a changes.json stub, and only the rows of agg/month_type.parquet that the district page's Compare
panel reads for that district (cd 480, Queens, the city).

It never calls NYC Open Data and never runs the pipeline. The source folder holds files
downloaded from https://www.beta.nyc/boardstat/data/ (manifest.json,
boundaries/cd.geojson, agg/month_type.parquet, detail/cd/480.parquet).

Usage, from v2/pipeline (it needs DuckDB):
    uv run python ../tests-browser/make_fixture.py ../site/data ../tests-browser/fixture-data
"""
import json
import shutil
import sys
from pathlib import Path

import duckdb

DISTRICT = "480"
BOROUGH = "Queens"


def main(src: Path, out: Path) -> None:
    (out / "boundaries").mkdir(parents=True, exist_ok=True)
    (out / "agg").mkdir(exist_ok=True)
    (out / "detail" / "cd").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src / "boundaries" / "cd.geojson", out / "boundaries" / "cd.geojson")
    shutil.copyfile(src / "detail" / "cd" / f"{DISTRICT}.parquet", out / "detail" / "cd" / f"{DISTRICT}.parquet")
    con = duckdb.connect()
    agg_in = (src / "agg" / "month_type.parquet").as_posix()
    agg_out = (out / "agg" / "month_type.parquet").as_posix()
    con.execute(
        f"""COPY (SELECT * FROM read_parquet('{agg_in}')
                  WHERE (geo_kind = 'cd' AND geo_id = '{DISTRICT}')
                     OR (geo_kind = 'borough' AND geo_id = '{BOROUGH}')
                     OR geo_kind = 'city'
                  ORDER BY geo_kind, geo_id, year_month, complaint_type)
            TO '{agg_out}' (FORMAT parquet, COMPRESSION zstd)"""
    )
    manifest = json.loads((src / "manifest.json").read_text())
    manifest["fixture"] = (
        "Browser-test fixture (v2/tests-browser/make_fixture.py): only Queens Joint Interest "
        f"Area {DISTRICT} has a detail file here; agg/month_type.parquet holds only cd {DISTRICT}, "
        f"{BOROUGH} and the city."
    )
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    # The nightly job writes data/changes.json; a fixture has no night before it, so it
    # gets a stub with nothing changed (format: lib.js renderChanges). Without it every
    # page logs a 404 (QA round 1).
    zero = {"new": 0, "updated": 0, "closed": 0}
    changes = {"fixture": "stub: nothing changed", "since": manifest["generated_at"], "city": zero, "cd": {DISTRICT: zero}}
    (out / "changes.json").write_text(json.dumps(changes, indent=1) + "\n")
    shutil.copyfile(Path(__file__).resolve().parents[2] / "LICENSE-DATA.md", out / "LICENSE.txt")
    for p in sorted(out.rglob("*")):
        if p.is_file():
            print(f"{p.relative_to(out)}  {p.stat().st_size:,} bytes")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
