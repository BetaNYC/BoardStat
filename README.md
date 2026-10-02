# BoardStat

BoardStat helps New York City’s community boards explore 311 requests with charts, maps, and tables. The borough dashboards query NYC Open Data directly.

**IF you are looking for tutorals on how to use BoardStat's features, please check out our indepth page-by-page [videos on BetaNYC's YouTube](https://youtu.be/Q8JJfaizWik).**

| Borough  | URL |
| ------------- | ------------- |
| Bronx | https://boardstat.beta.nyc/bronx |
| Brooklyn | https://boardstat.beta.nyc/brooklyn |
| Manhattan | https://boardstat.beta.nyc/manhattan |
| Queens | https://boardstat.beta.nyc/queens |
| Staten Island | https://boardstat.beta.nyc/statenisland |

## Using the dashboard

Choose a borough, then use the shared filters and numbered views to explore requests. The default is the last 30 days across that borough's permitted boards. Filters and the selected view are saved in the URL for sharing. **View data** opens a chart or map's table; **Reset filters** restores the defaults. If a request fails, use **Retry current view**. Any retained results are marked as stale.

## File an Issue 
We're tracking all issues via this [repo's issue cue](https://github.com/BetaNYC/BoardStat/issues).

### Development Process and Methodology:
BoardStat was conceived with the Manhattan Borough President Gale A. Brewer as a simple 311 analysis tool. Through research conducted by Civic Innovation Fellows, key features were baked into a prototype. During the Spring semester of 2016 - 2017, fellows and BetaNYC staff, with assistance from Microsoft Civic Chicago and NYC, developed a prototype using PowerBI. Through group and one-on-one meetings, MBPO staff, Community District staff, and Community Board members helped refine key features. 

### Funders:
BoardStat was created with funds and support from the Alfred P. Sloan Foundation, Fund for the City of New York, and Microsoft Civic.

## Training Documents
BetaNYC routinely hosts 90 min public training sessions. To find out about the next training session, join our [meetup](https://meetup.com/betanyc). If you are a Manhattan Community Board District Office staff member or Community Board member, email us at 'boardstat@manhattanbp.nyc.gov' to set up a personal one-on-one training. 

**IF you are looking for tutorals on how to use BoardStat's features, please check out our indepth page-by-page [videos on BetaNYC's YouTube](https://youtu.be/Q8JJfaizWik).**

In the meantime, you can browse our training materials.
 * [BoardStat Training - Data Journey Worksheet](https://docs.google.com/document/d/1DHgVLrm-X1gs1rwovhpWA5En_ozcQnTWHYobmG9_B0A/edit) - This is the worksheet BetaNYC uses to teach BoardStat. You can find companion slides [here](http://bit.ly/betanyc_datajourney_manhattan).
 * [Training Videos](https://) - In development
 
## Data

BoardStat queries NYC Open Data's [2010–2019](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-2019/76ig-c548/about_data) and [2020–present](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2020-to-Present/erm2-nwe9/about_data) 311 datasets, filtered by borough and Community Board. Dates from January 1, 2010 through today are supported. Ranges crossing 2020 query both datasets and merge their results. Responses are cached for five minutes, with no background polling.

The request table and default map show the newest matching records, not every request or a representative sample. The map shows up to 250 requests per dataset; hotspot mode shows up to 100 locations. Address and hotspot rankings spanning both datasets are labeled as leading candidates because each dataset is ranked separately before merging. Totals and low-cardinality aggregates are exact. BoardStat uses the source's borough and board labels without independently geocoding them.

## Development

No build step is needed. Run `python3 -m http.server 8000` and open `http://localhost:8000/manhattan.html` (or another borough).

```bash
node --test tests/*.test.mjs
node tests/live-api-validation.mjs  # optional; queries NYC Open Data
```

See [validation](VALIDATION.md), [accessibility](ACCESSIBILITY.md), and [deployment](DEPLOYMENT.md) for checks and known limitations. Production is served from `gh-pages`.

Third-party libraries, maps, and fonts are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Production analytics receive a canonical page name without dashboard filters or a referrer; previews send no analytics. NYC Open Data receives the filters needed for queries. See [SECURITY.md](SECURITY.md) for details.

## AI assistance and human verification

OpenAI Codex assisted with code, tests, debugging, documentation, and automated browser checks, using public repository content, documentation, and NYC 311 data. AI is not used at runtime and does not alter the displayed records or statistics.

**Human verification status:** in progress. A contributor walkthrough is recorded; independent review is pending. See the [validation record](VALIDATION.md) and [BetaNYC's AI Policy](https://beta.nyc/about/ai-policy).

# Change Log

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
