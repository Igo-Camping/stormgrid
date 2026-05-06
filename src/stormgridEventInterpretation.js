/* Stormgrid — event interpretation framework.

   Pure data: no DOM, no fetches. Builds on Phase 8's per-duration
   comparison output and produces:
     - per-duration "nearest design envelope" (the AEP whose
       ARF-adjusted areal design depth the observed catchment-mean
       most resembles, by symmetric log-distance)
     - multi-duration consistency analysis (dominant AEP across
       durations + a consistency score)
     - interpretation confidence (low / moderate / high) derived from
       coefficient verification, coverage, available durations,
       consistency and IFD-row suspicion.

   This module is INTERPRETATION ONLY. It NEVER:
     - classifies an event AEP
     - calculates a return period
     - says "1 in X"
     - asserts formal exceedance

   Wording uses "most closely resembles" / "best matches" /
   "interpretation" — and every output object carries methodology
   flags so consumers can assert the same. */

const AEP_ORDER = ['20%', '5%', '2%', '1%'];   // frequent → rare

/* For a single duration's per-AEP map, return the AEP whose design
   depth the observed value most resembles, measured by symmetric
   log-distance |log10(ratio)|. Returns null if no per-AEP data. */
export function computeNearestEnvelope(perAep) {
  if (!perAep) return null;
  let best = null;
  for (const aep of AEP_ORDER) {
    const info = perAep[aep];
    if (!info || typeof info.ratio !== 'number' || info.ratio <= 0) continue;
    const logDist = Math.abs(Math.log10(info.ratio));
    if (!best || logDist < best.log_distance) {
      best = {
        aep,
        ratio: Number(info.ratio.toFixed(4)),
        log_distance: Number(logDist.toFixed(4)),
        band: info.band,
      };
    }
  }
  return best;
}

/* Across multiple durations, find the most-common nearest AEP and a
   consistency score (agreement_count / total_durations_with_data).
   Returns {per_duration_nearest, dominant_aep, agreement_count,
   total_durations, consistency_score}. */
export function analyseMultiDurationConsistency(comparisonByDuration) {
  const nearest = {};
  for (const [dk, comp] of Object.entries(comparisonByDuration || {})) {
    if (!comp || !comp.per_aep) continue;
    const ne = computeNearestEnvelope(comp.per_aep);
    if (ne) nearest[dk] = ne;
  }
  const counts = {};
  for (const ne of Object.values(nearest)) {
    counts[ne.aep] = (counts[ne.aep] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const dominant = sorted[0] ? sorted[0][0] : null;
  const agreement = sorted[0] ? sorted[0][1] : 0;
  const total = Object.keys(nearest).length;
  return {
    per_duration_nearest: nearest,
    dominant_aep: dominant,
    agreement_count: agreement,
    total_durations: total,
    consistency_score: total > 0 ? Number((agreement / total).toFixed(3)) : 0,
  };
}

/* Score five contributing factors, return overall confidence level
   {low | moderate | high} + the per-factor breakdown for transparency. */
export function computeInterpretationConfidence({
  coefficientsVerified,
  coverageMin,           // 0..1 (lowest pixel-coverage among included durations)
  durationsWithData,     // integer count
  consistencyScore,      // 0..1
  suspectIfdCount,       // integer (rows flagged suspect within the active set)
}) {
  const factors = [
    { factor: 'arf_coefficients_verified',
      pass_rule: 'verified === true',
      status: coefficientsVerified === true ? 'pass' : 'fail',
      detail: coefficientsVerified === true
        ? 'Coefficients flagged verified.'
        : 'ARF coefficients UNVERIFIED — replace data/arf_coefficients.json with ARR2019 Book 2 Ch. 4 values.',
    },
    { factor: 'observed_coverage_min',
      pass_rule: 'min coverage >= 0.90 (warn at >= 0.70)',
      status: !Number.isFinite(coverageMin) ? 'unknown'
            : coverageMin >= 0.9 ? 'pass'
            : coverageMin >= 0.7 ? 'warn' : 'fail',
      detail: Number.isFinite(coverageMin)
        ? `Lowest pixel coverage in active set: ${(coverageMin * 100).toFixed(1)}%.`
        : 'Coverage figure not available.',
    },
    { factor: 'durations_with_data',
      pass_rule: '>= 3 durations (warn at >= 2)',
      status: !Number.isFinite(durationsWithData) ? 'unknown'
            : durationsWithData >= 3 ? 'pass'
            : durationsWithData >= 2 ? 'warn' : 'fail',
      detail: `${durationsWithData ?? 0} duration(s) included.`,
    },
    { factor: 'multi_duration_consistency',
      pass_rule: 'consistency_score >= 0.66 (warn at >= 0.33)',
      status: !Number.isFinite(consistencyScore) ? 'unknown'
            : consistencyScore >= 0.66 ? 'pass'
            : consistencyScore >= 0.33 ? 'warn' : 'fail',
      detail: `Consistency score: ${Number(consistencyScore || 0).toFixed(2)}.`,
    },
    { factor: 'suspect_ifd_rows',
      pass_rule: 'no suspect IFD rows in active set',
      status: !Number.isFinite(suspectIfdCount) ? 'unknown'
            : suspectIfdCount === 0 ? 'pass' : 'warn',
      detail: `${suspectIfdCount ?? 0} suspect IFD row(s).`,
    },
  ];

  const failures = factors.filter((f) => f.status === 'fail').length;
  const warns    = factors.filter((f) => f.status === 'warn').length;
  let level;
  if (failures > 0)        level = 'low';
  else if (warns >= 2)     level = 'moderate';
  else if (warns >= 1)     level = 'moderate';
  else                     level = 'high';
  return { level, factors };
}

/* Roll the lot up into a single payload-ready interpretation object.
   Every output carries the methodology flags downstream consumers must
   honour. */
export function buildEventInterpretation({
  catchmentId,
  comparisonByDuration,
  coefficientsVerified,
  observedCoverageMin,
  suspectIfdCount,
}) {
  const consistency = analyseMultiDurationConsistency(comparisonByDuration || {});
  const confidence = computeInterpretationConfidence({
    coefficientsVerified,
    coverageMin: observedCoverageMin,
    durationsWithData: consistency.total_durations,
    consistencyScore:  consistency.consistency_score,
    suspectIfdCount,
  });
  const dominant = consistency.dominant_aep;
  const headline = dominant && consistency.total_durations > 0
    ? `Across ${consistency.agreement_count} of ${consistency.total_durations} duration(s) with data, observed catchment-mean rainfall most closely resembles the ${dominant} ARF-adjusted areal design envelope.`
    : 'Insufficient durations to summarise an interpretation.';
  return {
    schema_version: 'stormgrid.event_interpretation.v1',
    catchment_id: catchmentId || null,
    classification_disclaimer: {
      event_aep_classified:  false,
      return_period_assigned: false,
      formal_exceedance_asserted: false,
      note: 'Interpretation only. Stormgrid never classifies an event AEP, never assigns a return period, and never asserts formal exceedance. Outputs are descriptive ratios + bands relative to ARF-adjusted reference depths.',
    },
    headline,
    consistency,
    confidence,
  };
}
