# Satellite Productivity Detection: project summary

Status snapshot: 20 August 2026

This is the canonical high-level summary of the farm-agnostic application. It
deliberately excludes private farm names, boundaries, crop records and evidence
counts. The active farm's verified evidence snapshot is stored locally at
`local-data/farms/<farm-id>/PROJECT-STATUS.md`; `local-data/` is ignored by Git.

## Purpose and current objective

Satellite Productivity Detection is a local, map-first application for finding
repeatable within-field spatial performance patterns while separating persistent
site constraints from crop, crop stage, preceding-crop, rotation and weather
effects.

The analytical unit is a field-season named by harvest year. Raw vegetation
indices from different crops are never directly averaged. Satellite values are
first normalised within field and observation date, then combined within one
crop season before any historical comparison.

The project is local-only. Farm evidence, credentials, large raster caches,
generated browser layers, D1 state and the analysis database must not be
uploaded or deployed.

## What currently works

- Farm-agnostic import of field boundaries and field-year crop history.
- A configurable crop taxonomy with winter, spring, cereal, break-crop, grass,
  fallow and unknown distinctions.
- A crop-history interface and local loopback-only field-season editing API.
- Whole-farm and selected-field maps on a shared Sentinel-2 grid.
- Crop, crop-group, harvest-year, comparison-method and evidence-quality filters.
- Crop-year composite and individual Sentinel-2 date inspection.
- NDVI and EVI2 at native 10 m analytical support.
- NDRE, the B8A/B11 water-status index, red-edge, narrow-NIR and SWIR evidence
  at native 20 m support, replicated to 10 m only for display.
- Relative improvement or worsening using a median pairwise crop-year slope.
- Wet- and dry-event departures where a stable comparison baseline exists.
- Evidence confidence, crop/year dominance disclosure and management-zone
  generation.
- Explicit Sentinel-2 evidence tiers:
  - `full-season`: adequate observations before and after peak canopy;
  - `partial-season`: usable spatial evidence with incomplete peak bracketing;
  - `grass-seasonal`: seasonal coverage without assuming one universal peak.
- Unsupported phenology is withheld. Partial and grass-seasonal evidence is
  down-weighted and can be excluded with the evidence-coverage control.
- A separate native-30 m Landsat performance and trend track.
- Cross-sensor agreement after Sentinel-2 cells are aggregated to the Landsat
  grid and both sensors are restricted to their shared year window.
- Supplementary Sentinel-1 RTC ingestion with VV, VH, polarisation difference
  and ratio features. Radar is not silently blended into optical scores.
- A local SQLite analytical database containing crop history, rotation metrics,
  weather, spatial cells, crop-year composites, individual optical values,
  Landsat and radar evidence.
- Synthetic tests for crop-specific, rotation-specific, weather-specific,
  missing-record, split-field and changing-boundary cases.

## Main analytical rules

1. Use harvest year for season identity, including winter crops.
2. Prefer same-crop comparisons where enough seasons exist.
3. Treat cross-crop persistence as evidence of a possible fundamental spatial
   constraint, while retaining crop identity and lowering confidence when the
   history is narrow.
4. Treat crop-specific weakness as a diagnostic signal, not noise.
5. Do not calculate persistent performance from fewer than two independent
   crop seasons.
6. Require at least three crop years spanning two years for a spatial trend.
7. Retain a one- or two-year weather event only as an event-specific observation
   when at least three other seasons establish a stable spatial baseline.
8. Never diagnose disease, take-all, nutrient deficiency, drainage or soil
   constraints from satellite data alone.
9. Always disclose contributing crop-years, dominant crop/year and confidence.
10. Keep historical performance, crop demand, soil supply and fertiliser
    strategy as separate layers.

## Local architecture and data separation

Tracked Git content contains application code, importers, schemas, generic
documentation and synthetic fixtures. Private data belongs under:

```text
local-data/farms/<farm-id>/
├── profile.json
├── source/          # private boundaries and crop history
├── derived/         # generated summaries
├── weather/         # local weather cache
├── ndvi/            # Sentinel-2 cache
├── landsat/         # Landsat cache
├── sentinel-1-rtc/  # radar cache
├── public/          # local browser products
├── analysis/        # local SQLite database
└── PROJECT-STATUS.md
```

`local-data/active-farm.json` selects the active workspace.
`npm run data:prepare` copies small active summaries and creates local links to
the private browser products. When no local farm is selected, the tracked
synthetic fixture is used.

The editable local D1 database is Wrangler-managed under:

```text
.wrangler/state/v3/d1/miniflare-D1DatabaseObject/
```

The large analytical database is generated at:

```text
local-data/farms/<farm-id>/analysis/satellite-productivity-detection.sqlite
```

## Run and rebuild locally

Node.js 22.13 or later is required:

```bash
nvm use
npm install
npm run dev
```

Open the loopback URL printed by the development server. It normally starts at
`http://localhost:3000`, but selects the next free port when another local
process already uses that port.

Rebuild already-cached evidence without downloading imagery:

```bash
npm run data:performance
npm run data:database
npm run data:prepare
```

Refresh upstream data only when required:

```bash
npm run data:weather
npm run data:optical
npm run data:landsat
npm run data:radar -- --scenes-per-harvest-year 6
```

Sentinel-1 remote access requires `EARTHDATA_TOKEN` in the invoking Terminal.
The token must not be written into tracked files or pasted into documentation.

## Verification status

As of this snapshot:

- the production build passes;
- ESLint passes;
- all application/model tests pass;
- all local data-pipeline tests pass;
- browser QA passes for the Sentinel-2 evidence selector, native Landsat field
  maps and whole-farm cross-sensor agreement map;
- the application remains bound to loopback and no deployment was performed.

Run the complete automated verification with:

```bash
npm test
npm run lint
```

## Known limitations

- The model has not been validated against measured yield, soil-test results or
  systematic field observations. Relative performance is a hypothesis layer,
  not yield or causation.
- Exact sowing and harvest dates are often unavailable, so crop windows and
  broad stages remain labelled estimates.
- Current boundaries may be provisional proxies for older seasons. Historical
  splits and boundary changes cannot be reconstructed without source records.
- Partial optical seasons support spatial comparison but not complete phenology.
- Multi-cut or grazed grass is treated as seasonal spatial evidence; the current
  model does not reconstruct individual cutting cycles.
- Weather is farm-level reanalysis context, not measured within-field weather.
- Older Landsat years can be sparse, and Landsat remains a coarser 30 m track.
- Sentinel-1 is supplementary database evidence; it is not yet a first-class
  interactive map layer or part of the optical performance score.
- Nutrient scenarios, soil-sampling recommendations and exportable field reports
  are not yet complete end-to-end workflows in the current map interface.
- Farm-history editing exists locally, but every imported management attribute
  and split-field correction still requires user review.

## Recommended next priorities

1. Validate spatial ranks against one clean yield-monitor layer, targeted crop
   inspections or soil-test evidence.
2. Add recorded sowing/harvest dates and historical boundary versions where
   available.
3. Add an inspectable Sentinel-1 map and cross-sensor time-series view without
   blending spatial resolutions.
4. Add rotation-aware soil-sampling recommendations with the crop-history
   evidence shown for every proposed sample.
5. Complete intended-next-crop nutrient scenarios while keeping soil supply,
   crop demand and historical performance separate.
6. Export a field report containing crop history, contributing crop-years,
   sensor coverage, zone classification, dominance warnings and confidence.

## Version-control state

This summary records the current local implementation, not a deployment.
Before treating it as a recoverable release, review the working tree, confirm
that private paths remain ignored, run the verification commands, and create a
Git commit containing only farm-agnostic code, documentation and fixtures.
