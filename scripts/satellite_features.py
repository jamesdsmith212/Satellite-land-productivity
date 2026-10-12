"""Pure feature and phenology functions shared by the local satellite pipeline."""

from __future__ import annotations

from datetime import date, datetime
import warnings

import numpy as np


OPTICAL_FEATURES = {
    "ndvi": {
        "label": "NDVI",
        "native_support_metres": 10,
        "formula": "(B08 - B04) / (B08 + B04)",
    },
    "evi2": {
        "label": "EVI2",
        "native_support_metres": 10,
        "formula": "2.5 * (B08 - B04) / (B08 + 2.4 * B04 + 1)",
    },
    "ndre": {
        "label": "NDRE",
        "native_support_metres": 20,
        "formula": "(B8A - B05) / (B8A + B05)",
    },
    "ndwi": {
        "label": "NDWI / NDMI water-status index",
        "native_support_metres": 20,
        "formula": "(B8A - B11) / (B8A + B11)",
    },
}

RAW_20M_BANDS = (
    "rededge1",
    "rededge2",
    "rededge3",
    "nir08",
    "swir16",
    "swir22",
)

def scaled_reflectance(raw: np.ndarray, asset: dict) -> np.ndarray:
    return raw.astype(np.float32) * asset.get("scale", 1) + asset.get("offset", 0)


def safe_normalised_difference(
    left: np.ndarray,
    right: np.ndarray,
    valid: np.ndarray,
    minimum_denominator: float = 0.02,
) -> np.ndarray:
    denominator = left + right
    output = np.full(left.shape, np.nan, dtype=np.float32)
    usable = valid & np.isfinite(denominator) & (denominator > minimum_denominator)
    output[usable] = np.clip(
        (left[usable] - right[usable]) / denominator[usable],
        -1,
        1,
    )
    return output


def dilate_boolean(mask: np.ndarray, radius: int) -> np.ndarray:
    """Dilate a boolean mask without adding a SciPy dependency."""
    if radius <= 0:
        return mask.astype(bool, copy=True)
    source = mask.astype(bool, copy=False)
    padded = np.pad(source, radius, constant_values=False)
    dilated = np.zeros(source.shape, dtype=bool)
    size = radius * 2 + 1
    for row_offset in range(size):
        for column_offset in range(size):
            dilated |= padded[
                row_offset : row_offset + source.shape[0],
                column_offset : column_offset + source.shape[1],
            ]
    return dilated


def calculate_sentinel2_features(
    raw_10m: dict[str, np.ndarray],
    raw_20m: dict[str, np.ndarray],
    assets: dict[str, dict],
    scl_10m: np.ndarray,
    scl_20m: np.ndarray,
    field_mask_10m: np.ndarray,
    field_mask_20m: np.ndarray,
    valid_scl_classes: tuple[int, ...] = (4, 5),
) -> dict[str, np.ndarray]:
    red = scaled_reflectance(raw_10m["red"], assets["red"])
    nir = scaled_reflectance(raw_10m["nir"], assets["nir"])
    contaminated_10m = dilate_boolean(
        np.isin(scl_10m, (3, 8, 9, 10, 11)),
        2,
    )
    valid_10m = (
        (field_mask_10m > 0)
        & np.isin(scl_10m, valid_scl_classes)
        & ~contaminated_10m
        & (raw_10m["red"] != assets["red"].get("nodata", 0))
        & (raw_10m["nir"] != assets["nir"].get("nodata", 0))
        & np.isfinite(red)
        & np.isfinite(nir)
    )
    ndvi = safe_normalised_difference(nir, red, valid_10m)
    evi2 = np.full(red.shape, np.nan, dtype=np.float32)
    evi2_denominator = nir + 2.4 * red + 1
    evi2_valid = valid_10m & (evi2_denominator > 0.02)
    evi2[evi2_valid] = np.clip(
        2.5 * (nir[evi2_valid] - red[evi2_valid])
        / evi2_denominator[evi2_valid],
        -1,
        1,
    )

    reflectance_20m = {
        name: scaled_reflectance(raw_20m[name], assets[name])
        for name in RAW_20M_BANDS
    }
    contaminated_20m = dilate_boolean(
        np.isin(scl_20m, (3, 8, 9, 10, 11)),
        1,
    )
    base_valid_20m = (
        (field_mask_20m > 0)
        & np.isin(scl_20m, valid_scl_classes)
        & ~contaminated_20m
    )
    valid_20m = {}
    for name in RAW_20M_BANDS:
        valid_20m[name] = (
            base_valid_20m
            & (raw_20m[name] != assets[name].get("nodata", 0))
            & np.isfinite(reflectance_20m[name])
        )

    ndre = safe_normalised_difference(
        reflectance_20m["nir08"],
        reflectance_20m["rededge1"],
        valid_20m["nir08"] & valid_20m["rededge1"],
    )
    ndwi = safe_normalised_difference(
        reflectance_20m["nir08"],
        reflectance_20m["swir16"],
        valid_20m["nir08"] & valid_20m["swir16"],
    )
    masked_bands = {}
    for name, values in reflectance_20m.items():
        masked = np.full(values.shape, np.nan, dtype=np.float32)
        masked[valid_20m[name]] = values[valid_20m[name]]
        masked_bands[name] = masked
    return {
        "ndvi": ndvi,
        "evi2": evi2,
        "ndre": ndre,
        "ndwi": ndwi,
        **masked_bands,
    }


def average_percentile_rank(values: np.ndarray) -> np.ndarray:
    """Return tied percentile ranks from 0 to 100."""
    ranked = np.full(values.shape, np.nan, dtype=np.float32)
    finite_indices = np.flatnonzero(np.isfinite(values))
    if finite_indices.size == 0:
        return ranked
    if finite_indices.size == 1:
        ranked.flat[finite_indices[0]] = 50.0
        return ranked
    finite_values = values.flat[finite_indices]
    order = np.argsort(finite_values, kind="stable")
    sorted_values = finite_values[order]
    finite_ranks = np.empty(finite_indices.size, dtype=np.float32)
    start = 0
    while start < finite_indices.size:
        end = start + 1
        while end < finite_indices.size and sorted_values[end] == sorted_values[start]:
            end += 1
        average_index = (start + end - 1) / 2
        finite_ranks[order[start:end]] = (
            average_index / (finite_indices.size - 1) * 100
        )
        start = end
    ranked.flat[finite_indices] = finite_ranks
    return ranked


def expand_native_to_display(
    values: np.ndarray,
    display_shape: tuple[int, int],
    native_row_offset: int = 0,
    native_column_offset: int = 0,
) -> np.ndarray:
    """Map native 20 m values onto a covered 10 m display grid.

    The native lattice can begin one 10 m pixel before the display lattice.
    Offsets describe that displacement in display pixels; indexing the source
    lattice preserves the real pixel footprint instead of assuming both grids
    share an origin.
    """
    row_indices = (np.arange(display_shape[0]) + native_row_offset) // 2
    column_indices = (
        np.arange(display_shape[1]) + native_column_offset
    ) // 2
    if (
        row_indices.size
        and column_indices.size
        and (
            row_indices.min() < 0
            or column_indices.min() < 0
            or row_indices.max() >= values.shape[0]
            or column_indices.max() >= values.shape[1]
        )
    ):
        raise ValueError("The native feature grid does not cover the display grid.")
    return values[np.ix_(row_indices, column_indices)]


def native_display_offsets(
    display_geotransform: list[float],
    native_geotransform: list[float],
) -> tuple[int, int]:
    """Return native-grid row/column offsets measured in display pixels."""
    display_pixel = float(display_geotransform[1])
    native_pixel = float(native_geotransform[1])
    if not np.isclose(native_pixel, display_pixel * 2):
        raise ValueError("The native feature grid must have twice the display support.")
    if not (
        np.isclose(display_geotransform[2], 0)
        and np.isclose(display_geotransform[4], 0)
        and np.isclose(display_geotransform[5], -display_pixel)
        and np.isclose(native_geotransform[5], -native_pixel)
    ):
        raise ValueError("Rotated or non-square satellite grids are not supported.")
    row_offset = round(
        (native_geotransform[3] - display_geotransform[3]) / display_pixel
    )
    column_offset = round(
        (display_geotransform[0] - native_geotransform[0]) / display_pixel
    )
    if row_offset not in (0, 1) or column_offset not in (0, 1):
        raise ValueError("The native and display grids are not correctly nested.")
    return row_offset, column_offset


def combine_relative_features(
    feature_layers: list[np.ndarray],
) -> tuple[np.ndarray, np.ndarray]:
    """Average available within-field feature ranks without favouring NDVI."""
    if not feature_layers:
        raise ValueError("At least one relative feature layer is required.")
    stack = np.stack(feature_layers)
    counts = np.sum(np.isfinite(stack), axis=0).astype(np.uint8)
    combined = np.full(stack.shape[1:], np.nan, dtype=np.float32)
    valid = counts > 0
    combined[valid] = np.nansum(stack, axis=0)[valid] / counts[valid]
    return combined, counts


def _iso_date(ordinal: int) -> str:
    return date.fromordinal(int(ordinal)).isoformat()


def _crossing(
    values: np.ndarray,
    threshold: float,
    start: int,
    end: int,
    direction: str,
) -> int | None:
    indices = range(start, end + 1)
    if direction == "down":
        return next((index for index in indices if values[index] <= threshold), None)
    return next((index for index in indices if values[index] >= threshold), None)


def derive_phenology(
    observations: list[dict],
    window_start: date,
    window_end: date,
) -> dict:
    """Infer broad crop-stage features from the full multi-index trajectory."""
    feature_names = tuple(OPTICAL_FEATURES)
    prepared = []
    for observation in observations:
        observed_on = observation["date"]
        if isinstance(observed_on, str):
            observed_on = datetime.strptime(observed_on, "%Y-%m-%d").date()
        values = {
            name: observation.get(name)
            for name in feature_names
            if observation.get(name) is not None
            and np.isfinite(observation.get(name))
        }
        if values:
            prepared.append({"date": observed_on, "values": values})
    prepared.sort(key=lambda item: item["date"])
    if len(prepared) < 4:
        return {
            "method": "insufficient multi-index observations",
            "estimated": True,
            "confidence": 0,
            "observationCount": len(prepared),
            "availableFeatures": [],
            "stages": {},
        }

    available_features = []
    feature_ranges = {}
    for name in feature_names:
        values = np.array(
            [
                item["values"][name]
                for item in prepared
                if name in item["values"]
            ],
            dtype=np.float32,
        )
        if values.size >= 3:
            low, high = np.percentile(values, [10, 90])
            if high - low >= 0.02:
                available_features.append(name)
                feature_ranges[name] = (float(low), float(high))
    if not available_features:
        return {
            "method": "insufficient seasonal feature amplitude",
            "estimated": True,
            "confidence": 0,
            "observationCount": len(prepared),
            "availableFeatures": [],
            "stages": {},
        }

    ordinals = np.array(
        [item["date"].toordinal() for item in prepared],
        dtype=np.int32,
    )
    observation_signal = []
    for item in prepared:
        normalised = []
        for name in available_features:
            if name not in item["values"]:
                continue
            low, high = feature_ranges[name]
            normalised.append(
                float(np.clip((item["values"][name] - low) / (high - low), 0, 1))
            )
        observation_signal.append(
            float(np.mean(normalised)) if normalised else np.nan
        )
    observation_signal_array = np.array(observation_signal, dtype=np.float32)
    signal_valid = np.isfinite(observation_signal_array)
    ordinals = ordinals[signal_valid]
    observation_signal_array = observation_signal_array[signal_valid]
    if ordinals.size < 4:
        return {
            "method": "insufficient coincident multi-index observations",
            "estimated": True,
            "confidence": 0,
            "observationCount": int(ordinals.size),
            "availableFeatures": available_features,
            "stages": {},
        }

    daily_ordinals = np.arange(ordinals.min(), ordinals.max() + 1)
    daily = np.interp(daily_ordinals, ordinals, observation_signal_array)
    smoothing_days = min(15, max(3, int(daily.size // 4) * 2 + 1))
    kernel = np.ones(smoothing_days, dtype=np.float32) / smoothing_days
    padded = np.pad(daily, smoothing_days // 2, mode="edge")
    smoothed = np.convolve(padded, kernel, mode="valid")[: daily.size]
    baseline = float(np.percentile(smoothed, 10))
    peak_value = float(np.max(smoothed))
    amplitude = peak_value - baseline
    if amplitude < 0.08:
        return {
            "method": "insufficient seasonal trajectory amplitude",
            "estimated": True,
            "confidence": 10,
            "observationCount": int(ordinals.size),
            "availableFeatures": available_features,
            "stages": {},
        }
    normalised_curve = np.clip((smoothed - baseline) / amplitude, 0, 1.2)
    peak_index = int(np.argmax(normalised_curve))
    greenup_index = _crossing(
        normalised_curve,
        0.20,
        0,
        peak_index,
        "up",
    )
    if (
        peak_index == 0
        or normalised_curve[0] > 0.20
        or greenup_index == peak_index
    ):
        greenup_index = None
    high_indices = np.where(normalised_curve >= 0.70)[0]
    senescence_index = _crossing(
        normalised_curve,
        0.80,
        peak_index,
        normalised_curve.size - 1,
        "down",
    )
    interval = min(14, max(1, normalised_curve.size // 4))
    slopes = (
        normalised_curve[interval:] - normalised_curve[:-interval]
    ) / interval
    spring_slope_count = max(0, peak_index - interval + 1)
    spring_slopes = slopes[:spring_slope_count]
    post_peak_start = min(peak_index, slopes.size)
    senescence_slopes = slopes[post_peak_start:]
    observed_area_under_curve = float(
        np.trapezoid(np.clip(normalised_curve, 0, 1), daily_ordinals)
    )
    observed_span_days = max(1, int(daily_ordinals[-1] - daily_ordinals[0]))
    window_days = max(1, (window_end - window_start).days)
    area_under_curve_mean = observed_area_under_curve / observed_span_days
    area_under_curve_equivalent_days = area_under_curve_mean * window_days
    late_gap_days = max(0, window_end.toordinal() - int(daily_ordinals[-1]))
    late_persistence = None
    if late_gap_days <= 20:
        late_ordinals = np.arange(
            max(window_start.toordinal(), window_end.toordinal() - 29),
            window_end.toordinal() + 1,
        )
        late_curve = np.interp(
            late_ordinals,
            daily_ordinals,
            normalised_curve,
            left=np.nan,
            right=normalised_curve[-1],
        )
        finite_late = late_curve[np.isfinite(late_curve)]
        if finite_late.size:
            late_persistence = float(np.mean(finite_late))
    maximums = {}
    for name in feature_names:
        values = [
            (item["date"], item["values"][name])
            for item in prepared
            if name in item["values"]
        ]
        if not values:
            maximums[name] = {"value": None, "date": None}
            continue
        maximum_date, maximum_value = max(values, key=lambda item: item[1])
        maximums[name] = {
            "value": round(float(maximum_value), 4),
            "date": maximum_date.isoformat(),
        }

    stages = {}
    for ordinal, value in zip(ordinals, observation_signal_array):
        daily_index = int(ordinal - daily_ordinals[0])
        curve_value = float(normalised_curve[daily_index])
        if greenup_index is not None and daily_index < greenup_index:
            stage = "establishment"
        elif daily_index < peak_index and curve_value < 0.70:
            stage = "green-up"
        elif daily_index <= peak_index:
            stage = "active canopy"
        elif senescence_index is None or daily_index < senescence_index:
            stage = "peak / late canopy"
        else:
            stage = "senescence"
        weight = 0.35 + 0.65 * min(1, max(0, curve_value))
        if stage == "senescence":
            weight *= 0.70
        stages[_iso_date(ordinal)] = {
            "stage": stage,
            "curveValue": round(curve_value, 3),
            "weight": round(weight, 3),
        }

    maximum_gap = int(np.max(np.diff(ordinals))) if ordinals.size > 1 else 999
    count_score = min(1, ordinals.size / 12)
    gap_score = max(0, 1 - max(0, maximum_gap - 10) / 40)
    feature_score = len(available_features) / len(feature_names)
    coverage_days = max(1, (window_end - window_start).days)
    observed_coverage = min(
        1,
        (daily_ordinals[-1] - daily_ordinals[0]) / coverage_days,
    )
    peak_at_boundary = peak_index in (0, normalised_curve.size - 1)
    stage_span_factor = (
        1.0
        if greenup_index is not None and senescence_index is not None
        else 0.75
        if not peak_at_boundary
        else 0.55
    )
    confidence = round(
        100
        * (
            count_score * 0.35
            + gap_score * 0.25
            + feature_score * 0.25
            + observed_coverage * 0.15
        )
        * stage_span_factor
    )
    sample_positions = np.linspace(0, 1, 21)
    curve_positions = (
        daily_ordinals - window_start.toordinal()
    ) / coverage_days
    curve_samples = np.interp(
        sample_positions,
        curve_positions,
        np.clip(normalised_curve, 0, 1),
        left=np.nan,
        right=np.nan,
    )
    positive_growth_rate = (
        float(np.max(spring_slopes))
        if spring_slopes.size and greenup_index is not None
        else np.nan
    )
    return {
        "method": (
            "Daily interpolation and 15-day-or-shorter smoothing of the "
            "season-normalised NDVI, EVI2, NDRE and NDWI/NDMI trajectory."
        ),
        "estimated": True,
        "confidence": confidence,
        "observationCount": int(ordinals.size),
        "availableFeatures": available_features,
        "maximumGapDays": maximum_gap,
        "trajectoryCoverageStart": _iso_date(daily_ordinals[0]),
        "trajectoryCoverageEnd": _iso_date(daily_ordinals[-1]),
        "peakAtObservationBoundary": peak_at_boundary,
        "greenupDate": (
            _iso_date(daily_ordinals[greenup_index])
            if greenup_index is not None
            else None
        ),
        "springGrowthRatePerDay": (
            round(positive_growth_rate, 4)
            if np.isfinite(positive_growth_rate)
            and positive_growth_rate > 0
            else None
        ),
        "peakCanopyDate": _iso_date(daily_ordinals[peak_index]),
        "maximums": maximums,
        "areaUnderCurveIndexDays": round(area_under_curve_equivalent_days, 1),
        "areaUnderCurveMean": round(area_under_curve_mean, 3),
        "highCanopyDurationDays": (
            int(high_indices[-1] - high_indices[0] + 1)
            if high_indices.size
            else 0
        ),
        "senescenceOnsetDate": (
            _iso_date(daily_ordinals[senescence_index])
            if senescence_index is not None
            else None
        ),
        "senescenceRatePerDay": (
            round(float(np.min(senescence_slopes)), 4)
            if senescence_slopes.size
            else None
        ),
        "lateSeasonPersistence": (
            round(late_persistence, 3)
            if late_persistence is not None
            else None
        ),
        "lateSeasonGapDays": late_gap_days,
        "curveSamplePositions": [round(float(value), 2) for value in sample_positions],
        "curveSamples": [
            round(float(value), 3) if np.isfinite(value) else None
            for value in curve_samples
        ],
        "stages": stages,
    }


def add_normal_curve_deviations(seasons: list[dict]) -> None:
    """Attach leave-one-season-out deviations for each field/crop trajectory."""
    by_crop: dict[str, list[dict]] = {}
    for season in seasons:
        samples = season.get("phenology", {}).get("curveSamples")
        if samples:
            by_crop.setdefault(season["cropCode"], []).append(season)
    for crop_seasons in by_crop.values():
        for season in crop_seasons:
            comparisons = [
                candidate["phenology"]["curveSamples"]
                for candidate in crop_seasons
                if candidate is not season
            ]
            phenology = season["phenology"]
            if not comparisons:
                phenology["normalCurveComparisonCount"] = 0
                phenology["normalCurveRmse"] = None
                phenology["normalCurveSignedDeviation"] = None
                continue
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", category=RuntimeWarning)
                normal = np.nanmedian(
                    np.array(comparisons, dtype=np.float32),
                    axis=0,
                )
            current = np.array(phenology["curveSamples"], dtype=np.float32)
            difference = current - normal
            valid = np.isfinite(difference)
            phenology["normalCurveComparisonCount"] = len(comparisons)
            phenology["normalCurveRmse"] = (
                round(
                    float(np.sqrt(np.mean(np.square(difference[valid])))),
                    3,
                )
                if np.count_nonzero(valid) >= 3
                else None
            )
            phenology["normalCurveSignedDeviation"] = (
                round(float(np.mean(difference[valid])), 3)
                if np.count_nonzero(valid) >= 3
                else None
            )
