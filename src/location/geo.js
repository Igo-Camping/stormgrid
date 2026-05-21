// geo.js — point-in-polygon + catchment resolution for the Location layer
// (docs/02 §5.1; docs/03 §2 LOCATION LAYER "GeoResolver"; rewrite of
// src/stormgridGeo.js — the original is NOT imported or modified).
//
// REPORT-GAPS / NEVER-GUESS DISCIPLINE (carried verbatim in spirit from the
// salvage source's contract): this resolver returns a containment hit ONLY when
// the point is genuinely inside a catchment polygon. When it is not, it MAY fall
// back to the nearest centroid, but that fallback is ALWAYS labelled
// medium-confidence with a human-readable reason — never presented as a
// containment match. When nothing is within range, it returns
// { catchmentId: null } with low/unknown confidence and a reason. It never
// fabricates a containment.
//
// Pure module: no DOM, no fetch, no store. The catchments GeoJSON is
// `is_authoritative:false` (raster-derived); confidence wording reflects that.

const EARTH_RADIUS_KM = 6371.0088;
const DEFAULT_NEAR_PROXIMITY_KM = 5;

/** Confidence tiers this resolver can return. */
export const CONFIDENCE = Object.freeze({
  HIGH: 'high',       // point is inside a catchment polygon (containment)
  MEDIUM: 'medium',   // outside all polygons but within nearProximityKm of a centroid (a guess)
  LOW: 'low',         // outside all polygons and beyond nearProximityKm
  UNKNOWN: 'unknown', // geojson missing/empty or no usable centroids
});

/** Great-circle distance between two lon/lat points, in kilometres. */
export function haversineKm(lon1, lat1, lon2, lat2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Standard ray-cast point-in-ring. Works in lon/lat directly because over a
 * single catchment-sized region the projection distortion is negligible for a
 * yes/no membership test. `ring` is [[lon,lat], ...].
 */
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

/**
 * True if (lon,lat) falls inside the feature's geometry (Polygon or
 * MultiPolygon). Holes are honoured.
 */
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

function round2(n) { return Math.round(n * 100) / 100; }

function catchmentIdOf(feature) {
  return (feature && feature.properties && feature.properties.catchment_id) || null;
}

/**
 * Resolve the catchment a (lon, lat) point belongs to.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {Object} geojson  FeatureCollection (data/catchments/catchments_dissolved.geojson)
 * @param {Object} [opts]
 * @param {number} [opts.nearProximityKm=5]  medium-confidence fallback radius
 * @returns {{
 *   catchmentId: string|null,   // a containment OR a labelled nearest-centroid guess; null if neither
 *   confidence: 'high'|'medium'|'low'|'unknown',
 *   reason: string,             // human-readable, surfaced in the UI
 *   distanceKm: number|null,    // 0 on containment; centroid distance on fallback
 *   feature: Object|null        // the resolved GeoJSON feature, or null
 * }}
 *
 * Contract:
 *  - 'high'    => point is INSIDE the polygon. catchmentId is a true containment.
 *  - 'medium'  => point is OUTSIDE every polygon but within nearProximityKm of a
 *                 centroid. catchmentId is a GEOMETRIC GUESS, explicitly labelled
 *                 as such in `reason`. NOT a containment.
 *  - 'low'     => outside every polygon and beyond nearProximityKm. catchmentId
 *                 is null (the nearest is named in `reason` only, never selected).
 *  - 'unknown' => geojson missing/empty or no usable centroids. catchmentId null.
 *
 * Never returns a containment-confidence result for a point that is not inside a
 * polygon. Never coerces a far-away nearest centroid into a selection.
 */
export function findCatchmentForPoint(lon, lat, geojson, opts = {}) {
  const nearKm = typeof opts.nearProximityKm === 'number' ? opts.nearProximityKm : DEFAULT_NEAR_PROXIMITY_KM;

  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return { catchmentId: null, confidence: CONFIDENCE.UNKNOWN, reason: 'No valid coordinate to resolve.', distanceKm: null, feature: null };
  }
  if (!geojson || !Array.isArray(geojson.features) || geojson.features.length === 0) {
    return { catchmentId: null, confidence: CONFIDENCE.UNKNOWN, reason: 'No catchment polygons loaded.', distanceKm: null, feature: null };
  }

  // 1) Containment hit-test — the only path that yields HIGH confidence.
  for (const feat of geojson.features) {
    if (pointInFeature(lon, lat, feat)) {
      return {
        catchmentId: catchmentIdOf(feat),
        confidence: CONFIDENCE.HIGH,
        reason: 'Point lies inside the catchment polygon (raster-derived boundary).',
        distanceKm: 0,
        feature: feat,
      };
    }
  }

  // 2) Nearest centroid — a labelled guess, never a containment.
  let bestKm = Infinity, bestFeat = null;
  for (const feat of geojson.features) {
    const p = feat.properties || {};
    if (typeof p.centroid_lon !== 'number' || typeof p.centroid_lat !== 'number') continue;
    const km = haversineKm(lon, lat, p.centroid_lon, p.centroid_lat);
    if (km < bestKm) { bestKm = km; bestFeat = feat; }
  }
  if (!bestFeat) {
    return { catchmentId: null, confidence: CONFIDENCE.UNKNOWN, reason: 'No usable catchment centroids.', distanceKm: null, feature: null };
  }

  const nearestId = catchmentIdOf(bestFeat);
  if (bestKm <= nearKm) {
    return {
      catchmentId: nearestId, // a guess — the caller MUST surface it as medium-confidence
      confidence: CONFIDENCE.MEDIUM,
      reason: `Point is outside every catchment polygon; nearest centroid is ${bestKm.toFixed(2)} km away (${nearestId}). This is a geometric guess, not a containment.`,
      distanceKm: round2(bestKm),
      feature: bestFeat,
    };
  }

  // 3) Beyond range — report the gap; select nothing.
  return {
    catchmentId: null,
    confidence: CONFIDENCE.LOW,
    reason: `Point is ${bestKm.toFixed(1)} km from the nearest catchment (${nearestId}); outside the area covered by Stormgrid catchments. No catchment selected.`,
    distanceKm: round2(bestKm),
    feature: null,
  };
}

/**
 * Look up a single feature by catchment_id (used to surface provenance for a
 * catchment selected elsewhere, e.g. by a map click).
 * @returns {Object|null} the feature, or null if not found / geojson empty
 */
export function featureById(catchmentId, geojson) {
  if (!catchmentId || !geojson || !Array.isArray(geojson.features)) return null;
  for (const feat of geojson.features) {
    if (catchmentIdOf(feat) === catchmentId) return feat;
  }
  return null;
}
