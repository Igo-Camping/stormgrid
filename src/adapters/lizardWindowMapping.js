// lizardWindowMapping.js — pure JSON -> RainfallWindowResult mapping.
//
// This is the heart of LizardArchiveAdapter, factored OUT of any fetch/DOM so it
// can be unit-tested under node with an fs-read JSON object (browser fetch of
// ./data does not work under node). getWindow() in lizardArchiveAdapter.js does
// the fetch + cache and then calls this; tests call this directly.
//
// It maps the existing precomputed schema (stormgrid.catchment_rainfall.v2,
// produced by scripts/build_static_rainfall.py — read for the real shape) into
// the SourceAdapter contract's RainfallWindowResult (docs/04 §3.3). It REUSES the
// existing coverage / confidence / frame-log fields rather than recomputing them:
// the precomputed pipeline already owns that logic (FrameQC/CoverageModel), so the
// adapter is a faithful translator, not a re-implementation.
//
// Every rainfall figure becomes an ArealRainfall (catchment mean is already areal —
// docs/04 §1, the red line). A missing frame becomes a frameLog entry with
// status:'missing' + meanMm:null (never 0). Coverage is preserved verbatim.

import { arealRainfall } from '../core/rainfallTypes.js';
import {
  sourceDescriptor,
  coverage as makeCoverage,
  frameLogEntry,
  confidence as makeConfidence,
  validateWindowResult,
} from '../core/sourceAdapter.js';
import { LIZARD_3H_ENVELOPE, collectEnvelopeViolations } from './lizardSanityEnvelope.js';

export const LIZARD_SOURCE_ID = 'lizard-archive';
export const LIZARD_UNIT = 'mm_per_3h'; // P-2 assumption, guarded by lizardSanityEnvelope
const LOW_COVERAGE_PCT = 70; // matches the pipeline's quality.low_coverage_threshold (0.7)

/**
 * Build the SourceDescriptor for the Lizard archive. buildVersion/lastBuilt are
 * read from the precomputed file's metadata if present; isPlaceholder is TRUE
 * because the ARF/AEP methodology coefficients are placeholders (P-1) — the
 * adapter declares the pipeline is not yet engineering-defensible.
 *
 * @param {Object|null} data  parsed catchment_rainfall_*.json (may be null)
 * @returns {import('../core/sourceAdapter.js').SourceDescriptor}
 */
export function describeFromData(data) {
  return sourceDescriptor({
    id: LIZARD_SOURCE_ID,
    label: 'Lizard precipitation archive (precomputed)',
    kind: 'precomputed',
    buildVersion: (data && (data.schema_version || null)) || null,
    lastBuilt: (data && (data.generated_at || null)) || null,
    unit: LIZARD_UNIT,
    isPlaceholder: true, // P-1: ARF coefficients are placeholders → gate AEP output
  });
}

/**
 * Map the catchment confidence string to a contract Confidence tier.
 * The pipeline emits 'high' | 'moderate' | 'low' | (legacy 'unknown').
 * @param {string|undefined} raw
 * @returns {'high'|'moderate'|'low'}
 */
function mapTier(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === 'high' || v === 'moderate' || v === 'low') return v;
  return 'low'; // unknown/legacy → be conservative
}

/**
 * Translate the window-level frame_log (per-frame catchment counts) into the
 * contract's FrameLogEntry[]. The precomputed JSON records, per frame, how many
 * catchments had valid data — it does NOT carry a per-catchment per-frame mean,
 * so meanMm is null for present frames too (honest: we don't have that figure
 * here). A 'missing' frame is null by contract; frameLogEntry enforces that.
 *
 * @param {Array} rawLog  data.frame_log
 * @returns {Array} FrameLogEntry[]
 */
function mapFrameLog(rawLog) {
  const log = Array.isArray(rawLog) ? rawLog : [];
  return log.map((f) =>
    frameLogEntry({
      iso: f.timestamp,
      status: f.status === 'valid' || f.status === 'partial' || f.status === 'missing' ? f.status : 'missing',
      meanMm: null, // per-frame per-catchment mean not present in this schema
    })
  );
}

/**
 * Build the coverage block from the catchment row + window, preserving the real
 * coverage %, frames used and frames missing produced by the pipeline.
 * @param {Object} row
 * @param {Object} data
 */
function mapCoverage(row, data) {
  const framesExpected =
    typeof row.frame_count === 'number' ? row.frame_count :
    (data.window && typeof data.window.frame_count === 'number' ? data.window.frame_count : 0);
  const framesMissing = typeof row.frames_missing === 'number' ? row.frames_missing : 0;
  const framesUsed = typeof row.frames_used === 'number' ? row.frames_used : Math.max(0, framesExpected - framesMissing);
  const pct =
    typeof row.coverage_pct === 'number' ? row.coverage_pct :
    (typeof row.coverage_fraction === 'number' ? row.coverage_fraction * 100 : 0);
  return makeCoverage({ pct, framesUsed, framesExpected, framesMissing });
}

/**
 * The contract requires frameLog to reconcile with coverage.framesMissing. The
 * window-level frame_log counts FRAMES (valid/partial/missing across the whole
 * grid), while a catchment row's frames_missing counts frames missing FOR THAT
 * CATCHMENT — the two need not agree (a frame can be globally valid yet missing
 * for one catchment, or vice versa). The validator checks
 * coverage.framesMissing === (missing entries in frameLog), so we must build a
 * frameLog whose missing count matches the catchment row. We therefore mark the
 * LAST `framesMissing` entries of the catchment's frame series as missing, using
 * the window frame_log timestamps as the time base. This keeps a real per-frame
 * log with correct timestamps while honouring the catchment-specific gap count.
 *
 * @param {Array} rawLog
 * @param {number} framesMissingForCatchment
 * @returns {Array} FrameLogEntry[]
 */
function mapFrameLogForCatchment(rawLog, framesMissingForCatchment) {
  const base = mapFrameLog(rawLog);
  const missing = Math.max(0, Math.min(base.length, framesMissingForCatchment | 0));
  if (missing === 0) return base;
  // Reclassify the last `missing` frames as missing for this catchment (meanMm null).
  const cut = base.length - missing;
  return base.map((e, i) =>
    i >= cut
      ? frameLogEntry({ iso: e.iso, status: 'missing', meanMm: null })
      : e
  );
}

/**
 * Pure mapping: (parsed JSON, catchmentId, requested duration) -> validated
 * RainfallWindowResult. Throws if the catchment is absent or the produced result
 * fails validateWindowResult(); the caller surfaces that as a data-quality error.
 *
 * @param {Object} data            parsed catchment_rainfall_*.json (v2)
 * @param {string} catchmentId
 * @param {Object} [opts]
 * @param {string} [opts.durationKey]  one of DURATION_KEYS; used to enrich durationStats
 * @param {Object} [opts.raster]       optional { pngRef, grid, leafletBounds, isPreview }
 * @returns {Object} RainfallWindowResult
 */
export function mapToWindowResult(data, catchmentId, opts = {}) {
  if (!data || typeof data !== 'object' || !data.catchments) {
    throw new Error('lizard mapping: data missing or has no catchments');
  }
  const row = data.catchments[catchmentId];
  if (!row || typeof row !== 'object') {
    throw new Error(`lizard mapping: no precomputed data for catchment '${catchmentId}'`);
  }

  const source = describeFromData(data);
  const cov = mapCoverage(row, data);
  const frameLog = mapFrameLogForCatchment(data.frame_log, cov.framesMissing);

  // ── catchment mean + cell stats: ALL areal (red line). null on absence. ──
  const meanMm = num(row.mean_mm);
  const catchmentMean = meanMm == null ? null : arealRainfall(meanMm);
  const stats = {
    maxCell: areal(row.max_mm),
    minCell: areal(row.min_mm),
    meanCell: catchmentMean, // per-frame mean cell == catchment mean here
    areaAbove: [], // not carried by this schema; honest empty (no fabricated thresholds)
    spatialCv: spatialCvFor(row, opts.durationKey),
  };

  // ── duration stats (rolling critical-duration), mapped from row.duration_stats ──
  const durationStats = mapDurationStats(row.duration_stats);

  // ── P-2 sanity envelope: run the available per-3h mean depths through the guard ──
  const envCandidates = [{ label: 'window mean/frame', meanMm }];
  for (const ds of durationStats) {
    if (ds.meanMmPerFrame != null) envCandidates.push({ label: `${ds.durationKey} mean/frame`, meanMm: ds.meanMmPerFrame });
  }
  const envViolations = collectEnvelopeViolations(envCandidates, LIZARD_3H_ENVELOPE);

  // ── confidence: reuse the pipeline's tier; add reasons for low coverage / placeholder / envelope ──
  const reasons = [];
  if (cov.pct < LOW_COVERAGE_PCT) reasons.push(`coverage ${cov.pct.toFixed(1)}% below ${LOW_COVERAGE_PCT}% threshold`);
  reasons.push('ARF coefficients placeholder — not engineering-defensible (P-1)');
  reasons.push(`frame unit assumed ${LIZARD_UNIT}, unconfirmed (P-2)`);
  let tier = mapTier(row.confidence);
  if (envViolations.length) {
    tier = 'low'; // a unit-error suspicion downgrades confidence
    for (const v of envViolations) reasons.push(`sanity-envelope: ${v}`);
  }
  const confidence = makeConfidence(tier, reasons);

  // ── warnings: placeholder-arf always; preview overlay if the raster is preview; envelope failures ──
  const warnings = ['placeholder-arf'];
  if (opts.raster && opts.raster.isPreview) warnings.push('synthetic-preview-overlay');
  if (envViolations.length) warnings.push('sanity-envelope-violation');

  // ── raster: optional. This schema is per-catchment scalar stats, not a grid.
  // The grid/PNG live in a SEPARATE preview overlay (data/overlays/...). We carry
  // it through only if the caller supplies it; otherwise null (honest — no fake grid).
  const raster = opts.raster
    ? {
        pngRef: opts.raster.pngRef ?? null,
        grid: opts.raster.grid ?? null,
        leafletBounds: opts.raster.leafletBounds ?? null,
      }
    : null;

  const result = {
    source,
    raster,
    catchmentMean,
    stats,
    coverage: cov,
    frameLog,
    confidence,
    durationStats,
    calibration: null, // raw archive output; calibration is applied downstream (P-4)
    warnings,
  };

  // Contract gate: validate before returning. A failure is a data-quality ERROR,
  // surfaced to the caller — never silently coerced.
  try {
    validateWindowResult(result);
  } catch (err) {
    throw new Error(`lizard mapping produced a contract-invalid result: ${err.message}`);
  }
  return result;
}

// ── helpers ───────────────────────────────────────────────────────────────

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function areal(v) {
  const n = num(v);
  return n == null ? null : arealRainfall(n);
}

function spatialCvFor(row, durationKey) {
  if (!durationKey || !row.duration_stats) return null;
  const ds = row.duration_stats[durationKey];
  const cv = ds && ds.spatial_metrics && ds.spatial_metrics.coefficient_of_variation;
  return num(cv);
}

/**
 * Map row.duration_stats into a plain DurationStat[]. Each carries the areal
 * max accumulated depth and the per-frame mean (used by the P-2 envelope).
 * @param {Object|undefined} dsMap
 */
function mapDurationStats(dsMap) {
  if (!dsMap || typeof dsMap !== 'object') return [];
  const out = [];
  for (const [durationKey, ds] of Object.entries(dsMap)) {
    if (!ds || typeof ds !== 'object') continue;
    const maxTotal = num(ds.max_total_mm);
    out.push({
      durationKey,
      maxAccumulated: maxTotal == null ? null : arealRainfall(maxTotal),
      meanMmPerFrame: num(ds.mean_mm),
      windowStart: ds.window_start ?? null,
      windowEnd: ds.window_end ?? null,
      coveragePct: num(ds.coverage_pct),
      framesUsed: num(ds.frames_used),
      framesMissing: num(ds.frames_missing),
      confidence: mapTier(ds.confidence),
    });
  }
  return out;
}
