# Validation

jflashman recorded a manual walkthrough in [PR #105 on August 26, 2026](https://github.com/BetaNYC/BoardStat/pull/105#issuecomment-5430440691).
Independent review, Firefox/Safari checks, and screen-reader speech testing
remain pending. The checks below were AI-assisted and do not constitute human
approval for production.

## Run locally

```bash
node --test tests/*.test.mjs
for file in js/*.js; do node --check "$file"; done
node tests/live-api-validation.mjs
python3 -m http.server 8000
```

The live script compares dashboard totals with independently constructed Socrata
queries for one standard board per borough across current, historical, and
2019/2020 boundary ranges. It prints timestamped results and query URLs.
It is excluded from CI because it depends on NYC Open Data.

## Recorded results

On August 26, 2026 at 16:58:07Z, all 15 live totals matched direct queries:

| Borough / board | Aug 1–7, 2025 | Aug 1–7, 2019 | Dec 30, 2019–Jan 2, 2020 |
| --- | ---: | ---: | ---: |
| Bronx / 01 BRONX | 875 | 363 | 212 |
| Brooklyn / 01 BROOKLYN | 1,707 | 1,388 | 511 |
| Manhattan / 07 MANHATTAN | 1,230 | 732 | 408 |
| Queens / 01 QUEENS | 1,753 | 1,094 | 535 |
| Staten Island / 01 STATEN ISLAND | 1,223 | 1,260 | 545 |

UI dates are inclusive; queries use an exclusive next-day upper bound. These
checks cover representative selections, not every board or source-data anomaly.

Chrome desktop and 390px mobile checks on August 26 covered all eight views,
address lookup, both map modes, URL navigation, reset, optional analyses, and
keyboard tabs. No normal-use console errors or page overflow were observed.
Screenshots: [desktop](docs/screenshots/manhattan-desktop.png),
[mobile](docs/screenshots/manhattan-mobile.png).

September 10 follow-up checks covered date clearing, cancellation and stale
results, cache expiry, zero-filled timelines, all board totals, address spacing,
and keyboard focus. The 42-test suite and JavaScript syntax checks passed;
[fork CI](https://github.com/jflashman/BoardStat/actions/runs/34488239779) also passed.
Chart and map labels containing HTML remained inert in Chrome. Repeated hotspot
activations shared one detail request. See [ACCESSIBILITY.md](ACCESSIBILITY.md)
for browser accessibility coverage and remaining checks. DOM test doubles do
not reproduce browser parsing, layout, event propagation, or screen readers.

## Known limits and review work

- Cold Bronx and Brooklyn defaults took 16.7s and 18.9s in recorded checks,
  exceeding the 15-second target but within the 45-second request timeout.
  Anonymous API latency varies; failures must offer retry.
- Cross-dataset address and hotspot rankings are bounded candidate rankings.
  Map points are newest-first samples, not a representative distribution.
  Source borough/board labels are used without independent geocoding.
- Before release, check all views in Firefox and Safari at desktop and mobile
  widths, including empty results, retry, reset, and Back/Forward. Complete the
  screen-reader checks in [ACCESSIBILITY.md](ACCESSIBILITY.md).
- Review borough constraints, date splitting, query bounds, cancellation, and
  cache behavior. Re-run local and live checks, investigating changed totals.
- Confirm the hosting work in [DEPLOYMENT.md](DEPLOYMENT.md) and record the human
  reviewer's name, date, findings, and resolution of release-blocking issues.
- The README licenses documents under CC BY-SA 4.0 but does not clearly license
  application code. That decision remains with BetaNYC maintainers; dependency
  licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

AI assistance and source use are disclosed in [README.md](README.md#ai-assistance-and-human-verification).
