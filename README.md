# BoardStat
## BoardStat 2.0 (prototype) is live: https://www.beta.nyc/boardstat/

The original Power BI BoardStat stopped refreshing in early 2025. **BoardStat 2.0** replaces it: an open-source, browser-based tool for 311 data by community district, council district, or a single address. It covers requests from January 1, 2020, on, and refreshes every night. Requests from 2010 to 2019 are in a separate city dataset, and adding them is planned ([#108](https://github.com/BetaNYC/BoardStat/issues/108)). Its code and documentation are in [`v2/`](v2/README.md). The old addresses at boardstat.beta.nyc, and the earlier `beta.nyc/boardstat/v2/` address, now send visitors to https://www.beta.nyc/boardstat/.

Questions or feedback on BoardStat 2.0: email [boardstat@beta.nyc](mailto:boardstat@beta.nyc?subject=BoardStat%202.0%20feedback) or see [how to give feedback](https://www.beta.nyc/boardstat/help.html#feedback-h).

## The original BoardStat (v0.x), kept for history

The rest of this page describes the original BoardStat as it was. Its training materials and contacts are from that time.

BoardStat is an interactive tool for New York City’s community boards. It empowers users to discover issues and trends within district boundaries. The six pages of the tool provided a variety of summaries, graphs, and maps of 311 data (from 2010 through the present day). Not only did BoardStat empower community board staff and members to gain timely insights into their residents’ concerns, but it also furthered then-Manhattan Borough President Gale A. Brewer's goal of moving beyond open data access to meaningful open data use.

This GitHub repo documents issues and holds the code.

The original page-by-page [tutorial videos on BetaNYC's YouTube](https://youtu.be/Q8JJfaizWik) (2018) teach the Power BI version, which no longer runs.

These original borough addresses now redirect to BoardStat 2.0.

| Borough  | URL |
| ------------- | ------------- |
| Bronx | https://boardstat.beta.nyc/bronx |
| Brooklyn | https://boardstat.beta.nyc/brooklyn |
| Manhattan | https://boardstat.beta.nyc/manhattan |
| Queens | https://boardstat.beta.nyc/queens |
| Staten Island | https://boardstat.beta.nyc/statenisland |

## File an Issue
We track all issues, for both versions, in this [repo's issue queue](https://github.com/BetaNYC/BoardStat/issues).

### Development Process and Methodology:
BoardStat was conceived with the Manhattan Borough President Gale A. Brewer as a simple 311 analysis tool. Through research conducted by Civic Innovation Fellows, key features were baked into a prototype. During the Spring semester of 2016 - 2017, fellows and BetaNYC staff, with assistance from Microsoft Civic Chicago and NYC, developed a prototype using Power BI. Through group and one-on-one meetings, MBPO staff, Community District staff, and Community Board members helped refine key features. 

### Funders:
BoardStat was created with funds and support from the Alfred P. Sloan Foundation, Fund for the City of New York, and Microsoft Civic.

## Training Documents (original version)
BetaNYC ran 90-minute public training sessions on the original BoardStat, and the Manhattan Borough President's office offered one-on-one trainings for Manhattan community boards. These materials teach the Power BI version:
 * [BoardStat Training - Data Journey Worksheet](https://docs.google.com/document/d/1DHgVLrm-X1gs1rwovhpWA5En_ozcQnTWHYobmG9_B0A/edit), the worksheet BetaNYC used to teach BoardStat, with [companion slides](http://bit.ly/betanyc_datajourney_manhattan).
 * [Tutorial videos on BetaNYC's YouTube](https://youtu.be/Q8JJfaizWik) (2018).

For help with BoardStat 2.0, use [boardstat@beta.nyc](mailto:boardstat@beta.nyc) and the [help page](https://www.beta.nyc/boardstat/help.html).

## Data
The original BoardStat read the city's 311 Service Requests dataset ([`erm2-nwe9`](https://data.cityofnewyork.us/d/erm2-nwe9), then titled "from 2010 to Present") through special views on NYC Open Data, filtered by the Community Board column. The city has since split 311 data in two: [311 Service Requests from 2020 to Present](https://data.cityofnewyork.us/d/erm2-nwe9) (`erm2-nwe9`, which BoardStat 2.0 uses) and [311 Service Requests 2010–2019](https://data.cityofnewyork.us/d/76ig-c548) (`76ig-c548`). See the [data sources in `v2/README.md`](v2/README.md).

# Change Log

## BoardStat 2.0 (prototype) - 2026
 * A rebuild that no longer depends on Power BI: a Python + DuckDB pipeline and a static site that queries the data in your browser. See [`v2/README.md`](v2/README.md).
 * Community districts, council districts and address pages; 311 data from January 1, 2020, refreshed nightly.
 * Lives at https://www.beta.nyc/boardstat/ (moved from `/boardstat/v2/` in November 2026; old links redirect).
 * boardstat.beta.nyc (GitHub Pages) now redirects to https://www.beta.nyc/boardstat/.

## BoardStat v0.7 - A New Look
 * Updated all pages to have a new header from the NYC Core Framework
 * Added a new home page which includes a description and a map with links to the BoardStat borough pages

## BoardStat v0.6b - User experance tweeks and introducting new views
For this edit, we've made a number of user experance tweeks and modifications. You can track these improvements via our [github issue cue](https://github.com/BetaNYC/BoardStat/issues/84). Many thanks to [Prathm Juneja](https://github.com/prathmj) for spending a few weeks with us idenitifying and making these improvments.

 * #81: Reordered first page
 * #82: Reordered the top bar on every page
 * #49: Added clear all buttons to the top bar
 * #71: Added ability to select multiple addresses on Page 2
 * #83: Recolored Page 4
 * #77: Added the “Complaints Over Time” and “Compare Complaint Types” pages (to eventually replace “Service Requests by Year” and “Complaint Type by Month”)

 
## BoardStat v0.6a - THE BOROUGH EDITION!
 * NEW FEATURE - to support deployment to all five boroughs, we've consolidated individual community board views into a single borough view. Now, there are five dashboards. Next to the date selection field, you can select a board. if you want to look at a region, select more than one. Additionally, you can look at service request issues in parks by selecting their corresponding "board number."
 * **ALL DATA QUALITY ISSUES HAVE BEEN ADDRESSED BY NYC'S OPEN DATA TEAM.**
 * ~~DATA QUALITY ISSUES — Manhattan CB 08's data stream continues to include service request issues from Marble Hill, which is technically Manhattan but service by Bronx CB 08. Yet, there are some service requests from Manhattan's Marble Hill that are properly coded as Bronx CB 08. ~~
 * ~~DATA QUALITY ISSUES — In all Boroughs, Community Board 01 seems to be getting assigned ahandfull of the Borough's service requests. This service requests are listed below. As we are pulling directly from the open data portal, this seems to be a problem with the City's geocoder. We are working with MODA / DOITT / NYC 311 to address this issue ~~


## BoardStat v0.5e
Many thanks to [Briana Vecchione](https://github.com/brianavecchione) for making these updates.
 * NEW FEATURE - Time slicers are synced across pages. When you change the date on one page and move to the next page, the time query stays the same.
 * Data tables on Page 1, 2, 4are in higher definition.
 * Data is streaming via ODATA with a limit to 10000 per query. Due to changes on the City's open data portal, we have 12 special views that permit us access to ODATA without authentication. 
 * DATA QUALITY ISSUES — Currently, Manhattan CB 01 seems to be getting all of the Borough's street light condition & homeless person assistance service requests. As we are pulling directly from the open data portal, this seems to be a problem with the City's geocoder.
 * DATA QUALITY ISSUES — Manhattan CB 08's data stream continues to include service request issues from Marble Hill, which is technically Manhattan but service by Bronx CB 08. 


## Copyright
All documents are Creative Commons 4.0 By-Share Alike, via BetaNYC.
