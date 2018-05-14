# BoardStat
[BoardStat](http://bit.ly/boardstat) is an interactive tool for Manhattan’s community boards. It empowers users to discover issues and trends within district boundaries. The six pages of the tool provide a variety of summaries, graphs, and maps of 311 data (from 2010 through the present day). Not only does BoardStat empower community board staff and members to gain timely insights into their residents’ concerns, but it also furthers the Borough President’s goal of moving beyond open data access to meaningful open data use.

This github repo is to document issues and outline future features. You can discover more of BoardStat's features within our [product overview document](https://docs.google.com/document/d/1pqDS1YaAF-HR0L_Ish6h1YFweZExaN41yX6sPaFGmKE/edit#).

## File an Issue 
We're tracking all issues via this [repo's issue cue](https://github.com/BetaNYC/BoardStat/issues).

### Development Process and Methodology:
BoardStat was conceived with the Manhattan Borough President (MBPO) as a simple 311 analysis tool. Through research conducted by Civic Innovation Fellows, key features were baked into a prototype. During the Spring semester of 2016 - 2017, fellows and BetaNYC staff, with assistance from Microsoft Civic Chicago and NYC, developed a prototype using PowerBI. Through group and one-on-one meetings, MBPO staff, Community District staff, and Community Board members helped refine key features. 

### Funders:
BoardStat was created with funds and support from the Alfred P. Sloan Foundation, Fund for the City of New York, and Microsoft Civic.

## Training Documents
BetaNYC routinely hosts 90 min public training sessions. To find out about the next training session, join our [meetup](https://meetup.com/betanyc). If you are a Manhattan Community Board District Office staff member or Community Board member, email us at 'boardstat@manhattanbp.nyc.gov' to set up a personal one-on-one training.

In the meantime, you can browse our training materals.
 * [BoardStat Training - Data Journey Worksheet](https://docs.google.com/document/d/1DHgVLrm-X1gs1rwovhpWA5En_ozcQnTWHYobmG9_B0A/edit) - This is the worksheet BetaNYC uses to teach BoardStat. You can find companion slides [here](http://bit.ly/betanyc_datajourney_manhattan).
 * [Training Videos](https://) - In development
 
## Data
BoardStat is ingesting [NYC 311 Service Requests from 2010 to Present](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9) dataset directly from the city’s open data portal. Data is filtered by the Community Board column.

# Change Log

## BoardStat v0.5e
 * NEW FEATURE - Time slicers are synced across pages. When you change the date on one page and move to the next page, the time query stays the same.
 * Data tables on Page 1, 2, 4are in higher definition.
 * Data is streaming via ODATA with a limit to 10000 per query. Due to changes on the City's open data portal, we have 12 special views that permit us access to ODATA without authenication. 
 * DATA QUALITY ISSUES — Currently, Manhattan CB 01 seems to be getting all of the Borough's street light condition & homeless person assistance service requests. As we are pulling directly from the open data portal, this seems to be a problem with the City's geocoder.
 * DATA QUALITY ISSUES — Manhattan CB 08's data stream continues to include service request issues from Marble Hill, which is technically Manhattan but service by Bronx CB 08. 


## Copyright
All documents are Creative Commons 4.0 By-Share Alike, via BetaNYC.
