# Accessibility

Charts provide expandable **View data** tables, including zero-filled periods
and grouped Other values. Lines use different markers and dash patterns; bars
use patterns as well as color. Map tables provide keyboard-accessible request
and hotspot details without requiring users to navigate every marker.

Tabs support arrow keys. Map popups support Escape and restore focus when
closed. Wide tables and the home page's fixed-coordinate illustration scroll
within their containers; the illustration also has a list of borough links.

## Checks recorded September 10, 2026

AI-assisted Chrome and axe-core 4.13.0 checks covered the home page, prototype,
five borough overviews, all eight Manhattan views, expanded tables, and alternate
map/monthly modes at 1280px and 320px. Checks included empty results, failed
requests and retry, keyboard focus, chart/table values, and color-vision
simulations. No confirmed axe violations remained after targeted retests.

Map contrast needed manual inspection. Text contrast was checked against
explicit backgrounds, but marker overlap depends on the data and zoom level.
One 320px map scan reported a target-size warning that did not reproduce on
repeat; the map tables remain an alternative to clustered or overlapping targets.

## Still to check

VoiceOver/Safari and NVDA/Firefox or Chrome speech testing remains pending.
Verify table reading, filter announcements, both map modes, hotspot loading and
retry, and popup focus. Dense patterns and map navigation also need review with
users who have low vision or motor impairments. These checks are not WCAG
certification or a substitute for disabled-user testing.

To repeat the checks, follow [VALIDATION.md](VALIDATION.md), open **View data**
with the keyboard, compare table values with the chart or map, and test 320px
reflow with both populated and empty results.
