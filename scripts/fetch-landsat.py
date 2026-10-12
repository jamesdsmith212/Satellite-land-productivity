#!/usr/bin/env python3
"""Build a separate, native-30 m Landsat crop-history evidence track.

The track is intentionally not fused into the Sentinel-2 performance score.
Landsat Collection 2 Level-2 surface reflectance is read from Microsoft
Planetary Computer with anonymous, short-lived SAS signing.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import math
import urllib.parse
import urllib.request
from datetime import date, datetime
from pathlib import Path

import numpy as np

try:
    from osgeo import gdal, ogr, osr
except ImportError:  # Pure calculation and catalogue helpers remain testable.
    gdal = ogr = osr = None

from farm_config import (
    BOUNDARIES_PATH,
    FARM_CRS,
    FARM_ID,
    HISTORY_PATH,
    LANDSAT_DIR,
    LANDSAT_SUMMARY_PATH,
    PROFILE,
    PUBLIC_LANDSAT_DIR,
)
from satellite_features import (
    average_percentile_rank,
    combine_relative_features,
    dilate_boolean,
    safe_normalised_difference,
)


STAC_SEARCH_URL = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
SAS_TOKEN_URL = "https://planetarycomputer.microsoft.com/api/sas/v1/token/landsat-c2-l2"
COLLECTION = "landsat-c2-l2"
FEATURE_VERSION = "landsat-c2-l2-v1"
PIXEL_SIZE_METRES = 30
REQUIRED_ASSETS = ("red", "nir08", "swir16", "swir22", "qa_pixel", "qa_radsat")
REFLECTANCE_ASSETS = ("red", "nir08", "swir16", "swir22")
SUPPORTED_PLATFORMS = {
    "landsat-5",
    "landsat-7",
    "landsat-8",
    "landsat-9",
}
LANDSAT_FEATURES = {
    "ndvi": {"label": "NDVI", "native_support_metres": 30},
    "evi2": {"label": "EVI2", "native_support_metres": 30},
    "ndwi": {
        "label": "NDWI / NDMI water-status index",
        "native_support_metres": 30,
    },
}
QA_EXCLUDED_BITS = (0, 1, 2, 3, 4, 5, 7)

if gdal is not None:
    gdal.UseExceptions()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boundaries", type=Path, default=BOUNDARIES_PATH)
    parser.add_argument("--history", type=Path, default=HISTORY_PATH)
    parser.add_argument("--output-dir", type=Path, default=LANDSAT_DIR)
    parser.add_argument("--public-dir", type=Path, default=PUBLIC_LANDSAT_DIR)
    parser.add_argument("--summary", type=Path, default=LANDSAT_SUMMARY_PATH)
    parser.add_argument("--start-date", default="2008-01-01")
    parser.add_argument("--end-date", default=date.today().isoformat())
    parser.add_argument("--cloud-cover", type=float, default=80)
    parser.add_argument("--edge-buffer-metres", type=float, default=15)
    parser.add_argument("--min-field-clear", type=float, default=0.35)
    parser.add_argument("--discover-only", action="store_true")
    parser.add_argument("--max-scenes", type=int)
    parser.add_argument("--workers", type=int, default=4)
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


def request_json(url: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "user-agent": "Satellite-Productivity-Detection/0.1 local-farm-analysis",
        },
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)


def asset_metadata(asset: dict) -> dict:
    raster_bands = asset.get("raster:bands") or [{}]
    band = raster_bands[0]
    return {
        "href": asset["href"],
        "scale": float(band.get("scale", 1)),
        "offset": float(band.get("offset", 0)),
        "nodata": band.get("nodata", 0),
    }


def normalise_stac_item(item: dict) -> dict | None:
    properties = item.get("properties", {})
    platform = str(properties.get("platform", "")).lower()
    product_id = str(properties.get("landsat:scene_id") or item.get("id", ""))
    processing_level = str(properties.get("landsat:processing_level", ""))
    if platform not in SUPPORTED_PLATFORMS:
        return None
    if processing_level and processing_level not in ("L2SP", "L2SR"):
        return None
    assets = item.get("assets", {})
    if not all(name in assets for name in REQUIRED_ASSETS):
        return None
    recorded = {
        "id": item["id"],
        "sceneId": product_id,
        "date": properties["datetime"][:10],
        "datetime": properties["datetime"],
        "platform": platform,
        "processingLevel": processing_level or None,
        "cloudCover": properties.get("eo:cloud_cover"),
        "path": properties.get("landsat:wrs_path"),
        "row": properties.get("landsat:wrs_row"),
    }
    recorded.update({name: asset_metadata(assets[name]) for name in REQUIRED_ASSETS})
    return recorded


def stac_items(
    bbox: list[float],
    start_date: str,
    end_date: str,
    cloud_cover: float,
) -> list[dict]:
    payload = {
        "collections": [COLLECTION],
        "bbox": bbox,
        "datetime": f"{start_date}T00:00:00Z/{end_date}T23:59:59Z",
        "query": {"eo:cloud_cover": {"lte": cloud_cover}},
        "limit": 1000,
    }
    page = request_json(STAC_SEARCH_URL, payload)
    features = list(page.get("features", []))
    while True:
        next_link = next(
            (link for link in page.get("links", []) if link.get("rel") == "next"),
            None,
        )
        if not next_link:
            break
        page = request_json(next_link["href"], next_link.get("body"))
        features.extend(page.get("features", []))
    items = [normalise_stac_item(item) for item in features]
    return sorted((item for item in items if item), key=lambda item: item["datetime"])


def evenly_spaced(items: list[dict], limit: int | None) -> list[dict]:
    """Keep a deterministic pilot sample spanning the discovered time range."""
    if limit is None or limit >= len(items):
        return items
    if limit <= 0:
        return []
    indices = np.linspace(0, len(items) - 1, limit, dtype=int)
    return [items[index] for index in dict.fromkeys(indices.tolist())]


def projected_grid(collection: dict, projection: str = FARM_CRS) -> dict:
    if osr is None:
        raise RuntimeError("GDAL Python bindings are required for Landsat ingestion.")
    source = osr.SpatialReference()
    source.ImportFromEPSG(4326)
    source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    target = osr.SpatialReference()
    target.SetFromUserInput(projection)
    target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(source, target)
    transformed = [
        transform.TransformPoint(point[0], point[1])
        for feature in collection["features"]
        for point in flatten_coordinates(feature["geometry"]["coordinates"])
    ]
    min_x = math.floor(min(point[0] for point in transformed) / PIXEL_SIZE_METRES) * PIXEL_SIZE_METRES
    min_y = math.floor(min(point[1] for point in transformed) / PIXEL_SIZE_METRES) * PIXEL_SIZE_METRES
    max_x = math.ceil(max(point[0] for point in transformed) / PIXEL_SIZE_METRES) * PIXEL_SIZE_METRES
    max_y = math.ceil(max(point[1] for point in transformed) / PIXEL_SIZE_METRES) * PIXEL_SIZE_METRES
    width = int(round((max_x - min_x) / PIXEL_SIZE_METRES))
    height = int(round((max_y - min_y) / PIXEL_SIZE_METRES))
    return {
        "width": width,
        "height": height,
        "projection": target.ExportToWkt(),
        "projectionName": projection,
        "geotransform": [min_x, PIXEL_SIZE_METRES, 0, max_y, 0, -PIXEL_SIZE_METRES],
        "bounds": [min_x, min_y, max_x, max_y],
    }


def field_mask(collection: dict, grid: dict, edge_buffer_metres: float) -> tuple[np.ndarray, list[dict]]:
    target = osr.SpatialReference()
    target.ImportFromWkt(grid["projection"])
    target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    source = osr.SpatialReference()
    source.ImportFromEPSG(4326)
    source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(source, target)
    vector = ogr.GetDriverByName("MEM").CreateDataSource("")
    layer = vector.CreateLayer("fields", target, ogr.wkbMultiPolygon)
    layer.CreateField(ogr.FieldDefn("field_idx", ogr.OFTInteger))
    definition = layer.GetLayerDefn()
    fields = []
    for index, source_feature in enumerate(collection["features"], start=1):
        geometry = ogr.CreateGeometryFromJson(json.dumps(source_feature["geometry"]))
        geometry.Transform(transform)
        buffered = geometry.Buffer(-edge_buffer_metres)
        used_buffer = not buffered.IsEmpty()
        feature = ogr.Feature(definition)
        feature.SetField("field_idx", index)
        feature.SetGeometry(buffered if used_buffer else geometry)
        layer.CreateFeature(feature)
        properties = source_feature["properties"]
        fields.append({
            "index": index,
            "fieldCode": str(properties["field_code"]),
            "fieldName": properties["history_field_name"],
            "boundaryUuid": properties["uuid"],
            "recordedHectares": properties.get("recorded_hectares"),
            "edgeBufferMetres": edge_buffer_metres if used_buffer else 0,
        })
    raster = gdal.GetDriverByName("MEM").Create("", grid["width"], grid["height"], 1, gdal.GDT_Int16)
    raster.SetProjection(grid["projection"])
    raster.SetGeoTransform(grid["geotransform"])
    raster.GetRasterBand(1).Fill(0)
    gdal.RasterizeLayer(raster, [1], layer, options=["ATTRIBUTE=field_idx"])
    mask = raster.ReadAsArray()
    for field in fields:
        field["interiorPixelCount"] = int(np.count_nonzero(mask == field["index"]))
        if field["interiorPixelCount"] == 0:
            raise RuntimeError(f"No retained 30 m pixels for {field['fieldName']}.")
    return mask, fields


def cache_context(mask: np.ndarray, grid: dict, edge_buffer_metres: float) -> str:
    digest = hashlib.sha256()
    digest.update(mask.tobytes())
    digest.update(json.dumps(grid["geotransform"], separators=(",", ":")).encode())
    digest.update(str(edge_buffer_metres).encode())
    digest.update(FEATURE_VERSION.encode())
    return digest.hexdigest()


def landsat_qa_invalid(qa_pixel: np.ndarray, qa_radsat: np.ndarray) -> np.ndarray:
    excluded = np.zeros(qa_pixel.shape, dtype=bool)
    qa = qa_pixel.astype(np.uint16, copy=False)
    for bit in QA_EXCLUDED_BITS:
        excluded |= (qa & (1 << bit)) != 0
    excluded |= qa_radsat.astype(np.uint16, copy=False) != 0
    return dilate_boolean(excluded, 1)


def calculate_landsat_features(raw: dict[str, np.ndarray], assets: dict[str, dict], field_pixels: np.ndarray) -> dict[str, np.ndarray]:
    reflectance = {
        name: raw[name].astype(np.float32) * assets[name].get("scale", 1) + assets[name].get("offset", 0)
        for name in REFLECTANCE_ASSETS
    }
    valid = field_pixels & ~landsat_qa_invalid(raw["qa_pixel"], raw["qa_radsat"])
    for name in REFLECTANCE_ASSETS:
        valid &= raw[name] != assets[name].get("nodata", 0)
        valid &= np.isfinite(reflectance[name])
    red = reflectance["red"]
    nir = reflectance["nir08"]
    swir = reflectance["swir16"]
    ndvi = safe_normalised_difference(nir, red, valid)
    ndwi = safe_normalised_difference(nir, swir, valid)
    evi2 = np.full(red.shape, np.nan, dtype=np.float32)
    denominator = nir + 2.4 * red + 1
    usable = valid & np.isfinite(denominator) & (denominator > 0.02)
    evi2[usable] = np.clip(2.5 * (nir[usable] - red[usable]) / denominator[usable], -1, 1)
    masked_bands = {}
    for name, values in reflectance.items():
        masked = np.full(values.shape, np.nan, dtype=np.float32)
        masked[valid] = values[valid]
        masked_bands[name] = masked
    return {"ndvi": ndvi, "evi2": evi2, "ndwi": ndwi, **masked_bands}


def relative_score(features: dict[str, np.ndarray], mask: np.ndarray, fields: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    score = np.full(mask.shape, np.nan, dtype=np.float32)
    count = np.zeros(mask.shape, dtype=np.uint8)
    for field in fields:
        pixels = mask == field["index"]
        ranks = []
        for name in LANDSAT_FEATURES:
            values = np.where(pixels, features[name], np.nan)
            ranks.append(average_percentile_rank(values))
        field_score, field_count = combine_relative_features(ranks)
        score[pixels] = field_score[pixels]
        count[pixels] = field_count[pixels]
    return score, count


def signed_href(href: str, token: str) -> str:
    separator = "&" if "?" in href else "?"
    return f"{href}{separator}{token.lstrip('?')}"


def sas_token() -> str:
    token = request_json(SAS_TOKEN_URL).get("token")
    if not token:
        raise RuntimeError("Planetary Computer did not return a Landsat SAS token.")
    return token


def read_asset(asset: dict, grid: dict, token: str, resampling: str = "near") -> np.ndarray:
    href = signed_href(asset["href"], token)
    dataset = gdal.Open(f"/vsicurl/{href}")
    if dataset is None:
        raise RuntimeError(f"GDAL could not open Landsat asset {asset['href']}.")
    warped = gdal.Warp(
        "", dataset, format="MEM", outputBounds=grid["bounds"],
        width=grid["width"], height=grid["height"], dstSRS=grid["projection"],
        resampleAlg=resampling, srcNodata=asset.get("nodata", 0),
        dstNodata=asset.get("nodata", 0), multithread=False,
    )
    if warped is None:
        raise RuntimeError(f"GDAL could not read {asset['href']}.")
    return warped.ReadAsArray()


def finite_median(values: np.ndarray) -> float | None:
    finite = values[np.isfinite(values)]
    return round(float(np.median(finite)), 4) if finite.size else None


def process_scene(item: dict, grid: dict, mask: np.ndarray, fields: list[dict], scenes_dir: Path, context: str, token: str) -> dict:
    array_path = scenes_dir / f"{item['id']}.npz"
    sidecar_path = scenes_dir / f"{item['id']}.json"
    if array_path.exists() and sidecar_path.exists():
        cached = json.loads(sidecar_path.read_text())
        if cached.get("featureVersion") == FEATURE_VERSION and cached.get("cacheContext") == context:
            with np.load(array_path) as arrays:
                if {"ndvi", "evi2", "ndwi", "relative_score"}.issubset(arrays.files):
                    cached["sceneFile"] = str(array_path)
                    return cached
    raw = {name: read_asset(item[name], grid, token) for name in REQUIRED_ASSETS}
    features = calculate_landsat_features(raw, item, mask > 0)
    score, feature_count = relative_score(features, mask, fields)
    field_stats = {}
    for field in fields:
        pixels = mask == field["index"]
        valid_count = int(np.count_nonzero(np.isfinite(features["ndvi"][pixels])))
        field_stats[field["fieldCode"]] = {
            "validPixelCount": valid_count,
            "interiorPixelCount": field["interiorPixelCount"],
            "clearFraction": round(valid_count / field["interiorPixelCount"], 3),
            "featureMedians": {name: finite_median(features[name][pixels]) for name in LANDSAT_FEATURES},
        }
    np.savez_compressed(
        array_path,
        **{name: values.astype(np.float32, copy=False) for name, values in features.items()},
        relative_score=score.astype(np.float32, copy=False),
        relative_feature_count=feature_count,
    )
    summary = {
        **{key: item.get(key) for key in ("id", "sceneId", "date", "datetime", "platform", "processingLevel", "cloudCover", "path", "row")},
        "featureVersion": FEATURE_VERSION,
        "cacheContext": context,
        "nativeSupportMetres": 30,
        "sceneFile": str(array_path),
        "fieldStats": field_stats,
    }
    sidecar_path.write_text(json.dumps(summary, separators=(",", ":")) + "\n")
    return summary


def crop_window(crop: str, harvest_year: int) -> tuple[date, date] | None:
    crop = (crop or "").lower()
    if crop.startswith("winter_"):
        return date(harvest_year - 1, 9, 1), date(harvest_year, 7, 15)
    if crop.startswith("spring_"):
        return date(harvest_year, 2, 15), date(harvest_year, 7, 31)
    if crop in ("temporary_grass", "permanent_grass", "grass"):
        return date(harvest_year, 3, 1), date(harvest_year, 9, 30)
    if crop in ("fallow", "unknown_crop", ""):
        return None
    return date(harvest_year - 1, 9, 1), date(harvest_year, 8, 31)


def choose_field_dates(history: list[dict], scenes: list[dict], fields: list[dict], min_clear: float) -> list[dict]:
    seasons = []
    field_codes = {field["fieldCode"] for field in fields}
    for record in history:
        field_code = str(record.get("fieldCode", ""))
        if field_code not in field_codes:
            continue
        harvest_year = int(record["year"])
        window = crop_window(record.get("cropNormalised", ""), harvest_year)
        if not window:
            continue
        candidates = []
        for scene in scenes:
            observed = date.fromisoformat(scene["date"])
            stats = scene["fieldStats"].get(field_code)
            if window[0] <= observed <= window[1] and stats and stats["clearFraction"] >= min_clear:
                candidates.append(scene)
        best_by_date = {}
        for scene in candidates:
            clear = scene["fieldStats"][field_code]["clearFraction"]
            existing = best_by_date.get(scene["date"])
            if existing is None or clear > existing["fieldStats"][field_code]["clearFraction"]:
                best_by_date[scene["date"]] = scene
        selected = sorted(best_by_date.values(), key=lambda scene: scene["date"])
        seasons.append({
            "id": f"landsat-{field_code}-{harvest_year}",
            "fieldCode": field_code,
            "harvestYear": harvest_year,
            "crop": record.get("cropNormalised") or "unknown_crop",
            "windowStart": window[0].isoformat(),
            "windowEnd": window[1].isoformat(),
            "observationCount": len(selected),
            "modelEligible": len(selected) >= 3,
            "sourceDates": [scene["date"] for scene in selected],
            "sourceSceneIds": [scene["id"] for scene in selected],
        })
    return seasons


def write_public_payloads(seasons: list[dict], scenes: list[dict], mask: np.ndarray, fields: list[dict], public_dir: Path) -> None:
    public_dir.mkdir(parents=True, exist_ok=True)
    scenes_by_id = {scene["id"]: scene for scene in scenes}
    for field in fields:
        pixels = np.argwhere(mask == field["index"])
        cells = [{"id": index, "row": int(row), "column": int(column)} for index, (row, column) in enumerate(pixels)]
        field_seasons = []
        for season in seasons:
            if season["fieldCode"] != field["fieldCode"]:
                continue
            observations = []
            stack = []
            for scene_id in season["sourceSceneIds"]:
                scene = scenes_by_id[scene_id]
                with np.load(scene["sceneFile"]) as arrays:
                    values = arrays["relative_score"][mask == field["index"]].astype(np.float32)
                stack.append(values)
                observations.append({
                    "date": scene["date"],
                    "sceneId": scene["id"],
                    "platform": scene["platform"],
                    "clearFraction": scene["fieldStats"][field["fieldCode"]]["clearFraction"],
                    "scores": [None if not np.isfinite(value) else round(float(value), 1) for value in values],
                })
            if stack:
                stacked = np.stack(stack)
                valid_counts = np.sum(np.isfinite(stacked), axis=0)
                composite = np.full(stacked.shape[1], np.nan, dtype=np.float32)
                np.divide(
                    np.nansum(stacked, axis=0),
                    valid_counts,
                    out=composite,
                    where=valid_counts > 0,
                )
            else:
                composite = np.full(len(cells), np.nan, dtype=np.float32)
            field_seasons.append({
                **season,
                "compositeScores": [None if not np.isfinite(value) else round(float(value), 1) for value in composite],
                "observations": observations,
            })
        payload = {
            "field": field,
            "nativeSupportMetres": 30,
            "cells": cells,
            "seasons": field_seasons,
            "warning": "Separate Landsat evidence track; not fused into the Sentinel-2 score.",
        }
        (public_dir / f"{FARM_ID}-{field['fieldCode']}.json").write_text(json.dumps(payload, separators=(",", ":")) + "\n")


def main() -> None:
    args = parse_args()
    boundaries = json.loads(args.boundaries.read_text())
    history = json.loads(args.history.read_text())
    items = stac_items(farm_bbox(boundaries), args.start_date, args.end_date, args.cloud_cover)
    if args.discover_only:
        print(json.dumps({
            "collection": COLLECTION,
            "startDate": args.start_date,
            "endDate": args.end_date,
            "itemCount": len(items),
            "dateCount": len({item["date"] for item in items}),
            "platformCounts": {platform: sum(item["platform"] == platform for item in items) for platform in sorted({item["platform"] for item in items})},
            "firstDate": items[0]["date"] if items else None,
            "lastDate": items[-1]["date"] if items else None,
            "credentialsRequired": False,
        }, indent=2))
        return
    selected = evenly_spaced(items, args.max_scenes)
    grid = projected_grid(boundaries)
    mask, fields = field_mask(boundaries, grid, args.edge_buffer_metres)
    context = cache_context(mask, grid, args.edge_buffer_metres)
    scenes_dir = args.output_dir / "scenes"
    scenes_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "farm-grid.json").write_text(json.dumps(grid, indent=2) + "\n")
    np.savez_compressed(args.output_dir / "farm-grid.npz", field_mask=mask)
    scenes = []
    errors = []
    completed = 0
    batch_size = 100
    for batch_start in range(0, len(selected), batch_size):
        batch = selected[batch_start : batch_start + batch_size]
        token = sas_token()
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
            futures = {
                executor.submit(
                    process_scene,
                    item,
                    grid,
                    mask,
                    fields,
                    scenes_dir,
                    context,
                    token,
                ): item
                for item in batch
            }
            for future in as_completed(futures):
                item = futures[future]
                completed += 1
                try:
                    scenes.append(future.result())
                    print(
                        f"[{completed}/{len(selected)}] {item['date']} {item['platform']}",
                        flush=True,
                    )
                except Exception as error:
                    errors.append({"id": item["id"], "date": item["date"], "error": str(error)})
                    print(f"[{completed}/{len(selected)}] ERROR {item['id']}: {error}", flush=True)
    scenes.sort(key=lambda scene: scene["datetime"])
    if selected and len(errors) / len(selected) > 0.1:
        raise RuntimeError(f"{len(errors)} of {len(selected)} Landsat scene reads failed.")
    seasons = choose_field_dates(history, scenes, fields, args.min_field_clear)
    write_public_payloads(seasons, scenes, mask, fields, args.public_dir)
    summary = {
        "generatedAt": datetime.now().astimezone().isoformat(),
        "source": {
            "provider": "Microsoft Planetary Computer",
            "collection": COLLECTION,
            "product": "Landsat Collection 2 Level-2 surface reflectance",
            "credentialsRequired": False,
            "features": LANDSAT_FEATURES,
            "redEdgeAvailable": False,
        },
        "query": {"startDate": args.start_date, "endDate": args.end_date, "maxCloudCover": args.cloud_cover},
        "method": {
            "nativeSupportMetres": 30,
            "analysisGrid": "Common farm grid aligned to 30 m multiples in the configured farm CRS.",
            "edgeBufferMetres": args.edge_buffer_metres,
            "sameDayRule": "Highest clear fraction retained per field and date.",
            "qaMask": "QA_PIXEL fill, cloud, cirrus, shadow, snow and water bits plus QA_RADSAT; buffered by one 30 m pixel.",
            "relativePerformance": "Equal average of available within-field NDVI, EVI2 and NDWI ranks.",
            "fusionRule": "Not fused into the Sentinel-2 performance score.",
            "historicalBoundaryWarning": f"{PROFILE['boundaryLabel']} is a provisional proxy where older boundaries are unavailable.",
        },
        "grid": {**grid, "projection": grid["projectionName"], "fields": fields},
        "catalogueItemCount": len(items),
        "processedSceneCount": len(scenes),
        "scenes": scenes,
        "sceneErrorCount": len(errors),
        "sceneErrors": errors,
        "fieldSeasonCount": len(seasons),
        "usableFieldSeasonCount": sum(season["modelEligible"] for season in seasons),
        "seasons": seasons,
    }
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"processedScenes": len(scenes), "errors": len(errors), "fieldSeasons": len(seasons), "summary": str(args.summary)}, indent=2))


if __name__ == "__main__":
    main()
