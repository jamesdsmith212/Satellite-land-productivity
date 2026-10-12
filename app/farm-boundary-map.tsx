"use client";

import { ACTIVE_FARM, FARM_BOUNDARY_COUNT } from "@/lib/farm-data";
import { cropName, getCrop, type FieldSeason } from "@/lib/rotation";
import { useEffect, useMemo, useState } from "react";

interface BoundaryProperties {
  uuid: string;
  field_name: string;
  history_field_name: string;
  field_code: string;
  recorded_hectares: number | null;
  recorded_acres: number;
  boundary_version: string;
  match_type: "exact-name" | "explicit-alias";
}

interface BoundaryFeature {
  type: "Feature";
  properties: BoundaryProperties;
  geometry: {
    type: "MultiPolygon";
    coordinates: number[][][][];
  };
}

interface BoundaryCollection {
  type: "FeatureCollection";
  features: BoundaryFeature[];
}

interface ProjectedFeature {
  feature: BoundaryFeature;
  path: string;
  labelX: number;
  labelY: number;
}

const MAP_WIDTH = 820;
const MAP_HEIGHT = 620;
const MAP_PADDING = 28;

function allCoordinates(feature: BoundaryFeature) {
  return feature.geometry.coordinates.flat(2);
}

function projectBoundaries(
  collection: BoundaryCollection,
): ProjectedFeature[] {
  const coordinates = collection.features.flatMap(allCoordinates);
  const meanLatitude =
    coordinates.reduce((sum, coordinate) => sum + coordinate[1], 0) /
    coordinates.length;
  const longitudeScale = Math.cos((meanLatitude * Math.PI) / 180);
  const projectedCoordinates = coordinates.map(([longitude, latitude]) => [
    longitude * longitudeScale,
    latitude,
  ]);
  const minX = Math.min(...projectedCoordinates.map((coordinate) => coordinate[0]));
  const maxX = Math.max(...projectedCoordinates.map((coordinate) => coordinate[0]));
  const minY = Math.min(...projectedCoordinates.map((coordinate) => coordinate[1]));
  const maxY = Math.max(...projectedCoordinates.map((coordinate) => coordinate[1]));
  const scale = Math.min(
    (MAP_WIDTH - MAP_PADDING * 2) / (maxX - minX),
    (MAP_HEIGHT - MAP_PADDING * 2) / (maxY - minY),
  );
  const contentWidth = (maxX - minX) * scale;
  const contentHeight = (maxY - minY) * scale;
  const offsetX = (MAP_WIDTH - contentWidth) / 2;
  const offsetY = (MAP_HEIGHT - contentHeight) / 2;
  const project = ([longitude, latitude]: number[]) => [
    offsetX + (longitude * longitudeScale - minX) * scale,
    MAP_HEIGHT - offsetY - (latitude - minY) * scale,
  ];

  return collection.features.map((feature) => {
    const path = feature.geometry.coordinates
      .map((polygon) =>
        polygon
          .map((ring) =>
            ring
              .map((coordinate, index) => {
                const [x, y] = project(coordinate);
                return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
              })
              .join(" ")
              .concat(" Z"),
          )
          .join(" "),
      )
      .join(" ");
    const featureCoordinates = allCoordinates(feature).map(project);
    return {
      feature,
      path,
      labelX:
        featureCoordinates.reduce((sum, coordinate) => sum + coordinate[0], 0) /
        featureCoordinates.length,
      labelY:
        featureCoordinates.reduce((sum, coordinate) => sum + coordinate[1], 0) /
        featureCoordinates.length,
    };
  });
}

export function FarmBoundaryMap({
  records,
  selectedField,
  onSelectField,
}: {
  records: FieldSeason[];
  selectedField: string;
  onSelectField: (fieldKey: string) => void;
}) {
  const [boundaries, setBoundaries] = useState<BoundaryCollection | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/active-farm/boundaries.geojson", {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Boundary file could not be loaded.");
        return (await response.json()) as BoundaryCollection;
      })
      .then((collection) => {
        if (
          collection.type !== "FeatureCollection" ||
          collection.features.length !== FARM_BOUNDARY_COUNT
        ) {
          throw new Error(
            `Boundary file did not contain the expected ${FARM_BOUNDARY_COUNT} fields.`,
          );
        }
        setBoundaries(collection);
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Boundary file could not be loaded.",
        );
      });
    return () => controller.abort();
  }, []);

  const currentSeasons = useMemo(
    () =>
      new Map(
        records
          .filter(
            (record) => record.harvestYear === ACTIVE_FARM.currentHarvestYear,
          )
          .map((record) => [record.fieldId, record]),
      ),
    [records],
  );
  const projected = useMemo(
    () => (boundaries ? projectBoundaries(boundaries) : []),
    [boundaries],
  );
  const selectedFieldId = selectedField.split("::")[0];
  const selectedBoundary = projected.find(
    ({ feature }) => feature.properties.field_code === selectedFieldId,
  );
  const selectedSeason = currentSeasons.get(selectedFieldId);

  if (error) {
    return <div className="map-empty">{error}</div>;
  }
  if (!boundaries) {
    return <div className="map-empty">Loading active farm boundaries…</div>;
  }

  return (
    <div className="real-map-wrap">
      <svg
        className="real-field-map"
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        role="img"
        aria-label={`${ACTIVE_FARM.name} ${ACTIVE_FARM.currentHarvestYear} field boundaries`}
      >
        {projected.map(({ feature, path, labelX, labelY }) => {
          const fieldId = feature.properties.field_code;
          const season = currentSeasons.get(fieldId);
          const crop = getCrop(season?.cropCode ?? "unknown");
          const selected = fieldId === selectedFieldId;
          return (
            <g key={feature.properties.uuid}>
              <path
                d={path}
                className={`farm-boundary crop-${crop.group} season-${crop.season} ${selected ? "selected" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`${feature.properties.history_field_name}, ${season ? cropName(season.cropCode) : "crop not recorded"}`}
                onClick={() => onSelectField(`${fieldId}::Whole field`)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectField(`${fieldId}::Whole field`);
                  }
                }}
              >
                <title>
                  {feature.properties.history_field_name} ·{" "}
                  {season ? cropName(season.cropCode) : "crop not recorded"}
                </title>
              </path>
              <text
                x={labelX}
                y={labelY}
                className={selected ? "map-field-label selected" : "map-field-label"}
              >
                {feature.properties.history_field_name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="real-map-detail">
        <span className="eyebrow">
          Selected {ACTIVE_FARM.currentHarvestYear} boundary
        </span>
        <strong>
          {selectedBoundary?.feature.properties.history_field_name ??
            "No supplied boundary"}
        </strong>
        <span>
          {selectedBoundary
            ? `${selectedBoundary.feature.properties.recorded_hectares} ha · ${selectedBoundary.feature.properties.match_type === "explicit-alias" ? "verified alias match" : "exact history match"}`
            : "This history field is not present in the active boundary file."}
        </span>
        <b>
          {selectedSeason
            ? cropName(selectedSeason.cropCode)
            : `No ${ACTIVE_FARM.currentHarvestYear} crop record`}
          {selectedSeason?.variety ? ` · ${selectedSeason.variety}` : ""}
        </b>
      </div>
      <div className="real-map-legend">
        <span><i className="cereal" /> Cereal</span>
        <span><i className="break" /> Beans / break</span>
        <span><i className="grass" /> Grass</span>
        <span><i className="fallow" /> Fallow</span>
        <span><i className="woodland" /> Woodland</span>
      </div>
    </div>
  );
}
