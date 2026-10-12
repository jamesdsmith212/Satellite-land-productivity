#!/usr/bin/env python3
"""Fetch and summarise real reanalysis weather for the active local farm."""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

from farm_config import BOUNDARIES_PATH, DAILY_WEATHER_PATH, WEATHER_SUMMARY_PATH, WORKSPACE


OPEN_METEO_URL = "https://archive-api.open-meteo.com/v1/archive"
WINDOWS = {
    "winter": ((-1, 9, 1), (0, 6, 30)),
    "spring": ((0, 3, 1), (0, 7, 15)),
    "grass": ((0, 3, 1), (0, 9, 30)),
    "crop_year": ((-1, 9, 1), (0, 8, 31)),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--boundaries",
        default=BOUNDARIES_PATH,
    )
    parser.add_argument("--raw-dir", default=WORKSPACE / "weather")
    parser.add_argument(
        "--summary",
        default=WEATHER_SUMMARY_PATH,
    )
    parser.add_argument("--first-harvest-year", type=int, default=2008)
    parser.add_argument("--last-harvest-year", type=int, default=date.today().year)
    parser.add_argument("--refresh", action="store_true")
    return parser.parse_args()


def farm_centroid(boundaries_path: Path) -> tuple[float, float]:
    collection = json.loads(boundaries_path.read_text())
    points = [
        coordinate
        for feature in collection["features"]
        for coordinate in flatten_coordinates(feature["geometry"]["coordinates"])
    ]
    longitudes = [point[0] for point in points]
    latitudes = [point[1] for point in points]
    return (
        (min(latitudes) + max(latitudes)) / 2,
        (min(longitudes) + max(longitudes)) / 2,
    )


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


def fetch_json(url: str, destination: Path, refresh: bool) -> dict:
    if destination.exists() and not refresh:
        return json.loads(destination.read_text())
    request = urllib.request.Request(
        url,
        headers={"user-agent": "Satellite-Productivity-Detection/0.1 local-farm-analysis"},
    )
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = json.load(response)
            break
        except Exception as error:
            last_error = error
            if attempt < 2:
                time.sleep(2**attempt)
    else:
        raise RuntimeError(
            f"Weather request failed after three attempts: {last_error}"
        )
    if payload.get("error"):
        raise RuntimeError(payload.get("reason", "Weather API returned an error."))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    return payload


def weather_url(
    latitude: float,
    longitude: float,
    start_date: date,
    end_date: date,
    model: str,
    variables: list[str],
) -> str:
    query = urllib.parse.urlencode(
        {
            "latitude": f"{latitude:.6f}",
            "longitude": f"{longitude:.6f}",
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "daily": ",".join(variables),
            "models": model,
            "timezone": "Europe/London",
            "cell_selection": "land",
        }
    )
    return f"{OPEN_METEO_URL}?{query}"


def daily_rows(payload: dict, variables: list[str]) -> dict[str, dict]:
    daily = payload["daily"]
    rows = {}
    for index, day in enumerate(daily["time"]):
        values = {variable: daily[variable][index] for variable in variables}
        if any(value is None for value in values.values()):
            continue
        rows[day] = values
    return rows


def window_dates(harvest_year: int, name: str) -> tuple[date, date]:
    start_parts, end_parts = WINDOWS[name]
    return (
        date(harvest_year + start_parts[0], start_parts[1], start_parts[2]),
        date(harvest_year + end_parts[0], end_parts[1], end_parts[2]),
    )


def mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def rounded(value: float | None, places: int = 2):
    return None if value is None else round(value, places)


def summarize_window(
    daily: dict[str, dict],
    start: date,
    end: date,
    last_available: date,
) -> dict:
    effective_end = min(end, last_available)
    expected_days = (end - start).days + 1
    available = []
    cursor = start
    while cursor <= effective_end:
        row = daily.get(cursor.isoformat())
        if row:
            available.append(row)
        cursor += timedelta(days=1)
    coverage = len(available) / expected_days
    if not available:
        return {
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "lastAvailableDate": last_available.isoformat(),
            "coverage": 0,
            "partial": True,
        }
    precipitation = sum(row["precipitation_sum"] for row in available)
    et0 = sum(row["et0_fao_evapotranspiration"] for row in available)
    temperatures = [row["temperature_2m_mean"] for row in available]
    return {
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "lastAvailableDate": last_available.isoformat(),
        "coverage": rounded(coverage, 3),
        "partial": coverage < 0.98,
        "precipitationMm": rounded(precipitation, 1),
        "et0Mm": rounded(et0, 1),
        "waterBalanceMm": rounded(precipitation - et0, 1),
        "meanTemperatureC": rounded(mean(temperatures), 1),
        "gddBase5": rounded(sum(max(value - 5, 0) for value in temperatures), 1),
        "surfaceSoilMoisture": rounded(
            mean([row["soil_moisture_0_to_7cm_mean"] for row in available]),
            3,
        ),
        "rootZoneSoilMoisture": rounded(
            mean([row["soil_moisture_7_to_28cm_mean"] for row in available]),
            3,
        ),
        "deepSoilMoisture": rounded(
            mean([row["soil_moisture_28_to_100cm_mean"] for row in available]),
            3,
        ),
    }


def add_baseline_comparisons(
    harvest_years: dict[str, dict],
    first_year: int,
    last_year: int,
) -> dict:
    baseline_end = min(last_year - 1, 2025)
    baseline_start = max(first_year + 1, 2009)
    baselines = {}
    for window_name in WINDOWS:
        complete = [
            harvest_years[str(year)][window_name]
            for year in range(baseline_start, baseline_end + 1)
            if harvest_years[str(year)][window_name].get("coverage", 0) >= 0.98
        ]
        water_balances = [row["waterBalanceMm"] for row in complete]
        temperatures = [row["meanTemperatureC"] for row in complete]
        if len(water_balances) < 8:
            continue
        water_mean = statistics.fmean(water_balances)
        water_sd = statistics.pstdev(water_balances)
        temperature_mean = statistics.fmean(temperatures)
        temperature_sd = statistics.pstdev(temperatures)
        baselines[window_name] = {
            "years": list(range(baseline_start, baseline_end + 1)),
            "completeYearCount": len(complete),
            "waterBalanceMeanMm": rounded(water_mean, 1),
            "waterBalanceSdMm": rounded(water_sd, 1),
            "meanTemperatureC": rounded(temperature_mean, 1),
            "temperatureSdC": rounded(temperature_sd, 2),
            "classificationThresholdZ": 0.75,
        }
        for year_rows in harvest_years.values():
            row = year_rows[window_name]
            if row.get("coverage", 0) < 0.98:
                row["moistureClass"] = "unknown"
                row["comparisonReason"] = "Window is incomplete."
                continue
            water_z = (
                (row["waterBalanceMm"] - water_mean) / water_sd
                if water_sd
                else 0
            )
            temperature_z = (
                (row["meanTemperatureC"] - temperature_mean) / temperature_sd
                if temperature_sd
                else 0
            )
            row["waterBalanceZ"] = rounded(water_z, 2)
            row["temperatureZ"] = rounded(temperature_z, 2)
            row["moistureClass"] = (
                "wet" if water_z >= 0.75 else "dry" if water_z <= -0.75 else "typical"
            )
            row["temperatureClass"] = (
                "warm"
                if temperature_z >= 0.75
                else "cool"
                if temperature_z <= -0.75
                else "typical"
            )
    return baselines


def main() -> None:
    args = parse_args()
    boundaries_path = Path(args.boundaries)
    raw_dir = Path(args.raw_dir)
    summary_path = Path(args.summary)
    latitude, longitude = farm_centroid(boundaries_path)
    start_date = date(args.first_harvest_year - 1, 9, 1)
    end_date = min(date.today() - timedelta(days=5), date(args.last_harvest_year, 12, 31))

    land_variables = [
        "temperature_2m_mean",
        "temperature_2m_min",
        "temperature_2m_max",
        "soil_moisture_0_to_7cm_mean",
        "soil_moisture_7_to_28cm_mean",
        "soil_moisture_28_to_100cm_mean",
    ]
    era5_variables = [
        "temperature_2m_mean",
        "temperature_2m_min",
        "temperature_2m_max",
        "precipitation_sum",
        "et0_fao_evapotranspiration",
    ]
    land_payload = fetch_json(
        weather_url(
            latitude,
            longitude,
            start_date,
            end_date,
            "era5_land",
            land_variables,
        ),
        raw_dir / "open-meteo-era5-land.json",
        args.refresh,
    )
    era5_payload = fetch_json(
        weather_url(
            latitude,
            longitude,
            start_date,
            end_date,
            "era5",
            era5_variables,
        ),
        raw_dir / "open-meteo-era5.json",
        args.refresh,
    )
    land_rows = daily_rows(land_payload, land_variables)
    era5_rows = daily_rows(era5_payload, era5_variables)
    shared_dates = sorted(set(land_rows) & set(era5_rows))
    if len(shared_dates) < 365 * (args.last_harvest_year - args.first_harvest_year):
        raise RuntimeError("Weather sources returned too few complete shared days.")
    merged_daily = {
        day: {
            **land_rows[day],
            "precipitation_sum": era5_rows[day]["precipitation_sum"],
            "et0_fao_evapotranspiration": era5_rows[day][
                "et0_fao_evapotranspiration"
            ],
        }
        for day in shared_dates
    }
    last_available = datetime.strptime(shared_dates[-1], "%Y-%m-%d").date()
    merged_path = DAILY_WEATHER_PATH if raw_dir == DAILY_WEATHER_PATH.parent else raw_dir / "daily-weather.json"
    merged_path.write_text(
        json.dumps(
            {
                "source": {
                    "temperatureAndSoilMoisture": "Open-Meteo ERA5-Land",
                    "precipitationAndEt0": "Open-Meteo ERA5",
                    "licence": "CC BY 4.0",
                },
                "requestedCentroid": {
                    "latitude": latitude,
                    "longitude": longitude,
                },
                "returnedGridPoints": {
                    "era5Land": {
                        "latitude": land_payload["latitude"],
                        "longitude": land_payload["longitude"],
                        "elevationM": land_payload["elevation"],
                    },
                    "era5": {
                        "latitude": era5_payload["latitude"],
                        "longitude": era5_payload["longitude"],
                        "elevationM": era5_payload["elevation"],
                    },
                },
                "daily": [
                    {"date": day, **merged_daily[day]} for day in shared_dates
                ],
            },
            separators=(",", ":"),
        )
        + "\n"
    )

    harvest_years = {}
    for harvest_year in range(
        args.first_harvest_year,
        args.last_harvest_year + 1,
    ):
        harvest_years[str(harvest_year)] = {}
        for window_name in WINDOWS:
            start, end = window_dates(harvest_year, window_name)
            harvest_years[str(harvest_year)][window_name] = summarize_window(
                merged_daily,
                start,
                end,
                last_available,
            )
    baselines = add_baseline_comparisons(
        harvest_years,
        args.first_harvest_year,
        args.last_harvest_year,
    )
    summary = {
        "generatedAt": datetime.now().astimezone().isoformat(),
        "lastAvailableDate": last_available.isoformat(),
        "source": {
            "temperatureAndSoilMoisture": {
                "provider": "Open-Meteo",
                "model": "ERA5-Land",
                "nominalResolutionKm": 11,
                "returnedGridPoint": {
                    "latitude": land_payload["latitude"],
                    "longitude": land_payload["longitude"],
                },
            },
            "precipitationAndEt0": {
                "provider": "Open-Meteo",
                "model": "ERA5",
                "nominalResolutionKm": 25,
                "returnedGridPoint": {
                    "latitude": era5_payload["latitude"],
                    "longitude": era5_payload["longitude"],
                },
            },
            "licence": "CC BY 4.0",
            "method": "Reanalysis, not an on-farm weather station.",
        },
        "requestedFarmCentroid": {
            "latitude": latitude,
            "longitude": longitude,
        },
        "windowDefinitions": {
            name: {
                "start": f"{start[1]:02d}-{start[2]:02d}",
                "startYearOffset": start[0],
                "end": f"{end[1]:02d}-{end[2]:02d}",
                "endYearOffset": end[0],
            }
            for name, (start, end) in WINDOWS.items()
        },
        "baselines": baselines,
        "harvestYears": harvest_years,
    }
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(
        json.dumps(
            {
                "dailyRows": len(shared_dates),
                "range": [shared_dates[0], shared_dates[-1]],
                "harvestYears": len(harvest_years),
                "summary": str(summary_path),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
