/* Stormgrid — catchment map.
   Loads the catchments GeoJSON, renders polygons, reports clicks via
   onSelect. Exports applyConfidenceStyling() so the orchestrator can
   recolour catchments by confidence after the rainfall JSON loads.
   Leaflet is loaded globally by the host page (window.L). */

const CATCHMENT_URL = './data/catchments/catchments_dissolved.geojson';

const STYLE_BASE        = { color: '#00585b', weight: 1, opacity: 0.9, fillOpacity: 0.18 };
const STYLE_SELECTED    = { weight: 3, fillOpacity: 0.45 };
const STYLE_UNSELECTED  = { weight: 1, fillOpacity: 0.18 };

// Colour palette for confidence levels — chosen to coexist with the
// teal Stormgrid accent without clashing.
const CONFIDENCE_FILLS = {
  high:        '#3CB371',  // medium sea-green
  medium:      '#E0A030',  // amber
  low:         '#C0392B',  // red
  unknown:     '#9AA5B1',  // grey
  unavailable: '#9AA5B1',
};
const CONFIDENCE_STROKES = {
  high:        '#1E6B43',
  medium:      '#7A5A0F',
  low:         '#7A2018',
  unknown:     '#4A5560',
  unavailable: '#4A5560',
};

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
  }).addTo(map);

  // Map legend
  const legend = window.L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const el = window.L.DomUtil.create('div', 'stormgrid-maplegend');
    el.innerHTML = `
      <strong>Confidence</strong>
      <span class="stormgrid-maplegend__row"><i style="background:${CONFIDENCE_FILLS.high}"></i>High</span>
      <span class="stormgrid-maplegend__row"><i style="background:${CONFIDENCE_FILLS.medium}"></i>Medium</span>
      <span class="stormgrid-maplegend__row"><i style="background:${CONFIDENCE_FILLS.low}"></i>Low</span>
      <span class="stormgrid-maplegend__row"><i style="background:${CONFIDENCE_FILLS.unknown}"></i>Unavailable</span>
    `;
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
    return { map, layer: null, geojson: null, status };
  }

  let selectedLayer = null;
  // We hold the per-feature confidence style in a side-table so re-styling
  // (after rainfall data arrives) doesn't trample selection state.
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

  return { map, layer, geojson, status, baseStyleByFeature, getSelectedLayer: () => selectedLayer };
}

/* Re-style the layer's polygons by per-catchment confidence (from
   rainfall data). Also rebinds tooltips with rainfall summary, coverage,
   and the selected critical-duration result if duration_stats is present.
   Safe to call multiple times — preserves selected state. */
export function applyConfidenceStyling(handle, rainfallData, opts = {}) {
  if (!handle || !handle.layer) return;
  const { layer, baseStyleByFeature, getSelectedLayer } = handle;
  const lastBuilt = (rainfallData && rainfallData.generated_at) || null;
  const catchments = (rainfallData && rainfallData.catchments) || {};
  const selectedLayer = getSelectedLayer ? getSelectedLayer() : null;
  const selectedDuration = (opts && opts.selectedDuration) || null;

  layer.eachLayer((lyr) => {
    const feat = lyr.feature;
    const id = feat.properties && feat.properties.catchment_id;
    const row = id ? catchments[id] : null;

    let confidence = 'unknown';
    if (row && typeof row.confidence === 'string') confidence = row.confidence;
    const fill = CONFIDENCE_FILLS[confidence] || CONFIDENCE_FILLS.unknown;
    const stroke = CONFIDENCE_STROKES[confidence] || CONFIDENCE_STROKES.unknown;

    if (baseStyleByFeature) {
      baseStyleByFeature.set(feat, { fillColor: fill, color: stroke, confidence });
    }

    const isSelected = selectedLayer === lyr;
    lyr.setStyle({
      ...STYLE_BASE,
      ...(isSelected ? STYLE_SELECTED : STYLE_UNSELECTED),
      fillColor: fill,
      color: stroke,
    });

    // Tooltip: id + window summary + critical-duration block if available
    const lines = [`<strong>${escapeHtml(id || '')}</strong>`];
    if (row) {
      const fmt = (n) => (typeof n === 'number') ? `${n.toFixed(2)} mm` : '—';
      const cov = (typeof row.coverage_pct === 'number')
        ? `${row.coverage_pct.toFixed(1)}%`
        : (typeof row.coverage_fraction === 'number')
          ? `${(row.coverage_fraction * 100).toFixed(1)}%`
          : '—';
      lines.push(`Window total: ${fmt(row.total_mm)}`);
      lines.push(`Window cov: ${cov} · ${escapeHtml(confidence.toUpperCase())}`);
      if (typeof row.frames_used === 'number') {
        lines.push(`Frames: ${row.frames_used} / ${row.frame_count}`);
      }
      // Critical duration block
      const dstat = (selectedDuration && row.duration_stats)
        ? row.duration_stats[selectedDuration]
        : null;
      if (selectedDuration && dstat) {
        const dconf = String(dstat.confidence || 'unknown').toLowerCase();
        const dcov = (typeof dstat.coverage_pct === 'number')
          ? `${dstat.coverage_pct.toFixed(1)}%` : '—';
        lines.push(`<hr style="margin:3px 0;border:0;border-top:1px solid rgba(255,255,255,0.25)">`);
        lines.push(`Critical ${escapeHtml(selectedDuration)}: ${fmt(dstat.max_total_mm)}`);
        lines.push(`@ ${escapeHtml(String(dstat.window_start).slice(0, 16).replace('T', ' '))} UTC`);
        lines.push(`Cov: ${dcov} · ${escapeHtml(dconf.toUpperCase())}`);
      } else if (selectedDuration) {
        lines.push(`Critical ${escapeHtml(selectedDuration)}: —`);
      }
      if (lastBuilt) lines.push(`<small>Built ${escapeHtml(String(lastBuilt).replace('T',' ').replace('Z',' UTC'))}</small>`);
    } else {
      lines.push('No precomputed data');
    }
    lyr.unbindTooltip();
    lyr.bindTooltip(lines.join('<br>'), { className: 'stormgrid-tooltip', sticky: true });
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
