"""The filter form as a person uses it, in a real browser (#186).

The district page is served by v2/serve.py's handler with the fixture data (Queens Joint
Interest Area 480), offline. See conftest.py.
"""
import re
from urllib.parse import parse_qs, urlsplit

from conftest import DISTRICT_PATH, wait_for_data

# Roles of the controls a person (or an agent) can operate. Options inside a list are
# parts of their control, not controls of their own.
CONTROL_ROLES = ("button", "checkbox", "combobox", "textbox", "searchbox", "spinbutton", "radio", "switch", "slider", "listbox")
LINE = re.compile(r'^\s*- (?P<role>[a-z]+)(?: "(?P<name>(?:[^"\\]|\\.)*)")?')


def count(page) -> int:
    text = page.locator("#status").text_content()
    m = re.match(r"([\d,]+) requests? match", text)
    assert m, text
    return int(m.group(1).replace(",", ""))


def open_every_group(page) -> None:
    for d in page.locator("#filters details.filter-group").all():
        d.evaluate("d => { d.open = true; }")


def form_controls(page) -> list[tuple[str, str]]:
    """(role, accessible name) of every control in the form's accessibility tree."""
    out = []
    for line in page.locator("#filters").aria_snapshot().splitlines():
        m = LINE.match(line)
        if m and m["role"] in CONTROL_ROLES:
            out.append((m["role"], (m["name"] or "").strip()))
    return out


def test_page_loads_the_fixture_offline(district):
    assert count(district) > 0
    assert district.errors == []


def test_apply_changes_the_page_and_the_link(district):
    page = district
    before = count(page)
    open_every_group(page)
    agency = page.get_by_label("Agency (most requests in these dates first)")
    # The first agency the data offers (the list puts the most requests first).
    value = agency.locator("option").nth(1).get_attribute("value")
    agency.select_option(value)
    # Changing a control changes only the form (#142): the page waits for Apply.
    assert page.locator("#pending").text_content().startswith("Filters changed.")
    assert "agency=" not in page.url
    page.get_by_role("button", name="Apply filters").click()
    page.wait_for_function("() => !document.getElementById('pending').textContent")
    wait_for_data(page)
    assert parse_qs(urlsplit(page.url).query)["agency"] == [value]
    after = count(page)
    assert 0 < after < before
    assert page.errors == []


def test_every_filter_control_has_a_unique_name(page, base_url):
    """Accessibility-tree check: every control on the filter form has a name, and no two
    share one, so a screen reader user (and an agent) can tell them apart. The link sets
    two problems and a description, so their chips' remove buttons are checked too."""
    page.goto(base_url + DISTRICT_PATH + "&type=Taxi%20Complaint|Lost%20Property&desc=Bag%2FWallet")
    wait_for_data(page)
    open_every_group(page)
    controls = form_controls(page)
    assert len(controls) >= 8, controls
    removes = [name for _, name in controls if name.lower().startswith("remove")]
    assert len(removes) == 3, f"expected a remove button per chip: {controls}"
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
    page.locator("#filters-toggle").click()  # the map's panel starts closed
    page.locator("#fg-problem summary").click()
    page.locator("#f-type input").click()
    page.keyboard.type("lost")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    page.keyboard.press("Escape")
    page.get_by_role("button", name="Apply filters").click()
    page.wait_for_function("() => location.search.includes('type=Lost')")
    assert parse_qs(urlsplit(page.url).query)["type"] == ["Lost Property"]
    assert page.errors == []
