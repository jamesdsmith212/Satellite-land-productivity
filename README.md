# Satellite Productivity Detection

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Satellite Productivity Detection is a local, map-first tool for relative historical crop
performance. The map can show every boundary field in the active farm at
once on a shared 10 m Sentinel-2 display grid, then drill into a selected
field's historical composite, one crop-year composite, or an individual
satellite date. Separate layers cover performance, variability and wet/dry
response; evidence confidence is shown as summaries and hatching rather than a
misleading spatial surface. Crop and weather history remain supporting evidence
rather than the primary workflow.

The whole-farm map is a mosaic of within-field relative scores. It does not
claim that absolute satellite-index values or yield are directly comparable
between fields or crops. Clicking any farm field opens its underlying cells
and the selectors needed to trace the composite back through crop year,
individual date, index and source band.

See [`PROJECT-SUMMARY.md`](PROJECT-SUMMARY.md) for the current capability,
verification, limitations and next-priority snapshot. Farm-specific evidence
status remains in the ignored local farm workspace.

The reusable application is released under the [MIT License](LICENSE). Farm
records, boundaries, downloaded imagery and generated analysis products are
not included.

## How to run this for your farm

You need two starting files: field boundaries as GeoJSON and crop history as a
CSV, spreadsheet export or tab-separated file. The history should identify a
stable field code, harvest year and crop wherever possible. The template at
[`fixtures/demo-farm/raw/history.tsv`](fixtures/demo-farm/raw/history.tsv)
shows the exact tab-separated import columns. An agent can normalise a CSV or
spreadsheet export to that shape without changing your source file.

The easiest route is to **point your agent at this page** and give it the two
files. A useful prompt is:

> Set up Satellite-land-productivity for my farm using these boundaries and
> crop-history records. Keep every farm-specific file under `local-data/` and
> do not commit or upload it. Create and review the farm profile, convert my
> crop history to the import template where necessary, activate the farm, then
> run the weather, Sentinel-2, performance and database steps. Stop and explain
> any unmatched fields or incomplete records instead of guessing.

The agent should create `local-data/farms/<farm-id>/profile.json`, run
`npm run data:import`, and write `local-data/active-farm.json` with the selected
workspace. It can then run, in order:

```bash
npm run data:weather
npm run data:optical
npm run data:performance
npm run data:database
npm run dev
```

All farm data and generated evidence stay in the ignored `local-data/`
workspace. Review field matches, crop names and boundary counts before relying
on the analysis. The commands below document each step in more detail.

## Run locally

Node.js 22.13 or later is required.

```bash
git clone https://github.com/jamesdsmith212/Satellite-land-productivity.git
cd Satellite-land-productivity
nvm install
nvm use
npm install
npm run dev
```

The repository includes an `.nvmrc`, so `nvm install` and `nvm use` select the
tested Node.js version. Check `node --version` if `vinext` reports an error
about `node:fs/promises`; Node 20 is not supported by the installed `vinext`.

Open `http://localhost:3000`. Nothing in this workflow uploads or deploys the
project. The weather and satellite commands below make read-only requests to
public data services using the farm centroid or bounding box; all downloaded
farm windows remain in ignored local directories.

The development server stores its local D1 state under:

```text
.wrangler/state/v3/d1/miniflare-D1DatabaseObject/
```

The hashed filename is Wrangler-managed and may change if the local binding is
recreated. On the first local API request, Satellite Productivity Detection creates the
`field_seasons` table and loads the active farm records. The migration removes the
exact legacy 12-row example dataset only; it does not replace mixed or edited
user data. Rotation storage is deliberately bound to one local farm owner key;
request headers are not treated as identity. Do not expose this local-only server
to the internet as a multi-user service. The development server binds to
`127.0.0.1`, and the rotation API rejects non-loopback request URLs.

## Farm data is separate from the tool

Reusable code, schemas, importers and synthetic tests are tracked in Git.
Private farm records live under the ignored workspace:

```text
local-data/farms/<farm-id>/
├── profile.json
├── source/       # boundaries, history and import report
├── derived/      # weather, satellite and performance summaries
├── weather/      # downloaded daily weather
├── ndvi/         # cached Sentinel-2 arrays
├── public/       # local browser layers
└── analysis/     # SQLite database
```

`local-data/active-farm.json` selects the farm workspace used on this machine.
`npm run data:prepare` creates an ignored active bundle for the application and
links its large browser layers. If the local selector is absent, the tracked
`fixtures/demo-farm/` synthetic dataset is used, so a clean checkout still
builds and tests without private data.

Import boundaries and a tab-separated crop-history export into a workspace:

```bash
npm run data:import -- \
  local-data/farms/my-farm \
  /path/to/boundaries.geojson \
  /path/to/history.tsv
```

The workspace must contain `profile.json`. Farm-specific aliases, expected
record counts, boundary labels and current harvest year belong in that profile,
not in application code. The importer refuses profile expectation failures
instead of silently accepting a partial match.

## Source weather locally

The weather fetcher requests daily
[Open-Meteo historical reanalysis](https://open-meteo.com/en/docs/historical-weather-api)
at the farm centroid.
Temperature and soil moisture use ERA5-Land; rainfall and FAO ET₀ use ERA5
because the ERA5-Land endpoint returned those variables as null for this
location. Raw responses and merged daily rows stay under the active farm's
ignored `weather/` workspace directory.

```bash
python3 scripts/fetch-weather.py --refresh
```

The summary uses inspectable crop windows: September–June for winter crops,
March–15 July for spring crops, and March–September for grass. Wet, dry, warm
and cool labels are based on z-scores against complete 2009–2025 windows.
Incomplete current windows remain `unknown`. These are 11–25 km reanalysis
grids, not an on-farm rain gauge.

## Source Sentinel-2 satellite features locally

Python 3, NumPy and GDAL with `/vsicurl/` support are required. The fetcher
queries [Element 84 Earth Search](https://github.com/Element84/earth-search) for
[Sentinel-2 Level-2A surface-reflectance COGs](https://registry.opendata.aws/sentinel-2-l2a-cogs/),
then reads only the farm window from B04 and B08 at 10 m, plus B05, B06,
B07, B8A, B11 and B12 at native 20 m. SCL is read on both analytical grids
for explicit cloud and shadow masking:

```bash
python3 scripts/fetch-ndvi.py --refresh-catalogue --workers 4
```

The run is resumable. Float32 scene arrays remain under the active farm's
ignored `ndvi/` workspace directory. The optical step now writes season
eligibility metadata only; the performance builder below is the single source
of crop-year cell composites. A normal refresh that reuses compatible cached
scenes is:

```bash
python3 scripts/fetch-ndvi.py --workers 4
```

Per-asset scale and offset are applied before any index. SCL classes 4 and 5
are retained after a 20 m cloud/cirrus/shadow/snow buffer; water and invalid
pixels are excluded. A
field date must be at least 60% clear on both grids. NDVI, EVI2, NDRE and the
B8A/B11 water-status index are separately converted to tied within-field
percentile ranks, then equally averaged where available. Raw values from
different crops are never averaged.

The analysis never pretends that resampling creates new red-edge detail.
NDRE, the water-status index, red-edge and SWIR bands are ranked at native
20 m support on the source asset's actual pixel lattice. Their values are only
nearest-neighbour replicated onto the aligned 10 m map for display and joins.
The current pipeline requires one Sentinel-2 MGRS tile and stops explicitly
rather than resampling mixed tiles onto whichever scene appeared first.

Winter-crop windows begin on 1 September before the harvest year so autumn
establishment contributes to the trajectory. Spring crops begin on 15
February. Exact sowing and harvest dates are still missing and the interface
labels inferred stages as estimates.

The formulas, trajectory thresholds and native-resolution rules
and research caveat are documented in
[`docs/phase-2-satellite-method.md`](docs/phase-2-satellite-method.md).

## Build the historical performance map

The persistent model reuses the cached field-date arrays created by the
satellite fetcher. It does not download or recalculate Sentinel imagery:

```bash
npm run data:performance
```

This writes one ignored local browser product per boundary field under
`public/data/performance/`, plus lazily loaded index, source-band and
within-field-rank layers for every contributing field-date under
`public/data/performance/dates/`. These files stay local and are not deployed.

### Performance calculation

For every valid field-date:

1. Valid NDVI, EVI2, NDRE and water-status cells are independently converted
   to tied percentile ranks from 0 to 100 within that field and date.
2. Available index ranks are equally averaged, so NDVI is one feature rather
   than the model.
3. A crop year is eligible only with at least four clear observations, including
   at least two before observed peak canopy and one after it. Variability is
   withheld below five observations; excluded crop years are listed in the UI.
4. The full multi-index trajectory is interpolated and smoothed to estimate
   green-up, spring growth rate, peak canopy, high-canopy duration,
   senescence onset/rate, late persistence and area under the curve.
   Curve area is normalised by observed span, and late persistence is withheld
   when the last clear observation is more than 20 days before window end.
5. The date receives a weight for valid-field coverage, number of supported
   indices and trajectory-derived stage relevance.
   Fixed crop-window stages are used only as a labelled sparse-data fallback.
6. Weighted dates are combined within their crop season. Crop-window and
   boundary confidence then weight the completed season, where those factors
   cannot cancel out of a weighted mean. This produces one
   cell score per independent crop season.
7. Crop-season cell scores are combined across years using their data-quality
   weights. A season with many clear dates therefore cannot dominate merely
   because it has more scenes.

In formula form:

```text
season cell score = Σ(date percentile × date weight) / Σ(date weight)
historical cell score = Σ(season cell score × season weight) / Σ(season weight)
```

Different crops are combined only after date-level within-field
normalisation. Same-crop mode retains only the selected crop. All-crop mode
reports the dominant crop and lowers confidence when one crop supplies more
than 60% of a cell's analytical weight.

Wet- and dry-season response is calculated as the difference between the
cell's weighted score in the target weather class and its position in the
other complete wet/dry/typical seasons. Three target and three comparison
years support a general sensitivity label. One or two target years can be
shown only as an event-specific observation when at least three comparison
seasons give that cell a stable baseline; two events must agree in direction.
The UI labels these as `observed once` or `repeated indication`, not as a
general sensitivity. Weather is farm-level context and is never turned into
artificial within-field weather variation.

Confidence is separate from performance. Its four inspectable components are:

- effective season depth, including within-season observation adequacy: 40%;
- mean satellite data quality: 30%;
- crop breadth: 15%;
- wet/dry/typical weather breadth: 15%.

The result is then reduced for crop dominance, single-year dominance and only
those crop years that actually use a provisional historical boundary. Edge
distance remains a score-weighting guardrail but is not drawn as a standalone
confidence map. Fewer than two
independent crop seasons always displays as insufficient persistent evidence,
regardless of how many satellite scenes exist.

The optional management-zone view modestly blends each cell with the median
of its eight neighbours, then groups the field distribution into three, four or
five quantile classes. Small low-confidence fragments are merged simultaneously
into adjacent zones so the result is not dependent on cell iteration order;
strongly contrasting features with at least 75% confidence are preserved.

## Separate Landsat historical evidence

Landsat Collection 2 Level-2 surface reflectance extends the historical
comparison at honest 30 m support. It uses within-field NDVI, EVI2 and
NDWI/NDMI ranks; Landsat has no Sentinel-2-style red-edge feature in this
track. Landsat results are not fused into the Sentinel-2 composite.

No Landsat account or API key is required. Catalogue and pixel requests use
anonymous short-lived signing from Microsoft Planetary Computer. The request
does send the farm bounding box to that service, so run it only when that
location disclosure is acceptable:

```bash
npm run data:landsat -- --discover-only
npm run data:landsat -- --max-scenes 12
npm run data:performance
npm run data:database
```

`--max-scenes` selects an evenly spaced archive pilot rather than only the
oldest dates. Remove it for the full archive after inspecting storage and
quality. Cached rasters and browser payloads remain inside the ignored active
farm workspace.

## Build the local analysis database

Create a single SQLite database containing crop history, rotation metrics,
daily and crop-window weather, field boundaries, 10 m spatial cells,
crop-year composites and every contributing satellite-date cell value:

```bash
npm run data:database
```

The ignored, local-only output is:

```text
local-data/farms/<farm-id>/analysis/satellite-productivity-detection.sqlite
```

The database retains every optical index and source band at
field-cell-date grain, crop-stage features at field-year grain, and the
separate Landsat 30 m history when ingested. It
also includes ready-to-query same-crop and cross-crop
persistence views. Raw indices are never directly combined across crops;
cross-crop views use only relative scores normalised within each field and
satellite date. See
[`docs/analysis-database.md`](docs/analysis-database.md) for the table grain,
data controls and example SQL.

## Explicit data gaps and boundaries

Missing sowing dates, harvest dates, management-zone scores or historical
boundary versions remain explicit data gaps. Crop windows are labelled as
estimates where exact dates are absent. The active current geometry is used as
a provisional historical imagery proxy only where an older boundary was not
supplied, with a 10 m inward buffer. Historical splits or boundary changes are
never reconstructed without records.

The application can group performance cells into practical map zones, but
these remain satellite-derived relative-performance classes rather than measured
yield or causal diagnoses. Soil-sampling and nutrient-planning workflows are
intentionally outside the primary interface.

Generic spring and winter barley remain “use unknown” because feed versus
malting use was not supplied. Grass is classed as temporary only for fields
with arable crops elsewhere in their history; all-grass fields are classed as
permanent. Those rules are inspectable in `lib/farm-data.ts`.

## Verification

```bash
npm test
```

The suite builds the application, re-runs the synthetic farm import in a temporary
directory, validates the active farm through generic invariants, verifies weather
and satellite provenance, tests cloud masking, reflectance offsets, native
resolution, multi-index weighting and phenology derivation,
and confirms with synthetic cases that crop filtering, season independence,
confidence, weather sensitivity and spatial-zone generation follow the
documented rules.

The model is not validated against measured yield, soil tests or field
observations. A local cell score is a satellite-derived hypothesis, not a yield
estimate. The highest-value external validation remains a rank comparison with
one clean yield-monitor layer or equivalent ground evidence.

## Method v3 migration

Older optical caches used a misaligned 20 m grid and float16 scene arrays. The
application deliberately withholds those maps. After updating the code, refresh
the local evidence in this order:

```bash
npm run data:optical -- --refresh-catalogue
npm run data:performance
npm run data:database
```

The first command can take hours and requires enough local disk for float32
scene caches. It invalidates a scene whenever the exact 10 m/20 m masks or edge
buffer changes.
