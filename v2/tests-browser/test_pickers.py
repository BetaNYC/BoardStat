"""The Problem and Description pickers (UI SDK Combobox, #187) for people: keyboard,
Escape, click-away, visible focus, forced colors, a phone-width screen, and Description's
virtualized list. Offline, like every browser test (conftest.py)."""
import gzip

from conftest import DISTRICT_PATH, wait_for_data

STATE = """() => { const b = document.getElementById('f-type');
  return { focus: document.activeElement?.closest('ui-combobox')?.id ?? document.activeElement?.tagName,
           open: b.open, value: b.value, query: b.query, search: location.search,
           pending: document.getElementById('pending').textContent }; }"""


def test_keyboard_escape_and_click_away(district):
    page = district
    page.locator("#fg-problem summary").focus()
    page.keyboard.press("Tab")  # Sort suggestions (#199): one stop, on the checked choice
    assert page.evaluate("document.activeElement.name") == "list-order"
    page.keyboard.press("Tab")
    assert page.evaluate(STATE)["focus"] == "f-agency"  # #192: Agency comes first
    page.keyboard.press("Tab")
    assert page.evaluate(STATE)["focus"] == "f-type"
    page.keyboard.type("lost")
    s = page.evaluate(STATE)
    assert s["open"] and s["query"] == "lost"
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    s = page.evaluate(STATE)
    # A pick adds a chip, keeps the list open for more, and empties the text.
    assert s["value"] == ["Lost Property"] and s["open"] and s["query"] == ""
    assert s["pending"].startswith("Filters changed.") and "type=" not in s["search"]
    page.keyboard.press("Escape")
    s = page.evaluate(STATE)
    assert not s["open"] and s["focus"] == "f-type" and s["value"] == ["Lost Property"]
    # Enter in the empty, closed box applies, like Enter in a date box.
    page.keyboard.press("Enter")
    page.wait_for_function("() => location.search.includes('type=Lost')")
    wait_for_data(page)
    # Backspace in the empty box removes the last chip (in the form only).
    page.keyboard.press("Backspace")
    s = page.evaluate(STATE)
    assert s["value"] == [] and s["pending"].startswith("Filters changed.")
    # Click-away closes the list. Text that was never chosen stays in the box, so Apply
    # can add it or say it names nothing (#142's rule; see the next test).
    page.keyboard.type("taxi")
    assert page.evaluate(STATE)["open"]
    page.locator("h1").click()
    s = page.evaluate(STATE)
    assert not s["open"] and s["query"] == "taxi" and s["value"] == []
    assert page.errors == []


def test_typed_whole_name_is_added_by_enter_or_apply(district):
    page = district
    page.locator("#f-type input").fill("lost property")
    page.keyboard.press("Enter")
    assert page.evaluate(STATE)["value"] == ["Lost Property"]
    page.locator("#f-type input").fill("taxi report")
    page.get_by_role("button", name="Apply filters").click()
    page.wait_for_function("() => location.search.includes('type=')")
    assert "type=Lost+Property%7CTaxi+Report" in page.url


def test_typed_text_that_names_nothing_stops_apply(district):
    page = district
    page.locator("#f-type input").fill("no such problem")
    page.get_by_role("button", name="Apply filters").click()
    assert page.locator("#status").text_content().startswith("No problem named “no such problem”.")
    assert "type=" not in page.url


def test_focus_is_visible(district):
    page = district
    page.locator("#fg-problem summary").focus()
    page.keyboard.press("Tab")  # Sort suggestions (#199): one stop, on the checked choice
    assert page.evaluate("document.activeElement.name") == "list-order"
    page.keyboard.press("Tab")
    chips = page.locator("#f-agency ui-combobox-chips")
    assert chips.evaluate("e => getComputedStyle(e).outlineStyle") == "solid"
    page.keyboard.press("Tab")
    chips = page.locator("#f-type ui-combobox-chips")
    assert chips.evaluate("e => getComputedStyle(e).outlineStyle") == "solid"
    assert chips.evaluate("e => parseFloat(getComputedStyle(e).outlineWidth)") >= 2
    # Tab on to Description, then Exclude.
    page.keyboard.press("Tab")
    assert page.evaluate("document.activeElement.closest('ui-combobox')?.id") == "f-desc"
    page.keyboard.press("Tab")
    box = page.locator("#f-desc-ex")
    assert page.evaluate("document.activeElement.id") == "f-desc-ex"
    assert box.evaluate("e => getComputedStyle(e).outlineStyle") == "solid"
    page.keyboard.press("Space")
    assert box.evaluate("e => e.checked") is True
    page.locator("#apply").focus()
    page.keyboard.press("Tab")
    page.keyboard.press("Shift+Tab")
    assert page.locator("#apply").evaluate("e => getComputedStyle(e).outlineStyle") == "solid"


def test_forced_colors(page, base_url):
    """Windows High Contrast: the highlighted choice and a ticked Exclude box use system
    colors, so they still show when the system replaces the page's colors."""
    page.emulate_media(forced_colors="active", reduced_motion="reduce")
    page.goto(base_url + DISTRICT_PATH + "&type=Taxi%20Complaint&desc=Bag%2FWallet&descx=1")
    wait_for_data(page)
    assert page.evaluate("matchMedia('(forced-colors: active)').matches")
    page.locator("#f-type input").click()
    page.keyboard.type("lost")
    page.keyboard.press("ArrowDown")
    item = page.locator("#f-type ui-combobox-item[data-highlighted]")
    assert item.text_content().strip() == "Lost Property"
    assert item.evaluate("e => getComputedStyle(e).outlineStyle") == "solid"
    assert item.evaluate("e => getComputedStyle(e).forcedColorAdjust") == "none"
    # The chosen problem keeps its check mark (web.css draws it as a masked background).
    page.keyboard.press("Enter")  # choose it; the list stays open with every item
    mark = page.locator("#f-type ui-combobox-item[data-selected] ui-combobox-item-indicator").first
    assert mark.evaluate("e => getComputedStyle(e, '::before').forcedColorAdjust") == "none"
    checked = page.locator("#f-desc-ex")
    assert checked.get_attribute("data-checked") == ""
    assert checked.evaluate("e => getComputedStyle(e).forcedColorAdjust") == "none"
    assert checked.evaluate("e => getComputedStyle(e).backgroundColor") != "rgb(255, 255, 255)"


def test_phone_width(page, base_url):
    page.set_viewport_size({"width": 390, "height": 844})
    page.emulate_media(reduced_motion="reduce")
    page.goto(base_url + DISTRICT_PATH)
    wait_for_data(page)
    # On a phone the panel starts closed (filterform.js panelStartsOpen) ...
    toggle = page.locator("#filters-toggle")
    assert toggle.text_content() == "Change filters"
    toggle.click()
    page.locator("#fg-problem summary").click()
    page.locator("#f-desc input").click()
    page.keyboard.type("driver")
    content = page.locator("#f-desc ui-combobox-content")
    box = content.bounding_box()
    assert box["x"] >= 0 and box["x"] + box["width"] <= 390
    page.locator("#f-desc ui-combobox-item", has_text="Driver Complaint - Passenger").first.click()
    assert page.evaluate("document.getElementById('f-desc').value") == ["Driver Complaint - Passenger"]
    # Chip remove buttons are big enough to tap (32 px, WCAG 2.2 target size minimum is 24).
    remove = page.locator("#f-desc ui-combobox-chip-remove button").bounding_box()
    assert remove["width"] >= 24 and remove["height"] >= 24
    page.locator("h1").click()
    page.get_by_role("button", name="Apply filters").click()
    # ... and closes again after Apply, with focus on its toggle.
    page.wait_for_function("() => document.getElementById('filters-toggle').textContent === 'Change filters'")
    assert "desc=Driver" in page.url
    assert page.evaluate("document.activeElement.id") == "filters-toggle"


def test_description_list_is_virtualized(district):
    page = district
    page.emulate_media(reduced_motion="reduce")
    page.locator("#f-desc input").click()
    for _ in range(41):
        page.keyboard.press("ArrowDown")
    info = page.evaluate("""() => {
      const box = document.getElementById('f-desc'); const sc = box.querySelector('.vlist');
      const items = [...box.querySelectorAll('ui-combobox-item')];
      const h = items.find((i) => i.hasAttribute('data-highlighted'));
      const hr = h.getBoundingClientRect(), sr = sc.getBoundingClientRect();
      return { total: box.items.length, rendered: items.length, posinset: h.getAttribute('aria-posinset'),
               setsize: h.getAttribute('aria-setsize'), inView: hr.top >= sr.top - 1 && hr.bottom <= sr.bottom + 1 }; }""")
    assert info["total"] > 40
    assert info["rendered"] < info["total"]          # only the nearby rows exist
    assert info["posinset"] == "41" and info["setsize"] == str(info["total"])
    assert info["inView"]                             # the highlighted row was scrolled to
    page.keyboard.press("Enter")
    assert len(page.evaluate("document.getElementById('f-desc').value")) == 1


def test_ui_sdk_download_size(district, network):
    """What UI SDK adds to a page, measured from the files the page fetched (the agent
    bridge is not loaded by the page). Printed with -s; the budget catches a version
    bump that grows it a lot. Sizes are gzip, level 9, per file; jsDelivr serves Brotli,
    which is a little smaller."""
    ui = [(u, b) for u, b in network.vendor if "/@ui-sdk/" in u]
    other = [(u, b) for u, b in network.vendor if "/@ui-sdk/" not in u]
    from conftest import vendor_file
    gz = lambda items: sum(len(gzip.compress(vendor_file(u).read_bytes(), 9)) for u, _ in items)
    raw_ui = sum(b for _, b in ui)
    report = (f"UI SDK: {len(ui)} files, {raw_ui:,} bytes, {gz(ui):,} gzip. "
              f"Everything else from the CDNs: {len(other)} files, {sum(b for _, b in other):,} bytes, {gz(other):,} gzip.")
    print("\n" + report)
    assert not any(u.endswith("/agent.js") for u, _ in ui)
    assert gz(ui) < 250_000, report


def test_typing_after_a_long_scroll_keeps_the_list_virtualized(district):
    page = district
    page.locator("#f-desc input").click()
    for _ in range(60):
        page.keyboard.press("ArrowDown")
    page.keyboard.type("driver")
    info = page.evaluate("""() => { const items = [...document.querySelectorAll('#f-desc ui-combobox-item')];
      return { rendered: items.length, unindexed: items.filter((i) => !i.hasAttribute('index')).length }; }""")
    assert info["rendered"] > 0 and info["unindexed"] == 0, info


def test_description_list_keeps_matching_the_text_after_click_away(district):
    """QA round 1: the typed text stays after click-away (#142's rule), and the virtual
    list must still show only its matches when the box is opened again."""
    page = district
    page.locator("#f-desc input").click()
    page.keyboard.type("driver")
    page.locator("h1").click()
    assert page.evaluate("document.getElementById('f-desc').query") == "driver"
    page.locator("#f-desc input").click()
    page.keyboard.press("ArrowDown")
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(100)
    rows = page.evaluate("""() => [...document.querySelectorAll('#f-desc ui-combobox-item')].map((i) => ({
      text: i.textContent, hl: i.hasAttribute('data-highlighted'), index: i.getAttribute('index') }))""")
    assert rows and all("driver" in r["text"].lower() for r in rows), rows
    highlighted = [r for r in rows if r["hl"]]
    assert len(highlighted) == 1 and highlighted[0]["index"] == "1", rows


def test_parts_that_fail_to_load_leave_a_warning_that_stays(page, base_url, network):
    """QA round 1: if UI SDK does not load (here: js/uisdk.js refused), the form says so in
    its own warning line, and the count that follows does not replace it."""
    network.refuse.append("/js/uisdk.js")
    page.allow_console.append("uisdk.js")  # the refused file is a console error, on purpose
    page.goto(base_url + DISTRICT_PATH)
    wait_for_data(page, timeout=60_000)  # formPartsReady waits 20 s first
    warning = page.locator("#parts-failed")
    assert warning.is_visible()
    assert warning.text_content().startswith("The Agency, Problem and Description boxes did not load")
    assert page.get_by_role("alert").filter(has_text="did not load").count() == 1
    assert "match" in page.locator("#status").text_content()  # the rest of the page still drew
    page.locator("#filters-toggle").click()  # closed panel: the warning still shows
    assert page.locator("#filters").evaluate("f => f.classList.contains('is-collapsed')")
    assert warning.is_visible()
    assert network.refused
