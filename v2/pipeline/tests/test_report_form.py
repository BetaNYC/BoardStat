"""The Help page's "Report a data problem" form (js/report.js; betanyc-ai-workspace epic #1594).

Checks the markup the script and screen readers depend on: labels tied to their boxes, the
live status line, the honeypot hidden from people and assistive tech, the block hidden until
JavaScript runs (so no dead button), the email button kept, no contact fields, and copy that
makes no promise the form cannot keep.
"""

import re
from html.parser import HTMLParser
from pathlib import Path

SITE = Path(__file__).resolve().parents[2] / "site"
HELP = SITE / "help.html"


class Tags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags: list[tuple[str, dict]] = []

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))

    def by_id(self, id_):
        found = [(t, a) for t, a in self.tags if a.get("id") == id_]
        assert len(found) == 1, f"expected one #{id_}, found {len(found)}"
        return found[0]


def page() -> tuple[str, Tags]:
    html = HELP.read_text(encoding="utf-8")
    p = Tags()
    p.feed(html)
    return html, p


def report_block(html: str) -> str:
    m = re.search(r'<div class="report" id="report" hidden>(.*?)</form>\s*</div>', html, re.S)
    assert m, "the report block, hidden until the script runs"
    return m.group(1)


def test_form_sits_in_give_feedback_and_keeps_the_email_and_github_buttons():
    html, _ = page()
    feedback = re.search(r'<section class="panel" aria-labelledby="feedback-h" id="feedback">(.*?)</section>', html, re.S)
    assert feedback
    body = feedback.group(1)
    assert 'id="report-form"' in body
    assert 'href="mailto:boardstat@beta.nyc' in body
    assert 'href="https://github.com/BetaNYC/BoardStat/issues"' in body
    # The email button is outside the hidden block, so it works without JavaScript.
    assert "mailto:" not in report_block(html)


def test_labels_hints_and_limits():
    _, p = page()
    labels = {a.get("for") for t, a in p.tags if t == "label"}
    tag, desc = p.by_id("report-desc")
    assert tag == "textarea" and "required" in desc and desc["maxlength"] == "2000"
    assert desc["name"] == "description" and "report-desc" in labels
    tag, rec = p.by_id("report-record")
    assert tag == "input" and rec["type"] == "text" and rec["maxlength"] == "300" and "required" not in rec
    assert rec["name"] == "record" and "report-record" in labels
    for field in (desc, rec):
        hint = field["aria-describedby"]
        p.by_id(hint)
    # Error lines exist for aria-describedby to point at.
    p.by_id("report-desc-error")
    p.by_id("report-record-error")


def test_labels_read_as_asked():
    html, _ = page()
    assert '<label for="report-desc">What looks wrong?</label>' in html
    assert '<label for="report-record">Which number, request or place?</label>' in html


def test_honeypot_is_hidden_from_sight_assistive_tech_and_the_tab_order():
    html, p = page()
    tag, hp = p.by_id("report-website")
    assert tag == "input" and hp["name"] == "website"
    assert hp["tabindex"] == "-1" and hp["autocomplete"] == "off"
    assert re.search(r'<div class="report-hp" aria-hidden="true">\s*<label for="report-website">', html)
    css = (SITE / "css" / "style.css").read_text()
    assert re.search(r"\.report-hp \{[^}]*left: -10000px", css)


def test_live_status_and_button():
    _, p = page()
    tag, status = p.by_id("report-status")
    assert status.get("aria-live") == "polite" and status.get("role") == "status"
    tag, button = p.by_id("report-send")
    assert tag == "button" and button["type"] == "submit"


def test_no_contact_fields():
    block = report_block(page()[0])
    names = re.findall(r'name="([^"]+)"', block)
    assert sorted(names) == ["description", "record", "website"]
    assert 'type="email"' not in block


def test_script_is_loaded_as_a_stamped_module():
    html, _ = page()
    assert re.search(r'<script type="module" src="js/report\.js(\?v=\w+)?"></script>', html)
    assert '"./js/report.js"' in html, "run python3 v2/stamp_assets.py"


def test_copy_promises_nothing_the_form_cannot_keep():
    block = report_block(page()[0])
    text = re.sub(r"<[^>]+>", " ", block)
    assert "A BetaNYC staff member reads every report." in text
    assert "does not ask for your name or email, so we cannot write back to you" in text
    assert "personal details" in text
    assert "!" not in text
    assert not re.search(r"anonym", text, re.I)


def test_no_page_still_says_nothing_typed_is_ever_sent():
    """The form sends what people type, so the old absolute promises were corrected."""
    help_html = HELP.read_text()
    assert "<dd><p>No. BoardStat runs in your browser" not in help_html
    assert "nothing you type is sent anywhere." not in (SITE / "index.html").read_text()
    assert "Nothing you type is sent to us, and" not in (SITE / "about.html").read_text()


# ---------------------------------------------------------------- the data pages' link

JS = SITE / "js"
REPORT_LINK = (
    '<p class="muted report-link no-print">Does a number look wrong? '
    '<a id="report-link" href="help.html#report-h">Report a data problem</a></p>'
)


def test_data_pages_have_the_link_with_a_fallback_href():
    """Without JavaScript the plain link still opens the form's heading (the form then uses the referrer)."""
    for name in ("district.html", "address.html", "map.html"):
        html = (SITE / name).read_text(encoding="utf-8")
        assert html.count('id="report-link"') == 1, name
        assert REPORT_LINK in html, name
    # Under the "At a glance" caveat on the district and address pages.
    for name in ("district.html", "address.html"):
        html = (SITE / name).read_text(encoding="utf-8")
        assert re.search(r'id="kpi-caveat">[^<]*</p>\s*' + re.escape(REPORT_LINK), html), name
    # Under the data date on the full-page map.
    assert re.search(r'<p class="muted" id="as-of"></p>\s*' + re.escape(REPORT_LINK), (SITE / "map.html").read_text(encoding="utf-8"))
    # The heading the link points at.
    assert '<h3 id="report-h">Report a data problem</h3>' in HELP.read_text(encoding="utf-8")
    css = (SITE / "css" / "style.css").read_text(encoding="utf-8")
    assert re.search(r"\.report-link a \{[^}]*min-height: 44px", css)


def test_footer_feedback_links_are_unchanged():
    for name in ("district.html", "address.html", "map.html"):
        assert '<a href="help.html#feedback">Send us feedback</a>' in (SITE / name).read_text(encoding="utf-8"), name


def test_the_link_is_kept_current_from_the_same_parameters_as_the_other_links():
    """One filtersToParams result feeds the page's own links and the report link, on every
    refresh, the address page included (where writeUrl otherwise writes nothing)."""
    district = (JS / "district.js").read_text(encoding="utf-8")
    write_url = re.search(r"function writeUrl\(\) \{.*?\n\}", district, re.DOTALL).group(0)
    p_at = write_url.index("const p = filtersToParams(geo, geoId, state, defaultDates());")
    report_at = write_url.index("updateReportLink(p);")
    assert p_at < report_at < write_url.index("if (ADDRESS_MODE) return;")
    update = re.search(r"function updateReportLink\(p\) \{.*?\n\}", district, re.DOTALL).group(0)
    assert "reportLinkHref(ADDRESS_MODE ? 'address.html' : 'district.html', p)" in update
    assert "updateReportLink(firstParams);" in district
    fullmap = (JS / "fullmap.js").read_text(encoding="utf-8")
    links = re.search(r"function writeLinks\(\) \{.*?\n\}", fullmap, re.DOTALL).group(0)
    assert "$('report-link').href = reportLinkHref('map.html', p);" in links
    for src in (district, fullmap):
        assert "import { reportLinkHref } from './report.js';" in src


def test_the_report_link_never_carries_an_address():
    """#report-link is built only from filtersToParams (which never writes addr) through
    reportLinkHref (which keeps only PAGE_PARAMS, and PAGE_PARAMS has no addr)."""
    report = (JS / "report.js").read_text(encoding="utf-8")
    params = re.search(r"export const PAGE_PARAMS = \[([^\]]*)\]", report).group(1)
    assert not re.search(r"\baddr\b", params)
    to_params = re.search(r"export function filtersToParams\(.*?\n\}", (JS / "filterstate.js").read_text(encoding="utf-8"), re.DOTALL).group(0)
    assert not re.search(r"\baddr\b", to_params)
    for name in ("district.js", "fullmap.js"):
        src = (JS / name).read_text(encoding="utf-8")
        for line in src.splitlines():
            if "reportLinkHref(" in line and "import" not in line:
                assert not re.search(r"\baddr\b", line), line
