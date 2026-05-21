// footprint.js — the provenance master object (rewrite of buildEventFootprint).
//
// docs/02 §10.6 (export flow leads with the provenance the output carries);
// docs/03 §2 (Export Layer reads everything from the SourceAdapter return contract
// and adds nothing of its own); docs/04 §3.3 + §4 (the RainfallWindowResult and the
// source/coverage/confidence/calibration/warnings that must travel into every export).
//
// This is a REWRITE of the legacy stormgridSnapshot.js buildEventFootprint. The
// legacy version assembled provenance from the OLD closure-state shape
// (rainfallResult.data.catchments, state.selectedDuration, ifd/arf result objects).
// This version assembles it from the NEW shared store (src/core/store.js) and the
// NEW SourceAdapter contract (src/core/rainfallTypes.js branded values), which is
// the single source of truth for the rebuild.
//
// HARD RULES (carried verbatim from the brief and docs/04 §1):
//   - Pure data. No DOM, no fetch, no clock side effects beyond a single
//     generatedAt stamp the caller may override (so exports are reproducible/testable).
//   - Provenance travels UNCHANGED: source, coverage, confidence, calibration,
//     warnings are copied out of the validated RainfallWindowResult as-is.
//   - Gaps are reported, never filled. A missing frame stays { meanMm: null };
//     a missing figure is null, never 0 (gap-honesty red line).
//   - A placeholder / synthetic result MUST be labelled. The footprint exposes
//     `provenance.isPlaceholder`, `aep.engineeringGradeAllowed`, and an explicit
//     `warnings` array so no consumer can mistake illustrative output for a
//     defensible deliverable.
//
// Every other exporter in this layer (csv/json/geojson/png/htmlReport/pdfReport)
// reads from the object this module produces and adds no provenance of its own.

import { mmOf, isAreal } from '../core/rainfallTypes.js';
import { engineeringGradeAllowed } from '../core/sourceAdapter.js';

export const FOOTPRINT_SCHEMA = 'stormgrid.event_footprint.v2';

/** Canonical, well-known warning → human label map (mirrors methodologyPanel.js). */
export const WARNING_LABELS = Object.freeze({
  'placeholder-arf': 'ARF coefficients: placeholder — not engineering-defensible',
  'synthetic-gauges': 'Calibration uses synthetic gauge data — illustrative only',
  'synthetic-preview-overlay': 'Map raster is a synthetic preview overlay — not measured grid data',
  'sanity-envelope-violation': 'Frame values failed the unit sanity envelope — possible unit error',
});

/**
 * Build the canonical, self-describing event footprint.
 *
 * Reads ONLY from the store-selected slices the brief names
 * (select.{windowResult,location,timeframe,duration,calibration}) plus the
 * already-resolved colourMode/layers context. It does not reach into any
 * legacy compute module; the new RainfallWindowResult already carries every
 * stat and gap field (docs/04 §3.3).
 *
 * @param {Object} args
 * @param {Object|null} args.windowResult  a validated RainfallWindowResult (or null)
 * @param {Object|null} args.location      LocationRef: {catchmentId}|{lat,lon}|{areaRef}
 * @param {Object|null} args.timeframe     Timeframe: {kind:'window',windowKey,endIso}|{kind:'event',eventId}
 * @param {string|null} args.duration      DurationKey, e.g. '24h'
 * @param {string|null} args.calibration   'raw' | 'calibrated' (the display mode)
 * @param {string|null} [args.colourMode]  map colour mode (illustrative context only)
 * @param {Object|null} [args.layers]      layer toggles (illustrative context only)
 * @param {string|null} [args.phase]       workflow phase, for the footprint's settled flag
 * @param {Object|null} [args.locationMeta] optional resolved provenance for the location
 *        (e.g. the catchment feature's properties — is_authoritative, area, centroid).
 *        Read for labelling only; never used to fabricate a rainfall value.
 * @param {string} [args.generatedAt]      ISO8601 override (default: now). Supplied so
 *        tests and reproducible exports can pin the timestamp.
 * @returns {Object} the footprint (a plain, JSON-serialisable object)
 */
export function buildEventFootprint(args = {}) {
  const {
    windowResult = null,
    location = null,
    timeframe = null,
    duration = null,
    calibration = 'raw',
    colourMode = null,
    layers = null,
    phase = null,
    locationMeta = null,
    generatedAt,
  } = args;

  const hasResult = !!(windowResult && windowResult.source);
  const source = hasResult ? windowResult.source : null;

  // Provenance block — copied straight off the SourceDescriptor (docs/04 §3.1).
  // isPlaceholder / kind drive the "real vs greenfield" honesty everywhere downstream.
  const provenance = source
    ? {
        sourceId: source.id,
        sourceLabel: source.label || source.id,
        kind: source.kind, // 'precomputed' | 'live'
        buildVersion: source.buildVersion ?? null,
        lastBuilt: source.lastBuilt ?? null,
        unit: source.unit,
        isPlaceholder: source.isPlaceholder === true,
      }
    : null;

  // Coverage — verbatim (gap accounting, docs/04 §3.3). Never recomputed here.
  const coverage = hasResult && windowResult.coverage
    ? {
        pct: numOrNull(windowResult.coverage.pct),
        framesUsed: numOrNull(windowResult.coverage.framesUsed),
        framesExpected: numOrNull(windowResult.coverage.framesExpected),
        framesMissing: numOrNull(windowResult.coverage.framesMissing),
      }
    : null;

  // Frame log — verbatim, including the missing entries. A missing frame's meanMm
  // is null by contract and is preserved as null here (gap honesty).
  const frameLog = hasResult && Array.isArray(windowResult.frameLog)
    ? windowResult.frameLog.map((f) => ({
        iso: f.iso,
        status: f.status,
        meanMm: f.status === 'missing' ? null : numOrNull(f.meanMm),
      }))
    : [];

  const missingFrames = frameLog.filter((f) => f.status === 'missing').map((f) => f.iso);

  // Confidence — verbatim tier + reasons (docs/04 §3.3).
  const confidence = hasResult && windowResult.confidence
    ? {
        tier: windowResult.confidence.tier,
        reasons: Array.isArray(windowResult.confidence.reasons)
          ? windowResult.confidence.reasons.slice()
          : [],
      }
    : null;

  // Stats — read the branded areal values out to plain mm via mmOf (a gap stays
  // null). mmOf THROWS on a non-areal branded value, which would flag a red-line bug.
  const stats = hasResult ? readStats(windowResult) : null;

  // Per-duration rolling stats, areal depths read out honestly.
  const durationStats = hasResult && Array.isArray(windowResult.durationStats)
    ? windowResult.durationStats.map((ds) => ({
        durationKey: ds.durationKey || null,
        maxAccumulatedMm: mmOf(arealOrNull(ds.maxAccumulated)),
        windowStart: ds.windowStart ?? null,
        windowEnd: ds.windowEnd ?? null,
      }))
    : [];

  // Calibration — verbatim. The display mode (raw|calibrated) is recorded alongside
  // the contract's CalibrationMeta so a consumer knows both what was applied and
  // which view this export was taken from. rawPreserved makes the op reversible.
  const cal = hasResult ? windowResult.calibration : null;
  const calibrationBlock = {
    displayMode: calibration || 'raw',
    applied: cal ? cal.applied === true : false,
    method: cal ? (cal.method ?? null) : null,
    version: cal ? (cal.version ?? null) : null,
    rawPreserved: cal ? cal.rawPreserved !== false : true,
    note: 'Calibration is a transparent, reversible bias correction. Raw values are '
      + 'preserved. Calibration is NOT an AEP classification, NOT a return-period '
      + 'assignment, and NOT a formal exceedance assertion.',
  };

  // Warnings — verbatim list, plus human labels. This is the master honesty signal.
  const warnings = hasResult && Array.isArray(windowResult.warnings)
    ? windowResult.warnings.slice()
    : [];
  const warningDetail = warnings.map((w) => ({
    key: w,
    label: WARNING_LABELS[w] || w,
  }));

  // AEP basis / engineering gate (P-1). The footprint does NOT compute an AEP band
  // (that is the Analysis layer's job and requires IFD/ARF inputs not in the store
  // slices the brief names). It records WHETHER an engineering-grade AEP is even
  // permitted, and the explicit placeholder flag, so a report can show the
  // "placeholder — not defensible" note when the gate is closed.
  const aep = {
    engineeringGradeAllowed: source ? engineeringGradeAllowed(source) : false,
    gated: source ? !engineeringGradeAllowed(source) : true,
    gateReason: source && !engineeringGradeAllowed(source)
      ? 'ARF coefficients: placeholder — AEP output suppressed (P-1, not engineering-defensible).'
      : (source ? null : 'No window result — no AEP basis.'),
    arfPlaceholder: source ? source.isPlaceholder === true : true,
    note: 'Stormgrid never classifies an event AEP, never assigns a return period, '
      + 'and never asserts formal exceedance. Any AEP figure shown elsewhere is an '
      + 'indicative comparison band only and is suppressed entirely while ARF '
      + 'coefficients are placeholder-grade.',
  };

  // A synthetic / placeholder / preview result is flagged at the top level so a
  // single boolean answers "is this a defensible deliverable?".
  const isSynthetic = (provenance ? provenance.isPlaceholder : true)
    || warnings.includes('synthetic-preview-overlay')
    || warnings.includes('synthetic-gauges')
    || warnings.includes('placeholder-arf');

  return {
    schemaVersion: FOOTPRINT_SCHEMA,
    generatedAt: generatedAt || new Date().toISOString(),

    // ── Honesty header — the one place that answers "is this real?" ──
    defensible: hasResult && !isSynthetic && aep.engineeringGradeAllowed,
    isSynthetic,
    hasResult,
    phase: phase || null,

    // ── Context (what view this export was taken from) ──
    context: {
      location: normaliseLocation(location, locationMeta),
      timeframe: normaliseTimeframe(timeframe),
      duration: duration || null,
      colourMode: colourMode || null,
      layers: layers ? { ...layers } : null,
    },

    // ── Provenance (travels unchanged into every export) ──
    provenance,
    coverage,
    confidence,
    calibration: calibrationBlock,
    warnings,
    warningDetail,
    missingFrames,
    aep,

    // ── The analytical payload (already-areal values, gaps as null) ──
    stats,
    durationStats,
    frameLog,
  };
}

// ── Location / timeframe normalisers (label-only; never fabricate science) ─────

function normaliseLocation(location, meta) {
  if (!location) return null;
  const out = { kind: null };
  if (location.catchmentId) {
    out.kind = 'catchment';
    out.catchmentId = location.catchmentId;
  } else if (location.lat != null && location.lon != null) {
    out.kind = 'point';
    out.lat = location.lat;
    out.lon = location.lon;
  } else if (location.areaRef) {
    out.kind = 'area';
    out.areaRef = location.areaRef;
  }
  // Resolved provenance for the location (label only). The raster-derived catchment
  // set is non-authoritative (P-3) — surface that flag so every export states it.
  if (meta) {
    out.label = meta.label ?? meta.name ?? null;
    out.isAuthoritative = meta.is_authoritative === true;
    if (typeof meta.area_m2 === 'number') out.areaM2 = meta.area_m2;
    if (typeof meta.area_ha === 'number') out.areaHa = meta.area_ha;
    if (typeof meta.centroid_lon === 'number' && typeof meta.centroid_lat === 'number') {
      out.centroid = { lon: meta.centroid_lon, lat: meta.centroid_lat };
    }
    if (meta.source) out.geometrySource = meta.source;
  } else if (out.kind === 'catchment') {
    // No meta supplied: be explicit that authoritativeness is unknown here, not true.
    out.isAuthoritative = false;
  }
  return out;
}

function normaliseTimeframe(timeframe) {
  if (!timeframe) return null;
  if (timeframe.kind === 'window') {
    return { kind: 'window', windowKey: timeframe.windowKey ?? null, endIso: timeframe.endIso ?? null };
  }
  if (timeframe.kind === 'event') {
    return { kind: 'event', eventId: timeframe.eventId ?? null };
  }
  return { kind: timeframe.kind ?? null };
}

// ── Stat reader: branded areal → plain mm (or null gap) ────────────────────────

function readStats(windowResult) {
  const stats = windowResult.stats || {};
  return {
    catchmentMeanMm: mmOf(arealOrNull(windowResult.catchmentMean)),
    maxCellMm: mmOf(arealOrNull(stats.maxCell)),
    minCellMm: mmOf(arealOrNull(stats.minCell)),
    meanCellMm: mmOf(arealOrNull(stats.meanCell)),
    spatialCv: numOrNull(stats.spatialCv),
    areaAbove: Array.isArray(stats.areaAbove)
      ? stats.areaAbove.map((a) => ({
          thresholdMm: numOrNull(a.thresholdMm),
          fraction: numOrNull(a.fraction),
        }))
      : [],
  };
}

// ── small guards ───────────────────────────────────────────────────────────────

function numOrNull(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

/** Pass through an ArealRainfall or null; anything else is a red-line bug. */
function arealOrNull(v) {
  if (v == null) return null;
  if (isAreal(v)) return v;
  throw new TypeError('footprint: expected an ArealRainfall (already-areal) value or null.');
}

/**
 * A compact, display-ready digest of a footprint for headers/summaries.
 * Pure; reads only the footprint. Used by csv/htmlReport and the panel.
 * @param {Object} fp a footprint from buildEventFootprint
 */
export function summariseFootprint(fp) {
  if (!fp || !fp.hasResult) {
    return {
      available: false,
      catchmentMeanMm: null,
      maxCellMm: null,
      coveragePct: null,
      framesMissing: null,
      confidenceTier: null,
      defensible: false,
    };
  }
  return {
    available: true,
    catchmentMeanMm: fp.stats ? fp.stats.catchmentMeanMm : null,
    maxCellMm: fp.stats ? fp.stats.maxCellMm : null,
    minCellMm: fp.stats ? fp.stats.minCellMm : null,
    spatialCv: fp.stats ? fp.stats.spatialCv : null,
    coveragePct: fp.coverage ? fp.coverage.pct : null,
    framesUsed: fp.coverage ? fp.coverage.framesUsed : null,
    framesExpected: fp.coverage ? fp.coverage.framesExpected : null,
    framesMissing: fp.coverage ? fp.coverage.framesMissing : null,
    confidenceTier: fp.confidence ? fp.confidence.tier : null,
    confidenceReasons: fp.confidence ? fp.confidence.reasons : [],
    duration: fp.context ? fp.context.duration : null,
    defensible: fp.defensible === true,
  };
}

/**
 * Deterministic export filename for a footprint + extension.
 * @param {Object} fp @param {string} ext (no dot)
 */
export function suggestExportFilename(fp, ext) {
  const loc = fp && fp.context && fp.context.location;
  const locTag = loc
    ? (loc.catchmentId || (loc.lat != null ? `${loc.lat.toFixed(3)}_${loc.lon.toFixed(3)}` : (loc.areaRef || 'loc')))
    : 'loc';
  const dur = (fp && fp.context && fp.context.duration) || 'dur';
  const ts = String((fp && fp.generatedAt) || new Date().toISOString())
    .replace(/[-:]/g, '')
    .replace(/\.\d+/, '')
    .replace(/Z$/, 'Z');
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_.-]/g, '');
  return `stormgrid_${safe(locTag)}_${safe(dur)}_${safe(ts)}.${ext}`;
}
