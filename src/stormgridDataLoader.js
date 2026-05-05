/* Stormgrid v0 — static data loader.
   Fetches the precomputed catchment rainfall JSON produced by
   scripts/build_stormgrid_static_rainfall.py. Schema (flat summary):

     { generated_at, source, window: {start,end,frame_count},
       catchments: { <id>: {total_mm,mean_mm,min_mm,max_mm,sample_count} } }

   Returns null on any failure so the UI can show a clear "rainfall data
   not available" state. Never imports radar/station/export modules. */

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
  if (typeof row.total_mm !== 'number') return null;
  return row;
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
