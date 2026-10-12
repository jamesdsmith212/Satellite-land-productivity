#!/usr/bin/env python3
"""Discover and process real Sentinel-2 crop features over the farm boundaries."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from pathlib import Path

import numpy as np
try:
    from osgeo import gdal, ogr, osr
except ModuleNotFoundError:  # Pure pipeline tests do not require GDAL.
    gdal = ogr = osr = None
from farm_config import (
    BOUNDARIES_PATH,
    FARM_ID,
    HISTORY_PATH,
    NDVI_DIR,
    NDVI_SUMMARY_PATH,
    PROFILE,
)
from satellite_features import (
    OPTICAL_FEATURES,
    RAW_20M_BANDS,
    calculate_sentinel2_features,
    dilate_boolean,
)


STAC_SEARCH_URL = "https://earth-search.aws.element84.com/v1/search"
COLLECTION = "sentinel-2-l2a"
ALLOWED_ASSET_HOST = "sentinel-cogs.s3.us-west-2.amazonaws.com"
VALID_SCL_CLASSES = (4, 5)
FEATURE_VERSION = "sentinel-features-v3"
SENTINEL_2_ASSETS = (
    "red",
    "nir",
    "rededge1",
    "rededge2",
    "rededge3",
    "nir08",
    "swir16",
    "swir22",
    "scl",
)

os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MULTIPLEX", "YES")
os.environ.setdefault("GDAL_HTTP_VERSION", "2")
os.environ.setdefault("CPL_VSIL_CURL_CACHE_SIZE", "200000000")
if gdal is not None:
    gdal.UseExceptions()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--boundaries",
        default=BOUNDARIES_PATH,
    )
    parser.add_argument("--history", default=HISTORY_PATH)
    parser.add_argument("--farm-id", default=FARM_ID)
    parser.add_argument("--output-dir", default=NDVI_DIR)
    parser.add_argument(
        "--summary",
        default=NDVI_SUMMARY_PATH,
    )
    parser.add_argument("--start-date", default="2016-09-01")
    parser.add_argument("--end-date", default=date.today().isoformat())
    parser.add_argument("--max-tile-cloud", type=float, default=100)
    parser.add_argument("--min-field-clear", type=float, default=0.60)
    parser.add_argument("--edge-buffer-metres", type=float, default=10)
    parser.add_argument("--max-scenes", type=int)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--refresh-catalogue", action="store_true")
    parser.add_argument("--discover-only", action="store_true")
    return parser.parse_args()


def flatten_coordinates(value):
    if (
        isinstance(value, list)
        and len(value) >= 2
        and all(isinstance(item, (int, float)) for item in value[:2])
    ):
        yield value
        return
    for child in value:
        yield from flatten_coordinates(child)


def farm_bbox(collection: dict) -> list[float]:
    points = [
        coordinate
        for feature in collection["features"]
        for coordinate in flatten_coordinates(feature["geometry"]["coordinates"])
    ]
    return [
        min(point[0] for point in points),
        min(point[1] for point in points),
        max(point[0] for point in points),
        max(point[1] for point in points),
    ]


def request_json(url: str, body: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "content-type": "application/json",
            "accept": "application/geo+json",
            "user-agent": "Satellite-Productivity-Detection/0.1 local-farm-analysis",
        },
        method="POST",
    )
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return json.load(response)
        except Exception as error:
            last_error = error
            if attempt < 2:
                time.sleep(2**attempt)
    raise RuntimeError(f"STAC request failed after three attempts: {last_error}")


def asset_metadata(item: dict, name: str) -> dict:
    asset = item["assets"].get(name)
    if not asset:
        raise RuntimeError(f"{item['id']} has no {name} asset.")
    href = asset["href"]
    if not href.startswith(f"https://{ALLOWED_ASSET_HOST}/"):
        raise RuntimeError(f"{item['id']} has an unexpected {name} asset host.")
    raster_band = (asset.get("raster:bands") or [{}])[0]
    scale = raster_band.get("scale")
    offset = raster_band.get("offset")
    nodata = raster_band.get("nodata")
    return {
        "href": href,
        "scale": 1 if scale is None else scale,
        "offset": 0 if offset is None else offset,
        "nodata": 0 if nodata is None else nodata,
        "gsd": asset.get("gsd"),
    }


def condensed_item(item: dict) -> dict:
    tile_match = re.search(r"_(\d{2}[A-Z]{3})_", item["id"])
    return {
        "id": item["id"],
        "date": item["properties"]["datetime"][:10],
        "datetime": item["properties"]["datetime"],
        "tileCloudCover": item["properties"].get("eo:cloud_cover"),
        "platform": item["properties"].get("platform"),
        "processingBaseline": item["properties"].get("s2:processing_baseline"),
        "mgrsTile": tile_match.group(1) if tile_match else None,
        **{
            asset_name: asset_metadata(item, asset_name)
            for asset_name in SENTINEL_2_ASSETS
        },
    }


def require_single_mgrs_tile(items: list[dict]) -> str:
    tiles = {item.get("mgrsTile") for item in items}
    if None in tiles:
        raise RuntimeError("A Sentinel-2 catalogue item has no parseable MGRS tile.")
    if len(tiles) != 1:
        raise RuntimeError(
            "The farm spans multiple Sentinel-2 MGRS tiles; one aligned analysis "
            "grid cannot be inferred safely. Split or mosaic the farm explicitly."
        )
    return next(iter(tiles))


def discover_items(
    bbox: list[float],
    start_date: str,
    end_date: str,
    max_tile_cloud: float,
) -> list[dict]:
    body = {
        "collections": [COLLECTION],
        "bbox": bbox,
        "datetime": (
            f"{start_date}T00:00:00Z/{end_date}T23:59:59Z"
        ),
        "limit": 100,
        "query": {"eo:cloud_cover": {"lt": max_tile_cloud}},
        "fields": {
            "include": [
                "id",
                "properties.datetime",
                "properties.eo:cloud_cover",
                "properties.platform",
                "properties.s2:processing_baseline",
                *[f"assets.{asset_name}" for asset_name in SENTINEL_2_ASSETS],
            ],
            "exclude": ["geometry"],
        },
    }
    items = []
    while True:
        page = request_json(STAC_SEARCH_URL, body)
        if page.get("type") != "FeatureCollection":
            raise RuntimeError(f"Earth Search returned an invalid page: {page}")
        items.extend(condensed_item(item) for item in page["features"])
        next_link = next(
            (link for link in page.get("links", []) if link.get("rel") == "next"),
            None,
        )
        if not next_link:
            break
        body = next_link["body"]
        print(f"Discovered {len(items)} catalogue items…", flush=True)
    return sorted(items, key=lambda item: (item["datetime"], item["id"]))


def projected_grid(first_red_href: str, bbox: list[float]) -> dict:
    dataset = gdal.Open(f"/vsicurl/{first_red_href}")
    if dataset is None:
        raise RuntimeError("GDAL could not open the first Sentinel-2 red band.")
    geotransform = dataset.GetGeoTransform()
    projection = dataset.GetProjection()
    source_srs = osr.SpatialReference()
    source_srs.ImportFromEPSG(4326)
    source_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    target_srs = osr.SpatialReference()
    target_srs.ImportFromWkt(projection)
    target_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(source_srs, target_srs)
    corners = [
        transform.TransformPoint(longitude, latitude)
        for longitude, latitude in [
            (bbox[0], bbox[1]),
            (bbox[0], bbox[3]),
            (bbox[2], bbox[1]),
            (bbox[2], bbox[3]),
        ]
    ]
    min_x = min(point[0] for point in corners)
    max_x = max(point[0] for point in corners)
    min_y = min(point[1] for point in corners)
    max_y = max(point[1] for point in corners)
    pixel_width = geotransform[1]
    pixel_height = abs(geotransform[5])
    x_offset = max(0, math.floor((min_x - geotransform[0]) / pixel_width) - 1)
    y_offset = max(0, math.floor((geotransform[3] - max_y) / pixel_height) - 1)
    x_end = min(
        dataset.RasterXSize,
        math.ceil((max_x - geotransform[0]) / pixel_width) + 1,
    )
    y_end = min(
        dataset.RasterYSize,
        math.ceil((geotransform[3] - min_y) / pixel_height) + 1,
    )
    width = x_end - x_offset
    height = y_end - y_offset
    output_geotransform = [
        geotransform[0] + x_offset * pixel_width,
        pixel_width,
        0,
        geotransform[3] - y_offset * pixel_height,
        0,
        -pixel_height,
    ]
    return {
        "width": width,
        "height": height,
        "projection": projection,
        "geotransform": output_geotransform,
        "bounds": [
            output_geotransform[0],
            output_geotransform[3] - height * pixel_height,
            output_geotransform[0] + width * pixel_width,
            output_geotransform[3],
        ],
    }


def coarser_native_grid(display_grid: dict, native_geotransform: list[float]) -> dict:
    """Cover the display bounds on the source Sentinel-2 20 m pixel grid."""
    pixel_width = native_geotransform[1]
    pixel_height = abs(native_geotransform[5])
    if not math.isclose(pixel_width, 20) or not math.isclose(pixel_height, 20):
        raise RuntimeError("The Sentinel-2 red-edge asset is not on a 20 m grid.")
    min_x, min_y, max_x, max_y = display_grid["bounds"]
    x_offset = math.floor((min_x - native_geotransform[0]) / pixel_width)
    y_offset = math.floor((native_geotransform[3] - max_y) / pixel_height)
    x_end = math.ceil((max_x - native_geotransform[0]) / pixel_width)
    y_end = math.ceil((native_geotransform[3] - min_y) / pixel_height)
    width = x_end - x_offset
    height = y_end - y_offset
    geotransform = [
        native_geotransform[0] + x_offset * pixel_width,
        pixel_width,
        0,
        native_geotransform[3] - y_offset * pixel_height,
        0,
        -pixel_height,
    ]
    if not math.isclose((geotransform[0] - native_geotransform[0]) % 20, 0):
        raise RuntimeError("The native 20 m X origin is misaligned.")
    if not math.isclose((native_geotransform[3] - geotransform[3]) % 20, 0):
        raise RuntimeError("The native 20 m Y origin is misaligned.")
    return {
        "width": width,
        "height": height,
        "projection": display_grid["projection"],
        "geotransform": geotransform,
        "bounds": [
            geotransform[0],
            geotransform[3] - height * 20,
            geotransform[0] + width * 20,
            geotransform[3],
        ],
    }


def source_geotransform(asset_href: str, expected_projection: str) -> list[float]:
    dataset = gdal.Open(f"/vsicurl/{asset_href}")
    if dataset is None:
        raise RuntimeError("GDAL could not open the Sentinel-2 20 m asset.")
    if dataset.GetProjection() != expected_projection:
        raise RuntimeError("The 10 m and 20 m Sentinel-2 assets use different projections.")
    return list(dataset.GetGeoTransform())


def scene_cache_context(
    mask_10m: np.ndarray,
    mask_20m: np.ndarray,
    edge_buffer_metres: float,
    geotransform_10m: list[float] | None = None,
    geotransform_20m: list[float] | None = None,
) -> str:
    digest = hashlib.sha256()
    digest.update(mask_10m.tobytes())
    digest.update(mask_20m.tobytes())
    digest.update(str(edge_buffer_metres).encode())
    digest.update(json.dumps(geotransform_10m, separators=(",", ":")).encode())
    digest.update(json.dumps(geotransform_20m, separators=(",", ":")).encode())
    return digest.hexdigest()


def cache_storage_array(values: np.ndarray) -> np.ndarray:
    return values.astype(np.float32, copy=False)


def field_mask(
    collection: dict,
    grid: dict,
    edge_buffer_metres: float,
) -> tuple[np.ndarray, list[dict]]:
    target_srs = osr.SpatialReference()
    target_srs.ImportFromWkt(grid["projection"])
    target_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    source_srs = osr.SpatialReference()
    source_srs.ImportFromEPSG(4326)
    source_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(source_srs, target_srs)
    vector_driver = ogr.GetDriverByName("MEM")
    vector_data = vector_driver.CreateDataSource("")
    layer = vector_data.CreateLayer("fields", target_srs, ogr.wkbMultiPolygon)
    layer.CreateField(ogr.FieldDefn("field_idx", ogr.OFTInteger))
    field_defn = layer.GetLayerDefn()
    fields = []
    for index, source_feature in enumerate(collection["features"], start=1):
        geometry = ogr.CreateGeometryFromJson(
            json.dumps(source_feature["geometry"])
        )
        geometry.Transform(transform)
        buffered = geometry.Buffer(-edge_buffer_metres)
        used_buffer = not buffered.IsEmpty()
        if used_buffer:
            geometry = buffered
        feature = ogr.Feature(field_defn)
        feature.SetField("field_idx", index)
        feature.SetGeometry(geometry)
        layer.CreateFeature(feature)
        properties = source_feature["properties"]
        fields.append(
            {
                "index": index,
                "fieldCode": properties["field_code"],
                "fieldName": properties["history_field_name"],
                "boundaryUuid": properties["uuid"],
                "recordedHectares": properties["recorded_hectares"],
                "edgeBufferMetres": edge_buffer_metres if used_buffer else 0,
            }
        )
    raster = gdal.GetDriverByName("MEM").Create(
        "",
        grid["width"],
        grid["height"],
        1,
        gdal.GDT_Int16,
    )
    raster.SetProjection(grid["projection"])
    raster.SetGeoTransform(grid["geotransform"])
    raster.GetRasterBand(1).Fill(0)
    gdal.RasterizeLayer(
        raster,
        [1],
        layer,
        options=["ATTRIBUTE=field_idx"],
    )
    mask = raster.ReadAsArray()
    for field in fields:
        field["interiorPixelCount"] = int(np.count_nonzero(mask == field["index"]))
        if field["interiorPixelCount"] == 0:
            raise RuntimeError(
                f"Edge buffering removed all pixels for {field['fieldName']}."
            )
    return mask, fields


def read_asset(asset: dict, grid: dict, resampling: str) -> np.ndarray:
    dataset = gdal.Open(f"/vsicurl/{asset['href']}")
    if dataset is None:
        raise RuntimeError(f"GDAL could not open {asset['href']}.")
    warped = gdal.Warp(
        "",
        dataset,
        format="MEM",
        outputBounds=grid["bounds"],
        width=grid["width"],
        height=grid["height"],
        dstSRS=grid["projection"],
        resampleAlg=resampling,
        srcNodata=asset["nodata"],
        dstNodata=asset["nodata"],
        multithread=False,
    )
    if warped is None:
        raise RuntimeError(f"GDAL could not read the farm window from {asset['href']}.")
    return warped.ReadAsArray()


def percentile(values: np.ndarray, value: float) -> float:
    return float(np.percentile(values, value))


def calculate_ndvi(
    red_raw: np.ndarray,
    nir_raw: np.ndarray,
    scl: np.ndarray,
    field_mask_array: np.ndarray,
    red_asset: dict,
    nir_asset: dict,
) -> np.ndarray:
    red = red_raw.astype(np.float32) * red_asset["scale"] + red_asset["offset"]
    nir = nir_raw.astype(np.float32) * nir_asset["scale"] + nir_asset["offset"]
    denominator = nir + red
    contaminated = dilate_boolean(np.isin(scl, (3, 8, 9, 10, 11)), 2)
    valid = (
        (field_mask_array > 0)
        & np.isin(scl, VALID_SCL_CLASSES)
        & ~contaminated
        & (red_raw != red_asset["nodata"])
        & (nir_raw != nir_asset["nodata"])
        & np.isfinite(red)
        & np.isfinite(nir)
        & (denominator > 0.02)
    )
    ndvi = np.full(field_mask_array.shape, np.nan, dtype=np.float32)
    ndvi[valid] = np.clip(
        (nir[valid] - red[valid]) / denominator[valid],
        -1,
        1,
    )
    return ndvi


def finite_summary(values: np.ndarray) -> dict:
    valid = values[np.isfinite(values)]
    return {
        "count": int(valid.size),
        "mean": round(float(np.mean(valid)), 4) if valid.size else None,
        "median": round(float(np.median(valid)), 4) if valid.size else None,
        "p10": round(percentile(valid, 10), 4) if valid.size else None,
        "p90": round(percentile(valid, 90), 4) if valid.size else None,
    }


def process_scene(
    item: dict,
    grid_10m: dict,
    grid_20m: dict,
    mask_10m: np.ndarray,
    mask_20m: np.ndarray,
    fields: list[dict],
    scenes_dir: Path,
    cache_context: str,
) -> dict:
    scene_file = scenes_dir / f"{item['id']}.npz"
    sidecar_file = scenes_dir / f"{item['id']}.json"
    if scene_file.exists() and sidecar_file.exists():
        cached = json.loads(sidecar_file.read_text())
        if (
            cached.get("featureVersion") == FEATURE_VERSION
            and cached.get("cacheContext") == cache_context
        ):
            with np.load(scene_file) as arrays:
                required = set(OPTICAL_FEATURES) | set(RAW_20M_BANDS)
                if required.issubset(arrays.files):
                    cached["sceneFile"] = str(scene_file)
                    return cached
    raw_10m = {
        name: read_asset(item[name], grid_10m, "near")
        for name in ("red", "nir")
    }
    raw_20m = {
        name: read_asset(item[name], grid_20m, "near")
        for name in RAW_20M_BANDS
    }
    scl_10m = read_asset(item["scl"], grid_10m, "near")
    scl_20m = read_asset(item["scl"], grid_20m, "near")
    features = calculate_sentinel2_features(
        raw_10m,
        raw_20m,
        item,
        scl_10m,
        scl_20m,
        mask_10m,
        mask_20m,
    )
    field_stats = {}
    for field in fields:
        pixels_10m = mask_10m == field["index"]
        pixels_20m = mask_20m == field["index"]
        total = field["interiorPixelCount"]
        native_total = field["native20mInteriorPixelCount"]
        feature_summaries = {}
        for name, values in features.items():
            pixels = pixels_10m if name in ("ndvi", "evi2") else pixels_20m
            feature_summaries[name] = finite_summary(values[pixels])
        ndvi_summary = feature_summaries["ndvi"]
        native_summary = feature_summaries["ndre"]
        field_scl = scl_10m[pixels_10m]
        field_stats[field["fieldCode"]] = {
            "validPixelCount": ndvi_summary["count"],
            "interiorPixelCount": total,
            "native20mValidPixelCount": native_summary["count"],
            "native20mInteriorPixelCount": native_total,
            "clearFraction": round(ndvi_summary["count"] / total, 3),
            "native20mClearFraction": round(
                native_summary["count"] / native_total,
                3,
            ),
            "meanNdvi": ndvi_summary["mean"],
            "medianNdvi": ndvi_summary["median"],
            "p10Ndvi": ndvi_summary["p10"],
            "p90Ndvi": ndvi_summary["p90"],
            "medianEvi2": feature_summaries["evi2"]["median"],
            "medianNdre": feature_summaries["ndre"]["median"],
            "medianNdwi": feature_summaries["ndwi"]["median"],
            "featureMedians": {
                name: summary["median"]
                for name, summary in feature_summaries.items()
            },
            "sclExcludedPixelCounts": {
                "cloudShadow": int(np.count_nonzero(field_scl == 3)),
                "cloud": int(
                    np.count_nonzero(np.isin(field_scl, (8, 9, 10)))
                ),
                "snowOrIce": int(np.count_nonzero(field_scl == 11)),
                "otherOrNoData": int(
                    np.count_nonzero(~np.isin(field_scl, (3, 4, 5, 8, 9, 10, 11)))
                ),
            },
        }
    np.savez_compressed(
        scene_file,
        **{
            name: cache_storage_array(values)
            for name, values in features.items()
        },
    )
    summary = {
        "id": item["id"],
        "date": item["date"],
        "datetime": item["datetime"],
        "tileCloudCover": item["tileCloudCover"],
        "platform": item["platform"],
        "processingBaseline": item["processingBaseline"],
        "featureVersion": FEATURE_VERSION,
        "cacheContext": cache_context,
        "nativeSupportMetres": {
            **{
                name: definition["native_support_metres"]
                for name, definition in OPTICAL_FEATURES.items()
            },
            **{name: 20 for name in RAW_20M_BANDS},
        },
        "displayGridMetres": 10,
        "sceneFile": str(scene_file),
        "fieldStats": field_stats,
    }
    sidecar_file.write_text(json.dumps(summary, separators=(",", ":")) + "\n")
    return summary


def crop_window(crop: str, harvest_year: int) -> tuple[date, date] | None:
    if crop.startswith("winter_"):
        return date(harvest_year - 1, 9, 1), date(harvest_year, 7, 15)
    if crop.startswith("spring_"):
        return date(harvest_year, 2, 15), date(harvest_year, 7, 31)
    if crop == "grass":
        return date(harvest_year, 3, 1), date(harvest_year, 9, 30)
    return None


def season_observation_support(
    selected: list[dict], field_code: str, crop: str
) -> dict:
    canopy = [
        (scene["date"], scene["fieldStats"][field_code].get("medianNdvi"))
        for scene in selected
        if scene["fieldStats"][field_code].get("medianNdvi") is not None
    ]
    observed_dates = sorted(item[0] for item in canopy)
    coverage_days = (
        (date.fromisoformat(observed_dates[-1]) - date.fromisoformat(observed_dates[0])).days
        if len(observed_dates) >= 2
        else 0
    )
    if len(selected) < 4:
        reason = "Fewer than four clear observations."
        peak_date = None
        pre_peak = post_peak = 0
        evidence_tier = None
    elif len(canopy) < 4:
        reason = "Fewer than four observations contain a canopy signal."
        peak_date = None
        pre_peak = post_peak = 0
        evidence_tier = None
    else:
        peak_date = max(canopy, key=lambda row: row[1])[0]
        pre_peak = sum(observed_on < peak_date for observed_on, _ in canopy)
        post_peak = sum(observed_on > peak_date for observed_on, _ in canopy)
        if crop == "grass":
            reason = "" if coverage_days >= 90 else "Grass evidence spans fewer than 90 days."
            evidence_tier = "grass-seasonal" if not reason else None
        elif pre_peak >= 2 and post_peak >= 1:
            reason = ""
            evidence_tier = "full-season"
        else:
            reason = ""
            evidence_tier = "partial-season"
    return {
        "modelEligible": not reason,
        "modelExclusionReason": reason or None,
        "evidenceTier": evidence_tier,
        "coverageDays": coverage_days,
        "estimatedPeakObservationDate": peak_date,
        "prePeakObservationCount": pre_peak,
        "postPeakObservationCount": post_peak,
    }


def season_composites(
    history: list[dict],
    scene_summaries: list[dict],
    mask_10m: np.ndarray,
    fields: list[dict],
    min_field_clear: float,
    farm_id: str,
) -> list[dict]:
    fields_by_code = {field["fieldCode"]: field for field in fields}
    scene_dates = {
        scene["id"]: datetime.strptime(scene["date"], "%Y-%m-%d").date()
        for scene in scene_summaries
    }
    seasons = []
    for history_row in sorted(
        history,
        key=lambda row: (row["field"], row["year"]),
    ):
        field_code = history_row["fieldCode"]
        field = fields_by_code.get(field_code)
        if not field or history_row["year"] < 2017:
            continue
        window = crop_window(history_row["cropNormalised"], history_row["year"])
        if not window:
            continue
        start, end = window
        candidates = [
            scene
            for scene in scene_summaries
            if start <= scene_dates[scene["id"]] <= end
        ]
        best_by_date = {}
        for scene in candidates:
            stats = scene["fieldStats"][field_code]
            existing = best_by_date.get(scene["date"])
            effective_clear_fraction = min(
                stats["clearFraction"],
                stats.get("native20mClearFraction", stats["clearFraction"]),
            )
            if (
                effective_clear_fraction >= min_field_clear
                and (
                    existing is None
                    or effective_clear_fraction
                    > min(
                        existing["fieldStats"][field_code]["clearFraction"],
                        existing["fieldStats"][field_code].get(
                            "native20mClearFraction",
                            existing["fieldStats"][field_code]["clearFraction"],
                        ),
                    )
                )
            ):
                best_by_date[scene["date"]] = scene
        selected = sorted(best_by_date.values(), key=lambda scene: scene["date"])
        field_pixels = mask_10m == field["index"]
        absolute_medians = {name: [] for name in OPTICAL_FEATURES}
        clear_fractions = []
        observation_counts = np.zeros(mask_10m.shape, dtype=np.uint16)
        for scene in selected:
            with np.load(scene["sceneFile"]) as scene_features:
                valid_pixels = field_pixels & np.isfinite(scene_features["ndvi"])
                observation_counts[valid_pixels] += 1
            stats = scene["fieldStats"][field_code]
            for name in OPTICAL_FEATURES:
                median = stats.get("featureMedians", {}).get(name)
                if median is not None:
                    absolute_medians[name].append(median)
            clear_fractions.append(
                min(
                    stats["clearFraction"],
                    stats.get("native20mClearFraction", stats["clearFraction"]),
                )
            )
        valid_composite_cells = int(
            np.count_nonzero(field_pixels & (observation_counts >= 4))
        )
        cell_coverage = valid_composite_cells / field["interiorPixelCount"]
        season_id = f"{farm_id}-{field_code}-{history_row['year']}"
        model_support = season_observation_support(
            selected,
            field_code,
            history_row["cropNormalised"],
        )
        mean_clear = statistics.fmean(clear_fractions) if clear_fractions else 0
        count_score = min(1, len(selected) / 6)
        quality = round(
            100
            * (
                mean_clear * 0.45
                + count_score * 0.35
                + cell_coverage * 0.20
            )
        )
        seasons.append(
            {
                "id": season_id,
                "fieldCode": field_code,
                "fieldName": history_row["field"],
                "harvestYear": history_row["year"],
                "cropNormalised": history_row["cropNormalised"],
                "windowStart": start.isoformat(),
                "windowEnd": end.isoformat(),
                "windowMethod": "Crop-specific dates inferred without sowing or harvest dates.",
                "windowComplete": end <= max(scene_dates.values()),
                "boundaryMethod": f"{PROFILE['boundaryLabel']} used as a provisional historical proxy.",
                "edgeBufferMetres": field["edgeBufferMetres"],
                "candidateObservationCount": len(candidates),
                "usableObservationCount": len(selected),
                "usableDates": [scene["date"] for scene in selected],
                "meanClearFraction": round(mean_clear, 3),
                "validCompositeCellCount": valid_composite_cells,
                "interiorPixelCount": field["interiorPixelCount"],
                "cellCoverage": round(cell_coverage, 3),
                "dataQuality": quality,
                **model_support,
                "peakFeatureMedians": {
                    name: (
                        round(max(values), 4)
                        if values
                        else None
                    )
                    for name, values in absolute_medians.items()
                },
                "peakMedianNdvi": (
                    round(max(absolute_medians["ndvi"]), 4)
                    if absolute_medians["ndvi"]
                    else None
                ),
            }
        )
    return seasons


def main() -> None:
    args = parse_args()
    if gdal is None:
        raise SystemExit(
            "GDAL Python bindings with /vsicurl/ support are required for optical ingestion."
        )
    boundaries_path = Path(args.boundaries)
    history_path = Path(args.history)
    output_dir = Path(args.output_dir)
    summary_path = Path(args.summary)
    output_dir.mkdir(parents=True, exist_ok=True)
    scenes_dir = output_dir / "scenes"
    scenes_dir.mkdir(parents=True, exist_ok=True)
    collection = json.loads(boundaries_path.read_text())
    history = json.loads(history_path.read_text())
    bbox = farm_bbox(collection)
    catalogue_path = output_dir / "stac-items.json"
    catalogue_config = {
        "collection": COLLECTION,
        "featureVersion": FEATURE_VERSION,
        "assets": list(SENTINEL_2_ASSETS),
        "bbox": bbox,
        "startDate": args.start_date,
        "endDate": args.end_date,
        "maxTileCloud": args.max_tile_cloud,
    }
    if catalogue_path.exists() and not args.refresh_catalogue:
        catalogue = json.loads(catalogue_path.read_text())
        if catalogue.get("query") != catalogue_config:
            raise RuntimeError(
                "Cached catalogue uses different parameters; rerun with --refresh-catalogue."
            )
        items = catalogue["items"]
    else:
        items = discover_items(
            bbox,
            args.start_date,
            args.end_date,
            args.max_tile_cloud,
        )
        catalogue_path.write_text(
            json.dumps(
                {"query": catalogue_config, "items": items},
                separators=(",", ":"),
            )
            + "\n"
        )
    crop_season_items = items
    print(
        json.dumps(
            {
                "catalogueItems": len(items),
                "cropSeasonItems": len(crop_season_items),
                "dateRange": (
                    [items[0]["date"], items[-1]["date"]] if items else []
                ),
            },
            indent=2,
        ),
        flush=True,
    )
    if args.discover_only:
        return
    if not crop_season_items:
        raise RuntimeError("No Sentinel-2 scenes were discovered.")
    mgrs_tile = require_single_mgrs_tile(crop_season_items)
    grid = projected_grid(crop_season_items[0]["red"]["href"], bbox)
    native_grid = coarser_native_grid(
        grid,
        source_geotransform(
            crop_season_items[0]["rededge1"]["href"],
            grid["projection"],
        ),
    )
    mask, fields = field_mask(
        collection,
        grid,
        args.edge_buffer_metres,
    )
    native_mask, native_fields = field_mask(
        collection,
        native_grid,
        args.edge_buffer_metres,
    )
    native_fields_by_code = {
        field["fieldCode"]: field for field in native_fields
    }
    for field in fields:
        native_field = native_fields_by_code[field["fieldCode"]]
        field["native20mInteriorPixelCount"] = native_field[
            "interiorPixelCount"
        ]
    cache_context = scene_cache_context(
        mask,
        native_mask,
        args.edge_buffer_metres,
        grid["geotransform"],
        native_grid["geotransform"],
    )
    np.savez_compressed(
        output_dir / "farm-grid.npz",
        field_mask=mask,
        field_mask_20m=native_mask,
        geotransform=np.array(grid["geotransform"]),
        geotransform_20m=np.array(native_grid["geotransform"]),
    )
    (output_dir / "farm-grid.json").write_text(
        json.dumps(
            {
                "width": grid["width"],
                "height": grid["height"],
                "geotransform": grid["geotransform"],
                "projection": grid["projection"],
                "nativeFeatureGrid": {
                    "width": native_grid["width"],
                    "height": native_grid["height"],
                    "geotransform": native_grid["geotransform"],
                    "bounds": native_grid["bounds"],
                    "pixelSizeMetres": 20,
                },
                "fields": fields,
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    selected_items = (
        crop_season_items[: args.max_scenes]
        if args.max_scenes
        else crop_season_items
    )
    if args.workers < 1 or args.workers > 8:
        raise RuntimeError("--workers must be between 1 and 8.")
    scene_summaries = []
    errors = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_items = {
            executor.submit(
                process_scene,
                item,
                grid,
                native_grid,
                mask,
                native_mask,
                fields,
                scenes_dir,
                cache_context,
            ): item
            for item in selected_items
        }
        for completed, future in enumerate(as_completed(future_items), start=1):
            item = future_items[future]
            try:
                scene_summaries.append(future.result())
                print(
                    f"[{completed}/{len(selected_items)}] {item['date']} {item['id']}",
                    flush=True,
                )
            except Exception as error:
                errors.append({"id": item["id"], "error": str(error)})
                print(
                    f"[{completed}/{len(selected_items)}] ERROR {item['id']}: {error}",
                    file=sys.stderr,
                    flush=True,
                )
    if errors and len(errors) / len(selected_items) > 0.05:
        raise RuntimeError(
            f"{len(errors)} of {len(selected_items)} scene reads failed."
        )
    seasons = season_composites(
        history,
        scene_summaries,
        mask,
        fields,
        args.min_field_clear,
        args.farm_id,
    )
    usable_seasons = [
        season for season in seasons if season["modelEligible"]
    ]
    summary = {
        "generatedAt": datetime.now().astimezone().isoformat(),
        "source": {
            "provider": "Element 84 Earth Search on AWS Open Data",
            "collection": COLLECTION,
            "product": "Sentinel-2 Level-2A surface reflectance COGs",
            "bands": {
                "10m": ["B04 red", "B08 NIR"],
                "20m": [
                    "B05 red edge 1",
                    "B06 red edge 2",
                    "B07 red edge 3",
                    "B8A narrow NIR",
                    "B11 SWIR 1",
                    "B12 SWIR 2",
                ],
            },
            "features": OPTICAL_FEATURES,
            "cloudMask": (
                "SCL classes 4 and 5 retained after a 20 m cloud, cirrus, shadow "
                "and snow buffer; all other classes excluded."
            ),
            "reflectanceCorrection": (
                "Per-asset STAC scale and offset applied before indices."
            ),
            "licence": "Copernicus Sentinel data free, full and open access.",
        },
        "query": catalogue_config,
        "method": {
            "pixelSizeMetres": 10,
            "nativeFeatureSupportMetres": {
                "ndvi": 10,
                "evi2": 10,
                "ndre": 20,
                "ndwi": 20,
                **{name: 20 for name in RAW_20M_BANDS},
            },
            "displayResampling": (
                "Native 20 m features are nearest-neighbour replicated onto "
                "the aligned 10 m display grid only after analysis."
            ),
            "edgeBufferMetres": args.edge_buffer_metres,
            "minFieldClearFraction": args.min_field_clear,
            "sameDayRule": "Highest clear fraction retained per field and date.",
            "relativePerformance": (
                "Equal average of available NDVI, EVI2, NDRE and NDWI "
                "within-field ranks per observation, then combined by crop season."
            ),
            "historicalBoundaryWarning": f"{PROFILE['boundaryLabel']} is a provisional proxy for historical imagery where older boundaries are unavailable.",
        },
        "grid": {
            "width": grid["width"],
            "height": grid["height"],
            "bounds": grid["bounds"],
            "fields": fields,
            "mgrsTile": mgrs_tile,
        },
        "catalogueItemCount": len(items),
        "growingSeasonItemCount": len(crop_season_items),
        "growingSeasonDateCount": len(
            {item["date"] for item in crop_season_items}
        ),
        "processedSceneCount": len(scene_summaries),
        "sceneErrorCount": len(errors),
        "sceneErrors": errors,
        "fieldSeasonCount": len(seasons),
        "usableFieldSeasonCount": len(usable_seasons),
        "seasons": seasons,
    }
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(
        json.dumps(
            {
                "processedScenes": len(scene_summaries),
                "errors": len(errors),
                "fieldSeasons": len(seasons),
                "usableFieldSeasons": len(usable_seasons),
                "summary": str(summary_path),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
