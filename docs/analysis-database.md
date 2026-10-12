# Local analysis database

`npm run data:database` builds one local SQLite file:

```text
local-data/farms/FARM_ID/analysis/satellite-productivity-detection.sqlite
```

The build uses the farm sources and browser-performance products in the active
ignored farm workspace. It makes no network requests and uploads nothing. The
database is ignored by Git because it contains farm-level spatial data and can
be rebuilt locally.

The row counts depend on the refreshed catalogue and are recorded exactly in
the `metadata.table_row_counts` JSON value. The principal grains are:

| Table | Grain |
| --- | --- |
| `fields` | Stable field ID |
| `rotation_records` | Field × harvest year |
| `weather_windows` | Harvest year × crop window |
| `weather_daily` | Farm-centroid day |
| `spatial_cells` | Field × retained 10 m display cell |
| `performance_crop_years` | Mapped field × usable crop year, including phenology features |
| `satellite_dates` | Mapped field × usable optical date |
| `cell_crop_year_values` | Crop year × field cell |
| `cell_date_values` | Optical date × field cell × stored multi-index/band values |
| `landsat_dates` | Ingested Landsat Collection 2 scene |
| `cell_landsat_values` | Landsat scene × field × 10 m display-cell join |
| `radar_dates` | Ingested OPERA RTC-S1 scene |
| `cell_radar_values` | Radar scene × field × 10 m display-cell join |

The exact counts and source paths used for a build are stored in `metadata`.
Column definitions and units are available inside `data_dictionary`.

## Analytical controls

- Raw NDVI, EVI2, NDRE, the B8A/B11 water-status index, red-edge, narrow-NIR
  and SWIR values exist only at individual field-cell-date grain.
- NDVI and EVI2 retain 10 m support. NDRE, water-status, red-edge and SWIR
  retain native 20 m support; repeated 10 m joined rows do not create new
  spatial evidence.
- Each date's `relative_score` equally averages the available tied percentile
  ranks of NDVI, EVI2, NDRE and water-status against valid cells in that same
  field and date.
- Each crop-year cell score combines those relative date values using stage,
  clear-coverage and feature-support weights. Crop-window and boundary
  confidence weight the completed season rather than cancelling at date level.
- A mapped crop year needs at least four clear dates, including two before
  observed peak canopy and one after it. Variability needs five. Excluded crop
  years remain visible in the browser payload even though they create no
  `performance_crop_years` row.
- Green-up, growth rate, peak, canopy duration, senescence, curve area and
  normal-curve deviation are stored in `performance_crop_years`.
- `v_cell_same_crop_persistence` groups only like crop codes and is the
  preferred persistence view.
- `v_cell_cross_crop_persistence` combines crops only after the date and
  crop-year normalisation above. It exposes both crop-year and distinct-crop
  counts so sparse or crop-dominated evidence remains visible.
- Weather is farm-level temporal context. It is not treated as within-field
  spatial variation.
- Experimental Sentinel-1 radar is accepted only from OPERA radiometrically
  terrain-corrected gamma0. It remains supplementary and native 30 m values
  may repeat across their 10 m display-cell joins. The default status is
  `not_ingested`.
- Landsat is a separate native-30 m historical evidence track. Its NDVI,
  EVI2 and water-status ranks are never fused into the Sentinel-2 score;
  repeated rows in the 10 m cell join do not create extra spatial evidence.
- Missing sowing, harvest and management values remain `NULL`; they are not
  imputed.

Spatial cell coordinates are stored in the Sentinel grid's projected CRS,
with WGS84 longitude and latitude added when GDAL is available. The source
CRS is read from `farm-grid.json` rather than assumed, and the exact value is
recorded in `metadata`.

## Open and inspect

From the repository root:

```bash
sqlite3 local-data/farms/FARM_ID/analysis/satellite-productivity-detection.sqlite
```

Then:

```sql
.tables
.headers on
.mode column

SELECT key, value
FROM metadata
ORDER BY key;

SELECT *
FROM data_dictionary
ORDER BY table_name, column_name;
```

## Example analyses

Same-crop persistence, requiring at least two independent crop years:

```sql
SELECT
  field_name,
  crop_code,
  cell_index,
  crop_year_count,
  ROUND(quality_weighted_relative_score, 1) AS relative_score
FROM v_cell_same_crop_persistence
WHERE crop_year_count >= 2
ORDER BY field_name, crop_code, relative_score;
```

Cells whose relative result changes between wet and dry crop years:

```sql
WITH response AS (
  SELECT
    field_code,
    field_name,
    cell_index,
    AVG(CASE WHEN weather_class = 'wet' THEN relative_score END) AS wet_score,
    AVG(CASE WHEN weather_class = 'dry' THEN relative_score END) AS dry_score,
    COUNT(DISTINCT CASE
      WHEN weather_class = 'wet' THEN harvest_year
    END) AS wet_years,
    COUNT(DISTINCT CASE
      WHEN weather_class = 'dry' THEN harvest_year
    END) AS dry_years
  FROM v_cell_crop_year_analysis
  GROUP BY field_code, field_name, cell_index
)
SELECT
  *,
  ROUND(wet_score - dry_score, 1) AS wet_minus_dry
FROM response
WHERE wet_score IS NOT NULL
  AND dry_score IS NOT NULL
  AND wet_years >= 3
  AND dry_years >= 3
ORDER BY ABS(wet_score - dry_score) DESC;
```

Current-crop performance by preceding crop and rotation position:

```sql
SELECT
  crop_code,
  previous_crop_code,
  rotation_position,
  COUNT(DISTINCT harvest_year || ':' || field_code) AS field_years,
  ROUND(AVG(relative_score), 1) AS mean_relative_score
FROM v_cell_crop_year_analysis
WHERE relative_score IS NOT NULL
GROUP BY crop_code, previous_crop_code, rotation_position
ORDER BY crop_code, field_years DESC;
```

Trace a crop-year composite back to its satellite dates:

```sql
SELECT
  observation_date,
  scene_id,
  stage,
  stage_estimated,
  stage_method,
  trajectory_value,
  median_ndvi,
  median_evi2,
  median_ndre,
  median_ndwi,
  clear_fraction,
  native_20m_clear_fraction,
  relative_feature_count,
  observation_weight,
  valid_cell_count
FROM satellite_dates
WHERE season_id = '<farm-id>-<field-id>-<harvest-year>'
ORDER BY observation_date;
```

Inspect all index inputs and their combined same-date within-field rank:

```sql
SELECT
  field_name,
  observation_date,
  cell_index,
  easting_m,
  northing_m,
  raw_ndvi,
  raw_evi2,
  raw_ndre,
  raw_ndwi,
  rededge1_reflectance,
  rededge2_reflectance,
  rededge3_reflectance,
  narrow_nir_reflectance,
  swir16_reflectance,
  swir22_reflectance,
  relative_score
FROM v_cell_date_analysis
WHERE field_code = 'example-field'
  AND observation_date = '2017-03-09'
  AND is_valid = 1
ORDER BY cell_index;
```

Inspect the inferred trajectory features for one field:

```sql
SELECT
  harvest_year,
  model_crop_code,
  trajectory_coverage_start,
  trajectory_coverage_end,
  greenup_date,
  spring_growth_rate_per_day,
  peak_canopy_date,
  peak_at_observation_boundary,
  high_canopy_duration_days,
  senescence_onset_date,
  senescence_rate_per_day,
  area_under_curve_mean,
  late_season_persistence,
  late_season_gap_days,
  normal_curve_rmse,
  phenology_confidence
FROM performance_crop_years
WHERE field_code = 'example-field'
ORDER BY harvest_year;
```

Inspect optional cloud-resistant radar evidence without confusing its native
30 m support with the 10 m display join:

```sql
SELECT
  field_name,
  observation_date,
  cell_index,
  native_support_metres,
  vv_db,
  vh_db,
  vv_minus_vh_db,
  vh_vv_ratio
FROM v_cell_radar_analysis
WHERE field_code = 'example-field'
  AND is_valid = 1
ORDER BY observation_date, cell_index;
```

Inspect the separate Landsat history:

```sql
SELECT
  field_name,
  observation_date,
  platform,
  cell_index,
  raw_ndvi,
  raw_evi2,
  raw_ndwi,
  relative_score
FROM v_cell_landsat_analysis
WHERE field_code = 'example-field'
  AND is_valid = 1
ORDER BY observation_date, cell_index;
```

Replace the example field, season or date with values returned by:

```sql
SELECT field_code, field_name FROM fields ORDER BY field_name;
SELECT season_id, field_code, harvest_year, model_crop_code
FROM performance_crop_years
ORDER BY field_code, harvest_year;
SELECT DISTINCT observation_date
FROM satellite_dates
ORDER BY observation_date;
```

## Python and CSV access

Python needs no additional database package:

```python
import sqlite3

database = sqlite3.connect(
    "local-data/farms/FARM_ID/analysis/satellite-productivity-detection.sqlite"
)
database.row_factory = sqlite3.Row
rows = database.execute(
    """
    SELECT *
    FROM v_cell_same_crop_persistence
    WHERE crop_year_count >= 2
    """
).fetchall()
```

Export any query to CSV:

```bash
sqlite3 -header -csv \
  local-data/farms/FARM_ID/analysis/satellite-productivity-detection.sqlite \
  "SELECT * FROM v_cell_same_crop_persistence" \
  > local-data/farms/FARM_ID/analysis/same-crop-persistence.csv
```

To build a separately named copy:

```bash
npm run data:database -- \
  --output local-data/farms/FARM_ID/analysis/satellite-productivity-detection-copy.sqlite
```
