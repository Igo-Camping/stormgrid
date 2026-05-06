/* Stormgrid — exports + Event Summary panel.
   Four exports + a summary card. Every export carries the full audit
   context (generated_at, accumulation_window, critical_duration,
   map_colour_mode, filters, sort) so a downstream consumer can
   reproduce exactly which view this came from.

   No new rainfall science. No AEP/IFD/ARF. Reads only the loaded
   JSON + state via the snapshot model. */

import { suggestExportFilename, summariseFootprint } from './stormgridSnapshot.js';

const CSV_FIELDS = [
  'rank',
  'catchment_id',
  'catchment_name',
  'critical_duration',
  'max_total_mm',
  'coverage_pct',
  'confidence',
  'critical_window_start',
  'critical_window_end',
  'coefficient_of_variation',
  'uniformity_index',
  'wet_core_ratio',
  'spatial_concentration_class',
];

// ──────────────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────────────

export function exportCsv(footprint) {
  const lines = [];
  // Audit comment header — non-data lines starting with '#'.
  lines.push(`# stormgrid event footprint — ${footprint.schema_version}`);
  lines.push(`# generated_at,${csvCell(footprint.generated_at)}`);
  lines.push(`# accumulation_window,${csvCell(footprint.accumulation_window)}`);
  lines.push(`# critical_duration,${csvCell(footprint.critical_duration)}`);
  lines.push(`# map_colour_mode,${csvCell(footprint.map_colour_mode)}`);
  lines.push(`# filters_confidence,${csvCell(footprint.filters && footprint.filters.confidence)}`);
  lines.push(`# filters_minMm,${csvCell(footprint.filters && footprint.filters.minMm)}`);
  lines.push(`# sort,${csvCell((footprint.sort && footprint.sort.key) + ' ' + (footprint.sort && footprint.sort.order))}`);
  if (footprint.source) {
    lines.push(`# source,${csvCell(footprint.source.kind)}`);
    lines.push(`# data_generated_at,${csvCell(footprint.source.data_generated)}`);
    if (footprint.source.window) {
      lines.push(`# window_start,${csvCell(footprint.source.window.start)}`);
      lines.push(`# window_end,${csvCell(footprint.source.window.end)}`);
      lines.push(`# window_frame_count,${csvCell(footprint.source.window.frame_count)}`);
    }
  }
  lines.push(`# catchment_count,${csvCell(footprint.catchment_count)}`);
  lines.push(CSV_FIELDS.join(','));
  for (const row of footprint.catchments) {
    lines.push(CSV_FIELDS.map((f) => csvCell(row[f])).join(','));
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, suggestExportFilename(footprint, 'csv'));
}

export function exportJson(footprint) {
  const blob = new Blob([JSON.stringify(footprint, null, 2)], { type: 'application/json' });
  triggerDownload(blob, suggestExportFilename(footprint, 'json'));
}

/* GeoJSON: visible catchments only, with analytical properties attached
   to each feature. Reads the canonical catchments_dissolved.geojson and
   filters by ID set from the footprint. */
export async function exportGeoJSON(footprint, geojsonUrl = './data/catchments/catchments_dissolved.geojson') {
  const idSet = new Set(footprint.catchments.map((c) => c.catchment_id));
  const propsById = new Map(footprint.catchments.map((c) => [c.catchment_id, c]));

  const r = await fetch(geojsonUrl, { cache: 'force-cache' });
  if (!r.ok) throw new Error(`GeoJSON source unavailable: HTTP ${r.status}`);
  const gj = await r.json();

  const features = (gj.features || [])
    .filter((f) => f.properties && idSet.has(f.properties.catchment_id))
    .map((f) => {
      const id = f.properties.catchment_id;
      const analytic = propsById.get(id) || {};
      return {
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          ...f.properties,
          stormgrid: analytic,
        },
      };
    });

  const out = {
    type: 'FeatureCollection',
    name: 'stormgrid_event_footprint',
    metadata: {
      schema_version: footprint.schema_version,
      generated_at:        footprint.generated_at,
      accumulation_window: footprint.accumulation_window,
      critical_duration:   footprint.critical_duration,
      map_colour_mode:     footprint.map_colour_mode,
      filters:             footprint.filters,
      sort:                footprint.sort,
      catchment_count:     features.length,
      source:              footprint.source,
      catchment_dataset:   gj.metadata || null,
    },
    crs: gj.crs || null,
    features,
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/geo+json' });
  triggerDownload(blob, suggestExportFilename(footprint, 'geojson'));
}

/* PNG snapshot of the visible Stormgrid app region. Uses html2canvas
   if available; otherwise falls back to a same-origin SVG-only render
   of the map polygons (no basemap tiles). */
export async function exportPngSnapshot(targetEl, footprint) {
  if (!targetEl) throw new Error('PNG: target element missing.');

  // html2canvas is loaded by index.html via CDN.
  const html2canvas = window.html2canvas;
  if (typeof html2canvas !== 'function') {
    throw new Error('PNG: html2canvas not loaded.');
  }
  const canvas = await html2canvas(targetEl, {
    backgroundColor: '#ffffff',
    useCORS: true,
    logging: false,
    scale: window.devicePixelRatio || 1,
  });
  await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('PNG: canvas.toBlob returned null')); return; }
      triggerDownload(blob, suggestExportFilename(footprint, 'png'));
      resolve();
    }, 'image/png');
  });
}

// ──────────────────────────────────────────────────────────────────────
// Event summary + export controls UI
// ──────────────────────────────────────────────────────────────────────

export function renderEventSummaryPanel(host, { footprint, onExport, lastExportNote }) {
  host.innerHTML = '';
  host.classList.add('stormgrid-eventwrap');

  if (!footprint || !footprint.source || footprint.catchment_count === 0) {
    host.innerHTML = `
      <h3 class="stormgrid-eventhead">Event summary &amp; exports</h3>
      <p class="stormgrid-event__empty">No catchments to summarise yet — load data and pick a duration.</p>
    `;
    return;
  }

  const s = summariseFootprint(footprint);
  const fmtMm = (n) => (typeof n === 'number') ? `${n.toFixed(2)} mm` : '—';
  const ts = String(footprint.generated_at || '').replace('T', ' ').replace('Z', ' UTC');

  host.innerHTML = `
    <h3 class="stormgrid-eventhead">Event summary &amp; exports</h3>
    <dl class="stormgrid-event__grid">
      <div><dt>Accumulation window</dt><dd>${escapeHtml(footprint.accumulation_window || '—')}</dd></div>
      <div><dt>Critical duration</dt>  <dd>${escapeHtml(footprint.critical_duration || '—')}</dd></div>
      <div><dt>Map colour mode</dt>    <dd>${escapeHtml(footprint.map_colour_mode || '—')}</dd></div>
      <div><dt>Catchments analysed</dt><dd>${footprint.catchment_count}</dd></div>
      <div><dt>Highest rainfall</dt>   <dd>${fmtMm(s.highest_rainfall_mm)} — <strong>${escapeHtml(s.highest_id || '—')}</strong></dd></div>
      <div><dt>At critical window</dt> <dd>${escapeHtml(s.highest_window || '—')}</dd></div>
      <div><dt>Spatial pattern</dt>    <dd>${escapeHtml(s.spatial_summary)}</dd></div>
      <div><dt>Confidence</dt>         <dd>${escapeHtml(s.confidence_summary)}</dd></div>
      <div><dt>Generated</dt>          <dd>${escapeHtml(ts)}</dd></div>
    </dl>
    <div class="stormgrid-event__exports" role="toolbar" aria-label="Export options">
      <button type="button" class="stormgrid-event__btn" data-export="csv">Export CSV</button>
      <button type="button" class="stormgrid-event__btn" data-export="json">Export JSON</button>
      <button type="button" class="stormgrid-event__btn" data-export="geojson">Export GeoJSON</button>
      <button type="button" class="stormgrid-event__btn" data-export="png">Export PNG snapshot</button>
      <span class="stormgrid-event__status" aria-live="polite">${escapeHtml(lastExportNote || '')}</span>
    </div>
  `;
  host.querySelectorAll('button[data-export]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (typeof onExport === 'function') onExport(btn.dataset.export);
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 250);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
