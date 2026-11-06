"""Month windows, default window, schema check, boundary version parsing."""

import datetime as dt

import pytest

import boardstat_build as bb


def test_month_windows_clip_to_range():
    w = bb.month_windows(dt.date(2025, 11, 15), dt.date(2026, 1, 3))
    assert [(x.start, x.end) for x in w] == [
        (dt.date(2025, 11, 15), dt.date(2025, 12, 1)),
        (dt.date(2025, 12, 1), dt.date(2026, 1, 1)),
        (dt.date(2026, 1, 1), dt.date(2026, 1, 4)),
    ]


def test_month_windows_rejects_reversed_range():
    with pytest.raises(bb.PipelineError):
        bb.month_windows(dt.date(2026, 2, 1), dt.date(2026, 1, 1))


def test_default_view_is_12_full_months_plus_current():
    assert bb.default_view_start(bb.HISTORY_START, dt.date(2026, 11, 4)) == dt.date(2025, 11, 1)
    assert bb.default_view_start(bb.HISTORY_START, dt.date(2026, 1, 31)) == dt.date(2025, 1, 1)


def test_default_view_never_starts_before_the_data():
    assert bb.default_view_start(dt.date(2026, 6, 15), dt.date(2026, 11, 4)) == dt.date(2026, 6, 15)


def test_build_start_before_2020_fails_loudly():
    with pytest.raises(bb.PipelineError, match="76ig-c548"):
        bb.check_start(dt.date(2019, 11, 1))
    bb.check_start(dt.date(2020, 1, 1))  # the pinned start is fine


def test_build_default_start_is_pinned_to_2020():
    assert bb.parse_args([]).start == dt.date(2020, 1, 1)


def test_build_main_refuses_pre_2020_before_any_network_call(monkeypatch):
    def no_network(*a, **k):
        raise AssertionError("must fail before contacting the portal")
    monkeypatch.setattr(bb.Soda, "get", no_network)
    with pytest.raises(bb.PipelineError, match="before 2020-01-01"):
        bb.main(["--start", "2019-11-01", "--end", "2020-02-01"])


def test_schema_check_fails_loudly_on_missing_field():
    meta = {"name": "311 Service Requests from 2020 to Present", "columns": [{"fieldName": f} for f in bb.FIELDS_311 if f != "latitude"]}
    with pytest.raises(bb.PipelineError, match="latitude"):
        bb.check_schema(meta, bb.FIELDS_311, "erm2-nwe9")


def test_schema_check_fails_on_renamed_dataset():
    meta = {"name": "Something else", "columns": [{"fieldName": f} for f in bb.FIELDS_311]}
    with pytest.raises(bb.PipelineError, match="named"):
        bb.check_schema(meta, bb.FIELDS_311, "erm2-nwe9", name_hint="311 Service Requests")


def test_schema_check_passes():
    meta = {"name": "311 Service Requests from 2020 to Present", "columns": [{"fieldName": f} for f in bb.FIELDS_311 + ["location"]]}
    bb.check_schema(meta, bb.FIELDS_311, "erm2-nwe9", name_hint="311 Service Requests")


def test_boundary_version_from_description():
    assert bb.boundary_version({"description": "... Current version: 26c"}) == "26c"
    assert bb.boundary_version({"description": "no version here"}) is None


def test_inline_script_deps_match_pyproject():
    """The PEP 723 block and pyproject.toml must declare the same runtime deps."""
    import re
    import tomllib
    from pathlib import Path

    here = Path(bb.__file__).resolve().parent
    py = tomllib.loads((here / "pyproject.toml").read_text())
    block = re.search(r"# /// script\n(.*?)# ///", (here / "boardstat_build.py").read_text(), re.DOTALL).group(1)
    inline = tomllib.loads("\n".join(line[2:] if line.startswith("# ") else "" for line in block.splitlines()))
    assert sorted(inline["dependencies"]) == sorted(py["project"]["dependencies"])
    assert inline["requires-python"] == py["project"]["requires-python"]
