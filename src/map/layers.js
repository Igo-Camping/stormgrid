// layers.js — the two map layers the rainfall workspace draws on (docs/02 §7,
// docs/03 §2 Map Layer, §6 rendering strategy).
//
// Two responsibilities, deliberately kept as separate factory functions so the
// MapStage (mapHost.js) owns the single Leaflet instance and just composes them:
//
//   createCatchmentBoundaryLayer(map, opts)
//       GeoJSON polygons (clickable -> dispatch setLocation), selected restyle,
//       fit-bounds to a chosen catchment or to all. On the POLYGON pane (z 400)
//       so clicks register.
//
//   createRainfallRasterLayer(map, opts)
//       L.imageOverlay PNG on a DEDICATED pane BELOW the polygon pane (z 350),
//       pointerEvents:'none' so hover/click pass through to the polygons and the
//       hover readout. For THIS phase it draws a PLACEHOLDER raster from
//       windowResult.raster { pngRef, leafletBounds }; if absent it draws nothing.
//       Real data fetching is the adapter + B.3, NOT here (docs/04 §4 Map layer).
//
// Z-ORDER (docs/02 §7, salvaged from stormgridCumulativeOverlay.js:26-28):
//   basemap            z 200  (CARTO light, owned by mapHost)
//   rainfall raster    z 350  (this module's dedicated pane, pointerEvents none)
//   catchment polygons z 400  (Leaflet overlayPane default — clicks land here)
// The raster sits below the polygons precisely so a click selects a catchment
// and a hover reads through to the grid. Do NOT reorder these.
//
// Leaflet is loaded globally by index.html as window.L (no import).
// This module never fetches rainfall data and never writes the store; it takes a
// dispatch callback for selection and is otherwise pure-ish DOM/Leaflet wiring.

const CATCHMENT_URL = './data/catchments/catchments_dissolved.geojson';

// Dedicated raster pane — kept distinct from the catchment overlayPane.
export const RASTER_PANE = 'stormgridRainfallRasterPane';
export const RASTER_PANE_Z = 350;       // basemap 200 < raster 350 < polygons 400
const RASTER_DEFAULT_OPACITY = 0.65;    // matches the salvaged overlay default

// Boundary styling — salvaged from stormgridCatchmentMap.js:13-15, neutralised to
// a single "selected vs not" treatment (colour modes live in legend/restyle, not
// here). The teal house colour is kept.
const STYLE_BASE = { color: '#00585b', weight: 1, opacity: 0.9, fillColor: '#00585b', fillOpacity: 0.12 };
const STYLE_UNSELECTED = { weight: 1, fillOpacity: 0.12 };
const STYLE_SELECTED = { weight: 3, fillOpacity: 0.30 };

// ── Raster layer ─────────────────────────────────────────────────────────────

function ensureRasterPane(map) {
  if (!map.getPane(RASTER_PANE)) {
    map.createPane(RASTER_PANE);
    const pane = map.getPane(RASTER_PANE);
    pane.style.zIndex = String(RASTER_PANE_Z);
    // pointerEvents:none -> mousemove/click fall through to the polygon pane so
    // the hover readout reads the grid and clicks still select a catchment.
    pane.style.pointerEvents = 'none';
  }
}

/**
 * The rainfall raster layer. Owns its own L.imageOverlay reference and swaps it
 * in place when the windowResult changes (no map re-mount).
 *
 * PLACEHOLDER-PHASE CONTRACT (docs/04 §3.3): consumes
 *   windowResult.raster = { pngRef: string, leafletBounds: [[s,w],[n,e]] }
 * Draws that PNG if present; draws nothing if windowResult or raster is absent.
 * No fetching, no grid building here — that is the adapter's job (B.3).
 *
 * @param {L.Map} map
 * @param {{opacity?:number}} [opts]
 * @returns {{ update(windowResult:Object|null):void, setVisible(v:boolean):void,
 *            setOpacity(o:number):void, destroy():void }}
 */
export function createRainfallRasterLayer(map, opts = {}) {
  if (!map || !window.L) throw new Error('Stormgrid map: Leaflet (window.L) required for raster layer.');
  ensureRasterPane(map);

  const opacity = typeof opts.opacity === 'number' ? opts.opacity : RASTER_DEFAULT_OPACITY;
  /** @type {L.ImageOverlay|null} */
  let overlay = null;
  let visible = true;
  let lastPngRef = null;

  function clear() {
    if (overlay) { map.removeLayer(overlay); overlay = null; }
    lastPngRef = null;
  }

  function update(windowResult) {
    const raster = windowResult && windowResult.raster;
    const pngRef = raster && raster.pngRef;
    const bounds = raster && raster.leafletBounds;
    if (!pngRef || !Array.isArray(bounds)) { clear(); return; }

    // Restyle/replace in place: only rebuild the overlay when the image source
    // changes; otherwise just re-assert bounds. Keeps redraws cheap.
    if (overlay && pngRef === lastPngRef) {
      if (typeof overlay.setBounds === 'function') overlay.setBounds(bounds);
      return;
    }
    clear();
    overlay = window.L.imageOverlay(pngRef, bounds, {
      pane: RASTER_PANE,
      opacity,
      interactive: false,
      crossOrigin: 'anonymous', // lets html2canvas read pixels for PNG snapshot export
    });
    lastPngRef = pngRef;
    if (visible) overlay.addTo(map);
  }

  function setVisible(v) {
    visible = Boolean(v);
    if (!overlay) return;
    if (visible && !map.hasLayer(overlay)) overlay.addTo(map);
    else if (!visible && map.hasLayer(overlay)) map.removeLayer(overlay);
  }

  function setOpacity(o) {
    if (overlay && typeof overlay.setOpacity === 'function') overlay.setOpacity(o);
  }

  return { update, setVisible, setOpacity, destroy: clear };
}

// ── Catchment boundary layer ───────────────────────────────────────────────--

/**
 * Load + render the catchment boundary polygons. Clicking a polygon calls
 * onSelectCatchment(catchmentId, feature) — the host translates that into
 * dispatch(actions.setLocation({ catchmentId })). Selection restyles in place
 * and (optionally) frames the catchment.
 *
 * @param {L.Map} map
 * @param {{ onSelectCatchment?:(id:string, feature:Object)=>void, url?:string }} [opts]
 * @returns {Promise<{
 *   layer: L.GeoJSON|null,
 *   geojson: Object|null,
 *   error: string|null,
 *   selectCatchment(id:string|null, opts?:{frame?:boolean}):void,
 *   fitAll(opts?:Object):void,
 *   setVisible(v:boolean):void,
 *   getFeatureBounds(id:string):L.LatLngBounds|null,
 *   destroy():void
 * }>}
 */
export async function createCatchmentBoundaryLayer(map, opts = {}) {
  if (!map || !window.L) throw new Error('Stormgrid map: Leaflet (window.L) required for boundary layer.');
  const onSelectCatchment = typeof opts.onSelectCatchment === 'function' ? opts.onSelectCatchment : null;
  const url = opts.url || CATCHMENT_URL;

  let geojson = null;
  let error = null;
  try {
    const r = await fetch(url, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    geojson = await r.json();
  } catch (err) {
    error = String((err && err.message) || err);
    return {
      layer: null, geojson: null, error,
      selectCatchment: () => {}, fitAll: () => {}, setVisible: () => {},
      getFeatureBounds: () => null, destroy: () => {},
    };
  }

  /** @type {Map<string, L.Layer>} */
  const layersById = new globalThis.Map();
  let selectedId = null;

  function idOf(feat) {
    return (feat && feat.properties && feat.properties.catchment_id) || null;
  }

  const layer = window.L.geoJSON(geojson, {
    style: () => ({ ...STYLE_BASE }),
    onEachFeature: (feat, lyr) => {
      const id = idOf(feat);
      if (id) layersById.set(id, lyr);
      lyr.on('click', () => {
        applySelection(id);
        if (onSelectCatchment && id) onSelectCatchment(id, feat);
      });
      lyr.bindTooltip(id || '', { className: 'stormgrid-tooltip', sticky: true });
    },
  }).addTo(map);

  function applySelection(id) {
    selectedId = id;
    layer.eachLayer((lyr) => {
      const isSel = idOf(lyr.feature) === selectedId;
      lyr.setStyle({ ...STYLE_BASE, ...(isSel ? STYLE_SELECTED : STYLE_UNSELECTED) });
      if (isSel && typeof lyr.bringToFront === 'function') lyr.bringToFront();
    });
  }

  function getFeatureBounds(id) {
    const lyr = layersById.get(id);
    if (lyr && typeof lyr.getBounds === 'function') {
      const b = lyr.getBounds();
      return b && b.isValid() ? b : null;
    }
    return null;
  }

  function fitAll(fitOpts = { padding: [20, 20] }) {
    const b = layer.getBounds();
    if (b && b.isValid()) map.fitBounds(b, fitOpts);
    else map.setView([-33.75, 151.27], 11); // regional fallback (docs/02 §3 EMPTY)
  }

  /**
   * Drive selection from store state (not from a click). frame:true fits bounds
   * to the catchment (LOCATED treatment, docs/02 §3); id:null clears selection
   * and frames the whole region (EMPTY treatment).
   */
  function selectCatchment(id, selOpts = {}) {
    applySelection(id);
    if (id == null) { fitAll(); return; }
    if (selOpts.frame) {
      const b = getFeatureBounds(id);
      if (b) map.fitBounds(b, { padding: [40, 40] });
    }
  }

  function setVisible(v) {
    if (v && !map.hasLayer(layer)) layer.addTo(map);
    else if (!v && map.hasLayer(layer)) map.removeLayer(layer);
  }

  function destroy() {
    if (map.hasLayer(layer)) map.removeLayer(layer);
    layersById.clear();
  }

  // Initial frame: whole region until a location is selected.
  fitAll();

  return { layer, geojson, error, selectCatchment, fitAll, setVisible, getFeatureBounds, destroy };
}
