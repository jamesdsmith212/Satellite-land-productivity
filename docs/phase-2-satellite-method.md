# Phase 2 satellite method

Phase 2 makes NDVI one feature in a traceable crop-trajectory analysis. It
does not turn satellite reflectance into a yield measurement or an accuracy
promise.

## Optical inputs

The source remains Element 84's harmonised Sentinel-2 Level-2A collection.
Per-asset STAC scale and offset are applied before calculating:

| Feature | Formula | Analytical support | Role |
| --- | --- | ---: | --- |
| NDVI | `(B08 - B04) / (B08 + B04)` | 10 m | General green-canopy response |
| EVI2 | `2.5 × (B08 - B04) / (B08 + 2.4 × B04 + 1)` | 10 m | Supplement where NDVI saturates or soil background matters |
| NDRE | `(B8A - B05) / (B8A + B05)` | 20 m | Red-edge response in denser canopy |
| Water-status index | `(B8A - B11) / (B8A + B11)` | 20 m | Narrow-NIR/SWIR response; often called NDMI with this band pair |

B05, B06, B07, B8A, B11 and B12 surface reflectance are also retained as
inspectable explanatory features. Sentinel-2's official band specification
identifies B04 and B08 as 10 m bands and the red-edge/SWIR group as 20 m
bands. The Earth Search collection metadata exposes the same asset support:

- [Copernicus Sentinel-2 mission and band documentation](https://documentation.dataspace.copernicus.eu/Data/SentinelMissions/Sentinel2.html)
- [Element 84 Earth Search Sentinel-2 L2A collection](https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a)

SCL classes 4 and 5 are retained. Cloud shadow, cloud, cirrus and snow/ice are
dilated by 20 m before masking; water, no-data and unclassified pixels are
excluded and counted. A field-date
must have at least 60% valid support on the 10 m and 20 m grids.

## Honest spatial support

NDRE, the water-status index, red-edge and SWIR bands are calculated and
ranked on the 20 m source asset's native pixel lattice. The pipeline requires a
single MGRS tile and stops on mixed tiles rather than introducing resampling
jitter. Only after that calculation are native
values repeated into 2 × 2 display blocks on the 10 m UI grid. Repetition is
nearest-neighbour display resampling; it creates no additional observations.

The individual-date payload and local SQLite database record native support.
Database rows joined to 10 m cells can therefore repeat one native 20 m value.

## Relative observation score

For each clear field-date:

1. Each of NDVI, EVI2, NDRE and the water-status index is separately assigned
   a tied percentile rank against the valid cells in that field.
2. Available ranks are equally averaged by cell. No extra weight is assigned
   to NDVI.
3. Raw indices and source bands remain separate and inspectable.

This controls absolute crop and stage effects before a date contributes to a
crop-year score. It does not make raw values from different crops directly
comparable.

## Crop-stage trajectory

Winter-crop windows run from 1 September before the harvest year through
15 July. Spring-crop windows run from 15 February through 31 July. Grass runs
from 1 March through 30 September. These are estimated windows because the
farm record does not yet contain exact sowing and harvest dates.

Within each field and crop year, the model first requires at least four clear
observations with two before observed peak canopy and one after it. It withholds
the variability layer below five observations and records excluded crop years.
For eligible crop years:

1. Field-median NDVI, EVI2, NDRE and water-status observations are scaled by
   their 10th-to-90th-percentile seasonal amplitude.
2. Available normalised features are averaged into a crop-trajectory signal.
3. The signal is linearly interpolated to daily values and smoothed with a
   maximum 15-day moving window.
4. Green-up is the first pre-peak crossing of 20% seasonal amplitude.
5. High canopy is the period at or above 70% amplitude.
6. Senescence onset is the first post-peak fall below 80% amplitude.
7. Growth and senescence rates are 14-day-or-shorter slopes.
8. Area under the curve is normalised by the observed span before being scaled
   to the nominal crop window. Late-season persistence is anchored to window
   end and is `null` when the last clear observation is more than 20 days early.
   The coverage dates, maximum gap and late-season gap remain inspectable.
9. The maximum and date of every index are retained.

Every derived stage is labelled as estimated. Confidence combines observation
count, maximum temporal gap, number of supported indices and coverage of the
crop window. If the curve is too sparse or flat, the model records the reason
and uses a labelled crop-window fallback for stage relevance. Crop-window
confidence weights the completed season, not every date, because a constant
within-season multiplier would otherwise cancel mathematically.

For each field and crop, a leave-one-season-out median trajectory is used to
calculate normal-curve RMSE and signed deviation when another comparable
season exists.

## Separate Landsat history

Landsat Collection 2 Level-2 surface reflectance is a separate long-history
track at native 30 m support. Per observation it calculates NDVI, EVI2 and a
NIR/SWIR water-status index, ranks each feature within the field, and equally
averages the available ranks. It does not invent red-edge data and does not
silently alter the Sentinel-2 score. QA_PIXEL cloud, cirrus, shadow, snow,
water and fill flags and QA_RADSAT are excluded with a one-pixel native
buffer. Landsat 7 scan-line gaps remain missing rather than interpolated.

## Interpretation

A field-scale winter-wheat study combined NDVI, NDRE and an NDWI-type signal
with rainfall and potential evapotranspiration, and reported random-forest
RMSE around 0.88 t/ha with influential red-edge features:
[Field-Aware and Explainable Modelling for Early-Season Crop Yield Prediction
Using Satellite-Derived Phenology](https://doi.org/10.3390/rs18060890).

That value describes the study's own fields, seasons, targets and validation.
It is motivation for feature selection, not an accuracy claim for any active farm.
Satellite Productivity Detection continues to model relative spatial
performance and requires local yield or field validation before estimating
tonnes per hectare.

WorldCereal's methods likewise use crop calendars and seasonal trajectories
rather than treating a fixed calendar date as universal crop stage:
[ESA WorldCereal project](https://esa-worldcereal.org/en).
