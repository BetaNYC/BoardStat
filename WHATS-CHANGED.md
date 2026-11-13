# What's changed

This page lists the changes to BoardStat that a reader would notice: new pages, new data, data fixes, and corrections when BoardStat showed something wrong. Newest first. BoardStat's 311 data refreshes every night, and those refreshes are not listed. The "What changed since" box on a district page lists the 311 requests that changed overnight; this page lists changes to BoardStat itself.

- **History begins:** 2017-05-18, the day BoardStat's GitHub repository opened. Entries before November 2026 cover the original BoardStat, one per release, from its README and issues. Corrections made before November 2026 may be missing.
- **Data refresh:** nightly from NYC Open Data, at 5:30 AM, with a second try at 8:30 AM if the first fails

BetaNYC uploads BoardStat 2.0 to www.beta.nyc/boardstat/ by hand, so a change reaches the site at the next upload. Entries since November 2026 are dated by the day the change was merged on GitHub. BetaNYC's [nyc-311-mcp](https://github.com/BetaNYC/nyc-311-mcp) server reads BoardStat's data files, so a change to BoardStat's data can change its answers too. To report a bug or ask for a new feature, email [boardstat@beta.nyc](mailto:boardstat@beta.nyc) or [open an issue on GitHub](https://github.com/BetaNYC/BoardStat/issues).

## Unreleased: A What's changed page

- **Tags:** Site
- **What changed:** A new page lists every change to BoardStat a reader would notice, newest first, with a filter for site changes, data changes and corrections. Every page links to it at the bottom.
- **More detail:** [What's changed on GitHub](WHATS-CHANGED.md)

## 2026-11-09: The data paused for two days, and the nightly refresh now tries twice

- **Tags:** Data
- **What changed:** On November 8 and 9, 2026, NYC Open Data turned away the 5:30 AM refresh, so BoardStat kept showing data built on the morning of November 7 until a refresh run by hand on the evening of November 9. When the first try fails, the refresh now tries again at 8:30 AM.
- **Who it affects:** Anyone who used BoardStat on November 8 or 9, 2026. The About page always shows when the data was last built.
- **More detail:** [The data is out of date](https://github.com/BetaNYC/BoardStat/issues/137) · [The second try](https://github.com/BetaNYC/BoardStat/pull/139)

## 2026-11-08: BoardStat's data files have an open license

- **Tags:** Data
- **What changed:** The data files BoardStat 2.0 publishes are under the Open Database License (ODbL) 1.0, crediting NYC Open Data as the source. Each nightly build carries the license notice with the files. BoardStat's code is under the MIT License.
- **Who it affects:** Anyone who reuses BoardStat's data files.
- **More detail:** [The data license](LICENSE-DATA.md) · [Pull request](https://github.com/BetaNYC/BoardStat/pull/135)

## 2026-11-06: Large districts load faster

- **Tags:** Site
- **What changed:** A district page now downloads only the parts of the data file it shows, instead of the whole file. For Council District 11, the largest district, the data a page downloads by default fell from 30.0 MB to 13.8 MB. Moving the From date further back downloads more.
- **More detail:** [Pull request](https://github.com/BetaNYC/BoardStat/pull/132)

## 2026-11-06: BoardStat 2.0 moved to www.beta.nyc/boardstat/

- **Tags:** Site
- **What changed:** BoardStat 2.0 moved from www.beta.nyc/boardstat/v2/ to www.beta.nyc/boardstat/. Old links, including links to boardstat.beta.nyc, go to the new address.
- **More detail:** [The move](https://github.com/BetaNYC/BoardStat/pull/130) · [The old pages](https://github.com/BetaNYC/BoardStat/pull/131)

## 2026-11-06: BoardStat counts visits, and never sends an address

- **Tags:** Site
- **What changed:** BoardStat now counts visits with Google Analytics, through the same Google tag the rest of beta.nyc uses. Before anything is sent to Google, BoardStat removes any address and map coordinates from the page's link. The About page says in plain words what is measured.
- **More detail:** [What we measure about visits](v2/site/about.html#measure-h) · [Pull request](https://github.com/BetaNYC/BoardStat/pull/126)

## 2026-11-06: 311 requests back to January 1, 2020

- **Tags:** Data
- **What changed:** BoardStat 2.0 now covers 311 requests from January 1, 2020, on, instead of the last three years. Pages still open on about the last year, and you can move the From date back to 2020. Requests from 2010 to 2019 are in a separate City dataset and are not included yet.
- **More detail:** [Pull request](https://github.com/BetaNYC/BoardStat/pull/126) · [History back to 2010](https://github.com/BetaNYC/BoardStat/issues/108)

## 2026-11-05: A Help and feedback page

- **Tags:** Site
- **What changed:** A new Help and feedback page, in the top menu of every page, explains how to use BoardStat, answers common questions, and says how to send feedback by email or on GitHub.
- **More detail:** [Help and feedback](v2/site/help.html) · [Pull request](https://github.com/BetaNYC/BoardStat/pull/123)

## 2026-11-05: The data refreshes every night

- **Tags:** Data
- **What changed:** BoardStat 2.0's data now refreshes every night. Each night picks up new 311 requests and changes to older ones, such as a request that was closed. A district page shows what changed since the last refresh.
- **More detail:** [Pull request](https://github.com/BetaNYC/BoardStat/pull/120) · [How the nightly refresh works](v2/README.md)

## 2026-11-05: The old BoardStat pages send visitors to BoardStat 2.0

- **Tags:** Site
- **What changed:** The original BoardStat pages at boardstat.beta.nyc, one per borough, now send visitors to BoardStat 2.0. The old Power BI dashboards had stopped refreshing, and they cannot be linked into 2.0, so every old page goes to the 2.0 front page.
- **More detail:** [Pull request](https://github.com/BetaNYC/BoardStat/pull/122)

## 2026-11-05: BoardStat 2.0, a rebuilt BoardStat

- **Tags:** Site, Data
- **What changed:** BoardStat 2.0 is a new BoardStat that does not depend on Power BI. It shows 311 requests for any community district, council district or single address: the most common problems, how long agencies take to close requests, a map, and how a district compares with its borough and the city. It places each request in today's district lines itself and launched with three years of data, from November 1, 2023.
- **More detail:** [About BoardStat 2.0](v2/site/about.html) · [Pull request](https://github.com/BetaNYC/BoardStat/pull/119) · [The rebuild](https://github.com/BetaNYC/BoardStat/issues/106)

## 2026-01-14: A notice that the data had stopped refreshing

- **Tags:** Site, Data
- **What changed:** The City's Office of Technology and Innovation told BetaNYC that BoardStat's connection to NYC Open Data had stopped working. Its data had not refreshed since early 2025, and the pages did not say so until this notice was added to every page.
- **Who it affects:** Anyone who used the original BoardStat in 2025.
- **More detail:** [The issue](https://github.com/BetaNYC/BoardStat/issues/99) · [Pull request](https://github.com/BetaNYC/BoardStat/pull/100)

## 2019-07-23: Version 0.7, a new look and a home page

- **Tags:** Site
- **What changed:** Every page moved to the NYC Core Framework design, and a new home page described BoardStat and showed a map with links to the five borough pages at boardstat.beta.nyc.
- **More detail:** [README change log](README.md) · [Issue 89](https://github.com/BetaNYC/BoardStat/issues/89) · [Issue 90](https://github.com/BetaNYC/BoardStat/issues/90)

## 2018-08-09: Version 0.6b, easier to use, with two new pages

- **Tags:** Site
- **What changed:** The pages were reordered and gained clear-all buttons and a way to select several addresses at once. Two new pages, "Complaints Over Time" and "Compare Complaint Types", were added.
- **More detail:** [Version 0.6b changes](https://github.com/BetaNYC/BoardStat/issues/84) · [README change log](README.md)

## 2018-07-11: Tutorial videos for each page

- **Tags:** Site
- **What changed:** BetaNYC published page-by-page tutorial videos for BoardStat. They teach the original Power BI version, which no longer runs.
- **More detail:** [Tutorial videos](https://youtu.be/Q8JJfaizWik) · [History](v2/site/about.html#history-h)

## 2018-07-11: Some requests had been shown under the wrong community board

- **Tags:** Data, Correction
- **What changed:** BoardStat read each request's community board from the City's 311 data as published. That field was wrong for some requests: requests from Marble Hill showed up under Manhattan Community Board 8, reported in September 2017, and Community Board 1 received requests that belonged elsewhere, noted for Manhattan in April 2018 and for every borough in May 2018, when the issue counted tens of thousands of requests across complaint types such as Street Light Condition and Heat/Hot Water. On this date the README recorded that NYC's Open Data team had addressed these problems.
- **If you used the old numbers:** Counts for Manhattan Community Board 8, or for Community Board 1 in any borough, taken from BoardStat before July 2018 may include requests from other districts. The record does not say how many requests each board gained. The original BoardStat no longer runs, so to re-check a count from those years, use the City's 311 Service Requests 2010 to 2019 dataset on NYC Open Data and check each request's location, not only its community board field. BoardStat 2.0 does not use that field: it places each request by its location.
- **Who it affects:** Anyone who used the original BoardStat's numbers for those boards from 2017 to July 2018.
- **More detail:** [Marble Hill](https://github.com/BetaNYC/BoardStat/issues/24) · [Community Board 1](https://github.com/BetaNYC/BoardStat/issues/36) · [311 Service Requests 2010 to 2019](https://data.cityofnewyork.us/d/76ig-c548)
- **Update 2019-11-21:** The Community Board 1 issue was closed that day with the note that it had been fixed.

## 2018-05-21: Version 0.6a, the Borough Edition

- **Tags:** Site
- **What changed:** One dashboard per community board became five borough dashboards. Each had a board picker, so you could look at one board, compare several, or look at parks by their board number.
- **More detail:** [README change log](README.md) · [History](v2/site/about.html#history-h)

## 2018-04-16: Version 0.5e, one date filter for every page

- **Tags:** Site, Data
- **What changed:** The date filter stayed the same as you moved from page to page, and the data tables became sharper. Data came from NYC Open Data's 311 dataset; by May 14, 2018, the README said it streamed 10,000 rows per query through 12 special views of that dataset.
- **More detail:** [README change log](README.md) · [The data feed](https://github.com/BetaNYC/BoardStat/issues/14)

## 2017-05-18: BoardStat begins, for Manhattan's community boards

- **Tags:** Site
- **What changed:** BoardStat started as a 311 tool in Power BI, conceived with the office of then-Manhattan Borough President Gale A. Brewer and built by BetaNYC's Civic Innovation Fellows and staff. Its GitHub repository opened on this date. The first issues, in June 2017, record feedback from district offices on the first dashboards.
- **More detail:** [History](v2/site/about.html#history-h) · [First issues](https://github.com/BetaNYC/BoardStat/issues?q=is%3Aissue+created%3A2017-06-20..2017-06-23)
