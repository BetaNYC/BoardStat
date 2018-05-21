# BoardStat
BoardStat is an interactive tool for New York City’s community boards. It empowers users to discover issues and trends within district boundaries. The six pages of the tool provide a variety of summaries, graphs, and maps of 311 data (from 2010 through the present day). Not only does BoardStat empower community board staff and members to gain timely insights into their residents’ concerns, but it also furthers Manhattan Borough President Gale A. Brewer's goal of moving beyond open data access to meaningful open data use.

This github repo is to document issues and outline future features. You can discover more of BoardStat's features within our [product overview document](https://docs.google.com/document/d/1pqDS1YaAF-HR0L_Ish6h1YFweZExaN41yX6sPaFGmKE/edit#).

| Borough  | Bit.ly URL |
| ------------- | ------------- |
| Bronx | https://bit.ly/BoardStat_v6a_Bronx |
| Brooklyn | https://bit.ly/BoardStat_v6a_Brooklyn |
| Manhattan | https://bit.ly/BoardStat_v6a_Manhattan |
| Queens | http://bit.ly/BoardStat_v6a_Queens |
| Staten Island | http://bit.ly/BoardStat_v6a_StatenIsland |

## File an Issue 
We're tracking all issues via this [repo's issue cue](https://github.com/BetaNYC/BoardStat/issues).

### Development Process and Methodology:
BoardStat was conceived with the Manhattan Borough President Gale A. Brewer as a simple 311 analysis tool. Through research conducted by Civic Innovation Fellows, key features were baked into a prototype. During the Spring semester of 2016 - 2017, fellows and BetaNYC staff, with assistance from Microsoft Civic Chicago and NYC, developed a prototype using PowerBI. Through group and one-on-one meetings, MBPO staff, Community District staff, and Community Board members helped refine key features. 

### Funders:
BoardStat was created with funds and support from the Alfred P. Sloan Foundation, Fund for the City of New York, and Microsoft Civic.

## Training Documents
BetaNYC routinely hosts 90 min public training sessions. To find out about the next training session, join our [meetup](https://meetup.com/betanyc). If you are a Manhattan Community Board District Office staff member or Community Board member, email us at 'boardstat@manhattanbp.nyc.gov' to set up a personal one-on-one training. 

In the meantime, you can browse our training materials.
 * [BoardStat Training - Data Journey Worksheet](https://docs.google.com/document/d/1DHgVLrm-X1gs1rwovhpWA5En_ozcQnTWHYobmG9_B0A/edit) - This is the worksheet BetaNYC uses to teach BoardStat. You can find companion slides [here](http://bit.ly/betanyc_datajourney_manhattan).
 * [Training Videos](https://) - In development
 
## Data
BoardStat is ingesting [NYC 311 Service Requests from 2010 to Present](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9) dataset directly from the city’s open data portal. Data is filtered by the Community Board column.

# Change Log

## BoardStat v0.6a - THE BOROUGH EDITION!
 * NEW FEATURE - to support deployment to all five boroughs, we've consolidated individual community board views into a single borough view. Now, there are five dashboards. Next to the date selection field, you can select a board. if you want to look at a region, select more than one. Additionally, you can look at service request issues in parks by selecting their corresponding "board number."
 * DATA QUALITY ISSUES — ALL CB 01s seems to be getting all of the Borough's street light condition & homeless person assistance service requests. As we are pulling directly from the open data portal, this seems to be a problem with the City's geocoder. We are working with NYC 311 to address this issue.
 * DATA QUALITY ISSUES — Manhattan CB 08's data stream continues to include service request issues from Marble Hill, which is technically Manhattan but service by Bronx CB 08. Yet, there are some service requests from Manhattan's Marble Hill that are properly coded as Bronx CB 08.
 * Missing Data - We are not seeing any 311 service requests from Rikers Island

## BoardStat v0.5e
 * NEW FEATURE - Time slicers are synced across pages. When you change the date on one page and move to the next page, the time query stays the same.
 * Data tables on Page 1, 2, 4are in higher definition.
 * Data is streaming via ODATA with a limit to 10000 per query. Due to changes on the City's open data portal, we have 12 special views that permit us access to ODATA without authentication. 
 * DATA QUALITY ISSUES — Currently, Manhattan CB 01 seems to be getting all of the Borough's street light condition & homeless person assistance service requests. As we are pulling directly from the open data portal, this seems to be a problem with the City's geocoder.
 * DATA QUALITY ISSUES — Manhattan CB 08's data stream continues to include service request issues from Marble Hill, which is technically Manhattan but service by Bronx CB 08. 


## Copyright
All documents are Creative Commons 4.0 By-Share Alike, via BetaNYC.
