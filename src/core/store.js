// store.js — the single shared store (docs/03 §1, §3.2; docs/02 §3, §4).
//
// One source of truth, unidirectional flow: action -> reducer -> new immutable
// state -> subscribers re-render the slices they care about. No component
// mutates state directly; no service writes the DOM. This replaces the closure
// state stranded in mountStormgridShell today (docs/01 §3.7).
//
// The reducer encodes the workflow-state machine (docs/02 §3) and the
// invalidation rules (docs/02 §4): changing location/timeframe invalidates the
// derived window; changing duration/colour/calibration does not.

import { validateWindowResult } from './sourceAdapter.js';

export const PHASES = Object.freeze(['EMPTY', 'LOCATED', 'AGGREGATING', 'SETTLED', 'DEGRADED', 'ERROR']);
export const COLOUR_MODES = Object.freeze(['rainfall', 'confidence', 'spatialVariability']);
export const LOW_COVERAGE_PCT = 70; // matches stormgridAvailability.js:176 threshold

/** @returns {Object} the canonical initial state */
export function initialState() {
  return {
    context: {
      location: null,          // LocationRef | null
      timeframe: null,         // Timeframe | null
      duration: '24h',         // DurationKey
      colourMode: 'rainfall',  // COLOUR_MODES
      calibration: 'raw',      // 'raw' | 'calibrated'
      layers: { raster: true, catchment: true, assets: false },
    },
    workflow: { phase: 'EMPTY', error: null },
    data: {
      windowResult: null,      // RainfallWindowResult | null
      events: { status: 'idle', items: [] }, // 'idle'|'scanning'|'done', streamed candidates
    },
    session: { recentLocations: [] }, // hydrated from persistence
  };
}

// ── Action creators ──────────────────────────────────────────────────────────
export const actions = Object.freeze({
  setLocation: (location) => ({ type: 'SET_LOCATION', location }),
  clearLocation: () => ({ type: 'CLEAR_LOCATION' }),
  setTimeframe: (timeframe) => ({ type: 'SET_TIMEFRAME', timeframe }),
  setDuration: (duration) => ({ type: 'SET_DURATION', duration }),
  setColourMode: (colourMode) => ({ type: 'SET_COLOUR_MODE', colourMode }),
  setCalibration: (calibration) => ({ type: 'SET_CALIBRATION', calibration }),
  setLayers: (layers) => ({ type: 'SET_LAYERS', layers }),
  beginAggregation: () => ({ type: 'BEGIN_AGGREGATION' }),
  setWindowData: (windowResult) => ({ type: 'SET_WINDOW_DATA', windowResult }),
  setError: (error) => ({ type: 'SET_ERROR', error }),
  setEvents: (patch) => ({ type: 'SET_EVENTS', patch }),
  addRecentLocation: (location) => ({ type: 'ADD_RECENT_LOCATION', location }),
});

// ── Reducer (pure) ─────────────────────────────────────────────────────────--
function reduce(state, action) {
  switch (action.type) {
    case 'SET_LOCATION':
      // Location change invalidates the derived window + events; timeframe persists.
      return {
        ...state,
        context: { ...state.context, location: action.location },
        data: { windowResult: null, events: { status: 'idle', items: [] } },
        workflow: { phase: 'LOCATED', error: null },
      };

    case 'CLEAR_LOCATION':
      return {
        ...state,
        context: { ...state.context, location: null, timeframe: null },
        data: { windowResult: null, events: { status: 'idle', items: [] } },
        workflow: { phase: 'EMPTY', error: null },
      };

    case 'SET_TIMEFRAME':
      // Timeframe change invalidates the window; location persists; aggregation begins next.
      return {
        ...state,
        context: { ...state.context, timeframe: action.timeframe },
        data: { ...state.data, windowResult: null },
        workflow: { phase: 'AGGREGATING', error: null },
      };

    case 'SET_DURATION':
      // Within a loaded window, duration re-derives from already-loaded stats — no invalidation.
      return { ...state, context: { ...state.context, duration: action.duration } };

    case 'SET_COLOUR_MODE':
      return { ...state, context: { ...state.context, colourMode: action.colourMode } };

    case 'SET_CALIBRATION':
      // Display state: re-derive from the parallel calibrated copy; raw is preserved.
      return { ...state, context: { ...state.context, calibration: action.calibration } };

    case 'SET_LAYERS':
      return { ...state, context: { ...state.context, layers: { ...state.context.layers, ...action.layers } } };

    case 'BEGIN_AGGREGATION':
      return { ...state, workflow: { phase: 'AGGREGATING', error: null } };

    case 'SET_WINDOW_DATA': {
      const result = validateWindowResult(action.windowResult); // throws on a bad/gap-stripped result
      const degraded = result.coverage.pct < LOW_COVERAGE_PCT || result.coverage.framesMissing > 0;
      return {
        ...state,
        data: { ...state.data, windowResult: result },
        workflow: { phase: degraded ? 'DEGRADED' : 'SETTLED', error: null },
      };
    }

    case 'SET_ERROR':
      return { ...state, workflow: { phase: 'ERROR', error: action.error } };

    case 'SET_EVENTS':
      return { ...state, data: { ...state.data, events: { ...state.data.events, ...action.patch } } };

    case 'ADD_RECENT_LOCATION': {
      const id = locationKey(action.location);
      const next = [action.location, ...state.session.recentLocations.filter((l) => locationKey(l) !== id)].slice(0, 10);
      return { ...state, session: { ...state.session, recentLocations: next } };
    }

    default:
      return state;
  }
}

function locationKey(loc) {
  if (!loc) return '';
  if (loc.catchmentId) return `c:${loc.catchmentId}`;
  if (loc.lat != null && loc.lon != null) return `p:${loc.lat.toFixed(5)},${loc.lon.toFixed(5)}`;
  if (loc.areaRef) return `a:${loc.areaRef}`;
  return JSON.stringify(loc);
}

// ── Store factory ─────────────────────────────────────────────────────────--
/**
 * @param {Object} [preset] optional initial state (e.g. hydrated from URL + persistence)
 * @returns {{getState, dispatch, subscribe}}
 */
export function createStore(preset) {
  let state = preset || initialState();
  /** @type {Array<{selector:Function, last:*, cb:Function}>} */
  const subs = [];

  function getState() { return state; }

  function dispatch(action) {
    const next = reduce(state, action);
    if (next === state) return state; // no-op (e.g. unknown action)
    state = next;
    for (const s of subs) {
      const sel = s.selector(state);
      if (!shallowEqual(sel, s.last)) { s.last = sel; s.cb(sel, state); }
    }
    return state;
  }

  /**
   * Subscribe to a selected slice. cb fires only when selector(state) changes.
   * @param {Function} selector @param {Function} cb @returns {Function} unsubscribe
   */
  function subscribe(selector, cb) {
    const entry = { selector, cb, last: selector(state) };
    subs.push(entry);
    return () => { const i = subs.indexOf(entry); if (i >= 0) subs.splice(i, 1); };
  }

  return { getState, dispatch, subscribe };
}

function shallowEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

// ── Selectors (pure) ─────────────────────────────────────────────────────────
export const select = Object.freeze({
  phase: (s) => s.workflow.phase,
  error: (s) => s.workflow.error,
  location: (s) => s.context.location,
  timeframe: (s) => s.context.timeframe,
  duration: (s) => s.context.duration,
  colourMode: (s) => s.context.colourMode,
  calibration: (s) => s.context.calibration,
  layers: (s) => s.context.layers,
  windowResult: (s) => s.data.windowResult,
  events: (s) => s.data.events,
  recentLocations: (s) => s.session.recentLocations,
  // the slice the URL encodes (docs/03 §3.1)
  context: (s) => s.context,
});
