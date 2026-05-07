/* Stormgrid — automatic event-window detection (Phase 12).

   Goal: surface a plausible *operational* event window without making any
   AEP / return-period / "1 in X" / formal exceedance claim. Works off the
   precomputed catchment rainfall JSON only — no new rainfall science.

   Strategy:
   ---------
   For the chosen catchment, scan its `duration_stats` map and select the
   duration whose maximal rolling-window total is highest. That window's
   `window_start` / `window_end` are the detected event window; the
   selected duration becomes the recommended critical duration; confidence
   propagates from the duration_stats `confidence` field.

   When `preferredDurationKey` is supplied AND it has stats, that duration
   is used directly (the operator has already chosen). Otherwise we pick
   automatically and record the decision in `reason`.

   No DOM, no fetches.
*/

const DEFAULT_DURATION_PRIORITY = ['72h', '48h', '24h', '12h', '6h', '3h'];

/**
 * @param {object} args
 * @param {string} args.catchmentId
 * @param {object} args.rainfallData     full catchment rainfall JSON
 * @param {string|null} [args.preferredDurationKey]
 * @returns {object|null} window descriptor, or null when nothing usable.
 */
export function detectEventWindow({ catchmentId, rainfallData, preferredDurationKey } = {}) {
  if (!catchmentId || !rainfallData || !rainfallData.catchments) return null;
  const cRow = rainfallData.catchments[catchmentId];
  if (!cRow || !cRow.duration_stats) return null;

  // 1) Honour preferred duration if it has stats.
  if (preferredDurationKey && cRow.duration_stats[preferredDurationKey]) {
    return describeFromStats(
      cRow.duration_stats[preferredDurationKey],
      preferredDurationKey,
      'operator-selected duration',
    );
  }

  // 2) Auto-pick: duration with the highest max_total_mm.
  const candidates = Object.entries(cRow.duration_stats)
    .filter(([, ds]) => ds && typeof ds.max_total_mm === 'number')
    .sort((a, b) => {
      // Primary: higher rainfall first.
      const dr = b[1].max_total_mm - a[1].max_total_mm;
      if (dr !== 0) return dr;
      // Tiebreaker: longer-duration first (per default priority).
      return DEFAULT_DURATION_PRIORITY.indexOf(a[0]) - DEFAULT_DURATION_PRIORITY.indexOf(b[0]);
    });
  if (candidates.length === 0) return null;
  const [bestKey, bestStats] = candidates[0];

  return describeFromStats(
    bestStats,
    bestKey,
    `auto-detected: highest rolling ${bestKey} total of ${bestStats.max_total_mm.toFixed(2)} mm in this accumulation window`,
  );
}

function describeFromStats(ds, durationKey, reason) {
  if (!ds || !ds.window_start || !ds.window_end) return null;
  return {
    start:        ds.window_start,
    end:          ds.window_end,
    duration_key: durationKey,
    total_mm:     typeof ds.max_total_mm === 'number' ? ds.max_total_mm : null,
    coverage_pct: typeof ds.coverage_pct === 'number' ? ds.coverage_pct : null,
    frames_used:  typeof ds.frames_used  === 'number' ? ds.frames_used  : null,
    confidence:   normaliseConfidence(ds.confidence),
    source:       'rolling_max_in_accumulation_window',
    reason,
    methodology_note: 'Detected window is the maximal rolling-rainfall slice of the chosen accumulation window. It is a hydrological-context cue, NOT an AEP classification, return period, or formal exceedance assertion.',
  };
}

function normaliseConfidence(c) {
  const v = String(c == null ? '' : c).toLowerCase();
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return 'unknown';
}

/**
 * Format a window descriptor for one-line UI display:
 *   "2026-05-10 03:00 → 06:00 UTC · 24h critical window · 12.4 mm"
 */
export function formatEventWindow(win) {
  if (!win) return '—';
  const t = (s) => String(s || '').replace('T', ' ').replace(/:00Z$/, '').replace('Z', ' UTC');
  const mm = (typeof win.total_mm === 'number') ? `${win.total_mm.toFixed(1)} mm` : '—';
  return `${t(win.start)} → ${t(win.end)} · ${win.duration_key} window · ${mm}`;
}
