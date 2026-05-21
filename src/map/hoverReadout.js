// hoverReadout.js — THE single cursor-following map readout (docs/02 §7, §9, §11;
// docs/03 §2 HoverReadout).
//
// CONSOLIDATION: today there are TWO readouts — the per-polygon Leaflet tooltip
// in stormgridCatchmentMap.js (catchment + window stats) and the overlay hover
// line rendered by stormgridCumulativeOverlay.js renderOverlayLegend (depth +
// coverage). This module replaces BOTH with one readout that, for the point under
// the probe, reports: rainfall depth (mm), the catchment the point falls in, and
// the coverage state.
//
// GAP-HONESTY RED LINE (docs/02 §7, docs/04 §1 rule 2): it distinguishes
//   in_bounds && has_coverage   -> "<depth> mm"
//   in_bounds && !has_coverage  -> "no coverage here"   (NEVER "0 mm")
//   !in_bounds                  -> "outside data extent"
// A no-coverage cell must never read 0 mm. The grid lookup (hoverDepthAt-style)
// already returns in_bounds / has_coverage; this module only renders those, it
// never coerces a missing value to a number.
//
// PROBE-POINT ABSTRACTION (docs/02 §9): the readout is driven by a generic
// "probe" — { lat, lon, clientX, clientY } — NOT directly by a mouse event. On
// desktop the host feeds mousemove; a mobile pass can feed tap/long-press into
// the same probe() method without touching this logic. updateProbe(null) clears.
//
// THROTTLING (docs/02 §7, perf budget docs/03 §7 ≤16ms/frame): updates are
// rAF-coalesced so rapid pointer moves render at most once per frame.
//
// TIME-SCRUBBER READINESS: the readout takes a `lookup(lat,lon)` function the
// host supplies. Today that closes over the accumulated-window grid; once a
// scrubber exists the host swaps in a frame-scoped lookup with no change here.
//
// No store import; no Leaflet control — a plain absolutely-positioned element the
// host parents into the map container. Pure render from the probe + lookup.

/**
 * @typedef {Object} ProbeResult
 * @property {boolean} in_bounds
 * @property {boolean} has_coverage
 * @property {number|null} depth_mm
 */

/**
 * @param {HTMLElement} container  the map container (positioned ancestor)
 * @param {{
 *   lookup:(lat:number, lon:number)=>ProbeResult,
 *   catchmentAt?:(lat:number, lon:number)=>string|null
 * }} cfg
 *   lookup       grid depth lookup (closes over window grid; swap for per-frame later)
 *   catchmentAt  optional: resolve which catchment a point falls in (name/id)
 * @returns {{
 *   updateProbe(probe:{lat:number, lon:number, clientX?:number, clientY?:number}|null):void,
 *   setLookup(lookup:(lat:number, lon:number)=>ProbeResult):void,
 *   setCatchmentResolver(fn:(lat:number, lon:number)=>string|null):void,
 *   setVisible(v:boolean):void,
 *   destroy():void
 * }}
 */
export function createHoverReadout(container, cfg = {}) {
  if (!container) throw new Error('Stormgrid map: hover readout needs a container element.');

  let lookup = typeof cfg.lookup === 'function' ? cfg.lookup : null;
  let catchmentAt = typeof cfg.catchmentAt === 'function' ? cfg.catchmentAt : null;
  let visible = true;
  let pending = null;     // latest probe awaiting a frame
  let rafId = 0;

  const el = document.createElement('div');
  el.className = 'stormgrid-hoverreadout';
  el.setAttribute('aria-live', 'polite');
  el.style.display = 'none';
  // The container must be a positioned ancestor; map.css sets position:relative.
  container.appendChild(el);

  function depthLabel(probe) {
    if (!lookup) return null;
    let res;
    try { res = lookup(probe.lat, probe.lon); } catch (_) { res = null; }
    if (!res) return { text: '—', state: 'unknown' };
    if (!res.in_bounds) return { text: 'outside data extent', state: 'out-of-bounds' };
    if (!res.has_coverage) return { text: 'no coverage here', state: 'no-coverage' }; // NEVER "0 mm"
    const mm = typeof res.depth_mm === 'number' ? res.depth_mm : null;
    if (mm == null) return { text: 'no coverage here', state: 'no-coverage' };
    return { text: `${mm.toFixed(1)} mm`, state: 'covered' };
  }

  function paint(probe) {
    if (!probe || !visible) { el.style.display = 'none'; return; }
    const depth = depthLabel(probe);
    const catchment = catchmentAt ? safe(() => catchmentAt(probe.lat, probe.lon)) : null;

    const rows = [];
    if (depth) {
      rows.push(`<span class="stormgrid-hoverreadout__depth stormgrid-hoverreadout__depth--${depth.state}">${escapeHtml(depth.text)}</span>`);
    }
    rows.push(`<span class="stormgrid-hoverreadout__catch">${catchment ? escapeHtml(catchment) : 'no catchment here'}</span>`);
    el.innerHTML = rows.join('');
    el.style.display = '';

    // Position relative to the container; offset so the cursor doesn't cover it.
    if (typeof probe.clientX === 'number' && typeof probe.clientY === 'number') {
      const rect = container.getBoundingClientRect();
      let x = probe.clientX - rect.left + 14;
      let y = probe.clientY - rect.top + 14;
      // Keep it inside the container's right/bottom edges.
      const ew = el.offsetWidth || 120;
      const eh = el.offsetHeight || 36;
      if (x + ew > rect.width) x = rect.width - ew - 4;
      if (y + eh > rect.height) y = rect.height - eh - 4;
      el.style.left = `${Math.max(0, x)}px`;
      el.style.top = `${Math.max(0, y)}px`;
    }
  }

  function flush() {
    rafId = 0;
    paint(pending);
  }

  /** Feed a probe point (cursor today; tap later). null clears the readout. */
  function updateProbe(probe) {
    pending = probe;
    if (!probe) { paint(null); return; }
    // rAF-coalesce: at most one paint per frame regardless of pointer rate.
    if (rafId) return;
    rafId = (window.requestAnimationFrame || ((cb) => setTimeout(cb, 16)))(flush);
  }

  function setLookup(fn) { lookup = typeof fn === 'function' ? fn : null; }
  function setCatchmentResolver(fn) { catchmentAt = typeof fn === 'function' ? fn : null; }
  function setVisible(v) { visible = Boolean(v); if (!visible) el.style.display = 'none'; }

  function destroy() {
    if (rafId && window.cancelAnimationFrame) window.cancelAnimationFrame(rafId);
    rafId = 0;
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  return { updateProbe, setLookup, setCatchmentResolver, setVisible, destroy };
}

function safe(fn) { try { return fn(); } catch (_) { return null; } }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
