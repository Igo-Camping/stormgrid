/* Stormgrid — ARR2019 Areal Reduction Factor (ARF) engine.

   Implements the ARR2019 Book 2 Chapter 4 long-duration ARF form:

     ARF = min(1, 1
       - a · A^b · D^(-c)
       + d · A^e · D^(-f) · (0.3 + log10(AEP))
       + g · 10^(h · A · D / 1440) · (0.3 + log10(AEP)))

   where A is catchment area in km², D is duration in minutes, AEP is
   the annual exceedance probability as a fraction (e.g. 0.01 for 1%).

   This module ONLY converts point IFD into areal design rainfall via
   ARF. It NEVER classifies event AEP, NEVER computes return periods,
   and NEVER asserts exceedance. */

const ARF_URL = './data/arf_coefficients.json';

let cached = null;
let inflight = null;

export async function loadArfCoefficients(url = ARF_URL) {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) {
        return { ok: false, status: r.status, error: `HTTP ${r.status}`, data: null };
      }
      const data = await r.json();
      if (!data || !data.regions || !data.default_region) {
        return { ok: false, status: r.status, error: 'unexpected ARF coefficients shape', data: null };
      }
      cached = { ok: true, status: 200, error: null, data };
      return cached;
    } catch (err) {
      return { ok: false, status: 0, error: String((err && err.message) || err), data: null };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function clearArfCache() { cached = null; inflight = null; }

/* AEP is supplied as a percent string (e.g. "1%", "20%") matching the
   IFD asset; convert here. Returns null on bad input. */
function aepStringToFraction(s) {
  if (typeof s === 'number') return s;
  if (typeof s !== 'string') return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*%?$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return v >= 1 ? v / 100 : v;   // accept "0.01" or "1%" or "1"
}

/* Returns {arf, valid, flags[]} where arf is in (0, 1] and flags
   describes any validity-range issues. Always honest — never fakes a
   value. */
export function computeArf({ areaKm2, durationHours, aep, coefficients, validity }) {
  const flags = [];
  if (!coefficients) {
    return { arf: null, valid: false, flags: ['no_coefficients_loaded'] };
  }
  const A = Number(areaKm2);
  const Dh = Number(durationHours);
  const aepF = typeof aep === 'number' ? aep : aepStringToFraction(aep);
  if (!Number.isFinite(A) || A <= 0) flags.push('area_invalid');
  if (!Number.isFinite(Dh) || Dh <= 0) flags.push('duration_invalid');
  if (!Number.isFinite(aepF) || aepF <= 0 || aepF > 1) flags.push('aep_invalid');
  if (flags.length) return { arf: null, valid: false, flags };

  const D = Dh * 60;  // minutes for the ARR2019 form

  if (validity) {
    if (validity.duration_min_hours != null && Dh < validity.duration_min_hours) flags.push('duration_below_validity');
    if (validity.duration_max_hours != null && Dh > validity.duration_max_hours) flags.push('duration_above_validity');
    if (validity.area_min_km2 != null && A < validity.area_min_km2)              flags.push('area_below_validity');
    if (validity.area_max_km2 != null && A > validity.area_max_km2)              flags.push('area_above_validity');
  }

  const { a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0 } = coefficients;
  const aepLog = Math.log10(aepF);

  const term1 = a * Math.pow(A, b) * Math.pow(D, -c);
  const term2 = d * Math.pow(A, e) * Math.pow(D, -f) * (0.3 + aepLog);
  const term3 = g * Math.pow(10, h * A * D / 1440) * (0.3 + aepLog);

  const raw = 1 - term1 + term2 + term3;
  // Clip to a defensible (0, 1] range — never above 1, never zero or
  // negative (which would imply a degenerate ARF).
  let arf = Math.min(1, raw);
  if (!Number.isFinite(arf)) {
    flags.push('non_finite_result');
    return { arf: null, valid: false, flags };
  }
  if (arf <= 0) {
    flags.push('non_positive_arf_clipped');
    arf = 0.01;
  }
  arf = Math.max(0.01, arf);

  // Mark as extrapolated if any validity flag fired.
  const extrapolated = flags.some((x) => x.endsWith('_below_validity') || x.endsWith('_above_validity'));
  return { arf: Number(arf.toFixed(6)), valid: !extrapolated, flags, raw_unclipped: Number(raw.toFixed(6)) };
}

/* Compute ARF for a (catchment area, duration) and an array of AEPs
   simultaneously. Returns { arf_by_aep: { '1%': 0.97, ... }, ... }. */
export function computeArfTable({ areaKm2, durationHours, aepKeys, coefficients, validity }) {
  const out = {};
  let anyExtrap = false;
  let allValid = true;
  for (const aep of aepKeys || []) {
    const r = computeArf({ areaKm2, durationHours, aep, coefficients, validity });
    out[aep] = r;
    if (!r.valid) allValid = false;
    if (r.flags.some((x) => x.endsWith('_below_validity') || x.endsWith('_above_validity'))) anyExtrap = true;
  }
  return { arf_by_aep: out, all_valid: allValid, any_extrapolated: anyExtrap };
}

export function getRegion(arfData, regionKey) {
  if (!arfData) return null;
  const key = regionKey || arfData.default_region;
  return arfData.regions ? arfData.regions[key] || null : null;
}

export function getValidity(arfData) {
  return (arfData && arfData.validity) || null;
}

export function isVerified(arfData) {
  return !!(arfData && arfData.verified === true);
}
