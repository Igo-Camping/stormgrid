// sourceAdapter.js — the data-source seam (docs/03 §8, docs/04).
//
// One boundary between "where rainfall comes from" and everything that uses it.
// LizardArchiveAdapter satisfies it today; a future RadarAdapter (BoM primary +
// RainViewer fallback) satisfies the identical contract with no downstream change.
//
// This module defines: the SourceDescriptor + result helpers, the gap-honest
// value constructors (coverage / frameLog / confidence), the registry, and
// validateWindowResult — run on every adapter return before it enters the store.
//
// It deliberately knows nothing about Leaflet, the DOM, or any specific source.

import { isAreal } from './rainfallTypes.js';

/** @typedef {import('./rainfallTypes.js').ArealRainfall} ArealRainfall */

export const SOURCE_KINDS = Object.freeze(['precomputed', 'live']);
export const CONFIDENCE_TIERS = Object.freeze(['high', 'moderate', 'low']);
export const FRAME_STATUSES = Object.freeze(['valid', 'partial', 'missing']);
export const DURATION_KEYS = Object.freeze(['3h', '6h', '12h', '24h', '48h', '72h']);

/**
 * @typedef {Object} SourceDescriptor
 * @property {string} id
 * @property {string} label
 * @property {'precomputed'|'live'} kind
 * @property {string|null} buildVersion
 * @property {string|null} lastBuilt        ISO8601
 * @property {string} unit                  declared frame unit, e.g. 'mm_per_3h' (P-2)
 * @property {boolean} [isPlaceholder]      true if a methodology input is placeholder-grade (P-1)
 */

/**
 * @param {SourceDescriptor} d
 * @returns {SourceDescriptor}
 */
export function sourceDescriptor(d) {
  if (!d || typeof d.id !== 'string' || !d.id) throw new TypeError('source.id required');
  if (!SOURCE_KINDS.includes(d.kind)) throw new TypeError(`source.kind must be one of ${SOURCE_KINDS}`);
  if (typeof d.unit !== 'string' || !d.unit) throw new TypeError('source.unit required (P-2)');
  return Object.freeze({
    id: d.id,
    label: d.label || d.id,
    kind: d.kind,
    buildVersion: d.buildVersion ?? null,
    lastBuilt: d.lastBuilt ?? null,
    unit: d.unit,
    isPlaceholder: Boolean(d.isPlaceholder),
  });
}

/**
 * Coverage accounting. framesMissing is explicit and reconciled against frameLog
 * by the validator — a gap is counted, never dropped.
 * @param {{pct:number, framesUsed:number, framesExpected:number, framesMissing:number}} c
 */
export function coverage(c) {
  for (const k of ['pct', 'framesUsed', 'framesExpected', 'framesMissing']) {
    if (typeof c?.[k] !== 'number' || !Number.isFinite(c[k])) {
      throw new TypeError(`coverage.${k} must be a finite number`);
    }
  }
  return Object.freeze({ ...c });
}

/**
 * @param {{iso:string, status:'valid'|'partial'|'missing', meanMm:number|null}} e
 */
export function frameLogEntry(e) {
  if (!FRAME_STATUSES.includes(e?.status)) throw new TypeError(`frame status must be one of ${FRAME_STATUSES}`);
  if (e.status === 'missing' && e.meanMm != null) {
    // A missing frame must report null, never a fabricated/zero value (gap-honesty red line).
    throw new TypeError('a missing frame must have meanMm === null, not a substituted value');
  }
  return Object.freeze({ iso: e.iso, status: e.status, meanMm: e.meanMm ?? null });
}

/**
 * @param {'high'|'moderate'|'low'} tier
 * @param {string[]} reasons
 */
export function confidence(tier, reasons = []) {
  if (!CONFIDENCE_TIERS.includes(tier)) throw new TypeError(`confidence tier must be one of ${CONFIDENCE_TIERS}`);
  return Object.freeze({ tier, reasons: Object.freeze([...reasons]) });
}

// ── Adapter registry ────────────────────────────────────────────────────────
// Adapters register by id; the app selects the active one. Selecting an adapter
// is a deliberate, logged action — never an implicit fallback.

const _registry = new Map();

/** @param {string} id @param {() => SourceAdapter} factory */
export function registerSourceAdapter(id, factory) {
  if (_registry.has(id)) throw new Error(`source adapter '${id}' already registered`);
  _registry.set(id, factory);
}

/** @param {string} id @returns {SourceAdapter} */
export function createSourceAdapter(id) {
  const factory = _registry.get(id);
  if (!factory) throw new Error(`no source adapter registered for '${id}' (have: ${[..._registry.keys()]})`);
  return factory();
}

/** @returns {string[]} */
export function registeredSourceAdapters() {
  return [..._registry.keys()];
}

/**
 * The SourceAdapter shape (documented; duck-typed at runtime). Implementations
 * provide: describe(), getWindow(request), listEventCandidates(request).
 * @typedef {Object} SourceAdapter
 * @property {() => SourceDescriptor} describe
 * @property {(request:Object) => Promise<Object>} getWindow
 * @property {(request:Object) => AsyncIterable<Object>} listEventCandidates
 */

/**
 * Validate a RainfallWindowResult before it enters the store (docs/04 §5).
 * Throws a descriptive error on any violation; callers surface that as a
 * data-quality ERROR state (docs/02 §3), never silently coerce.
 *
 * Enforces: source present + known kind; coverage/frameLog/confidence present;
 * framesUsed+framesMissing reconciles with frameLog; every rainfall figure is a
 * branded ArealRainfall or explicit null (never a bare number, never a point
 * value where areal is required); AEP suppressed when source.isPlaceholder.
 *
 * @param {Object} result
 * @returns {Object} the same result (frozen-checked), for chaining
 */
export function validateWindowResult(result) {
  const err = (m) => { throw new Error(`invalid RainfallWindowResult: ${m}`); };
  if (!result || typeof result !== 'object') err('not an object');

  // source
  if (!result.source || !SOURCE_KINDS.includes(result.source.kind)) err('missing/invalid source descriptor');

  // gap fields are required and non-empty
  if (!result.coverage) err('coverage is required');
  coverage(result.coverage); // re-validate shape
  if (!Array.isArray(result.frameLog) || result.frameLog.length === 0) err('frameLog required and non-empty');
  if (!result.confidence || !CONFIDENCE_TIERS.includes(result.confidence.tier)) err('confidence required');

  // coverage reconciles with frameLog
  const counted = result.frameLog.reduce(
    (acc, f) => {
      if (f.status === 'missing') acc.missing += 1;
      else acc.used += 1;
      if (f.status === 'missing' && f.meanMm != null) err('missing frame carries a non-null value (silent fill)');
      return acc;
    },
    { used: 0, missing: 0 }
  );
  if (counted.missing !== result.coverage.framesMissing) {
    err(`framesMissing (${result.coverage.framesMissing}) != missing frames in log (${counted.missing})`);
  }

  // the observed catchment value must be areal (or an explicit null gap) — never a bare number / point
  if (result.catchmentMean !== null && !isAreal(result.catchmentMean)) {
    err('catchmentMean must be an ArealRainfall or null (areal-vs-point red line)');
  }
  for (const k of ['maxCell', 'minCell', 'meanCell']) {
    const v = result.stats?.[k];
    if (v !== undefined && v !== null && !isAreal(v)) err(`stats.${k} must be ArealRainfall or null`);
  }

  return result;
}

/**
 * AEP engineering gate (P-1). When the active source / ARF coefficients are
 * placeholder-grade, no AEP/engineering-grade number is emitted. Callers use
 * this before producing any AEP band; the methodology layer surfaces the reason.
 * @param {SourceDescriptor} source
 * @returns {boolean} true if engineering-grade AEP output is permitted
 */
export function engineeringGradeAllowed(source) {
  return Boolean(source) && source.isPlaceholder !== true;
}
