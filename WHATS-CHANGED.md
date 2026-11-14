# What's changed

This page lists the changes to BoardStat that a reader would notice: new pages, new data, data fixes, and corrections when BoardStat showed something wrong. Newest first. BoardStat's 311 data refreshes every night, and those refreshes are not listed. The "What changed since" box on a district page lists the 311 requests that changed overnight; this page lists changes to BoardStat itself.

- **History begins:** 2017-05-18, the day BoardStat's GitHub repository opened. Entries before November 2026 cover the original BoardStat, one per release, from its README and issues. Corrections made before November 2026 may be missing.
- **Data refresh:** nightly from NYC Open Data, at 5:30 AM, with a second try at 8:30 AM if the first fails

BetaNYC uploads BoardStat 2.0 to www.beta.nyc/boardstat/ by hand, so a change reaches the site at the next upload. Entries since November 2026 are dated by the day the change was merged on GitHub. BetaNYC's [nyc-311-mcp](https://github.com/BetaNYC/nyc-311-mcp) server reads BoardStat's data files, so a change to BoardStat's data can change its answers too. To report a bug or ask for a new feature, email [boardstat@beta.nyc](mailto:boardstat@beta.nyc) or [open an issue on GitHub](https://github.com/BetaNYC/BoardStat/issues).

## 2026-11-13: Whole-borough pages open faster, including on phones

- **Tags:** Site, Data
- **What changed:** A whole-borough page now draws its charts and tables from a smaller file that BoardStat builds every night for each borough, so they appear sooner and use less of a phone's memory. Before its charts appear, Brooklyn's page now downloads about 24 MB instead of 90 MB, and about 48 MB in all instead of 182 MB. The map, the addresses with the most requests and the list of requests load when you ask for them. They still need much more data, and on a phone a whole borough's map can be slow or make the page reload. Each night BoardStat checks that every borough file holds the same requests as that borough's district files, and does not publish the night's data if they differ.
- **Who it affects:** Anyone who opens a whole-borough page, especially on a phone.
- **More detail:** [Borough pages on phones](https://github.com/BetaNYC/BoardStat/issues/151) · [Pull request](https://github.com/BetaNYC/BoardStat/pull/154)

## 2026-11-13: "Top 10 request types", and what 311 counts mean

- **Tags:** Site
- **What changed:** The panel listing the 10 most common kinds of 311 requests is now called "Top 10 request types", because it shows what people report most, not the biggest problems in a place. Every district, council district, borough and address page now says at the top of "At a glance": "311 counts are reports, not problems. Closed doesn't mean fixed."
- **More detail:** [The change](https://github.com/BetaNYC/BoardStat/issues/152) · [Pull request](https://github.com/BetaNYC/BoardStat/pull/153)

## 2026-11-13: Change filters on the full-page map, and fold the filter panel away

- **Tags:** Site
- **What changed:** The full-page map has the same filters as the district page, behind a "Change filters" button. Filters you set on the map stay set when you go back, for community districts, council districts and boroughs. An address filter is never carried between pages, because BoardStat never puts a street address in a link. On every page, the filter panel can be folded away with "Hide filters"; on a phone it starts folded.
- **More detail:** [The change](https://github.com/BetaNYC/BoardStat/issues/149) · [Pull request](https://github.com/BetaNYC/BoardStat/pull/150)

## 2026-11-13: A whole borough at once

- **Tags:** Site
- **What changed:** You can now open a whole borough (Manhattan, the Bronx, Brooklyn, Queens or Staten Island) with the same charts, map, request list and filters as a community district. A borough page counts every community district and Joint Interest Area in the borough. Every community district page links to its borough, keeping the dates and filters.
- **Who it affects:** Borough presidents' offices and anyone looking across a borough.
- **More detail:** [Whole-borough view](https://github.com/BetaNYC/BoardStat/issues/144) · [Pull request](https://github.com/BetaNYC/BoardStat/pull/148)

## 2026-11-13: A full-page map

- **Tags:** Site
- **What changed:** Under each district's map, "Open full-page map" opens the same map as big as your screen, with the same dates and filters. Its link can be shared. An address filter is not carried over, so the full-page map shows the whole district. The district and address maps now have a key.
- **More detail:** [Full-page map](https://github.com/BetaNYC/BoardStat/issues/143) · [Pull request](https://github.com/BetaNYC/BoardStat/pull/147)

## 2026-11-13: Filters you apply, and wider charts

- **Tags:** Site
- **What changed:** The filters are grouped into sections you can open and close. Changes in the filter form take effect when you press Apply filters, and the page tells you when filters have changed but not been applied. Reset filters and the shortcut buttons inside panels still update the page at once. Requests per month and Compare now use the full width of the page.
- **More detail:** [Filters and Apply](https://github.com/BetaNYC/BoardStat/issues/142) · [Pull request](https://github.com/BetaNYC/BoardStat/pull/146)

## 2026-11-13: The street map is open source

- **Tags:** Site
- **What changed:** Every map now uses one street map, built from OpenStreetMap data with Protomaps and hosted by BetaNYC with the rest of BoardStat. Since November 4, 2026, each map had first asked for the City's NYC basemap, which is served from Esri's ArcGIS, and used this street map only if that failed. The map credits OpenStreetMap in its corner. If the street map cannot load, the map says so and still shows the district boundaries and requests.
- **Who it affects:** Anyone who uses BoardStat's maps. Streets and labels look different from the City's basemap.
- **More detail:** [Open-source street map only](https://github.com/BetaNYC/BoardStat/issues/141) · [Pull request](https://github.com/BetaNYC/BoardStat/pull/145)

## 2026-11-12: A What's changed page

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

## 2026-01-14: The original BoardStat showed data from early 2025 without saying it was out of date

- **Tags:** Data, Correction
- **What changed:** The City's Office of Technology and Innovation told BetaNYC that BoardStat's connection to NYC Open Data had stopped working, and that its data had not refreshed since early 2025. Until this date the pages did not say so. On January 14, 2026, a notice went on the home page saying the data could no longer be refreshed. The five borough pages, where the numbers were, carried no notice until they began sending visitors to BoardStat 2.0 on November 5, 2026.
- **If you used the old numbers:** Numbers from the original BoardStat taken from early 2025 until November 5, 2026, stop in early 2025. Re-check them in BoardStat 2.0, which covers 2020 on.
- **Who it affects:** Anyone who used the original BoardStat from early 2025 on.
- **More detail:** [The issue](https://github.com/BetaNYC/BoardStat/issues/99) · [The notice](https://github.com/BetaNYC/BoardStat/pull/100) · [The redirect](https://github.com/BetaNYC/BoardStat/pull/122)

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
- **What changed:** BoardStat showed each request under the community board listed in the City's 311 data. For some requests, that board did not match where the request was. Requests from Marble Hill showed up under Manhattan Community Board 8, reported in September 2017. Community Board 1 received requests that belonged elsewhere, noted for Manhattan on May 14, 2018, and for every borough later that month, when the issue counted tens of thousands of requests across complaint types such as Street Light Condition and Heat/Hot Water. On this date the README recorded that NYC's Open Data team had addressed these problems.
- **If you used the old numbers:** Counts for Manhattan Community Board 8, or for Community Board 1 in any borough, taken from the original BoardStat from 2017 until as late as November 2019 may include requests from other districts. The record does not say how many requests each board gained. The original BoardStat no longer runs, so to re-check a count from those years, use the City's 311 Service Requests 2010 to 2019 dataset on NYC Open Data and check each request's location, not only its community board field. BoardStat 2.0 does not use that field: it places each request by its location.
- **Who it affects:** Anyone who used the original BoardStat's numbers for those boards from 2017 to November 2019.
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
