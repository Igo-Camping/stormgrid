// router.js — minimal hash + query routing for the navigation shell.
//
// Spec: docs/02 §2 (URL-addressable surfaces) and docs/03 §3.1 (URL tier).
//
// Two responsibilities, no more:
//   1. Context <-> URL query sync. On load, hydrate the store context from the
//      URL via queryToContext(location.search) and apply it through the store's
//      actions. On result-defining context changes (location, timeframe) push a
//      new history entry so Back works; on lesser changes (duration, colour mode,
//      calibration, layers) replaceState so Back is not polluted (docs/03 §3.1).
//   2. Secondary-surface routing. #methodology and #labs are routable so a link
//      can deep-open them. The router only EXPOSES which secondary surface is
//      open; it does NOT implement their content (docs/02 §2, §6).
//
// The shell never serialises the URL by hand — it delegates to the pure
// urlState.contextToQuery / queryToContext helpers (src/core/urlState.js).
//
// Non-browser safe: every History/window access is guarded by hasWindow() so
// `node --check` and any unit import won't crash. In a non-browser context the
// router degrades to a no-op that still exposes its API.

import { contextToQuery, queryToContext } from '../core/urlState.js';
import { actions } from '../core/store.js';

const SECONDARY_SURFACES = Object.freeze(['methodology', 'labs']);

/** True when a real browser window + History API are present. */
function hasWindow() {
  return typeof window !== 'undefined' && !!window.history && !!window.location;
}

/** Parse the leading hash into a known secondary surface name, or null. */
function surfaceFromHash(hash) {
  const name = String(hash || '').replace(/^#/, '').trim().toLowerCase();
  return SECONDARY_SURFACES.includes(name) ? name : null;
}

/** Build the full path+query+hash string for a history write. */
function composeUrl(query, surface) {
  const path = hasWindow() ? window.location.pathname : '/';
  const q = query ? `?${query}` : '';
  const h = surface ? `#${surface}` : '';
  return `${path}${q}${h}`;
}

/**
 * Apply a partial context (from queryToContext) to the store via actions.
 * Order matters: location/timeframe set the workflow phase, so apply the
 * lesser presentation fields after. A missing loc stays null — the URL never
 * fabricates a location (urlState.queryToContext already guarantees this).
 */
function hydrateStore(store, ctx) {
  if (ctx.location) store.dispatch(actions.setLocation(ctx.location));
  if (ctx.timeframe) store.dispatch(actions.setTimeframe(ctx.timeframe));
  if (ctx.duration) store.dispatch(actions.setDuration(ctx.duration));
  if (ctx.colourMode) store.dispatch(actions.setColourMode(ctx.colourMode));
  if (ctx.calibration) store.dispatch(actions.setCalibration(ctx.calibration));
  if (ctx.layers) store.dispatch(actions.setLayers(ctx.layers));
}

/**
 * Create the router and wire it to the store.
 *
 * @param {Object} store              createStore() instance
 * @param {Object} [options]
 * @param {Function} [options.onSurfaceChange]  called with (surfaceName|null) when
 *                                               the open secondary surface changes
 * @returns {{
 *   start: () => void,            hydrate from URL + begin listening (call once on load)
 *   stop: () => void,             remove listeners
 *   getSurface: () => (string|null),  which secondary surface is open
 *   openSurface: (name) => void,  open #methodology / #labs (pushes history)
 *   closeSurface: () => void,     return to the workspace (clears the hash)
 *   syncContext: () => void,      write current store context to the URL now
 * }}
 */
export function createRouter(store, options = {}) {
  const onSurfaceChange = typeof options.onSurfaceChange === 'function' ? options.onSurfaceChange : () => {};

  let surface = null;            // current secondary surface, or null (workspace)
  let lastQuery = null;          // last query string we wrote, to dedupe writes
  let unsubscribeContext = null; // store subscription teardown
  let started = false;

  // ── Context -> URL ────────────────────────────────────────────────────────--
  // Result-defining changes (location, timeframe) push; everything else replaces.
  // We compare the *defining* slice against the previous context to decide.
  let prevDefining = null;

  function definingKey(ctx) {
    return JSON.stringify({ loc: ctx.location || null, tf: ctx.timeframe || null });
  }

  function writeUrl(ctx) {
    if (!hasWindow()) return;
    const query = contextToQuery(ctx);
    const url = composeUrl(query, surface);
    const defining = definingKey(ctx);
    const isResultDefining = prevDefining !== null && defining !== prevDefining;
    prevDefining = defining;

    // Skip a redundant write (no observable change to query or surface).
    if (query === lastQuery && !isResultDefining) return;
    lastQuery = query;

    if (isResultDefining) window.history.pushState({ sg: true }, '', url);
    else window.history.replaceState({ sg: true }, '', url);
  }

  function onContextChange(ctx) { writeUrl(ctx); }

  // ── URL -> surface (hash) ────────────────────────────────────────────────────
  function readSurfaceFromUrl() {
    const next = hasWindow() ? surfaceFromHash(window.location.hash) : null;
    if (next !== surface) {
      surface = next;
      onSurfaceChange(surface);
    }
  }

  function onPopState() {
    // Back/forward: re-hydrate context AND re-read the surface so deep links work.
    if (hasWindow()) hydrateStore(store, queryToContext(window.location.search));
    readSurfaceFromUrl();
  }

  function onHashChange() { readSurfaceFromUrl(); }

  // ── Public API ────────────────────────────────────────────────────────────--
  function start() {
    if (started) return;
    started = true;

    if (hasWindow()) {
      // 1. Hydrate the store context from the URL on load.
      const ctx = queryToContext(window.location.search);
      hydrateStore(store, ctx);
      // Seed the defining key from the now-current store context so the first
      // user change is correctly classified as push vs replace.
      prevDefining = definingKey(store.getState().context);
      lastQuery = contextToQuery(store.getState().context);

      // 2. Read any deep-linked secondary surface.
      readSurfaceFromUrl();

      // 3. Begin listening for browser navigation.
      window.addEventListener('popstate', onPopState);
      window.addEventListener('hashchange', onHashChange);
    }

    // 4. Begin mirroring context changes to the URL (works once a window exists;
    //    the subscription itself is store-only and harmless in non-browser).
    unsubscribeContext = store.subscribe((s) => s.context, onContextChange);
  }

  function stop() {
    if (!started) return;
    started = false;
    if (typeof unsubscribeContext === 'function') unsubscribeContext();
    unsubscribeContext = null;
    if (hasWindow()) {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('hashchange', onHashChange);
    }
  }

  function getSurface() { return surface; }

  function openSurface(name) {
    const target = SECONDARY_SURFACES.includes(name) ? name : null;
    if (!target || target === surface) return;
    surface = target;
    if (hasWindow()) {
      const url = composeUrl(contextToQuery(store.getState().context), surface);
      window.history.pushState({ sg: true, surface: target }, '', url);
    }
    onSurfaceChange(surface);
  }

  function closeSurface() {
    if (surface === null) return;
    surface = null;
    if (hasWindow()) {
      const url = composeUrl(contextToQuery(store.getState().context), null);
      window.history.pushState({ sg: true, surface: null }, '', url);
    }
    onSurfaceChange(surface);
  }

  function syncContext() {
    if (hasWindow()) writeUrl(store.getState().context);
  }

  return { start, stop, getSurface, openSurface, closeSurface, syncContext };
}

export { SECONDARY_SURFACES };
