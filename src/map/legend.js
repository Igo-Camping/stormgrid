// legend.js — THE single map legend (docs/02 §7, §11; docs/03 §2 MapLegend).
//
// CONSOLIDATION: the current app has TWO legends — the Leaflet control legend in
// stormgridCatchmentMap.js (confidence / criticalRainfall / spatialVariability
// palettes) and the overlay legend rendered into a side panel by
// stormgridCumulativeOverlay.js (renderOverlayLegend, the colour-scale bar). This
// module replaces BOTH with one Leaflet control anchored bottom-right.
//
// It binds its colour stops and mm range to the LIVE data from the active raster
// when present (docs/04 §3.3: raster.grid + stats), not to hardcoded values, and
// it swaps content by colourMode ('rainfall' | 'confidence' | 'spatialVariability',
// store.COLOUR_MODES). With no raster it shows an honest "no rainfall raster for
// this selection" state — never a blank-but-settled scale.
//
// SYNTHETIC-PREVIEW HONESTY (DECISIONS B-012, docs/04 §3.3 warnings): the precomputed
// Lizard windowResult.raster is null today, so the map falls back to the SYNTHETIC
// PREVIEW overlay (overlayLoader.js, is_synthetic_preview:true). When that is the
// source, the legend carries `isSyntheticPreview:true` and renders a clear badge so
// the surface is never mistaken for a real radar/observed raster.
//
// TIME-SCRUBBER READINESS (docs/02 §7): the legend is parameterised by a `frame`
// descriptor — { kind:'window' } for the accumulated window (today) or
// { kind:'frame', index, iso } for a single frame once the scrubber lands. Range
// derivation reads whichever the caller passes, so adding the scrubber later
// requires no change here — only a different `frame` argument.
//
// Leaflet global window.L. No store import; the host pushes state via update().

// Rainfall ramp (single-hue teal, no red) — salvaged intent from
// stormgridCatchmentMap.js RAIN_LIGHT/RAIN_DARK and the overlay colour scale.
const RAIN_LIGHT = '#f5fafb';
const RAIN_DARK = '#00585b';

const CONFIDENCE_FILLS = Object.freeze({
  high: '#3CB371', moderate: '#E0A030', low: '#C0392B', unavailable: '#9AA5B1',
});

const CV_BUCKETS = Object.freeze([
  { label: 'Uniform · CV<0.25', fill: '#3CB371' },
  { label: 'Moderate · 0.25–0.5', fill: '#E0A030' },
  { label: 'Concentrated · 0.5–1.0', fill: '#C0773A' },
  { label: 'Highly concentrated · ≥1.0', fill: '#C0392B' },
]);

/**
 * Derive the mm range to label from the active raster + window result, honouring
 * the active frame descriptor. The raster may be the real windowResult.raster or
 * the synthetic preview overlay — its grid carries the authoritative min/max.
 * Today only the accumulated window is available; per-frame ranges plug in here
 * when the scrubber arrives (the grid would carry per-frame planes, or the adapter
 * would hand a frame-scoped grid) — the `frame` parameter is the seam.
 *
 * @param {Object|null} raster        contract raster ({ grid, pngRef, leafletBounds }) or null
 * @param {Object|null} windowResult  for stats fallback (minCell/maxCell)
 * @param {{kind:'window'|'frame', index?:number, iso?:string}} frame
 * @returns {{ min:number|null, max:number|null }}
 */
function rangeFor(raster, windowResult, frame) {
  // frame is reserved: a per-frame implementation would index a frame plane here.
  void frame;
  // Prefer the active raster grid's explicit min/max (real or preview).
  const grid = raster && raster.grid;
  if (grid && typeof grid.min_mm === 'number' && typeof grid.max_mm === 'number') {
    return { min: grid.min_mm, max: grid.max_mm };
  }
  // Then the windowResult stats min/max cell (ArealRainfall.mm).
  const stats = (windowResult && windowResult.stats) || {};
  const minV = stats.minCell && typeof stats.minCell.mm === 'number' ? stats.minCell.mm : null;
  const maxV = stats.maxCell && typeof stats.maxCell.mm === 'number' ? stats.maxCell.mm : null;
  return { min: minV, max: maxV };
}

function fmtMm(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? `${v.toFixed(1)} mm` : '—';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The honesty badge for the synthetic preview overlay (DECISIONS B-012). Rendered
// inside the rainfall legend whenever the active raster is the preview surface, so
// the depth scale is never read as a real radar/observed product.
function previewBadgeHtml(previewMeta) {
  const win = previewMeta && previewMeta.window_key ? ` · window ${escapeHtml(previewMeta.window_key)}` : '';
  return `
    <div class="stormgrid-legend__synth" role="status">
      <strong>Synthetic preview</strong>${win}
      <span>Derived from the precomputed catchment rainfall — not a real radar surface.</span>
    </div>
  `;
}

function rainfallHtml(range, opts = {}) {
  const { hasRaster = false, isSyntheticPreview = false, previewMeta = null } = opts;
  // No raster at all: honest empty state, never a settled-looking blank scale.
  if (!hasRaster) {
    return `
      <strong class="stormgrid-legend__title">Rainfall depth</strong>
      <p class="stormgrid-legend__empty">No rainfall raster for this selection.</p>
    `;
  }
  const haveRange = range.min != null && range.max != null;
  const rangeLabel = haveRange ? `${range.min.toFixed(1)} – ${range.max.toFixed(1)} mm` : 'range unavailable';
  return `
    <strong class="stormgrid-legend__title">Rainfall depth</strong>
    ${isSyntheticPreview ? previewBadgeHtml(previewMeta) : ''}
    <div class="stormgrid-legend__bar" style="background:linear-gradient(to right, ${RAIN_LIGHT}, ${RAIN_DARK})"></div>
    <div class="stormgrid-legend__bar-labels">
      <span>${escapeHtml(fmtMm(range.min))}</span>
      <span>${escapeHtml(fmtMm(range.max))}</span>
    </div>
    <small class="stormgrid-legend__range">${escapeHtml(rangeLabel)}</small>
  `;
}

function confidenceHtml() {
  return `
    <strong class="stormgrid-legend__title">Data confidence</strong>
    <span class="stormgrid-legend__row"><i style="background:${CONFIDENCE_FILLS.high}"></i>High</span>
    <span class="stormgrid-legend__row"><i style="background:${CONFIDENCE_FILLS.moderate}"></i>Moderate</span>
    <span class="stormgrid-legend__row"><i style="background:${CONFIDENCE_FILLS.low}"></i>Low</span>
    <span class="stormgrid-legend__row"><i style="background:${CONFIDENCE_FILLS.unavailable}"></i>Unavailable</span>
  `;
}

function spatialHtml() {
  return `
    <strong class="stormgrid-legend__title">Spatial variability (CV)</strong>
    ${CV_BUCKETS.map((b) => `<span class="stormgrid-legend__row"><i style="background:${b.fill}"></i>${escapeHtml(b.label)}</span>`).join('')}
    <span class="stormgrid-legend__row"><i style="background:${CONFIDENCE_FILLS.unavailable}"></i>Unavailable</span>
  `;
}

function bodyFor(colourMode, state) {
  switch (colourMode) {
    case 'confidence': return confidenceHtml();
    case 'spatialVariability': return spatialHtml();
    case 'rainfall':
    default:
      return rainfallHtml(rangeFor(state.raster, state.windowResult, state.frame), {
        hasRaster: !!state.raster,
        isSyntheticPreview: !!state.isSyntheticPreview,
        previewMeta: state.previewMeta,
      });
  }
}

/**
 * Create the single legend control and add it to the map (bottom-right).
 *
 * @param {L.Map} map
 * @returns {{
 *   update(args:{ colourMode?:string, windowResult?:Object|null, raster?:Object|null,
 *                 isSyntheticPreview?:boolean, previewMeta?:Object|null,
 *                 frame?:{kind:'window'|'frame', index?:number, iso?:string} }):void,
 *   setVisible(v:boolean):void,
 *   destroy():void
 * }}
 */
export function createLegend(map) {
  if (!map || !window.L) throw new Error('Stormgrid map: Leaflet (window.L) required for legend.');

  const state = {
    colourMode: 'rainfall',
    windowResult: null,
    raster: null,              // the ACTIVE raster (real windowResult.raster OR preview)
    isSyntheticPreview: false, // badge when the active raster is the preview overlay
    previewMeta: null,         // preview overlay metadata (window_key, etc.) for the badge
    frame: { kind: 'window' }, // accumulated window today; scrubber swaps later
  };
  let visible = true;

  const control = window.L.control({ position: 'bottomright' });
  let el = null;

  control.onAdd = () => {
    el = window.L.DomUtil.create('div', 'stormgrid-legend');
    render();
    return el;
  };
  control.addTo(map);

  function render() {
    if (!el) return;
    el.innerHTML = bodyFor(state.colourMode, state);
    el.style.display = visible ? '' : 'none';
  }

  function update(args = {}) {
    if (typeof args.colourMode === 'string') state.colourMode = args.colourMode;
    if ('windowResult' in args) state.windowResult = args.windowResult || null;
    if ('raster' in args) state.raster = args.raster || null;
    if ('isSyntheticPreview' in args) state.isSyntheticPreview = !!args.isSyntheticPreview;
    if ('previewMeta' in args) state.previewMeta = args.previewMeta || null;
    if (args.frame) state.frame = args.frame; // reserved for the time-scrubber
    render();
  }

  function setVisible(v) { visible = Boolean(v); render(); }

  function destroy() {
    if (typeof control.remove === 'function') control.remove();
    else map.removeControl(control);
    el = null;
  }

  return { update, setVisible, destroy };
}
