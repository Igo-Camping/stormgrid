// urlState.js — the context tier serialised to/from the URL (docs/03 §3.1).
//
// A result must be linkable. The minimum shareable tuple is
// location + timeframe/event + duration + colour mode + calibration + layers.
// On load the store hydrates from the URL; on a result-defining change the app
// writes back. This module is pure string<->object; the wiring (history API)
// lives in the shell.

/**
 * Serialise the store's context slice to a URLSearchParams string (no leading '?').
 * @param {Object} context  store.select.context(state)
 * @returns {string}
 */
export function contextToQuery(context) {
  const p = new URLSearchParams();
  if (context.location) p.set('loc', encodeLocation(context.location));
  if (context.timeframe) p.set('tf', encodeTimeframe(context.timeframe));
  if (context.duration) p.set('dur', context.duration);
  if (context.colourMode && context.colourMode !== 'rainfall') p.set('mode', context.colourMode);
  if (context.calibration && context.calibration !== 'raw') p.set('cal', context.calibration);
  const on = Object.entries(context.layers || {}).filter(([, v]) => v).map(([k]) => k);
  if (on.length) p.set('layers', on.join(','));
  return p.toString();
}

/**
 * Parse a query string into a partial context. Unknown/malformed params are
 * ignored (never throw on a user-pasted link) but are NOT silently defaulted to
 * a fabricated location — a missing loc stays null.
 * @param {string} query  location.search (with or without leading '?')
 * @returns {Object} partial context
 */
export function queryToContext(query) {
  const p = new URLSearchParams(query.replace(/^\?/, ''));
  const ctx = {};
  if (p.has('loc')) { const l = decodeLocation(p.get('loc')); if (l) ctx.location = l; }
  if (p.has('tf')) { const t = decodeTimeframe(p.get('tf')); if (t) ctx.timeframe = t; }
  if (p.has('dur')) ctx.duration = p.get('dur');
  if (p.has('mode')) ctx.colourMode = p.get('mode');
  if (p.has('cal')) ctx.calibration = p.get('cal');
  if (p.has('layers')) {
    const set = new Set(p.get('layers').split(',').filter(Boolean));
    ctx.layers = { raster: set.has('raster'), catchment: set.has('catchment'), assets: set.has('assets') };
  }
  return ctx;
}

// loc encoding: catchment id `c:<id>`, point `p:<lat>,<lon>`, area `a:<ref>`
function encodeLocation(loc) {
  if (loc.catchmentId) return `c:${loc.catchmentId}`;
  if (loc.lat != null && loc.lon != null) return `p:${round5(loc.lat)},${round5(loc.lon)}`;
  if (loc.areaRef) return `a:${loc.areaRef}`;
  return '';
}
function decodeLocation(s) {
  if (!s) return null;
  if (s.startsWith('c:')) return { catchmentId: s.slice(2) };
  if (s.startsWith('p:')) {
    const [lat, lon] = s.slice(2).split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }
  if (s.startsWith('a:')) return { areaRef: s.slice(2) };
  return null;
}

// tf encoding: event `event:<id>`, window `window:<key>@<iso>`
function encodeTimeframe(tf) {
  if (tf.kind === 'event') return `event:${tf.eventId}`;
  if (tf.kind === 'window') return `window:${tf.windowKey}@${tf.endIso}`;
  return '';
}
function decodeTimeframe(s) {
  if (!s) return null;
  if (s.startsWith('event:')) return { kind: 'event', eventId: s.slice(6) };
  if (s.startsWith('window:')) {
    const body = s.slice(7);
    const at = body.lastIndexOf('@');
    if (at < 0) return null;
    return { kind: 'window', windowKey: body.slice(0, at), endIso: body.slice(at + 1) };
  }
  return null;
}

function round5(n) { return Math.round(n * 1e5) / 1e5; }
