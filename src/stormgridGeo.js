/* Stormgrid — geo helpers (Phase 12).
   Pure functions for haversine + ray-cast point-in-polygon and catchment
   lookup from a (lon, lat) address result. No DOM, no fetches.

   Deliberate scope: this is a *non-authoritative* geometric assist for the
   address-first workflow. The catchments GeoJSON itself is flagged
   `is_authoritative: false`; the point-in-polygon answer below is at best
   "the polygon that geometrically contains this lon/lat per the raster-
   derived boundaries". Confidence reflects that — see findCatchmentForPoint.
*/

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance between two lon/lat points, in kilometres. */
export function haversineKm(lon1, lat1, lon2, lat2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Standard ray-cast — works in lon/lat directly because over a single
    catchment-sized region the projection distortion is negligible for a
    yes/no membership test. ring is [[lon,lat], ...]. */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat))
      && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** True if the point falls inside the feature's geometry (Polygon or
    MultiPolygon). Holes are honoured. */
export function pointInFeature(lon, lat, feature) {
  if (!feature || !feature.geometry) return false;
  const g = feature.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates]
              : g.type === 'MultiPolygon' ? g.coordinates
              : null;
  if (!polys) return false;
  for (const poly of polys) {
    if (!poly || poly.length === 0) continue;
    const outer = poly[0];
    if (!pointInRing(lon, lat, outer)) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lon, lat, poly[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * Locate the catchment that geometrically contains (lon, lat); fall back
 * to the nearest centroid when the point lies outside every polygon.
 *
 * Returns:
 *   { feature, id, confidence, reason, distance_km, nearestId }
 *
 * Confidence:
 *   'high'    — point is inside a catchment polygon
 *   'medium'  — outside all polygons but within nearProximityKm of a centroid
 *   'low'     — outside all polygons and beyond nearProximityKm
 *   'unknown' — geojson missing or empty
 *
 * `feature` is null when nothing is in nearProximityKm OR when the geojson
 * itself is empty.
 */
export function findCatchmentForPoint(lon, lat, geojson, opts = {}) {
  const nearKm = typeof opts.nearProximityKm === 'number' ? opts.nearProximityKm : 5;
  if (!geojson || !Array.isArray(geojson.features) || geojson.features.length === 0) {
    return { feature: null, id: null, confidence: 'unknown', reason: 'No catchment polygons loaded.', distance_km: null, nearestId: null };
  }
  // 1) Hit-test
  for (const feat of geojson.features) {
    if (pointInFeature(lon, lat, feat)) {
      return {
        feature: feat,
        id: feat.properties && feat.properties.catchment_id,
        confidence: 'high',
        reason: 'Address lies inside the catchment polygon.',
        distance_km: 0,
        nearestId: feat.properties && feat.properties.catchment_id,
      };
    }
  }
  // 2) Nearest centroid
  let bestKm = Infinity, bestFeat = null;
  for (const feat of geojson.features) {
    const p = feat.properties || {};
    if (typeof p.centroid_lon !== 'number' || typeof p.centroid_lat !== 'number') continue;
    const km = haversineKm(lon, lat, p.centroid_lon, p.centroid_lat);
    if (km < bestKm) { bestKm = km; bestFeat = feat; }
  }
  if (!bestFeat) {
    return { feature: null, id: null, confidence: 'unknown', reason: 'No usable catchment centroids.', distance_km: null, nearestId: null };
  }
  const id = bestFeat.properties && bestFeat.properties.catchment_id;
  if (bestKm <= nearKm) {
    return {
      feature: bestFeat,
      id,
      confidence: 'medium',
      reason: `Address is outside every catchment polygon; nearest centroid is ${bestKm.toFixed(2)} km away (${id}).`,
      distance_km: round2(bestKm),
      nearestId: id,
    };
  }
  return {
    feature: null,
    id: null,
    confidence: 'low',
    reason: `Address is ${bestKm.toFixed(1)} km from the nearest catchment (${id}); outside the area covered by Stormgrid catchments.`,
    distance_km: round2(bestKm),
    nearestId: id,
  };
}

/**
 * Rank IFD reference stations by distance to (lon, lat).
 * `ifdData` is the loaded data/catchment_ifd_centroid.json; we walk every
 * catchment's reference_station entry (deduping by station_id) so we can
 * surface the closest physical gauges to the resolved address even when
 * the auto-selected catchment is far away.
 *
 * Returns up to `limit` items: { station_id, station_name, lonlat, distance_km }
 */
export function nearbyReferenceStations(lon, lat, ifdData, opts = {}) {
  const limit = typeof opts.limit === 'number' ? opts.limit : 5;
  if (!ifdData || !ifdData.catchments) return [];
  const seen = new Map();
  for (const cid of Object.keys(ifdData.catchments)) {
    const e = ifdData.catchments[cid];
    if (!e || !e.reference_station_id || !Array.isArray(e.reference_station_lonlat)) continue;
    const sid = e.reference_station_id;
    if (seen.has(sid)) continue;
    const [slon, slat] = e.reference_station_lonlat;
    if (typeof slon !== 'number' || typeof slat !== 'number') continue;
    seen.set(sid, {
      station_id: sid,
      station_name: e.reference_station_name || sid,
      lonlat: [slon, slat],
      distance_km: round2(haversineKm(lon, lat, slon, slat)),
    });
  }
  return Array.from(seen.values())
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, limit);
}

function round2(n) { return Math.round(n * 100) / 100; }
