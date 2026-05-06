/* Stormgrid — static data loader.
   Fetches the precomputed catchment rainfall JSON produced by
   scripts/build_static_rainfall.py.

   Phase 2: supports multiple precomputed accumulation windows.
   Each window is independently fetched and cached.

   Accepts both schemas:
     v1 (flat summary, no quality fields)
     v2 ("stormgrid.catchment_rainfall.v2" — coverage, frame_log, quality)

   Returns null on any failure so the UI can show a "rainfall data not
   available" state. Never imports radar/station/export modules. */

export const RAINFALL_WINDOWS = Object.freeze([
  { key: '24h',    label: '24 h',   path: './data/catchment_rainfall_24h.json' },
  { key: '7d',     label: '7 d',    path: './data/catchment_rainfall_7d.json' },
  { key: '30d',    label: '30 d',   path: './data/catchment_rainfall_30d.json' },
  { key: 'latest', label: 'Latest', path: './data/catchment_rainfall_latest.json' },
]);

export const DEFAULT_WINDOW_KEY = '24h';

const cacheByKey = new Map();   // windowKey -> result
const inflightByKey = new Map();

export function getAvailableRainfallWindows() {
  // Returns the public window list (no internal state).
  return RAINFALL_WINDOWS.map(({ key, label, path }) => ({ key, label, path }));
}

function urlForWindow(windowKey) {
  const w = RAINFALL_WINDOWS.find((x) => x.key === windowKey);
  return w ? w.path : null;
}

export async function loadRainfallData(windowKey = DEFAULT_WINDOW_KEY) {
  if (cacheByKey.has(windowKey)) return cacheByKey.get(windowKey);
  if (inflightByKey.has(windowKey)) return inflightByKey.get(windowKey);

  const url = urlForWindow(windowKey);
  if (!url) {
    return { ok: false, status: 0, error: `unknown window key: ${windowKey}`, data: null, sizeBytes: 0, windowKey };
  }

  const promise = (async () => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) {
        return { ok: false, status: r.status, error: `HTTP ${r.status}`, data: null, sizeBytes: 0, windowKey };
      }
      const text = await r.text();
      const data = JSON.parse(text);
      if (!isShapeValid(data)) {
        return { ok: false, status: r.status, error: 'unexpected JSON shape', data: null, sizeBytes: text.length, windowKey };
      }
      const result = { ok: true, status: 200, error: null, data, sizeBytes: text.length, windowKey };
      cacheByKey.set(windowKey, result);
      return result;
    } catch (err) {
      return { ok: false, status: 0, error: String((err && err.message) || err), data: null, sizeBytes: 0, windowKey };
    } finally {
      inflightByKey.delete(windowKey);
    }
  })();
  inflightByKey.set(windowKey, promise);
  return promise;
}

/* Back-compat alias for callers still expecting the Phase 1 API. */
export async function loadStormgridData(url) {
  if (url) {
    // explicit URL — no registry, single-shot, not cached
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}`, data: null, sizeBytes: 0 };
      const text = await r.text();
      const data = JSON.parse(text);
      if (!isShapeValid(data)) return { ok: false, status: r.status, error: 'unexpected JSON shape', data: null, sizeBytes: text.length };
      return { ok: true, status: 200, error: null, data, sizeBytes: text.length };
    } catch (err) {
      return { ok: false, status: 0, error: String((err && err.message) || err), data: null, sizeBytes: 0 };
    }
  }
  return loadRainfallData(DEFAULT_WINDOW_KEY);
}

export function clearStormgridDataCache() {
  cacheByKey.clear();
  inflightByKey.clear();
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

/* Phase 3 — duration helpers. Tolerant of v1/v2-without-durations payloads;
   return [] / null when the dataset doesn't carry duration_stats. */

export function getAvailableDurations(data) {
  if (!data || !data.durations) return [];
  return Object.entries(data.durations)
    .filter(([, meta]) => meta && meta.available)
    .map(([key, meta]) => ({
      key,
      label: humanDurationLabel(key, meta),
      durationHours: meta.duration_hours,
      frameCount: meta.frame_count,
    }))
    .sort((a, b) => a.durationHours - b.durationHours);
}

export function getCatchmentDurationStats(data, catchmentId, durationKey) {
  if (!data || !catchmentId || !durationKey) return null;
  const row = data.catchments && data.catchments[catchmentId];
  if (!row || !row.duration_stats) return null;
  return row.duration_stats[durationKey] || null;
}

/* Phase 4 — spatial helpers. Tolerant of legacy JSON. */

export function getCatchmentSpatialMetrics(data, catchmentId, durationKey) {
  const ds = getCatchmentDurationStats(data, catchmentId, durationKey);
  if (!ds || !ds.spatial_metrics) return null;
  return ds.spatial_metrics;
}

export function pickDefaultDurationKey(durations) {
  if (!Array.isArray(durations) || durations.length === 0) return null;
  const has24 = durations.find((d) => d.key === '24h');
  if (has24) return '24h';
  // Otherwise the longest available.
  return durations[durations.length - 1].key;
}

function humanDurationLabel(key, meta) {
  // Renders like "24 h" — keeps the engineering style.
  if (!meta || typeof meta.duration_hours !== 'number') return key;
  return `${meta.duration_hours} h`;
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
