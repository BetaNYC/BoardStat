"""The tax-lot rule is written twice: isLot() in site/js/filterstate.js (for links) and
LOT_SQL in site/js/filtersql.js (for queries). Check they agree on the same values."""

import json
import shutil
import subprocess
from pathlib import Path

import duckdb
import pytest

SITE_JS = Path(__file__).resolve().parents[2] / "site" / "js"
VALUES = [
    "1001220001", "5079990100", "3000680001", "2025490001",  # real lots
    "0000000000", "1000000001", "1001220000", "6001220001", "0001220001",  # not lots
    "12345", "10012200010", "1001220001' OR 1=1 --", "abcdefghij", "",
    " 1001220001", "1001220001 ", "1.00122e9", "1001220001.0", "100122000a", "1001220001\n",
]
JS = """
import { isLot } from './filterstate.js';
import { LOT_SQL } from './filtersql.js';
const values = JSON.parse(process.argv[1]);
console.log(JSON.stringify({ sql: LOT_SQL, js: values.map(isLot) }));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_lot_rule_is_the_same_in_js_and_sql():
    r = subprocess.run(["node", "--input-type=module", "-e", JS, json.dumps(VALUES)],
                       capture_output=True, text=True, timeout=60, check=True, cwd=SITE_JS)
    out = json.loads(r.stdout)
    con = duckdb.connect()
    con.execute("CREATE TABLE t (i INTEGER, bbl VARCHAR)")
    con.executemany("INSERT INTO t VALUES (?, ?)", list(enumerate(VALUES)))
    sql = [bool(v) for (v,) in con.execute(f"SELECT coalesce({out['sql']}, false) FROM t ORDER BY i").fetchall()]
    assert sql == out["js"], [(v, s, j) for v, s, j in zip(VALUES, sql, out["js"]) if s != j]
    assert out["js"][:4] == [True] * 4 and not any(out["js"][4:])
