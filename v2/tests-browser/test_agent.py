"""An AI agent can find and change every setting in the "Agency, problem and description"
group, and press Apply (#187; Agency since #192). It uses UI SDK's own agent bridge, createAgent from
@ui-sdk/web/agent, loaded through the page's import map, so it shares the page's copy of
@ui-sdk/core (see js/vendor-importmap.json). Offline, like every browser test.
"""
from urllib.parse import parse_qs, urlsplit

from conftest import DISTRICT_PATH, wait_for_data
from test_filter_form import count

AGENCY = "Agency"
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
        AGENCY: ["setOpen", "setValue", "clear", "setQuery"],
        PROBLEM: ["setOpen", "setValue", "clear", "setQuery"],
        DESCRIPTION: ["setOpen", "setValue", "clear", "setQuery"],
        EXCLUDE: ["setChecked"],
        "Apply filters": ["press"],
        "Reset filters": ["press"],
    }
    # The choices come from the same DuckDB lists a person sees, A to Z (#199).
    found = agent(district, "return agent.query({ within: 'Problem', text: 'taxi' });")
    taxi = [i["label"] for i in found[0]["items"]]
    assert "Taxi Complaint" in taxi and taxi == sorted(taxi, key=str.casefold)


def test_agent_sets_the_group_and_applies(district):
    before = count(district)
    result = agent(district, "return agent.act({ steps: arg });", [
        {"ref": AGENCY, "action": "setValue", "args": [["TLC"]]},
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
    assert params["agency"] == ["TLC"]
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
    component inside a closed <details>, and a step that names one fails. Since #192
    Agency sits in the same group as Problem and Description, and every group starts open
    on a wide screen; on a phone or the full-page map groups start closed unless something
    in them is set, so an agent there opens the group first (or a later change moves the
    groups to UI SDK's Accordion, which the bridge can open by itself, "reveals")."""
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
    assert AGENCY in found and PROBLEM in found and DESCRIPTION in found and EXCLUDE in found


def test_page_cannot_read_data_without_duckdbs_parquet_extension(page, base_url, network):
    """Lesson BS-18, checked: DuckDB-WASM loads its Parquet reader from
    extensions.duckdb.org, not jsDelivr. With that host refused, the page reads no data
    and says so, instead of counting requests."""
    network.refuse.append("extensions.duckdb.org")
    page.allow_console.append("")  # the failed load is logged; the page's message is what we check
    page.goto(base_url + DISTRICT_PATH)
    page.wait_for_function("() => /could not|did not|failed|Reload/i.test(document.getElementById('status')?.textContent || '')", timeout=60_000)
    status = page.locator("#status").text_content()
    assert "match" not in status, status
    assert any("extensions.duckdb.org" in u for u in network.refused)
    print("\nStatus without the Parquet extension:", status)
