#!/usr/bin/env python3
"""Build local, crop-aware persistent field-performance inputs.

This script reuses the existing farm grid, cloud-masked Sentinel-2 feature
arrays, crop history and weather summaries. It does not download imagery or
recalculate reflectance.
"""

from __future__ import annotations

import argparse
import json
from collections import OrderedDict, defaultdict
from datetime import date, datetime
from pathlib import Path

import numpy as np
from farm_config import (
    DAILY_WEATHER_PATH,
    FARM_ID,
    HISTORY_PATH,
    LANDSAT_SUMMARY_PATH,
    NDVI_DIR,
    NDVI_SUMMARY_PATH,
    PERFORMANCE_SUMMARY_PATH,
    PROFILE,
    PUBLIC_PERFORMANCE_DIR,
    WEATHER_SUMMARY_PATH,
)
from satellite_features import (
    OPTICAL_FEATURES,
    RAW_20M_BANDS,
    add_normal_curve_deviations,
    average_percentile_rank,
    combine_relative_features,
    derive_phenology,
    expand_native_to_display,
    native_display_offsets,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MIN_FIELD_CLEAR_FRACTION = 0.60
MIN_SEASON_OBSERVATIONS = 4
MIN_VARIABILITY_OBSERVATIONS = 5
SCENE_FEATURE_CACHE_MAX_BYTES = 256 * 1024 * 1024
_scene_feature_cache: OrderedDict[tuple[str, str], np.ndarray] = OrderedDict()
_scene_feature_cache_bytes = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build local persistent-performance evidence from cached "
            "multi-index Sentinel-2 scenes."
        )
    )
    parser.add_argument(
        "--history",
        type=Path,
        default=HISTORY_PATH,
    )
    parser.add_argument(
        "--ndvi-summary",
        type=Path,
        default=NDVI_SUMMARY_PATH,
    )
    parser.add_argument(
        "--weather-summary",
        type=Path,
        default=WEATHER_SUMMARY_PATH,
    )
    parser.add_argument(
        "--daily-weather",
        type=Path,
        default=DAILY_WEATHER_PATH,
    )
    parser.add_argument(
        "--landsat-summary",
        type=Path,
        default=LANDSAT_SUMMARY_PATH,
    )
    parser.add_argument(
        "--grid",
        type=Path,
        default=NDVI_DIR / "farm-grid.npz",
    )
    parser.add_argument(
        "--grid-metadata",
        type=Path,
        default=NDVI_DIR / "farm-grid.json",
    )
    parser.add_argument(
        "--scene-dir",
        type=Path,
        default=NDVI_DIR / "scenes",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=PUBLIC_PERFORMANCE_DIR,
    )
    parser.add_argument(
        "--summary-output",
        type=Path,
        default=PERFORMANCE_SUMMARY_PATH,
    )
    return parser.parse_args()


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def fallback_stage_relevance(
    observed_on: date,
    window_start: date,
    window_end: date,
    median_ndvi: float | None,
) -> tuple[str, float, float]:
    """Fallback only when the observed trajectory cannot support phenology."""
    window_days = max(1, (window_end - window_start).days)
    relative_position = clamp(
        (observed_on - window_start).days / window_days,
        0,
        1,
    )
    if relative_position < 0.18:
        stage, position_weight = "establishment", 0.25
    elif relative_position < 0.45:
        stage, position_weight = "active canopy", 0.85
    elif relative_position < 0.72:
        stage, position_weight = "peak canopy", 1.0
    elif relative_position < 0.88:
        stage, position_weight = "late canopy", 0.65
    else:
        stage, position_weight = "senescence", 0.25

    if median_ndvi is None:
        canopy_weight = 0.50
    elif median_ndvi < 0.25:
        canopy_weight = 0.25
    elif median_ndvi < 0.40:
        canopy_weight = 0.55
    elif median_ndvi <= 0.82:
        canopy_weight = 1.0
    elif median_ndvi <= 0.90:
        canopy_weight = 0.80
    else:
        canopy_weight = 0.50
    return stage, round(relative_position, 3), position_weight * canopy_weight


def crop_group(crop: str) -> str:
    if crop.endswith(("wheat", "barley", "oats")):
        return "cereal"
    if crop.endswith(("beans", "oilseed_rape")):
        return "break"
    if crop == "grass":
        return "grass"
    return "other"


def season_type(crop: str) -> str:
    if crop.startswith("winter_"):
        return "winter"
    if crop.startswith("spring_"):
        return "spring"
    if crop == "grass":
        return "perennial"
    return "unknown"


def weather_window(crop: str) -> str:
    if crop.startswith("winter_"):
        return "winter"
    if crop.startswith("spring_"):
        return "spring"
    if crop == "grass":
        return "grass"
    return "crop_year"


def erode(mask: np.ndarray) -> np.ndarray:
    padded = np.pad(mask, 1, constant_values=False)
    result = mask.copy()
    for row_offset in range(3):
        for column_offset in range(3):
            result &= padded[
                row_offset : row_offset + mask.shape[0],
                column_offset : column_offset + mask.shape[1],
            ]
    return result


def edge_reliability(field_pixels: np.ndarray) -> np.ndarray:
    """Down-weight the first two retained pixel rings after the 10 m buffer."""
    reliability = np.zeros(field_pixels.shape, dtype=np.float32)
    reliability[field_pixels] = 1.0
    first_erosion = erode(field_pixels)
    second_erosion = erode(first_erosion)
    reliability[field_pixels & ~first_erosion] = 0.75
    reliability[first_erosion & ~second_erosion] = 0.90
    return reliability


def date_weather_lookup(daily_weather: dict) -> dict[str, dict]:
    return {row["date"]: row for row in daily_weather.get("daily", [])}


def cumulative_gdd(
    weather_by_date: dict[str, dict],
    start: date,
    end: date,
    base_temperature: float = 5.0,
) -> float | None:
    total = 0.0
    found = False
    current = start
    while current <= end:
        row = weather_by_date.get(current.isoformat())
        if row and row.get("temperature_2m_mean") is not None:
            total += max(0, float(row["temperature_2m_mean"]) - base_temperature)
            found = True
        current = date.fromordinal(current.toordinal() + 1)
    return round(total, 1) if found else None


def load_scene_summaries(scene_dir: Path) -> dict[str, list[dict]]:
    by_date: dict[str, list[dict]] = defaultdict(list)
    for sidecar in sorted(scene_dir.glob("*.json")):
        scene = json.loads(sidecar.read_text())
        scene["_sidecar"] = str(sidecar)
        scene["sceneFile"] = str(sidecar.with_suffix(".npz"))
        by_date[scene["date"]].append(scene)
    return by_date


def load_scene_feature(scene_file: str, feature: str) -> np.ndarray:
    global _scene_feature_cache_bytes
    key = (scene_file, feature)
    cached = _scene_feature_cache.get(key)
    if cached is not None:
        _scene_feature_cache.move_to_end(key)
        return cached
    path = Path(scene_file)
    if not path.is_absolute():
        path = REPOSITORY_ROOT / path
    with np.load(path) as arrays:
        values = arrays[feature].astype(np.float32)
    if values.nbytes <= SCENE_FEATURE_CACHE_MAX_BYTES:
        while (
            _scene_feature_cache
            and _scene_feature_cache_bytes + values.nbytes
            > SCENE_FEATURE_CACHE_MAX_BYTES
        ):
            _, removed = _scene_feature_cache.popitem(last=False)
            _scene_feature_cache_bytes -= removed.nbytes
        _scene_feature_cache[key] = values
        _scene_feature_cache_bytes += values.nbytes
    return values


def observation_support(observations: list[dict], crop: str) -> dict:
    canopy = [
        (item["date"], item.get("ndvi"))
        for item in observations
        if item.get("ndvi") is not None
    ]
    observed_dates = sorted(item[0] for item in canopy)
    coverage_days = (
        (date.fromisoformat(observed_dates[-1]) - date.fromisoformat(observed_dates[0])).days
        if len(observed_dates) >= 2
        else 0
    )
    if len(observations) < MIN_SEASON_OBSERVATIONS:
        reason = "Fewer than four clear observations."
        peak_date = None
        pre_peak = post_peak = 0
        evidence_tier = None
        coverage_label = "insufficient"
    elif len(canopy) < MIN_SEASON_OBSERVATIONS:
        reason = "Fewer than four observations contain a canopy signal."
        peak_date = None
        pre_peak = post_peak = 0
        evidence_tier = None
        coverage_label = "insufficient"
    else:
        peak_date = max(canopy, key=lambda row: row[1])[0]
        pre_peak = sum(observed_on < peak_date for observed_on, _ in canopy)
        post_peak = sum(observed_on > peak_date for observed_on, _ in canopy)
        if crop == "grass":
            if coverage_days < 90:
                reason = "Grass evidence spans fewer than 90 days."
                evidence_tier = None
                coverage_label = "insufficient"
            else:
                reason = ""
                evidence_tier = "grass-seasonal"
                coverage_label = "multi-cycle seasonal coverage"
        elif pre_peak >= 2 and post_peak >= 1:
            reason = ""
            evidence_tier = "full-season"
            coverage_label = "full seasonal trajectory"
        else:
            reason = ""
            evidence_tier = "partial-season"
            if pre_peak == 0:
                coverage_label = "canopy-to-late-season only"
            elif post_peak == 0:
                coverage_label = "early-to-canopy only"
            else:
                coverage_label = "incomplete peak bracketing"
    return {
        "eligible": not reason,
        "reason": reason or None,
        "evidenceTier": evidence_tier,
        "coverageLabel": coverage_label,
        "coverageDays": coverage_days,
        "peakDate": peak_date,
        "prePeakCount": pre_peak,
        "postPeakCount": post_peak,
    }


def limited_phenology(observations: list[dict], support: dict) -> dict:
    available_features = [
        feature
        for feature in OPTICAL_FEATURES
        if any(item.get(feature) is not None for item in observations)
    ]
    return {
        "method": (
            "Phenology withheld: grass may contain repeated growth or cutting cycles."
            if support["evidenceTier"] == "grass-seasonal"
            else "Phenology withheld: the observed dates do not bracket a complete crop trajectory."
        ),
        "estimated": True,
        "confidence": 0,
        "observationCount": len(observations),
        "availableFeatures": available_features,
        "greenupDate": None,
        "springGrowthRatePerDay": None,
        "peakCanopyDate": None,
        "senescenceOnsetDate": None,
        "senescenceRatePerDay": None,
        "stages": {},
    }


def window_confidence(window_method: str) -> float:
    method = window_method.lower()
    if "recorded sowing" in method and "recorded harvest" in method:
        return 1.0
    if "recorded" in method:
        return 0.9
    return 0.75


def boundary_confidence(boundary_method: str) -> float:
    method = boundary_method.lower()
    return 0.85 if "provisional" in method or "proxy" in method else 1.0


def choose_scene(
    scenes_by_date: dict[str, list[dict]],
    observed_on: str,
    field_code: str,
) -> dict | None:
    eligible = [
        scene
        for scene in scenes_by_date.get(observed_on, [])
        if min(
            scene["fieldStats"][field_code]["clearFraction"],
            scene["fieldStats"][field_code].get(
                "native20mClearFraction",
                scene["fieldStats"][field_code]["clearFraction"],
            ),
        )
        >= MIN_FIELD_CLEAR_FRACTION
    ]
    if not eligible:
        return None
    return max(
        eligible,
        key=lambda scene: min(
            scene["fieldStats"][field_code]["clearFraction"],
            scene["fieldStats"][field_code].get(
                "native20mClearFraction",
                scene["fieldStats"][field_code]["clearFraction"],
            ),
        ),
    )


def display_feature_layer(
    values: np.ndarray,
    feature: str,
    display_shape: tuple[int, int],
    native_offsets: tuple[int, int],
) -> np.ndarray:
    native_support = (
        OPTICAL_FEATURES.get(feature, {}).get("native_support_metres", 20)
    )
    if native_support == 20:
        return expand_native_to_display(values, display_shape, *native_offsets)
    return values


def relative_feature_layer(
    values: np.ndarray,
    feature: str,
    field_pixels_10m: np.ndarray,
    field_pixels_20m: np.ndarray,
    native_offsets: tuple[int, int],
) -> np.ndarray | None:
    native_support = OPTICAL_FEATURES[feature]["native_support_metres"]
    field_pixels = (
        field_pixels_10m if native_support == 10 else field_pixels_20m
    )
    valid = field_pixels & np.isfinite(values)
    if np.count_nonzero(valid) < 2:
        return None
    relative = np.full(values.shape, np.nan, dtype=np.float32)
    relative[valid] = average_percentile_rank(values[valid])
    if native_support == 20:
        relative = expand_native_to_display(
            relative,
            field_pixels_10m.shape,
            *native_offsets,
        )
        relative[~field_pixels_10m] = np.nan
    return relative


def build_field_payload(
    field: dict,
    seasons: list[dict],
    field_mask_10m: np.ndarray,
    field_mask_20m: np.ndarray,
    scenes_by_date: dict[str, list[dict]],
    weather_summary: dict,
    weather_by_date: dict[str, dict],
    date_output_dir: Path,
    native_offsets: tuple[int, int] = (0, 0),
) -> dict:
    field_code = field["fieldCode"]
    field_pixels = field_mask_10m == field["index"]
    native_field_pixels = field_mask_20m == field["index"]
    rows, columns = np.where(field_pixels)
    row_offset = int(rows.min())
    column_offset = int(columns.min())
    height = int(rows.max() - row_offset + 1)
    width = int(columns.max() - column_offset + 1)
    reliability = edge_reliability(field_pixels)
    base_cells = [
        [
            int(column - column_offset),
            int(row - row_offset),
            round(float(reliability[row, column]), 2),
        ]
        for row, column in zip(rows, columns)
    ]

    output_seasons = []
    excluded_seasons = []
    for season in sorted(seasons, key=lambda item: item["harvestYear"]):
        start = datetime.strptime(season["windowStart"], "%Y-%m-%d").date()
        end = datetime.strptime(season["windowEnd"], "%Y-%m-%d").date()
        score_numerator = np.zeros(field_mask_10m.shape, dtype=np.float32)
        score_denominator = np.zeros(field_mask_10m.shape, dtype=np.float32)
        score_square_numerator = np.zeros(
            field_mask_10m.shape,
            dtype=np.float32,
        )
        observation_counts = np.zeros(field_mask_10m.shape, dtype=np.uint16)
        dates = []

        selected_observations = []
        for observed_on in season["usableDates"]:
            scene = choose_scene(scenes_by_date, observed_on, field_code)
            if scene is None:
                continue
            stats = scene["fieldStats"][field_code]
            medians = stats.get("featureMedians", {})
            selected_observations.append(
                {
                    "date": observed_on,
                    "scene": scene,
                    "stats": stats,
                    **{
                        feature: medians.get(
                            feature,
                            stats.get(
                                {
                                    "ndvi": "medianNdvi",
                                    "evi2": "medianEvi2",
                                    "ndre": "medianNdre",
                                    "ndwi": "medianNdwi",
                                }[feature]
                            ),
                        )
                        for feature in OPTICAL_FEATURES
                    },
                }
            )
        support = observation_support(
            selected_observations,
            season["cropNormalised"],
        )
        if not support["eligible"]:
            excluded_seasons.append(
                {
                    "id": season["id"],
                    "harvestYear": season["harvestYear"],
                    "cropCode": season["cropNormalised"],
                    "usableObservationCount": len(selected_observations),
                    "prePeakObservationCount": support["prePeakCount"],
                    "postPeakObservationCount": support["postPeakCount"],
                    "reason": support["reason"],
                }
            )
            continue
        phenology = (
            derive_phenology(selected_observations, start, end)
            if support["evidenceTier"] == "full-season"
            else limited_phenology(selected_observations, support)
        )
        season_window_confidence = window_confidence(season["windowMethod"])
        season_boundary_confidence = boundary_confidence(
            season.get("boundaryMethod", "")
        )

        for observation in selected_observations:
            observed_on = observation["date"]
            scene = observation["scene"]
            stats = observation["stats"]
            relative_layers = []
            display_features = {}
            for feature in (*OPTICAL_FEATURES, *RAW_20M_BANDS):
                values = load_scene_feature(scene["sceneFile"], feature)
                display = display_feature_layer(
                    values,
                    feature,
                    field_mask_10m.shape,
                    native_offsets,
                )
                display_features[feature] = display
                if feature in OPTICAL_FEATURES:
                    relative = relative_feature_layer(
                        values,
                        feature,
                        field_pixels,
                        native_field_pixels,
                        native_offsets,
                    )
                    if relative is not None:
                        relative_layers.append(relative)
            if not relative_layers:
                continue
            relative_score, feature_counts = combine_relative_features(
                relative_layers
            )
            relative_score[~field_pixels] = np.nan
            feature_counts[~field_pixels] = 0
            valid = field_pixels & np.isfinite(relative_score)
            observed_date = datetime.strptime(observed_on, "%Y-%m-%d").date()
            relative_position = round(
                clamp(
                    (observed_date - start).days
                    / max(1, (end - start).days),
                    0,
                    1,
                ),
                3,
            )
            stage_evidence = phenology.get("stages", {}).get(observed_on)
            if stage_evidence:
                stage = stage_evidence["stage"]
                stage_weight = stage_evidence["weight"]
                stage_method = "Estimated from the multi-index crop trajectory."
                curve_value = stage_evidence["curveValue"]
            else:
                stage, _, stage_weight = fallback_stage_relevance(
                    observed_date,
                    start,
                    end,
                    observation.get("ndvi"),
                )
                stage_method = (
                    "Fallback crop-window estimate; the trajectory was insufficient."
                )
                curve_value = None
            effective_clear_fraction = min(
                stats["clearFraction"],
                stats.get("native20mClearFraction", stats["clearFraction"]),
            )
            coverage_weight = 0.55 + 0.45 * clamp(
                (effective_clear_fraction - MIN_FIELD_CLEAR_FRACTION)
                / (1 - MIN_FIELD_CLEAR_FRACTION),
                0,
                1,
            )
            mean_feature_count = float(np.mean(feature_counts[valid]))
            feature_support_weight = 0.70 + 0.30 * (
                mean_feature_count / len(OPTICAL_FEATURES)
            )
            observation_weight = (
                coverage_weight
                * stage_weight
                * feature_support_weight
            )
            score_numerator[valid] += relative_score[valid] * observation_weight
            score_square_numerator[valid] += (
                np.square(relative_score[valid]) * observation_weight
            )
            score_denominator[valid] += observation_weight
            observation_counts[valid] += 1
            date_filename = (
                f"{FARM_ID}-{field_code}-{season['harvestYear']}-{observed_on}.json"
            )
            date_file = date_output_dir / date_filename
            exported_features = {
                feature: [
                    (
                        round(float(values[row, column]), 4)
                        if np.isfinite(values[row, column])
                        else None
                    )
                    for row, column in zip(rows, columns)
                ]
                for feature, values in display_features.items()
            }
            date_file.write_text(
                json.dumps(
                    {
                        "fieldCode": field_code,
                        "fieldName": field["fieldName"],
                        "seasonId": season["id"],
                        "harvestYear": season["harvestYear"],
                        "cropCode": season["cropNormalised"],
                        "date": observed_on,
                        "sceneId": scene["id"],
                        "pixelSizeMetres": 10,
                        "displayPixelSizeMetres": 10,
                        "nativeSupportMetres": {
                            **{
                                feature: definition["native_support_metres"]
                                for feature, definition in OPTICAL_FEATURES.items()
                            },
                            **{feature: 20 for feature in RAW_20M_BANDS},
                        },
                        "displayResampling": {
                            feature: "nearest-neighbour replication from native 20 m"
                            for feature in (
                                "ndre",
                                "ndwi",
                                *RAW_20M_BANDS,
                            )
                        },
                        "width": width,
                        "height": height,
                        "features": exported_features,
                        "ndvi": exported_features["ndvi"],
                        "relativeScores": [
                            round(float(relative_score[row, column]), 1)
                            if np.isfinite(relative_score[row, column])
                            else None
                            for row, column in zip(rows, columns)
                        ],
                        "relativeFeatureCount": [
                            int(feature_counts[row, column])
                            for row, column in zip(rows, columns)
                        ],
                        "method": (
                            "The relative layer equally averages the available "
                            "within-field percentile ranks for NDVI, EVI2, NDRE "
                            "and NDWI. Red-edge and SWIR values retain native "
                            "20 m analytical support and are replicated only "
                            "for the 10 m display."
                        ),
                    },
                    separators=(",", ":"),
                )
                + "\n"
            )
            dates.append(
                {
                    "date": observed_on,
                    "stage": stage,
                    "stageEstimated": True,
                    "stageMethod": stage_method,
                    "trajectoryValue": curve_value,
                    "relativeSeasonPosition": relative_position,
                    "gddBase5FromWindowStart": cumulative_gdd(
                        weather_by_date,
                        start,
                        observed_date,
                    ),
                    "medianNdvi": observation.get("ndvi"),
                    "medianEvi2": observation.get("evi2"),
                    "medianNdre": observation.get("ndre"),
                    "medianNdwi": observation.get("ndwi"),
                    "featureMedians": stats.get("featureMedians", {}),
                    "clearFraction": effective_clear_fraction,
                    "native20mClearFraction": stats.get(
                        "native20mClearFraction"
                    ),
                    "relativeFeatureCount": round(mean_feature_count, 2),
                    "stageWeight": round(stage_weight, 3),
                    "observationWeight": round(observation_weight, 3),
                    "cellUrl": f"/data/performance/dates/{date_filename}",
                }
            )

        season_score = np.full(field_mask_10m.shape, np.nan, dtype=np.float32)
        season_variability = np.full(
            field_mask_10m.shape,
            np.nan,
            dtype=np.float32,
        )
        enough_weight = score_denominator > 0
        season_score[enough_weight] = (
            score_numerator[enough_weight] / score_denominator[enough_weight]
        )
        variance = np.zeros(field_mask_10m.shape, dtype=np.float32)
        variance[enough_weight] = np.maximum(
            0,
            score_square_numerator[enough_weight]
            / score_denominator[enough_weight]
            - np.square(season_score[enough_weight]),
        )
        season_variability[enough_weight] = np.sqrt(variance[enough_weight])
        season_score[observation_counts < MIN_SEASON_OBSERVATIONS] = np.nan
        season_variability[
            observation_counts < MIN_VARIABILITY_OBSERVATIONS
        ] = np.nan

        crop = season["cropNormalised"]
        window_name = weather_window(crop)
        weather = (
            weather_summary.get("harvestYears", {})
            .get(str(season["harvestYear"]), {})
            .get(window_name, {})
        )
        mean_stage_weight = (
            sum(item["stageWeight"] for item in dates) / len(dates)
            if dates
            else 0
        )
        date_support = 0.70 + 0.30 * min(1, len(dates) / 6)
        phenology_support = (
            0.65 + 0.35 * (phenology.get("confidence", 0) / 100)
            if support["evidenceTier"] == "full-season"
            else 1.0
        )
        tier_weight = {
            "full-season": 1.0,
            "grass-seasonal": 0.75,
            "partial-season": 0.60,
        }[support["evidenceTier"]]
        quality_weight = (
            season["dataQuality"]
            / 100
            * season_window_confidence
            * season_boundary_confidence
            * date_support
            * (0.65 + 0.35 * mean_stage_weight)
            * phenology_support
            * tier_weight
        )
        output_seasons.append(
            {
                "id": season["id"],
                "harvestYear": season["harvestYear"],
                "cropCode": crop,
                "cropGroup": crop_group(crop),
                "seasonType": season_type(crop),
                "evidenceTier": support["evidenceTier"],
                "evidenceReason": support["coverageLabel"],
                "coverageDays": support["coverageDays"],
                "windowStart": season["windowStart"],
                "windowEnd": season["windowEnd"],
                "windowConfidence": season_window_confidence,
                "windowMethod": season["windowMethod"],
                "boundaryConfidence": season_boundary_confidence,
                "dataQuality": season["dataQuality"],
                "qualityWeight": round(quality_weight, 3),
                "weatherClass": weather.get("moistureClass", "unknown"),
                "waterBalanceMm": weather.get("waterBalanceMm"),
                "waterBalanceZ": weather.get("waterBalanceZ"),
                "temperatureZ": weather.get("temperatureZ"),
                "gddBase5": weather.get("gddBase5"),
                "soilMoisture": weather.get("rootZoneSoilMoisture"),
                "phenology": phenology,
                "dates": dates,
                "scores": [
                    round(float(season_score[row, column]), 1)
                    if np.isfinite(season_score[row, column])
                    else None
                    for row, column in zip(rows, columns)
                ],
                "withinSeasonVariability": [
                    round(float(season_variability[row, column]), 1)
                    if np.isfinite(season_variability[row, column])
                    else None
                    for row, column in zip(rows, columns)
                ],
                "observationCounts": [
                    int(observation_counts[row, column])
                    for row, column in zip(rows, columns)
                ],
            }
        )

    add_normal_curve_deviations(output_seasons)
    years = [season["harvestYear"] for season in output_seasons]
    crop_codes = sorted({season["cropCode"] for season in output_seasons})
    return {
        "fieldCode": field_code,
        "fieldName": field["fieldName"],
        "recordedHectares": field["recordedHectares"],
        "pixelSizeMetres": 10,
        "width": width,
        "height": height,
        "gridOffset": [column_offset, row_offset],
        "cells": base_cells,
        "seasons": output_seasons,
        "excludedSeasons": excluded_seasons,
        "availableYears": [min(years), max(years)] if years else [],
        "cropCodes": crop_codes,
        "method": {
            "description": (
                "Multi-index satellite estimate of relative historical crop "
                "performance, not a direct yield measurement."
            ),
            "observationNormalisation": (
                "NDVI, EVI2, NDRE and NDWI are separately converted to tied "
                "within-field percentile ranks, then equally averaged from "
                "the features available at each cell and date."
            ),
            "dateWeighting": (
                "Clear fraction, feature support, trajectory-derived crop-stage "
                "relevance weight dates. Crop-window and boundary confidence "
                "weight the completed crop season, where they cannot cancel."
            ),
            "phenology": (
                "Green-up, peak, canopy duration and senescence are estimated only "
                "for full trajectories. Partial seasons retain lower-confidence "
                "spatial evidence but withhold unsupported phenology. Grass uses "
                "seasonal coverage because grazing and cutting can create several peaks."
            ),
            "nativeResolution": (
                "NDVI and EVI2 are analysed at 10 m. NDRE, NDWI, red-edge and "
                "SWIR bands are analysed at native 20 m support and replicated "
                "onto the 10 m display grid only after ranking."
            ),
            "seasonIndependence": (
                "Dates are combined within seasons before seasons are combined, "
                "so scene-rich years do not dominate."
            ),
            "edgeTreatment": (
                "The source field mask already has a 10 m inward buffer; the "
                "first two retained pixel rings receive lower confidence."
            ),
            "historicalBoundaryWarning": (
                f"{PROFILE['boundaryLabel']} is a provisional proxy for "
                "historical imagery where older boundaries are unavailable."
            ),
        },
    }


def main() -> None:
    args = parse_args()
    required = [
        args.history,
        args.ndvi_summary,
        args.weather_summary,
        args.daily_weather,
        args.grid,
        args.grid_metadata,
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise SystemExit(f"Missing required local evidence: {', '.join(missing)}")

    history = json.loads(args.history.read_text())
    ndvi_summary = json.loads(args.ndvi_summary.read_text())
    if (
        ndvi_summary.get("source", {}).get("collection") != "synthetic"
        and ndvi_summary.get("query", {}).get("featureVersion")
        != "sentinel-features-v3"
    ):
        raise SystemExit(
            "The optical cache predates the aligned float32 v3 method. Run "
            "npm run data:optical before rebuilding performance outputs."
        )
    weather_summary = json.loads(args.weather_summary.read_text())
    daily_weather = json.loads(args.daily_weather.read_text())
    landsat_summary = (
        json.loads(args.landsat_summary.read_text())
        if args.landsat_summary.exists()
        else None
    )
    grid_metadata = json.loads(args.grid_metadata.read_text())
    with np.load(args.grid) as grid_arrays:
        if "field_mask_20m" not in grid_arrays.files:
            raise SystemExit(
                "The farm grid predates Phase 2. Refresh Sentinel-2 data to "
                "create the native 20 m field mask."
            )
        field_mask = grid_arrays["field_mask"]
        field_mask_20m = grid_arrays["field_mask_20m"]
    if list(field_mask.shape) != [
        grid_metadata["height"],
        grid_metadata["width"],
    ]:
        raise SystemExit("The field mask and farm-grid metadata are not aligned.")
    native_grid = grid_metadata.get("nativeFeatureGrid", {})
    if list(field_mask_20m.shape) != [
        native_grid.get("height"),
        native_grid.get("width"),
    ]:
        raise SystemExit(
            "The native 20 m mask and farm-grid metadata are not aligned."
        )
    native_offsets = native_display_offsets(
        grid_metadata["geotransform"],
        native_grid["geotransform"],
    )

    history_by_id = {
        f"{FARM_ID}-{row['fieldCode']}-{row['year']}": row for row in history
    }
    seasons_by_field: dict[str, list[dict]] = defaultdict(list)
    for season in ndvi_summary["seasons"]:
        history_row = history_by_id.get(season["id"])
        if history_row:
            seasons_by_field[season["fieldCode"]].append(
                {**season, "cropNormalised": history_row["cropNormalised"]}
            )

    scenes_by_date = load_scene_summaries(args.scene_dir)
    weather_by_date = date_weather_lookup(daily_weather)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    date_output_dir = args.output_dir / "dates"
    date_output_dir.mkdir(parents=True, exist_ok=True)
    field_summaries = []
    total_model_seasons = 0
    total_excluded_seasons = 0
    total_model_dates = 0
    for field in grid_metadata["fields"]:
        payload = build_field_payload(
            field,
            seasons_by_field.get(field["fieldCode"], []),
            field_mask,
            field_mask_20m,
            scenes_by_date,
            weather_summary,
            weather_by_date,
            date_output_dir,
            native_offsets,
        )
        field_filename = f"{FARM_ID}-{field['fieldCode']}.json"
        output_path = args.output_dir / field_filename
        output_path.write_text(
            json.dumps(payload, separators=(",", ":")) + "\n"
        )
        total_model_seasons += len(payload["seasons"])
        total_excluded_seasons += len(payload["excludedSeasons"])
        total_model_dates += sum(
            len(season["dates"]) for season in payload["seasons"]
        )
        field_summaries.append(
            {
                "fieldCode": payload["fieldCode"],
                "fieldName": payload["fieldName"],
                "recordedHectares": payload["recordedHectares"],
                "cellCount": len(payload["cells"]),
                "seasonCount": len(payload["seasons"]),
                "excludedSeasonCount": len(payload["excludedSeasons"]),
                "availableYears": payload["availableYears"],
                "cropCodes": payload["cropCodes"],
                "url": f"/data/performance/{field_filename}",
            }
        )
        print(
            f"{payload['fieldName']}: {len(payload['cells'])} cells, "
            f"{len(payload['seasons'])} crop seasons",
            flush=True,
        )

    summary = {
        "generatedAt": ndvi_summary.get("generatedAt"),
        "source": {
            "ndviSummary": str(args.ndvi_summary.relative_to(REPOSITORY_ROOT)),
            "sceneDirectory": str(args.scene_dir.relative_to(REPOSITORY_ROOT)),
            "weatherSummary": str(args.weather_summary.relative_to(REPOSITORY_ROOT)),
            "farmGrid": str(args.grid.relative_to(REPOSITORY_ROOT)),
        },
        "methodVersion": "persistent-performance-v4-evidence-tiers",
        "sceneErrorCount": ndvi_summary.get("sceneErrorCount", 0),
        "sceneErrors": ndvi_summary.get("sceneErrors", []),
        "features": {
            **OPTICAL_FEATURES,
            **{
                feature: {
                    "label": feature,
                    "native_support_metres": 20,
                    "role": "stored explanatory band",
                }
                for feature in RAW_20M_BANDS
            },
        },
        "landsat": {
            "status": (
                "available"
                if landsat_summary and landsat_summary.get("processedSceneCount", 0)
                else "not_ingested"
            ),
            "sceneCount": (
                landsat_summary.get("processedSceneCount", 0)
                if landsat_summary
                else 0
            ),
            "availableYears": (
                [
                    int(landsat_summary["scenes"][0]["date"][:4]),
                    int(landsat_summary["scenes"][-1]["date"][:4]),
                ]
                if landsat_summary and landsat_summary.get("scenes")
                else []
            ),
            "nativeSupportMetres": 30,
            "grid": (
                landsat_summary.get("grid")
                if landsat_summary
                else None
            ),
            "fieldUrlTemplate": f"/data/landsat/{FARM_ID}-{{fieldCode}}.json",
            "role": (
                "separate long-history evidence using within-field NDVI, EVI2 "
                "and NDWI ranks; not fused into the Sentinel-2 score"
            ),
        },
        "farmGrid": {
            "width": grid_metadata["width"],
            "height": grid_metadata["height"],
            "pixelSizeMetres": 10,
            "geotransform": grid_metadata["geotransform"],
        },
        "fieldCount": len(field_summaries),
        "seasonCount": total_model_seasons,
        "excludedSeasonCount": total_excluded_seasons,
        "individualDateCount": total_model_dates,
        "fields": sorted(field_summaries, key=lambda item: item["fieldName"].lower()),
    }
    args.summary_output.write_text(json.dumps(summary, indent=2) + "\n")
    print(
        f"Wrote {len(field_summaries)} field products with "
        f"{total_model_seasons} stage-weighted crop seasons and "
        f"{total_model_dates} individual date layers.",
        flush=True,
    )


if __name__ == "__main__":
    main()
