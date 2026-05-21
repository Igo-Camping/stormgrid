// coverageModel.js — thin, shared, gap-honest helpers over the contract's
// coverage / frameLog / confidence (docs/04 §3.3; docs/02 §3, §6, §7).
//
// PURPOSE: the Map layer (single legend / single hover readout) and the Analysis
// layer (SummaryStats, ConfidenceChip) both need the SAME small derivations off a
// RainfallWindowResult — "is this degraded?", "how many frames missing?", "what is
// the one-line coverage label?". Putting them here means those derivations are
// computed once, consistently, instead of each consumer re-deriving (and risking a
// drift in the DEGRADED threshold or a gap being defaulted to 0 in one place).
//
// IT DOES NOT recompute anything the adapter already owns. The adapter's pipeline
// produced coverage %, frame statuses and the confidence tier; these are faithful
// reads + presentation helpers over that, never a re-aggregation. Every helper is
// pure (no DOM, no fetch) and gap-honest: a missing/absent value is reported as
// such, never coerced to 0.

import { mmOf } from '../core/rainfallTypes.js';

// The single DEGRADED threshold, shared with the store (LOW_COVERAGE_PCT) and the
// pipeline (quality.low_coverage_threshold 0.7). Kept here so consumers reference
// one constant instead of hardcoding 70 in several panels.
export const LOW_COVERAGE_PCT = 70;

/**
 * Frame-status tallies straight off the contract frameLog. No recomputation —
 * just a count, so legend/chip/methodology all show the same numbers.
 * @param {Object} result RainfallWindowResult
 * @returns {{ total:number, valid:number, partial:number, missing:number }}
 */
export function frameTally(result) {
  const log = result && Array.isArray(result.frameLog) ? result.frameLog : [];
  const t = { total: log.length, valid: 0, partial: 0, missing: 0 };
  for (const f of log) {
    if (f.status === 'valid') t.valid += 1;
    else if (f.status === 'partial') t.partial += 1;
    else if (f.status === 'missing') t.missing += 1;
  }
  return t;
}

/**
 * Is the result a DEGRADED settle (docs/02 §3)? Mirrors the store's rule exactly:
 * low coverage OR any missing frame. Centralised so the Map and Analysis layers
 * cannot disagree with the store about what "degraded" means.
 * @param {Object} result
 * @returns {boolean}
 */
export function isDegraded(result) {
  if (!result || !result.coverage) return false;
  return result.coverage.pct < LOW_COVERAGE_PCT || result.coverage.framesMissing > 0;
}

/**
 * One-line coverage label for the ConfidenceChip (docs/02 §6: "96% (81/84 frames)").
 * Honest about absence — returns 'unavailable' rather than a fake 0% when the
 * coverage block is missing.
 * @param {Object} result
 * @returns {string}
 */
export function coverageLabel(result) {
  const c = result && result.coverage;
  if (!c) return 'unavailable';
  const pct = typeof c.pct === 'number' ? `${c.pct.toFixed(1)}%` : 'unavailable';
  return `${pct} (${c.framesUsed}/${c.framesUsed + c.framesMissing} frames)`;
}

/**
 * Missing-frame summary for the chip's "Missing frames: 3 of 84" slot.
 * @param {Object} result
 * @returns {{ missing:number, total:number, label:string }}
 */
export function missingFramesSummary(result) {
  const c = result && result.coverage;
  if (!c) return { missing: 0, total: 0, label: 'unavailable' };
  const total = c.framesUsed + c.framesMissing;
  return { missing: c.framesMissing, total, label: `${c.framesMissing} of ${total}` };
}

/**
 * Confidence tier + reasons, read straight off the contract. A faithful pass-through
 * so the methodology layer renders the adapter's reasons verbatim (docs/04 §4:
 * "adds nothing of its own").
 * @param {Object} result
 * @returns {{ tier:string, reasons:string[] }}
 */
export function confidenceView(result) {
  const c = result && result.confidence;
  if (!c) return { tier: 'low', reasons: ['confidence unavailable'] };
  return { tier: c.tier, reasons: Array.isArray(c.reasons) ? [...c.reasons] : [] };
}

/**
 * Resolve the DurationStat for a requested duration key, for the duration
 * re-derive (docs/02 §4 — duration change reads from the loaded window's
 * durationStats, no refetch). Returns null when the duration is not present in the
 * window (honest: the duration selector should disable it, not fabricate it).
 * @param {Object} result
 * @param {string} durationKey
 * @returns {Object|null} the DurationStat, or null
 */
export function durationStatFor(result, durationKey) {
  const list = result && Array.isArray(result.durationStats) ? result.durationStats : [];
  return list.find((d) => d && d.durationKey === durationKey) || null;
}

/**
 * The duration keys actually available in the loaded window — drives the duration
 * selector's enabled/disabled state without guessing.
 * @param {Object} result
 * @returns {string[]}
 */
export function availableDurations(result) {
  const list = result && Array.isArray(result.durationStats) ? result.durationStats : [];
  return list.map((d) => d && d.durationKey).filter(Boolean);
}

/**
 * Plain-number view of the catchment mean for display/serialisation. Returns null
 * for a gap (never 0) — the areal value object stays branded everywhere else.
 * @param {Object} result
 * @returns {number|null}
 */
export function catchmentMeanMm(result) {
  return result ? mmOf(result.catchmentMean ?? null) : null;
}
