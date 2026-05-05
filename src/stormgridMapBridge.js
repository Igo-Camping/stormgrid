/* Stormgrid v0 — map bridge.
   Read-only access to a Leaflet map instance, when one is registered.
   No imports from Stormgauge map/radar/station modules.
   No async work. Returns null when nothing is registered or when any
   probe throws — callers must handle null gracefully.

   Handshake (host page sets this before Stormgrid mounts):
     window.__stormgrid = window.__stormgrid || {};
     window.__stormgrid.map = leafletMapInstance;

   Or pass via mount option:
     mountStormgridShell(host, { map: leafletMapInstance });
*/

const NS = '__stormgrid';

function safe(fn) {
  try { return fn(); } catch (_) { return null; }
}

function ensureNs() {
  if (typeof window === 'undefined') return null;
  if (!window[NS] || typeof window[NS] !== 'object') window[NS] = {};
  return window[NS];
}

export function registerStormgridMap(mapRef) {
  const ns = ensureNs();
  if (!ns) return;
  ns.map = mapRef || null;
}

export function getStormgridMap() {
  if (typeof window === 'undefined') return null;
  const ns = window[NS];
  return (ns && ns.map) || null;
}

export function getMapBounds() {
  const map = getStormgridMap();
  if (!map || typeof map.getBounds !== 'function') return null;
  const b = safe(() => map.getBounds());
  if (!b) return null;
  const north = safe(() => (typeof b.getNorth === 'function' ? b.getNorth() : null));
  const south = safe(() => (typeof b.getSouth === 'function' ? b.getSouth() : null));
  const east  = safe(() => (typeof b.getEast  === 'function' ? b.getEast()  : null));
  const west  = safe(() => (typeof b.getWest  === 'function' ? b.getWest()  : null));
  if (![north, south, east, west].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return null;
  }
  return { north, south, east, west };
}

export function getMapCenter() {
  const map = getStormgridMap();
  if (!map || typeof map.getCenter !== 'function') return null;
  const c = safe(() => map.getCenter());
  if (!c) return null;
  const lat = safe(() => (typeof c.lat === 'number' ? c.lat : null));
  const lng = safe(() => (typeof c.lng === 'number' ? c.lng : null));
  if (typeof lat !== 'number' || typeof lng !== 'number' ||
      !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return { lat, lng };
}

export function getMapContext() {
  const bounds = getMapBounds();
  const center = getMapCenter();
  if (!bounds && !center) return null;
  return { bounds, center };
}
