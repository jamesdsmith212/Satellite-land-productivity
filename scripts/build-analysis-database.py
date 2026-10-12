#!/usr/bin/env python3
"""Build one local SQLite database for rotation, weather and satellite analysis."""

from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from farm_config import (
    ANALYSIS_DIR,
    BOUNDARIES_PATH,
    BOUNDARY_VERSION_PREFIX,
    CURRENT_HARVEST_YEAR,
    DAILY_WEATHER_PATH,
    FARM_CRS,
    FARM_ID,
    FARM_NAME,
    HISTORY_PATH,
    LANDSAT_SUMMARY_PATH,
    NDVI_DIR,
    PERFORMANCE_SUMMARY_PATH,
    RADAR_SUMMARY_PATH,
    WEATHER_SUMMARY_PATH,
    repository_display_path,
)

try:
    from osgeo import osr
except ImportError:  # Coordinates remain available in UTM if GDAL is absent.
    osr = None
else:
    osr.UseExceptions()


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = (
    ANALYSIS_DIR / "satellite-productivity-detection.sqlite"
)
GRID_PATH = NDVI_DIR / "farm-grid.json"

ARABLE_CROPS = {
    "winter_wheat",
    "spring_wheat",
    "winter_barley",
    "spring_barley",
    "winter_beans",
    "spring_beans",
    "winter_oilseed_rape",
    "spring_oilseed_rape",
    "winter_oats",
    "spring_oats",
}
BREAK_GROUPS = {"break", "grass", "fallow"}

CROP_TAXONOMY = {
    "winter_wheat": ("Winter wheat", "cereal", "winter"),
    "spring_wheat": ("Spring wheat", "cereal", "spring"),
    "winter_barley": ("Winter barley, use unknown", "cereal", "winter"),
    "spring_barley": ("Spring barley, use unknown", "cereal", "spring"),
    "winter_feed_barley": ("Winter feed barley", "cereal", "winter"),
    "winter_malting_barley": ("Winter malting or distilling barley", "cereal", "winter"),
    "spring_feed_barley": ("Spring feed barley", "cereal", "spring"),
    "spring_malting_barley": ("Spring malting barley", "cereal", "spring"),
    "winter_oats": ("Winter oats", "cereal", "winter"),
    "spring_oats": ("Spring oats", "cereal", "spring"),
    "winter_oilseed_rape": ("Winter oilseed rape", "break", "winter"),
    "spring_oilseed_rape": ("Spring oilseed rape", "break", "spring"),
    "winter_beans": ("Winter beans", "break", "winter"),
    "spring_beans": ("Spring beans", "break", "spring"),
    "temporary_grass": ("Temporary grass", "grass", "perennial"),
    "permanent_grass": ("Permanent grass", "grass", "perennial"),
    "cover_crop": ("Cover crop", "cover", "unknown"),
    "fallow": ("Fallow or uncropped", "fallow", "none"),
    "native_woodland": ("Native woodland", "woodland", "perennial"),
    "non_native_woodland": ("Non-native woodland", "woodland", "perennial"),
    "unknown": ("Unknown crop", "unknown", "unknown"),
}


def load_json(path: Path):
    if not path.exists():
        raise FileNotFoundError(f"Required local source is missing: {path}")
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def canonical_crop(source_code: str, field_has_arable_history: bool) -> str:
    source_code = (source_code or "").strip().lower()
    if source_code == "grass":
        return "temporary_grass" if field_has_arable_history else "permanent_grass"
    return source_code if source_code in CROP_TAXONOMY else "unknown"


def crop_details(crop_code: str) -> tuple[str, str, str]:
    return CROP_TAXONOMY.get(crop_code, CROP_TAXONOMY["unknown"])


def weather_window(season_type: str, crop_group: str) -> str:
    if season_type == "winter":
        return "winter"
    if season_type == "spring":
        return "spring"
    if crop_group == "grass":
        return "grass"
    return "crop_year"


def rotation_position(
    source_crop: str,
    crop_code: str,
    crop_group: str,
    previous_crop_code: str,
) -> str:
    source_upper = (source_crop or "").strip().upper()
    if source_upper == "WW1":
        return "First cereal"
    if source_upper == "WW2":
        return "Second cereal"
    previous_group = crop_details(previous_crop_code)[1]
    if crop_group == "cereal":
        if previous_group == "cereal":
            return "Consecutive cereal"
        if previous_group in BREAK_GROUPS:
            return "First cereal"
        return "Cereal position unknown"
    if crop_group == "break":
        return "Break crop"
    if crop_code == "temporary_grass":
        return "Temporary grass"
    if crop_code == "permanent_grass":
        return "Permanent grass"
    if crop_group == "woodland":
        return "Woodland"
    if crop_group == "fallow":
        return "Fallow"
    return "Unknown"


def years_since(prior: list[dict], harvest_year: int, predicate) -> int | None:
    previous = next((record for record in reversed(prior) if predicate(record)), None)
    return harvest_year - previous["harvest_year"] if previous else None


def consecutive_count(current: dict, prior: list[dict], key: str, value: str) -> int:
    count = 0
    for record in [current, *reversed(prior)]:
        if record[key] != value:
            break
        count += 1
    return count


def make_coordinate_transformer(source_projection: str):
    if osr is None:
        return None
    source = osr.SpatialReference()
    source.SetFromUserInput(source_projection)
    target = osr.SpatialReference()
    target.ImportFromEPSG(4326)
    source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return osr.CoordinateTransformation(source, target)


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE crop_taxonomy (
  crop_code TEXT PRIMARY KEY,
  crop_name TEXT NOT NULL,
  crop_group TEXT NOT NULL,
  season_type TEXT NOT NULL
);

CREATE TABLE fields (
  field_code TEXT PRIMARY KEY,
  field_name TEXT NOT NULL,
  recorded_hectares REAL,
  recorded_acres REAL,
  first_harvest_year INTEGER NOT NULL,
  last_harvest_year INTEGER NOT NULL,
  has_current_boundary INTEGER NOT NULL CHECK (has_current_boundary IN (0, 1)),
  boundary_uuid TEXT,
  boundary_version TEXT,
  boundary_match_type TEXT,
  boundary_geometry_geojson TEXT,
  boundary_properties_json TEXT
);

CREATE TABLE field_rotation_metrics (
  field_code TEXT PRIMARY KEY REFERENCES fields(field_code),
  historical_record_count INTEGER NOT NULL,
  known_crop_record_count INTEGER NOT NULL,
  distinct_crop_count INTEGER NOT NULL,
  spring_crop_proportion REAL,
  winter_crop_proportion REAL,
  rotation_diversity REAL
);

CREATE TABLE rotation_records (
  season_id TEXT PRIMARY KEY,
  field_code TEXT NOT NULL REFERENCES fields(field_code),
  field_name TEXT NOT NULL,
  source_field_year TEXT NOT NULL,
  harvest_year INTEGER NOT NULL,
  source_crop TEXT,
  crop_normalised TEXT,
  crop_code TEXT NOT NULL REFERENCES crop_taxonomy(crop_code),
  crop_name TEXT NOT NULL,
  crop_group TEXT NOT NULL,
  season_type TEXT NOT NULL,
  crop_type_or_use TEXT,
  variety TEXT,
  crop_variety TEXT,
  previous_crop_code TEXT REFERENCES crop_taxonomy(crop_code),
  rotation_position TEXT NOT NULL,
  years_since_same_crop INTEGER,
  years_since_break_crop INTEGER,
  years_since_temporary_grass INTEGER,
  years_since_organic_manure INTEGER,
  consecutive_cereals INTEGER NOT NULL,
  consecutive_autumn_sown INTEGER NOT NULL,
  sowing_date TEXT,
  harvest_date TEXT,
  establishment_method TEXT,
  cultivation_system TEXT,
  seed_rate TEXT,
  end_market TEXT,
  straw_management TEXT,
  cover_crop TEXT,
  organic_manure TEXT,
  drainage_or_structure_work TEXT,
  notes TEXT,
  weather_window TEXT NOT NULL,
  recorded_hectares REAL,
  recorded_acres REAL,
  boundary_uuid TEXT,
  boundary_name TEXT,
  boundary_version TEXT NOT NULL,
  satellite_performance_available INTEGER NOT NULL CHECK (
    satellite_performance_available IN (0, 1)
  )
);

CREATE TABLE weather_windows (
  harvest_year INTEGER NOT NULL,
  weather_window TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  last_available_date TEXT,
  coverage REAL,
  partial INTEGER,
  precipitation_mm REAL,
  et0_mm REAL,
  water_balance_mm REAL,
  mean_temperature_c REAL,
  gdd_base_5 REAL,
  surface_soil_moisture REAL,
  root_zone_soil_moisture REAL,
  deep_soil_moisture REAL,
  water_balance_z REAL,
  temperature_z REAL,
  moisture_class TEXT,
  temperature_class TEXT,
  PRIMARY KEY (harvest_year, weather_window)
) WITHOUT ROWID;

CREATE TABLE weather_daily (
  date TEXT PRIMARY KEY,
  temperature_mean_c REAL,
  temperature_min_c REAL,
  temperature_max_c REAL,
  soil_moisture_0_7cm REAL,
  soil_moisture_7_28cm REAL,
  soil_moisture_28_100cm REAL,
  precipitation_mm REAL,
  et0_mm REAL
);

CREATE TABLE spatial_cells (
  field_code TEXT NOT NULL REFERENCES fields(field_code),
  cell_index INTEGER NOT NULL,
  local_column INTEGER NOT NULL,
  local_row INTEGER NOT NULL,
  farm_column INTEGER NOT NULL,
  farm_row INTEGER NOT NULL,
  easting_m REAL NOT NULL,
  northing_m REAL NOT NULL,
  longitude REAL,
  latitude REAL,
  edge_reliability REAL NOT NULL,
  PRIMARY KEY (field_code, cell_index)
) WITHOUT ROWID;

CREATE TABLE performance_crop_years (
  season_id TEXT PRIMARY KEY REFERENCES rotation_records(season_id),
  field_code TEXT NOT NULL REFERENCES fields(field_code),
  harvest_year INTEGER NOT NULL,
  model_crop_code TEXT NOT NULL,
  crop_group TEXT NOT NULL,
  season_type TEXT NOT NULL,
  evidence_tier TEXT NOT NULL,
  evidence_reason TEXT,
  coverage_days INTEGER,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  window_confidence REAL NOT NULL,
  window_method TEXT NOT NULL,
  boundary_confidence REAL NOT NULL,
  data_quality INTEGER NOT NULL,
  quality_weight REAL NOT NULL,
  weather_class TEXT NOT NULL,
  water_balance_mm REAL,
  water_balance_z REAL,
  temperature_z REAL,
  gdd_base_5 REAL,
  root_zone_soil_moisture REAL,
  usable_date_count INTEGER NOT NULL,
  phenology_method TEXT,
  phenology_confidence INTEGER,
  phenology_observation_count INTEGER,
  trajectory_coverage_start TEXT,
  trajectory_coverage_end TEXT,
  greenup_date TEXT,
  spring_growth_rate_per_day REAL,
  peak_canopy_date TEXT,
  peak_at_observation_boundary INTEGER
    CHECK (peak_at_observation_boundary IN (0, 1)),
  maximums_json TEXT,
  area_under_curve_index_days REAL,
  area_under_curve_mean REAL,
  high_canopy_duration_days INTEGER,
  senescence_onset_date TEXT,
  senescence_rate_per_day REAL,
  late_season_persistence REAL,
  late_season_gap_days INTEGER,
  normal_curve_comparison_count INTEGER,
  normal_curve_rmse REAL,
  normal_curve_signed_deviation REAL
);

CREATE TABLE satellite_dates (
  date_id INTEGER PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES performance_crop_years(season_id),
  field_code TEXT NOT NULL REFERENCES fields(field_code),
  harvest_year INTEGER NOT NULL,
  model_crop_code TEXT NOT NULL,
  observation_date TEXT NOT NULL,
  scene_id TEXT,
  stage TEXT NOT NULL,
  stage_estimated INTEGER NOT NULL,
  stage_method TEXT,
  trajectory_value REAL,
  relative_season_position REAL NOT NULL,
  gdd_base_5_from_window_start REAL,
  median_ndvi REAL,
  median_evi2 REAL,
  median_ndre REAL,
  median_ndwi REAL,
  clear_fraction REAL NOT NULL,
  native_20m_clear_fraction REAL,
  relative_feature_count REAL,
  stage_weight REAL NOT NULL,
  observation_weight REAL NOT NULL,
  valid_cell_count INTEGER NOT NULL,
  source_file TEXT NOT NULL,
  method TEXT NOT NULL,
  UNIQUE (season_id, observation_date)
);

CREATE TABLE cell_crop_year_values (
  season_id TEXT NOT NULL REFERENCES performance_crop_years(season_id),
  field_code TEXT NOT NULL,
  cell_index INTEGER NOT NULL,
  relative_score REAL,
  within_crop_year_variability REAL,
  usable_observation_count INTEGER NOT NULL,
  PRIMARY KEY (season_id, cell_index),
  FOREIGN KEY (field_code, cell_index)
    REFERENCES spatial_cells(field_code, cell_index)
) WITHOUT ROWID;

CREATE TABLE cell_date_values (
  date_id INTEGER NOT NULL REFERENCES satellite_dates(date_id),
  field_code TEXT NOT NULL,
  cell_index INTEGER NOT NULL,
  raw_ndvi REAL,
  raw_evi2 REAL,
  raw_ndre REAL,
  raw_ndwi REAL,
  rededge1_reflectance REAL,
  rededge2_reflectance REAL,
  rededge3_reflectance REAL,
  narrow_nir_reflectance REAL,
  swir16_reflectance REAL,
  swir22_reflectance REAL,
  relative_score REAL,
  relative_feature_count INTEGER,
  is_valid INTEGER NOT NULL CHECK (is_valid IN (0, 1)),
  PRIMARY KEY (date_id, cell_index),
  FOREIGN KEY (field_code, cell_index)
    REFERENCES spatial_cells(field_code, cell_index)
) WITHOUT ROWID;

CREATE TABLE landsat_dates (
  landsat_date_id INTEGER PRIMARY KEY,
  observation_date TEXT NOT NULL,
  scene_id TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  wrs_path INTEGER,
  wrs_row INTEGER,
  native_support_metres INTEGER NOT NULL,
  source_file TEXT NOT NULL
);

CREATE TABLE cell_landsat_values (
  landsat_date_id INTEGER NOT NULL REFERENCES landsat_dates(landsat_date_id),
  field_code TEXT NOT NULL,
  cell_index INTEGER NOT NULL,
  raw_ndvi REAL,
  raw_evi2 REAL,
  raw_ndwi REAL,
  red_reflectance REAL,
  nir_reflectance REAL,
  swir16_reflectance REAL,
  swir22_reflectance REAL,
  relative_score REAL,
  is_valid INTEGER NOT NULL CHECK (is_valid IN (0, 1)),
  PRIMARY KEY (landsat_date_id, field_code, cell_index),
  FOREIGN KEY (field_code, cell_index)
    REFERENCES spatial_cells(field_code, cell_index)
) WITHOUT ROWID;

CREATE TABLE radar_dates (
  radar_date_id INTEGER PRIMARY KEY,
  observation_date TEXT NOT NULL,
  scene_id TEXT NOT NULL UNIQUE,
  product_type TEXT NOT NULL,
  native_support_metres INTEGER NOT NULL,
  quality_mask TEXT,
  source_file TEXT NOT NULL
);

CREATE TABLE cell_radar_values (
  radar_date_id INTEGER NOT NULL REFERENCES radar_dates(radar_date_id),
  field_code TEXT NOT NULL,
  cell_index INTEGER NOT NULL,
  vv_db REAL,
  vh_db REAL,
  vv_minus_vh_db REAL,
  vh_vv_ratio REAL,
  is_valid INTEGER NOT NULL CHECK (is_valid IN (0, 1)),
  PRIMARY KEY (radar_date_id, field_code, cell_index),
  FOREIGN KEY (field_code, cell_index)
    REFERENCES spatial_cells(field_code, cell_index)
) WITHOUT ROWID;

CREATE TABLE data_dictionary (
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  description TEXT NOT NULL,
  unit TEXT,
  source TEXT NOT NULL,
  PRIMARY KEY (table_name, column_name)
) WITHOUT ROWID;
"""


INDEXES_AND_VIEWS = """
CREATE INDEX rotation_field_year_idx
  ON rotation_records(field_code, harvest_year);
CREATE INDEX rotation_crop_idx
  ON rotation_records(crop_code, harvest_year);
CREATE INDEX rotation_previous_crop_idx
  ON rotation_records(previous_crop_code, crop_code);
CREATE INDEX rotation_position_idx
  ON rotation_records(rotation_position, crop_code);
CREATE INDEX performance_field_year_idx
  ON performance_crop_years(field_code, harvest_year);
CREATE INDEX performance_crop_weather_idx
  ON performance_crop_years(model_crop_code, weather_class);
CREATE INDEX satellite_season_date_idx
  ON satellite_dates(season_id, observation_date);
CREATE INDEX satellite_field_date_idx
  ON satellite_dates(field_code, observation_date);
CREATE INDEX cell_crop_year_field_cell_idx
  ON cell_crop_year_values(field_code, cell_index, season_id);
CREATE INDEX cell_date_field_cell_idx
  ON cell_date_values(field_code, cell_index, date_id);
CREATE INDEX radar_field_cell_date_idx
  ON cell_radar_values(field_code, cell_index, radar_date_id);
CREATE INDEX landsat_field_cell_date_idx
  ON cell_landsat_values(field_code, cell_index, landsat_date_id);

CREATE VIEW v_rotation_with_weather AS
SELECT
  r.*,
  w.start_date AS weather_start_date,
  w.end_date AS weather_end_date,
  w.coverage AS weather_coverage,
  w.precipitation_mm,
  w.et0_mm,
  w.water_balance_mm,
  w.mean_temperature_c,
  w.gdd_base_5,
  w.root_zone_soil_moisture,
  w.water_balance_z,
  w.temperature_z,
  w.moisture_class,
  w.temperature_class
FROM rotation_records r
LEFT JOIN weather_windows w
  ON w.harvest_year = r.harvest_year
 AND w.weather_window = r.weather_window;

CREATE VIEW v_cell_crop_year_analysis AS
SELECT
  v.field_code,
  f.field_name,
  v.cell_index,
  c.easting_m,
  c.northing_m,
  c.longitude,
  c.latitude,
  r.harvest_year,
  r.crop_code,
  r.crop_name,
  r.crop_group,
  r.season_type,
  r.previous_crop_code,
  r.rotation_position,
  r.years_since_same_crop,
  r.years_since_break_crop,
  r.consecutive_cereals,
  r.consecutive_autumn_sown,
  p.weather_class,
  p.water_balance_mm,
  p.water_balance_z,
  p.temperature_z,
  p.data_quality,
  p.quality_weight,
  v.relative_score,
  v.within_crop_year_variability,
  v.usable_observation_count,
  c.edge_reliability
FROM cell_crop_year_values v
JOIN performance_crop_years p ON p.season_id = v.season_id
JOIN rotation_records r ON r.season_id = v.season_id
JOIN fields f ON f.field_code = v.field_code
JOIN spatial_cells c
  ON c.field_code = v.field_code AND c.cell_index = v.cell_index;

CREATE VIEW v_cell_date_analysis AS
SELECT
  v.field_code,
  f.field_name,
  v.cell_index,
  c.easting_m,
  c.northing_m,
  c.longitude,
  c.latitude,
  d.observation_date,
  d.scene_id,
  d.stage,
  d.stage_estimated,
  d.stage_method,
  d.trajectory_value,
  d.relative_season_position,
  d.clear_fraction,
  d.native_20m_clear_fraction,
  d.relative_feature_count AS date_relative_feature_count,
  d.observation_weight,
  r.harvest_year,
  r.crop_code,
  r.crop_name,
  r.previous_crop_code,
  r.rotation_position,
  p.weather_class,
  v.raw_ndvi,
  v.raw_evi2,
  v.raw_ndre,
  v.raw_ndwi,
  v.rededge1_reflectance,
  v.rededge2_reflectance,
  v.rededge3_reflectance,
  v.narrow_nir_reflectance,
  v.swir16_reflectance,
  v.swir22_reflectance,
  v.relative_score,
  v.relative_feature_count AS cell_relative_feature_count,
  v.is_valid
FROM cell_date_values v
JOIN satellite_dates d ON d.date_id = v.date_id
JOIN performance_crop_years p ON p.season_id = d.season_id
JOIN rotation_records r ON r.season_id = d.season_id
JOIN fields f ON f.field_code = v.field_code
JOIN spatial_cells c
  ON c.field_code = v.field_code AND c.cell_index = v.cell_index;

CREATE VIEW v_cell_radar_analysis AS
SELECT
  v.field_code,
  f.field_name,
  v.cell_index,
  c.easting_m,
  c.northing_m,
  c.longitude,
  c.latitude,
  d.observation_date,
  d.scene_id,
  d.product_type,
  d.native_support_metres,
  d.quality_mask,
  v.vv_db,
  v.vh_db,
  v.vv_minus_vh_db,
  v.vh_vv_ratio,
  v.is_valid
FROM cell_radar_values v
JOIN radar_dates d ON d.radar_date_id = v.radar_date_id
JOIN fields f ON f.field_code = v.field_code
JOIN spatial_cells c
  ON c.field_code = v.field_code AND c.cell_index = v.cell_index;

CREATE VIEW v_cell_landsat_analysis AS
SELECT
  v.field_code,
  f.field_name,
  v.cell_index,
  c.easting_m,
  c.northing_m,
  c.longitude,
  c.latitude,
  d.observation_date,
  d.scene_id,
  d.platform,
  d.wrs_path,
  d.wrs_row,
  d.native_support_metres,
  v.raw_ndvi,
  v.raw_evi2,
  v.raw_ndwi,
  v.red_reflectance,
  v.nir_reflectance,
  v.swir16_reflectance,
  v.swir22_reflectance,
  v.relative_score,
  v.is_valid
FROM cell_landsat_values v
JOIN landsat_dates d ON d.landsat_date_id = v.landsat_date_id
JOIN fields f ON f.field_code = v.field_code
JOIN spatial_cells c
  ON c.field_code = v.field_code AND c.cell_index = v.cell_index;

CREATE VIEW v_cell_same_crop_persistence AS
SELECT
  field_code,
  field_name,
  cell_index,
  crop_code,
  COUNT(relative_score) AS crop_year_count,
  SUM(relative_score * quality_weight) / NULLIF(SUM(quality_weight), 0)
    AS quality_weighted_relative_score,
  AVG(within_crop_year_variability) AS mean_within_crop_year_variability
FROM v_cell_crop_year_analysis
WHERE relative_score IS NOT NULL
GROUP BY field_code, field_name, cell_index, crop_code;

CREATE VIEW v_cell_cross_crop_persistence AS
SELECT
  field_code,
  field_name,
  cell_index,
  COUNT(relative_score) AS crop_year_count,
  COUNT(DISTINCT crop_code) AS crop_count,
  SUM(relative_score * quality_weight) / NULLIF(SUM(quality_weight), 0)
    AS quality_weighted_relative_score,
  AVG(within_crop_year_variability) AS mean_within_crop_year_variability
FROM v_cell_crop_year_analysis
WHERE relative_score IS NOT NULL
GROUP BY field_code, field_name, cell_index;
"""


DICTIONARY_ROWS = [
    (
        "rotation_records",
        "*",
        "One record per stable field and harvest year, including derived preceding-crop and rotation metrics.",
        None,
        "Active farm crop-history export; missing management columns remain NULL.",
    ),
    (
        "rotation_records",
        "harvest_year",
        "The crop harvest year. Winter crops are named by harvest year.",
        "year",
        "Active farm crop-history export.",
    ),
    (
        "rotation_records",
        "rotation_position",
        "Inspectable first-cereal, second/consecutive-cereal, break, grass, fallow or unknown position.",
        None,
        "Derived from source labels and the preceding crop.",
    ),
    (
        "spatial_cells",
        "*",
        "One retained Sentinel grid cell per mapped field, aligned on the common farm grid.",
        None,
        "Sentinel-2 10 m grid and inward-buffered field mask.",
    ),
    (
        "spatial_cells",
        "edge_reliability",
        "Reliability multiplier for the retained cell after the 10 m inward boundary buffer.",
        "0–1",
        "Performance model edge treatment.",
    ),
    (
        "cell_date_values",
        "raw_ndvi",
        "Cloud-masked raw NDVI for one field cell and satellite date.",
        "-1 to 1",
        "Sentinel-2 Level-2A B04/B08 with SCL mask.",
    ),
    (
        "cell_date_values",
        "raw_evi2",
        "Cloud-masked EVI2 at native 10 m support.",
        "-1 to 1",
        "Sentinel-2 Level-2A B04/B08 with SCL mask.",
    ),
    (
        "cell_date_values",
        "raw_ndre",
        "Cloud-masked NDRE calculated at native 20 m support; repeated rows share the same native value where shown on the 10 m display grid.",
        "-1 to 1",
        "Sentinel-2 Level-2A B05/B8A with SCL mask.",
    ),
    (
        "cell_date_values",
        "raw_ndwi",
        "Narrow-NIR/SWIR water-status index calculated at native 20 m support; also known as NDMI in this band configuration.",
        "-1 to 1",
        "Sentinel-2 Level-2A B8A/B11 with SCL mask.",
    ),
    (
        "cell_date_values",
        "*_reflectance",
        "Cloud-masked Sentinel-2 red-edge, narrow-NIR and SWIR surface reflectance at native 20 m support.",
        "0–1 reflectance",
        "Sentinel-2 Level-2A with per-asset STAC scale and offset.",
    ),
    (
        "cell_date_values",
        "relative_score",
        "Equal average of the available NDVI, EVI2, NDRE and NDWI tied within-field percentile ranks for the same date.",
        "0–100",
        "Satellite Productivity Detection within-field normalisation.",
    ),
    (
        "performance_crop_years",
        "peak_at_observation_boundary",
        "One when the estimated peak is the first or last observed trajectory day; interpret peak timing cautiously.",
        "0/1",
        "Multi-index phenology derivation.",
    ),
    (
        "cell_crop_year_values",
        "relative_score",
        "Stage- and coverage-weighted combination of within-field date ranks for one crop year.",
        "0–100",
        "Satellite Productivity Detection persistent-performance model.",
    ),
    (
        "cell_radar_values",
        "*",
        "Supplementary Sentinel-1 radar features. Native 30 m values may repeat across joined 10 m display cells and are not silently promoted to 10 m evidence.",
        None,
        "NASA OPERA L2 RTC-S1 linear gamma0, converted to dB and polarisation ratios.",
    ),
    (
        "cell_landsat_values",
        "*",
        "Separate Landsat historical evidence at native 30 m support. Values may repeat across joined 10 m display cells and are not fused into the Sentinel-2 performance score.",
        None,
        "Landsat Collection 2 Level-2 surface reflectance via Microsoft Planetary Computer.",
    ),
    (
        "v_cell_same_crop_persistence",
        "*",
        "Quality-weighted persistence grouped by cell and crop; preferred for like-for-like crop comparison.",
        None,
        "Derived only from already normalised crop-year cell scores.",
    ),
    (
        "v_cell_cross_crop_persistence",
        "*",
        "Quality-weighted cross-crop persistence with crop and crop-year counts exposed.",
        None,
        "Different crops are combined only after within-field date and crop-year normalisation.",
    ),
    (
        "weather_daily",
        "*",
        "Daily farm-centroid reanalysis weather. It is context, not within-field spatial weather.",
        None,
        "Open-Meteo ERA5 and ERA5-Land.",
    ),
]


def configure_connection(connection: sqlite3.Connection):
    connection.execute("PRAGMA journal_mode = OFF")
    connection.execute("PRAGMA synchronous = OFF")
    connection.execute("PRAGMA temp_store = MEMORY")
    connection.execute("PRAGMA cache_size = -200000")
    connection.execute("PRAGMA foreign_keys = ON")


def insert_fields_and_rotation(
    connection: sqlite3.Connection,
    history: list[dict],
    boundaries: dict,
    performance_season_ids: set[str],
):
    rows_by_field = defaultdict(list)
    for row in history:
        rows_by_field[str(row["fieldCode"])].append(row)
    fields_with_arable = {
        field_code
        for field_code, rows in rows_by_field.items()
        if any((row.get("cropNormalised") or "") in ARABLE_CROPS for row in rows)
    }
    boundary_by_code = {
        str(feature["properties"]["field_code"]): feature
        for feature in boundaries["features"]
    }

    for field_code, rows in sorted(rows_by_field.items(), key=lambda item: int(item[0])):
        ordered = sorted(rows, key=lambda row: int(row["year"]))
        latest = ordered[-1]
        boundary = boundary_by_code.get(field_code)
        properties = boundary["properties"] if boundary else {}
        connection.execute(
            """
            INSERT INTO fields VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                field_code,
                latest["field"],
                latest.get("hectares"),
                latest.get("acres"),
                ordered[0]["year"],
                ordered[-1]["year"],
                int(boundary is not None),
                properties.get("uuid"),
                properties.get("boundary_version"),
                properties.get("match_type"),
                json.dumps(boundary["geometry"], separators=(",", ":"))
                if boundary
                else None,
                json.dumps(properties, separators=(",", ":")) if boundary else None,
            ),
        )

        prior = []
        known_codes = []
        for row in ordered:
            crop_code = canonical_crop(
                row.get("cropNormalised", ""),
                field_code in fields_with_arable,
            )
            crop_name, crop_group, season_type = crop_details(crop_code)
            previous_crop_code = prior[-1]["crop_code"] if prior else "unknown"
            current = {
                "harvest_year": int(row["year"]),
                "crop_code": crop_code,
                "crop_group": crop_group,
                "season_type": season_type,
            }
            same_crop = years_since(
                prior,
                current["harvest_year"],
                lambda record: record["crop_code"] == crop_code,
            )
            since_break = years_since(
                prior,
                current["harvest_year"],
                lambda record: record["crop_group"] in BREAK_GROUPS,
            )
            since_grass = years_since(
                prior,
                current["harvest_year"],
                lambda record: record["crop_code"] == "temporary_grass",
            )
            consecutive_cereals = (
                consecutive_count(current, prior, "crop_group", "cereal")
                if crop_group == "cereal"
                else 0
            )
            consecutive_autumn = (
                consecutive_count(current, prior, "season_type", "winter")
                if season_type == "winter"
                else 0
            )
            season_id = f"{FARM_ID}-{field_code}-{row['year']}"
            boundary_version = (
                f"{BOUNDARY_VERSION_PREFIX}:{row['boundaryUuid']}"
                if row.get("boundaryUuid")
                else (
                    f"No {CURRENT_HARVEST_YEAR} boundary supplied"
                    if int(row["year"]) == CURRENT_HARVEST_YEAR
                    else "Historical boundary not supplied"
                )
            )
            notes = (
                f"Source crop label: {row['crop']}."
                if row.get("crop")
                and row.get("crop") != row.get("cropNormalised")
                else None
            )
            connection.execute(
                """
                INSERT INTO rotation_records VALUES (
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    season_id,
                    field_code,
                    row["field"],
                    row["fieldYear"],
                    row["year"],
                    row.get("crop") or None,
                    row.get("cropNormalised") or None,
                    crop_code,
                    crop_name,
                    crop_group,
                    season_type,
                    row.get("cropSimplified") or None,
                    row.get("variety") or None,
                    row.get("cropVariety") or None,
                    previous_crop_code,
                    rotation_position(
                        row.get("crop", ""),
                        crop_code,
                        crop_group,
                        previous_crop_code,
                    ),
                    same_crop,
                    since_break,
                    since_grass,
                    None,
                    consecutive_cereals,
                    consecutive_autumn,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    notes,
                    weather_window(season_type, crop_group),
                    row.get("hectares"),
                    row.get("acres"),
                    row.get("boundaryUuid"),
                    row.get("boundaryName"),
                    boundary_version,
                    int(season_id in performance_season_ids),
                ),
            )
            prior.append(current)
            if crop_group != "unknown":
                known_codes.append(crop_code)

        counts = defaultdict(int)
        for crop_code in known_codes:
            counts[crop_code] += 1
        proportions = [
            count / len(known_codes) for count in counts.values()
        ] if known_codes else []
        diversity = (
            -sum(proportion * math.log(proportion) for proportion in proportions)
            if proportions
            else None
        )
        spring_count = sum(
            1 for crop_code in known_codes if crop_details(crop_code)[2] == "spring"
        )
        winter_count = sum(
            1 for crop_code in known_codes if crop_details(crop_code)[2] == "winter"
        )
        connection.execute(
            "INSERT INTO field_rotation_metrics VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                field_code,
                len(ordered),
                len(known_codes),
                len(counts),
                spring_count / len(known_codes) if known_codes else None,
                winter_count / len(known_codes) if known_codes else None,
                diversity,
            ),
        )


def insert_weather(
    connection: sqlite3.Connection,
    weather_summary: dict,
    daily_weather: dict,
):
    for year, windows in weather_summary["harvestYears"].items():
        for window_name, row in windows.items():
            connection.execute(
                """
                INSERT INTO weather_windows VALUES (
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    int(year),
                    window_name,
                    row.get("startDate"),
                    row.get("endDate"),
                    row.get("lastAvailableDate"),
                    row.get("coverage"),
                    int(bool(row.get("partial"))),
                    row.get("precipitationMm"),
                    row.get("et0Mm"),
                    row.get("waterBalanceMm"),
                    row.get("meanTemperatureC"),
                    row.get("gddBase5"),
                    row.get("surfaceSoilMoisture"),
                    row.get("rootZoneSoilMoisture"),
                    row.get("deepSoilMoisture"),
                    row.get("waterBalanceZ"),
                    row.get("temperatureZ"),
                    row.get("moistureClass"),
                    row.get("temperatureClass"),
                ),
            )
    connection.executemany(
        "INSERT INTO weather_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                row["date"],
                row.get("temperature_2m_mean"),
                row.get("temperature_2m_min"),
                row.get("temperature_2m_max"),
                row.get("soil_moisture_0_to_7cm_mean"),
                row.get("soil_moisture_7_to_28cm_mean"),
                row.get("soil_moisture_28_to_100cm_mean"),
                row.get("precipitation_sum"),
                row.get("et0_fao_evapotranspiration"),
            )
            for row in daily_weather["daily"]
        ],
    )


def insert_performance(
    connection: sqlite3.Connection,
    performance_summary: dict,
    grid: dict,
) -> tuple[int, int, int]:
    transform = make_coordinate_transformer(grid["projection"])
    origin_x, pixel_width, _, origin_y, _, pixel_height = grid["geotransform"]
    crop_year_value_count = 0
    date_value_count = 0
    date_id = 0

    for field_number, field in enumerate(performance_summary["fields"], start=1):
        payload_path = REPOSITORY_ROOT / "public" / field["url"].lstrip("/")
        payload = load_json(payload_path)
        field_code = str(payload["fieldCode"])
        column_offset, row_offset = payload["gridOffset"]

        cell_rows = []
        for cell_index, (column, row, reliability) in enumerate(payload["cells"]):
            farm_column = column_offset + column
            farm_row = row_offset + row
            easting = origin_x + (farm_column + 0.5) * pixel_width
            northing = origin_y + (farm_row + 0.5) * pixel_height
            longitude = latitude = None
            if transform is not None:
                longitude, latitude, _ = transform.TransformPoint(easting, northing)
            cell_rows.append(
                (
                    field_code,
                    cell_index,
                    column,
                    row,
                    farm_column,
                    farm_row,
                    easting,
                    northing,
                    longitude,
                    latitude,
                    reliability,
                )
            )
        connection.executemany(
            "INSERT INTO spatial_cells VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            cell_rows,
        )

        for season in payload["seasons"]:
            phenology = season.get("phenology", {})
            connection.execute(
                """
                INSERT INTO performance_crop_years (
                  season_id, field_code, harvest_year, model_crop_code,
                  crop_group, season_type, evidence_tier, evidence_reason,
                  coverage_days, window_start, window_end,
                  window_confidence, window_method, boundary_confidence, data_quality,
                  quality_weight, weather_class, water_balance_mm,
                  water_balance_z, temperature_z, gdd_base_5,
                  root_zone_soil_moisture, usable_date_count,
                  phenology_method, phenology_confidence,
                  phenology_observation_count, trajectory_coverage_start,
                  trajectory_coverage_end, greenup_date,
                  spring_growth_rate_per_day, peak_canopy_date,
                  peak_at_observation_boundary,
                  maximums_json, area_under_curve_index_days, area_under_curve_mean,
                  high_canopy_duration_days, senescence_onset_date,
                  senescence_rate_per_day, late_season_persistence,
                  late_season_gap_days,
                  normal_curve_comparison_count, normal_curve_rmse,
                  normal_curve_signed_deviation
                ) VALUES (
                  :season_id, :field_code, :harvest_year, :model_crop_code,
                  :crop_group, :season_type, :evidence_tier, :evidence_reason,
                  :coverage_days, :window_start, :window_end,
                  :window_confidence, :window_method, :boundary_confidence, :data_quality,
                  :quality_weight, :weather_class, :water_balance_mm,
                  :water_balance_z, :temperature_z, :gdd_base_5,
                  :root_zone_soil_moisture, :usable_date_count,
                  :phenology_method, :phenology_confidence,
                  :phenology_observation_count, :trajectory_coverage_start,
                  :trajectory_coverage_end, :greenup_date,
                  :spring_growth_rate_per_day, :peak_canopy_date,
                  :peak_at_observation_boundary,
                  :maximums_json, :area_under_curve_index_days, :area_under_curve_mean,
                  :high_canopy_duration_days, :senescence_onset_date,
                  :senescence_rate_per_day, :late_season_persistence,
                  :late_season_gap_days,
                  :normal_curve_comparison_count, :normal_curve_rmse,
                  :normal_curve_signed_deviation
                )
                """,
                {
                    "season_id": season["id"],
                    "field_code": field_code,
                    "harvest_year": season["harvestYear"],
                    "model_crop_code": season["cropCode"],
                    "crop_group": season["cropGroup"],
                    "season_type": season["seasonType"],
                    "evidence_tier": season.get("evidenceTier", "full-season"),
                    "evidence_reason": season.get("evidenceReason"),
                    "coverage_days": season.get("coverageDays"),
                    "window_start": season["windowStart"],
                    "window_end": season["windowEnd"],
                    "window_confidence": season["windowConfidence"],
                    "window_method": season["windowMethod"],
                    "boundary_confidence": season.get("boundaryConfidence", 0.85),
                    "data_quality": season["dataQuality"],
                    "quality_weight": season["qualityWeight"],
                    "weather_class": season["weatherClass"],
                    "water_balance_mm": season.get("waterBalanceMm"),
                    "water_balance_z": season.get("waterBalanceZ"),
                    "temperature_z": season.get("temperatureZ"),
                    "gdd_base_5": season.get("gddBase5"),
                    "root_zone_soil_moisture": season.get("soilMoisture"),
                    "usable_date_count": len(season["dates"]),
                    "phenology_method": phenology.get("method"),
                    "phenology_confidence": phenology.get("confidence"),
                    "phenology_observation_count": phenology.get(
                        "observationCount"
                    ),
                    "trajectory_coverage_start": phenology.get(
                        "trajectoryCoverageStart"
                    ),
                    "trajectory_coverage_end": phenology.get(
                        "trajectoryCoverageEnd"
                    ),
                    "greenup_date": phenology.get("greenupDate"),
                    "spring_growth_rate_per_day": phenology.get(
                        "springGrowthRatePerDay"
                    ),
                    "peak_canopy_date": phenology.get("peakCanopyDate"),
                    "peak_at_observation_boundary": (
                        int(bool(phenology["peakAtObservationBoundary"]))
                        if "peakAtObservationBoundary" in phenology
                        else None
                    ),
                    "maximums_json": (
                        json.dumps(phenology["maximums"], sort_keys=True)
                        if phenology.get("maximums")
                        else None
                    ),
                    "area_under_curve_index_days": phenology.get(
                        "areaUnderCurveIndexDays"
                    ),
                    "area_under_curve_mean": phenology.get("areaUnderCurveMean"),
                    "high_canopy_duration_days": phenology.get(
                        "highCanopyDurationDays"
                    ),
                    "senescence_onset_date": phenology.get(
                        "senescenceOnsetDate"
                    ),
                    "senescence_rate_per_day": phenology.get(
                        "senescenceRatePerDay"
                    ),
                    "late_season_persistence": phenology.get(
                        "lateSeasonPersistence"
                    ),
                    "late_season_gap_days": phenology.get("lateSeasonGapDays"),
                    "normal_curve_comparison_count": phenology.get(
                        "normalCurveComparisonCount"
                    ),
                    "normal_curve_rmse": phenology.get("normalCurveRmse"),
                    "normal_curve_signed_deviation": phenology.get(
                        "normalCurveSignedDeviation"
                    ),
                },
            )
            crop_year_rows = [
                (
                    season["id"],
                    field_code,
                    cell_index,
                    season["scores"][cell_index],
                    season["withinSeasonVariability"][cell_index],
                    season["observationCounts"][cell_index],
                )
                for cell_index in range(len(payload["cells"]))
            ]
            connection.executemany(
                "INSERT INTO cell_crop_year_values VALUES (?, ?, ?, ?, ?, ?)",
                crop_year_rows,
            )
            crop_year_value_count += len(crop_year_rows)

            for observation in season["dates"]:
                date_id += 1
                date_path = (
                    REPOSITORY_ROOT
                    / "public"
                    / observation["cellUrl"].lstrip("/")
                )
                date_payload = load_json(date_path)
                feature_values = date_payload.get(
                    "features",
                    {"ndvi": date_payload["ndvi"]},
                )
                relative_values = date_payload["relativeScores"]
                empty_values = [None] * len(payload["cells"])
                feature_columns = {
                    name: feature_values.get(name, empty_values)
                    for name in (
                        "ndvi",
                        "evi2",
                        "ndre",
                        "ndwi",
                        "rededge1",
                        "rededge2",
                        "rededge3",
                        "nir08",
                        "swir16",
                        "swir22",
                    )
                }
                if (
                    len(relative_values) != len(payload["cells"])
                    or any(
                        len(values) != len(payload["cells"])
                        for values in feature_columns.values()
                    )
                ):
                    raise ValueError(
                        f"Cell alignment failed for {date_path}: "
                        f"{len(relative_values)} relative, "
                        f"{len(payload['cells'])} field cells"
                    )
                relative_feature_counts = date_payload.get(
                    "relativeFeatureCount",
                    [
                        int(value is not None)
                        for value in feature_columns["ndvi"]
                    ],
                )
                valid_count = sum(
                    value is not None for value in relative_values
                )
                connection.execute(
                    """
                    INSERT INTO satellite_dates (
                      date_id, season_id, field_code, harvest_year,
                      model_crop_code, observation_date, scene_id, stage,
                      stage_estimated, stage_method, trajectory_value,
                      relative_season_position, gdd_base_5_from_window_start,
                      median_ndvi, median_evi2, median_ndre, median_ndwi,
                      clear_fraction, native_20m_clear_fraction,
                      relative_feature_count, stage_weight,
                      observation_weight, valid_cell_count, source_file, method
                    ) VALUES (
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?, ?
                    )
                    """,
                    (
                        date_id,
                        season["id"],
                        field_code,
                        season["harvestYear"],
                        season["cropCode"],
                        observation["date"],
                        date_payload.get("sceneId"),
                        observation["stage"],
                        int(bool(observation["stageEstimated"])),
                        observation.get("stageMethod"),
                        observation.get("trajectoryValue"),
                        observation["relativeSeasonPosition"],
                        observation.get("gddBase5FromWindowStart"),
                        observation.get("medianNdvi"),
                        observation.get("medianEvi2"),
                        observation.get("medianNdre"),
                        observation.get("medianNdwi"),
                        observation["clearFraction"],
                        observation.get("native20mClearFraction"),
                        observation.get("relativeFeatureCount"),
                        observation["stageWeight"],
                        observation["observationWeight"],
                        valid_count,
                        str(date_path.relative_to(REPOSITORY_ROOT)),
                        date_payload["method"],
                    ),
                )
                date_rows = [
                    (
                        date_id,
                        field_code,
                        cell_index,
                        feature_columns["ndvi"][cell_index],
                        feature_columns["evi2"][cell_index],
                        feature_columns["ndre"][cell_index],
                        feature_columns["ndwi"][cell_index],
                        feature_columns["rededge1"][cell_index],
                        feature_columns["rededge2"][cell_index],
                        feature_columns["rededge3"][cell_index],
                        feature_columns["nir08"][cell_index],
                        feature_columns["swir16"][cell_index],
                        feature_columns["swir22"][cell_index],
                        relative_values[cell_index],
                        relative_feature_counts[cell_index],
                        int(
                            relative_values[cell_index] is not None
                        ),
                    )
                    for cell_index in range(len(payload["cells"]))
                ]
                connection.executemany(
                    """
                    INSERT INTO cell_date_values VALUES (
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                    """,
                    date_rows,
                )
                date_value_count += len(date_rows)

        print(
            f"[{field_number:02d}/{len(performance_summary['fields'])}] "
            f"{payload['fieldName']}: {len(payload['cells']):,} cells, "
            f"{len(payload['seasons'])} crop years",
            flush=True,
        )
    return crop_year_value_count, date_id, date_value_count


def native_cell_index(
    farm_column: int,
    farm_row: int,
    display_geotransform: list[float],
    native_geotransform: list[float],
) -> tuple[int, int]:
    """Join a display-cell centre to a coarser native analysis grid."""
    easting = display_geotransform[0] + (farm_column + 0.5) * display_geotransform[1]
    northing = display_geotransform[3] + (farm_row + 0.5) * display_geotransform[5]
    native_column = math.floor(
        (easting - native_geotransform[0]) / native_geotransform[1]
    )
    native_row = math.floor(
        (native_geotransform[3] - northing) / abs(native_geotransform[5])
    )
    return native_row, native_column


def local_scene_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPOSITORY_ROOT / path


def insert_landsat(
    connection: sqlite3.Connection,
    summary_path: Path,
    display_grid: dict,
) -> tuple[int, int]:
    if not summary_path.exists():
        return 0, 0
    summary = load_json(summary_path)
    if not summary.get("scenes"):
        return 0, 0
    native_geotransform = summary["grid"]["geotransform"]
    cells = connection.execute(
        """
        SELECT field_code, cell_index, farm_column, farm_row
        FROM spatial_cells
        ORDER BY field_code, cell_index
        """
    ).fetchall()
    value_count = 0
    feature_names = (
        "ndvi",
        "evi2",
        "ndwi",
        "red",
        "nir08",
        "swir16",
        "swir22",
        "relative_score",
    )
    for landsat_date_id, scene in enumerate(summary["scenes"], start=1):
        scene_path = local_scene_path(scene["sceneFile"])
        with np.load(scene_path) as arrays:
            features = {
                name: arrays[name].astype(np.float32)
                for name in feature_names
            }
        connection.execute(
            "INSERT INTO landsat_dates VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                landsat_date_id,
                scene["date"],
                scene["id"],
                scene["platform"],
                scene.get("path"),
                scene.get("row"),
                scene.get("nativeSupportMetres", 30),
                repository_display_path(scene_path),
            ),
        )
        rows = []
        for field_code, cell_index, farm_column, farm_row in cells:
            native_row, native_column = native_cell_index(
                farm_column,
                farm_row,
                display_grid["geotransform"],
                native_geotransform,
            )
            values = [
                feature[native_row, native_column]
                if 0 <= native_row < feature.shape[0]
                and 0 <= native_column < feature.shape[1]
                else np.nan
                for feature in features.values()
            ]
            rows.append(
                (
                    landsat_date_id,
                    field_code,
                    cell_index,
                    *[
                        round(float(value), 6) if np.isfinite(value) else None
                        for value in values
                    ],
                    int(all(np.isfinite(value) for value in values[:3])),
                )
            )
        connection.executemany(
            "INSERT INTO cell_landsat_values VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        value_count += len(rows)
    return len(summary["scenes"]), value_count


def insert_radar(
    connection: sqlite3.Connection,
    summary_path: Path,
    display_grid: dict,
) -> tuple[int, int]:
    if not summary_path.exists():
        return 0, 0
    summary = load_json(summary_path)
    if summary.get("status") != "available":
        return 0, 0
    native_geotransform = summary["grid"]["geotransform"]
    cells = connection.execute(
        """
        SELECT field_code, cell_index, farm_column, farm_row
        FROM spatial_cells
        ORDER BY field_code, cell_index
        """
    ).fetchall()
    radar_value_count = 0
    for radar_date_id, scene in enumerate(summary.get("scenes", []), start=1):
        scene_path = local_scene_path(scene["sceneFile"])
        with np.load(scene_path) as arrays:
            features = {
                name: arrays[name].astype(np.float32)
                for name in (
                    "vv_db",
                    "vh_db",
                    "vv_minus_vh_db",
                    "vh_vv_ratio",
                )
            }
        connection.execute(
            "INSERT INTO radar_dates VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                radar_date_id,
                scene["date"],
                scene["id"],
                scene["productType"],
                scene["nativeSupportMetres"],
                scene.get("qualityMask"),
                repository_display_path(scene_path),
            ),
        )
        value_rows = []
        for field_code, cell_index, farm_column, farm_row in cells:
            native_row, native_column = native_cell_index(
                farm_column,
                farm_row,
                display_grid["geotransform"],
                native_geotransform,
            )
            values = [
                feature[native_row, native_column]
                if 0 <= native_row < feature.shape[0]
                and 0 <= native_column < feature.shape[1]
                else np.nan
                for feature in features.values()
            ]
            valid = all(np.isfinite(value) for value in values)
            value_rows.append(
                (
                    radar_date_id,
                    field_code,
                    cell_index,
                    *[
                        round(float(value), 4) if np.isfinite(value) else None
                        for value in values
                    ],
                    int(valid),
                )
            )
        connection.executemany(
            "INSERT INTO cell_radar_values VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            value_rows,
        )
        radar_value_count += len(value_rows)
    return len(summary.get("scenes", [])), radar_value_count


def validate_database(connection: sqlite3.Connection, expected: dict) -> dict:
    table_counts = {
        table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in (
            "fields",
            "rotation_records",
            "weather_windows",
            "weather_daily",
            "spatial_cells",
            "performance_crop_years",
            "satellite_dates",
            "cell_crop_year_values",
            "cell_date_values",
            "landsat_dates",
            "cell_landsat_values",
            "radar_dates",
            "cell_radar_values",
        )
    }
    for table, count in expected.items():
        if table_counts[table] != count:
            raise ValueError(
                f"{table} has {table_counts[table]:,} rows; expected {count:,}"
            )
    foreign_key_errors = connection.execute("PRAGMA foreign_key_check").fetchall()
    if foreign_key_errors:
        raise ValueError(f"Foreign-key validation failed: {foreign_key_errors[:5]}")
    invalid_indices = connection.execute(
        """
        SELECT COUNT(*) FROM cell_date_values
        WHERE (raw_ndvi IS NOT NULL AND (raw_ndvi < -1 OR raw_ndvi > 1))
           OR (raw_evi2 IS NOT NULL AND (raw_evi2 < -1 OR raw_evi2 > 1))
           OR (raw_ndre IS NOT NULL AND (raw_ndre < -1 OR raw_ndre > 1))
           OR (raw_ndwi IS NOT NULL AND (raw_ndwi < -1 OR raw_ndwi > 1))
        """
    ).fetchone()[0]
    invalid_relative = connection.execute(
        """
        SELECT COUNT(*) FROM cell_date_values
        WHERE relative_score IS NOT NULL
          AND (relative_score < 0 OR relative_score > 100)
        """
    ).fetchone()[0]
    if invalid_indices or invalid_relative:
        raise ValueError(
            f"Value-range validation failed: {invalid_indices} index values, "
            f"{invalid_relative} relative"
        )
    return table_counts


def build_database(output_path: Path) -> dict:
    history = load_json(HISTORY_PATH)
    boundaries = load_json(BOUNDARIES_PATH)
    weather_summary = load_json(WEATHER_SUMMARY_PATH)
    daily_weather = load_json(DAILY_WEATHER_PATH)
    grid = load_json(GRID_PATH)
    performance_summary = load_json(PERFORMANCE_SUMMARY_PATH)
    if performance_summary.get("methodVersion") != "persistent-performance-v4-evidence-tiers":
        raise ValueError(
            "Performance outputs predate the evidence-tier method; rebuild performance "
            "evidence before creating the analysis database."
        )
    # Use exact model season IDs rather than assuming every year in the range exists.
    performance_season_ids = set()
    for field in performance_summary["fields"]:
        payload_path = REPOSITORY_ROOT / "public" / field["url"].lstrip("/")
        performance_season_ids.update(
            season["id"] for season in load_json(payload_path)["seasons"]
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = tempfile.NamedTemporaryFile(
        prefix=f"{output_path.stem}-",
        suffix=".tmp.sqlite",
        dir=output_path.parent,
        delete=False,
    )
    temporary_path = Path(temporary.name)
    temporary.close()

    try:
        connection = sqlite3.connect(temporary_path)
        configure_connection(connection)
        connection.executescript(SCHEMA)
        connection.executemany(
            "INSERT INTO crop_taxonomy VALUES (?, ?, ?, ?)",
            [
                (crop_code, *details)
                for crop_code, details in CROP_TAXONOMY.items()
            ],
        )
        insert_fields_and_rotation(
            connection,
            history,
            boundaries,
            performance_season_ids,
        )
        insert_weather(connection, weather_summary, daily_weather)
        crop_year_values, date_count, date_values = insert_performance(
            connection,
            performance_summary,
            grid,
        )
        landsat_date_count, landsat_value_count = insert_landsat(
            connection,
            LANDSAT_SUMMARY_PATH,
            grid,
        )
        radar_date_count, radar_value_count = insert_radar(
            connection,
            RADAR_SUMMARY_PATH,
            grid,
        )
        connection.executemany(
            "INSERT INTO data_dictionary VALUES (?, ?, ?, ?, ?)",
            DICTIONARY_ROWS,
        )
        generated_at = datetime.now(timezone.utc).isoformat()
        metadata = {
            "database_version": "3",
            "generated_at": generated_at,
            "farm": FARM_NAME,
            "farm_id": FARM_ID,
            "crs": FARM_CRS,
            "pixel_size_metres": str(grid["geotransform"][1]),
            "crop_effect_control": (
                "Raw satellite indices are never combined directly across "
                "dates or crops. Each index is first ranked within field/date; "
                "the available index ranks are equally averaged; crop-year "
                "values combine those date ranks; cross-crop views combine "
                "only crop-year relative scores."
            ),
            "native_resolution_control": (
                "NDVI and EVI2 retain 10 m support. NDRE, NDWI, red-edge and "
                "SWIR values retain 20 m analytical support and are only "
                "replicated for the 10 m display/cell join."
            ),
            "source_history": repository_display_path(HISTORY_PATH),
            "source_boundaries": repository_display_path(BOUNDARIES_PATH),
            "source_weather": repository_display_path(DAILY_WEATHER_PATH),
            "source_performance": repository_display_path(PERFORMANCE_SUMMARY_PATH),
            "source_radar": (
                repository_display_path(RADAR_SUMMARY_PATH)
                if RADAR_SUMMARY_PATH.exists()
                else "not ingested"
            ),
            "source_landsat": (
                repository_display_path(LANDSAT_SUMMARY_PATH)
                if LANDSAT_SUMMARY_PATH.exists()
                else "not ingested"
            ),
            "landsat_role": (
                "Separate long-history optical evidence at native 30 m support; "
                "not fused into the Sentinel-2 performance score."
            ),
            "radar_role": (
                "Supplementary OPERA RTC-S1 evidence at native 30 m support; "
                "not included in the optical composite unless an explicit "
                "model documents that combination."
            ),
        }
        connection.executemany(
            "INSERT INTO metadata VALUES (?, ?)",
            metadata.items(),
        )
        connection.executescript(INDEXES_AND_VIEWS)
        expected = {
            "fields": len({str(row["fieldCode"]) for row in history}),
            "rotation_records": len(history),
            "weather_windows": sum(
                len(windows)
                for windows in weather_summary["harvestYears"].values()
            ),
            "weather_daily": len(daily_weather["daily"]),
            "spatial_cells": sum(
                field["cellCount"] for field in performance_summary["fields"]
            ),
            "performance_crop_years": performance_summary["seasonCount"],
            "satellite_dates": performance_summary["individualDateCount"],
            "cell_crop_year_values": crop_year_values,
            "cell_date_values": date_values,
            "landsat_dates": landsat_date_count,
            "cell_landsat_values": landsat_value_count,
            "radar_dates": radar_date_count,
            "cell_radar_values": radar_value_count,
        }
        table_counts = validate_database(connection, expected)
        connection.execute(
            "INSERT INTO metadata VALUES (?, ?)",
            ("table_row_counts", json.dumps(table_counts, sort_keys=True)),
        )
        connection.execute("PRAGMA user_version = 3")
        connection.execute("ANALYZE")
        connection.execute("PRAGMA optimize")
        connection.commit()
        connection.close()
        os.replace(temporary_path, output_path)
        return table_counts
    except Exception:
        if temporary_path.exists():
            temporary_path.unlink()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"SQLite output path (default: {DEFAULT_OUTPUT})",
    )
    args = parser.parse_args()
    output = args.output.resolve()
    counts = build_database(output)
    size_mb = output.stat().st_size / (1024 * 1024)
    print(f"\nCreated {output}")
    print(f"Size: {size_mb:.1f} MiB")
    for table, count in counts.items():
        print(f"  {table}: {count:,}")


if __name__ == "__main__":
    main()
