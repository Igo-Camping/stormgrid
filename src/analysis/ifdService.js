// ifdService.js — Analysis layer: point IFD design depths per catchment.
//
// SALVAGE/rewrite of src/stormgridIfdLoader.js + scripts/build_catchment_ifd.py
// output (data/catchment_ifd_centroid.json). Loads the precomputed point IFD per
// catchment and hands each design depth back as a branded PointDesignDepth
// (rainfallTypes.pointDesignDepth) — NOT a bare number, NOT an ArealRainfall.
//
// RED LINE (docs/01 §7, docs/04 §3.5): this asset is POINT IFD only, ARF NOT
// applied (data declares `methodology.point_ifd_only:true, arf_applied:false`).
// Returning PointDesignDepth values is exactly what makes the areal-vs-point
// boundary structural: a PointDesignDepth is the ONLY thing applyArf accepts, and
// the observed catchment mean is an ArealRainfall, which applyArf rejects. So the
// observed mean can never be ARF-reduced; only these point depths can.
//
// This module never makes an AEP / return-period claim. It is a typed loader.

import { pointDesignDepth } from '../core/rainfallTypes.js';

/** Default location of the point IFD asset. */
export const IFD_URL = './data/catchment_ifd_centroid.json';

/** This service deals exclusively in POINT IFD; ARF is applied downstream only. */
export const IFD_BASIS = Object.freeze({
  point_ifd_only: true,
  arf_applied: false,
  note: 'Point IFD design depths. ARF is applied downstream to the point side only (applyArf); the observed catchment mean (areal) is never ARF-reduced.',
});

let _cache = null;
let _inflight = null;

/**
 * @typedef {Object} IfdAsset
 * @property {boolean} ok
 * @property {number} status
 * @property {string|null} error
 * @property {Object|null} data       raw catchment_ifd_centroid.json payload
 */

/**
 * Load the point IFD asset. Returns { ok:false } on failure; never throws on a
 * fetch/parse problem, never fabricates IFD values.
 * @param {string} [url]
 * @param {{fetchImpl?:Function}} [opts]  test seam; defaults to global fetch
 * @returns {Promise<IfdAsset>}
 */
export async function loadCatchmentIfd(url = IFD_URL, opts = {}) {
  if (_cache) return _cache;
  if (_inflight) return _inflight;
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  _inflight = (async () => {
    try {
      if (!fetchImpl) {
        return { ok: false, status: 0, error: 'no fetch implementation available', data: null };
      }
      const r = await fetchImpl(url, { cache: 'no-store' });
      if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}`, data: null };
      const data = await r.json();
      if (!data || !data.catchments || !data.methodology) {
        return { ok: false, status: r.status, error: 'unexpected IFD JSON shape', data: null };
      }
      _cache = { ok: true, status: 200, error: null, data };
      return _cache;
    } catch (err) {
      return { ok: false, status: 0, error: String((err && err.message) || err), data: null };
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** Test/util seam — drop any cached asset. */
export function clearIfdCache() { _cache = null; _inflight = null; }

/**
 * Raw per-catchment record (centroid, reference station, durations map). Returns
 * null when absent — never a fabricated record.
 * @param {Object|null} data
 * @param {string} catchmentId
 * @returns {Object|null}
 */
export function getCatchmentIfd(data, catchmentId) {
  if (!data || !data.catchments || !catchmentId) return null;
  return data.catchments[catchmentId] || null;
}

/** @param {Object|null} data @returns {Object|null} the methodology block */
export function getMethodology(data) {
  return (data && data.methodology) || null;
}

/** @param {Object|null} data @returns {Object|null} the source/provenance block */
export function getIfdSource(data) {
  return (data && data.source) || null;
}

/**
 * The IFD asset stores AEP as percent-string keys ('1%','2%','5%','20%'). Convert
 * to the fraction the PointDesignDepth brand requires (in (0,1]). Returns null on
 * an unparseable key — never coerced.
 * @param {string} key
 * @returns {number|null}
 */
export function aepKeyToFraction(key) {
  if (typeof key === 'number') return key > 1 ? key / 100 : key;
  if (typeof key !== 'string') return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*%?$/.exec(key.trim());
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return v >= 1 ? v / 100 : v;
}

/**
 * Get one branded PointDesignDepth for (catchment, duration, aepKey). Returns
 * null when the cell is absent (a gap — never coerced to 0). Suspect IFD rows are
 * surfaced via the second return field rather than silently dropped.
 *
 * @param {Object|null} data
 * @param {string} catchmentId
 * @param {string} durationKey   e.g. '24h'
 * @param {string} aepKey        e.g. '1%'
 * @returns {{depth:import('../core/rainfallTypes.js').PointDesignDepth|null, qualityFlag:string|null}}
 */
export function pointDepth(data, catchmentId, durationKey, aepKey) {
  const rec = getCatchmentIfd(data, catchmentId);
  const durations = rec && rec.durations;
  const row = durations && durations[durationKey];
  if (!row || !row.aep) return { depth: null, qualityFlag: null };
  const mm = row.aep[aepKey];
  const aepF = aepKeyToFraction(aepKey);
  if (typeof mm !== 'number' || !Number.isFinite(mm) || aepF == null) {
    return { depth: null, qualityFlag: row.quality_flag || null };
  }
  return {
    depth: pointDesignDepth(mm, aepF, durationKey),
    qualityFlag: row.quality_flag || null,
  };
}

/**
 * Get all available PointDesignDepths for (catchment, duration) across the asset's
 * AEP keys. Skips absent cells (gaps) honestly. Suspect-monotonicity rows are
 * flagged but still returned — the consumer decides whether to use them; we never
 * silently drop or fabricate.
 *
 * @param {Object|null} data
 * @param {string} catchmentId
 * @param {string} durationKey
 * @returns {{byAep:Object<string,import('../core/rainfallTypes.js').PointDesignDepth>, aepKeys:string[], qualityFlag:string|null}}
 */
export function pointDepthsForDuration(data, catchmentId, durationKey) {
  const rec = getCatchmentIfd(data, catchmentId);
  const durations = rec && rec.durations;
  const row = durations && durations[durationKey];
  const out = { byAep: {}, aepKeys: [], qualityFlag: (row && row.quality_flag) || null };
  if (!row || !row.aep) return out;
  const keys = (data && Array.isArray(data.aep_keys) && data.aep_keys.length)
    ? data.aep_keys
    : Object.keys(row.aep);
  for (const aepKey of keys) {
    const mm = row.aep[aepKey];
    const aepF = aepKeyToFraction(aepKey);
    if (typeof mm === 'number' && Number.isFinite(mm) && aepF != null) {
      out.byAep[aepKey] = pointDesignDepth(mm, aepF, durationKey);
      out.aepKeys.push(aepKey);
    }
  }
  return out;
}
