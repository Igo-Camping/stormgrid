// lizardSanityEnvelope.js — P-2 runtime sanity guard for Lizard mm/3h frames.
//
// Phase D prerequisite P-2 (docs/05): each Lizard GeoTIFF frame is *assumed* to
// be "mm per 3 h interval". That assumption is UNCONFIRMED from disk. Rather than
// silently trust it, the adapter runs every per-frame catchment-mean depth through
// a plausibility envelope. A value outside the envelope is almost certainly a unit
// or temporal-semantics error (metres mistaken for mm, a cumulative total mistaken
// for a per-interval depth, a negative/garbage value) — exactly the failure mode
// P-2 warns about. On violation we DO NOT silently proceed: the caller surfaces it
// as a data-quality warning carried in the RainfallWindowResult.
//
// ── The envelope (a guard, NOT vendor confirmation) ──────────────────────────
// Lower bound: 0 mm. Rain depth cannot be negative; a negative trips the guard.
// Upper bound: 400 mm per 3 h interval.
//   Rationale: world-record point rainfall intensities sit around ~300-400 mm in
//   3 hours (e.g. the ~401 mm/3h class of tropical extremes). A *catchment-areal
//   mean* over a 3 h interval exceeding this is physically implausible for the
//   Sydney-region catchments this archive covers and far more likely indicates a
//   unit error (e.g. a metres value of 0.4 read as 400, or a 30-day cumulative
//   total landing in a 3 h slot). We pick 400 deliberately on the generous side:
//   the guard exists to catch GROSS errors (orders of magnitude), not to second-
//   guess a genuinely extreme but plausible storm. This bound is a tripwire, not
//   a vendor-confirmed maximum. When the vendor confirms the frame unit (P-2
//   "to clear"), this stays as a regression guard.
//
// The bound is expressed per 3 h interval because the declared source unit is
// 'mm_per_3h' (docs/04 §3.1, SourceDescriptor.unit). If the declared unit ever
// changes, this envelope must be revisited alongside it.

export const LIZARD_3H_ENVELOPE = Object.freeze({
  minMm: 0,
  maxMm: 400,
  unit: 'mm_per_3h',
});

/**
 * Check a single per-frame catchment-mean depth against the 3 h envelope.
 * A null depth (a gap) is NOT a violation — gaps are handled by the frame log,
 * not by this guard.
 *
 * @param {number|null|undefined} meanMm  per-frame catchment-mean depth (mm)
 * @param {{minMm:number,maxMm:number}} [envelope]
 * @returns {{ok:boolean, reason:string|null}}
 */
export function checkFrameDepth(meanMm, envelope = LIZARD_3H_ENVELOPE) {
  if (meanMm == null) return { ok: true, reason: null }; // gap — not this guard's job
  if (typeof meanMm !== 'number' || !Number.isFinite(meanMm)) {
    return { ok: false, reason: `non-finite per-frame depth (${meanMm})` };
  }
  if (meanMm < envelope.minMm) {
    return { ok: false, reason: `negative per-frame depth ${meanMm} mm/3h (envelope min ${envelope.minMm})` };
  }
  if (meanMm > envelope.maxMm) {
    return {
      ok: false,
      reason:
        `per-frame depth ${meanMm} mm/3h exceeds plausibility envelope ` +
        `(${envelope.maxMm} mm/3h) — probable unit/temporal error (P-2)`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Run the envelope over a set of candidate per-3h depths and collect violations.
 * Inputs are the depths the adapter can actually see for a catchment in a window:
 * the window-mean-per-frame and each available duration's mean-per-frame. We do
 * NOT have a true per-frame series per catchment in the precomputed JSON, so the
 * guard runs on the available per-frame mean depths (which are themselves on a
 * per-3h-frame basis) — that is sufficient to catch gross unit errors.
 *
 * @param {Array<{label:string, meanMm:number|null}>} candidates
 * @param {{minMm:number,maxMm:number}} [envelope]
 * @returns {string[]} violation reasons (empty if all plausible)
 */
export function collectEnvelopeViolations(candidates, envelope = LIZARD_3H_ENVELOPE) {
  const out = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const { ok, reason } = checkFrameDepth(c?.meanMm, envelope);
    if (!ok) out.push(`${c?.label ?? 'frame'}: ${reason}`);
  }
  return out;
}
