"""The filter form on the district and address pages (#142): groups that open and close,
one Apply button, full-width charts, and no form control that reloads the page by itself."""

import re
from pathlib import Path

import pytest

SITE = Path(__file__).resolve().parents[2] / "site"
PAGES = ["district.html", "address.html"]


def form_html(page: str) -> str:
    m = re.search(r'<form id="filters".*?</form>', (SITE / page).read_text(), re.DOTALL)
    assert m, page
    return m.group(0)


def test_both_pages_share_the_same_filter_form():
    assert form_html("district.html") == form_html("address.html")


@pytest.mark.parametrize("page", PAGES)
def test_filters_are_in_details_groups_with_one_submit_button(page):
    form = form_html(page)
    groups = re.findall(r'<details class="filter-group"[^>]*data-section="(\w+)"', form)
    assert groups == ["dates", "problem", "agency"]
    assert form.count("<summary>") == 3
    # Apply is the form's only submit button, so Enter in a text or date box applies.
    assert re.findall(r'<button type="submit"[^>]*>', form) == ['<button type="submit" id="apply">']
    assert 'id="pending"' in form and 'aria-live="polite"' in form


@pytest.mark.parametrize("page", PAGES)
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
    js = (SITE / "js" / "district.js").read_text()
    for control in ["f-start", "f-end", "f-agency", "f-status", "f-desc-ex", "f-type", "f-desc", "addr-clear"]:
        for line in re.findall(rf"\$\('{control}'\)\.addEventListener\(.*", js):
            assert "refresh(" not in line, line


def test_every_chart_is_drawn_at_its_box_width():
    js = (SITE / "js" / "district.js").read_text()
    for m in re.finditer(r"Plot\.plot\(\{(.*?)\n\s*marks", js, re.DOTALL):
        assert re.search(r"\bwidth\b", m.group(1)), m.group(1)[:120]


def test_description_shortcut_keeps_the_forms_exclude_setting():
    """QA on #142: a description shortcut must not overwrite a pending Exclude toggle."""
    js = (SITE / "js" / "district.js").read_text()
    assert "descEx: state.descEx" not in js


@pytest.mark.parametrize("page", [*PAGES, "help.html", "glossary.html"])
def test_pages_say_reset_applies_at_once(page):
    # Reset applies without the Apply button; every page that explains Apply says so.
    assert re.search(r"<strong>Reset filters</strong>[^<]*(at once|not applied)", (SITE / page).read_text())
