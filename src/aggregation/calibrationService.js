// calibrationService.js — raw-preserving, labelled, versioned calibration over
// the SourceAdapter contract (docs/04 §1 rule 1 red line; docs/02 §4; docs/03 §2).
//
// THE RED LINE (docs/04 §1): raw is immutable; calibration is a SEPARATE, LABELLED,
// VERSIONED artefact. This module NEVER mutates the raw RainfallWindowResult. It
// returns a deep COPY whose areal figures are scaled by a transparent
// multiplicative bias factor, with the original raw values preserved alongside
// (raw_catchmentMean, raw_stats, raw_durationStats) and a CalibrationMeta block
// ({ applied, method, version, rawPreserved:true }) attached.
//
// It is a thin REWRITE/WRAPPER of the salvaged IDW logic in
// ../stormgridCalibration.js. That salvaged code calibrates the *raw archive JSON*
// shape (total_mm/mean_mm/…); this service calibrates the *contract* shape
// (branded ArealRainfall value objects). It reuses the salvaged pairing + IDW
// factor computation verbatim and only re-targets where the factor is applied.
//
// Synthetic-gauge honesty (P-4): data/gauge_observations.json is is_synthetic:true.
// Any calibrated output therefore carries a 'synthetic-gauges' warning so the
// number is labelled illustrative, never presented as engineering-defensible.
//
// What it does NOT do:
//   • It does not apply ARF or touch the point side — calibration is a bias
//     correction on already-areal observed values; the areal-vs-point boundary is
//     untouched (the calibrated values stay branded ArealRainfall).
//   • It does not invent coverage/frame/confidence data; gap fields pass through
//     unchanged so the calibrated copy still validates and still tells the truth
//     about missing frames.

import { arealRainfall, isAreal, mmOf } from '../core/rainfallTypes.js';
import { validateWindowResult } from '../core/sourceAdapter.js';
import {
  loadGaugeObservations,
  computePairings,
  computeCalibrationFactors,
  CALIBRATION_METHODOLOGY_NOTE,
} from '../stormgridCalibration.js';

// Versioned so a calibrated artefact records which calibration logic produced it.
// Bump on any change to the factor maths or the applied-fields set.
export const CALIBRATION_VERSION = 'stormgrid.calibration.v1';
export const CALIBRATION_METHOD = 'multiplicative_bias_idw_p2';
const SYNTHETIC_WARNING = 'synthetic-gauges';

/**
 * Round to 3 dp for display parity with the salvaged pipeline, while keeping the
 * branded value a real number. We round the *scaled* mm only; raw is preserved
 * exactly.
 * @param {number} n
 */
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Scale a single branded ArealRainfall by a factor, preserving null gaps.
 * Returns a NEW ArealRainfall (or null). Never coerces a gap to 0.
 * @param {Object|null} areal
 * @param {number} factor
 * @returns {Object|null}
 */
function scaleAreal(areal, factor) {
  if (areal == null) return null;
  if (!isAreal(areal)) {
    throw new TypeError('calibrationService: expected a branded ArealRainfall or null');
  }
  // Identity factor must reproduce the raw value EXACTLY — an identity calibration
  // (applied:false) is not allowed to drift the number through rounding.
  if (factor === 1) return arealRainfall(areal.mm);
  return arealRainfall(round3(areal.mm * factor));
}

/**
 * Resolve the calibration factor for the result's catchment.
 *
 * The contract RainfallWindowResult is per-catchment scalar (one catchment mean),
 * so we need exactly one factor: the IDW-projected bias for this catchment. The
 * salvaged computeCalibrationFactors projects a factor onto every catchment in the
 * supplied GeoJSON from the valid gauge/radar pairs; we read this catchment's
 * entry. When pairing inputs are unavailable, the honest result is "no calibration
 * available" — the caller surfaces that rather than silently applying identity.
 *
 * @param {Object} args
 * @param {Object} args.gaugeData      parsed gauge_observations.json
 * @param {Object} args.rainfallData   raw archive JSON for the window (radar totals)
 * @param {Object} args.geojson        catchment polygons (centroids for IDW)
 * @param {string} args.windowKey      e.g. '24h'
 * @param {string} args.catchmentId
 * @returns {{ factor:number|null, nearestGaugeKm:number|null, nPairsValid:number }}
 */
function resolveFactorForCatchment({ gaugeData, rainfallData, geojson, windowKey, catchmentId }) {
  const pairings = computePairings({ gaugeData, rainfallData, geojson, windowKey });
  const factors = computeCalibrationFactors({ pairings, geojson });
  const factor = factors.factor_by_catchment[catchmentId];
  const nearest = factors.nearest_pair_distance_km_by_catchment[catchmentId];
  return {
    factor: typeof factor === 'number' ? factor : null,
    nearestGaugeKm: typeof nearest === 'number' ? nearest : null,
    nPairsValid: pairings.n_pairs_valid,
  };
}

/**
 * Produce a calibrated COPY of a RainfallWindowResult.
 *
 * Raw is preserved on the copy under raw_* keys; the calibrated copy's areal
 * figures are the raw × factor; a CalibrationMeta block is attached; and the
 * 'synthetic-gauges' warning is appended (deduped) when the gauge source is
 * synthetic, plus 'calibrated' is implied by calibration.applied. The copy is
 * re-run through validateWindowResult before return (contract gate, docs/04 §5).
 *
 * The factor + gauge data may be injected (tests, or a caller that already
 * loaded them); otherwise they are loaded from the committed gauge file +
 * the supplied raw archive + geojson. If no valid pairing exists, calibration
 * degrades to an explicit identity tagged applied:false — never a silent scale.
 *
 * @param {Object} rawResult                a contract RainfallWindowResult (raw, NOT mutated)
 * @param {Object} [opts]
 * @param {number} [opts.factor]            pre-resolved bias factor (skip pairing)
 * @param {number} [opts.nearestGaugeKm]    nearest gauge distance for provenance
 * @param {boolean} [opts.synthetic]        force the synthetic flag (else from gaugeData)
 * @param {Object}  [opts.gaugeData]        parsed gauge observations (skip fetch)
 * @param {Object}  [opts.rainfallData]     raw archive JSON (needed if factor not supplied)
 * @param {Object}  [opts.geojson]          catchment polygons (needed if factor not supplied)
 * @param {string}  [opts.windowKey]        archive window key (needed if factor not supplied)
 * @param {string}  [opts.catchmentId]      catchment id (needed if factor not supplied)
 * @returns {Promise<Object>} a NEW calibrated RainfallWindowResult
 */
export async function deriveCalibratedResult(rawResult, opts = {}) {
  if (!rawResult || typeof rawResult !== 'object') {
    throw new TypeError('deriveCalibratedResult: a RainfallWindowResult is required');
  }

  // Resolve the gauge source for the synthetic flag + (if needed) factor maths.
  let gaugeData = opts.gaugeData || null;
  let synthetic = opts.synthetic;
  if (gaugeData == null && (opts.factor == null || synthetic == null)) {
    const loaded = await loadGaugeObservations();
    if (loaded && loaded.ok && loaded.data) gaugeData = loaded.data;
  }
  if (synthetic == null) {
    // Default to TRUE (illustrative) when we cannot prove the gauges are real —
    // err toward labelling output as non-defensible, never the reverse.
    synthetic = gaugeData ? Boolean(gaugeData.is_synthetic) : true;
  }

  // Resolve the factor.
  let factor = opts.factor;
  let nearestGaugeKm = opts.nearestGaugeKm ?? null;
  if (typeof factor !== 'number') {
    if (!gaugeData || !opts.rainfallData || !opts.geojson || !opts.windowKey || !opts.catchmentId) {
      // We cannot honestly compute a factor without the pairing inputs. Degrade to
      // an explicit, labelled identity rather than guessing or silently scaling.
      return buildCalibratedCopy(rawResult, {
        factor: 1,
        applied: false,
        synthetic,
        nearestGaugeKm: null,
        note: 'no gauge/radar pairing inputs available — calibrated mode is identity',
      });
    }
    const resolved = resolveFactorForCatchment({
      gaugeData,
      rainfallData: opts.rainfallData,
      geojson: opts.geojson,
      windowKey: opts.windowKey,
      catchmentId: opts.catchmentId,
    });
    factor = resolved.factor;
    nearestGaugeKm = resolved.nearestGaugeKm;
    if (factor == null) {
      return buildCalibratedCopy(rawResult, {
        factor: 1,
        applied: false,
        synthetic,
        nearestGaugeKm: null,
        note: 'no valid gauge pairing for this catchment/window — calibrated mode is identity',
      });
    }
  }

  return buildCalibratedCopy(rawResult, {
    factor,
    applied: factor !== 1,
    synthetic,
    nearestGaugeKm,
    note: null,
  });
}

/**
 * Build the calibrated copy (pure). Preserves raw under raw_* keys, scales the
 * areal figures, tags CalibrationMeta, appends warnings, and re-validates.
 *
 * @param {Object} rawResult
 * @param {{factor:number, applied:boolean, synthetic:boolean, nearestGaugeKm:number|null, note:string|null}} cfg
 * @returns {Object}
 */
function buildCalibratedCopy(rawResult, cfg) {
  const { factor, applied, synthetic, nearestGaugeKm, note } = cfg;

  // Scale the areal observed figures. Gaps (null) pass through unchanged.
  const catchmentMean = scaleAreal(rawResult.catchmentMean ?? null, factor);
  const rawStats = rawResult.stats || {};
  const stats = {
    ...rawStats,
    maxCell: scaleAreal(rawStats.maxCell ?? null, factor),
    minCell: scaleAreal(rawStats.minCell ?? null, factor),
    meanCell: scaleAreal(rawStats.meanCell ?? null, factor),
    // areaAbove thresholds are areal-fraction descriptors, not depths — leaving the
    // thresholds untouched would mislabel them under calibration; we scale the
    // thresholdMm so "area above X mm" stays meaningful against calibrated depths.
    areaAbove: Array.isArray(rawStats.areaAbove)
      ? rawStats.areaAbove.map((a) => ({ ...a, thresholdMm: round3((a.thresholdMm || 0) * factor) }))
      : [],
    // spatialCv is dimensionless (a ratio) — invariant under a uniform multiplicative
    // scale, so it is preserved exactly. (CV = stddev/mean; both scale by factor.)
    spatialCv: rawStats.spatialCv ?? null,
  };

  // durationStats: scale the areal maxAccumulated; preserve everything else; keep
  // the raw value alongside as raw_maxAccumulated for reversibility.
  const durationStats = Array.isArray(rawResult.durationStats)
    ? rawResult.durationStats.map((ds) => ({
        ...ds,
        raw_maxAccumulated: ds.maxAccumulated ?? null,
        maxAccumulated: scaleAreal(ds.maxAccumulated ?? null, factor),
        raw_meanMmPerFrame: ds.meanMmPerFrame ?? null,
        meanMmPerFrame: ds.meanMmPerFrame != null ? round3(ds.meanMmPerFrame * factor) : null,
      }))
    : [];

  // Warnings: keep raw warnings, add the synthetic-gauges label (deduped). The
  // synthetic warning makes the calibrated output explicitly illustrative (P-4).
  const warnings = Array.isArray(rawResult.warnings) ? [...rawResult.warnings] : [];
  if (synthetic && !warnings.includes(SYNTHETIC_WARNING)) warnings.push(SYNTHETIC_WARNING);

  const reasons = [];
  if (synthetic) reasons.push('calibrated on SYNTHETIC gauges — illustrative only, not engineering-defensible (P-4)');
  if (typeof nearestGaugeKm === 'number') reasons.push(`nearest gauge ${nearestGaugeKm} km`);
  if (note) reasons.push(note);

  const calibration = {
    applied,
    method: CALIBRATION_METHOD,
    version: CALIBRATION_VERSION,
    rawPreserved: true,
    factor,
    nearestGaugeKm,
    synthetic,
    note: note || CALIBRATION_METHODOLOGY_NOTE,
    reasons,
  };

  const calibrated = {
    // Carry the whole raw result forward, then override the calibrated fields.
    ...rawResult,
    // Preserve raw under raw_* keys — the immutable original, one toggle away.
    raw_catchmentMean: rawResult.catchmentMean ?? null,
    raw_stats: rawResult.stats || null,
    raw_durationStats: Array.isArray(rawResult.durationStats) ? rawResult.durationStats : [],
    // Calibrated (scaled) fields.
    catchmentMean,
    stats,
    durationStats,
    // Gap fields (coverage / frameLog / confidence) pass through UNCHANGED — a
    // multiplicative bias correction does not change which frames are missing.
    calibration,
    warnings,
  };

  // Contract gate: the calibrated copy must still validate (branded areal figures,
  // reconciled gaps). A failure here is a bug in the scaling, surfaced not swallowed.
  validateWindowResult(calibrated);
  return calibrated;
}

/**
 * Cheap feature-detect for whether the calibrated toggle should be offered at all
 * (docs/02 §6: the Raw/Calibrated control). True if gauge observations load; the
 * toggle is still allowed to render disabled when false. Never throws.
 * @returns {Promise<{available:boolean, synthetic:boolean, reason:string|null}>}
 */
export async function isCalibratedAvailable() {
  try {
    const loaded = await loadGaugeObservations();
    if (!loaded || !loaded.ok || !loaded.data) {
      return { available: false, synthetic: false, reason: (loaded && loaded.error) || 'gauge observations unavailable' };
    }
    return {
      available: true,
      synthetic: Boolean(loaded.data.is_synthetic),
      reason: loaded.data.is_synthetic ? 'gauges are synthetic — calibrated output is illustrative only (P-4)' : null,
    };
  } catch (err) {
    return { available: false, synthetic: false, reason: (err && err.message) || String(err) };
  }
}

// Re-export for display/serialisation symmetry with the salvaged module.
export { mmOf };
