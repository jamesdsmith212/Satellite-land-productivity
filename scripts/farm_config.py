"""Resolve the active local farm workspace without embedding farm identity."""

from __future__ import annotations

import json
import os
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = REPOSITORY_ROOT / "local-data" / "active-farm.json"
DEMO_WORKSPACE = REPOSITORY_ROOT / "fixtures" / "demo-farm"


def _resolve_from_repository(value: str | Path) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else REPOSITORY_ROOT / path


def active_config_path() -> Path:
    configured = os.environ.get("FARM_CONFIG")
    return _resolve_from_repository(configured) if configured else DEFAULT_CONFIG_PATH


def active_workspace() -> Path:
    config_path = active_config_path()
    if not config_path.exists():
        return DEMO_WORKSPACE
    config = json.loads(config_path.read_text(encoding="utf-8"))
    workspace = config.get("workspace")
    if not workspace:
        raise ValueError(f"Farm config has no workspace: {config_path}")
    return _resolve_from_repository(workspace).resolve()


def load_farm_profile() -> dict:
    profile_path = active_workspace() / "profile.json"
    if not profile_path.exists():
        raise FileNotFoundError(f"Farm profile is missing: {profile_path}")
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    for key in ("id", "name", "currentHarvestYear", "boundaryVersionPrefix", "crs"):
        if key not in profile:
            raise ValueError(f"Farm profile is missing {key}: {profile_path}")
    return profile


WORKSPACE = active_workspace()
PROFILE = load_farm_profile()
FARM_ID = str(PROFILE["id"])
FARM_NAME = str(PROFILE["name"])
CURRENT_HARVEST_YEAR = int(PROFILE["currentHarvestYear"])
BOUNDARY_VERSION_PREFIX = str(PROFILE["boundaryVersionPrefix"])
FARM_CRS = str(PROFILE["crs"])

SOURCE_DIR = WORKSPACE / "source"
DERIVED_DIR = WORKSPACE / "derived"
PUBLIC_DIR = WORKSPACE / "public"
HISTORY_PATH = SOURCE_DIR / "history.json"
IMPORT_REPORT_PATH = SOURCE_DIR / "import-report.json"
BOUNDARIES_PATH = SOURCE_DIR / "boundaries.geojson"
WEATHER_SUMMARY_PATH = DERIVED_DIR / "weather-summary.json"
NDVI_SUMMARY_PATH = DERIVED_DIR / "ndvi-summary.json"
PERFORMANCE_SUMMARY_PATH = DERIVED_DIR / "performance-summary.json"
LANDSAT_SUMMARY_PATH = DERIVED_DIR / "landsat-summary.json"
DAILY_WEATHER_PATH = WORKSPACE / "weather" / "daily-weather.json"
NDVI_DIR = WORKSPACE / "ndvi"
LANDSAT_DIR = WORKSPACE / "landsat"
ANALYSIS_DIR = WORKSPACE / "analysis"
PUBLIC_NDVI_DIR = PUBLIC_DIR / "ndvi"
PUBLIC_PERFORMANCE_DIR = PUBLIC_DIR / "performance"
PUBLIC_LANDSAT_DIR = PUBLIC_DIR / "landsat"


def repository_display_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPOSITORY_ROOT))
    except ValueError:
        return str(path.resolve())
