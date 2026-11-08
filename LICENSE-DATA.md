# BoardStat data license

This file covers BoardStat's **data outputs**: the files the pipeline writes to
`v2/site/data/` and publishes at https://www.beta.nyc/boardstat/data/
(`manifest.json`, `build-log.md`, `changes.json`, the Parquet files under
`detail/` and `agg/`, `addresses.parquet`, and the GeoJSON under `boundaries/`).
The code in this repository is under the MIT License; see [`LICENSE`](LICENSE).

## License

The BoardStat database is made available under the Open Database License (ODbL)
1.0: https://opendatacommons.org/licenses/odbl/1-0/

A plain-language summary is at https://opendatacommons.org/licenses/odbl/summary/.

The ODbL covers the database as a whole: how BoardStat selects, cleans,
combines and arranges the records. It does not cover the individual records
themselves. Those come from NYC Open Data and stay subject to the City's terms
of use (see "Source records" below).

## Attribution

If you use or share BoardStat's data, credit it like this:

> BoardStat by BetaNYC (https://www.beta.nyc/boardstat/), built from NYC Open
> Data. Data available under the Open Database License (ODbL) 1.0.

If you publish a changed or combined version of the database, the ODbL asks you
to share that version under the ODbL too. The license text has the details.

## Source records

Every record comes from NYC Open Data (https://data.cityofnewyork.us):

| Dataset | Id | Used for |
|---|---|---|
| 311 Service Requests from 2020 to Present | [`erm2-nwe9`](https://data.cityofnewyork.us/d/erm2-nwe9) | The service requests |
| Community Districts | [`5crt-au7u`](https://data.cityofnewyork.us/d/5crt-au7u) | Community district boundaries |
| City Council Districts | [`872g-cjhh`](https://data.cityofnewyork.us/d/872g-cjhh) | Council district boundaries |

These records remain subject to NYC Open Data's own terms of use, which this
license does not change.

## Street map

The street map in the BoardStat site is not part of the data outputs above. Its
fallback street map is built with Protomaps from © OpenStreetMap contributors
data, which is itself under the ODbL (https://www.openstreetmap.org/copyright).
