"use client";

import {
  type AnalysisFilters,
  type FieldSeason,
  CROP_TAXONOMY,
  CSV_HEADER_ALIASES,
  ROTATION_DEFINITIONS,
  analyseZone,
  auditSeason,
  computeRotationMetrics,
  cropName,
  emptySeason,
  filterSeasons,
  getCrop,
  normaliseCropCode,
} from "@/lib/rotation";
import {
  ACTIVE_FARM,
  FARM_BOUNDARY_COUNT,
  FARM_SEASONS,
} from "@/lib/farm-data";
import { FarmBoundaryMap } from "./farm-boundary-map";
import { IntraFieldNdviMap } from "./intra-field-ndvi-map";
import Link from "next/link";
import {
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type View =
  | "overview"
  | "history"
  | "analysis"
  | "sampling"
  | "nutrients"
  | "report";

const navItems: { id: View; label: string; kicker: string }[] = [
  { id: "history", label: "Crop history", kicker: "01" },
  { id: "analysis", label: "Evidence checks", kicker: "02" },
];

function formatScore(value: number) {
  const points = Math.round(value * 100);
  return `${points > 0 ? "+" : ""}${points} pts`;
}

function formatDate(value: string) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function qualityLabel(score: number) {
  if (score >= 80) return "Good";
  if (score >= 60) return "Usable";
  return "Limited";
}

function fieldKey(record: FieldSeason) {
  return `${record.fieldId}::${record.portion}`;
}

function badgeTone(classification: string) {
  if (classification.includes("strong")) return "good";
  if (classification.includes("Insufficient") || classification.includes("inconsistent")) return "muted";
  if (classification.includes("weak") || classification.includes("Sensitive")) return "warn";
  return "neutral";
}

function FieldMark({ children }: { children: ReactNode }) {
  return <span className="field-mark">{children}</span>;
}

function parseDelimited(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/\t/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function importedSeasons(text: string): FieldSeason[] {
  const rows = parseDelimited(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) =>
    header.toLowerCase().replace(/[^a-z0-9]/g, ""),
  );
  return rows.slice(1).map((row, rowIndex) => {
    const record = emptySeason();
    headers.forEach((header, columnIndex) => {
      const target = CSV_HEADER_ALIASES[header];
      const value = row[columnIndex] ?? "";
      if (!target || !value) return;
      if (target === "harvestYear") {
        record.harvestYear = Number(value) || record.harvestYear;
      } else if (target === "cropCode" || target === "previousCropCode") {
        record[target] = normaliseCropCode(value);
      } else {
        (record as unknown as Record<string, string>)[target] = value;
      }
    });
    record.id = [
      record.fieldId || "imported",
      record.harvestYear,
      record.portion || "whole",
      rowIndex + 1,
    ]
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    return record;
  });
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function RotationWorkspace() {
  const [view, setView] = useState<View>("history");
  const [records, setRecords] = useState<FieldSeason[]>(FARM_SEASONS);
  const [selectedField, setSelectedField] = useState(
    `${ACTIVE_FARM.defaultFieldCode ?? FARM_SEASONS[0]?.fieldId ?? ""}::Whole field`,
  );
  const [selectedZone, setSelectedZone] = useState("");
  const [status, setStatus] = useState("Loading saved rotation records…");
  const [editRecord, setEditRecord] = useState<FieldSeason | null>(null);
  const [importPreview, setImportPreview] = useState<FieldSeason[]>([]);
  const [importName, setImportName] = useState("");
  const [filterCrop, setFilterCrop] = useState("all");
  const [filterPrevious, setFilterPrevious] = useState("all");
  const [filterSeason, setFilterSeason] = useState("all");
  const [filterRotation, setFilterRotation] = useState("all");
  const [filterWeather, setFilterWeather] = useState("all");
  const [plannedCrop, setPlannedCrop] = useState("winter-wheat");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/field-seasons", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed");
        return (await response.json()) as { records: FieldSeason[] };
      })
      .then((payload) => {
        setRecords(payload.records);
        setStatus(`${payload.records.length} crop-season records saved`);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("Active farm data in memory · saved data service unavailable");
      });
    return () => controller.abort();
  }, []);

  const fields = useMemo(() => {
    const found = new Map<string, { key: string; label: string }>();
    records.forEach((record) => {
      found.set(fieldKey(record), {
        key: fieldKey(record),
        label: `${record.fieldName}${record.portion === "Whole field" ? "" : ` · ${record.portion}`}`,
      });
    });
    return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [records]);

  const activeField = fields.some((field) => field.key === selectedField)
    ? selectedField
    : (fields[0]?.key ?? selectedField);

  const fieldRecords = useMemo(
    () =>
      records
        .filter((record) => fieldKey(record) === activeField)
        .sort((a, b) => b.harvestYear - a.harvestYear),
    [records, activeField],
  );
  const currentSeason = fieldRecords[0];
  const selectedFieldName =
    fields.find((field) => field.key === activeField)?.label ?? "Field";
  const filters = useMemo<AnalysisFilters>(
    () => ({
      cropCode: filterCrop,
      previousCropCode: filterPrevious,
      season: filterSeason,
      rotationPosition: filterRotation,
      weatherClass: filterWeather,
    }),
    [filterCrop, filterPrevious, filterSeason, filterRotation, filterWeather],
  );
  const filteredRecords = useMemo(
    () => filterSeasons(fieldRecords, filters),
    [fieldRecords, filters],
  );
  const availableZoneIds = useMemo(
    () =>
      [
        ...new Set(
          fieldRecords.flatMap((record) => Object.keys(record.zoneScores ?? {})),
        ),
      ].sort(),
    [fieldRecords],
  );
  const analyses = useMemo(
    () =>
      availableZoneIds.map((zoneId) => ({
        zone: { id: zoneId, name: zoneId, areaHa: null },
        analysis: analyseZone(fieldRecords, zoneId, filters),
      })),
    [availableZoneIds, fieldRecords, filters],
  );
  const selectedAnalysis =
    analyses.find((item) => item.zone.id === selectedZone) ?? analyses[0];
  const metrics = useMemo(() => computeRotationMetrics(fieldRecords), [fieldRecords]);
  const currentMetrics = metrics.history.find((metric) => metric.id === currentSeason?.id);
  const missingCount = fieldRecords.filter((record) => auditSeason(record).length).length;
  const totalUsable = fieldRecords.reduce(
    (sum, record) => sum + record.usableObservationCount,
    0,
  );
  const totalCandidates = fieldRecords.reduce(
    (sum, record) => sum + record.observationCount,
    0,
  );
  const weatherRecordCount = fieldRecords.filter(
    (record) => (record.weatherCoverage ?? 0) >= 0.98,
  ).length;

  async function persist(recordList: FieldSeason[], method: "POST" | "PATCH") {
    setStatus("Saving rotation history…");
    const response = await fetch("/api/field-seasons", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        method === "PATCH" ? { record: recordList[0] } : { records: recordList },
      ),
    });
    if (!response.ok) {
      setStatus("Save failed · your unsaved changes remain on screen");
      return false;
    }
    const payload = (await response.json()) as { records: FieldSeason[] };
    setRecords(payload.records);
    setStatus(`${payload.records.length} crop-season records saved`);
    return true;
  }

  async function saveEdit() {
    if (!editRecord) return;
    const updated = records.some((record) => record.id === editRecord.id)
      ? records.map((record) => (record.id === editRecord.id ? editRecord : record))
      : [...records, editRecord];
    setRecords(updated);
    if (await persist([editRecord], "PATCH")) setEditRecord(null);
  }

  async function saveImport() {
    if (!importPreview.length) return;
    setRecords((current) => {
      const importedIds = new Set(importPreview.map((record) => record.id));
      return [...current.filter((record) => !importedIds.has(record.id)), ...importPreview];
    });
    if (await persist(importPreview, "POST")) {
      setImportPreview([]);
      setImportName("");
    }
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setImportPreview(importedSeasons(text));
    setImportName(file.name);
    event.target.value = "";
  }

  function startNewSeason() {
    const blank = emptySeason();
    const [fieldId, portion] = activeField.split("::");
    blank.fieldId = fieldId || "";
    blank.fieldName = currentSeason?.fieldName ?? "";
    blank.portion = portion || "Whole field";
    blank.boundaryVersion = currentSeason?.boundaryVersion ?? "";
    blank.id = `${blank.fieldId}-${blank.harvestYear}-${blank.portion}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    setEditRecord(blank);
  }

  function downloadReport() {
    const reportRows = fieldRecords
      .map(
        (record) => `<tr><td>${record.harvestYear}</td><td>${escapeHtml(cropName(record.cropCode))}</td><td>${escapeHtml(cropName(record.previousCropCode))}</td><td>${escapeHtml(record.rotationPosition)}</td><td>${escapeHtml(record.weatherClass)}</td><td>${record.usableObservationCount}</td><td>${record.dataQuality}%</td></tr>`,
      )
      .join("");
    const zoneRows = analyses
      .map(
        ({ zone, analysis }) => `<tr><td>${escapeHtml(zone.name)}</td><td>${escapeHtml(analysis.classification)}</td><td>${analysis.confidenceLabel} (${analysis.confidenceScore}%)</td><td>${escapeHtml(analysis.evidence.map((row) => `${row.harvestYear} ${row.crop}`).join(", "))}</td></tr>`,
      )
      .join("") ||
      `<tr><td colspan="4">${totalUsable ? "Real within-field NDVI composites are linked, but management zones have not yet been classified." : "No spatial observations or management-zone evidence supplied."}</td></tr>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(selectedFieldName)} rotation report</title><style>body{font:14px Arial;max-width:1000px;margin:40px auto;color:#19362f}h1{font-size:30px}table{width:100%;border-collapse:collapse;margin:16px 0 32px}th,td{padding:10px;border-bottom:1px solid #ccd5ce;text-align:left}th{background:#edf1e8}</style></head><body><p>Satellite Productivity Detection · field-level export</p><h1>${escapeHtml(selectedFieldName)}</h1><p>Cross-crop results use within-season relative performance; raw satellite-index values from different crops are not averaged. Weather classes use crop-specific ERA5/ERA5-Land windows and are not on-farm station readings.</p><h2>Crop history</h2><table><thead><tr><th>Harvest year</th><th>Crop</th><th>Previous crop</th><th>Rotation position</th><th>Weather</th><th>Usable observations</th><th>Quality</th></tr></thead><tbody>${reportRows}</tbody></table><h2>Rotation-aware zones</h2><table><thead><tr><th>Zone</th><th>Classification</th><th>Confidence</th><th>Contributing crop years</th></tr></thead><tbody>${zoneRows}</tbody></table><p>Satellite evidence supports hypotheses only. Confirm drainage, disease, nutrient and soil constraints with field observations and appropriate sampling.</p></body></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selectedFieldName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-rotation-report.html`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-seed" aria-hidden="true">SPD</span>
          <div>
            <strong>Satellite Productivity Detection</strong>
            <span>Crop-aware evidence</span>
          </div>
        </div>
        <nav aria-label="Application">
          {navItems.map((item) => (
            <button
              className={view === item.id ? "nav-item active" : "nav-item"}
              key={item.id}
              onClick={() => setView(item.id)}
            >
              <span>{item.kicker}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="method-note">
          <span className="eyebrow">Method guardrail</span>
          <p>Different crops are compared only after normalising performance within each crop season.</p>
        </div>
        <div className="sidebar-status">
          <span className="status-dot" />
          {status}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">Harvest-year history</span>
            <h1>{selectedFieldName}</h1>
          </div>
          <div className="topbar-actions">
            <label className="field-select">
              <span>Active field</span>
              <select
                value={activeField}
                onChange={(event) => setSelectedField(event.target.value)}
              >
                {fields.map((field) => (
                  <option key={field.key} value={field.key}>{field.label}</option>
                ))}
              </select>
            </label>
            <button className="secondary-button" onClick={() => setView("history")}>Import history</button>
            <Link className="primary-button" href="/">Performance map</Link>
          </div>
        </header>

        {view === "overview" && (
          <div className="page-grid">
            <section className="hero-card">
              <div className="hero-copy">
                <span className="eyebrow accent">{ACTIVE_FARM.historyLabel}</span>
                <h2>Real fields. Honest gaps.</h2>
                <p>
                  The supplied rotation history and current boundaries are linked
                  to real Sentinel-2 observations and crop-window weather summaries.
                  Historical geometry and field observations remain visible gaps.
                </p>
                <div className="hero-metrics">
                  <div><strong>{totalUsable}</strong><span>usable observations</span></div>
                  <div><strong>{metrics.cropFrequencies.length}</strong><span>crop types</span></div>
                  <div><strong>{Math.round(metrics.rotationDiversity * 100)}%</strong><span>rotation diversity</span></div>
                  <div><strong>{missingCount}</strong><span>records need review</span></div>
                </div>
              </div>
              <div className="current-crop">
                <span className="eyebrow">Current field-season</span>
                <strong>{currentSeason ? cropName(currentSeason.cropCode) : "No crop record"}</strong>
                <span>Harvest {currentSeason?.harvestYear ?? "—"} · {currentSeason?.rotationPosition ?? "Unknown position"}</span>
                <span>
                  {currentSeason?.hectares ?? "—"} ha ·{" "}
                  {currentSeason?.acres ?? "—"} acres · field ID{" "}
                  {currentSeason?.fieldId ?? "—"}
                </span>
                <div className="crop-window">
                  <div style={{ width: `${currentSeason?.dataQuality ?? 0}%` }} />
                </div>
                <small>{currentSeason?.usableObservationCount ?? 0} usable scenes · {currentSeason?.dataQuality ?? 0}% data quality</small>
              </div>
            </section>

            <section className="panel map-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Supplied current geometry</span>
                  <h3>{ACTIVE_FARM.boundaryLabel}</h3>
                </div>
                <span className="table-note">
                  {FARM_BOUNDARY_COUNT} supplied boundaries
                </span>
              </div>
              <FarmBoundaryMap
                records={records}
                selectedField={activeField}
                onSelectField={setSelectedField}
              />
              <p className="map-caption">
                The active farm&apos;s current GeoJSON is shown here. Historical
                years are not assigned this geometry where earlier boundary versions
                were not supplied.
              </p>
            </section>

            <section className="panel ndvi-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Real Sentinel-2 · within-field rank</span>
                  <h3>Intra-field NDVI comparison</h3>
                </div>
                <span className="table-note">{totalUsable} clear field-dates</span>
              </div>
              <IntraFieldNdviMap seasons={fieldRecords} />
            </section>

            <section className="panel evidence-panel">
              {selectedAnalysis ? (
                <>
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">{selectedAnalysis.zone.id}</span>
                      <h3>{selectedAnalysis.zone.name}</h3>
                    </div>
                    <span className={`classification ${badgeTone(selectedAnalysis.analysis.classification)}`}>
                      {selectedAnalysis.analysis.classification}
                    </span>
                  </div>
                  <div className="confidence-row">
                    <div className="confidence-ring" style={{ "--score": `${selectedAnalysis.analysis.confidenceScore * 3.6}deg` } as CSSProperties}>
                      <span>{selectedAnalysis.analysis.confidenceScore}</span>
                    </div>
                    <div>
                      <strong>{selectedAnalysis.analysis.confidenceLabel} confidence</strong>
                      <p>{selectedAnalysis.analysis.evidence.length} seasons · {new Set(selectedAnalysis.analysis.evidence.map((row) => row.cropCode)).size} crops</p>
                    </div>
                  </div>
                  <div className="evidence-callout">
                    <span className="eyebrow">Diagnostic signal</span>
                    <p>{selectedAnalysis.analysis.signals[0]}</p>
                  </div>
                  <div className="season-chips">
                    {selectedAnalysis.analysis.evidence.map((row) => (
                      <FieldMark key={row.id}>
                        {row.harvestYear} {row.crop.replace("Winter ", "W. ").replace("Spring ", "S. ")}
                      </FieldMark>
                    ))}
                  </div>
                  <button className="text-button" onClick={() => setView("analysis")}>Inspect contributing crop years →</button>
                </>
              ) : (
                <div className="spatial-empty">
                  <span className="eyebrow">Spatial evidence status</span>
                  <h3>{totalUsable ? "Cell composites linked; zones not yet classified" : "Boundaries and rotation loaded"}</h3>
                  <p>
                    {totalUsable
                      ? "Real crop-window NDVI cells are available above. Persistent, crop-specific and weather-sensitive management-zone classification still requires the next local modelling step and field validation."
                      : "Rotation metrics are available, but persistent spatial constraints will remain unclassified until real observation data is linked."}
                  </p>
                  <div className="missing-data-list">
                    <span>Weather: {weatherRecordCount} complete crop windows</span>
                    <span>Satellite: {totalUsable} usable of {totalCandidates} candidate field-dates</span>
                    <span>Historical geometry: not supplied</span>
                  </div>
                </div>
              )}
            </section>

            <section className="panel timeline-panel">
              <div className="panel-heading">
                <div><span className="eyebrow">Crop history</span><h3>Rotation timeline</h3></div>
                <button className="text-button" onClick={() => setView("history")}>Review & edit</button>
              </div>
              <div className="timeline">
                {fieldRecords.map((record) => {
                  const warnings = auditSeason(record);
                  return (
                    <button className="timeline-row" key={record.id} onClick={() => { setEditRecord({ ...record }); setView("history"); }}>
                      <span className={`timeline-dot ${getCrop(record.cropCode).group}`} />
                      <strong>{record.harvestYear}</strong>
                      <div><b>{cropName(record.cropCode)}</b><span>after {cropName(record.previousCropCode)} · {record.rotationPosition}</span></div>
                      <div className="timeline-quality"><b>{record.usableObservationCount}</b><span>usable scenes</span></div>
                      {warnings.length ? <span className="warning-count">{warnings.length} issue{warnings.length > 1 ? "s" : ""}</span> : <span className="quality-ok">Checked</span>}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="panel metric-panel">
              <span className="eyebrow">Current rotation position</span>
              <h3>{currentSeason?.rotationPosition ?? "Unknown"}</h3>
              <dl>
                <div><dt>Years since same crop</dt><dd>{currentMetrics?.yearsSinceSameCrop ?? "No prior record"}</dd></div>
                <div><dt>Years since break crop</dt><dd>{currentMetrics?.yearsSinceBreakCrop ?? "No prior record"}</dd></div>
                <div><dt>Consecutive cereals</dt><dd>{currentMetrics?.consecutiveCereals ?? "—"}</dd></div>
                <div><dt>Consecutive autumn crops</dt><dd>{currentMetrics?.consecutiveAutumnSown ?? "—"}</dd></div>
                <div><dt>Years since manure</dt><dd>{currentMetrics?.yearsSinceOrganicManure ?? "No prior record"}</dd></div>
              </dl>
              <button className="text-button" onClick={() => setView("analysis")}>View definitions & comparisons →</button>
            </section>
          </div>
        )}

        {view === "history" && (
          <section className="page-section">
            <div className="section-intro">
              <div>
                <span className="eyebrow">Editable field-season records</span>
                <h2>Rotation history</h2>
                <p>Winter crops use the harvest year: a crop sown in September 2025 and harvested in August 2026 is recorded as 2026.</p>
              </div>
              <div className="button-row">
                <input ref={fileInput} type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" hidden onChange={handleImport} />
                <button className="secondary-button" onClick={() => fileInput.current?.click()}>Import CSV / spreadsheet export</button>
                <button className="primary-button" onClick={startNewSeason}>Add crop season</button>
              </div>
            </div>

            {importName && (
              <div className="import-banner">
                <div>
                  <strong>{importName}</strong>
                  <span>{importPreview.length} rows recognised · crop names mapped to the configured taxonomy</span>
                </div>
                <div className="button-row">
                  <button className="text-button" onClick={() => { setImportPreview([]); setImportName(""); }}>Discard</button>
                  <button className="primary-button" disabled={!importPreview.length} onClick={saveImport}>Save imported records</button>
                </div>
              </div>
            )}

            <div className="panel table-panel">
              <div className="panel-heading">
                <div><span className="eyebrow">Active field</span><h3>{selectedFieldName}</h3></div>
                <span className="table-note">{fieldRecords.length} distinct field-season records</span>
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>Harvest</th><th>Crop</th><th>Previous crop</th><th>Sowing → harvest</th><th>Rotation position</th><th>Boundary</th><th>Coverage</th><th /></tr></thead>
                  <tbody>
                    {fieldRecords.map((record) => {
                      const warnings = auditSeason(record);
                      return (
                        <tr key={record.id}>
                          <td><strong>{record.harvestYear}</strong></td>
                          <td><strong>{cropName(record.cropCode)}</strong><span>{record.variety || "Variety unknown"}</span></td>
                          <td>{cropName(record.previousCropCode)}</td>
                          <td><span>{formatDate(record.sowingDate)}</span><span>{formatDate(record.harvestDate)}</span></td>
                          <td><FieldMark>{record.rotationPosition}</FieldMark></td>
                          <td><span>{record.boundaryVersion || "Missing"}</span><span>{record.portion}</span></td>
                          <td><span className={`quality-pill ${qualityLabel(record.dataQuality).toLowerCase()}`}>{record.dataQuality}% {qualityLabel(record.dataQuality)}</span>{warnings.length > 0 && <span className="row-warning">{warnings.length} review flag{warnings.length > 1 ? "s" : ""}</span>}</td>
                          <td><button className="table-action" onClick={() => setEditRecord({ ...record })}>Edit</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="panel taxonomy-panel">
              <div className="panel-heading">
                <div><span className="eyebrow">Central analysis configuration</span><h3>Crop taxonomy</h3></div>
                <span className="table-note">{CROP_TAXONOMY.length} core crop classes</span>
              </div>
              <div className="taxonomy-grid">
                {CROP_TAXONOMY.filter((crop) => crop.code !== "unknown").map((crop) => (
                  <div key={crop.code}>
                    <span className={`crop-swatch ${crop.group}`} />
                    <strong>{crop.name}</strong>
                    <span>{crop.season} · {crop.comparableGroup}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {view === "analysis" && (
          <section className="page-section">
            <div className="section-intro">
              <div>
                <span className="eyebrow">Crop-aware normalisation</span>
                <h2>Persistence analysis</h2>
                <p>Same-crop comparisons carry the strongest crop-specific evidence. Cross-crop results use relative spatial rank and are labelled separately.</p>
              </div>
              <div className="mode-key">
                <span><i className="same" /> Same crop</span>
                <span><i className="cross" /> Cross crop</span>
              </div>
            </div>
            <div className="filter-bar">
              <label>Crop<select value={filterCrop} onChange={(event) => setFilterCrop(event.target.value)}><option value="all">All crops</option>{CROP_TAXONOMY.map((crop) => <option value={crop.code} key={crop.code}>{crop.name}</option>)}</select></label>
              <label>Winter / spring<select value={filterSeason} onChange={(event) => setFilterSeason(event.target.value)}><option value="all">All seasons</option><option value="winter">Winter / autumn-sown</option><option value="spring">Spring-sown</option><option value="perennial">Grass / perennial</option></select></label>
              <label>Preceding crop<select value={filterPrevious} onChange={(event) => setFilterPrevious(event.target.value)}><option value="all">All preceding crops</option>{CROP_TAXONOMY.map((crop) => <option value={crop.code} key={crop.code}>{crop.name}</option>)}</select></label>
              <label>Rotation position<select value={filterRotation} onChange={(event) => setFilterRotation(event.target.value)}><option value="all">All positions</option>{[...new Set(fieldRecords.map((record) => record.rotationPosition))].map((position) => <option value={position} key={position}>{position}</option>)}</select></label>
              <label>Weather<select value={filterWeather} onChange={(event) => setFilterWeather(event.target.value)}><option value="all">All weather</option><option value="wet">Wet crop window</option><option value="dry">Dry crop window</option><option value="typical">Typical crop window</option><option value="unknown">Unknown / incomplete</option></select></label>
              <button className="clear-button" onClick={() => { setFilterCrop("all"); setFilterPrevious("all"); setFilterSeason("all"); setFilterRotation("all"); setFilterWeather("all"); }}>Clear filters</button>
            </div>

            <div className="analysis-summary">
              <div><span>Seasons included</span><strong>{filteredRecords.length}</strong><small>{filteredRecords.map((record) => record.harvestYear).join(", ") || "None"}</small></div>
              <div><span>Crops included</span><strong>{new Set(filteredRecords.map((record) => record.cropCode)).size}</strong><small>{[...new Set(filteredRecords.map((record) => cropName(record.cropCode)))].join(", ") || "None"}</small></div>
              <div><span>Spatial evidence</span><strong>{analyses.length ? "Zones available" : totalUsable ? "Cell composites" : "Not supplied"}</strong><small>{analyses.length ? "Within-season relative performance" : totalUsable ? "Real NDVI linked; zone model pending" : "No zone scores or satellite observations"}</small></div>
              <div><span>Stage estimates</span><strong>{filteredRecords.reduce((sum, record) => sum + record.inferredStageCount, 0)}</strong><small>Labelled estimates, never observed stages</small></div>
            </div>

            <div className={analyses.length ? "analysis-layout" : "analysis-layout empty"}>
              {!analyses.length ? (
                <div className="panel analysis-empty">
                  <span className="eyebrow">Honest analysis boundary</span>
                  <h3>{totalUsable ? "Real cell evidence is ready; zone persistence is not" : "Rotation comparisons are ready; spatial persistence is not"}</h3>
                  <p>
                    The supplied history supports crop frequency, preceding-crop and
                    rotation-position summaries. {totalUsable
                      ? "The linked crop-specific NDVI composites are not silently converted into management zones; zone construction and cross-season modelling remain a separate, inspectable step."
                      : "It does not include within-field observations or management-zone scores, so Satellite Productivity Detection will not manufacture a persistent-zone classification."}
                  </p>
                  <div className="analysis-next-data">
                    <span><b>{fieldRecords.length}</b> real crop years loaded</span>
                    <span><b>{totalUsable}</b> usable satellite field-dates</span>
                    <span><b>{weatherRecordCount}</b> complete weather windows</span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="panel zone-list">
                    <div className="panel-heading"><div><span className="eyebrow">Management zones</span><h3>Classification</h3></div></div>
                    {analyses.map(({ zone, analysis }) => (
                      <button key={zone.id} className={selectedZone === zone.id ? "zone-row selected" : "zone-row"} onClick={() => setSelectedZone(zone.id)}>
                        <span className={`zone-code ${badgeTone(analysis.classification)}`}>{zone.id}</span>
                        <div><strong>{zone.name}</strong><span>{analysis.classification}</span></div>
                        <div className="zone-score"><strong>{formatScore(analysis.overallMean)}</strong><span>{analysis.confidenceLabel} {analysis.confidenceScore}%</span></div>
                      </button>
                    ))}
                  </div>
                  {selectedAnalysis && (
                <div className="panel analysis-detail">
                  <div className="panel-heading">
                    <div><span className="eyebrow">{selectedAnalysis.zone.id} · rotation-aware diagnosis</span><h3>{selectedAnalysis.zone.name}</h3></div>
                    <span className={`classification ${badgeTone(selectedAnalysis.analysis.classification)}`}>{selectedAnalysis.analysis.classification}</span>
                  </div>
                  <div className="comparison-grid">
                    <div className="comparison-card same-card">
                      <span className="eyebrow">Same-crop persistence</span>
                      <strong>{selectedAnalysis.analysis.sameCropGroups.length ? "Comparable seasons found" : "Not enough repeats"}</strong>
                      {selectedAnalysis.analysis.sameCropGroups.length ? selectedAnalysis.analysis.sameCropGroups.map((group) => <p key={group.name}>{cropName(group.name)} · {group.count} seasons · <b>{formatScore(group.mean)}</b></p>) : <p>Two seasons of the same crop are required before a same-crop summary is shown.</p>}
                    </div>
                    <div className="comparison-card cross-card">
                      <span className="eyebrow">Cross-crop persistence</span>
                      <strong>{selectedAnalysis.analysis.crossCropAvailable ? "Relative comparison available" : "Insufficient crop diversity"}</strong>
                      <p>{selectedAnalysis.analysis.crossCropAvailable ? `${selectedAnalysis.analysis.cropGroups.length} crops represented. Crop effects controlled using within-field season-relative scores.` : "Add a contrasting crop season to test a fundamental site constraint."}</p>
                    </div>
                  </div>
                  <div className="evidence-table">
                    <div className="evidence-table-head"><span>Crop year</span><span>Previous crop</span><span>Position</span><span>Weather</span><span>Relative</span></div>
                    {selectedAnalysis.analysis.evidence.map((row) => (
                      <div className="evidence-table-row" key={row.id}>
                        <span><b>{row.harvestYear}</b> {row.crop}</span>
                        <span>{row.previousCrop}</span>
                        <span>{row.rotationPosition}</span>
                        <span>{row.weatherClass}</span>
                        <span className={row.relativePerformance <= -0.08 ? "score-low" : row.relativePerformance >= 0.08 ? "score-high" : ""}>{formatScore(row.relativePerformance)}</span>
                      </div>
                    ))}
                    {!selectedAnalysis.analysis.evidence.length && <p className="empty-state">No crop years match the current filters.</p>}
                  </div>
                  <div className="confidence-detail">
                    <div><span className="eyebrow">Dominance check</span><p><b>{cropName(selectedAnalysis.analysis.dominantCrop)}</b> contributes {Math.round(selectedAnalysis.analysis.dominantCropShare * 100)}% of seasons. Largest single-year influence: {selectedAnalysis.analysis.dominantYear ?? "—"} ({Math.round(selectedAnalysis.analysis.dominantYearShare * 100)}%).</p></div>
                    <div><span className="eyebrow">Confidence deductions</span><p>{selectedAnalysis.analysis.confidenceNotes.join(" ") || "No material deductions."}</p></div>
                  </div>
                  <div className="hypothesis-note"><strong>Field-check boundary</strong><p>{selectedAnalysis.analysis.signals.join(" ")} This is a hypothesis signal, not a diagnosis of disease, nutrient deficiency, drainage or compaction.</p></div>
                </div>
                  )}
                </>
              )}
            </div>

            <details className="definitions-panel">
              <summary>Inspect rotation metric definitions</summary>
              <div>
                <p><b>Break crop groups:</b> {ROTATION_DEFINITIONS.breakCropGroups.join(", ")}.</p>
                <p><b>Same-crop minimum:</b> {ROTATION_DEFINITIONS.comparableMinimumSeasons} seasons.</p>
                <p><b>Cross-crop minimum:</b> {ROTATION_DEFINITIONS.crossCropMinimumCrops} distinct crops.</p>
                <p><b>Weak / strong thresholds:</b> ≤ {formatScore(ROTATION_DEFINITIONS.weakThreshold)} / ≥ {formatScore(ROTATION_DEFINITIONS.strongThreshold)} relative to the field-season.</p>
              </div>
            </details>
          </section>
        )}

        {view === "sampling" && (
          <section className="page-section">
            <div className="section-intro">
              <div><span className="eyebrow">Evidence-led ground truth</span><h2>Soil-sampling design</h2><p>Locations are prioritised where a sample can distinguish persistent soil constraints from crop, rotation and weather responses.</p></div>
            </div>
            <div className="panel analysis-empty sampling-empty">
              <span className="eyebrow">Sampling status · {selectedFieldName}</span>
              <h3>No defensible sampling locations yet</h3>
              <p>
                The current boundary, 19-year rotation and crop-specific NDVI cells
                are available, but management-zone and soil evidence are not yet
                classified. Sampling points remain empty until the local model can
                distinguish persistent, crop-specific and rotation-sensitive areas.
              </p>
              <FarmBoundaryMap
                records={records}
                selectedField={activeField}
                onSelectField={setSelectedField}
              />
            </div>
          </section>
        )}

        {view === "nutrients" && (
          <section className="page-section">
            <div className="section-intro">
              <div><span className="eyebrow">Separated decision layers</span><h2>Nutrient scenario context</h2><p>Rotation history informs the scenario; it does not determine a rate. Soil supply, crop demand, historical performance and strategy remain separate.</p></div>
              <label className="planned-crop">Intended next crop<select value={plannedCrop} onChange={(event) => setPlannedCrop(event.target.value)}>{CROP_TAXONOMY.filter((crop) => !["cover", "fallow", "woodland", "unknown"].includes(crop.group)).map((crop) => <option value={crop.code} key={crop.code}>{crop.name}</option>)}</select></label>
            </div>
            <div className="nutrient-grid">
              <article className="layer-card crop-layer"><span className="layer-number">01</span><span className="eyebrow">Planned crop demand</span><h3>{cropName(plannedCrop)}</h3><p>Use the farm’s approved nutrient-planning rules, target yield and intended market. No rate is inferred from NDVI.</p><dl><div><dt>Season</dt><dd>{getCrop(plannedCrop).season}</dd></div><div><dt>Comparable group</dt><dd>{getCrop(plannedCrop).comparableGroup}</dd></div></dl></article>
              <article className="layer-card soil-layer"><span className="layer-number">02</span><span className="eyebrow">Soil supply</span><h3>Awaiting current analysis</h3><p>Attach pH, P, K, Mg and mineral-N evidence with sample dates relative to this rotation.</p><button className="secondary-button" onClick={() => setView("sampling")}>Use sampling plan</button></article>
              <article className="layer-card rotation-layer"><span className="layer-number">03</span><span className="eyebrow">Rotation context</span><h3>{currentSeason ? `Following ${cropName(currentSeason.cropCode)}` : "Previous crop unknown"}</h3><p>{currentSeason?.strawManagement ?? "Straw management unknown"}. {currentSeason?.organicManure ?? "Manure history unknown"}.</p><dl><div><dt>Last legume</dt><dd>{fieldRecords.find((record) => getCrop(record.cropCode).comparableGroup === "beans")?.harvestYear ?? "Not recorded"}</dd></div><div><dt>Last manure</dt><dd>{fieldRecords.find((record) => record.organicManure && !/none|unknown/i.test(record.organicManure))?.harvestYear ?? "Not recorded"}</dd></div></dl></article>
              <article className="layer-card history-layer"><span className="layer-number">04</span><span className="eyebrow">Historical performance</span><h3>{analyses.length ? `${analyses.filter((item) => item.analysis.classification.includes("strong")).length} strong · ${analyses.filter((item) => item.analysis.classification.includes("weak") || item.analysis.classification.includes("Sensitive")).length} constrained zones` : totalUsable ? "NDVI cells linked · zones pending" : "Spatial performance not supplied"}</h3><p>{analyses.length ? "Use persistence as investment context only. Strong does not automatically mean “more”; weak does not automatically mean “less”." : totalUsable ? "Real within-field ranks are available, but nutrient strategy will not use them until rotation-aware zones are classified and checked." : "The real crop history is available, but no NDVI, yield or management-zone evidence has been linked."}</p><button className="secondary-button" onClick={() => setView("analysis")}>Inspect evidence</button></article>
            </div>
            <div className="panel nutrient-boundary"><strong>Scenario boundary</strong><p>Previous-crop contributions, legume effects and straw removal must be applied through a recognised nutrient plan and local rules. Satellite data cannot replace soil analysis.</p></div>
          </section>
        )}

        {view === "report" && (
          <section className="page-section report-page">
            <div className="section-intro">
              <div><span className="eyebrow">Field-level evidence pack</span><h2>{selectedFieldName} report</h2><p>Crop history, method disclosure, zone evidence, data limitations and sampling implications in one export.</p></div>
              <div className="button-row"><button className="secondary-button" onClick={() => window.print()}>Print / save PDF</button><button className="primary-button" onClick={downloadReport}>Download HTML report</button></div>
            </div>
            <article className="report-sheet">
              <div className="report-cover"><div><span className="eyebrow">Satellite Productivity Detection · {new Date().toLocaleDateString("en-GB")}</span><h2>{selectedFieldName}</h2><p>Rotation-aware historical performance review</p></div><div className="report-score"><strong>{fieldRecords.length}</strong><span>crop seasons</span></div></div>
              <div className="report-method"><strong>Method statement</strong><p>The supplied crop history is reported as recorded. Each clear Sentinel-2 date is ranked within its field before a crop-window median is calculated; raw NDVI values from different crops are not averaged. Weather uses crop-specific ERA5/ERA5-Land windows. Zone conclusions remain unavailable until these cell composites are modelled and checked.</p></div>
              <h3>Crop history</h3>
              <div className="report-history">{fieldRecords.map((record) => <div key={record.id}><strong>{record.harvestYear}</strong><span>{cropName(record.cropCode)}</span><small>after {cropName(record.previousCropCode)} · {record.rotationPosition}</small></div>)}</div>
              <h3>Rotation-aware zone conclusions</h3>
              <table className="data-table report-table"><thead><tr><th>Zone</th><th>Classification</th><th>Crop years included</th><th>Dominance</th><th>Confidence</th></tr></thead><tbody>{analyses.map(({ zone, analysis }) => <tr key={zone.id}><td><strong>{zone.id} · {zone.name}</strong></td><td>{analysis.classification}</td><td>{analysis.evidence.map((row) => `${row.harvestYear} ${row.crop}`).join(", ") || "None"}</td><td>{cropName(analysis.dominantCrop)} {Math.round(analysis.dominantCropShare * 100)}% · {analysis.dominantYear ?? "—"} {Math.round(analysis.dominantYearShare * 100)}%</td><td>{analysis.confidenceLabel} {analysis.confidenceScore}%</td></tr>)}{!analyses.length && <tr><td colSpan={5}>{totalUsable ? "Real NDVI cell composites are linked; management zones have not yet been classified." : "No spatial observations or management-zone evidence supplied."}</td></tr>}</tbody></table>
              <div className="report-cautions"><strong>Limitations and field checks</strong><ul>{[...new Set(fieldRecords.flatMap(auditSeason))].map((warning) => <li key={warning}>{warning}</li>)}{!fieldRecords.flatMap(auditSeason).length && <li>No material crop-history completeness flags.</li>}<li>Disease, take-all, nutrient and drainage interpretations remain hypotheses until supported by field evidence.</li></ul></div>
            </article>
          </section>
        )}
      </main>

      {editRecord && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditRecord(null); }}>
          <aside className="edit-drawer" aria-label="Edit field-season">
            <div className="drawer-heading">
              <div><span className="eyebrow">Field-season record</span><h2>{editRecord.harvestYear} {cropName(editRecord.cropCode)}</h2></div>
              <button aria-label="Close editor" className="drawer-close" onClick={() => setEditRecord(null)}>×</button>
            </div>
            {auditSeason(editRecord).length > 0 && <div className="drawer-warnings"><strong>Analysis impact</strong>{auditSeason(editRecord).map((warning) => <p key={warning}>{warning}</p>)}</div>}
            <div className="form-grid">
              <label>Field name<input value={editRecord.fieldName} onChange={(event) => setEditRecord({ ...editRecord, fieldName: event.target.value })} /></label>
              <label>Stable field ID<input value={editRecord.fieldId} onChange={(event) => setEditRecord({ ...editRecord, fieldId: event.target.value })} /></label>
              <label>Field portion<input value={editRecord.portion} onChange={(event) => setEditRecord({ ...editRecord, portion: event.target.value })} /></label>
              <label>Boundary version<input value={editRecord.boundaryVersion} onChange={(event) => setEditRecord({ ...editRecord, boundaryVersion: event.target.value })} /></label>
              <label>Harvest year<input type="number" value={editRecord.harvestYear} onChange={(event) => setEditRecord({ ...editRecord, harvestYear: Number(event.target.value) })} /></label>
              <label>Crop<select value={editRecord.cropCode} onChange={(event) => setEditRecord({ ...editRecord, cropCode: event.target.value })}>{CROP_TAXONOMY.map((crop) => <option value={crop.code} key={crop.code}>{crop.name}</option>)}</select></label>
              <label>Crop type / use<input value={editRecord.cropTypeUse} onChange={(event) => setEditRecord({ ...editRecord, cropTypeUse: event.target.value })} /></label>
              <label>Variety<input value={editRecord.variety} onChange={(event) => setEditRecord({ ...editRecord, variety: event.target.value })} /></label>
              <label>Preceding crop<select value={editRecord.previousCropCode} onChange={(event) => setEditRecord({ ...editRecord, previousCropCode: event.target.value })}>{CROP_TAXONOMY.map((crop) => <option value={crop.code} key={crop.code}>{crop.name}</option>)}</select></label>
              <label>Rotation position<input value={editRecord.rotationPosition} onChange={(event) => setEditRecord({ ...editRecord, rotationPosition: event.target.value })} /></label>
              <label>Sowing date<input type="date" value={editRecord.sowingDate} onChange={(event) => setEditRecord({ ...editRecord, sowingDate: event.target.value })} /></label>
              <label>Harvest date<input type="date" value={editRecord.harvestDate} onChange={(event) => setEditRecord({ ...editRecord, harvestDate: event.target.value })} /></label>
              <label>Establishment method<input value={editRecord.establishmentMethod} onChange={(event) => setEditRecord({ ...editRecord, establishmentMethod: event.target.value })} /></label>
              <label>Cultivation system<input value={editRecord.cultivationSystem} onChange={(event) => setEditRecord({ ...editRecord, cultivationSystem: event.target.value })} /></label>
              <label>Seed rate<input value={editRecord.seedRate} onChange={(event) => setEditRecord({ ...editRecord, seedRate: event.target.value })} /></label>
              <label>End market<input value={editRecord.endMarket} onChange={(event) => setEditRecord({ ...editRecord, endMarket: event.target.value })} /></label>
              <label>Straw management<input value={editRecord.strawManagement} onChange={(event) => setEditRecord({ ...editRecord, strawManagement: event.target.value })} /></label>
              <label>Cover crop<input value={editRecord.coverCrop} onChange={(event) => setEditRecord({ ...editRecord, coverCrop: event.target.value })} /></label>
              <label>Organic manure<input value={editRecord.organicManure} onChange={(event) => setEditRecord({ ...editRecord, organicManure: event.target.value })} /></label>
              <label>Weather class<select value={editRecord.weatherClass} onChange={(event) => setEditRecord({ ...editRecord, weatherClass: event.target.value as FieldSeason["weatherClass"], weatherProvenance: "User override", weatherSummary: `User weather-class override: ${event.target.value}.` })}><option value="typical">Typical</option><option value="wet">Wet</option><option value="dry">Dry</option><option value="unknown">Unknown</option></select></label>
              <label className="full">Drainage / soil-structure work<textarea value={editRecord.drainageWork} onChange={(event) => setEditRecord({ ...editRecord, drainageWork: event.target.value })} /></label>
              <label className="full">Failure, reseeding, partial-field and management notes<textarea value={editRecord.notes} onChange={(event) => setEditRecord({ ...editRecord, notes: event.target.value })} /></label>
            </div>
            <div className="drawer-actions"><button className="secondary-button" onClick={() => setEditRecord(null)}>Cancel</button><button className="primary-button" onClick={saveEdit}>Save crop season</button></div>
          </aside>
        </div>
      )}
    </div>
  );
}
