// overlayLoader.js — load the SYNTHETIC PREVIEW spatial overlay (docs/03 §6,
// docs/04 §3.3; DECISIONS B-009/B-010/B-012).
//
// WHY THIS EXISTS. The Lizard precomputed source (B-012) returns a
// RainfallWindowResult whose `raster` is `null`: the per-catchment
// `catchment_rainfall_*.json` carries scalar stats, no grid and no PNG. The only
// spatial surface that exists today is the SEPARATE preview overlay built offline
// by scripts/build_cumulative_overlay.py and flagged `is_synthetic_preview:true`
// (metadata.json:91). It is derived from the catchment rainfall JSON, NOT from raw
// radar frames — it is an honest stand-in, never a real radar surface.
//
// WHAT THIS RETURNS. A raster object in the docs/04 §3.3 RainfallWindowResult.raster
// shape — { pngRef, grid:{values_mm,bbox,cols,rows,...}, leafletBounds } — PLUS an
// explicit `isSyntheticPreview` honesty flag and the source metadata so the legend
// can badge it and read the real mm range. It NEVER fabricates a grid: if the
// overlay artefacts are missing or malformed it returns a clear "no overlay"
// result with `available:false` and a `reason`, and the map falls back to its
// honest "no rainfall raster for this selection" state (the host handles that).
//
// SALVAGE. The fetch + bbox/grid shape and the O(1) `hoverDepthAt` lookup are
// salvaged from src/stormgridCumulativeOverlay.js (loadCumulativeOverlay* +
// hoverDepthAt). This module re-expresses them against the contract raster shape
// the map host already consumes, so legend/hover need no special-casing.
//
// No store import, no Leaflet import. Pure async fetch + reshape.

const DEFAULT_BASE = './data/overlays/cumulative/latest/';
const META_FILE = 'metadata.json';
const GRID_FILE = 'rainfall_grid.json';

/**
 * @typedef {Object} PreviewRaster
 * @property {string} pngRef            URL of the georeferenced overlay PNG
 * @property {Object} grid              { values_mm, bbox, cols, rows, min_mm, max_mm, cell_size_deg_lon, cell_size_deg_lat }
 * @property {Array}  leafletBounds     [[s,w],[n,e]] for L.imageOverlay
 */

/**
 * @typedef {Object} OverlayLoadResult
 * @property {boolean} available        true only when a usable PNG + grid loaded
 * @property {boolean} isSyntheticPreview  carried from metadata.is_synthetic_preview
 * @property {PreviewRaster|null} raster  contract-shaped raster, or null when unavailable
 * @property {Object|null} metadata     the raw overlay metadata (window_key, stats, color_scale…)
 * @property {string|null} reason       human-readable cause when available === false
 */

function unavailable(reason, metadata = null) {
  return { available: false, isSyntheticPreview: false, raster: null, metadata, reason };
}

async function fetchJson(url) {
  // cache:'no-store' mirrors the salvaged loader — the offline build can change
  // the artefacts under the same `latest/` path between runs.
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

/**
 * Derive a defensive min/max mm over the wet (non-null) cells of the grid, so the
 * legend can label the REAL range of this surface rather than a hardcoded scale.
 * Returns { min_mm, max_mm } with nulls when there are no wet cells (all-gap grid).
 */
function deriveRange(values_mm) {
  let min = null;
  let max = null;
  if (!Array.isArray(values_mm)) return { min_mm: null, max_mm: null };
  for (const row of values_mm) {
    if (!Array.isArray(row)) continue;
    for (const v of row) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue; // null gap stays a gap
      if (min === null || v < min) min = v;
      if (max === null || v > max) max = v;
    }
  }
  return { min_mm: min, max_mm: max };
}

/**
 * Reshape the raw overlay metadata + grid into the contract raster object the map
 * host, legend, and hover readout already consume. Returns null if the grid is not
 * a usable 2-D values_mm + bbox (we never fabricate one).
 */
function toContractRaster(metadata, grid, base) {
  const bbox = grid && Array.isArray(grid.bbox) && grid.bbox.length === 4 ? grid.bbox : null;
  const values_mm = grid && Array.isArray(grid.values_mm) ? grid.values_mm : null;
  if (!bbox || !values_mm || values_mm.length === 0) return null;

  const rows = typeof grid.rows === 'number' ? grid.rows : values_mm.length;
  const cols = typeof grid.cols === 'number'
    ? grid.cols
    : (Array.isArray(values_mm[0]) ? values_mm[0].length : 0);
  if (!rows || !cols) return null;

  // Prefer the metadata's authored leaflet_bounds; else derive [[s,w],[n,e]] from bbox.
  const [w, s, e, n] = bbox;
  const leafletBounds = (metadata && Array.isArray(metadata.leaflet_bounds))
    ? metadata.leaflet_bounds
    : [[s, w], [n, e]];

  const pngRef = base + ((metadata && metadata.image_path) || 'rainfall_overlay.png');
  const range = deriveRange(values_mm);

  return {
    pngRef,
    leafletBounds,
    grid: {
      values_mm,
      bbox,
      cols,
      rows,
      // Range carried explicitly so legend.rangeFor() labels the REAL mm span
      // (it reads grid.min_mm/max_mm first; falls back to stats otherwise).
      min_mm: range.min_mm,
      max_mm: range.max_mm,
      cell_size_deg_lon: grid.cell_size_deg_lon,
      cell_size_deg_lat: grid.cell_size_deg_lat,
    },
  };
}

/**
 * Load the preview overlay from data/overlays/cumulative/latest/.
 *
 * @param {{ base?:string }} [opts]  base path (default ./data/overlays/cumulative/latest/)
 * @returns {Promise<OverlayLoadResult>}
 */
export async function loadPreviewOverlay(opts = {}) {
  const base = opts.base || DEFAULT_BASE;
  let metadata = null;
  let grid = null;

  try {
    metadata = await fetchJson(base + META_FILE);
  } catch (err) {
    return unavailable(`overlay metadata unavailable (${String((err && err.message) || err)})`);
  }
  try {
    grid = await fetchJson(base + GRID_FILE);
  } catch (err) {
    return unavailable(`overlay grid unavailable (${String((err && err.message) || err)})`, metadata);
  }

  const raster = toContractRaster(metadata, grid, base);
  if (!raster) {
    return unavailable('overlay grid is missing a usable values_mm/bbox (no grid fabricated)', metadata);
  }

  return {
    available: true,
    // Honesty flag travels from the artefact into the UI (legend badges it).
    isSyntheticPreview: !!(metadata && metadata.is_synthetic_preview),
    raster,
    metadata,
    reason: null,
  };
}
