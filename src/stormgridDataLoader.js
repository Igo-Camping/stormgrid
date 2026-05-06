/* Stormgrid — static data loader.
   Fetches the precomputed catchment rainfall JSON produced by
   scripts/build_static_rainfall.py.

   Accepts both schemas:
     v1 (flat summary, no quality fields)
     v2 ("stormgrid.catchment_rainfall.v2" — adds coverage, frame_log, quality)

   Returns null on any failure so the UI can show a "rainfall data not
   available" state. Never imports radar/station/export modules. */

const DATA_URL = './data/catchment_rainfall_latest.json';

let cached = null;
let inflight = null;

export async function loadStormgridData(url = DATA_URL) {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) {
        return { ok: false, status: r.status, error: `HTTP ${r.status}`, data: null, sizeBytes: 0 };
      }
      const text = await r.text();
      const data = JSON.parse(text);
      if (!isShapeValid(data)) {
        return { ok: false, status: r.status, error: 'unexpected JSON shape', data: null, sizeBytes: text.length };
      }
      cached = { ok: true, status: 200, error: null, data, sizeBytes: text.length };
      return cached;
    } catch (err) {
      return { ok: false, status: 0, error: String(err && err.message || err), data: null, sizeBytes: 0 };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function clearStormgridDataCache() {
  cached = null;
  inflight = null;
}

export function getCatchmentRow(data, catchmentId) {
  if (!data || !data.catchments || !catchmentId) return null;
  const row = data.catchments[catchmentId];
  if (!row || typeof row !== 'object') return null;
  return row;
}

export function getSchemaVersion(data) {
  return (data && data.schema_version) || 'stormgrid.catchment_rainfall.v1';
}

export function getFrameLog(data) {
  if (!data || !Array.isArray(data.frame_log)) return [];
  return data.frame_log;
}

export function getQualityMeta(data) {
  return (data && data.quality) || null;
}

/* Confidence helpers — work on a catchment row from either schema.
   v1 rows lack coverage_fraction; we return 'unknown'. */
export function rowConfidence(row) {
  if (!row) return 'unknown';
  if (typeof row.confidence === 'string') return row.confidence;
  return 'unknown';
}

export function rowCoveragePct(row) {
  if (!row) return null;
  if (typeof row.coverage_pct === 'number') return row.coverage_pct;
  if (typeof row.coverage_fraction === 'number') return row.coverage_fraction * 100;
  return null;
}

function isShapeValid(d) {
  return !!d
      && typeof d === 'object'
      && typeof d.generated_at === 'string'
      && typeof d.source === 'string'
      && d.window && typeof d.window.start === 'string' && typeof d.window.end === 'string'
      && typeof d.window.frame_count === 'number'
      && d.catchments && typeof d.catchments === 'object';
}
