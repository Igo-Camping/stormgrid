// mapHost.js — the MAP HOST (docs/02 §1, §3, §7; docs/03 §2 MAP LAYER, §6).
//
// mountMap(container, store) creates and OWNS the single Leaflet map instance
// (CARTO light basemap), composes the boundary + raster layers, the ONE legend,
// and the ONE hover readout, and wires them to the store. The map never blocks on
// analysis — it renders purely from store state pushed to it via subscriptions
// (docs/02 §1: the map is the dominant surface; docs/03 §6: layers added by
// reference, never re-created).
//
// LAYOUT CONTRACT: the host fills its parent (100% width/height). It expects a
// flex/grid parent supplied by the shell (docs/02 §1 three-column workspace), NOT
// a fixed 460px tile like today's stormgrid.css:302-305. See map.css.
//
// BRIDGE HANDSHAKE: the created Leaflet map is exposed two ways for downstream
// wiring (B.3) — returned indirectly via the layer refs, and published on
// window.__stormgrid.map using the existing read-only handshake pattern
// (stormgridMapBridge.js). We set it directly (no import of that module, to keep
// map/ self-contained) and clear it on destroy.
//
// STORE SUBSCRIPTIONS (built against src/core/store.js select.* — never mutated):
//   select.windowResult -> raster.update + legend.update + hover lookup rebind
//   select.location     -> frame the catchment boundary (or regional on null)
//   select.layers       -> toggle raster / catchment visibility
//   select.colourMode   -> legend.update (restyle in place)
//   select.phase        -> per-state treatment (docs/02 §3 via workflowView tokens)
//
// Leaflet global: window.L (loaded by index.html). No build step.

import { select, actions } from '../core/store.js';
import { MAP_TREATMENTS } from '../shell/workflowView.js';
import {
  createCatchmentBoundaryLayer,
  createRainfallRasterLayer,
} from './layers.js';
import { createLegend } from './legend.js';
import { createHoverReadout } from './hoverReadout.js';
import { loadPreviewOverlay } from './overlayLoader.js';

const BRIDGE_NS = '__stormgrid';
const REGIONAL_VIEW = { center: [-33.75, 151.27], zoom: 11 }; // docs/02 §3 EMPTY fallback

/**
 * Look up depth at (lon,lat) in a contract raster grid. Mirrors the salvaged
 * hoverDepthAt (stormgridCumulativeOverlay.js:119-136) but reads the contract
 * grid shape (docs/04 §3.3: raster.grid.values_mm + bbox). Returns the gap-honest
 * { in_bounds, has_coverage, depth_mm } the hover readout expects. The grid may
 * come from a real windowResult.raster OR from the synthetic preview overlay —
 * the lookup is identical, so the readout never special-cases the source.
 *
 * @param {{grid:Object}|null} raster  a contract raster ({ grid, pngRef, leafletBounds })
 */
function gridLookup(raster) {
  const grid = raster && raster.grid;
  return (lat, lon) => {
    const empty = { in_bounds: false, has_coverage: false, depth_mm: null };
    if (!grid || !Array.isArray(grid.values_mm) || !Array.isArray(grid.bbox)) return empty;
    const [w, s, e, n] = grid.bbox;
    if (!(Number.isFinite(lon) && Number.isFinite(lat))) return empty;
    if (lon < w || lon > e || lat < s || lat > n) return empty;
    const cols = grid.cols || (grid.values_mm[0] ? grid.values_mm[0].length : 0);
    const rows = grid.rows || grid.values_mm.length;
    if (!cols || !rows) return empty;
    const col = Math.min(cols - 1, Math.max(0, Math.floor(((lon - w) / (e - w)) * cols)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(((n - lat) / (n - s)) * rows)));
    const v = grid.values_mm[row] ? grid.values_mm[row][col] : null;
    return {
      in_bounds: true,
      has_coverage: typeof v === 'number',
      depth_mm: typeof v === 'number' ? v : null, // null gap stays null — never 0
    };
  };
}

/**
 * Mount the map host.
 * @param {HTMLElement} container  a flex/grid child that the map fills (full height)
 * @param {{getState:Function, dispatch:Function, subscribe:Function}} store  src/core/store.js
 * @returns {{ destroy():void }}
 */
export function mountMap(container, store) {
  if (!window.L) throw new Error('Stormgrid map: Leaflet (window.L) is required (loaded by index.html).');
  if (!container) throw new Error('Stormgrid map: a container element is required.');
  if (!store || typeof store.subscribe !== 'function') throw new Error('Stormgrid map: a store is required.');

  container.classList.add('stormgrid-maphost');

  // ── Single Leaflet instance (CARTO light basemap, salvaged from
  //    stormgridCatchmentMap.js:125-130). z 200 basemap implied by Leaflet panes.
  const map = window.L.map(container, { zoomControl: true, attributionControl: true });
  window.L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap, &copy; CARTO',
    crossOrigin: 'anonymous', // lets html2canvas read tile pixels for PNG snapshot export
  }).addTo(map);
  map.setView(REGIONAL_VIEW.center, REGIONAL_VIEW.zoom);

  // Bridge handshake (read-only, defensive — same shape as stormgridMapBridge.js).
  if (typeof window !== 'undefined') {
    if (!window[BRIDGE_NS] || typeof window[BRIDGE_NS] !== 'object') window[BRIDGE_NS] = {};
    window[BRIDGE_NS].map = map;
  }

  // ── Layers + UI singletons.
  const raster = createRainfallRasterLayer(map);
  const legend = createLegend(map);
  const hover = createHoverReadout(container, { lookup: gridLookup(null) });

  // ── SYNTHETIC PREVIEW OVERLAY (DECISIONS B-012; docs/04 §3.3) ───────────────
  // The Lizard precomputed source returns windowResult.raster === null (the
  // per-catchment JSON has no grid/PNG). The only spatial surface that exists
  // today is the SEPARATE preview overlay (is_synthetic_preview:true), loaded once
  // here via overlayLoader. We hold it and fall back to it when a windowResult is
  // present but carries no real raster — clearly badged as synthetic so it is
  // never presented as a real radar surface. If it fails to load, we keep null and
  // the map shows the honest "no rainfall raster" state.
  let previewOverlay = null; // OverlayLoadResult | null (set async)
  loadPreviewOverlay()
    .then((res) => {
      previewOverlay = res && res.available ? res : null;
      // Re-apply the raster now that the fallback surface is (or isn't) available.
      syncRaster();
    })
    .catch(() => { previewOverlay = null; });

  // The ACTIVE raster for the current store state. Prefers the real
  // windowResult.raster (radar/real adapter, future); falls back to the synthetic
  // preview overlay only while a windowResult is present (i.e. a selection has
  // produced a window) so we never paint a raster over an empty/regional view.
  // Returns { raster, isSyntheticPreview, previewMeta } — raster is null when none.
  function effectiveRaster() {
    const wr = select.windowResult(store.getState());
    if (wr && wr.raster && wr.raster.pngRef) {
      return { raster: wr.raster, isSyntheticPreview: false, previewMeta: null };
    }
    if (wr && previewOverlay && previewOverlay.raster) {
      return {
        raster: previewOverlay.raster,
        isSyntheticPreview: !!previewOverlay.isSyntheticPreview,
        previewMeta: previewOverlay.metadata || null,
      };
    }
    return { raster: null, isSyntheticPreview: false, previewMeta: null };
  }

  // Single point that pushes the active raster to the image layer, the ONE legend,
  // and the ONE hover lookup. Honours the layers.raster toggle and the current
  // phase treatment (some phases force the raster clear regardless of data).
  function syncRaster() {
    const st = store.getState();
    const layersOn = select.layers(st).raster !== false;
    const rasterAllowed = treatmentAllowsRaster(select.phase(st));
    const eff = effectiveRaster();
    const active = (layersOn && rasterAllowed) ? eff.raster : null;

    raster.update(active);
    raster.setVisible(Boolean(active));
    legend.update({
      colourMode: select.colourMode(st),
      windowResult: select.windowResult(st),
      raster: active,
      isSyntheticPreview: active ? eff.isSyntheticPreview : false,
      previewMeta: active ? eff.previewMeta : null,
      frame: { kind: 'window' }, // accumulated window today; scrubber swaps later
    });
    // Hover always reads the data grid (independent of the layers toggle) so the
    // readout reports coverage even when the visual layer is hidden — but only when
    // a raster is conceptually active for this phase. No raster -> empty lookup.
    hover.setLookup(gridLookup(rasterAllowed ? eff.raster : null));
  }

  // Boundary layer loads async (GeoJSON fetch). Track readiness so subscriptions
  // that arrive before it resolves can re-apply once it's ready.
  let boundary = null;
  let pendingLocationFrame = null; // last location to frame, applied on boundary ready

  // ── TIME-SCRUBBER MOUNT POINT (RESERVED — docs/02 §7) ──────────────────────
  // A horizontal strip along the map's bottom edge is reserved for a future frame
  // scrubber. Do NOT implement it now. When added, it will:
  //   (a) mount into `scrubberMount` below (kept empty + 0-height by map.css),
  //   (b) dispatch a frame-selection action, and
  //   (c) the host will re-call legend.update({ frame:{kind:'frame',index,iso} })
  //       and hover.setLookup(<frame-scoped lookup>) — both already accept a
  //       `frame`/lookup parameter, so NO rework of legend/hover is needed.
  // The legend and hover readout are deliberately parameterised by "current frame
  // or accumulated window" precisely so this strip can be added without rework.
  const scrubberMount = document.createElement('div');
  scrubberMount.className = 'stormgrid-scrubber-mount';
  scrubberMount.setAttribute('data-reserved', 'time-scrubber');
  scrubberMount.setAttribute('aria-hidden', 'true');
  container.appendChild(scrubberMount);

  // ── Probe wiring (docs/02 §9 probe-point abstraction). Desktop feeds mousemove;
  //    a mobile pass swaps the source without touching the readout.
  function onMouseMove(ev) {
    const ll = map.mouseEventToLatLng(ev);
    hover.updateProbe({ lat: ll.lat, lon: ll.lng, clientX: ev.clientX, clientY: ev.clientY });
  }
  function onMouseOut() { hover.updateProbe(null); }
  map.getContainer().addEventListener('mousemove', onMouseMove);
  map.getContainer().addEventListener('mouseout', onMouseOut);

  // Resolve which catchment a point falls in (best-effort, for the readout's
  // "which catchment" line). Uses Leaflet layer bounds as a cheap proxy until a
  // point-in-polygon resolver (stormgridGeo.js) is wired in B.3.
  function resolveCatchmentName(lat, lon) {
    if (!boundary || !boundary.layer) return null;
    let hit = null;
    boundary.layer.eachLayer((lyr) => {
      if (hit) return;
      const b = typeof lyr.getBounds === 'function' ? lyr.getBounds() : null;
      if (b && b.contains([lat, lon])) {
        hit = (lyr.feature && lyr.feature.properties && lyr.feature.properties.catchment_id) || null;
      }
    });
    return hit;
  }

  // Which phases may show a rainfall raster at all. REGIONAL (EMPTY), framed
  // LOCATED (boundary only, no window yet), and ERROR (never stale/fabricated)
  // suppress the raster regardless of data; the rest let the active raster paint.
  function treatmentAllowsRaster(phase) {
    const t = treatmentFor(phase);
    return t !== MAP_TREATMENTS.REGIONAL
      && t !== MAP_TREATMENTS.FRAMED_BOUNDARY
      && t !== MAP_TREATMENTS.ERROR;
  }

  // ── Phase → map treatment (docs/02 §3, tokens from workflowView.js). The host
  //    honours the semantic treatment; it does not re-derive workflow logic.
  function applyTreatment(phase) {
    const t = treatmentFor(phase);
    // REGIONAL clears any selection; raster suppression for all states is decided
    // centrally by syncRaster() via treatmentAllowsRaster() so the active raster,
    // legend badge, and hover lookup never drift out of sync.
    if (t === MAP_TREATMENTS.REGIONAL && boundary) boundary.selectCatchment(null);
    // STREAMING_RASTER / SETTLED_RASTER / PARTIAL_RASTER: the active raster paints
    // (real windowResult.raster, else the synthetic preview). PARTIAL (DEGRADED)
    // shows what exists with no-coverage cells transparent — a property of the
    // PNG/grid, honoured as-is.
    syncRaster();
  }

  function treatmentFor(phase) {
    switch (phase) {
      case 'EMPTY': return MAP_TREATMENTS.REGIONAL;
      case 'LOCATED': return MAP_TREATMENTS.FRAMED_BOUNDARY;
      case 'AGGREGATING': return MAP_TREATMENTS.STREAMING_RASTER;
      case 'SETTLED': return MAP_TREATMENTS.SETTLED_RASTER;
      case 'DEGRADED': return MAP_TREATMENTS.PARTIAL_RASTER;
      case 'ERROR': return MAP_TREATMENTS.ERROR;
      default: return MAP_TREATMENTS.REGIONAL;
    }
  }

  function frameLocation(loc) {
    if (!boundary) { pendingLocationFrame = loc; return; }
    if (!loc) { boundary.selectCatchment(null); return; }
    if (loc.catchmentId) { boundary.selectCatchment(loc.catchmentId, { frame: true }); return; }
    // Point/area locations: framing them is a B.3 concern (need geometry); for now
    // clear the catchment selection so we don't imply a catchment hit.
    boundary.selectCatchment(null);
  }

  // ── Store subscriptions. Each returns an unsubscribe; collected for destroy().
  const unsubs = [];

  // windowResult, layers, and colourMode all feed the single raster/legend/hover
  // sync so the active raster (real or synthetic preview), the ONE legend's range
  // + badge, and the ONE hover lookup stay coherent from a single code path.
  unsubs.push(store.subscribe(select.windowResult, () => {
    syncRaster();
  }));

  unsubs.push(store.subscribe(select.location, (loc) => {
    frameLocation(loc);
  }));

  unsubs.push(store.subscribe(select.layers, (layers) => {
    syncRaster(); // honours the raster toggle (visibility) centrally
    if (boundary) boundary.setVisible(layers.catchment !== false);
  }));

  unsubs.push(store.subscribe(select.colourMode, () => {
    syncRaster();
  }));

  unsubs.push(store.subscribe(select.phase, (phase) => {
    applyTreatment(phase);
  }));

  // ── Boundary layer (async). On ready, wire click→dispatch and apply current state.
  createCatchmentBoundaryLayer(map, {
    onSelectCatchment: (catchmentId) => {
      store.dispatch(actions.setLocation({ catchmentId }));
    },
  }).then((b) => {
    boundary = b;
    hover.setCatchmentResolver(resolveCatchmentName);
    const st = store.getState();
    // Apply any state that arrived before the boundary finished loading.
    const loc = select.location(st);
    frameLocation(pendingLocationFrame || loc);
    pendingLocationFrame = null;
    boundary.setVisible(select.layers(st).catchment !== false);
    applyTreatment(select.phase(st));
  });

  // ── Apply the initial snapshot synchronously for everything not boundary-bound.
  //    syncRaster() reads the current windowResult/layers/colourMode/phase and the
  //    (not-yet-loaded) preview overlay; the preview's .then() re-runs it on load.
  {
    const st = store.getState();
    applyTreatment(select.phase(st)); // calls syncRaster() internally
  }

  function destroy() {
    for (const u of unsubs) { try { u(); } catch (_) { /* noop */ } }
    map.getContainer().removeEventListener('mousemove', onMouseMove);
    map.getContainer().removeEventListener('mouseout', onMouseOut);
    try { hover.destroy(); } catch (_) { /* noop */ }
    try { legend.destroy(); } catch (_) { /* noop */ }
    try { raster.destroy(); } catch (_) { /* noop */ }
    if (boundary) { try { boundary.destroy(); } catch (_) { /* noop */ } }
    if (typeof window !== 'undefined' && window[BRIDGE_NS] && window[BRIDGE_NS].map === map) {
      window[BRIDGE_NS].map = null;
    }
    try { map.remove(); } catch (_) { /* noop */ }
    container.classList.remove('stormgrid-maphost');
  }

  return { destroy };
}
