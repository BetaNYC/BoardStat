"""The filter form as a person uses it, in a real browser (#186).

The district page is served by v2/serve.py's handler with the fixture data (Queens Joint
Interest Area 480), offline. See conftest.py.
"""
import re
from urllib.parse import parse_qs, urlsplit

from conftest import ADDRESS_PATH, DISTRICT_PATH, wait_for_data

# Roles of the controls a person (or an agent) can operate. Options inside a list are
# parts of their control, not controls of their own.
CONTROL_ROLES = ("button", "checkbox", "combobox", "textbox", "searchbox", "spinbutton", "radio", "switch", "slider", "listbox")
# A picker's chips row is a toolbar, named apart from its combobox (QA round 1).
NAMED_ROLES = (*CONTROL_ROLES, "toolbar")
# The snapshot is YAML: a line whose name holds ": " is wrapped in single quotes.
LINE = re.compile(r'^\s*- \'?(?P<role>[a-z]+)(?: "(?P<name>(?:[^"\\]|\\.)*)")?')


def count(page) -> int:
    text = page.locator("#status").text_content()
    m = re.match(r"([\d,]+) requests? match", text)
    assert m, text
    return int(m.group(1).replace(",", ""))


def open_every_group(page) -> None:
    for d in page.locator("#filters details.filter-group").all():
        d.evaluate("d => { d.open = true; }")


def form_controls(page, roles=NAMED_ROLES) -> list[tuple[str, str]]:
    """(role, accessible name) of every control (and chips row) in the form's accessibility tree."""
    out = []
    for line in page.locator("#filters").aria_snapshot().splitlines():
        m = LINE.match(line)
        if m and m["role"] in roles:
            out.append((m["role"], (m["name"] or "").strip()))
    return out


def test_page_loads_the_fixture_offline(district):
    assert count(district) > 0
    assert district.errors == []


def pick(page, box: str, text: str, label: str) -> None:
    """Type in a picker and click the choice whose text is exactly `label`."""
    page.locator(f"#{box} input").click()
    page.keyboard.type(text)
    page.locator(f"#{box} ui-combobox-item", has_text=re.compile(rf"^\s*{re.escape(label)}\s*$")).first.click()


def problem_list(page) -> set[str]:
    return set(page.evaluate("() => document.getElementById('f-type').items.map((i) => i.value)"))


def test_two_agencies_apply_to_the_page_and_the_link(district, base_url):
    """#192: Agency takes several picks, and the link carries them all. Each old
    one-agency link still opens, and the two counts add up to the two-agency count."""
    page = district
    before = count(page)
    every_problem = problem_list(page)
    pick(page, "f-agency", "DOT", "DOT (Department of Transportation)")
    pick(page, "f-agency", "NYPD", "NYPD (New York City Police Department)")
    page.keyboard.press("Escape")
    assert page.evaluate("document.getElementById('f-agency').value") == ["DOT", "NYPD"]
    # Changing a control changes only the form (#142): the page waits for Apply.
    assert page.locator("#pending").text_content().startswith("Filters changed.")
    assert "agency=" not in page.url
    # Problem now lists only those agencies' problems (in the fixture: DOT's and NYPD's, never TLC's).
    page.wait_for_function("""() => { const v = document.getElementById('f-type').items.map((i) => i.value);
        return v.includes('Illegal Parking') && v.includes('Traffic Signal Condition') && !v.includes('Taxi Complaint'); }""")
    problems = problem_list(page)
    assert {"Traffic Signal Condition", "Illegal Parking"} <= problems < every_problem
    assert "Taxi Complaint" not in problems and "Lost Property" not in problems
    page.get_by_role("button", name="Apply filters").click()
    page.wait_for_function("() => !document.getElementById('pending').textContent")
    wait_for_data(page)
    assert parse_qs(urlsplit(page.url).query)["agency"] == ["DOT|NYPD"]
    both = count(page)
    assert 0 < both < before
    # Links made before #192 carry one agency=; each opens with that agency chosen.
    singles = []
    for code in ("DOT", "NYPD"):
        other = page.context.new_page()
        other.goto(base_url + DISTRICT_PATH + f"&agency={code}")
        wait_for_data(other)
        assert other.evaluate("document.getElementById('f-agency').value") == [code]
        singles.append(count(other))
        other.close()
    assert sum(singles) == both
    assert page.errors == []


def test_every_filter_control_has_a_unique_name(page, base_url):
    """Accessibility-tree check: every control on the filter form has a name, and no two
    share one, so a screen reader user (and an agent) can tell them apart. The link sets
    two problems and two descriptions, so their chips' remove buttons are checked too.
    "Derelict Vehicles" is both a problem and a description (14 real names are), which
    gave two buttons the same name before QA round 1."""
    page.goto(base_url + DISTRICT_PATH + "&agency=TLC|NYPD&type=Taxi%20Complaint|Derelict%20Vehicles&desc=Derelict%20Vehicles|Bag%2FWallet")
    wait_for_data(page)
    open_every_group(page)
    controls = form_controls(page)
    assert len(controls) >= 8, controls
    removes = [name for _, name in controls if name.lower().startswith("remove")]
    assert len(removes) == 6, f"expected a remove button per chip: {controls}"
    assert ("button", "Remove agency filter TLC") in controls and ("button", "Remove agency filter NYPD") in controls
    assert ("toolbar", "Chosen agencies") in controls
    assert ("button", "Remove problem filter Derelict Vehicles") in controls
    assert ("button", "Remove description filter Derelict Vehicles") in controls
    assert ("toolbar", "Chosen problems") in controls and ("toolbar", "Chosen descriptions") in controls
    # Chips (groups) are named apart too, and say Excluded in Exclude mode.
    groups = form_controls(page, ("group",))
    assert ("group", "Chosen problem: Derelict Vehicles") in groups and ("group", "Chosen description: Derelict Vehicles") in groups
    unnamed = [role for role, name in controls if not name]
    assert not unnamed, f"controls without a name: {unnamed}"
    names = [name for _, name in controls]
    dupes = sorted({n for n in names if names.count(n) > 1})
    assert not dupes, f"names used by more than one control: {dupes}"


def test_full_page_map_runs_the_same_form(page, base_url):
    """#149: map.html has the district page's form. With the UI SDK pickers (#187), a
    problem chosen there is applied to the map and its link."""
    from conftest import MAP_PATH
    page.goto(base_url + MAP_PATH)
    page.wait_for_function("() => document.getElementById('f-type').items?.length > 0", timeout=60_000)
    # The map's blue panel starts open on a wide screen, with every group open (#193).
    page.locator("#f-type input").click()
    page.keyboard.type("lost")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    page.keyboard.press("Escape")
    page.get_by_role("button", name="Apply filters").click()
    page.wait_for_function("() => location.search.includes('type=Lost')")
    assert parse_qs(urlsplit(page.url).query)["type"] == ["Lost Property"]
    assert page.errors == []


def test_exclude_mode_renames_the_description_chips(page, base_url):
    page.goto(base_url + DISTRICT_PATH + "&desc=Derelict%20Vehicles&descx=1")
    wait_for_data(page)
    controls = form_controls(page, (*NAMED_ROLES, "group"))
    assert ("toolbar", "Excluded descriptions") in controls
    assert ("group", "Excluded description: Derelict Vehicles") in controls
    page.locator("#f-desc-ex").click()  # untick: back to chosen, in the form only
    controls = form_controls(page, (*NAMED_ROLES, "group"))
    assert ("toolbar", "Chosen descriptions") in controls


def test_address_page_runs_the_same_form(page, base_url):
    """The address page (QA round 1: it had no browser test). Its address is fixed, and
    the form's pickers work the same there."""
    page.goto(base_url + ADDRESS_PATH)
    wait_for_data(page)
    assert "LA GUARDIA AIRPORT" in page.locator("h1").text_content()
    before = count(page)
    page.locator("#f-type input").click()
    page.keyboard.type("lost")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    page.keyboard.press("Escape")
    page.get_by_role("button", name="Apply filters").click()
    page.wait_for_function("() => !document.getElementById('pending').textContent")
    wait_for_data(page)
    assert 0 < count(page) < before
    # The address page never rewrites its link (district.js writeUrl: no address in history).
    assert page.url == base_url + ADDRESS_PATH
    assert page.evaluate("document.getElementById('f-type').value") == ["Lost Property"]
    assert page.errors == []
