/* Stormgrid — catchment map.
   Thin wrapper around a Leaflet map that:
     1. Loads the catchments GeoJSON from the configured path
     2. Renders catchment polygons as a click-selectable layer
     3. Calls onSelect(catchmentId) when the user clicks a polygon

   Leaflet is loaded globally by the host page (window.L). */

const CATCHMENT_URL = './data/catchments/catchments_dissolved.geojson';

export async function mountCatchmentMap(hostEl, { onSelect, getRainfallSummary } = {}) {
  if (!window.L) {
    throw new Error('Stormgrid: Leaflet (window.L) is required.');
  }
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
    return { map, layer: null, geojson: null };
  }

  let selectedLayer = null;
  const layer = window.L.geoJSON(geojson, {
    style: () => ({
      color: '#00585b', weight: 1, opacity: 0.9, fillColor: '#00C4BE', fillOpacity: 0.18,
    }),
    onEachFeature: (feat, lyr) => {
      const id = feat.properties && feat.properties.catchment_id;
      lyr.on('click', () => {
        if (selectedLayer) selectedLayer.setStyle({ weight: 1, fillOpacity: 0.18 });
        selectedLayer = lyr;
        lyr.setStyle({ weight: 3, fillOpacity: 0.45 });
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

  return { map, layer, geojson, status };
}
