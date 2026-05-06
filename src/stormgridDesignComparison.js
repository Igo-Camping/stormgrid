/* Stormgrid — ARF-adjusted comparison interpretation.

   Pure data: no DOM, no fetches. Given observed catchment-mean rainfall
   and ARF-adjusted areal design depths at one or more AEPs, this
   module produces methodology-safe comparison ratios + descriptive
   bands. It NEVER classifies an event AEP, NEVER calculates a return
   period, NEVER says "1 in X", NEVER asserts "exceeded".

   Bands answer the question:
     "How close was the observed catchment-mean to the ARF-adjusted
      design reference depth?"

   They do NOT answer:
     "What's the AEP of this event?"  (out of Stormgrid's scope) */

export const COMPARISON_BANDS = Object.freeze([
  { key: 'well_below',   label: 'Well below reference depth',   max:  0.50 },
  { key: 'below',        label: 'Below reference depth',         max:  0.85 },
  { key: 'approaching',  label: 'Approaching reference depth',   max:  1.00 },
  { key: 'at_or_above',  label: 'At or above reference depth',   max:  1.20 },
  { key: 'above',        label: 'Above reference depth',         max:  Infinity },
]);

const BAND_RANK = COMPARISON_BANDS.reduce((acc, b, i) => { acc[b.key] = i; return acc; }, {});

/* AEP keys are sorted from frequent (largest %) to rare (smallest %)
   so callers can iterate from most-likely to least-likely design event. */
const AEP_ORDER = ['20%', '5%', '2%', '1%'];

export function bandForRatio(r) {
  if (r == null || !Number.isFinite(r) || r < 0) {
    return { key: 'unknown', label: 'Unknown', ratio: null };
  }
  for (const b of COMPARISON_BANDS) {
    if (r < b.max) {
      return { key: b.key, label: b.label, ratio: Number(r.toFixed(4)) };
    }
  }
  // Should not reach here — final band has Infinity max — but be safe.
  return { key: 'above', label: 'Above reference depth', ratio: Number(r.toFixed(4)) };
}

/* For one duration: given observedMm and a map of {aep -> arfAdjustedDepthMm},
   return per-AEP ratios + bands and a row-level headline (the smallest /
   rarest AEP whose design depth was reached or exceeded by the observed). */
export function computeDurationComparison({ observedMm, arfDepthsByAep }) {
  const out = {
    observed_mm: typeof observedMm === 'number' ? Number(observedMm.toFixed(4)) : null,
    per_aep: {},
    headline: null,    // the rarest AEP whose ratio reached "at_or_above" or "above"
    strongest_band: null,
  };
  if (!arfDepthsByAep || typeof arfDepthsByAep !== 'object') return out;

  let strongestRank = -1;
  let strongestKey  = null;
  let rarestReached = null;     // rarest AEP whose ratio >= 1.0

  for (const aep of AEP_ORDER) {
    const ref = arfDepthsByAep[aep];
    if (typeof observedMm !== 'number' || !Number.isFinite(observedMm) ||
        typeof ref !== 'number' || !Number.isFinite(ref) || ref <= 0) {
      out.per_aep[aep] = { ratio: null, band: 'unknown', label: 'Unknown' };
      continue;
    }
    const r = observedMm / ref;
    const b = bandForRatio(r);
    out.per_aep[aep] = { ratio: b.ratio, band: b.key, label: b.label };
    const rank = BAND_RANK[b.key];
    if (rank != null && rank > strongestRank) {
      strongestRank = rank;
      strongestKey  = b.key;
    }
    if (r >= 1.0) rarestReached = aep;   // since AEP_ORDER is frequent → rare, last reached is rarest
  }

  if (strongestKey) {
    out.strongest_band = strongestKey;
  }
  if (rarestReached) {
    out.headline = {
      message: 'reference_depth_reached',
      reference_aep: rarestReached,
      reached_or_above: true,
    };
  } else {
    // Find the rarest AEP whose ratio is finite — for "X is the closest reference depth approached"
    let closestAep = null;
    let closestRatio = -Infinity;
    for (const aep of AEP_ORDER) {
      const r = out.per_aep[aep] && out.per_aep[aep].ratio;
      if (typeof r === 'number' && r > closestRatio) {
        closestRatio = r;
        closestAep = aep;
      }
    }
    if (closestAep) {
      out.headline = {
        message: 'closest_reference_depth_below',
        reference_aep: closestAep,
        reached_or_above: false,
        ratio: Number(closestRatio.toFixed(4)),
      };
    }
  }
  return out;
}

/* Roll up an array of per-duration comparisons into a single payload-
   ready summary. Used by exports + the comparison summary panel. */
export function summariseComparisons(byDuration) {
  const summary = {
    comparison_only: true,
    event_aep_classification: false,
    return_period_calculated: false,
    exceedance_assertion: false,
    note: 'Comparison ratios + bands only. Stormgrid does not classify event AEP, does not compute return periods, and does not assert exceedance.',
    per_duration: byDuration || {},
    rarest_reference_reached: null,
    strongest_band_overall: null,
  };
  let strongestRank = -1;
  let rarestReached = null;
  for (const [dur, comp] of Object.entries(byDuration || {})) {
    if (!comp) continue;
    if (comp.strongest_band) {
      const rank = BAND_RANK[comp.strongest_band];
      if (rank != null && rank > strongestRank) {
        strongestRank = rank;
        summary.strongest_band_overall = comp.strongest_band;
      }
    }
    if (comp.headline && comp.headline.reached_or_above && comp.headline.reference_aep) {
      // Track the rarest (smallest %) AEP reached across all durations.
      const aepNum = (s) => Number(String(s).replace('%', ''));
      if (rarestReached == null || aepNum(comp.headline.reference_aep) < aepNum(rarestReached)) {
        rarestReached = comp.headline.reference_aep;
      }
    }
  }
  summary.rarest_reference_reached = rarestReached;
  return summary;
}
