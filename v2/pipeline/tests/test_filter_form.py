"""The filter form on the district, address and full-page map pages (#142, #149): groups
that open and close, one Apply button, full-width charts, and no form control that reloads
the page by itself. The form runs in one shared module, site/js/filterform.js."""

import json
import re
from pathlib import Path

import pytest

SITE = Path(__file__).resolve().parents[2] / "site"
PAGES = ["district.html", "address.html"]
FORM_PAGES = [*PAGES, "map.html"]
JS = SITE / "js"


def form_html(page: str) -> str:
    m = re.search(r'<form id="filters".*?</form>', (SITE / page).read_text(), re.DOTALL)
    assert m, page
    return m.group(0)


def test_every_page_with_filters_has_the_same_form():
    """#149: the full-page map has the district page's form, not a variant of it."""
    assert form_html("district.html") == form_html("address.html") == form_html("map.html")


@pytest.mark.parametrize("page", ["district.js", "fullmap.js"])
def test_pages_run_the_form_through_the_shared_module(page):
    """#149: one copy of the form's behavior. A page builds it with createFilterForm and
    never wires the form's controls itself."""
    js = (JS / page).read_text()
    assert "createFilterForm(" in js
    for control in ["f-start", "f-end", "f-agency", "f-status", "f-desc-ex", "f-type", "f-desc", "addr-clear", "reset", "filters"]:
        assert f"$('{control}').addEventListener" not in js, control


@pytest.mark.parametrize("page", FORM_PAGES)
def test_filters_are_in_details_groups_with_one_submit_button(page):
    form = form_html(page)
    groups = re.findall(r'<details class="filter-group"[^>]*data-section="(\w+)"', form)
    assert groups == ["dates", "problem", "agency"]
    assert form.count("<summary>") == 3
    # Apply is the form's only submit button, so Enter in a text or date box applies.
    assert re.findall(r'<button type="submit"[^>]*>', form) == ['<button type="submit" id="apply">']
    assert 'id="pending"' in form and 'aria-live="polite"' in form


@pytest.mark.parametrize("page", FORM_PAGES)
def test_problem_and_description_sit_in_one_aligned_pair(page):
    form = form_html(page)
    m = re.search(r'data-section="problem".*?<div class="fg-body fg-pair">(.*?)</details>', form, re.DOTALL)
    assert m and 'id="f-type"' in m.group(1) and 'id="f-desc"' in m.group(1)


@pytest.mark.parametrize("page", PAGES)
def test_monthly_chart_is_not_in_a_two_column_grid(page):
    html = (SITE / page).read_text()
    assert 'class="grid' not in html


def test_compare_is_its_own_panel():
    html = (SITE / "district.html").read_text()
    assert re.search(r'<section class="panel no-print" aria-labelledby="cmp-h">', html)


def test_form_controls_do_not_refresh_on_change():
    """The #142 bug: dates, agency, status and Exclude reloaded the page; problem chips did not.
    Rewritten for #187: Problem, Description and Exclude are UI SDK parts, so their change
    events (valuechange, checkedchange) are checked instead of the old change and keydown
    listeners. Every one only updates the draft."""
    js = (JS / "filterform.js").read_text()
    bind = js[js.index("    bind(min, max) {"):]
    for control in ["f-start", "f-end", "f-agency", "f-status", "addr-clear"]:
        lines = re.findall(rf"\$\('{control}'\)\.addEventListener\(.*", bind)
        assert lines, control
        for line in lines:
            assert "onApply(" not in line and "apply()" not in line, line
    for event in ["valuechange", "checkedchange"]:
        m = re.search(rf"addEventListener\('{event}', \(e\) => \{{(.*?)\n\s*\}}\);|addEventListener\('{event}', \(e\) => \{{(.*?)\}}\);", bind, re.S)
        assert m, event
        body = m.group(1) or m.group(2)
        assert "changed()" in body and "onApply(" not in body and "apply()" not in body, body
    # The pickers follow UI SDK's events, not the old text box's change and keydown-to-add.
    assert "addType(" not in js and "addDesc(" not in js


def test_every_chart_is_drawn_at_its_box_width():
    js = (SITE / "js" / "district.js").read_text()
    for m in re.finditer(r"Plot\.plot\(\{(.*?)\n\s*marks", js, re.DOTALL):
        assert re.search(r"\bwidth\b", m.group(1)), m.group(1)[:120]


def test_description_shortcut_keeps_the_forms_exclude_setting():
    """QA on #142: a description shortcut must not overwrite a pending Exclude toggle."""
    js = (SITE / "js" / "district.js").read_text()
    assert "descEx: state.descEx" not in js


@pytest.mark.parametrize("page", [*FORM_PAGES, "help.html", "glossary.html"])
def test_pages_say_reset_applies_at_once(page):
    # Reset applies without the Apply button; every page that explains Apply says so.
    assert re.search(r"<strong>Reset filters</strong>[^<]*(at once|not applied)", (SITE / page).read_text())


def test_apply_checks_date_order_before_skipping_and_retries_after_a_failure():
    """QA round 2 on #142: swapped dates in a link are flagged; a failed refresh can be retried.
    The order is unit-tested in tests-js/filterform.test.mjs (applyCheck); here, that Apply
    uses it with the page's own "last run failed" flag."""
    js = (JS / "filterform.js").read_text()
    check = js[js.index("export function applyCheck"):js.index("export function findChoice")]
    assert check.index("draft.start > draft.end") < check.index("changedFields(draft, applied)")
    assert "lastFailed: lastFailed()" in js[js.index("function apply()"):]
    for page in ("district.js", "fullmap.js"):
        assert "lastFailed: () =>" in (JS / page).read_text(), page


def test_reset_clears_typed_text():
    """#187: a picker's typed text is its `query`; its `value` is the chosen list."""
    js = (JS / "filterform.js").read_text()
    m = re.search(r"function reset\(\) \{.*?\n  \}", js, re.DOTALL)
    assert m and "$('f-type').query = ''" in m.group(0) and "$('f-desc').query = ''" in m.group(0)


def test_form_says_how_the_suggestions_are_ordered():
    """#149 QA round 2: the lists put the most requests in the applied dates first, and say so."""
    form = form_html("district.html")
    assert '<label for="f-agency">Agency (most requests in these dates first)</label>' in form
    for box in ("type", "desc"):
        assert f'<p class="field-hint" id="{box}-order">Suggestions are listed with the most requests in these dates first.</p>' in form
        assert f'aria-describedby="{box}-order {box}-help"' in form


@pytest.mark.parametrize("page", FORM_PAGES)
def test_every_page_has_the_panel_toggle_outside_the_form(page):
    """#149: the filter panel opens and closes on every page. The toggle and the summary
    line are outside the form, so the form's markup stays the same on every page."""
    html = (SITE / page).read_text()
    form_at = html.index('<form id="filters"')
    toggle = re.search(r'<button type="button" class="secondary" id="filters-toggle" aria-controls="filters" aria-expanded="(true|false)">(Hide|Change) filters</button>', html)
    assert toggle and toggle.start() < form_at
    assert html.index('id="filters-summary"') < form_at
    # The markup's starting state matches the wide-screen default (filterform.js panelStartsOpen).
    assert toggle.group(1) == ("false" if page == "map.html" else "true")


def test_pages_set_up_the_panel_through_the_shared_module():
    district = (JS / "district.js").read_text()
    fullmap = (JS / "fullmap.js").read_text()
    assert "form.setupPanel({ scrollTo: $('filters-bar') });" in district
    assert "form.setupPanel({ mapPage: true, scrollTo: $('main') });" in fullmap
    for src in (district, fullmap):
        assert "form.afterRedraw();" in src
    # The open/close rules live in one place.
    assert "is-collapsed" not in district and "is-collapsed" not in fullmap


def test_panel_is_set_up_before_the_first_load():
    """#149 review: on a phone the panel was fully open, with a dead "Hide filters" button,
    until the first load finished. main() sets the panel up before it loads any rows."""
    district = (JS / "district.js").read_text()
    main = district[district.index("async function main()"):]
    assert main.index("form.setupPanel(") < main.index("await ensureLoaded();")
    assert "form.setupPanel(" not in district[district.index("function setupFilters()"):district.index("function describeFiltersForPrint()")]


def test_pages_with_nothing_to_show_have_no_filter_panel():
    """#149 review: "District not found" showed a toggle that did nothing."""
    district = (JS / "district.js").read_text()
    hide = re.search(r"function hideFilters\(\) \{.*?\n\}", district, re.DOTALL).group(0)
    assert "$('filters-bar').hidden = true;" in hide and "$('filters').hidden = true;" in hide
    main = district[district.index("async function main()"):]
    for marker in ("'Data not available'", "'Borough not found' : 'District not found'", "'No address chosen'"):
        block = main[main.index(marker):]
        assert block.index("hideFilters();") < block.index("return;"), marker


# ---------------------------------------------------------------- UI SDK parts (#187)

UI_SDK_VERSION = re.compile(r"@ui-sdk/(?:web|core)@([^/]+)/")


@pytest.mark.parametrize("page", FORM_PAGES)
def test_problem_and_description_are_ui_sdk_comboboxes(page):
    """#187: several picks shown as chips, from UI SDK's Combobox, named by its label."""
    form = form_html(page)
    for box, label in (("type", "Problem (formerly Complaint Type)"), ("desc", "Description (formerly Descriptor)")):
        m = re.search(rf'<ui-combobox id="f-{box}" multiple>(.*?)</ui-combobox>\n', form, re.S)
        assert m, box
        body = m.group(1)
        assert f"<ui-combobox-label>{label}</ui-combobox-label>" in body
        assert re.search(r"<ui-combobox-chips>\s*<ui-combobox-input><input [^>]*></ui-combobox-input>\s*</ui-combobox-chips>", body)
        assert "<ui-combobox-content hidden>" in body and "<ui-combobox-empty>" in body
    # Description's list is virtualized: its rows sit in a scroller the form fills.
    desc = re.search(r'<ui-combobox id="f-desc" multiple>(.*?)</ui-combobox>\n', form, re.S).group(1)
    assert '<div class="vlist"><ui-combobox-list></ui-combobox-list></div>' in desc
    # The old text boxes, suggestion lists and hand-made chip lists are gone.
    for old in ("<datalist", 'id="type-chips"', 'id="desc-chips"', 'list="type-options"'):
        assert old not in form, old


@pytest.mark.parametrize("page", FORM_PAGES)
def test_exclude_apply_and_reset_are_ui_sdk_parts(page):
    """#187: an agent that can set a filter but cannot press Apply has done nothing, and
    UI SDK's agent bridge sees only UI SDK parts."""
    form = form_html(page)
    assert '<label class="choice"><ui-checkbox id="f-desc-ex">' in form and "</ui-checkbox> Exclude these descriptions</label>" in form
    assert '<ui-button><button type="submit" id="apply">Apply filters</button></ui-button>' in form
    assert '<ui-button id="reset"><button type="button" class="secondary">Reset filters</button></ui-button>' in form
    # Dates, Agency, Status and Print stay native in slice 1.
    for native in ('<input type="date" id="f-start"', '<select id="f-agency"', '<select id="f-status"', '<button type="button" class="secondary" id="print">'):
        assert native in form, native


def test_ui_sdk_is_pinned_to_one_exact_version():
    """#187 condition 1: one exact version on jsDelivr, like lib.js's DuckDB, never a tag
    or a range (UI SDK's `latest` tag lags its `beta` tag)."""
    vendor = json.loads((JS / "vendor-importmap.json").read_text())
    urls = [*vendor["imports"].values()] + [u for scope in vendor["scopes"].values() for u in scope.values()]
    versions = {UI_SDK_VERSION.search(u).group(1) for u in urls}
    assert len(versions) == 1, versions
    (version,) = versions
    assert re.fullmatch(r"\d+\.\d+\.\d+(-[a-z]+\.\d+)?", version), version
    assert all(u.startswith("https://cdn.jsdelivr.net/npm/@ui-sdk/") for u in urls)
    for page in FORM_PAGES:
        html = (SITE / page).read_text()
        css = re.findall(r'href="(https://cdn.jsdelivr.net/npm/@ui-sdk/[^"]+)"', html)
        assert css == [f"https://cdn.jsdelivr.net/npm/@ui-sdk/core@{version}/dist/web.css"], page


@pytest.mark.parametrize("page", FORM_PAGES)
def test_form_pages_load_ui_sdk_through_the_import_map(page):
    """stamp_assets.py merges js/vendor-importmap.json into the page's one import map;
    js/uisdk.js registers the parts; ui-theme.css comes after style.css, so its mapping wins."""
    html = (SITE / page).read_text()
    m = re.search(r'<script type="importmap">(.*?)</script>', html)
    importmap = json.loads(m.group(1))
    vendor = json.loads((JS / "vendor-importmap.json").read_text())
    for spec, url in vendor["imports"].items():
        assert importmap["imports"].get(spec) == url, (page, spec)
    assert importmap["scopes"] == vendor["scopes"]
    assert html.count('<script type="importmap">') == 1
    assert re.search(r'<script type="module" src="js/uisdk.js(\?v=\w+)?"></script>', html)
    order = [html.index("@ui-sdk/core@"), html.index('href="css/style.css'), html.index('href="css/ui-theme.css')]
    assert order == sorted(order)
    assert html.index("</script>", m.start()) < html.index('src="js/uisdk.js')


def test_pages_wait_for_the_ui_sdk_parts_before_the_form():
    """The form sets the parts' properties (value, items, checked), so it must not run
    before they are defined, or the property would hide the element's own."""
    for page in ("district.js", "fullmap.js"):
        js = (JS / page).read_text()
        assert js.index("await formPartsReady()") < js.index("createFilterForm({"), page
