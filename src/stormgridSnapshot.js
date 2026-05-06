/* Stormgrid — event footprint / snapshot model.
   Pure data: no DOM, no fetches. Builds the canonical, self-describing
   object that every export downstream reads from. Never invents values
   — only reads what's already in state + the loaded JSON. */

import { buildCatchmentRanking } from './stormgridRanking.js';

export const FOOTPRINT_SCHEMA = 'stormgrid.event_footprint.v1';

export function buildEventFootprint({
  state,
  rainfallResult,
  rankingFilters,
  rankingSort,
  selectedCatchmentId,
}) {
  const ok   = !!(rainfallResult && rainfallResult.ok && rainfallResult.data);
  const data = ok ? rainfallResult.data : null;
  const durationKey = state && state.selectedDuration ? state.selectedDuration : null;

  const ranking = ok && durationKey
    ? buildCatchmentRanking(data, durationKey, {
        filters: rankingFilters || {},
        sort:    rankingSort    || { key: 'max', order: 'desc' },
      })
    : [];

  // Compact catchment row for export. Includes geometry-free metadata
  // so JSON consumers don't depend on the catchments GeoJSON file.
  const catchments = ranking.map((r, i) => ({
    rank: i + 1,
    catchment_id:   r.id,
    catchment_name: r.id, // placeholder — no separate name field in current dataset
    critical_duration: durationKey,
    max_total_mm:           r.max_total_mm,
    coverage_pct:           r.coverage_pct,
    confidence:             r.confidence,
    critical_window_start:  r.window_start,
    critical_window_end:    r.window_end,
    coefficient_of_variation:    r.cv,
    uniformity_index:            uniformityFromCv(r.cv),
    wet_core_ratio:              r.wet_core,
    spatial_concentration_class: r.spatial_class,
  }));

  return {
    schema_version:        FOOTPRINT_SCHEMA,
    generated_at:          new Date().toISOString(),
    selected_catchment_id: selectedCatchmentId || null,
    accumulation_window:   state ? state.selectedWindow : null,
    critical_duration:     durationKey,
    map_colour_mode:       state ? state.mapColourMode : null,
    filters:               { ...(rankingFilters || {}) },
    sort:                  { ...(rankingSort    || { key: 'max', order: 'desc' }) },
    source: ok ? {
      kind:           data.source,
      data_schema:    data.schema_version,
      data_generated: data.generated_at,
      window:         data.window,
      quality:        data.quality || null,
    } : null,
    catchment_count: catchments.length,
    catchments,
  };
}

export function summariseFootprint(fp) {
  if (!fp || !Array.isArray(fp.catchments) || fp.catchments.length === 0) {
    return {
      catchment_count: fp ? fp.catchment_count : 0,
      highest_rainfall_mm: null,
      highest_id: null,
      highest_window: null,
      spatial_summary: 'no catchments in this view',
      confidence_summary: 'no data',
    };
  }
  const top = fp.catchments[0];
  const classCounts = {};
  const confCounts  = {};
  let cvMin = Infinity, cvMax = -Infinity;
  for (const c of fp.catchments) {
    const cls = c.spatial_concentration_class || 'unknown';
    classCounts[cls] = (classCounts[cls] || 0) + 1;
    const cf = (c.confidence || 'unknown').toLowerCase();
    confCounts[cf] = (confCounts[cf] || 0) + 1;
    if (typeof c.coefficient_of_variation === 'number') {
      if (c.coefficient_of_variation < cvMin) cvMin = c.coefficient_of_variation;
      if (c.coefficient_of_variation > cvMax) cvMax = c.coefficient_of_variation;
    }
  }
  const classSummary = Object.entries(classCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v}× ${k}`)
    .join(', ');
  const confSummary = ['high', 'medium', 'low', 'unknown']
    .filter((k) => confCounts[k])
    .map((k) => `${confCounts[k]} ${k.toUpperCase()}`)
    .join(' · ');
  const cvRange = (Number.isFinite(cvMin) && Number.isFinite(cvMax))
    ? `CV ${cvMin.toFixed(3)}–${cvMax.toFixed(3)}`
    : null;
  return {
    catchment_count: fp.catchment_count,
    highest_rainfall_mm: top.max_total_mm,
    highest_id: top.catchment_id,
    highest_window: top.critical_window_start && top.critical_window_end
      ? `${top.critical_window_start.replace('T', ' ').replace('Z', ' UTC')} → ${top.critical_window_end.replace('T', ' ').replace('Z', ' UTC')}`
      : null,
    spatial_summary: cvRange ? `${classSummary} (${cvRange})` : classSummary,
    confidence_summary: confSummary || 'no confidence data',
  };
}

function uniformityFromCv(cv) {
  if (typeof cv !== 'number' || !Number.isFinite(cv)) return null;
  return Math.round((1 - Math.min(cv / 2, 1)) * 10000) / 10000;
}

/* Filename for an export of the given footprint + extension.
   Deterministic per (window, duration, mode, generated_at). */
export function suggestExportFilename(fp, ext) {
  const w = fp.accumulation_window || 'window';
  const d = fp.critical_duration   || 'dur';
  const m = (fp.map_colour_mode || 'mode').replace(/[^a-zA-Z0-9]/g, '');
  const ts = (fp.generated_at || new Date().toISOString())
    .replace(/[-:]/g, '')
    .replace(/\.\d+/, '')
    .replace(/Z$/, 'Z');
  return `stormgrid_${w}_${d}_${m}_${ts}.${ext}`;
}
