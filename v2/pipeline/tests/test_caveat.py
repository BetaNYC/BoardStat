"""#152: the Top 10 list is called "Top 10 request types", and every district, council
district, borough and address page carries the 311 caveat next to "At a glance".
district.html serves community districts, council districts and boroughs; address.html
serves addresses. Help, the Glossary and About use the same sentence."""

import re
from pathlib import Path

import pytest

SITE = Path(__file__).resolve().parents[2] / "site"
CAVEAT = "311 counts are reports, not problems. Closed doesn't mean fixed."


@pytest.mark.parametrize("page", ["district.html", "address.html"])
def test_heading_and_caveat_on_every_place_page(page):
    html = (SITE / page).read_text()
    assert '<h2 id="top-h">Top 10 request types</h2>' in html
    # The caveat sits in the At a glance panel, as a muted note that is not hidden in print.
    m = re.search(r'<h2 id="kpi-h">At a glance</h2>\s*<p class="([^"]*)"[^>]*>([^<]*)</p>', html)
    assert m, page
    classes = m.group(1).split()
    assert "muted" in classes and "no-print" not in classes
    assert m.group(2) == CAVEAT


def test_help_glossary_and_about_use_the_same_caveat():
    assert CAVEAT in (SITE / "help.html").read_text()
    assert CAVEAT in (SITE / "glossary.html").read_text()
    # about.js writes the sentence inside a single-quoted JS string.
    assert CAVEAT.replace("'", "\\'") in (SITE / "js" / "about.js").read_text()


def test_no_page_calls_the_list_top_problems():
    for path in [*SITE.glob("*.html"), *(SITE / "js").glob("*.js")]:
        text = path.read_text().lower()
        assert "top 10 problems" not in text and "top problems" not in text, path.name
