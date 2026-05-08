/* Stormgrid — radar/gauge calibration framework (Phase 14).

   Three responsibilities:

   1. Pair gauges to catchments
      - Each gauge is paired to the catchment whose polygon contains it
        (point-in-polygon), falling back to the nearest centroid. The
        pairing carries the gauge's window total + the catchment's
        radar window total + bias_ratio + residual_mm + distance_km.

   2. Compute per-catchment calibration factors
      - From the gauge/radar pairs, an inverse-distance-weighted (IDW)
        average of bias ratios is projected onto every catchment in the
        dataset. The IDW is:

            f(c) = sum_i (b_i / d_i^p) / sum_i (1 / d_i^p)

        where d_i is the Haversine distance from catchment c's centroid
        to gauge i, and p = 2 (standard IDW exponent). When a gauge
        sits inside a catchment, that pair fully determines the factor
        (d_i = 0 trap is handled). p is configurable.

   3. Apply calibration to a rainfall-data structure
      - applyCalibration() returns a NEW deep-cloneable rainfall_data
        object with `present_total_mm` replaced by `radar_present_total_mm * factor`,
        and the original radar value preserved as `raw_present_total_mm` so the
        operation is fully reversible. duration_stats[*].max_total_mm
        is also adjusted with the same factor; raw is preserved.

   Critical rules baked in:
     - No ML, no kriging — IDW only, fully explainable
     - Calibrated values never silently overwrite raw (raw_* stays)
     - Confidence is independently downgraded by one tier if the
       nearest gauge is > MAX_PAIR_DISTANCE_KM away (calibration-aware
       confidence — see deriveCalibrationConfidence)
     - Methodology note travels into every UI panel + export
*/

import { haversineKm, pointInFeature } from './stormgridGeo.js';

const GAUGE_OBS_URL = './data/gauge_observations.json';

// Tier downgrades by one step when nearest gauge is further than this.
const MAX_PAIR_DISTANCE_KM = 5;
const IDW_EXPONENT = 2;

const METHODOLOGY_NOTE =
  'Calibration is a transparent multiplicative bias correction with ' +
  'inverse-distance weighting (IDW, p=2) from per-gauge bias ratios. ' +
  'Raw radar values are preserved (raw_present_total_mm) so the operation is ' +
  'fully reversible. Calibration is NOT an AEP classification, NOT a ' +
  'return-period assignment, and NOT a formal exceedance assertion.';

/* ────────────────────────────────────────────────────────────────────
   Loader
   ──────────────────────────────────────────────────────────────────── */

let cached = null;

export async function loadGaugeObservations(url = GAUGE_OBS_URL) {
  if (cached) return cached;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      cached = { ok: false, error: `HTTP ${r.status}`, data: null };
      return cached;
    }
    const data = await r.json();
    cached = { ok: true, error: null, data };
    return cached;
  } catch (err) {
    cached = { ok: false, error: String((err && err.message) || err), data: null };
    return cached;
  }
}

export function clearGaugeObservationsCache() { cached = null; }

/* ────────────────────────────────────────────────────────────────────
   Pairing
   ──────────────────────────────────────────────────────────────────── */

/**
 * Pair every station to a catchment for the given accumulation window.
 * Returns:
 *   {
 *     window: '24h',
 *     pairs: [{ station_id, station_name, gauge_lonlat, paired_catchment_id,
 *               method: 'point-in-polygon' | 'nearest-centroid',
 *               distance_km, gauge_total_mm, radar_total_mm,
 *               bias_ratio, residual_mm, valid }, ...],
 *     n_pairs, n_pairs_valid
 *   }
 */
export function computePairings({ gaugeData, rainfallData, geojson, windowKey }) {
  const out = { window: windowKey, pairs: [], n_pairs: 0, n_pairs_valid: 0 };
  if (!gaugeData || !Array.isArray(gaugeData.stations) || !rainfallData || !geojson) return out;

  const catchments = rainfallData.catchments || {};
  const features = (geojson.features || []);

  for (const station of gaugeData.stations) {
    const totals = (station && station.totals_mm) || {};
    const gaugeTotal = totals[windowKey];
    const lonlat = station.lonlat || [null, null];
    const [lon, lat] = lonlat;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    let pairedFeature = null;
    let method = 'nearest-centroid';
    let distanceKm = Infinity;

    // Step 1 — strict containment via point-in-polygon
    for (const f of features) {
      if (pointInFeature(lon, lat, f)) {
        pairedFeature = f;
        method = 'point-in-polygon';
        distanceKm = 0;
        break;
      }
    }
    // Step 2 — nearest centroid fallback
    if (!pairedFeature) {
      let bestKm = Infinity, bestFeat = null;
      for (const f of features) {
        const p = f.properties || {};
        if (typeof p.centroid_lon !== 'number' || typeof p.centroid_lat !== 'number') continue;
        const km = haversineKm(lon, lat, p.centroid_lon, p.centroid_lat);
        if (km < bestKm) { bestKm = km; bestFeat = f; }
      }
      pairedFeature = bestFeat;
      distanceKm = bestKm;
    }

    if (!pairedFeature) continue;
    const cid = pairedFeature.properties && pairedFeature.properties.catchment_id;
    const cRow = cid ? catchments[cid] : null;
    const radarTotal = (cRow && typeof cRow.present_total_mm === 'number') ? cRow.present_total_mm : null;

    const bias = (typeof gaugeTotal === 'number' && typeof radarTotal === 'number' && radarTotal > 1e-6)
      ? gaugeTotal / radarTotal
      : null;
    const residual = (typeof gaugeTotal === 'number' && typeof radarTotal === 'number')
      ? Math.round((gaugeTotal - radarTotal) * 1000) / 1000
      : null;
    const valid = Number.isFinite(bias) && bias > 0;

    out.pairs.push({
      station_id:           station.station_id,
      station_name:         station.station_name,
      gauge_lonlat:         lonlat,
      paired_catchment_id:  cid,
      method,
      distance_km:          round2(distanceKm),
      gauge_total_mm:       round3(gaugeTotal),
      radar_total_mm:       round3(radarTotal),
      bias_ratio:           round3(bias),
      residual_mm:          residual,
      valid,
    });
  }
  out.n_pairs = out.pairs.length;
  out.n_pairs_valid = out.pairs.filter((p) => p.valid).length;
  return out;
}

export function summarisePairings(pairings) {
  const valid = (pairings && pairings.pairs ? pairings.pairs : [])
    .filter((p) => p.valid && Number.isFinite(p.bias_ratio));
  if (valid.length === 0) {
    return {
      n_pairs: pairings ? pairings.n_pairs : 0,
      n_pairs_valid: 0,
      median_bias_ratio: null,
      mean_bias_ratio: null,
      mean_residual_mm: null,
      max_abs_residual_mm: null,
      stations_under_radar: 0,
      stations_over_radar:  0,
    };
  }
  const ratios = valid.map((p) => p.bias_ratio).sort((a, b) => a - b);
  const median = ratios.length % 2
    ? ratios[(ratios.length - 1) / 2]
    : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const residuals = valid.map((p) => p.residual_mm).filter((r) => Number.isFinite(r));
  const meanResidual = residuals.length
    ? residuals.reduce((a, b) => a + b, 0) / residuals.length
    : null;
  const maxAbsResidual = residuals.length
    ? Math.max(...residuals.map(Math.abs))
    : null;
  return {
    n_pairs:               valid.length,
    n_pairs_valid:         valid.length,
    median_bias_ratio:     round3(median),
    mean_bias_ratio:       round3(mean),
    mean_residual_mm:      meanResidual != null ? round3(meanResidual) : null,
    max_abs_residual_mm:   maxAbsResidual != null ? round3(maxAbsResidual) : null,
    stations_under_radar:  valid.filter((p) => p.bias_ratio < 1).length,
    stations_over_radar:   valid.filter((p) => p.bias_ratio > 1).length,
  };
}

/* ────────────────────────────────────────────────────────────────────
   Per-catchment calibration factors via IDW from valid pairings
   ──────────────────────────────────────────────────────────────────── */

export function computeCalibrationFactors({ pairings, geojson, exponent = IDW_EXPONENT }) {
  const out = {
    factor_by_catchment: {},
    nearest_pair_distance_km_by_catchment: {},
    method: 'idw_p' + exponent,
  };
  const valid = (pairings && pairings.pairs ? pairings.pairs : [])
    .filter((p) => p.valid && Number.isFinite(p.bias_ratio));
  if (!geojson || valid.length === 0) return out;

  const features = geojson.features || [];
  for (const f of features) {
    const props = f.properties || {};
    const cid = props.catchment_id;
    if (!cid) continue;
    const clon = props.centroid_lon, clat = props.centroid_lat;
    if (!Number.isFinite(clon) || !Number.isFinite(clat)) continue;

    let num = 0, den = 0, nearest = Infinity;
    for (const p of valid) {
      const [glon, glat] = p.gauge_lonlat || [null, null];
      if (!Number.isFinite(glon) || !Number.isFinite(glat)) continue;
      const d = haversineKm(clon, clat, glon, glat);
      if (d < nearest) nearest = d;
      const d_eff = Math.max(d, 0.05);   // 50 m floor (d in km) — prevents single-gauge dominance
      const w = 1 / (d_eff ** IDW_EXPONENT);
      num += p.bias_ratio * w;
      den += w;
    }
    const factor = den > 0 ? num / den : null;
    if (factor !== null) {
      out.factor_by_catchment[cid] = round3(factor);
    } else {
      // No contributing gauge pairs — record explicitly; do not store a 1.0 identity value
      out.factor_by_catchment[cid] = null;
      out.no_pairs_catchments = out.no_pairs_catchments || [];
      out.no_pairs_catchments.push(cid);
    }
    out.nearest_pair_distance_km_by_catchment[cid] = round2(nearest === Infinity ? null : nearest);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────
   Apply calibration → returns a parallel rainfall_data
   ──────────────────────────────────────────────────────────────────── */

/**
 * Returns a deep-cloned rainfall_data object whose totals are calibrated.
 * Raw values are preserved as `raw_total_mm` (catchment) and
 * `raw_max_total_mm` (each duration_stats entry). Confidence is recomputed
 * to reflect calibration distance per `deriveCalibrationConfidence`.
 *
 * The function is a pure data transform — no DOM, no fetches.
 */
export function applyCalibration({ rainfallData, calibrationFactors }) {
  if (!rainfallData) return rainfallData;
  const factors = calibrationFactors && calibrationFactors.factor_by_catchment;
  const distances = calibrationFactors && calibrationFactors.nearest_pair_distance_km_by_catchment;
  if (!factors || Object.keys(factors).length === 0) {
    // No calibration — return a tagged copy so consumers can detect
    // "calibrated mode but identity transform".
    return tagCopy(rainfallData, {});
  }

  const out = JSON.parse(JSON.stringify(rainfallData));
  out.calibration_applied = true;
  out.calibration_method  = calibrationFactors.method;

  if (out.catchments) {
    for (const cid of Object.keys(out.catchments)) {
      const c = out.catchments[cid];
      if (!c) continue;
      const f = factors[cid];
      const dist = distances ? distances[cid] : null;
      c.calibration_factor       = (typeof f === 'number') ? f : 1.0;
      c.nearest_gauge_distance_km = (typeof dist === 'number') ? dist : null;

      // Preserve raw + apply factor at the catchment level
      if (typeof c.present_total_mm === 'number') {
        c.raw_present_total_mm = c.present_total_mm;
        c.present_total_mm = round3(c.present_total_mm * c.calibration_factor);
      }
      // Mean / min / max scale the same way (uniform multiplicative).
      for (const k of ['mean_mm', 'min_mm', 'max_mm']) {
        if (typeof c[k] === 'number') {
          c['raw_' + k] = c[k];
          c[k] = round3(c[k] * c.calibration_factor);
        }
      }

      // Duration stats are uncalibrated radar sub-window estimates.
      // Calibration applies only to the accumulation-window total
      // (present_total_mm). Sub-window numeric values remain unchanged.
      if (c.duration_stats) {
        for (const dk of Object.keys(c.duration_stats)) {
          const ds = c.duration_stats[dk];
          if (!ds) continue;
          ds.calibration_applied = false;
        }
      }

      // Calibration-aware confidence — preserve raw confidence first.
      if (typeof c.confidence !== 'undefined') {
        c.raw_confidence = c.confidence;
        c.confidence = deriveCalibrationConfidence(c.confidence, c.nearest_gauge_distance_km);
      }
    }
  }
  return out;
}

/** Clone with a tag so callers can tell the data has gone through the
    pipeline even if no factors applied. */
function tagCopy(rainfallData, factorsByCatchment) {
  const clone = JSON.parse(JSON.stringify(rainfallData));
  clone.calibration_applied = false;
  clone.calibration_method  = 'identity_no_pairs';
  if (clone.catchments) {
    for (const cid of Object.keys(clone.catchments)) {
      const c = clone.catchments[cid];
      if (!c) continue;
      c.calibration_factor = null;
      c.calibration_mode   = 'identity_no_pairs';
      c.nearest_gauge_distance_km = null;
      if (typeof c.present_total_mm === 'number') c.raw_present_total_mm = c.present_total_mm;
    }
  }
  return clone;
}

/** Step the confidence tier down by one when the nearest gauge is far. */
export function deriveCalibrationConfidence(rawConfidence, nearestGaugeDistanceKm) {
  const v = String(rawConfidence || '').toLowerCase();
  if (typeof nearestGaugeDistanceKm !== 'number' || nearestGaugeDistanceKm <= MAX_PAIR_DISTANCE_KM) return v;
  if (v === 'high')   return 'medium';
  if (v === 'medium') return 'low';
  return v; // already low/unknown — don't go further
}

/* ────────────────────────────────────────────────────────────────────
   UI: mode selector + summary panel
   ──────────────────────────────────────────────────────────────────── */

export function renderCalibrationModeSelector(host, { mode = 'raw', onChange, gaugeOk = true }) {
  if (!host) return;
  host.classList.add('stormgrid-calibmodewrap');
  const calibratedDisabled = !gaugeOk;
  host.innerHTML = `
    <div class="stormgrid-calibmode" role="radiogroup" aria-label="Rainfall mode">
      <span class="stormgrid-calibmode__label">Rainfall mode:</span>
      <button type="button" role="radio"
              class="stormgrid-calibmode__btn ${mode === 'raw' ? 'stormgrid-calibmode__btn--active' : ''}"
              data-mode="raw" aria-checked="${mode === 'raw'}">
        Raw radar
      </button>
      <button type="button" role="radio"
              class="stormgrid-calibmode__btn ${mode === 'calibrated' ? 'stormgrid-calibmode__btn--active' : ''}"
              data-mode="calibrated" aria-checked="${mode === 'calibrated'}"
              ${calibratedDisabled ? 'disabled aria-disabled="true" title="Gauge observations not loaded"' : ''}>
        Calibrated rainfall
      </button>
    </div>
  `;
  host.querySelectorAll('button[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.mode;
      if (typeof onChange === 'function') onChange(m);
    });
  });
}

export function renderCalibrationPanel(host, {
  mode,
  gaugeData,
  gaugeError,
  pairings,
  summary,
  factors,
  selectedCatchmentId,
} = {}) {
  if (!host) return;
  host.classList.add('stormgrid-calibwrap');

  if (gaugeError) {
    host.innerHTML = `
      <h3 class="stormgrid-calib__head">Calibration</h3>
      <p class="stormgrid-calib__empty stormgrid-calib__empty--error">
        Could not load gauge observations: ${escapeHtml(gaugeError)}
      </p>
    `;
    return;
  }
  if (!gaugeData) {
    host.innerHTML = `
      <h3 class="stormgrid-calib__head">Calibration</h3>
      <p class="stormgrid-calib__empty">Loading gauge observations…</p>
    `;
    return;
  }

  const synth = !!gaugeData.is_synthetic;
  const banner = synth ? `
    <div class="stormgrid-calib__synthbanner" role="status">
      <strong>Synthetic gauge data</strong> — calibrated values are illustrative only. Run
      <code>scripts/build_gauge_observations.py</code> to replace with real BOM/MHL feeds.
    </div>
  ` : '';

  const summaryHtml = summary && summary.n_pairs_valid > 0 ? `
    <dl class="stormgrid-calib__summary">
      <div><dt>Pairs (valid)</dt><dd>${summary.n_pairs_valid} / ${summary.n_pairs}</dd></div>
      <div><dt>Median bias</dt><dd>${summary.median_bias_ratio != null ? summary.median_bias_ratio.toFixed(3) : '—'}</dd></div>
      <div><dt>Mean bias</dt><dd>${summary.mean_bias_ratio != null ? summary.mean_bias_ratio.toFixed(3) : '—'}</dd></div>
      <div><dt>Mean residual</dt><dd>${summary.mean_residual_mm != null ? summary.mean_residual_mm.toFixed(3) + ' mm' : '—'}</dd></div>
      <div><dt>Max |residual|</dt><dd>${summary.max_abs_residual_mm != null ? summary.max_abs_residual_mm.toFixed(3) + ' mm' : '—'}</dd></div>
      <div><dt>Under / Over</dt><dd>${summary.stations_under_radar} under · ${summary.stations_over_radar} over</dd></div>
    </dl>
  ` : `
    <p class="stormgrid-calib__empty">No valid pairings for this window — calibrated mode degrades to identity.</p>
  `;

  const pairsHtml = (pairings && pairings.pairs && pairings.pairs.length) ? `
    <table class="stormgrid-calib__pairs">
      <thead><tr>
        <th>Station</th><th>Catchment</th><th>Method</th>
        <th class="num">Gauge</th><th class="num">Radar</th>
        <th class="num">Bias</th><th class="num">Residual</th>
      </tr></thead>
      <tbody>
        ${pairings.pairs.map((p) => `
          <tr class="${p.valid ? '' : 'stormgrid-calib__pairs-invalid'}">
            <td title="${escapeAttr(p.gauge_lonlat ? p.gauge_lonlat.join(', ') : '')}">${escapeHtml(p.station_name)}<br><small>${escapeHtml(p.station_id)}</small></td>
            <td>${escapeHtml(p.paired_catchment_id || '—')}<br><small>${escapeHtml(p.method)} · ${p.distance_km != null ? p.distance_km.toFixed(2) + ' km' : '—'}</small></td>
            <td><span class="stormgrid-calib__methodpill">${escapeHtml(p.method)}</span></td>
            <td class="num">${formatMm(p.gauge_total_mm)}</td>
            <td class="num">${formatMm(p.radar_total_mm)}</td>
            <td class="num">${p.bias_ratio != null ? p.bias_ratio.toFixed(3) : '—'}</td>
            <td class="num">${formatMm(p.residual_mm)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : '';

  const selectedFactor = (factors && selectedCatchmentId)
    ? factors.factor_by_catchment[selectedCatchmentId]
    : null;
  const selectedDistance = (factors && selectedCatchmentId)
    ? factors.nearest_pair_distance_km_by_catchment[selectedCatchmentId]
    : null;
  const selectedCatchmentLine = selectedCatchmentId ? `
    <div class="stormgrid-calib__selected">
      <strong>Selected catchment ${escapeHtml(selectedCatchmentId)}:</strong>
      factor <code>${selectedFactor != null ? selectedFactor.toFixed(3) : '—'}</code>
      · nearest gauge ${selectedDistance != null ? selectedDistance.toFixed(2) + ' km' : '—'}
    </div>
  ` : '';

  host.innerHTML = `
    <header class="stormgrid-calib__head-row">
      <h3 class="stormgrid-calib__head">Calibration</h3>
      <span class="stormgrid-calib__meta">
        mode: <strong>${escapeHtml(mode || 'raw')}</strong>
        · ${escapeHtml(gaugeData.method || 'multiplicative_bias_idw')}
      </span>
    </header>
    ${banner}
    ${summaryHtml}
    ${selectedCatchmentLine}
    ${pairsHtml}
    <p class="stormgrid-calib__safety">${escapeHtml(METHODOLOGY_NOTE)}</p>
  `;
}

/* ────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────── */

export const CALIBRATION_METHODOLOGY_NOTE = METHODOLOGY_NOTE;
export const CALIBRATION_MAX_PAIR_DISTANCE_KM = MAX_PAIR_DISTANCE_KM;

function round2(n) { return (typeof n === 'number' && Number.isFinite(n)) ? Math.round(n * 100) / 100 : null; }
function round3(n) { return (typeof n === 'number' && Number.isFinite(n)) ? Math.round(n * 1000) / 1000 : null; }
function formatMm(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? `${v.toFixed(2)} mm` : '—';
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace