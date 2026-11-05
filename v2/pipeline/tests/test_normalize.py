"""Complaint-type normalization and the reviewed mapping file."""

import boardstat_build as bb


def test_type_key_is_case_and_space_insensitive():
    assert bb.type_key("PLUMBING") == bb.type_key("Plumbing") == bb.type_key("  plumbing ")
    assert bb.type_key("Noise -  Residential") == "noise - residential"
    assert bb.type_key(None) == ""


def test_choose_display_prefers_most_common_non_all_caps():
    assert bb.choose_display({"PLUMBING": 900, "Plumbing": 100}) == "Plumbing"
    assert bb.choose_display({"ELEVATOR": 5}) == "ELEVATOR"  # only spelling available
    assert bb.choose_display({"Noise": 3, "noise": 3}) == "Noise"  # tie breaks deterministically


def test_merge_seeds_unreviewed_rows_and_groups_case():
    rows = bb.merge_type_map([], {"PLUMBING": 10, "Plumbing": 4, "Elevator": 2, "ELEVATOR": 9, "": 1, None: 3})
    keys = [r["type_key"] for r in rows]
    assert keys == ["elevator", "plumbing"]
    assert all(r["reviewed"] == "false" for r in rows)
    assert {r["type_key"]: r["display"] for r in rows} == {"elevator": "Elevator", "plumbing": "Plumbing"}
    assert rows[1]["raw_variants"] == "PLUMBING|Plumbing"


def test_merge_keeps_human_edits_and_is_idempotent(tmp_path):
    existing = [{"type_key": "plumbing", "display": "Plumbing (building)", "reviewed": "true", "raw_variants": "PLUMBING"}]
    rows = bb.merge_type_map(existing, {"Plumbing": 1, "PLUMBING": 1, "Graffiti": 2})
    plumbing = next(r for r in rows if r["type_key"] == "plumbing")
    assert plumbing["display"] == "Plumbing (building)"
    assert plumbing["reviewed"] == "true"
    assert plumbing["raw_variants"] == "PLUMBING|Plumbing"
    path = tmp_path / "map.csv"
    assert bb.write_type_map(path, rows) is True
    again = bb.merge_type_map(bb.read_type_map(path), {"Plumbing": 1, "Graffiti": 2})
    assert bb.write_type_map(path, again) is False  # nothing changed on rerun


def test_parse_city_board():
    assert bb.parse_city_board("02 BROOKLYN") == 302
    assert bb.parse_city_board("12 MANHATTAN") == 112
    assert bb.parse_city_board("01 STATEN ISLAND") == 501
    assert bb.parse_city_board("64 MANHATTAN") == 164
    assert bb.parse_city_board("Unspecified BROOKLYN") is None
    assert bb.parse_city_board("0 Unspecified") is None
    assert bb.parse_city_board(None) is None


def test_labels():
    assert bb.cd_label(306) == ("Brooklyn CD 6", False, "Brooklyn")
    assert bb.cd_label(164)[1] is True
    assert bb.cd_label(226)[1] is True
    assert bb.cd_label(318)[1] is False
    assert bb.cc_label(33) == "Council District 33"
