"""The filter form on the district, address and full-page map pages (#142, #149): groups
that open and close, one Apply button, full-width charts, and no form control that reloads
the page by itself. The form runs in one shared module, site/js/filterform.js."""

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
    """The #142 bug: dates, agency, status and Exclude reloaded the page; problem chips did not."""
    js = (JS / "filterform.js").read_text()
    for control in ["f-start", "f-end", "f-agency", "f-status", "f-desc-ex", "f-type", "f-desc", "addr-clear"]:
        lines = re.findall(rf"\$\('{control}'\)\.addEventListener\(.*", js)
        assert lines, control
        for line in lines:
            assert "onApply(" not in line and "apply()" not in line, line


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
    js = (JS / "filterform.js").read_text()
    m = re.search(r"function reset\(\) \{.*?\n  \}", js, re.DOTALL)
    assert m and "$('f-type').value = ''" in m.group(0) and "$('f-desc').value = ''" in m.group(0)


def test_form_says_how_the_suggestions_are_ordered():
    """#149 QA round 2: the lists put the most requests in the applied dates first, and say so."""
    form = form_html("district.html")
    assert '<label for="f-agency">Agency (most requests in these dates first)</label>' in form
    for box in ("type", "desc"):
        assert f'<p class="field-hint" id="{box}-order">Suggestions are listed with the most requests in these dates first.</p>' in form
        assert f'aria-describedby="{box}-order {box}-help"' in form
