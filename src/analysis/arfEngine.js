// arfEngine.js — Analysis layer: Areal Reduction Factor (ARF) engine.
//
// REWRITE of src/stormgridArf.js (computeArf/computeArfTable) for the rebuild.
// Scope is the single legitimate ARF direction (docs/01 §7, docs/04 §3.5):
//
//     POINT IFD design depth  ──ARF──▶  areal design rainfall
//
// This module computes an ArfFactor only. It NEVER applies that factor — the
// only point→areal reduction is rainfallTypes.applyArf(point, arf), which
// accepts only a PointDesignDepth and throws on an ArealRainfall. So the
// observed (already-areal) catchment mean can never be ARF-reduced here; this
// engine produces the factor, applyArf consumes it on the point side only.
//
// P-1 RED LINE: the ARR2019 Book 2 Ch.4 coefficients shipped in
// data/arf_coefficients.json are PLACEHOLDERS (verified:false, only a,b,c
// non-zero). This module exposes that fact (`is_placeholder`) so the AEP gate
// (sourceAdapter.engineeringGradeAllowed) stays closed. The engine remains
// usable for clearly-labelled illustrative shape only — never engineering output
// — while placeholders are active.
//
// Vanilla ES module, no build step (DECISIONS.md B-006). JSDoc for editor types.

import { arfFactor } from '../core/rainfallTypes.js';

/** Default location of the ARF coefficient table. */
export const ARF_COEFFICIENTS_URL = './data/arf_coefficients.json';

// Named placeholder constants. These mirror the shipped placeholder table so a
// reader sees, in code, that the engine has no engineering-grade coefficients.
// They are NOT used for computation by default (the loaded file is authoritative);
// they exist to (a) document the placeholder envelope and (b) give the smoke test
// a coefficient set to exercise the form without a fetch. PLACEHOLDER_* naming is
// mandated by the brief / DECISIONS.md B-004.
export const PLACEHOLDER_REGION = 'east_coast_north';
export const PLACEHOLDER_COEFFICIENTS = Object.freeze({
  a: 0.06, b: 0.361, c: 0.317, d: 0, e: 0, f: 0, g: 0, h: 0,
});
export const PLACEHOLDER_VALIDITY = Object.freeze({
  duration_min_hours: 24,
  duration_max_hours: 168,
  area_min_km2: 1,
  area_max_km2: 30000,
});

let _cache = null;
let _inflight = null;

/**
 * @typedef {Object} ArfCoefficientTable
 * @property {boolean} ok
 * @property {number} status
 * @property {string|null} error
 * @property {Object|null} data           the raw arf_coefficients.json payload
 * @property {boolean} is_placeholder      true while coefficients are not engineering-grade (P-1)
 */

/**
 * Load the ARF coefficient table. Mirrors the loader contract of the rest of the
 * app: returns { ok:false } on failure, never throws on a fetch/parse problem,
 * never fabricates coefficients.
 *
 * `is_placeholder` is derived from the table itself: a table is engineering-grade
 * ONLY if its top-level `verified === true` AND the active region's
 * `verified === true`. Anything else is placeholder-grade (P-1) and keeps the AEP
 * gate closed.
 *
 * @param {string} [url]
 * @param {{fetchImpl?:Function}} [opts]  test seam; defaults to global fetch
 * @returns {Promise<ArfCoefficientTable>}
 */
export async function loadArfCoefficients(url = ARF_COEFFICIENTS_URL, opts = {}) {
  if (_cache) return _cache;
  if (_inflight) return _inflight;
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  _inflight = (async () => {
    try {
      if (!fetchImpl) {
        return { ok: false, status: 0, error: 'no fetch implementation available', data: null, is_placeholder: true };
      }
      const r = await fetchImpl(url, { cache: 'no-store' });
      if (!r.ok) {
        return { ok: false, status: r.status, error: `HTTP ${r.status}`, data: null, is_placeholder: true };
      }
      const data = await r.json();
      if (!data || !data.regions || !data.default_region) {
        return { ok: false, status: r.status, error: 'unexpected ARF coefficients shape', data: null, is_placeholder: true };
      }
      _cache = { ok: true, status: 200, error: null, data, is_placeholder: isPlaceholderTable(data) };
      return _cache;
    } catch (err) {
      return { ok: false, status: 0, error: String((err && err.message) || err), data: null, is_placeholder: true };
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** Test/util seam — drop any cached table. */
export function clearArfCache() { _cache = null; _inflight = null; }

/**
 * Is this coefficient table placeholder-grade? Conservative: anything not
 * explicitly verified at BOTH the table and active-region level is placeholder.
 * @param {Object|null} data
 * @param {string} [regionKey]
 * @returns {boolean}
 */
export function isPlaceholderTable(data, regionKey) {
  if (!data) return true;
  if (data.verified !== true) return true;
  const region = getRegion(data, regionKey);
  if (!region || region.verified !== true) return true;
  return false;
}

/** @param {Object|null} data @param {string} [regionKey] */
export function getRegion(data, regionKey) {
  if (!data || !data.regions) return null;
  const key = regionKey || data.default_region;
  return data.regions[key] || null;
}

/** @param {Object|null} data */
export function getValidity(data) {
  return (data && data.validity) || null;
}

/**
 * Compute a single ARF as a branded ArfFactor.
 *
 * Implements the ARR2019 Book 2 Ch.4 long-duration form:
 *   ARF = min(1, 1 - a·A^b·D^-c + d·A^e·D^-f·(0.3+log10(AEP)) + g·10^(h·A·D/1440)·(0.3+log10(AEP)))
 * with A in km², D in minutes, AEP a fraction in (0,1].
 *
 * Returns a discriminated result:
 *   { ok:true,  factor: ArfFactor, flags:string[], rawUnclipped:number }
 *   { ok:false, factor: null,      flags:string[] }   on invalid input / non-finite
 *
 * `factor.extrapolated` is TRUE if any validity-range flag fired (area/duration
 * outside the coefficients' envelope). The factor value is clipped to (0,1].
 *
 * This function NEVER applies the factor to a depth — that is applyArf's job, and
 * applyArf accepts only a PointDesignDepth. The areal observed mean therefore has
 * no path into ARF.
 *
 * @param {{areaKm2:number, durationHours:number, aep:number, coefficients:Object, validity?:Object}} args
 * @returns {{ok:boolean, factor:import('../core/rainfallTypes.js').ArfFactor|null, flags:string[], rawUnclipped?:number}}
 */
export function arfFactorFor({ areaKm2, durationHours, aep, coefficients, validity }) {
  const flags = [];
  if (!coefficients) return { ok: false, factor: null, flags: ['no_coefficients'] };

  const A = Number(areaKm2);
  const Dh = Number(durationHours);
  const aepF = normaliseAep(aep);
  if (!Number.isFinite(A) || A <= 0) flags.push('area_invalid');
  if (!Number.isFinite(Dh) || Dh <= 0) flags.push('duration_invalid');
  if (!Number.isFinite(aepF) || aepF <= 0 || aepF > 1) flags.push('aep_invalid');
  if (flags.length) return { ok: false, factor: null, flags };

  const D = Dh * 60; // minutes

  if (validity) {
    if (validity.duration_min_hours != null && Dh < validity.duration_min_hours) flags.push('duration_below_validity');
    if (validity.duration_max_hours != null && Dh > validity.duration_max_hours) flags.push('duration_above_validity');
    if (validity.area_min_km2 != null && A < validity.area_min_km2) flags.push('area_below_validity');
    if (validity.area_max_km2 != null && A > validity.area_max_km2) flags.push('area_above_validity');
  }

  const { a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0 } = coefficients;
  const aepLog = Math.log10(aepF);
  const term1 = a * Math.pow(A, b) * Math.pow(D, -c);
  const term2 = d * Math.pow(A, e) * Math.pow(D, -f) * (0.3 + aepLog);
  const term3 = g * Math.pow(10, (h * A * D) / 1440) * (0.3 + aepLog);
  const raw = 1 - term1 + term2 + term3;

  if (!Number.isFinite(raw)) {
    flags.push('non_finite_result');
    return { ok: false, factor: null, flags };
  }

  // Clip to a defensible (0,1] range. arfFactor() enforces (0,1] structurally.
  let value = Math.min(1, raw);
  if (value <= 0) { flags.push('non_positive_arf_clipped'); }
  value = Math.max(0.01, value);
  value = Number(value.toFixed(6));

  const extrapolated = flags.some((x) => x.endsWith('_below_validity') || x.endsWith('_above_validity'));
  return {
    ok: true,
    factor: arfFactor(value, extrapolated),
    flags,
    rawUnclipped: Number(raw.toFixed(6)),
  };
}

/**
 * Compute ARF factors for one (area, duration) across several AEP keys at once.
 * Returns a map keyed by the AEP key string, each value the discriminated result
 * of arfFactorFor(), plus rollup flags.
 *
 * @param {{areaKm2:number, durationHours:number, aepKeys:string[]|number[], coefficients:Object, validity?:Object}} args
 * @returns {{byAep:Object, allOk:boolean, anyExtrapolated:boolean}}
 */
export function arfFactorTable({ areaKm2, durationHours, aepKeys, coefficients, validity }) {
  const byAep = {};
  let allOk = true;
  let anyExtrapolated = false;
  for (const aep of aepKeys || []) {
    const res = arfFactorFor({ areaKm2, durationHours, aep, coefficients, validity });
    byAep[aep] = res;
    if (!res.ok) allOk = false;
    if (res.ok && res.factor.extrapolated) anyExtrapolated = true;
  }
  return { byAep, allOk, anyExtrapolated };
}

/**
 * Accept an AEP as a fraction (0.01), a percent number (1 → 0.01), or a percent
 * string ('1%' → 0.01). Returns null on garbage. Mirrors the IFD asset's '1%'
 * key convention plus plain fractions.
 * @param {number|string} aep
 * @returns {number|null}
 */
export function normaliseAep(aep) {
  if (typeof aep === 'number') return aep > 1 ? aep / 100 : aep;
  if (typeof aep !== 'string') return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*%?$/.exec(aep.trim());
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return v >= 1 ? v / 100 : v;
}
