# BoardStat data license

This file covers BoardStat's **data outputs**: the files the pipeline writes to
`v2/site/data/` and publishes at https://www.beta.nyc/boardstat/data/
(`manifest.json`, `build-log.md`, `LICENSE.txt`, `changes.json`, the Parquet files under
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
> Data. Data available under the Open Database License (ODbL) 1.0:
> https://opendatacommons.org/licenses/odbl/1-0/

If you publicly use a changed version of the database (a Derivative Database),
the ODbL requires you to offer it under the ODbL. See section 4.4 of the
license. Combining BoardStat's data with other, independent databases into a
Collective Database does not require licensing the whole collection under the
ODbL (section 4.5), but the ODbL still applies to BoardStat's part of it.

## Source records

Every record comes from NYC Open Data (https://data.cityofnewyork.us):

| Dataset | Id | Used for |
|---|---|---|
| 311 Service Requests from 2020 to Present | [`erm2-nwe9`](https://data.cityofnewyork.us/d/erm2-nwe9) | The service requests |
| Community Districts | [`5crt-au7u`](https://data.cityofnewyork.us/d/5crt-au7u) | Community district boundaries |
| City Council Districts | [`872g-cjhh`](https://data.cityofnewyork.us/d/872g-cjhh) | Council district boundaries |

These records remain subject to NYC Open Data's own terms of use, which this
license does not change. A link to the current terms page is tracked in
[#136](https://github.com/BetaNYC/BoardStat/issues/136).

## Street map

The street map is not part of the data outputs above. The site uses the City's
NYC basemap. If that cannot load, it switches to a Protomaps street map built
from © OpenStreetMap contributors data, which is itself under the ODbL
(https://www.openstreetmap.org/copyright).
