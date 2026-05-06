/* Stormgrid — catchment map.
   Loads the catchments GeoJSON, renders polygons, reports clicks via
   onSelect. Exports applyConfidenceStyling() (kept name for stability)
   so the orchestrator can recolour catchments in three modes:
     - confidence         (default; high/medium/low/grey)
     - criticalRainfall   (light → dark teal by max_total_mm)
     - spatialVariability (CV bucket: uniform/moderate/concentrated/high)
   Legend updates dynamically. Selected & hover styling preserved in
   every mode. Leaflet is loaded globally by the host page (window.L). */

const CATCHMENT_URL = './data/catchments/catchments_dissolved.geojson';

const STYLE_BASE       = { color: '#00585b', weight: 1, opacity: 0.9, fillOpacity: 0.18 };
const STYLE_SELECTED   = { weight: 3, fillOpacity: 0.55 };
const STYLE_UNSELECTED = { weight: 1, fillOpacity: 0.45 };

// Mode 1 — confidence palette
const CONFIDENCE_FILLS = {
  high:        '#3CB371',
  medium:      '#E0A030',
  low:         '#C0392B',
  unknown:     '#9AA5B1',
  unavailable: '#9AA5B1',
};
const CONFIDENCE_STROKES = {
  high:        '#1E6B43',
  medium:      '#7A5A0F',
  low:         '#7A2018',
  unknown:     '#4A5560',
  unavailable: '#4A5560',
};

// Mode 2 — critical-duration rainfall: sequential single-hue (no red).
const RAIN_LIGHT = '#f5fafb';
const RAIN_DARK  = '#00585b';
const RAIN_STROKE = '#003a3c';

// Mode 3 — spatial variability (CV) buckets.
// Same thresholds as the spatial_concentration_class.
const CV_BUCKETS = [
  { max: 0.25,      key: 'uniform',             fill: '#3CB371', stroke: '#1E6B43', label: 'Uniform · CV<0.25' },
  { max: 0.50,      key: 'moderate',            fill: '#E0A030', stroke: '#7A5A0F', label: 'Moderate · 0.25–0.5' },
  { max: 1.00,      key: 'concentrated',        fill: '#C0773A', stroke: '#7A4218', label: 'Concentrated · 0.5–1.0' },
  { max: Infinity,  key: 'highly-concentrated', fill: '#C0392B', stroke: '#7A2018', label: 'Highly concentrated · ≥1.0' },
];
const CV_UNAVAILABLE = { fill: '#9AA5B1', stroke: '#4A5560' };

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function mixHex(a, b, f) {
  const parse = (h) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  };
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const r = Math.round(ar + (br - ar) * f);
  const g = Math.round(ag + (bg - ag) * f);
  const b2 = Math.round(ab + (bb - ab) * f);
  return '#' + ((r << 16) | (g << 8) | b2).toString(16).padStart(6, '0');
}

function bucketForCv(cv) {
  if (cv == null || !Number.isFinite(cv)) return null;
  for (const b of CV_BUCKETS) if (cv < b.max) return b;
  return CV_BUCKETS[CV_BUCKETS.length - 1];
}

function styleForCatchment(row, mode, ctx) {
  // Returns {fill, stroke, confidence}.
  if (!row) {
    return { fill: CONFIDENCE_FILLS.unknown, stroke: CONFIDENCE_STROKES.unknown, confidence: 'unknown' };
  }
  const conf = String(row.confidence || 'unknown').toLowerCase();

  if (mode === 'criticalRainfall') {
    const ds = ctx.selectedDuration && row.duration_stats
      ? row.duration_stats[ctx.selectedDuration]
      : null;
    const v = ds && typeof ds.max_total_mm === 'number' ? ds.max_total_mm : null;
    if (v == null || ctx.rainMin == null || ctx.rainMax == null || ctx.rainMax === ctx.rainMin) {
      // No duration data, or no spread — render greyscale-ish fallback at low opacity.
      const fb = (v == null) ? CV_UNAVAILABLE : { fill: RAIN_DARK, stroke: RAIN_STROKE };
      return { fill: fb.fill, stroke: fb.stroke, confidence: conf };
    }
    const t = (v - ctx.rainMin) / (ctx.rainMax - ctx.rainMin);
    return { fill: mixHex(RAIN_LIGHT, RAIN_DARK, Math.max(0, Math.min(1, t))), stroke: RAIN_STROKE, confidence: conf };
  }

  if (mode === 'spatialVariability') {
    const ds = ctx.selectedDuration && row.duration_stats
      ? row.duration_stats[ctx.selectedDuration]
      : null;
    const cv = ds && ds.spatial_metrics && typeof ds.spatial_metrics.coefficient_of_variation === 'number'
      ? ds.spatial_metrics.coefficient_of_variation : null;
    const b = bucketForCv(cv);
    if (!b) return { fill: CV_UNAVAILABLE.fill, stroke: CV_UNAVAILABLE.stroke, confidence: conf };
    return { fill: b.fill, stroke: b.stroke, confidence: conf };
  }

  // default: confidence
  return {
    fill:   CONFIDENCE_FILLS[conf]   || CONFIDENCE_FILLS.unknown,
    stroke: CONFIDENCE_STROKES[conf] || CONFIDENCE_STROKES.unknown,
    confidence: conf,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Mount
// ──────────────────────────────────────────────────────────────────────

export async function mountCatchmentMap(hostEl, { onSelect } = {}) {
  if (!window.L) throw new Error('Stormgrid: Leaflet (window.L) is required.');
  hostEl.innerHTML = '';
  hostEl.classList.add('stormgrid-mapwrap');

  const mapEl = document.createElement('div');
  mapEl.className = 'stormgrid-map';
  mapEl.setAttribute('aria-label', 'Catchment selection map');
  hostEl.appendChild(mapEl);

  const map = window.L.map(mapEl, { zoomControl: true, attributionControl: true });
  window.L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap, &copy; CARTO',
    crossOrigin: 'anonymous',  // allows html2canvas to read tile pixels for PNG snapshot
  }).addTo(map);

  const legend = window.L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const el = window.L.DomUtil.create('div', 'stormgrid-maplegend');
    el.innerHTML = renderLegendHtml('confidence', null);
    return el;
  };
  legend.addTo(map);

  const status = document.createElement('div');
  status.className = 'stormgrid-mapstatus';
  status.textContent = 'Loading catchments…';
  hostEl.appendChild(status);

  let geojson = null;
  try {
    const r = await fetch(CATCHMENT_URL, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    geojson = await r.json();
  } catch (err) {
    status.textContent = `Could not load catchments: ${err.message}`;
    status.classList.add('stormgrid-mapstatus--error');
    map.setView([-33.75, 151.27], 11);
    return { map, layer: null, geojson: null, status, legend };
  }

  let selectedLayer = null;
  const baseStyleByFeature = new WeakMap();

  const layer = window.L.geoJSON(geojson, {
    style: () => ({ ...STYLE_BASE, fillColor: CONFIDENCE_FILLS.unknown, color: CONFIDENCE_STROKES.unknown }),
    onEachFeature: (feat, lyr) => {
      const id = feat.properties && feat.properties.catchment_id;
      baseStyleByFeature.set(feat, {
        fillColor: CONFIDENCE_FILLS.unknown,
        color: CONFIDENCE_STROKES.unknown,
        confidence: 'unknown',
      });
      lyr.on('click', () => {
        if (selectedLayer && selectedLayer !== lyr) {
          const s = baseStyleByFeature.get(selectedLayer.feature) || baseStyleByFeature.get(feat);
          selectedLayer.setStyle({
            ...STYLE_BASE,
            ...STYLE_UNSELECTED,
            fillColor: s.fillColor,
            color: s.color,
          });
        }
        selectedLayer = lyr;
        const own = baseStyleByFeature.get(feat) || {};
        lyr.setStyle({
          ...STYLE_BASE,
          ...STYLE_SELECTED,
          fillColor: own.fillColor,
          color: own.color,
        });
        if (onSelect) onSelect(id, feat);
      });
      lyr.bindTooltip(id, { className: 'stormgrid-tooltip', sticky: true });
    },
  }).addTo(map);

  if (layer.getBounds().isValid()) {
    map.fitBounds(layer.getBounds(), { padding: [20, 20] });
  } else {
    map.setView([-33.75, 151.27], 11);
  }
  status.textContent = `${(geojson.features || []).length} catchments — click one to select`;

  return { map, layer, geojson, status, legend, baseStyleByFeature, getSelectedLayer: () => selectedLayer };
}

// ──────────────────────────────────────────────────────────────────────
// Apply styling (multi-mode). Function name kept for back-compat.
// ──────────────────────────────────────────────────────────────────────

export function applyConfidenceStyling(handle, rainfallData, opts = {}) {
  if (!handle || !handle.layer) return;
  const { layer, baseStyleByFeature, getSelectedLayer, legend } = handle;
  const lastBuilt = (rainfallData && rainfallData.generated_at) || null;
  const catchments = (rainfallData && rainfallData.catchments) || {};
  const selectedLayer = getSelectedLayer ? getSelectedLayer() : null;
  const selectedDuration = (opts && opts.selectedDuration) || null;
  const mode = (opts && opts.mode) || 'confidence';

  // For criticalRainfall mode: derive min/max max_total_mm across all
  // catchments that have data for the selected duration.
  let rainMin = null, rainMax = null;
  if (mode === 'criticalRainfall' && selectedDuration) {
    for (const row of Object.values(catchments)) {
      const ds = row && row.duration_stats && row.duration_stats[selectedDuration];
      const v = ds && typeof ds.max_total_mm === 'number' ? ds.max_total_mm : null;
      if (v == null) continue;
      if (rainMin == null || v < rainMin) rainMin = v;
      if (rainMax == null || v > rainMax) rainMax = v;
    }
  }
  const ctx = { selectedDuration, rainMin, rainMax };

  layer.eachLayer((lyr) => {
    const feat = lyr.feature;
    const id = feat.properties && feat.properties.catchment_id;
    const row = id ? catchments[id] : null;

    const style = styleForCatchment(row, mode, ctx);

    if (baseStyleByFeature) {
      baseStyleByFeature.set(feat, {
        fillColor: style.fill,
        color: style.stroke,
        confidence: style.confidence,
      });
    }

    const isSelected = selectedLayer === lyr;
    lyr.setStyle({
      ...STYLE_BASE,
      ...(isSelected ? STYLE_SELECTED : STYLE_UNSELECTED),
      fillColor: style.fill,
      color: style.stroke,
    });

    // Tooltip — keep all fields, regardless of colour mode.
    const lines = [`<strong>${escapeHtml(id || '')}</strong>`];
    if (row) {
      const fmt = (n) => (typeof n === 'number') ? `${n.toFixed(2)} mm` : '—';
      const cov = (typeof row.coverage_pct === 'number')
        ? `${row.coverage_pct.toFixed(1)}%`
        : (typeof row.coverage_fraction === 'number')
          ? `${(row.coverage_fraction * 100).toFixed(1)}%`
          : '—';
      lines.push(`Window total: ${fmt(row.total_mm)}`);
      lines.push(`Window cov: ${cov} · ${escapeHtml(String(style.confidence).toUpperCase())}`);
      if (typeof row.frames_used === 'number') {
        lines.push(`Frames: ${row.frames_used} / ${row.frame_count}`);
      }
      const dstat = (selectedDuration && row.duration_stats) ? row.duration_stats[selectedDuration] : null;
      if (selectedDuration && dstat) {
        const dconf = String(dstat.confidence || 'unknown').toLowerCase();
        const dcov = (typeof dstat.coverage_pct === 'number') ? `${dstat.coverage_pct.toFixed(1)}%` : '—';
        lines.push(`<hr style="margin:3px 0;border:0;border-top:1px solid rgba(255,255,255,0.25)">`);
        lines.push(`Critical ${escapeHtml(selectedDuration)}: ${fmt(dstat.max_total_mm)}`);
        lines.push(`@ ${escapeHtml(String(dstat.window_start).slice(0, 16).replace('T', ' '))} UTC`);
        lines.push(`Cov: ${dcov} · ${escapeHtml(dconf.toUpperCase())}`);
        const sm = dstat.spatial_metrics;
        if (sm) {
          const cv = (typeof sm.coefficient_of_variation === 'number') ? sm.coefficient_of_variation.toFixed(2) : '—';
          const wc = (typeof sm.wet_core_ratio === 'number') ? sm.wet_core_ratio.toFixed(2) : '—';
          const cls = sm.spatial_concentration_class || '—';
          lines.push(`Spatial: CV ${cv} · Wet-core ${wc}`);
          lines.push(`<em>${escapeHtml(cls)}</em>`);
        }
      } else if (selectedDuration) {
        lines.push(`Critical ${escapeHtml(selectedDuration)}: —`);
      }
      if (lastBuilt) lines.push(`<small>Built ${escapeHtml(String(lastBuilt).replace('T', ' ').replace('Z', ' UTC'))}</small>`);
    } else {
      lines.push('No precomputed data');
    }
    lyr.unbindTooltip();
    lyr.bindTooltip(lines.join('<br>'), { className: 'stormgrid-tooltip', sticky: true });
  });

  // Update legend in place.
  if (legend && typeof legend.getContainer === 'function') {
    const el = legend.getContainer();
    if (el) el.innerHTML = renderLegendHtml(mode, { rainMin, rainMax });
  }
}

function renderLegendHtml(mode, ctx) {
  if (mode === 'criticalRainfall') {
    const minV = ctx && Number.isFinite(ctx.rainMin) ? ctx.rainMin : null;
    const maxV = ctx && Number.isFinite(ctx.rainMax) ? ctx.rainMax : null;
    const range = (minV != null && maxV != null)
      ? `${minV.toFixed(2)} – ${maxV.toFixed(2)} mm`
      : 'no data';
    return `
      <strong>Critical-duration rainfall</strong>
      <div class="stormgrid-maplegend__bar"
           style="background:linear-gradient(to right, ${RAIN_LIGHT}, ${RAIN_DARK})"></div>
      <div class="stormgrid-maplegend__bar-labels">
        <span>${escapeHtml(minV != null ? `${minV.toFixed(2)} mm` : 'min')}</span>
        <span>${escapeHtml(maxV != null ? `${maxV.toFixed(2)} mm` : 'max')}</span>
      </div>
      <small class="stormgrid-maplegend__range">${escapeHtml(range)}</small>
    `;
  }
  if (mode === 'spatialVariability') {
    return `
      <strong>Spatial variability (CV)</strong>
      ${CV_BUCKETS.map((b) => `
        <span class="stormgrid-maplegend__row">
          <i style="background:${b.fill}"></i>${escapeHtml(b.label)}
        </span>
      `).join('')}
      <span class="stormgrid-maplegend__row">
        <i style="background:${CV_UNAVAILABLE.fill}"></i>Unavailable
      </span>
    `;
  }
  // default: confidence
  return `
    <strong>Data confidence</strong>
    <span class="stormgrid-maplegend__row"><i style="background:${CONFIDENCE_FILLS.high}"></i>High</span>
    <span class="stormgrid-maplegend__row"><i style="background:${CONFIDENCE_FILLS.medium}"></i>Medium</span>
    <span class="stormgrid-maplegend__row"><i style="background:${CONFIDENCE_FILLS.low}"></i>Low</span>
    <span class="stormgrid-maplegend__row"><i style="background:${CONFIDENCE_FILLS.unknown}"></i>Unavailable</span>
  `;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
