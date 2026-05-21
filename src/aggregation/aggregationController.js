// aggregationController.js — the data-flow spine driver (docs/03 §1, §4; docs/02 §3, §4).
//
// This is the side-effecting controller that turns store *intent* (a location +
// timeframe selected → phase AGGREGATING) into a SourceAdapter fetch, and feeds
// the validated result back into the store. It is the one place where the
// unidirectional flow crosses the service boundary:
//
//     action → store(phase AGGREGATING) → [this controller] → source.getWindow()
//            → dispatch(setWindowData | setError) → store(SETTLED|DEGRADED|ERROR)
//
// Hard rules it upholds (the brief's red lines):
//   • NEVER fall back to stale or fabricated data. A failed/invalid fetch becomes
//     an explicit ERROR with a data-quality message — never the previous window,
//     never a zeroed default.
//   • Latest-wins. Overlapping requests are guarded by a monotonic request key
//     derived from (location, timeframe, calibration). A stale resolve whose key
//     no longer matches the live request is dropped on the floor.
//   • Gaps propagate unchanged. The controller does not inspect or repair the
//     result's gap fields; validateWindowResult (run inside setWindowData) and the
//     calibration service own that. The controller only moves data, it never
//     defaults a missing value.
//   • Areal-only. This layer deals exclusively in the contract's ArealRainfall
//     observed values. It never imports, references, or applies ARF — that is the
//     Analysis layer, point-side only (docs/03 §4 red line).
//
// It is wired by the orchestrator in app.js: createAggregationController(store, source).

import { actions, select } from '../core/store.js';
import { deriveCalibratedResult, isCalibratedAvailable } from './calibrationService.js';

/**
 * Build the request key that defines "the thing currently being aggregated".
 * Two store states with the same key describe the same fetch; a change in any
 * component means a new request and invalidates any in-flight resolve.
 *
 * Duration is deliberately NOT part of the key: a duration change re-derives from
 * the already-loaded window's durationStats and must not trigger a refetch
 * (docs/02 §4; store SET_DURATION is a no-invalidation reducer). Calibration IS
 * part of the key only insofar as it selects raw vs calibrated *presentation* — but
 * because the calibrated copy is derived in-memory from the same raw fetch, a
 * calibration toggle alone does not refetch either (see onCalibrationChange below).
 * It is included here so a calibration change while a fetch is mid-flight cannot
 * let a raw-keyed resolve land as if it were calibrated.
 *
 * @param {Object} state
 * @returns {string|null} null when there is nothing to aggregate
 */
function requestKey(state) {
  const loc = select.location(state);
  const tf = select.timeframe(state);
  if (!loc || !tf) return null;
  return JSON.stringify({ loc: locKey(loc), tf, cal: select.calibration(state) });
}

function locKey(loc) {
  if (typeof loc === 'string') return loc;
  if (loc && loc.catchmentId) return `c:${loc.catchmentId}`;
  if (loc && loc.lat != null && loc.lon != null) return `p:${loc.lat},${loc.lon}`;
  if (loc && loc.areaRef) return `a:${loc.areaRef}`;
  return JSON.stringify(loc);
}

/**
 * Compose the WindowRequest (docs/04 §3.2) from the current store context. The
 * calibration field is always sent as 'raw' to the adapter: the adapter returns
 * the raw archive window, and CalibrationService derives the calibrated copy in
 * memory. This keeps raw immutable and the calibrated copy a separate, labelled
 * artefact (docs/04 §1 rule, the red line). The adapter is never asked to
 * pre-bake calibration.
 *
 * @param {Object} state
 * @returns {Object} WindowRequest
 */
function buildRequest(state) {
  return {
    location: select.location(state),
    timeframe: select.timeframe(state),
    duration: select.duration(state),
    calibration: 'raw',
  };
}

/**
 * Create the aggregation controller.
 *
 * @param {{getState:Function, dispatch:Function, subscribe:Function}} store
 * @param {{getWindow:Function, describe?:Function}} source  the active SourceAdapter
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createAggregationController(store, source) {
  if (!store || typeof store.dispatch !== 'function') {
    throw new Error('createAggregationController: a store with dispatch/subscribe is required');
  }
  if (!source || typeof source.getWindow !== 'function') {
    throw new Error('createAggregationController: a source with getWindow() is required');
  }

  // The key of the request currently considered "live". A resolve is only allowed
  // to land if its captured key still equals this when it completes (latest-wins).
  let liveKey = null;
  // The raw (uncalibrated) result for the live window, kept so a calibration
  // toggle can re-derive without a refetch.
  let liveRawResult = null;
  let unsubscribe = null;
  let started = false;

  /**
   * Run a fetch for the current store state. Captures the request key at call
   * time; on resolve, drops the result if the key has since changed.
   */
  async function runAggregation() {
    const state = store.getState();
    const key = requestKey(state);
    if (!key) return; // nothing selected — nothing to do
    liveKey = key;
    liveRawResult = null;
    const request = buildRequest(state);

    let result;
    try {
      result = await source.getWindow(request);
    } catch (err) {
      // A failed fetch is a data-quality ERROR, never a silent fallback to stale
      // or fabricated data. Drop it if a newer request superseded this one.
      if (liveKey !== key) return;
      store.dispatch(actions.setError(dataQualityMessage(err, source)));
      return;
    }

    // Latest-wins: a stale resolve whose request key no longer matches the live
    // request is ignored (the user changed location/timeframe/calibration while
    // this was in flight). It is NOT dispatched — no stale data reaches the store.
    if (liveKey !== key) return;

    // Keep the raw result so calibration toggles re-derive without refetching.
    liveRawResult = result;

    // Apply the current calibration selection. 'raw' passes the result through
    // untouched; 'calibrated' derives a labelled calibrated COPY (raw preserved).
    let toStore = result;
    if (select.calibration(store.getState()) === 'calibrated') {
      try {
        toStore = await deriveCalibratedResult(result);
      } catch (err) {
        // Calibration is a derived convenience; if it fails, surface it honestly
        // rather than showing a half-applied or fabricated calibrated number.
        store.dispatch(actions.setError(
          `Calibration could not be derived for this window: ${msgOf(err)}. ` +
          `Raw data is unaffected — switch to Raw to view it.`
        ));
        return;
      }
    }

    // setWindowData runs validateWindowResult internally and throws on a bad/
    // gap-stripped result; we convert that throw into an explicit ERROR rather
    // than letting it escape unhandled (docs/04 §5: a failing result is a
    // data-quality ERROR state, never silently coerced).
    try {
      store.dispatch(actions.setWindowData(toStore));
    } catch (err) {
      store.dispatch(actions.setError(
        `Rainfall window failed contract validation and was rejected: ${msgOf(err)}`
      ));
    }
  }

  /**
   * Re-derive the stored window for a calibration toggle WITHOUT a refetch
   * (docs/02 §4: calibration is display state). Uses the retained raw result.
   * If no raw result is loaded yet, this is a no-op (the next aggregation will
   * pick up the selection via requestKey).
   */
  async function reprojectCalibration() {
    const cal = select.calibration(store.getState());
    const raw = liveRawResult;
    if (!raw) return; // nothing loaded — nothing to re-derive

    if (cal === 'raw') {
      // Re-assert the raw result. setWindowData re-validates it (cheap, already valid).
      try { store.dispatch(actions.setWindowData(raw)); }
      catch (err) { store.dispatch(actions.setError(`Raw window rejected on re-validation: ${msgOf(err)}`)); }
      return;
    }

    // calibrated
    try {
      const calibrated = await deriveCalibratedResult(raw);
      store.dispatch(actions.setWindowData(calibrated));
    } catch (err) {
      store.dispatch(actions.setError(
        `Calibration could not be derived for this window: ${msgOf(err)}. ` +
        `Raw data is unaffected — switch to Raw to view it.`
      ));
    }
  }

  // Track previous slices so we react to the right transition, not every notify.
  let prevPhase = null;
  let prevKey = null;
  let prevCalibration = null;

  function onChange() {
    const state = store.getState();
    const phase = select.phase(state);
    const key = requestKey(state);
    const calibration = select.calibration(state);

    // (1) The data-flow spine: a fresh AGGREGATING phase with a complete request
    //     (location + timeframe present) triggers a fetch. We fire when we ENTER
    //     AGGREGATING, or when the request key changes while already aggregating
    //     (e.g. timeframe changed again before the first settled).
    const enteredAggregating = phase === 'AGGREGATING' && prevPhase !== 'AGGREGATING';
    const keyChangedWhileAggregating = phase === 'AGGREGATING' && key && key !== prevKey;
    if (key && (enteredAggregating || keyChangedWhileAggregating)) {
      // fire-and-forget; latest-wins guard inside protects against overlap.
      runAggregation();
    }

    // (2) Calibration toggle while settled/degraded → re-derive from the loaded
    //     window, no refetch. Only act when calibration actually changed and we
    //     are not mid-fetch (AGGREGATING handles the selection itself in (1)).
    const calibrationChanged = calibration !== prevCalibration && prevCalibration !== null;
    if (calibrationChanged && (phase === 'SETTLED' || phase === 'DEGRADED')) {
      reprojectCalibration();
    }

    prevPhase = phase;
    prevKey = key;
    prevCalibration = calibration;
  }

  return {
    start() {
      if (started) return;
      started = true;
      const state = store.getState();
      prevPhase = select.phase(state);
      prevKey = requestKey(state);
      prevCalibration = select.calibration(state);
      // Subscribe to the whole context+workflow slice that bears on aggregation.
      // The selector returns a small tuple; the store fires the cb only when it
      // shallow-changes, so we are not re-running on unrelated state churn.
      unsubscribe = store.subscribe(
        (s) => ({ phase: select.phase(s), key: requestKey(s), calibration: select.calibration(s) }),
        () => onChange()
      );
      // If we start already in AGGREGATING (e.g. hydrated from a URL), kick once.
      if (prevPhase === 'AGGREGATING' && prevKey) runAggregation();
    },
    stop() {
      started = false;
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
      // Abandon any in-flight resolve: clearing liveKey means a late resolve can
      // never match and will be dropped.
      liveKey = null;
      liveRawResult = null;
    },
  };
}

/**
 * Compose a clear, data-quality-oriented error message for a failed fetch. Names
 * the source so the ERROR state can say *which* source failed (docs/02 §3).
 * @param {*} err @param {Object} source
 * @returns {string}
 */
function dataQualityMessage(err, source) {
  let label = 'data source';
  try {
    if (source && typeof source.describe === 'function') {
      const d = source.describe();
      if (d && d.label) label = d.label;
    }
  } catch { /* describe must never break error reporting */ }
  return `Could not load rainfall data from ${label}: ${msgOf(err)}. ` +
    `No fallback to stale or estimated data — resolve the source issue and retry.`;
}

function msgOf(err) {
  return (err && err.message) ? err.message : String(err);
}

// Re-export so the orchestrator can feature-detect calibration availability when
// deciding whether to show the Raw/Calibrated toggle (docs/02 §6).
export { isCalibratedAvailable };
