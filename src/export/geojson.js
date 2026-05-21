// geojson.js — GeoJSON polygon exporter (SALVAGED + ported, WORKING).
//
// docs/01 §3.6: GeoJSON "works today — visible catchments + properties.stormgrid +
// metadata block; carries provenance: yes". This is the port of
// stormgridExports.exportGeoJSON onto the new footprint + new contract.
//
// What it does (unchanged in spirit from the legacy version):
//   - Fetches the CANONICAL catchment polygons (catchments_dissolved.geojson) —
//     same-origin, inside CSP (connect-src 'self').
//   - For a catchment-located footprint, finds that catchment's feature and attaches
//     the analytical properties + the full provenance metadata block.
//   - The catchment dataset's own metadata (is_authoritative:false, P-3) is carried
//     into the output metadata so the export states the boundary is non-authoritative.
//
// HONESTY for non-polygon locations: the new contract is a SINGLE (location,
// timeframe, duration) window, not a multi-catchment ranking. If the footprint's
// location is a point, the feature geometry is a Point at that coordinate; if it is
// an area-ref with no resolvable polygon, the feature is emitted with null geometry
// and a `geometry_unavailable` note — we never fabricate a polygon.
//
// Gaps in the analytical props are null (footprint already enforced that). No new
// science; pure fetch + assemble + Blob download.

import { triggerDownload } from './download.js';
import { suggestExportFilename } from './footprint.js';

const DEFAULT_CATCHMENTS_URL = './data/catchments/catchments_dissolved.geojson';

/**
 * Build the GeoJSON FeatureCollection for a footprint.
 * @param {Object} fp footprint from buildEventFootprint
 * @param {Object} [opts]
 * @param {string} [opts.geojsonUrl] catchment polygon source
 * @param {Function} [opts.fetchImpl] injectable fetch (tests / non-browser)
 * @returns {Promise<Object>} a GeoJSON FeatureCollection
 */
export async function buildGeoJson(fp, opts = {}) {
  const geojsonUrl = opts.geojsonUrl || DEFAULT_CATCHMENTS_URL;
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const loc = (fp.context && fp.context.location) || {};

  // The analytical properties block attached to the feature (the full footprint
  // analytics, minus the geometry-irrelevant frameLog which can be large — but the
  // provenance + stats + gaps all travel).
  const stormgridProps = {
    schema_version: fp.schemaVersion,
    generated_at: fp.generatedAt,
    defensible: fp.defensible,
    is_synthetic: fp.isSynthetic,
    duration: fp.context ? fp.context.duration : null,
    timeframe: fp.context ? fp.context.timeframe : null,
    provenance: fp.provenance,
    coverage: fp.coverage,
    confidence: fp.confidence,
    calibration: fp.calibration,
    stats: fp.stats,
    duration_stats: fp.durationStats,
    warnings: fp.warnings,
    aep: fp.aep,
    frames_missing: fp.missingFrames,
  };

  let feature = null;
  let datasetMeta = null;
  let crs = null;

  if (loc.kind === 'catchment' && loc.catchmentId && fetchImpl) {
    const r = await fetchImpl(geojsonUrl, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`GeoJSON source unavailable: HTTP ${r.status}`);
    const gj = await r.json();
    datasetMeta = gj.metadata || null;
    crs = gj.crs || null;
    const match = (gj.features || []).find(
      (f) => f.properties && f.properties.catchment_id === loc.catchmentId
    );
    if (match) {
      feature = {
        type: 'Feature',
        geometry: match.geometry,
        properties: {
          ...match.properties,
          stormgrid: stormgridProps,
        },
      };
    } else {
      // The catchment id is not in the canonical set — do not fabricate a polygon.
      feature = pointlessFeature(stormgridProps, `catchment ${loc.catchmentId} not found in ${geojsonUrl}`);
    }
  } else if (loc.kind === 'point' && loc.lat != null && loc.lon != null) {
    feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [loc.lon, loc.lat] },
      properties: { catchment_id: null, location_kind: 'point', stormgrid: stormgridProps },
    };
  } else {
    feature = pointlessFeature(stormgridProps,
      loc.kind === 'area'
        ? 'area location: polygon geometry not resolvable client-side (needs a draw-control geometry ref)'
        : 'no resolvable geometry for this location');
  }

  return {
    type: 'FeatureCollection',
    name: 'stormgrid_event_footprint',
    metadata: {
      schema_version: fp.schemaVersion,
      generated_at: fp.generatedAt,
      defensible: fp.defensible,
      is_synthetic: fp.isSynthetic,
      duration: fp.context ? fp.context.duration : null,
      timeframe: fp.context ? fp.context.timeframe : null,
      provenance: fp.provenance,
      coverage: fp.coverage,
      confidence: fp.confidence,
      calibration: fp.calibration,
      warnings: fp.warnings,
      aep: fp.aep,
      // The catchment dataset's own provenance — carries is_authoritative:false (P-3).
      catchment_dataset: datasetMeta,
      note: 'Catchment polygons are raster-derived and non-authoritative (P-3). '
        + 'Gaps are reported, never filled. Not an AEP classification.',
    },
    crs: crs || null,
    features: [feature],
  };
}

/** Build the GeoJSON and trigger a browser download. */
export async function exportGeoJson(fp, opts = {}) {
  const out = await buildGeoJson(fp, opts);
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/geo+json' });
  triggerDownload(blob, suggestExportFilename(fp, 'geojson'));
  return out;
}

/** A feature with null geometry + an honest note. Never a fabricated polygon. */
function pointlessFeature(stormgridProps, note) {
  return {
    type: 'Feature',
    geometry: null,
    properties: { catchment_id: null, geometry_unavailable: note, stormgrid: stormgridProps },
  };
}
