#!/usr/bin/env python3
"""Discover and ingest analysis-ready Sentinel-1 RTC features locally.

NASA OPERA RTC-S1 gamma0 products are accepted. Raw Sentinel-1 GRD digital
numbers are intentionally rejected. Remote raster access requires an
EARTHDATA_TOKEN; metadata discovery does not.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
try:
    from osgeo import gdal, ogr, osr
except ImportError:  # Pure validation and discovery helpers remain testable.
    gdal = ogr = osr = None
from farm_config import (
    BOUNDARIES_PATH,
    NDVI_DIR,
    RADAR_DIR,
    RADAR_SUMMARY_PATH,
)
from satellite_features import RADAR_FEATURES, calculate_sentinel1_rtc_features


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
CMR_GRANULES_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"
EDL_USER_TOKEN_URL = "https://urs.earthdata.nasa.gov/oauth/tokens/user"
ASF_EDL_CLIENT_ID = "BO_n7nTIlMljdvU6kRRB3g"
COLLECTION = "OPERA_L2_RTC-S1_V1"
PRODUCT_MARKER = "OPERA_L2_RTC-S1"
ACCEPTED_UNITS = "linear_gamma0"
FEATURE_VERSION = "opera-rtc-s1-v2"
ALLOWED_REMOTE_HOST_SUFFIXES = (
    ".earthdata.nasa.gov",
    ".earthdatacloud.nasa.gov",
    ".asf.alaska.edu",
    ".amazonaws.com",
)

if gdal is not None:
    gdal.UseExceptions()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--boundaries",
        type=Path,
        default=BOUNDARIES_PATH,
    )
    parser.add_argument(
        "--grid",
        type=Path,
        default=NDVI_DIR / "farm-grid.json",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=RADAR_DIR,
    )
    parser.add_argument(
        "--summary",
        type=Path,
        default=RADAR_SUMMARY_PATH,
    )
    parser.add_argument("--start-date", default="2020-12-31")
    parser.add_argument("--end-date", default=date.today().isoformat())
    parser.add_argument(
        "--manifest",
        type=Path,
        help=(
            "Optional local JSON manifest with OPERA RTC VV/VH/mask assets. "
            "This bypasses CMR discovery."
        ),
    )
    parser.add_argument("--discover-only", action="store_true")
    sampling = parser.add_mutually_exclusive_group()
    sampling.add_argument("--max-scenes", type=int)
    sampling.add_argument(
        "--scenes-per-harvest-year",
        type=int,
        help=(
            "Select this many dates across each September-August crop season. "
            "One granule is retained per selected acquisition date."
        ),
    )
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


def farm_bbox(boundaries: dict) -> list[float]:
    points = [
        coordinate
        for feature in boundaries["features"]
        for coordinate in flatten_coordinates(feature["geometry"]["coordinates"])
    ]
    return [
        min(point[0] for point in points),
        min(point[1] for point in points),
        max(point[0] for point in points),
        max(point[1] for point in points),
    ]


def cmr_items(
    bbox: list[float],
    start_date: str,
    end_date: str,
) -> list[dict]:
    query = urllib.parse.urlencode(
        {
            "short_name": COLLECTION,
            "bounding_box": ",".join(str(value) for value in bbox),
            "temporal": (
                f"{start_date}T00:00:00Z,{end_date}T23:59:59Z"
            ),
            "page_size": 2000,
            "sort_key": "start_date",
        }
    )
    request = urllib.request.Request(
        f"{CMR_GRANULES_URL}?{query}",
        headers={
            "accept": "application/json",
            "user-agent": "Satellite-Productivity-Detection/0.1 local-farm-analysis",
        },
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        feed = json.load(response)["feed"]
    items = []
    for entry in feed.get("entry", []):
        title = entry.get("title", "")
        links = [
            link["href"]
            for link in entry.get("links", [])
            if link.get("href")
        ]
        lower_links = {
            urllib.parse.urlparse(link).path.lower(): link
            for link in links
        }

        def find_asset(suffixes: tuple[str, ...]) -> str | None:
            return next(
                (
                    original
                    for lowered, original in lower_links.items()
                    if lowered.endswith(suffixes)
                ),
                None,
            )

        vv = find_asset(("_vv.tif", "_vv.tiff"))
        vh = find_asset(("_vh.tif", "_vh.tiff"))
        mask = find_asset(("_mask.tif", "_mask.tiff"))
        identity = opera_identity(entry.get("producer_granule_id") or title)
        orbit_domains = entry.get("orbit_calculated_spatial_domains") or []
        orbit = orbit_domains[0].get("orbit_calculated_spatial_domain", {}) if orbit_domains else {}
        items.append(
            {
                "id": entry.get("producer_granule_id") or title,
                "date": entry.get("time_start", "")[:10],
                "productType": COLLECTION,
                "units": ACCEPTED_UNITS,
                "vv": vv,
                "vh": vh,
                "mask": mask,
                "metadataLinkCount": len(links),
                "acquisitionDatetime": identity["acquisitionDatetime"] or entry.get("time_start"),
                "burstId": identity["burstId"],
                "spacecraft": identity["spacecraft"],
                "orbitDirection": entry.get("orbit_direction"),
                "startOrbitNumber": orbit.get("start_orbit_number"),
                "stopOrbitNumber": orbit.get("stop_orbit_number"),
            }
        )
    return items


def load_manifest(path: Path) -> list[dict]:
    payload = json.loads(path.read_text())
    items = payload.get("items", payload)
    if not isinstance(items, list):
        raise ValueError("The RTC manifest must contain an items array.")
    return items


def validate_item(item: dict) -> None:
    if item.get("productType") != COLLECTION:
        raise ValueError(
            f"{item.get('id', 'Radar item')} is not {COLLECTION}; "
            "raw GRD products are not accepted."
        )
    if item.get("units") != ACCEPTED_UNITS:
        raise ValueError(
            f"{item.get('id', 'Radar item')} must declare linear_gamma0 units."
        )
    if PRODUCT_MARKER not in item.get("id", ""):
        raise ValueError(
            f"{item.get('id', 'Radar item')} does not identify an OPERA RTC product."
        )
    if not item.get("vv") or not item.get("vh"):
        raise ValueError(
            f"{item['id']} has no separate VV and VH RTC assets."
        )


def opera_identity(product_id: str) -> dict:
    """Extract stable acquisition identity without guessing absent metadata."""
    burst = re.search(r"RTC-S1_([^_]+)_([0-9]{8}T[0-9]{6}Z)", product_id)
    spacecraft = re.search(r"_(S1[ABC])_", product_id)
    acquired = None
    if burst:
        acquired = datetime.strptime(burst.group(2), "%Y%m%dT%H%M%SZ").isoformat() + "Z"
    return {
        "burstId": burst.group(1) if burst else None,
        "acquisitionDatetime": acquired,
        "spacecraft": spacecraft.group(1) if spacecraft else None,
    }


def native_grid(display_grid: dict) -> dict:
    """Create a fixed 30 m analysis grid without inheriting a 10 m origin."""
    pixel_size = 30
    if "bounds" in display_grid:
        min_x, min_y, max_x, max_y = display_grid["bounds"]
    else:
        transform = display_grid["geotransform"]
        corners = [
            (
                transform[0] + column * transform[1] + row * transform[2],
                transform[3] + column * transform[4] + row * transform[5],
            )
            for column, row in (
                (0, 0),
                (display_grid["width"], 0),
                (0, display_grid["height"]),
                (display_grid["width"], display_grid["height"]),
            )
        ]
        min_x = min(point[0] for point in corners)
        min_y = min(point[1] for point in corners)
        max_x = max(point[0] for point in corners)
        max_y = max(point[1] for point in corners)
    min_x = math.floor(min_x / pixel_size) * pixel_size
    min_y = math.floor(min_y / pixel_size) * pixel_size
    max_x = math.ceil(max_x / pixel_size) * pixel_size
    max_y = math.ceil(max_y / pixel_size) * pixel_size
    width = int(round((max_x - min_x) / pixel_size))
    height = int(round((max_y - min_y) / pixel_size))
    geotransform = [min_x, pixel_size, 0, max_y, 0, -pixel_size]
    return {
        "width": width,
        "height": height,
        "projection": display_grid["projection"],
        "geotransform": geotransform,
        "bounds": [
            min_x,
            min_y,
            max_x,
            max_y,
        ],
    }


def conservative_30m_mask(mask_10m: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """Assign a 30 m cell only when its retained 10 m subcells agree."""
    output = np.zeros(shape, dtype=np.int16)
    for row in range(shape[0]):
        for column in range(shape[1]):
            block = mask_10m[
                row * 3 : min((row + 1) * 3, mask_10m.shape[0]),
                column * 3 : min((column + 1) * 3, mask_10m.shape[1]),
            ]
            if block.shape != (3, 3):
                continue
            positive = block[block > 0]
            if positive.size == 9 and np.all(positive == positive[0]):
                output[row, column] = positive[0]
    return output


def rasterize_field_mask(boundaries: dict, grid: dict, fields: list[dict]) -> np.ndarray:
    """Rasterise real boundaries on the 30 m grid rather than block-reducing 10 m."""
    if gdal is None:
        raise RuntimeError("GDAL is required to rasterise the Sentinel-1 grid.")
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
    by_code = {str(field["fieldCode"]): field for field in fields}
    for feature_json in boundaries["features"]:
        code = str(feature_json["properties"]["field_code"])
        field = by_code.get(code)
        if not field:
            continue
        geometry = ogr.CreateGeometryFromJson(json.dumps(feature_json["geometry"]))
        geometry.Transform(transform)
        feature = ogr.Feature(definition)
        feature.SetField("field_idx", int(field["index"]))
        feature.SetGeometry(geometry)
        layer.CreateFeature(feature)
    raster = gdal.GetDriverByName("MEM").Create("", grid["width"], grid["height"], 1, gdal.GDT_Int16)
    raster.SetProjection(grid["projection"])
    raster.SetGeoTransform(grid["geotransform"])
    raster.GetRasterBand(1).Fill(0)
    gdal.RasterizeLayer(raster, [1], layer, options=["ATTRIBUTE=field_idx"])
    return raster.ReadAsArray()


def scene_cache_context(field_mask: np.ndarray, grid: dict) -> str:
    digest = hashlib.sha256()
    digest.update(field_mask.tobytes())
    digest.update(json.dumps(grid["geotransform"], separators=(",", ":")).encode())
    digest.update(FEATURE_VERSION.encode())
    return digest.hexdigest()


def cache_storage_array(values: np.ndarray) -> np.ndarray:
    return values.astype(np.float32, copy=False)


def evenly_spaced(items: list[dict], limit: int | None) -> list[dict]:
    if limit is None or limit >= len(items):
        return items
    if limit <= 0:
        return []
    indices = np.linspace(0, len(items) - 1, limit, dtype=int)
    return [items[index] for index in dict.fromkeys(indices.tolist())]


def harvest_year(observed_on: str) -> int:
    observed = date.fromisoformat(observed_on)
    return observed.year + 1 if observed.month >= 9 else observed.year


def seasonally_representative(
    items: list[dict],
    scenes_per_harvest_year: int | None,
) -> list[dict]:
    if scenes_per_harvest_year is None:
        return items
    if scenes_per_harvest_year <= 0:
        return []
    seasons: dict[int, dict[str, dict]] = {}
    for item in items:
        seasons.setdefault(harvest_year(item["date"]), {}).setdefault(
            item["date"], item
        )
    selected = []
    for year in sorted(seasons):
        by_date = seasons[year]
        available = sorted(date.fromisoformat(value) for value in by_date)
        if len(available) <= scenes_per_harvest_year:
            selected.extend(by_date[value.isoformat()] for value in available)
            continue
        season_start = date(year - 1, 9, 1)
        targets = [
            season_start + timedelta(days=int(offset))
            for offset in np.linspace(30, 333, scenes_per_harvest_year)
        ]
        unused = set(available)
        chosen = []
        for target in targets:
            observed = min(unused, key=lambda value: (abs(value - target), value))
            unused.remove(observed)
            chosen.append(observed)
        selected.extend(by_date[value.isoformat()] for value in sorted(chosen))
    return selected


def canonicalize_asf_asset_url(value: str) -> str:
    """Avoid Datapool's cross-host redirect for published OPERA assets."""
    parsed = urllib.parse.urlparse(value)
    if parsed.hostname != "datapool.asf.alaska.edu":
        return value
    filename = Path(parsed.path).name
    match = re.match(
        r"(?P<granule>OPERA_L2_RTC-S1_.+?)_(?:VV|VH|mask)\.tiff?$",
        filename,
        re.IGNORECASE,
    )
    if not match:
        return value
    granule = match.group("granule")
    return (
        "https://cumulus.asf.alaska.edu/RTC/OPERA-S1/"
        f"OPERA_L2_RTC-S1/{granule}/{filename}"
    )


def checked_raster_path(value: str, token: str | None) -> str:
    value = canonicalize_asf_asset_url(value)
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme in ("http", "https"):
        if not any(
            (parsed.hostname or "").endswith(suffix)
            for suffix in ALLOWED_REMOTE_HOST_SUFFIXES
        ):
            raise ValueError(f"Unexpected RTC asset host: {parsed.hostname}")
        if not token:
            raise RuntimeError(
                "Remote OPERA RTC pixels require EARTHDATA_TOKEN. "
                "Run with --discover-only or provide a local manifest."
            )
        # ASF's protected Cumulus endpoint answers HEAD with a JSON redirect.
        # Use an authenticated range GET so GDAL follows the signed asset URL
        # and sees the GeoTIFF bytes rather than treating that JSON as raster data.
        encoded_url = urllib.parse.quote(value, safe="")
        return f"/vsicurl?use_head=no&empty_dir=yes&url={encoded_url}"
    path = Path(value).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"RTC asset is missing: {path}")
    return str(path)


def authenticate_asf_token(token: str) -> None:
    """Register an EDL user token with ASF's published OAuth client."""
    url = f"{EDL_USER_TOKEN_URL}?{urllib.parse.urlencode({'client_id': ASF_EDL_CLIENT_ID})}"
    request = urllib.request.Request(
        url,
        data=urllib.parse.urlencode({"token": token}).encode(),
        headers={
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "Satellite-Productivity-Detection/0.1 local-farm-analysis",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if not 200 <= response.status <= 299:
                raise RuntimeError("ASF Earthdata token exchange was not accepted.")
    except Exception as error:
        raise RuntimeError(
            "ASF Earthdata token exchange failed; refresh the EDL token or "
            "confirm ASF account authorisation."
        ) from error


def read_asset(
    value: str,
    grid: dict,
    token: str | None,
    resampling: str,
    destination_nodata: float,
) -> np.ndarray:
    if gdal is None:
        raise RuntimeError(
            "GDAL is required to read OPERA RTC raster pixels. "
            "Install GDAL or use --discover-only."
        )
    path = checked_raster_path(value, token)
    dataset = gdal.Open(path)
    if dataset is None:
        raise RuntimeError(f"GDAL could not open RTC asset {Path(value).name}.")
    source_nodata = dataset.GetRasterBand(1).GetNoDataValue()
    warped = gdal.Warp(
        "",
        dataset,
        format="MEM",
        outputBounds=grid["bounds"],
        width=grid["width"],
        height=grid["height"],
        dstSRS=grid["projection"],
        resampleAlg=resampling,
        srcNodata=source_nodata,
        dstNodata=destination_nodata,
    )
    return warped.ReadAsArray().astype(np.float32)


def process_item(
    item: dict,
    grid: dict,
    field_mask: np.ndarray,
    fields: list[dict],
    output_dir: Path,
    token: str | None,
    cache_context: str,
) -> dict:
    validate_item(item)
    scene_file = output_dir / "scenes" / f"{item['id']}.npz"
    sidecar_file = output_dir / "scenes" / f"{item['id']}.json"
    if scene_file.exists() and sidecar_file.exists():
        cached = json.loads(sidecar_file.read_text())
        if (
            cached.get("featureVersion") == FEATURE_VERSION
            and cached.get("cacheContext") == cache_context
        ):
            with np.load(scene_file) as arrays:
                if set(RADAR_FEATURES).issubset(arrays.files):
                    cached["sceneFile"] = str(scene_file)
                    return cached
    vv = read_asset(item["vv"], grid, token, "bilinear", np.nan)
    vh = read_asset(item["vh"], grid, token, "bilinear", np.nan)
    if item.get("mask"):
        quality_mask = (
            read_asset(item["mask"], grid, token, "near", 255) == 0
        )
    else:
        quality_mask = np.ones(vv.shape, dtype=bool)
    valid = (field_mask > 0) & quality_mask
    features = calculate_sentinel1_rtc_features(vv, vh, valid)
    field_stats = {}
    for field in fields:
        pixels = field_mask == field["index"]
        summaries = {}
        for name, values in features.items():
            finite = values[pixels & np.isfinite(values)]
            summaries[name] = {
                "validPixelCount": int(finite.size),
                "median": (
                    round(float(np.median(finite)), 4)
                    if finite.size
                    else None
                ),
            }
        field_stats[field["fieldCode"]] = {
            "native30mInteriorPixelCount": int(np.count_nonzero(pixels)),
            "features": summaries,
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
        "acquisitionDatetime": item.get("acquisitionDatetime"),
        "burstId": item.get("burstId"),
        "spacecraft": item.get("spacecraft"),
        "orbitDirection": item.get("orbitDirection"),
        "startOrbitNumber": item.get("startOrbitNumber"),
        "stopOrbitNumber": item.get("stopOrbitNumber"),
        "productType": COLLECTION,
        "units": ACCEPTED_UNITS,
        "nativeSupportMetres": 30,
        "featureVersion": FEATURE_VERSION,
        "cacheContext": cache_context,
        "sceneFile": str(scene_file),
        "qualityMask": (
            "OPERA layover/shadow mask equals zero"
            if item.get("mask")
            else "No mask supplied; confidence must be reduced."
        ),
        "fieldStats": field_stats,
    }
    sidecar_file.write_text(json.dumps(summary, separators=(",", ":")) + "\n")
    return summary


def main() -> None:
    args = parse_args()
    boundaries = json.loads(args.boundaries.read_text())
    display_grid = json.loads(args.grid.read_text())
    fields = display_grid["fields"]
    items = (
        load_manifest(args.manifest)
        if args.manifest
        else cmr_items(farm_bbox(boundaries), args.start_date, args.end_date)
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "scenes").mkdir(parents=True, exist_ok=True)
    catalogue = {
        "collection": COLLECTION,
        "query": {
            "bbox": farm_bbox(boundaries),
            "startDate": args.start_date,
            "endDate": args.end_date,
        },
        "items": items,
    }
    (args.output_dir / "cmr-items.json").write_text(
        json.dumps(catalogue, indent=2) + "\n"
    )
    if args.discover_only:
        print(
            json.dumps(
                {
                    "collection": COLLECTION,
                    "discoveredGranules": len(items),
                    "granulesWithSeparateVvVh": sum(
                        bool(item.get("vv") and item.get("vh"))
                        for item in items
                    ),
                    "catalogue": str(args.output_dir / "cmr-items.json"),
                    "pixelAccess": "not attempted",
                },
                indent=2,
            )
        )
        return
    if gdal is None:
        raise SystemExit(
            "GDAL is required to ingest OPERA RTC rasters. "
            "Install GDAL or run with --discover-only."
        )
    grid = native_grid(display_grid)
    mask_30m = rasterize_field_mask(boundaries, grid, fields)
    context = scene_cache_context(mask_30m, grid)
    (args.output_dir / "farm-grid.json").write_text(
        json.dumps({**grid, "cacheContext": context}, indent=2) + "\n"
    )
    np.savez_compressed(args.output_dir / "farm-grid.npz", field_mask=mask_30m)
    token = os.environ.get("EARTHDATA_TOKEN")
    if token:
        authenticate_asf_token(token)
    previous_headers = gdal.GetConfigOption("GDAL_HTTP_HEADERS")
    if token:
        gdal.SetConfigOption(
            "GDAL_HTTP_HEADERS",
            f"Authorization: Bearer {token}",
        )
    try:
        if args.scenes_per_harvest_year is not None:
            selected = seasonally_representative(
                items,
                args.scenes_per_harvest_year,
            )
        else:
            selected = evenly_spaced(items, args.max_scenes)
        scenes = []
        for index, item in enumerate(selected, start=1):
            print(
                f"[{index:02}/{len(selected):02}] {item['date']} {item['id']}",
                flush=True,
            )
            scenes.append(process_item(
                item,
                grid,
                mask_30m,
                fields,
                args.output_dir,
                token,
                context,
            ))
    finally:
        gdal.SetConfigOption("GDAL_HTTP_HEADERS", previous_headers)
    summary = {
        "generatedAt": datetime.now().astimezone().isoformat(),
        "status": "available" if scenes else "no_scenes",
        "source": {
            "provider": "NASA OPERA via Earthdata CMR / ASF",
            "collection": COLLECTION,
            "product": "Radiometrically terrain-corrected Sentinel-1 gamma0",
            "authentication": "Earthdata token for remote pixels",
        },
        "method": {
            "role": "Cloud-resistant supplementary evidence; not a replacement for optical indices.",
            "nativeSupportMetres": 30,
            "analysisGrid": (
                "Fixed farm 30 m grid aligned to 30 m multiples in the configured CRS; "
                "source RTC pixels are resampled once onto this grid."
            ),
            "displayRule": "May be nearest-neighbour replicated to 10 m for display only.",
            "cacheRule": "Boundary mask, 30 m grid and feature method are hashed; stale caches are rejected.",
            "precision": "Float32 is retained in the local cache.",
            "features": RADAR_FEATURES,
            "rejectedInput": "Raw Sentinel-1 GRD digital numbers.",
        },
        "grid": grid,
        "sampling": {
            "mode": (
                "seasonally_stratified"
                if args.scenes_per_harvest_year is not None
                else "archive_evenly_spaced"
                if args.max_scenes is not None
                else "all_discovered_granules"
            ),
            "discoveredGranules": len(items),
            "discoveredDates": len({item["date"] for item in items}),
            "requestedScenesPerHarvestYear": args.scenes_per_harvest_year,
            "selectedGranules": len(selected),
            "selectedDates": [item["date"] for item in selected],
        },
        "sceneCount": len(scenes),
        "scenes": scenes,
    }
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"processedScenes": len(scenes), "summary": str(args.summary)}, indent=2))


if __name__ == "__main__":
    main()
