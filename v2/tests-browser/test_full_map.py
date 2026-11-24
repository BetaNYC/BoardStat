"""The full-page map in BetaNYC's shared map layout (#193, #194), in a real browser, offline,
on the fixture (Queens Joint Interest Area 480; see conftest.py). The fixture has no street
map, so the map draws the district lines and the piles on a blank background."""
import re
from urllib.parse import parse_qs, urlsplit

from conftest import DISTRICT_PATH, MAP_PATH, wait_for_data
from test_filter_form import count, pick


def number(page, sel: str) -> int:
    return int(page.locator(sel).text_content().replace(",", ""))


def wait_for_redraw(page) -> None:
    page.wait_for_function("() => !document.getElementById('pending').textContent")
    wait_for_data(page)


def test_map_counts_filters_popups_panels_and_months(page, base_url):
    # The same link counts the same requests on the district page and the map.
    page.goto(base_url + DISTRICT_PATH + "&agency=DOT")
    wait_for_data(page)
    on_district = count(page)

    page.goto(base_url + MAP_PATH)
    wait_for_data(page)
    every = count(page)
    assert number(page, "#k-total") == every > on_district
    assert page.locator("#side").is_visible()  # the panel starts open on a wide screen
    assert page.get_by_role("region", name=re.compile(r"^Map of 311 requests in ")).count() == 1
    assert "311 counts are reports, not problems." in page.locator("#caveat").text_content()

    # A filter, from the panel: the map, the counts and the link follow.
    pick(page, "f-agency", "DOT", "DOT (Department of Transportation)")
    page.keyboard.press("Escape")
    page.get_by_role("button", name="Apply filters").click()
    page.wait_for_function("() => location.search.includes('agency=DOT')")
    wait_for_redraw(page)
    assert number(page, "#k-total") == count(page) == on_district
    assert 0 < number(page, "#k-addr") <= on_district
    assert "agency=DOT" in page.locator("#back-link").get_attribute("href")

    # A pile's popup, by keyboard: Enter on the map opens the pile nearest its middle.
    page.locator("#map canvas").focus()
    page.keyboard.press("Enter")
    pop = page.locator(".fm-pop")
    pop.locator("h4").wait_for(timeout=30_000)
    assert page.evaluate("document.activeElement.tagName") == "H3"
    assert re.match(r"Latest \d+", pop.locator("h4").text_content())
    assert pop.locator(".req").count() >= 1
    assert "DOT · " in pop.locator(".req").first.text_content()  # the agency is named, not only colored
    assert pop.locator(".res").count() >= 1  # what the agency wrote, read from the data file on demand
    link = pop.get_by_role("link", name="Open this address in BoardStat")
    if link.count():
        assert parse_qs(urlsplit(link.get_attribute("href")).query)["agency"] == ["DOT"]
    assert "addr=" not in page.url

    # The panel and the stats bar hide, the map takes the room, and they come back.
    width = page.evaluate("document.getElementById('map').getBoundingClientRect().width")
    page.get_by_role("button", name="Hide panel »").click()
    assert page.evaluate("document.getElementById('map').getBoundingClientRect().width") > width
    assert page.evaluate("document.activeElement.id") == "show-side"
    page.get_by_role("button", name="Hide stats").click()
    assert page.locator("#bar").is_hidden()
    assert page.evaluate("document.getElementById('map').getBoundingClientRect().bottom") == page.viewport_size["height"]
    page.get_by_role("button", name="Show stats").click()
    page.get_by_role("button", name="« Filters").click()
    assert page.locator("#side").is_visible() and page.locator("#bar").is_visible()
    assert page.evaluate("document.activeElement.id") == "hide-side"

    # A month, by keyboard: its label gives its total, and Enter applies it through the form.
    # (A middle month: the first and last are the default dates, which the link leaves out.)
    bars = page.locator("#chart .bar-hit").filter(has=page.locator("title", has_text=re.compile(r": [1-9][\d,]* requests?")))
    bar = bars.nth(bars.count() // 2)
    label = bar.get_attribute("aria-label")
    month = bar.get_attribute("data-m")
    total = int(re.search(r": ([\d,]+) request", label).group(1).replace(",", ""))
    bar.focus()
    page.keyboard.press("Enter")
    page.wait_for_function(f"() => location.search.includes('start={month}-01')")
    wait_for_data(page)
    q = parse_qs(urlsplit(page.url).query)
    assert q["agency"] == ["DOT"] and q["start"] == [f"{month}-01"] and q["end"][0].startswith(month)
    assert count(page) == number(page, "#k-total") == total
    assert page.locator("#f-start").input_value() == f"{month}-01"
    assert page.evaluate("document.activeElement.dataset.m") == month

    # 3D tilts the map.
    page.locator("#tilt").click()
    page.wait_for_function("() => document.getElementById('tilt').getAttribute('aria-pressed') === 'true'", timeout=10_000)
    assert page.errors == []


def test_phone_opens_the_panel_as_a_sheet(context, base_url):
    page = context.new_page()
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(base_url + MAP_PATH)
    wait_for_data(page)
    assert page.locator("#side").is_hidden()
    page.get_by_role("button", name="« Filters").click()
    assert page.locator("#side").is_visible()
    assert page.evaluate("document.getElementById('side').getBoundingClientRect().width") == 390
    page.get_by_role("button", name="Reset filters").click()  # applies, and closes the sheet
    page.wait_for_function("() => document.body.classList.contains('noside')")
    assert page.evaluate("document.activeElement.id") == "show-side"
