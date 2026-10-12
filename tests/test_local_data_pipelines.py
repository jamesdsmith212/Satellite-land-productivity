import importlib.util
import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

import numpy as np


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "scripts"))


def load_script(name: str, filename: str):
    specification = importlib.util.spec_from_file_location(
        name,
        REPOSITORY_ROOT / "scripts" / filename,
    )
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


satellite_features = load_script(
    "satellite_productivity_detection_features",
    "satellite_features.py",
)
ndvi = load_script("satellite_productivity_detection_ndvi", "fetch-ndvi.py")
landsat = load_script(
    "satellite_productivity_detection_landsat",
    "fetch-landsat.py",
)
weather = load_script("satellite_productivity_detection_weather", "fetch-weather.py")
performance = load_script(
    "satellite_productivity_detection_performance",
    "build-performance-model.py",
)
analysis_database = load_script(
    "satellite_productivity_detection_analysis_database",
    "build-analysis-database.py",
)


class NdviPipelineTests(unittest.TestCase):
    def test_performance_support_keeps_partial_seasons_without_claiming_phenology(self):
        observations = [
            {"date": observed_on, "ndvi": value}
            for observed_on, value in [
                ("2025-04-01", 0.35),
                ("2025-04-20", 0.48),
                ("2025-05-10", 0.62),
                ("2025-06-01", 0.74),
            ]
        ]
        support = performance.observation_support(
            observations,
            "winter_wheat",
        )
        self.assertTrue(support["eligible"])
        self.assertEqual(support["evidenceTier"], "partial-season")
        self.assertEqual(support["coverageLabel"], "early-to-canopy only")
        phenology = performance.limited_phenology(observations, support)
        self.assertIsNone(phenology["peakCanopyDate"])
        self.assertEqual(phenology["confidence"], 0)

    def test_performance_support_retains_well_spread_grass_as_multi_cycle_evidence(self):
        observations = [
            {"date": observed_on, "ndvi": value}
            for observed_on, value in [
                ("2025-03-10", 0.52),
                ("2025-05-01", 0.76),
                ("2025-07-01", 0.43),
                ("2025-09-12", 0.71),
            ]
        ]
        support = performance.observation_support(observations, "grass")
        self.assertTrue(support["eligible"])
        self.assertEqual(support["evidenceTier"], "grass-seasonal")
        self.assertGreaterEqual(support["coverageDays"], 90)

    def test_performance_support_preserves_full_trajectory_and_four_date_floor(self):
        full = performance.observation_support(
            [
                {"date": "2025-03-01", "ndvi": 0.22},
                {"date": "2025-04-01", "ndvi": 0.40},
                {"date": "2025-05-01", "ndvi": 0.72},
                {"date": "2025-06-01", "ndvi": 0.55},
            ],
            "winter_wheat",
        )
        sparse = performance.observation_support(
            [
                {"date": "2025-03-01", "ndvi": 0.22},
                {"date": "2025-04-01", "ndvi": 0.40},
                {"date": "2025-05-01", "ndvi": 0.72},
            ],
            "winter_wheat",
        )
        self.assertEqual(full["evidenceTier"], "full-season")
        self.assertTrue(full["eligible"])
        self.assertFalse(sparse["eligible"])

    def test_landsat_catalogue_accepts_only_supported_level_two_assets(self):
        assets = {
            name: {
                "href": f"https://example.test/{name}.tif",
                "raster:bands": [{"scale": 0.0000275, "offset": -0.2, "nodata": 0}],
            }
            for name in landsat.REQUIRED_ASSETS
        }
        item = landsat.normalise_stac_item(
            {
                "id": "LC08_L2SP_001001_20200101_02_T1",
                "properties": {
                    "datetime": "2020-01-01T10:00:00Z",
                    "platform": "landsat-8",
                    "landsat:processing_level": "L2SP",
                },
                "assets": assets,
            }
        )

        self.assertEqual(item["platform"], "landsat-8")
        self.assertAlmostEqual(item["red"]["scale"], 0.0000275)
        self.assertIsNone(
            landsat.normalise_stac_item(
                {
                    "id": "unsupported",
                    "properties": {
                        "datetime": "2020-01-01T10:00:00Z",
                        "platform": "landsat-4",
                        "landsat:processing_level": "L2SP",
                    },
                    "assets": assets,
                }
            )
        )

    def test_landsat_qa_excludes_cloud_shadow_water_and_saturation(self):
        qa = np.zeros((5, 5), dtype=np.uint16)
        qa[2, 2] = 1 << 3
        saturation = np.zeros((5, 5), dtype=np.uint16)
        saturation[0, 0] = 1

        invalid = landsat.landsat_qa_invalid(qa, saturation)

        self.assertTrue(invalid[2, 2])
        self.assertTrue(invalid[1, 1])
        self.assertTrue(invalid[0, 0])
        self.assertTrue(invalid[0, 1])
        self.assertFalse(invalid[4, 4])

    def test_landsat_features_remain_native_30m_and_have_no_red_edge(self):
        raw = {
            "red": np.full((5, 5), 10000, dtype=np.uint16),
            "nir08": np.full((5, 5), 20000, dtype=np.uint16),
            "swir16": np.full((5, 5), 12000, dtype=np.uint16),
            "swir22": np.full((5, 5), 11000, dtype=np.uint16),
            "qa_pixel": np.zeros((5, 5), dtype=np.uint16),
            "qa_radsat": np.zeros((5, 5), dtype=np.uint16),
        }
        assets = {
            name: {"scale": 0.0000275, "offset": -0.2, "nodata": 0}
            for name in landsat.REFLECTANCE_ASSETS
        }
        features = landsat.calculate_landsat_features(
            raw,
            assets,
            np.ones((5, 5), dtype=bool),
        )

        self.assertEqual(features["ndvi"].dtype, np.float32)
        self.assertEqual(features["ndvi"].shape, (5, 5))
        self.assertNotIn("ndre", features)
        self.assertTrue(np.isfinite(features["ndvi"][2, 2]))

    def test_landsat_pilot_sampling_spans_the_catalogue(self):
        items = [{"id": str(index)} for index in range(101)]
        selected = landsat.evenly_spaced(items, 3)

        self.assertEqual([item["id"] for item in selected], ["0", "50", "100"])

    def test_analysis_database_schema_contains_corrected_phase_two_fields(self):
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(analysis_database.SCHEMA)
            columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(performance_crop_years)"
                )
            }
            landsat_columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(cell_landsat_values)"
                )
            }
        finally:
            connection.close()

        self.assertIn("boundary_confidence", columns)
        self.assertIn("area_under_curve_mean", columns)
        self.assertIn("late_season_gap_days", columns)
        self.assertIn("raw_ndwi", landsat_columns)
        self.assertIn("relative_score", landsat_columns)

    def test_native_cell_join_uses_grid_coordinates_not_integer_thirds(self):
        native_row, native_column = analysis_database.native_cell_index(
            farm_column=0,
            farm_row=0,
            display_geotransform=[581490, 10, 0, 6158020, 0, -10],
            native_geotransform=[581490, 30, 0, 6158040, 0, -30],
        )

        self.assertEqual((native_row, native_column), (0, 0))

    def test_corrected_performance_payload_inserts_into_analysis_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            temporary_root = Path(temporary)
            public_root = temporary_root / "public" / "data" / "performance"
            shutil.copytree(
                REPOSITORY_ROOT / "fixtures" / "demo-farm" / "public" / "performance",
                public_root,
            )
            summary = json.loads(
                (
                    REPOSITORY_ROOT
                    / "fixtures"
                    / "demo-farm"
                    / "derived"
                    / "performance-summary.json"
                ).read_text()
            )
            grid = {
                "projection": "EPSG:32630",
                "geotransform": [500000, 10, 0, 6200000, 0, -10],
            }
            connection = sqlite3.connect(":memory:")
            original_root = analysis_database.REPOSITORY_ROOT
            try:
                connection.executescript(analysis_database.SCHEMA)
                connection.execute("PRAGMA foreign_keys = OFF")
                analysis_database.REPOSITORY_ROOT = temporary_root
                counts = analysis_database.insert_performance(
                    connection,
                    summary,
                    grid,
                )
            finally:
                analysis_database.REPOSITORY_ROOT = original_root
                connection.close()

        self.assertEqual(counts, (4, 4, 16))

    def test_multi_index_features_use_their_native_support(self):
        red = np.array([[3000, 3000], [3000, 3000]], dtype=np.uint16)
        nir = np.array([[7000, 7000], [7000, 7000]], dtype=np.uint16)
        raw_20m = {
            "rededge1": np.array([[4000]], dtype=np.uint16),
            "rededge2": np.array([[5000]], dtype=np.uint16),
            "rededge3": np.array([[5500]], dtype=np.uint16),
            "nir08": np.array([[7000]], dtype=np.uint16),
            "swir16": np.array([[3000]], dtype=np.uint16),
            "swir22": np.array([[2500]], dtype=np.uint16),
        }
        asset_10m = {"scale": 0.0001, "offset": -0.1, "nodata": 0}
        asset_20m = {"scale": 0.0001, "offset": -0.1, "nodata": 0}
        features = satellite_features.calculate_sentinel2_features(
            {"red": red, "nir": nir},
            raw_20m,
            {
                "red": asset_10m,
                "nir": asset_10m,
                **{
                    name: asset_20m
                    for name in satellite_features.RAW_20M_BANDS
                },
            },
            np.full((2, 2), 4, dtype=np.uint8),
            np.array([[4]], dtype=np.uint8),
            np.ones((2, 2), dtype=np.uint8),
            np.ones((1, 1), dtype=np.uint8),
        )

        self.assertAlmostEqual(float(features["ndvi"][0, 0]), 0.5, places=5)
        self.assertAlmostEqual(
            float(features["evi2"][0, 0]),
            1 / 2.08,
            places=5,
        )
        self.assertAlmostEqual(float(features["ndre"][0, 0]), 1 / 3, places=5)
        self.assertAlmostEqual(float(features["ndwi"][0, 0]), 0.5, places=5)
        self.assertAlmostEqual(float(features["rededge2"][0, 0]), 0.4, places=5)

    def test_native_20m_values_are_only_replicated_for_10m_display(self):
        native = np.array([[1, 2], [3, 4]], dtype=np.float32)
        display = satellite_features.expand_native_to_display(native, (4, 4))

        np.testing.assert_array_equal(
            display,
            np.array(
                [
                    [1, 1, 2, 2],
                    [1, 1, 2, 2],
                    [3, 3, 4, 4],
                    [3, 3, 4, 4],
                ],
                dtype=np.float32,
            ),
        )

    def test_native_20m_display_respects_a_one_pixel_lattice_offset(self):
        native = np.array([[1, 2, 3], [4, 5, 6]], dtype=np.float32)
        display = satellite_features.expand_native_to_display(
            native,
            (2, 4),
            native_column_offset=1,
        )

        np.testing.assert_array_equal(
            display,
            np.array([[1, 2, 2, 3], [1, 2, 2, 3]], dtype=np.float32),
        )

    def test_native_display_offsets_follow_the_recorded_grid_origins(self):
        offsets = satellite_features.native_display_offsets(
            [581490.0, 10.0, 0.0, 6158020.0, 0.0, -10.0],
            [581480.0, 20.0, 0.0, 6158020.0, 0.0, -20.0],
        )

        self.assertEqual(offsets, (0, 1))

    def test_native_20m_grid_uses_the_source_asset_lattice(self):
        display = {
            "bounds": [581490.0, 6154700.0, 584930.0, 6158020.0],
            "projection": "EPSG:32630",
        }
        native = ndvi.coarser_native_grid(
            display,
            [500000.0, 20.0, 0.0, 6200000.0, 0.0, -20.0],
        )

        self.assertEqual(native["geotransform"][0], 581480.0)
        self.assertEqual(native["geotransform"][3], 6158020.0)
        self.assertEqual(native["geotransform"][0] % 20, 0)
        self.assertLessEqual(native["bounds"][0], display["bounds"][0])
        self.assertGreaterEqual(native["bounds"][2], display["bounds"][2])

    def test_scene_cache_context_changes_with_mask_and_buffer(self):
        mask = np.ones((2, 2), dtype=np.int16)
        native = np.ones((1, 1), dtype=np.int16)
        baseline = ndvi.scene_cache_context(mask, native, 10)

        changed_mask = mask.copy()
        changed_mask[0, 0] = 0
        self.assertNotEqual(
            baseline,
            ndvi.scene_cache_context(changed_mask, native, 10),
        )
        self.assertNotEqual(
            baseline,
            ndvi.scene_cache_context(mask, native, 20),
        )
        self.assertNotEqual(
            baseline,
            ndvi.scene_cache_context(
                mask,
                native,
                10,
                [10, 10, 0, 20, 0, -10],
                [0, 20, 0, 20, 0, -20],
            ),
        )

    def test_scene_cache_preserves_float32_spatial_precision(self):
        values = np.linspace(0.8, 0.84, 5000, dtype=np.float32)
        stored = ndvi.cache_storage_array(values)

        self.assertEqual(stored.dtype, np.float32)
        self.assertGreater(len(np.unique(stored)), 4900)

    def test_mixed_mgrs_tiles_are_rejected_before_resampling(self):
        with self.assertRaisesRegex(RuntimeError, "multiple Sentinel-2 MGRS tiles"):
            ndvi.require_single_mgrs_tile(
                [{"mgrsTile": "30UWG"}, {"mgrsTile": "30UXG"}]
            )

    def test_multi_index_score_does_not_favour_ndvi(self):
        ndvi_rank = np.array([[100, 0]], dtype=np.float32)
        evi2_rank = np.array([[0, 100]], dtype=np.float32)
        combined, counts = satellite_features.combine_relative_features(
            [ndvi_rank, evi2_rank]
        )

        np.testing.assert_array_equal(combined, np.array([[50, 50]]))
        np.testing.assert_array_equal(counts, np.array([[2, 2]], dtype=np.uint8))

    def test_scale_offset_and_scl_mask_are_applied_before_ndvi(self):
        red_raw = np.full((7, 7), 3000, dtype=np.uint16)
        nir_raw = np.full((7, 7), 7000, dtype=np.uint16)
        scl = np.full((7, 7), 4, dtype=np.uint8)
        scl[6, 6] = 3
        field_mask = np.zeros((7, 7), dtype=np.uint8)
        field_mask[0, 0] = 1
        field_mask[6, 6] = 1
        asset = {"scale": 0.0001, "offset": -0.1, "nodata": 0}

        values = ndvi.calculate_ndvi(
            red_raw,
            nir_raw,
            scl,
            field_mask,
            asset,
            asset,
        )

        self.assertAlmostEqual(float(values[0, 0]), 0.5, places=6)
        self.assertTrue(np.isnan(values[0, 1]))
        self.assertTrue(np.isnan(values[6, 6]))

    def test_zero_red_reflectance_is_not_discarded_as_cloud(self):
        features = satellite_features.calculate_sentinel2_features(
            {
                "red": np.array([[1000]], dtype=np.uint16),
                "nir": np.array([[7000]], dtype=np.uint16),
            },
            {
                name: np.array([[3000 if name != "nir08" else 7000]], dtype=np.uint16)
                for name in satellite_features.RAW_20M_BANDS
            },
            {
                "red": {"scale": 0.0001, "offset": -0.1, "nodata": 0},
                "nir": {"scale": 0.0001, "offset": -0.1, "nodata": 0},
                **{
                    name: {"scale": 0.0001, "offset": -0.1, "nodata": 0}
                    for name in satellite_features.RAW_20M_BANDS
                },
            },
            np.array([[4]], dtype=np.uint8),
            np.array([[4]], dtype=np.uint8),
            np.ones((1, 1), dtype=np.uint8),
            np.ones((1, 1), dtype=np.uint8),
        )

        self.assertAlmostEqual(float(features["ndvi"][0, 0]), 1.0)

    def test_cloud_and_shadow_mask_is_dilated(self):
        mask = np.zeros((7, 7), dtype=bool)
        mask[3, 3] = True
        dilated = satellite_features.dilate_boolean(mask, 2)

        self.assertEqual(int(np.count_nonzero(dilated)), 25)
        self.assertTrue(dilated[1, 1])
        self.assertFalse(dilated[0, 0])

    def test_within_field_rank_controls_absolute_crop_ndvi_difference(self):
        dense_cereal = np.array([0.70, 0.85, 0.90, 0.75])
        open_break_crop = np.array([0.35, 0.50, 0.55, 0.40])

        cereal_rank = satellite_features.average_percentile_rank(dense_cereal)
        break_rank = satellite_features.average_percentile_rank(open_break_crop)

        np.testing.assert_allclose(cereal_rank, break_rank)
        np.testing.assert_allclose(
            np.median(np.stack([cereal_rank, break_rank]), axis=0),
            cereal_rank,
        )

    def test_percentile_rank_keeps_nan_unranked(self):
        ranked = satellite_features.average_percentile_rank(
            np.array([0.2, np.nan, 0.8], dtype=np.float32)
        )

        self.assertEqual(float(ranked[0]), 0)
        self.assertTrue(np.isnan(ranked[1]))
        self.assertEqual(float(ranked[2]), 100)

    def test_crop_windows_are_separate_and_inspectable(self):
        self.assertEqual(
            ndvi.crop_window("winter_wheat", 2026),
            (date(2025, 9, 1), date(2026, 7, 15)),
        )
        self.assertEqual(
            ndvi.crop_window("spring_barley", 2026),
            (date(2026, 2, 15), date(2026, 7, 31)),
        )
        self.assertEqual(
            ndvi.crop_window("grass", 2026),
            (date(2026, 3, 1), date(2026, 9, 30)),
        )
        self.assertIsNone(ndvi.crop_window("fallow", 2026))


class WeatherPipelineTests(unittest.TestCase):
    def test_incomplete_window_is_not_given_a_weather_class(self):
        harvest_years = {}
        for year in range(2008, 2027):
            harvest_years[str(year)] = {}
            for window_name in weather.WINDOWS:
                harvest_years[str(year)][window_name] = {
                    "coverage": 1,
                    "waterBalanceMm": float(year - 2017),
                    "meanTemperatureC": 10.0,
                }
        harvest_years["2026"]["grass"] = {
            "coverage": 0.66,
            "waterBalanceMm": -150.0,
            "meanTemperatureC": 11.0,
        }

        weather.add_baseline_comparisons(harvest_years, 2008, 2026)

        self.assertEqual(
            harvest_years["2026"]["grass"]["moistureClass"],
            "unknown",
        )
        self.assertEqual(
            harvest_years["2026"]["grass"]["comparisonReason"],
            "Window is incomplete.",
        )


class PerformanceBuilderTests(unittest.TestCase):
    def test_tied_ndvi_values_receive_the_same_percentile(self):
        values = np.array([0.2, 0.4, 0.4, 0.8], dtype=np.float32)
        ranked = performance.average_percentile_rank(values)

        self.assertEqual(float(ranked[1]), float(ranked[2]))
        self.assertAlmostEqual(float(ranked[0]), 0.0)
        self.assertAlmostEqual(float(ranked[-1]), 100.0)

    def test_scene_feature_cache_is_bounded_by_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            first = Path(temporary) / "first.npz"
            second = Path(temporary) / "second.npz"
            values = np.ones((10, 10), dtype=np.float32)
            np.savez_compressed(first, ndvi=values)
            np.savez_compressed(second, ndvi=values * 2)
            original_limit = performance.SCENE_FEATURE_CACHE_MAX_BYTES
            performance._scene_feature_cache.clear()
            performance._scene_feature_cache_bytes = 0
            try:
                performance.SCENE_FEATURE_CACHE_MAX_BYTES = values.nbytes
                performance.load_scene_feature(str(first), "ndvi")
                performance.load_scene_feature(str(second), "ndvi")
                self.assertLessEqual(
                    performance._scene_feature_cache_bytes,
                    performance.SCENE_FEATURE_CACHE_MAX_BYTES,
                )
                self.assertEqual(len(performance._scene_feature_cache), 1)
            finally:
                performance.SCENE_FEATURE_CACHE_MAX_BYTES = original_limit
                performance._scene_feature_cache.clear()
                performance._scene_feature_cache_bytes = 0

    def test_crop_stages_are_derived_from_the_seasonal_trajectory(self):
        observations = [
            {
                "date": observed_on,
                "ndvi": value,
                "evi2": value * 0.9,
                "ndre": value * 0.7,
                "ndwi": value * 0.6,
            }
            for observed_on, value in [
                ("2025-10-01", 0.15),
                ("2025-12-01", 0.20),
                ("2026-02-01", 0.28),
                ("2026-03-01", 0.45),
                ("2026-04-01", 0.70),
                ("2026-05-01", 0.82),
                ("2026-06-01", 0.72),
                ("2026-07-01", 0.35),
            ]
        ]
        phenology = satellite_features.derive_phenology(
            observations,
            date(2025, 9, 1),
            date(2026, 7, 15),
        )

        self.assertGreater(phenology["confidence"], 0)
        peak_date = date.fromisoformat(phenology["peakCanopyDate"])
        self.assertLessEqual(abs((peak_date - date(2026, 5, 1)).days), 7)
        self.assertIsNotNone(phenology["greenupDate"])
        self.assertIsNotNone(phenology["senescenceOnsetDate"])
        self.assertGreater(phenology["areaUnderCurveIndexDays"], 0)
        self.assertGreater(phenology["springGrowthRatePerDay"], 0)
        self.assertLess(phenology["senescenceRatePerDay"], 0)
        self.assertEqual(
            phenology["stages"]["2026-07-01"]["stage"],
            "senescence",
        )

    def test_late_only_observations_do_not_invent_greenup(self):
        observations = [
            {
                "date": observed_on,
                "ndvi": value,
                "evi2": value * 0.9,
                "ndre": value * 0.7,
                "ndwi": value * 0.6,
            }
            for observed_on, value in [
                ("2026-06-01", 0.82),
                ("2026-06-15", 0.75),
                ("2026-07-01", 0.55),
                ("2026-07-10", 0.30),
            ]
        ]
        phenology = satellite_features.derive_phenology(
            observations,
            date(2025, 9, 1),
            date(2026, 7, 15),
        )

        self.assertIsNone(phenology["greenupDate"])
        self.assertIsNone(phenology["springGrowthRatePerDay"])
        self.assertTrue(phenology["peakAtObservationBoundary"])
        self.assertLess(phenology["confidence"], 50)
        self.assertIsNone(phenology["curveSamples"][0])

    def test_auc_is_normalised_and_late_persistence_requires_window_end(self):
        def observations(dates):
            values = [0.15, 0.35, 0.8, 0.45, 0.2]
            return [
                {
                    "date": observed_on,
                    "ndvi": value,
                    "evi2": value * 0.9,
                    "ndre": value * 0.7,
                    "ndwi": value * 0.6,
                }
                for observed_on, value in zip(dates, values)
            ]

        full = satellite_features.derive_phenology(
            observations(
                ["2025-09-10", "2025-12-01", "2026-04-15", "2026-06-10", "2026-07-10"]
            ),
            date(2025, 9, 1),
            date(2026, 7, 15),
        )
        cloud_limited = satellite_features.derive_phenology(
            observations(
                ["2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-05-20"]
            ),
            date(2025, 9, 1),
            date(2026, 7, 15),
        )

        self.assertLess(
            abs(full["areaUnderCurveMean"] - cloud_limited["areaUnderCurveMean"]),
            0.08,
        )
        self.assertIsNotNone(full["lateSeasonPersistence"])
        self.assertIsNone(cloud_limited["lateSeasonPersistence"])
        self.assertGreater(cloud_limited["lateSeasonGapDays"], 20)

    def test_season_support_distinguishes_partial_and_full_trajectories(self):
        partial = performance.observation_support(
            [
                {"date": "2026-03-01", "ndvi": 0.3},
                {"date": "2026-04-01", "ndvi": 0.5},
                {"date": "2026-05-01", "ndvi": 0.7},
                {"date": "2026-05-15", "ndvi": 0.8},
            ],
            "winter_wheat",
        )
        supported = performance.observation_support(
            [
                {"date": "2026-02-01", "ndvi": 0.2},
                {"date": "2026-03-01", "ndvi": 0.4},
                {"date": "2026-05-01", "ndvi": 0.8},
                {"date": "2026-06-01", "ndvi": 0.5},
            ],
            "winter_wheat",
        )

        self.assertTrue(partial["eligible"])
        self.assertEqual(partial["evidenceTier"], "partial-season")
        self.assertTrue(supported["eligible"])
        self.assertEqual(supported["evidenceTier"], "full-season")
        self.assertEqual(supported["prePeakCount"], 2)
        self.assertEqual(supported["postPeakCount"], 1)

    def test_window_confidence_is_a_season_level_differential(self):
        self.assertEqual(
            performance.window_confidence("Recorded sowing and recorded harvest dates."),
            1,
        )
        self.assertEqual(
            performance.window_confidence("Crop-specific dates inferred."),
            0.75,
        )

    def test_field_payload_exports_all_features_and_native_support(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            date_output = root / "dates"
            date_output.mkdir()
            mask_10m = np.ones((4, 4), dtype=np.int16)
            mask_20m = np.ones((2, 2), dtype=np.int16)
            scene_dates = [
                ("2025-10-01", 0.18),
                ("2026-02-01", 0.30),
                ("2026-04-01", 0.70),
                ("2026-05-15", 0.82),
                ("2026-07-01", 0.35),
            ]
            scenes_by_date = {}
            for index, (observed_on, canopy) in enumerate(scene_dates):
                pattern_10m = np.linspace(
                    canopy - 0.05,
                    canopy + 0.05,
                    16,
                    dtype=np.float32,
                ).reshape(4, 4)
                pattern_20m = np.linspace(
                    canopy * 0.5 - 0.03,
                    canopy * 0.5 + 0.03,
                    4,
                    dtype=np.float32,
                ).reshape(2, 2)
                scene_file = root / f"scene-{index}.npz"
                np.savez_compressed(
                    scene_file,
                    ndvi=pattern_10m,
                    evi2=pattern_10m * 0.9,
                    ndre=pattern_20m,
                    ndwi=pattern_20m * 0.8,
                    rededge1=pattern_20m * 0.6,
                    rededge2=pattern_20m * 0.7,
                    rededge3=pattern_20m * 0.8,
                    nir08=pattern_20m,
                    swir16=pattern_20m * 0.5,
                    swir22=pattern_20m * 0.4,
                )
                medians = {
                    "ndvi": canopy,
                    "evi2": canopy * 0.9,
                    "ndre": canopy * 0.5,
                    "ndwi": canopy * 0.4,
                }
                scenes_by_date[observed_on] = [
                    {
                        "id": f"scene-{index}",
                        "date": observed_on,
                        "sceneFile": str(scene_file),
                        "fieldStats": {
                            "A": {
                                "clearFraction": 1,
                                "native20mClearFraction": 1,
                                "medianNdvi": medians["ndvi"],
                                "medianEvi2": medians["evi2"],
                                "medianNdre": medians["ndre"],
                                "medianNdwi": medians["ndwi"],
                                "featureMedians": medians,
                            }
                        },
                    }
                ]
            payload = performance.build_field_payload(
                {
                    "fieldCode": "A",
                    "fieldName": "Test field",
                    "recordedHectares": 0.16,
                    "index": 1,
                },
                [
                    {
                        "id": "test-A-2026",
                        "harvestYear": 2026,
                        "cropNormalised": "winter_wheat",
                        "windowStart": "2025-09-01",
                        "windowEnd": "2026-07-15",
                        "windowMethod": "Synthetic crop window.",
                        "usableObservationCount": len(scene_dates),
                        "usableDates": [row[0] for row in scene_dates],
                        "dataQuality": 100,
                    }
                ],
                mask_10m,
                mask_20m,
                scenes_by_date,
                {"harvestYears": {"2026": {"winter": {}}}},
                {},
                date_output,
            )

            season = payload["seasons"][0]
            self.assertEqual(payload["excludedSeasons"], [])
            self.assertTrue(
                all(value is not None for value in season["withinSeasonVariability"])
            )
            self.assertEqual(
                season["phenology"]["availableFeatures"],
                ["ndvi", "evi2", "ndre", "ndwi"],
            )
            date_payload = json.loads(
                next(date_output.glob("*.json")).read_text()
            )
            self.assertEqual(
                set(date_payload["features"]),
                {
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
                },
            )
            self.assertEqual(date_payload["nativeSupportMetres"]["ndre"], 20)
            self.assertEqual(date_payload["displayPixelSizeMetres"], 10)
            self.assertEqual(
                date_payload["features"]["ndre"][0],
                date_payload["features"]["ndre"][1],
            )


class AnalysisDatabaseTests(unittest.TestCase):
    def test_grass_taxonomy_uses_field_history(self):
        self.assertEqual(
            analysis_database.canonical_crop("grass", True),
            "temporary_grass",
        )
        self.assertEqual(
            analysis_database.canonical_crop("grass", False),
            "permanent_grass",
        )

    def test_rotation_position_preserves_source_and_preceding_crop_evidence(self):
        self.assertEqual(
            analysis_database.rotation_position(
                "WW2",
                "winter_wheat",
                "cereal",
                "winter_wheat",
            ),
            "Second cereal",
        )
        self.assertEqual(
            analysis_database.rotation_position(
                "Spring Barley",
                "spring_barley",
                "cereal",
                "spring_beans",
            ),
            "First cereal",
        )
        self.assertEqual(
            analysis_database.rotation_position(
                "Spring Barley",
                "spring_barley",
                "cereal",
                "winter_wheat",
            ),
            "Consecutive cereal",
        )


if __name__ == "__main__":
    unittest.main()
