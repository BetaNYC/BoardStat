"""End-to-end build on a tiny offline fixture: two squares and a handful of points.

Exercises point-in-polygon, days_to_close edge cases, the agreement report,
output files, and the manifest's required keys. No network.
"""

import csv
import datetime as dt
import gzip
import json

import duckdb
import pytest

import boardstat_build as bb

# Square A = boro_cd 101 / council 1; square B = boro_cd 302 / council 33 (NYC-ish coordinates).
SQ_A = [[-74.0, 40.7], [-73.9, 40.7], [-73.9, 40.8], [-74.0, 40.8], [-74.0, 40.7]]
SQ_B = [[-73.9, 40.7], [-73.8, 40.7], [-73.8, 40.8], [-73.9, 40.8], [-73.9, 40.7]]


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def poly(props, ring):
    return {"type": "Feature", "properties": props, "geometry": {"type": "MultiPolygon", "coordinates": [[ring]]}}


def row(key, created, closed, ctype, lat, lon, board="01 MANHATTAN", council="1", addr="1 MAIN STREET"):
    base = dict.fromkeys(bb.FIELDS_311, "")
    base.update(unique_key=key, created_date=created, closed_date=closed, agency="DSNY", agency_name="Sanitation",
                complaint_type=ctype, descriptor="d", status="Closed" if closed else "Open",
                incident_address=addr, borough="MANHATTAN", community_board=board, council_district=council,
                latitude=lat, longitude=lon)
    return [base[f] for f in bb.FIELDS_311]


@pytest.fixture()
def built(tmp_path):
    cd = tmp_path / "cd.geojson"
    cc = tmp_path / "cc.geojson"
    cd.write_text(json.dumps(fc([poly({"boro_cd": "101"}, SQ_A), poly({"boro_cd": "302"}, SQ_B)])))
    cc.write_text(json.dumps(fc([poly({"coundist": "1"}, SQ_A), poly({"coundist": "33"}, SQ_B)])))
    rows = [
        row("1", "2026-01-05T10:00:00.000", "2026-01-07T10:00:00.000", "PLUMBING", "40.75", "-73.95"),  # A, 2 days
        row("2", "2026-01-06T10:00:00.000", "", "Plumbing", "40.75", "-73.95"),  # A, open
        row("3", "2026-01-06T10:00:00.000", "2026-01-05T10:00:00.000", "Noise", "40.75", "-73.85",
            board="02 BROOKLYN", council="35", addr="2 SIDE STREET"),  # B, closed before created; city council differs
        row("4", "2026-01-07T10:00:00.000", "2099-01-01T00:00:00.000", "Noise", "40.75", "-73.85",
            board="02 BROOKLYN", council="33", addr="2 SIDE STREET"),  # B, closed in future
        row("5", "2026-01-08T10:00:00.000", "2026-01-08T10:00:00.000", "Noise", "", "", board="02 BROOKLYN"),  # no coords
        row("6", "2026-01-08T10:00:00.000", "", "Noise", "40.50", "-74.20"),  # in bbox, outside both squares
        row("7", "2026-01-08T10:00:00.000", "", "Noise", "0", "0"),  # junk coords
        row("8", "2025-12-31T23:59:59.000", "", "Noise", "40.75", "-73.95"),  # before window
        row("1", "2026-01-05T10:00:00.000", "2026-01-07T10:00:00.000", "PLUMBING", "40.75", "-73.95"),  # duplicate key
    ]
    raw = tmp_path / "jan.csv.gz"
    with gzip.open(raw, "wt", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(bb.FIELDS_311)
        w.writerows(rows)
    out = tmp_path / "out"
    tmap = tmp_path / "map.csv"
    m = bb.build([raw], cd, cc, tmap, out, dt.date(2026, 1, 1), dt.date(2026, 1, 31),
                 sources={"service_requests": {"id": "fixture"}},
                 now=dt.datetime(2026, 2, 1, tzinfo=dt.UTC))
    return m, out, tmap


def test_manifest_has_required_keys(built):
    m, out, _ = built
    bb.validate_manifest(m)
    on_disk = json.loads((out / "manifest.json").read_text())
    for k in bb.REQUIRED_MANIFEST_KEYS:
        assert k in on_disk
    assert m["generated_at"].endswith("Z")


def test_validate_manifest_rejects_missing_key():
    with pytest.raises(bb.PipelineError):
        bb.validate_manifest({"generated_at": "x"})


def test_counts_and_dedup(built):
    m, _, _ = built
    c = m["counts"]
    assert c["total"] == 7  # 9 rows - 1 duplicate - 1 before window
    assert c["with_coords"] == 5  # rows 1,2,3,4,6
    assert c["without_coords"] == 2  # rows 5 and 7
    assert c["not_in_any_cd"] == 3  # 5, 6, 7
    assert c["closed_before_created"] == 1
    assert c["closed_in_future"] == 1


def test_point_in_polygon_assignment(built):
    _, out, _ = built
    a = duckdb.sql(f"SELECT unique_key, cd, cc FROM '{out}/detail/cd/101.parquet' ORDER BY unique_key").fetchall()
    b = duckdb.sql(f"SELECT unique_key, cd, cc FROM '{out}/detail/cc/33.parquet' ORDER BY unique_key").fetchall()
    assert a == [("1", 101, 1), ("2", 101, 1)]
    assert b == [("3", 302, 33), ("4", 302, 33)]


def test_days_to_close_edge_cases(built):
    _, out, _ = built
    got = dict(duckdb.sql(f"""
        SELECT unique_key, struct_pack(d := days_to_close, f := close_flag)
        FROM read_parquet(['{out}/detail/cd/101.parquet', '{out}/detail/cd/302.parquet'])
    """).fetchall())
    assert got["1"] == {"d": 2.0, "f": None}
    assert got["2"] == {"d": None, "f": None}  # open
    assert got["3"] == {"d": None, "f": "closed_before_created"}
    assert got["4"] == {"d": None, "f": "closed_in_future"}


def test_types_normalized_in_outputs(built):
    _, out, tmap = built
    types = {r[0] for r in duckdb.sql(f"SELECT DISTINCT complaint_type FROM '{out}/detail/cd/101.parquet'").fetchall()}
    assert types == {"Plumbing"}
    assert "plumbing" in tmap.read_text()


def test_agreement_report(built):
    m, _, _ = built
    cc = m["agreement"]["council"]
    assert cc["compared"] == 4 and cc["matches"] == 3  # row 3 disagrees (city says 35)
    cd = m["agreement"]["community_district"]
    assert cd["compared"] == 4 and cd["matches"] == 4


def test_unlocated_rows_counted_against_city_board(built):
    m, _, _ = built
    by_id = {d["id"]: d for d in m["districts"]["cd"]}
    assert by_id[302]["unlocated_city_assigned"] == 1  # row 5
    assert by_id[101]["label"] == "Manhattan CD 1"


def test_aggregates_and_addresses(built):
    _, out, _ = built
    city = duckdb.sql(f"SELECT complaint_type, n FROM '{out}/agg/month_type.parquet' WHERE geo_kind='city' ORDER BY 1").fetchall()
    assert city == [("Noise", 2), ("Plumbing", 2)]
    addrs = duckdb.sql(f"SELECT address, cd, cc, n FROM '{out}/addresses.parquet' ORDER BY 1").fetchall()
    assert addrs == [("1 MAIN STREET", 101, 1, 2), ("2 SIDE STREET", 302, 33, 2)]


def test_boundaries_written_with_labels(built):
    _, out, _ = built
    gj = json.loads((out / "boundaries" / "cd.geojson").read_text())
    assert [f["properties"]["label"] for f in gj["features"]] == ["Manhattan CD 1", "Brooklyn CD 2"]


def test_rerun_is_idempotent(built, tmp_path):
    m, out, tmap = built
    before = tmap.read_text()
    files_before = sorted(p.name for p in out.rglob("*.parquet"))
    # Same build again into the same folder: same files, same map.
    raw = next(tmp_path.glob("*.csv.gz"))
    m2 = bb.build([raw], tmp_path / "cd.geojson", tmp_path / "cc.geojson", tmap, out,
                  dt.date(2026, 1, 1), dt.date(2026, 1, 31), sources={},
                  now=dt.datetime(2026, 2, 1, tzinfo=dt.UTC))
    assert tmap.read_text() == before
    assert sorted(p.name for p in out.rglob("*.parquet")) == files_before
    assert m2["counts"] == m["counts"]
