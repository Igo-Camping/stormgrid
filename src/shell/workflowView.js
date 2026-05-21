// workflowView.js — pure phase → presentation mapping for the navigation shell.
//
// Spec: docs/02 §3 (six workflow states) and docs/02 §8 (progressive disclosure).
// Given the current workflow phase (store.select.phase), the loaded
// windowResult, and any error, this returns a plain description of what the
// workspace should *reflect* for that state: which regions are active, what the
// map stage shows, and the honest loading / degraded / error messaging.
//
// This module is pure and side-effect free. It does NOT touch the DOM, the
// store, Leaflet, or the network. workspace.js subscribes to select.phase and
// feeds the result of describeWorkflow() into its render. Keeping the mapping
// pure means the six-state contract is unit-testable in isolation and the shell
// can never drift into showing a settled-looking map while data is incomplete —
// DEGRADED and ERROR are explicit branches here, never silent fallbacks.

/**
 * The map-stage treatments, one per workflow state (docs/02 §3 diagram).
 * These are *semantic* tokens, not Leaflet calls — the map host (B.3) decides
 * how to honour each. The shell only needs to know which to request.
 */
export const MAP_TREATMENTS = Object.freeze({
  REGIONAL: 'regional',          // EMPTY: AU / region overview, no selection
  FRAMED_BOUNDARY: 'framed',     // LOCATED: catchment framed, boundary drawn, no raster
  STREAMING_RASTER: 'streaming', // AGGREGATING: raster fades in by coverage
  SETTLED_RASTER: 'settled',     // SETTLED: full raster + boundary + legend
  PARTIAL_RASTER: 'partial',     // DEGRADED: render what exists, no-coverage cells transparent
  ERROR: 'error',                // ERROR: no raster; retry affordance
});

/** Known workflow phases, mirrored from store.PHASES (kept local so this module has no store import). */
export const WORKFLOW_PHASES = Object.freeze(['EMPTY', 'LOCATED', 'AGGREGATING', 'SETTLED', 'DEGRADED', 'ERROR']);

/**
 * @typedef {Object} WorkflowView
 * @property {string}  phase            the input phase (echoed for convenience)
 * @property {string}  mapTreatment     one of MAP_TREATMENTS
 * @property {Object}  regions          per-region activity flags { spine, map, results }
 * @property {Object}  results          what the results panel should say { mode, message }
 * @property {Object}  spine            spine focus hint { focus: 'location'|'event'|'none' }
 * @property {boolean} exportEnabled    whether the export entry is live
 * @property {boolean} settledLooking   true ONLY for genuinely complete data (never for partial)
 * @property {?string} banner           an honest top-of-stage banner, or null
 * @property {string}  statusClass      a stable CSS-friendly token for the state (e.g. 'state-degraded')
 */

/**
 * Map a workflow phase (+ optional windowResult / error) to its presentation.
 * Pure: same inputs always yield the same description.
 *
 * @param {string} phase                 one of WORKFLOW_PHASES (store.select.phase)
 * @param {Object|null} [windowResult]   store.select.windowResult — used for DEGRADED detail
 * @param {Object|null} [error]          store.select.error — used for ERROR detail
 * @returns {WorkflowView}
 */
export function describeWorkflow(phase, windowResult = null, error = null) {
  switch (phase) {
    case 'EMPTY':
      return view({
        phase,
        mapTreatment: MAP_TREATMENTS.REGIONAL,
        regions: { spine: true, map: true, results: true },
        spine: { focus: 'location' },
        results: { mode: 'empty', message: 'Select a location to begin.' },
        exportEnabled: false,
        settledLooking: false,
        banner: null,
        statusClass: 'state-empty',
      });

    case 'LOCATED':
      return view({
        phase,
        mapTreatment: MAP_TREATMENTS.FRAMED_BOUNDARY,
        regions: { spine: true, map: true, results: true },
        spine: { focus: 'event' },
        results: { mode: 'prompt', message: 'Choose a timeframe or pick from Last 10 Major Events.' },
        exportEnabled: false,
        settledLooking: false,
        banner: null,
        statusClass: 'state-located',
      });

    case 'AGGREGATING':
      return view({
        phase,
        mapTreatment: MAP_TREATMENTS.STREAMING_RASTER,
        regions: { spine: true, map: true, results: true },
        spine: { focus: 'event' },
        // Honest streaming language — coverage and confidence are forming, not done.
        results: { mode: 'loading', message: 'Aggregating — coverage and confidence are still forming.' },
        exportEnabled: false,
        settledLooking: false, // never settled-looking while data is incomplete
        banner: 'Aggregating rainfall — frames are still resolving.',
        statusClass: 'state-aggregating',
      });

    case 'SETTLED':
      return view({
        phase,
        mapTreatment: MAP_TREATMENTS.SETTLED_RASTER,
        regions: { spine: true, map: true, results: true },
        spine: { focus: 'none' },
        results: { mode: 'settled', message: '' },
        exportEnabled: true,
        settledLooking: true, // the one state allowed to look complete
        banner: null,
        statusClass: 'state-settled',
      });

    case 'DEGRADED':
      return view({
        phase,
        mapTreatment: MAP_TREATMENTS.PARTIAL_RASTER,
        regions: { spine: true, map: true, results: true },
        spine: { focus: 'none' },
        // Confidence panel leads with the limitation (docs/02 §3 DEGRADED).
        results: { mode: 'degraded', message: degradedMessage(windowResult) },
        exportEnabled: true, // export stays enabled but carries degraded provenance
        settledLooking: false, // explicitly NOT settled-looking
        banner: degradedMessage(windowResult),
        statusClass: 'state-degraded',
      });

    case 'ERROR':
      return view({
        phase,
        mapTreatment: MAP_TREATMENTS.ERROR,
        regions: { spine: true, map: true, results: true },
        spine: { focus: 'none' },
        results: { mode: 'error', message: errorMessage(error) },
        exportEnabled: false,
        settledLooking: false,
        banner: errorMessage(error),
        statusClass: 'state-error',
      });

    default:
      // Unknown phase: fail honest, not settled. Treat as empty-with-warning.
      return view({
        phase: phase == null ? 'EMPTY' : String(phase),
        mapTreatment: MAP_TREATMENTS.REGIONAL,
        regions: { spine: true, map: true, results: true },
        spine: { focus: 'location' },
        results: { mode: 'empty', message: 'Select a location to begin.' },
        exportEnabled: false,
        settledLooking: false,
        banner: null,
        statusClass: 'state-empty',
      });
  }
}

/** Build the honest degraded message from coverage detail when available. */
function degradedMessage(windowResult) {
  const cov = windowResult && windowResult.coverage;
  if (cov && typeof cov.pct === 'number') {
    const missing = cov.framesMissing != null ? cov.framesMissing : null;
    const tail = missing != null ? ` ${missing} frame${missing === 1 ? '' : 's'} missing.` : '';
    return `Low coverage (${cov.pct}%) — result is degraded, not settled.${tail}`;
  }
  return 'Coverage is low or frames are missing — this result is degraded, not settled.';
}

/** Build a user-facing error message that never implies stale or fabricated data. */
function errorMessage(error) {
  if (error && typeof error === 'object' && error.message) return `Could not load this result: ${error.message}`;
  if (typeof error === 'string' && error) return `Could not load this result: ${error}`;
  return 'Could not load this result. No data was shown rather than showing stale or fabricated data.';
}

/** Internal: freeze the view object so callers cannot mutate the shared description. */
function view(v) {
  return Object.freeze({
    ...v,
    regions: Object.freeze({ ...v.regions }),
    results: Object.freeze({ ...v.results }),
    spine: Object.freeze({ ...v.spine }),
  });
}
