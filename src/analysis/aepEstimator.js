// aepEstimator.js — Analysis layer: indicative AEP band estimator.
//
// REFACTOR of the comparison logic stranded in stormgridIfdPanel.js (the only ARF
// call site) into a pure, contract-driven estimator. It is the one place where the
// areal observed mean and the point IFD meet — and it encodes both red lines:
//
//   RED LINE 1 (areal vs point, docs/01 §7, docs/04 §3.5):
//     ARF is applied to the POINT side ONLY, via applyArf(pointDesignDepth, arfFactor),
//     which returns an ArealRainfall and throws on anything that is not a
//     PointDesignDepth. The observed catchment mean (windowResult.catchmentMean) is
//     ALREADY an ArealRainfall; it is compared DIRECTLY to the ARF-reduced point
//     depth and is NEVER passed to applyArf. Because applyArf rejects an
//     ArealRainfall, the double-ARF mistake throws rather than silently happening.
//
//   RED LINE 2 (engineering gate, P-1):
//     If !engineeringGradeAllowed(windowResult.source) — i.e. source.isPlaceholder
//     is true because the ARF coefficients are placeholders — NO AEP number is
//     emitted. computeAep returns { aepBand:null, gated:true, reason:... }. We never
//     fabricate an AEP from placeholder coefficients.
//
// And it preserves the non-classification disclaimers: the band is INDICATIVE,
// labelled, and explicitly not an event AEP classification / return period /
// exceedance assertion (mirrors stormgridDesignComparison / EventInterpretation).
//
// Pure data: no DOM, no fetch.

import { applyArf, isAreal, isPoint, isArf, mmOf } from '../core/rainfallTypes.js';
import { engineeringGradeAllowed } from '../core/sourceAdapter.js';

/** The standard placeholder gate reason surfaced to the methodology layer. */
export const GATE_REASON_PLACEHOLDER_ARF = 'ARF coefficients: placeholder — not engineering-defensible';

/**
 * Indicative comparison bands (ratio = observed areal mean / ARF-reduced point
 * design depth). These describe "how close the observed catchment mean was to the
 * ARF-adjusted areal design reference depth" — NOT an event AEP. Mirrors
 * stormgridDesignComparison.COMPARISON_BANDS.
 */
export const COMPARISON_BANDS = Object.freeze([
  { key: 'well_below',  label: 'Well below reference depth',  max: 0.50 },
  { key: 'below',       label: 'Below reference depth',        max: 0.85 },
  { key: 'approaching', label: 'Approaching reference depth',   max: 1.00 },
  { key: 'at_or_above', label: 'At or above reference depth',   max: 1.20 },
  { key: 'above',       label: 'Above reference depth',         max: Infinity },
]);

const BAND_RANK = COMPARISON_BANDS.reduce((acc, b, i) => { acc[b.key] = i; return acc; }, {});

// AEP keys ordered frequent → rare so the "rarest reference reached" is the
// last one whose ratio >= 1.0.
const AEP_ORDER = ['20%', '5%', '2%', '1%'];

/**
 * @typedef {Object} AepBand
 * @property {boolean} indicative           always true — never a formal classification
 * @property {string|null} referenceAep      the rarest AEP whose ARF-reduced design depth
 *                                            the observed mean reached, e.g. '1%', or null
 * @property {string} band                   COMPARISON_BANDS key for the strongest band reached
 * @property {string} label                  human label for that band
 * @property {Object<string,{ratio:number|null, band:string, label:string, arealDesignMm:number|null}>} perAep
 * @property {string} basis                  'point IFD → ARF-reduced areal vs observed areal mean'
 * @property {boolean} anyExtrapolated        true if any ARF factor used was extrapolated
 * @property {Object} disclaimer             non-classification flags
 */

/**
 * @typedef {Object} AepResult
 * @property {AepBand|null} aepBand   null when gated
 * @property {boolean} gated           true when the P-1 engineering gate is closed
 * @property {string} reason           human reason (gate reason when gated; method note otherwise)
 */

const DISCLAIMER = Object.freeze({
  event_aep_classified: false,
  return_period_assigned: false,
  formal_exceedance_asserted: false,
  note: 'Indicative comparison band only. Stormgrid never classifies an event AEP, never assigns a return period, and never asserts formal exceedance. The band describes how close the observed (areal) catchment mean is to the ARF-adjusted areal design reference depth.',
});

/**
 * Estimate an indicative AEP band by comparing the observed areal catchment mean
 * to ARF-reduced point IFD design depths.
 *
 * @param {Object} windowResult                 a validated RainfallWindowResult.
 *        Uses windowResult.catchmentMean (ArealRainfall|null) and windowResult.source.
 * @param {{ pointDepthsByAep: Object<string,import('../core/rainfallTypes.js').PointDesignDepth>,
 *           qualityFlag?: string|null }} ifd     point IFD design depths for the active
 *        (catchment, duration), keyed by AEP key. These are PointDesignDepth values
 *        (from ifdService.pointDepthsForDuration). ARF is applied to THESE only.
 * @param {{ factorsByAep: Object<string,import('../core/rainfallTypes.js').ArfFactor> }} arf
 *        the ArfFactor per AEP key (from arfEngine.arfFactorTable, unwrapped to .factor).
 * @returns {AepResult}
 */
export function computeAep(windowResult, ifd, arf) {
  // ── Gate first (P-1). Never emit an AEP from placeholder coefficients. ──
  const source = windowResult && windowResult.source;
  if (!engineeringGradeAllowed(source)) {
    return { aepBand: null, gated: true, reason: GATE_REASON_PLACEHOLDER_ARF };
  }

  // ── The observed value is areal and must NOT be ARF-reduced. ──
  const observed = windowResult && windowResult.catchmentMean;
  if (observed != null && !isAreal(observed)) {
    // Defensive: the store validator already enforces this, but assert here too —
    // a point value masquerading as the observed mean is exactly the red-line bug.
    throw new TypeError(
      'computeAep: windowResult.catchmentMean must be an ArealRainfall (or null). ' +
      'It is the already-areal observed value and must never be a PointDesignDepth.'
    );
  }
  const observedMm = mmOf(observed); // number | null (a gap stays null, never 0)

  const pointDepths = (ifd && ifd.pointDepthsByAep) || {};
  const factors = (arf && arf.factorsByAep) || {};

  const perAep = {};
  let strongestRank = -1;
  let strongestKey = null;
  let strongestLabel = null;
  let rarestReached = null;
  let anyExtrapolated = false;

  for (const aepKey of AEP_ORDER) {
    const point = pointDepths[aepKey];
    const factor = factors[aepKey];

    // No point depth or no factor → unknown for this AEP (a gap, not a zero).
    if (!isPoint(point) || !isArf(factor)) {
      perAep[aepKey] = { ratio: null, band: 'unknown', label: 'Unknown', arealDesignMm: null };
      continue;
    }
    if (factor.extrapolated) anyExtrapolated = true;

    // ── THE ONLY ARF APPLICATION: point side only. Throws if `point` is not a
    //    PointDesignDepth — so the observed areal mean can never reach here. ──
    const arealDesign = applyArf(point, factor); // ArealRainfall
    const refMm = mmOf(arealDesign);

    if (observedMm == null || refMm == null || refMm <= 0) {
      perAep[aepKey] = { ratio: null, band: 'unknown', label: 'Unknown', arealDesignMm: refMm };
      continue;
    }

    const ratio = observedMm / refMm; // areal observed vs areal (ARF-reduced) design
    const b = bandForRatio(ratio);
    perAep[aepKey] = { ratio: b.ratio, band: b.key, label: b.label, arealDesignMm: Number(refMm.toFixed(4)) };

    const rank = BAND_RANK[b.key];
    if (rank != null && rank > strongestRank) {
      strongestRank = rank; strongestKey = b.key; strongestLabel = b.label;
    }
    if (ratio >= 1.0) rarestReached = aepKey; // frequent → rare order: last one reached is rarest
  }

  if (strongestKey == null) {
    // Nothing comparable (all gaps). Honest: indicative band unavailable, but not gated.
    return {
      aepBand: {
        indicative: true,
        referenceAep: null,
        band: 'unknown',
        label: 'Unknown',
        perAep,
        basis: 'point IFD → ARF-reduced areal vs observed areal mean',
        anyExtrapolated,
        disclaimer: DISCLAIMER,
      },
      gated: false,
      reason: 'Insufficient IFD/ARF/observed data to form an indicative band.',
    };
  }

  return {
    aepBand: {
      indicative: true,
      referenceAep: rarestReached,
      band: strongestKey,
      label: strongestLabel,
      perAep,
      basis: 'point IFD → ARF-reduced areal vs observed areal mean',
      anyExtrapolated,
      disclaimer: DISCLAIMER,
    },
    gated: false,
    reason: anyExtrapolated
      ? 'Indicative band (one or more ARF factors extrapolated outside the coefficients\' validity envelope).'
      : 'Indicative band only — not an event AEP classification.',
  };
}

/**
 * Map a comparison ratio to an indicative band. Mirrors
 * stormgridDesignComparison.bandForRatio.
 * @param {number|null} r
 * @returns {{key:string, label:string, ratio:number|null}}
 */
export function bandForRatio(r) {
  if (r == null || !Number.isFinite(r) || r < 0) {
    return { key: 'unknown', label: 'Unknown', ratio: null };
  }
  for (const b of COMPARISON_BANDS) {
    if (r < b.max) return { key: b.key, label: b.label, ratio: Number(r.toFixed(4)) };
  }
  return { key: 'above', label: 'Above reference depth', ratio: Number(r.toFixed(4)) };
}

/**
 * The display string for the "~AEP (indicative)" summary line. NEVER returns a
 * bare number when gated — returns the gate reason instead. When ungated, returns
 * a labelled, indicative phrasing, never a return period / "1 in X".
 * @param {AepResult} aepResult
 * @returns {string}
 */
export function indicativeAepLabel(aepResult) {
  if (!aepResult || aepResult.gated || !aepResult.aepBand) {
    return (aepResult && aepResult.reason) || GATE_REASON_PLACEHOLDER_ARF;
  }
  const { referenceAep, label } = aepResult.aepBand;
  if (referenceAep) {
    return `~${referenceAep} AEP (indicative · point-IFD, ARF-adjusted · not a classification)`;
  }
  return `${label} (indicative · not a classification)`;
}
