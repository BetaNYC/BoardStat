"""An AI agent can find and change every setting in the "Problem and description" group,
and press Apply (#187). It uses UI SDK's own agent bridge, createAgent from
@ui-sdk/web/agent, loaded through the page's import map, so it shares the page's copy of
@ui-sdk/core (see js/vendor-importmap.json). Offline, like every browser test.
"""
from urllib.parse import parse_qs, urlsplit

from conftest import DISTRICT_PATH, wait_for_data
from test_filter_form import count

PROBLEM = "Problem (formerly Complaint Type)"
DESCRIPTION = "Description (formerly Descriptor)"
EXCLUDE = "Exclude these descriptions"

# Runs in the page: one bridge per page, created on first use.
BRIDGE = """async () => {
  const { createAgent } = await import('@ui-sdk/web/agent');
  window.__agent ??= createAgent();
}"""


def agent(page, js: str, arg=None):
    page.evaluate(BRIDGE)
    return page.evaluate(f"async (arg) => {{ const agent = window.__agent; {js} }}", arg)


def labels(snapshot) -> dict[str, list[str]]:
    return {c["label"]: c["actions"] for c in snapshot if c.get("label")}


def test_agent_sees_every_setting_in_the_group(district):
    found = labels(agent(district, "return agent.snapshot();"))
    assert found == {
        PROBLEM: ["setOpen", "setValue", "clear", "setQuery"],
        DESCRIPTION: ["setOpen", "setValue", "clear", "setQuery"],
        EXCLUDE: ["setChecked"],
        "Apply filters": ["press"],
        "Reset filters": ["press"],
    }
    # The choices come from the same DuckDB lists a person sees, most requests first.
    found = agent(district, "return agent.query({ within: 'Problem', text: 'taxi' });")
    assert found[0]["items"][0] == {"value": "Taxi Complaint", "label": "Taxi Complaint"}


def test_agent_sets_the_group_and_applies(district):
    before = count(district)
    result = agent(district, "return agent.act({ steps: arg });", [
        {"ref": "Problem", "action": "setValue", "args": [["Taxi Complaint", "Lost Property"]]},
        {"ref": "Description", "action": "setValue", "args": [["Bag/Wallet"]]},
        {"ref": EXCLUDE, "action": "setChecked", "args": [True]},
        {"ref": "Apply filters", "action": "press"},
    ])
    assert result["ok"], result
    district.wait_for_function("() => !document.getElementById('pending').textContent")
    wait_for_data(district)

    # The applied filters are in the link, exactly as a person's Apply writes them.
    params = parse_qs(urlsplit(district.url).query)
    assert params["type"] == ["Taxi Complaint|Lost Property"]
    assert params["desc"] == ["Bag/Wallet"]
    assert params["descx"] == ["1"]
    after = count(district)
    assert 0 < after < before

    # The form shows what was applied: chips, Exclude mode, nothing waiting for Apply.
    chips = district.locator("#f-type ui-combobox-chip").all_text_contents()
    assert [c.strip().rstrip("×").strip() for c in chips] == ["Taxi Complaint", "Lost Property"]
    assert district.locator("#f-desc").get_attribute("data-exclude") == ""
    assert district.locator("#pending").text_content() == ""

    # The same link, opened fresh, gives the same page.
    other = district.context.new_page()
    other.goto(district.url)
    wait_for_data(other)
    assert count(other) == after
    assert district.errors == []


def test_agent_does_not_see_controls_in_a_closed_group(district):
    """Risk 4 in #187, measured with UI SDK 0.1.0-beta.14: createAgent leaves out every
    component inside a closed <details>, and a step that names one fails. Agency and
    status starts closed, and on a phone or the full-page map every group does, so slice 2
    has to open the group for the agent or move the groups to UI SDK's Accordion, which
    the bridge can open by itself ("reveals")."""
    district.evaluate("() => { document.getElementById('fg-problem').open = false; }")
    found = labels(agent(district, "return agent.snapshot();"))
    assert set(found) == {"Apply filters", "Reset filters"}
    result = agent(district, "return agent.act({ steps: arg });",
                   [{"ref": "Problem", "action": "setValue", "args": [["Taxi Complaint"]]}])
    assert not result["ok"]
    assert result["error"]["message"].startswith('No component "Problem" on the page.')
    # Opened again, the group's controls are back.
    district.evaluate("() => { document.getElementById('fg-problem').open = true; }")
    found = labels(agent(district, "return agent.snapshot();"))
    assert PROBLEM in found and DESCRIPTION in found and EXCLUDE in found
