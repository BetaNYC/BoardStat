# Third-party dependencies

The dashboards load these pinned releases from public CDNs:

| Dependency | Version | License | Project |
| --- | --- | --- | --- |
| Chart.js | 4.4.7 | MIT | https://github.com/chartjs/Chart.js |
| Leaflet | 1.9.4 | BSD-2-Clause | https://github.com/Leaflet/Leaflet |
| Leaflet.markercluster | 1.5.3 | MIT | https://github.com/Leaflet/Leaflet.markercluster |
| Esri Leaflet | 3.0.19 | Apache-2.0 | https://github.com/Esri/esri-leaflet |
| Esri Leaflet Vector | 4.3.0 | Apache-2.0 | https://github.com/Esri/esri-leaflet-vector |
| jQuery | 3.7.1 | MIT | https://github.com/jquery/jquery |

CDN assets include Subresource Integrity hashes. The site also retains NYC theme styles, Font Awesome, Popper, and Bootstrap. Google Analytics uses sanitized page metadata; see [SECURITY.md](SECURITY.md).

Map data and tiles carry visible attribution in the interface. The primary NYC vector basemap credits NYC OTI; the fallback layer credits OpenStreetMap contributors.

Self-hosted Instrument Sans and Noto Sans fonts use the SIL Open Font License; see [fonts/README.md](fonts/README.md) for copyright notices and the license.
