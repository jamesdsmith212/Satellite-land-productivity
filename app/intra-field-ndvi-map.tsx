"use client";

import { cropName, type FieldSeason } from "@/lib/rotation";
import type { PerformancePayload } from "@/lib/performance";
import { useEffect, useMemo, useState } from "react";

function channel(start: number, end: number, amount: number) {
  return Math.round(start + (end - start) * amount);
}

function relativeColour(value: number | null) {
  if (value === null) return "#e6e7df";
  const low = [194, 119, 54];
  const middle = [229, 224, 190];
  const high = [36, 111, 66];
  const relative = Math.max(-1, Math.min(1, (value - 50) / 50));
  const amount = Math.abs(relative);
  const start = relative < 0 ? low : middle;
  const end = relative < 0 ? middle : high;
  const scaled = relative < 0 ? 1 - amount : amount;
  return `rgb(${channel(start[0], end[0], scaled)}, ${channel(start[1], end[1], scaled)}, ${channel(start[2], end[2], scaled)})`;
}

export function IntraFieldNdviMap({
  seasons,
}: {
  seasons: FieldSeason[];
}) {
  const available = useMemo(
    () =>
      seasons.filter(
        (season) =>
          season.performanceFieldUrl &&
          season.usableObservationCount >= 4 &&
          (season.ndviCellCoverage ?? 0) > 0,
      ),
    [seasons],
  );
  const [selectedId, setSelectedId] = useState("");
  const [result, setResult] = useState<{
    url: string;
    payload: PerformancePayload | null;
    error: string;
  } | null>(null);
  const selected =
    available.find((season) => season.id === selectedId) ?? available[0];
  const selectedUrl = selected?.performanceFieldUrl ?? "";
  const payload = result?.url === selectedUrl ? result.payload : null;
  const performanceSeason = payload?.seasons.find(
    (season) => season.id === selected?.id,
  );
  const status = !selectedUrl
    ? "No usable Sentinel-2 season for this field"
    : result?.url !== selectedUrl
      ? "Loading local cell composite…"
      : result.error;

  useEffect(() => {
    if (!selectedUrl) return;
    const controller = new AbortController();
    fetch(selectedUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("cell composite unavailable");
        return (await response.json()) as PerformancePayload;
      })
      .then((data) => {
        setResult({ url: selectedUrl, payload: data, error: "" });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setResult({
          url: selectedUrl,
          payload: null,
          error: "Local weighted composite is unavailable; rebuild the performance data.",
        });
      });
    return () => controller.abort();
  }, [selectedUrl]);

  if (!available.length) {
    return (
      <div className="ndvi-empty">
        No crop-specific field season has four well-distributed clear
        Sentinel-2 observations for a weighted composite.
      </div>
    );
  }

  return (
    <div className="ndvi-viewer">
      <div className="ndvi-toolbar">
        <label>
          <span>Crop season</span>
          <select
            value={selected?.id ?? ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {available.map((season) => (
              <option key={season.id} value={season.id}>
                {season.harvestYear} · {cropName(season.cropCode)} ·{" "}
                {season.usableObservationCount} clear dates
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <div className="ndvi-season-facts">
            <span>
              <b>{selected.dataQuality}%</b> quality
            </span>
            <span>
              <b>{Math.round((selected.ndviCellCoverage ?? 0) * 100)}%</b> cell
              coverage
            </span>
            <span>
              <b>{selected.peakNdvi?.toFixed(2) ?? "—"}</b> crop-specific peak
              median NDVI
            </span>
          </div>
        )}
      </div>

      <div className="ndvi-map-frame">
        {payload && performanceSeason ? (
          <svg
            aria-label={`Within-field relative NDVI for ${selected?.harvestYear}`}
            className="ndvi-cell-map"
            viewBox={`0 0 ${payload.width} ${payload.height}`}
            preserveAspectRatio="xMidYMid meet"
          >
            {payload.cells.map(([column, row], index) => {
              const value = performanceSeason.scores[index] ?? null;
              const observations = performanceSeason.observationCounts[index] ?? 0;
              return (
              <rect
                key={`${column}-${row}`}
                x={column}
                y={row}
                width="1.03"
                height="1.03"
                fill={relativeColour(value)}
                opacity={value === null ? 0.45 : Math.min(1, 0.55 + observations * 0.08)}
              >
                <title>
                  {value === null
                    ? "Insufficient clear observations"
                    : `${Math.round(value)} / 100 relative performance · ${observations} observations`}
                </title>
              </rect>
              );
            })}
          </svg>
        ) : (
          <div className="ndvi-map-status">{status}</div>
        )}
      </div>

      <div className="ndvi-legend" aria-label="Relative performance legend">
        <span>Relatively weak</span>
        <i />
        <span>Field median</span>
        <i />
        <span>Relatively strong</span>
      </div>
      {selected && (
        <div className="ndvi-disclosure">
          <p>
            <b>{selected.ndviWindowStart}–{selected.ndviWindowEnd}</b>
            {selected.ndviWindowComplete === false ? " · current window incomplete" : ""}
            {" · "}
            Each clear date is ranked within this field before a crop-stage,
            coverage and feature-support weighted seasonal mean. This is the
            same crop-year product used by the main performance map.
          </p>
          <p>
            Estimated crop window; the active current boundary is used
            provisionally where historical geometry is unavailable. Grey cells
            have fewer than four valid observations; variability is withheld
            below five.
          </p>
        </div>
      )}
    </div>
  );
}
