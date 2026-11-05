# Generated data (not committed)

Everything in this folder except this file and `.gitkeep` is written by the
pipeline and ignored by git. Rebuild it from the repository root with:

    uv run v2/pipeline/boardstat_build.py --out v2/site/data

| Path | What it is |
|---|---|
| `manifest.json` | Build time, source dataset ids and their `rowsUpdatedAt`, window, row counts, agreement report, district list |
| `build-log.md` | The agreement report and counts as Markdown |
| `boundaries/cd.geojson`, `boundaries/cc.geojson` | Simplified DCP boundaries for the web (properties: `id`, `label`, `jia`, `borough`) |
| `detail/cd/<boro_cd>.parquet`, `detail/cc/<coundist>.parquet` | One row per request in that district, sorted by `created_date` |
| `agg/month_type.parquet` | Request counts by `geo_kind` (cd, cc, borough, city), `geo_id`, `year_month`, `complaint_type` |
| `addresses.parquet` | Addresses as they appear in 311 data, with their district. Not a geocoder |
