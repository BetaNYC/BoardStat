"""Guards for what a browser downloads on a district page (#106, follow-up to #126)."""

import re
from pathlib import Path

import duckdb

SITE_JS = Path(__file__).resolve().parents[2] / "site" / "js"


def test_duckdb_wasm_reads_byte_ranges():
    """DuckDB-WASM 1.32.0 defaults forceFullHTTPReads to true and then fetches every
    registered file whole. lib.js must turn it off before the first query."""
    src = (SITE_JS / "lib.js").read_text()
    assert re.search(r"db\.open\(\{\s*filesystem:\s*\{\s*forceFullHTTPReads:\s*false\s*\}\s*\}\)", src)
    assert src.index("db.open(") < src.index("db.connect()")


def test_load_reads_closed_rows_before_open_rows():
    """Closed branch first: the other order made DuckDB-WASM re-fetch ranges (loadplan.js)."""
    src = (SITE_JS / "loadplan.js").read_text()
    load = src[src.index("CREATE OR REPLACE TABLE req AS"):]
    assert load.index("is_closed = true") < load.index("is_closed = false")


def test_year_before_loads_after_the_first_draw():
    """#144: the page draws before the background load of the year before the From date,
    and that load appends Closed rows only (never re-reads the open ones)."""
    src = (SITE_JS / "district.js").read_text()
    refresh = src[src.index("async function refresh()"):]
    assert refresh.index("Promise.all([renderTop()") < refresh.index("loadPriorYear()")
    extend = (SITE_JS / "loadplan.js").read_text()
    extend = extend[extend.index("export function extendSql"):extend.index("export function createSerial")]
    assert "INSERT INTO req" in extend and "is_closed = true" in extend and "is_closed = false" not in extend


def test_compare_query_split_by_geo_matches_the_or_filter(tmp_path):
    """district.js aggRows(): one UNION ALL branch per (geo_kind, geo_id), so row groups
    can be pruned. It must return exactly what the old OR filter returned."""
    path = tmp_path / "month_type.parquet"
    duckdb.sql(f"""
        COPY (
            WITH k AS (
                SELECT 'cd' AS geo_kind, CAST(100 + i AS VARCHAR) AS geo_id FROM range(1, 13) t(i)
                UNION ALL SELECT 'cc', CAST(i AS VARCHAR) FROM range(1, 52) t(i)
                UNION ALL SELECT 'borough', b FROM (VALUES ('Bronx'), ('Brooklyn'), ('Manhattan')) v(b)
                UNION ALL SELECT 'city', 'nyc'
            ),
            m AS (SELECT strftime(DATE '2020-01-01' + to_months(CAST(i AS INTEGER)), '%Y-%m') AS year_month FROM range(0, 82) t(i)),
            t AS (SELECT 'Type ' || i AS complaint_type FROM range(0, 6) t(i))
            SELECT geo_kind, geo_id, year_month, complaint_type, (hash(geo_id, year_month, complaint_type) % 50) + 1 AS n
            FROM k, m, t
            ORDER BY 1, 2, 3, 4
        ) TO '{path}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 2048)
    """)
    f = f"'{path}'"
    ym0, ym1 = "2025-11", "2026-10"
    old = f"""
        SELECT geo_kind, complaint_type, sum(n) FROM {f}
        WHERE year_month BETWEEN '{ym0}' AND '{ym1}'
          AND ((geo_kind = 'cc' AND geo_id = '11') OR (geo_kind = 'borough' AND geo_id = 'Bronx') OR geo_kind = 'city')
        GROUP BY ALL ORDER BY ALL"""
    branches = [("cc", "11"), ("borough", "Bronx"), ("city", None)]
    union = " UNION ALL ".join(
        f"SELECT geo_kind, complaint_type, n FROM {f} WHERE geo_kind = '{k}'"
        + ("" if i is None else f" AND geo_id = '{i}'")
        + f" AND year_month BETWEEN '{ym0}' AND '{ym1}'"
        for k, i in branches
    )
    new = f"SELECT geo_kind, complaint_type, sum(n) FROM ({union}) GROUP BY ALL ORDER BY ALL"
    a, b = duckdb.sql(old).fetchall(), duckdb.sql(new).fetchall()
    assert a and a == b


def test_a_failed_first_load_never_leaves_the_page_waiting():
    """#144 QA: Brooklyn from 2020 failed its first load and the page hung on "Loading…".
    main() must catch the first load and say so."""
    src = (SITE_JS / "district.js").read_text()
    main = src[src.index("async function main()"):]
    first = main.index("await ensureLoaded();")
    assert main.rindex("try {", 0, first) > main.index("USE boardstat")
    assert "loadFailedText(loadError)" in main


def test_table_is_stored_compressed():
    """#144 QA: the req table lives in a compressed in-memory database (Brooklyn from 2020
    did not fit uncompressed). Every query names the table without a database."""
    src = (SITE_JS / "district.js").read_text()
    assert src.index("ATTACH ':memory:' AS boardstat (COMPRESS true)") < src.index("USE boardstat") < src.index("async function main()") + src[src.index("async function main()"):].index("await ensureLoaded();")


def test_year_before_note_is_announced_once():
    """#144 QA: the loading note is redrawn with the chart, so it has no live role; a
    separate live region outside the chart says once when the line arrives."""
    src = (SITE_JS / "district.js").read_text()
    note = src[src.index("'muted prior-loading'") - 40:src.index("'muted prior-loading'") + 120]
    assert "role" not in note
    for page in ("district.html", "address.html"):
        html = (SITE_JS.parent / page).read_text()
        assert re.search(r'id="monthly-live" role="status" aria-live="polite"', html)
        assert html.index('id="monthly"') < html.index('id="monthly-live"')
