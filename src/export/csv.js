// csv.js — CSV exporter (SALVAGED + ported, WORKING).
//
// docs/01 §3.6: CSV "works today — `#`-comment audit header + columns; carries
// provenance: yes". This is the port of stormgridExports.exportCsv onto the new
// footprint (footprint.js). The provenance header is KEPT and extended to the new
// contract fields (source kind/build, coverage %, framesMissing, confidence tier,
// calibration mode, AEP gate status). Gaps render as empty cells, never 0.
//
// The legacy CSV emitted one row per catchment (the old per-catchment ranking
// schema). The new RainfallWindowResult is a single (location, timeframe, duration)
// window with already-areal stats + a per-frame log, so the canonical CSV here is
// the FRAME LOG (one row per frame, gaps included) under the provenance header —
// this is the row-shaped data the new contract actually carries, and it preserves
// every missing frame honestly. The areal summary stats live in the header block.
//
// No new science. Pure string assembly + a Blob download.

import { triggerDownload } from './download.js';
import { suggestExportFilename, summariseFootprint } from './footprint.js';

const FRAME_FIELDS = ['frame_iso', 'status', 'mean_mm'];

/** Build the CSV text for a footprint (pure; testable without the DOM). */
export function buildCsv(fp) {
  const lines = [];
  const s = summariseFootprint(fp);
  const p = fp.provenance || {};
  const cov = fp.coverage || {};
  const conf = fp.confidence || {};
  const loc = (fp.context && fp.context.location) || {};
  const tf = (fp.context && fp.context.timeframe) || {};

  // ── Audit / provenance header — non-data lines starting with '#'. ──
  lines.push(`# stormgrid event footprint — ${cell(fp.schemaVersion)}`);
  lines.push(`# generated_at,${cell(fp.generatedAt)}`);
  lines.push(`# defensible,${cell(fp.defensible)}`);
  lines.push(`# is_synthetic,${cell(fp.isSynthetic)}`);
  lines.push(`# location_kind,${cell(loc.kind)}`);
  lines.push(`# location_id,${cell(loc.catchmentId || loc.areaRef || (loc.lat != null ? `${loc.lat},${loc.lon}` : ''))}`);
  lines.push(`# location_is_authoritative,${cell(loc.isAuthoritative)}`);
  lines.push(`# timeframe_kind,${cell(tf.kind)}`);
  lines.push(`# timeframe_window,${cell(tf.windowKey || tf.eventId || '')}`);
  lines.push(`# timeframe_end,${cell(tf.endIso)}`);
  lines.push(`# duration,${cell(fp.context && fp.context.duration)}`);
  lines.push(`# calibration_mode,${cell(fp.calibration && fp.calibration.displayMode)}`);
  lines.push(`# calibration_applied,${cell(fp.calibration && fp.calibration.applied)}`);
  // Provenance (travels unchanged from the SourceDescriptor).
  lines.push(`# source_id,${cell(p.sourceId)}`);
  lines.push(`# source_label,${cell(p.sourceLabel)}`);
  lines.push(`# source_kind,${cell(p.kind)}`);
  lines.push(`# source_build_version,${cell(p.buildVersion)}`);
  lines.push(`# source_last_built,${cell(p.lastBuilt)}`);
  lines.push(`# source_unit,${cell(p.unit)}`);
  lines.push(`# source_is_placeholder,${cell(p.isPlaceholder)}`);
  // Coverage + confidence (gap accounting).
  lines.push(`# coverage_pct,${cell(cov.pct)}`);
  lines.push(`# frames_used,${cell(cov.framesUsed)}`);
  lines.push(`# frames_expected,${cell(cov.framesExpected)}`);
  lines.push(`# frames_missing,${cell(cov.framesMissing)}`);
  lines.push(`# confidence_tier,${cell(conf.tier)}`);
  lines.push(`# confidence_reasons,${cell((conf.reasons || []).join(' | '))}`);
  // Areal summary stats (already-areal; gaps blank, never 0).
  lines.push(`# catchment_mean_mm,${cell(s.catchmentMeanMm)}`);
  lines.push(`# max_cell_mm,${cell(s.maxCellMm)}`);
  lines.push(`# min_cell_mm,${cell(s.minCellMm)}`);
  lines.push(`# spatial_cv,${cell(s.spatialCv)}`);
  // AEP gate status (P-1).
  lines.push(`# aep_engineering_grade_allowed,${cell(fp.aep && fp.aep.engineeringGradeAllowed)}`);
  lines.push(`# aep_gate_reason,${cell(fp.aep && fp.aep.gateReason)}`);
  // Warnings.
  if (Array.isArray(fp.warnings) && fp.warnings.length) {
    lines.push(`# warnings,${cell(fp.warnings.join(' | '))}`);
  }
  lines.push(`# frame_count,${cell((fp.frameLog || []).length)}`);

  // ── Frame-log data rows (one per frame; gaps included, mean blank). ──
  lines.push(FRAME_FIELDS.join(','));
  for (const f of fp.frameLog || []) {
    // A missing frame's mean is null by contract → blank cell, never 0.
    lines.push([cell(f.iso), cell(f.status), cell(f.meanMm)].join(','));
  }

  return lines.join('\n') + '\n';
}

/** Build the CSV and trigger a browser download. */
export function exportCsv(fp) {
  const blob = new Blob([buildCsv(fp)], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, suggestExportFilename(fp, 'csv'));
}

function cell(v) {
  if (v === null || v === undefined) return '';
  const str = String(v);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}
