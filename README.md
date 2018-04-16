# BoardStat
BoardStat is an interactive tool for Manhattan’s community boards. It empowers users to discover issues and trends within district boundaries. The six pages of the tool provide a variety of summaries, graphs, and maps of 311 data (from 2010 through the present day). Not only does BoardStat empower community board staff and members to gain timely insights into their residents’ concerns, but it also furthers the Borough President’s goal of moving beyond open data access to meaningful open data use.

This github repo is to document issues and outline future features.

## File an Issue 
We're tracking all issues via this [repo's issue cue](https://github.com/BetaNYC/BoardStat/issues).

### Development Process and Methodology:
BoardStat was conceived with the Manhattan Borough President (MBPO) as a simple 311 analysis tool. Through research conducted by Civic Innovation Fellows, key features were baked into a prototype. During the Spring semester of 2016 - 2017, fellows and BetaNYC staff, with assistance from Microsoft Civic Chicago and NYC, developed a prototype using PowerBI. Through group and one-on-one meetings, MBPO staff, Community District staff, and Community Board members helped refine key features. 

## Background Document
 * [Product overview document](https://docs.google.com/document/d/1pqDS1YaAF-HR0L_Ish6h1YFweZExaN41yX6sPaFGmKE/edit#)
 * [NYC 311 Data Jam Boardstat Doc](https://docs.google.com/document/d/1cxCQfUbsb-ryWZ_-hB_ZMvUYfLXF1KpVef4cubrhJ38/edit#)

## Copyright
All documents are Creative Commons 4.0 By-Share Alike, via BetaNYC.

## Data
Currently, BoardStat is ingesting NYC 311 service request data from the city’s open data portal. Data is filtered by the Community Board column. Link to [NYC 311 Service Requests from 2010 to Present](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9).

# Change Log

## BoardStat v0.5e
 ! NOTE - ODATA streaming is not working like it should. We are working with Socrata to address this issue. For now, data is being manually published.
 * ODATA feed is now authenticated with a limit to 5000 per query
 * Time slicers are synced across pages. When you change the date on one page and move to the next page, the time query stays the same.
 * Page 1, 2, 4 tables are in higher definition.
