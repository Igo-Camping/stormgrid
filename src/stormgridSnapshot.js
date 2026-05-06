/* Stormgrid — event footprint / snapshot model.
   Pure data: no DOM, no fetches. Builds the canonical, self-describing
   object that every export downstream reads from. Never invents values
   — only reads what's already in state + the loaded JSON. */

import { buildCatchmentRanking } from './stormgridRanking.js';
import { computeArfTable, getRegion, getValidity } from './stormgridArf.js';
import { computeDurationComparison, summariseComparisons } from './stormgridDesignComparison.js';
import { buildEventInterpretation } from './stormgridEventInterpretation.js';

const DURATION_KEYS = ['3h', '6h', '12h', '24h', '48h', '72h'];
const DURATION_HOURS = { '3h': 3, '6h': 6, '12h': 12, '24h': 24, '48h': 48, '72h': 72 };
const AEP_COLUMNS    = ['20%', '5%', '2%', '1%'];

export const FOOTPRINT_SCHEMA = 'stormgrid.event_footprint.v1';

export function buildEventFootprint({
  state,
  rainfallResult,
  rankingFilters,
  rankingSort,
  selectedCatchmentId,
  ifdResult,
  arfResult,
  selectedCatchmentFeature,
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

  // Optional point-IFD context block. Always carries a methodology
  // safeguard so downstream consumers cannot mistake it for an AEP
  // classification or an ARF-adjusted areal design rainfall.
  let pointIfd = null;
  if (ifdResult && ifdResult.ok && ifdResult.data) {
    const ifdData = ifdResult.data;
    const sel = selectedCatchmentId ? ifdData.catchments[selectedCatchmentId] : null;
    pointIfd = {
      point_ifd_only: true,
      arf_applied:    false,
      warning: (ifdData.methodology && ifdData.methodology.warning) ||
        'Point IFD only. ARF not applied. Not a catchment AEP classification.',
      reference_point_rule: ifdData.methodology && ifdData.methodology.reference_point_rule,
      source: ifdData.source || null,
      schema_version: ifdData.schema_version,
      data_generated: ifdData.generated_at,
      durations:      ifdData.durations || null,
      aep_keys:       ifdData.aep_keys  || null,
      selected_catchment: sel ? {
        catchment_id:                  selectedCatchmentId,
        catchment_centroid:            sel.catchment_centroid,
        reference_station_id:          sel.reference_station_id,
        reference_station_name:        sel.reference_station_name,
        reference_station_lonlat:      sel.reference_station_lonlat,
        reference_station_distance_km: sel.reference_station_distance_km,
        durations:                     sel.durations,
      } : null,
    };
  }

  // Optional ARR2019 ARF engine block. Only emitted when ARF mode is
  // active AND coefficients are loaded. Carries methodology flags so a
  // downstream consumer can refuse to use unverified values.
  let arfEngine = null;
  let arfData = null;
  if (state && state.ifdDisplayMode === 'arf' && arfResult && arfResult.ok && arfResult.data) {
    arfData = arfResult.data;
    let areaKm2 = null;
    if (selectedCatchmentFeature && selectedCatchmentFeature.properties) {
      const a = selectedCatchmentFeature.properties.area_ha;
      if (typeof a === 'number' && Number.isFinite(a)) areaKm2 = a / 100;
    }
    arfEngine = {
      mode:            'arf_adjusted_areal_design_rainfall',
      schema_version:  arfData.schema_version,
      coefficients_verified: arfData.verified === true,
      warning:         arfData.warning,
      form:            arfData.form,
      form_description: arfData.form_description,
      validity:        arfData.validity,
      region:          arfData.default_region,
      coefficients:    arfData.regions ? (arfData.regions[arfData.default_region] || null) : null,
      catchment_area_km2: areaKm2,
      methodology_note: 'ARF-adjusted areal design rainfall only. No event AEP classification, no return period, no exceedance assertion. Verify coefficients against ARR2019 Book 2 Ch. 4 before any engineering use.',
    };
  }

  // Phase 8 — comparison interpretation. Built only when ARF mode AND
  // we have everything needed to run a real comparison; flags assert
  // that no AEP / return-period / exceedance claim has been made.
  // Phase 9 — interpretation framework rolls up Phase 8's per-duration
  // bands into a multi-duration consistency + confidence summary.
  let comparisonSummary = null;
  let eventInterpretation = null;
  if (arfEngine && pointIfd && pointIfd.selected_catchment && Number.isFinite(arfEngine.catchment_area_km2)) {
    const region = getRegion(arfResult.data);
    const validity = getValidity(arfResult.data);
    const coeff = region && region.coefficients;
    const cifdDurs = pointIfd.selected_catchment.durations || {};
    const observedByDur = {};
    if (ok && selectedCatchmentId) {
      const cRow = data.catchments && data.catchments[selectedCatchmentId];
      if (cRow && cRow.duration_stats) {
        for (const dk of DURATION_KEYS) {
          const ds = cRow.duration_stats[dk];
          if (ds && typeof ds.max_total_mm === 'number') observedByDur[dk] = ds.max_total_mm;
        }
      }
    }
    const byDur = {};
    for (const dk of DURATION_KEYS) {
      const ifdRow = cifdDurs[dk];
      if (!ifdRow || ifdRow.quality_flag === 'suspect_non_monotonic' || !ifdRow.aep) continue;
      if (!coeff) continue;
      const t = computeArfTable({
        areaKm2: arfEngine.catchment_area_km2,
        durationHours: DURATION_HOURS[dk],
        aepKeys: AEP_COLUMNS,
        coefficients: coeff,
        validity,
      });
      const arfDepthsByAep = {};
      for (const p of AEP_COLUMNS) {
        const v = ifdRow.aep[p];
        const ar = t.arf_by_aep[p] && t.arf_by_aep[p].arf;
        if (typeof v === 'number' && typeof ar === 'number') arfDepthsByAep[p] = v * ar;
      }
      const obs = observedByDur[dk];
      if (typeof obs !== 'number' || Object.keys(arfDepthsByAep).length === 0) continue;
      byDur[dk] = computeDurationComparison({ observedMm: obs, arfDepthsByAep });
    }
    if (Object.keys(byDur).length > 0) comparisonSummary = summariseComparisons(byDur);
    // Phase 9 — interpretation framework. Computed when comparisonSummary
    // is built; same methodology safeguards baked in.
    if (Object.keys(byDur).length > 0) {
      let coverageMin = Infinity;
      let suspectCount = 0;
      const cRow = ok && selectedCatchmentId ? data.catchments[selectedCatchmentId] : null;
      for (const dk of Object.keys(byDur)) {
        const ds = cRow && cRow.duration_stats ? cRow.duration_stats[dk] : null;
        if (ds && typeof ds.coverage_pct === 'number') {
          coverageMin = Math.min(coverageMin, ds.coverage_pct / 100);
        }
        const ifdRow = cifdDurs[dk];
        if (ifdRow && ifdRow.quality_flag === 'suspect_non_monotonic') suspectCount += 1;
      }
      if (!Number.isFinite(coverageMin)) coverageMin = null;
      eventInterpretation = buildEventInterpretation({
        catchmentId: selectedCatchmentId,
        comparisonByDuration: byDur,
        coefficientsVerified: !!(arfData && arfData.verified === true),
        observedCoverageMin: coverageMin,
        suspectIfdCount: suspectCount,
      });
    }
  }

  return {
    schema_version:        FOOTPRINT_SCHEMA,
    generated_at:          new Date().toISOString(),
    selected_catchment_id: selectedCatchmentId || null,
    accumulation_window:   state ? state.selectedWindow : null,
    critical_duration:     durationKey,
    map_colour_mode:       state ? state.mapColourMode : null,
    ifd_display_mode:      state ? state.ifdDisplayMode : 'point',
    filters:               { ...(rankingFilters || {}) },
    sort:                  { ...(rankingSort    || { key: 'max', order: 'desc' }) },
    source: ok ? {
      kind:           data.source,
      data_schema:    data.schema_version,
      data_generated: data.generated_at,
      window:         data.window,
      quality:        data.quality || null,
    } : null,
    point_ifd:       pointIfd,
    arf_engine:      arfEngine,
    comparison_summary: comparisonSummary,
    event_interpretation: eventInterpretation,
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
