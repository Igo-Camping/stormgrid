/* Stormgrid — cumulative rainfall overlay (Phase 16).

   Loads three artefacts produced by scripts/build_cumulative_overlay.py:

     data/overlays/cumulative/latest/metadata.json      (bbox + colour scale)
     data/overlays/cumulative/latest/rainfall_grid.json (hover lookup grid)
     data/overlays/cumulative/latest/rainfall_overlay.png (Leaflet imageOverlay)

   Provides:
     - loadCumulativeOverlayMetadata / loadCumulativeOverlayGrid
     - createOverlayLayer(map, metadata, opts)  → Leaflet ImageOverlay
                                                  on a dedicated pane that
                                                  sits BELOW the catchment
                                                  polygon overlay so polygon
                                                  clicks still register.
     - hoverDepthAt(grid, lon, lat)              numeric lookup
     - renderOverlayControl(host, {…})           Off / On toggle
     - renderOverlayLegend(host, metadata, …)    legend + window/gap context

   Methodology note travels with every panel + export.
*/

const META_URL = './data/overlays/cumulative/latest/metadata.json';
const GRID_URL = './data/overlays/cumulative/latest/rainfall_grid.json';

const OVERLAY_PANE       = 'stormgridCumulativeOverlayPane';
const OVERLAY_PANE_Z     = 350;          // basemap=200, overlay polygons=400
const DEFAULT_OPACITY    = 0.65;

let cachedMeta = null;
let cachedGrid = null;

export const CUMULATIVE_OVERLAY_METHODOLOGY_NOTE =
  'Cumulative depth derived by summing the source rainfall frames inside ' +
  'the chosen window. Cells without valid samples are transparent — gaps ' +
  'are reported, never silently filled. NOT an AEP classification, NOT a ' +
  'return-period assignment, NOT a formal exceedance assertion.';

/* ────────────────────────────────────────────────────────────────────
   Loaders
   ──────────────────────────────────────────────────────────────────── */

export async function loadCumulativeOverlayMetadata(url = META_URL) {
  if (cachedMeta) return cachedMeta;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      cachedMeta = { ok: false, error: `HTTP ${r.status}`, data: null };
      return cachedMeta;
    }
    const data = await r.json();
    cachedMeta = { ok: true, error: null, data };
    return cachedMeta;
  } catch (err) {
    cachedMeta = { ok: false, error: String((err && err.message) || err), data: null };
    return cachedMeta;
  }
}

export async function loadCumulativeOverlayGrid(url = GRID_URL) {
  if (cachedGrid) return cachedGrid;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      cachedGrid = { ok: false, error: `HTTP ${r.status}`, data: null };
      return cachedGrid;
    }
    const data = await r.json();
    cachedGrid = { ok: true, error: null, data };
    return cachedGrid;
  } catch (err) {
    cachedGrid = { ok: false, error: String((err && err.message) || err), data: null };
    return cachedGrid;
  }
}

export function clearCumulativeOverlayCache() {
  cachedMeta = null;
  cachedGrid = null;
}

/* ────────────────────────────────────────────────────────────────────
   Map layer
   ──────────────────────────────────────────────────────────────────── */

function ensurePane(map) {
  if (!map.getPane(OVERLAY_PANE)) {
    map.createPane(OVERLAY_PANE);
    map.getPane(OVERLAY_PANE).style.zIndex = String(OVERLAY_PANE_Z);
    map.getPane(OVERLAY_PANE).style.pointerEvents = 'none'; // mousemove still hits map
  }
}

/**
 * Build (or refresh) the imageOverlay layer. Returns the Leaflet layer.
 * Caller is responsible for `addTo(map)` / `removeFrom(map)`.
 */
export function createOverlayLayer(map, metadata, { imageUrlBase = './data/overlays/cumulative/latest/' } = {}) {
  if (!map || !window.L || !metadata || !Array.isArray(metadata.leaflet_bounds)) return null;
  ensurePane(map);
  const url = imageUrlBase + (metadata.image_path || 'rainfall_overlay.png');
  return window.L.imageOverlay(url, metadata.leaflet_bounds, {
    pane:    OVERLAY_PANE,
    opacity: DEFAULT_OPACITY,
    interactive: false,
    crossOrigin: 'anonymous',
  });
}

/* ────────────────────────────────────────────────────────────────────
   Hover lookup
   ──────────────────────────────────────────────────────────────────── */

/**
 * Look up the cumulative depth at (lon, lat) from the JSON grid.
 * Returns:
 *   { in_bounds, has_coverage, depth_mm, cell: { row, col }, bbox, cell_size }
 */
export function hoverDepthAt(grid, lon, lat) {
  const empty = { in_bounds: false, has_coverage: false, depth_mm: null, cell: null };
  if (!grid || !Array.isArray(grid.values_mm) || !Array.isArray(grid.bbox)) return empty;
  const [w, s, e, n] = grid.bbox;
  if (!(Number.isFinite(lon) && Number.isFinite(lat))) return empty;
  if (lon < w || lon > e || lat < s || lat > n) return empty;
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor((lon - w) / (e - w) * grid.cols)));
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor((n - lat) / (n - s) * grid.rows)));
  const v = grid.values_mm[row] ? grid.values_mm[row][col] : null;
  return {
    in_bounds: true,
    has_coverage: typeof v === 'number',
    depth_mm: typeof v === 'number' ? v : null,
    cell: { row, col },
    bbox: grid.bbox,
    cell_size: { lon: grid.cell_size_deg_lon, lat: grid.cell_size_deg_lat },
  };
}

/* ────────────────────────────────────────────────────────────────────
   UI: Off / On control
   ──────────────────────────────────────────────────────────────────── */

export function renderOverlayControl(host, {
  state = 'off',
  available = true,
  disabledReason = '',
  metadata = null,
  onChange,
} = {}) {
  if (!host) return;
  host.classList.add('stormgrid-overlayctrlwrap');
  const win = (metadata && metadata.window_key) || '—';
  const isPreview = !!(metadata && metadata.is_synthetic_preview);

  host.innerHTML = `
    <div class="stormgrid-overlayctrl" role="group" aria-label="Cumulative rainfall overlay">
      <span class="stormgrid-overlayctrl__label">Cumulative rainfall overlay</span>
      <button type="button"
              class="stormgrid-overlayctrl__btn ${state === 'off' ? 'stormgrid-overlayctrl__btn--active' : ''}"
              data-state="off" aria-pressed="${state === 'off'}">Off</button>
      <button type="button"
              class="stormgrid-overlayctrl__btn ${state === 'on' ? 'stormgrid-overlayctrl__btn--active' : ''}"
              data-state="on"
              aria-pressed="${state === 'on'}"
              ${available ? '' : 'disabled aria-disabled="true" title="' + escapeAttr(disabledReason) + '"'}>On</button>
      <span class="stormgrid-overlayctrl__win">window <strong>${escapeHtml(win)}</strong>${isPreview ? ' · <em>preview</em>' : ''}</span>
      ${disabledReason ? `<span class="stormgrid-overlayctrl__hint">${escapeHtml(disabledReason)}</span>` : ''}
    </div>
  `;
  host.querySelectorAll('button[data-state]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.state;
      if (next === state) return;
      if (typeof onChange === 'function') onChange(next);
    });
  });
}

/* ────────────────────────────────────────────────────────────────────
   UI: Legend + hover readout
   ──────────────────────────────────────────────────────────────────── */

export function renderOverlayLegend(host, {
  metadata,
  loadError,
  state,
  hover,            // { in_bounds, has_coverage, depth_mm, lon, lat }
  archiveActive,    // when truthy, overlay is intentionally hidden
} = {}) {
  if (!host) return;
  host.classList.add('stormgrid-overlaylegendwrap');

  if (loadError) {
    host.innerHTML = `
      <h3 class="stormgrid-overlaylegend__head">Cumulative overlay</h3>
      <p class="stormgrid-overlaylegend__empty stormgrid-overlaylegend__empty--error">Could not load overlay: ${escapeHtml(loadError)}</p>
    `;
    return;
  }
  if (!metadata) {
    host.innerHTML = `
      <h3 class="stormgrid-overlaylegend__head">Cumulative overlay</h3>
      <p class="stormgrid-overlaylegend__empty">Loading overlay metadata…</p>
    `;
    return;
  }
  if (archiveActive) {
    host.innerHTML = `
      <h3 class="stormgrid-overlaylegend__head">Cumulative overlay</h3>
      <p class="stormgrid-overlaylegend__empty">Overlay reflects the live window only — disabled while a restored archived event is active.</p>
    `;
    return;
  }

  const stops = (metadata.color_scale && Array.isArray(metadata.color_scale.stops))
    ? metadata.color_scale.stops : [];
  const previewBanner = metadata.is_synthetic_preview ? `
    <div class="stormgrid-overlaylegend__synth" role="status">
      <strong>Preview overlay</strong> — derived from the precomputed catchment rainfall JSON, not from raw radar frames. Run
      <code>scripts/build_cumulative_overlay.py --mode real --archive PATH</code> to refresh from the Lizard archive.
    </div>
  ` : '';
  const gaps = !!metadata.gaps_present;
  const used = metadata.frame_count_used;
  const expected = metadata.frame_count_expected;
  const winStart = (metadata.window_start_utc || '').replace('T', ' ').replace('Z', ' UTC');
  const winEnd   = (metadata.window_end_utc   || '').replace('T', ' ').replace('Z', ' UTC');
  const stats = metadata.stats || {};
  const hoverHtml = (state === 'on' && hover && hover.in_bounds) ? `
    <div class="stormgrid-overlaylegend__hover" aria-live="polite">
      <strong>Hover:</strong>
      ${hover.has_coverage ? `${hover.depth_mm.toFixed(2)} mm` : 'no coverage'}
      <small>@ ${hover.lon != null ? hover.lon.toFixed(4) : '—'}, ${hover.lat != null ? hover.lat.toFixed(4) : '—'}</small>
    </div>
  ` : '';

  host.innerHTML = `
    <header class="stormgrid-overlaylegend__head-row">
      <h3 class="stormgrid-overlaylegend__head">Cumulative overlay</h3>
      <span class="stormgrid-overlaylegend__meta">${escapeHtml(metadata.mode || '')} · window <strong>${escapeHtml(metadata.window_key || '—')}</strong></span>
    </header>
    ${previewBanner}
    <dl class="stormgrid-overlaylegend__facts">
      <div><dt>Window</dt><dd>${escapeHtml(winStart)} → ${escapeHtml(winEnd)}</dd></div>
      <div><dt>Frames</dt><dd>${used ?? '—'} / ${expected ?? '—'}${gaps ? ' · <span class="stormgrid-overlaylegend__gap">gaps present</span>' : ''}</dd></div>
      <div><dt>Depth (wet cells)</dt><dd>${formatRange(stats.depth_min_mm, stats.depth_max_mm)} · mean ${formatMm(stats.depth_mean_mm)}</dd></div>
    </dl>
    <div class="stormgrid-overlaylegend__bar">
      ${stops.map((s) => `
        <span class="stormgrid-overlaylegend__bar-stop"
              title="${escapeAttr(`${s.depth_mm} mm`)}"
              style="background: rgba(${(s.rgba || []).slice(0, 3).join(',')}, ${(s.rgba && s.rgba[3] != null) ? (s.rgba[3] / 255).toFixed(2) : 1})">${escapeHtml(`${s.depth_mm}mm`)}</span>
      `).join('')}
    </div>
    ${hoverHtml}
    <p class="stormgrid-overlaylegend__safety">${escapeHtml(CUMULATIVE_OVERLAY_METHODOLOGY_NOTE)}</p>
  `;
}

/* ────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────── */

function formatMm(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? `${v.toFixed(2)} mm` : '—';
}
function formatRange(lo, hi) {
  if (typeof lo !== 'number' || typeof hi !== 'number') return '—';
  return `${lo.toFixed(2)} – ${hi.toFixed(2)} mm`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
