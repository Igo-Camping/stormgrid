/* Stormgrid — infrastructure exposure layer (Phase 15).

   Reads data/stormwater_assets.json (a FeatureCollection of stormwater
   asset Points), associates each asset with the parent catchment it
   carries in its properties, and computes an inspection-priority score
   that combines:

     - rainfall  (catchment total in the active accumulation window)
     - condition (asset condition grade, 1=excellent → 5=very poor)
     - size      (smaller → higher priority — proxy for capacity)
     - class     (relative susceptibility weighting)

   The score is a transparent heuristic for OPERATIONAL TRIAGE only. It
   is NOT a failure prediction, NOT an assertion of design exceedance,
   NOT an AEP classification, NOT a return-period assignment, NOT a
   legal-liability indicator. Wording across panels and exports is
   methodology-safe. */

const ASSETS_URL = './data/stormwater_assets.json';

let cached = null;

export const ASSET_CLASSES = ['pit', 'pipe', 'culvert', 'headwall', 'open_channel', 'scour_protection'];
export const CONDITION_GRADES = [1, 2, 3, 4, 5];
export const PRIORITY_TIERS = ['low', 'medium', 'high', 'urgent'];

const CLASS_WEIGHT = {
  pit:              0.60,
  pipe:             0.70,
  culvert:          0.85,
  headwall:         0.55,
  open_channel:     0.70,
  scour_protection: 0.50,
};
const W_RAIN  = 0.45;
const W_COND  = 0.30;
const W_SIZE  = 0.15;
const W_CLASS = 0.10;

const TIER_THRESHOLDS = [
  { tier: 'low',     max: 0.30 },
  { tier: 'medium',  max: 0.50 },
  { tier: 'high',    max: 0.70 },
  { tier: 'urgent',  max: Infinity },
];

const TIER_COLOURS = {
  low:    '#3CB371',
  medium: '#E0A030',
  high:   '#C0773A',
  urgent: '#C0392B',
};

export const ASSETS_METHODOLOGY_NOTE =
  'Inspection-priority scoring is a transparent triage heuristic ' +
  '(score = ' + W_RAIN + ' * rainfall_norm + ' + W_COND + ' * condition_norm + ' +
  W_SIZE + ' * size_inv_norm + ' + W_CLASS + ' * class_weight). ' +
  'Tier thresholds: low <0.30, medium <0.50, high <0.70, urgent ≥0.70. ' +
  'Operational triage only. NOT a failure prediction, NOT an assertion ' +
  'of design exceedance, NOT an AEP classification, NOT a return-period ' +
  'assignment, NOT a legal-liability indicator.';

/* ────────────────────────────────────────────────────────────────────
   Loader
   ──────────────────────────────────────────────────────────────────── */

export async function loadAssets(url = ASSETS_URL) {
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

export function clearAssetsCache() { cached = null; }

/* ────────────────────────────────────────────────────────────────────
   Index + filter helpers
   ──────────────────────────────────────────────────────────────────── */

export function indexAssetsByCatchment(assetsCollection) {
  const out = {};
  if (!assetsCollection || !Array.isArray(assetsCollection.features)) return out;
  for (const f of assetsCollection.features) {
    const cid = f.properties && f.properties.catchment_id;
    if (!cid) continue;
    if (!out[cid]) out[cid] = [];
    out[cid].push(f);
  }
  return out;
}

export function defaultAssetFilters() {
  return {
    classes:        new Set(ASSET_CLASSES),
    conditions:     new Set(CONDITION_GRADES),
    minSize:        null,
    maxSize:        null,
    priorityTiers:  new Set(PRIORITY_TIERS),
    catchmentScope: null,         // when set, only assets in this catchment_id are kept
  };
}

export function applyAssetFilters(rows, filters) {
  if (!Array.isArray(rows) || !filters) return rows || [];
  return rows.filter((r) => {
    if (filters.catchmentScope && r.catchment_id !== filters.catchmentScope) return false;
    if (filters.classes && filters.classes.size && !filters.classes.has(r.asset_class)) return false;
    if (filters.conditions && filters.conditions.size && !filters.conditions.has(r.condition_grade)) return false;
    if (filters.priorityTiers && filters.priorityTiers.size && !filters.priorityTiers.has(r.priority_tier)) return false;
    if (filters.minSize != null && Number.isFinite(filters.minSize)
        && (typeof r.size_mm !== 'number' || r.size_mm < filters.minSize)) return false;
    if (filters.maxSize != null && Number.isFinite(filters.maxSize)
        && (typeof r.size_mm !== 'number' || r.size_mm > filters.maxSize)) return false;
    return true;
  });
}

/* ────────────────────────────────────────────────────────────────────
   Exposure model
   ──────────────────────────────────────────────────────────────────── */

/**
 * Build per-asset exposure rows from the active rainfall_data + assets.
 * Returns:
 *   { rows, datasetMaxRainfallMm, datasetMaxCriticalMm }
 * where rows = [{
 *   asset_id, catchment_id, asset_class, size_mm, condition_grade,
 *   material, install_year, lonlat,
 *   total_mm, raw_total_mm, calibration_factor, critical_max_mm,
 *   priority_score, priority_tier,
 *   inputs: { rainfall_norm, condition_norm, size_inv_norm, class_weight }
 * }, ...]
 */
export function computeAssetExposure({ assets, rainfallData, durationKey, calibrationMode }) {
  const out = { rows: [], dataset_max_rainfall_mm: 0, dataset_max_critical_mm: 0 };
  if (!assets || !Array.isArray(assets.features) || !rainfallData || !rainfallData.catchments) return out;

  const catchments = rainfallData.catchments;

  // First pass — compute the dataset extrema for normalisation.
  let maxRain = 0, maxCrit = 0;
  for (const f of assets.features) {
    const cid = f.properties && f.properties.catchment_id;
    const c = cid ? catchments[cid] : null;
    if (!c) continue;
    const tm = typeof c.total_mm === 'number' ? c.total_mm : 0;
    if (tm > maxRain) maxRain = tm;
    const dk = durationKey;
    const ds = (dk && c.duration_stats) ? c.duration_stats[dk] : null;
    const cm = ds && typeof ds.max_total_mm === 'number' ? ds.max_total_mm : 0;
    if (cm > maxCrit) maxCrit = cm;
  }
  out.dataset_max_rainfall_mm = round2(maxRain);
  out.dataset_max_critical_mm = round2(maxCrit);

  for (const f of assets.features) {
    const props = f.properties || {};
    const cid = props.catchment_id;
    const c = cid ? catchments[cid] : null;
    const tm = c && typeof c.total_mm === 'number' ? c.total_mm : null;
    const rawTm = c && typeof c.raw_total_mm === 'number' ? c.raw_total_mm : null;
    const cf = c && typeof c.calibration_factor === 'number' ? c.calibration_factor : null;
    const ds = (durationKey && c && c.duration_stats) ? c.duration_stats[durationKey] : null;
    const critical = ds && typeof ds.max_total_mm === 'number' ? ds.max_total_mm : null;

    // Normalised inputs in [0,1]
    const rainNorm = (typeof tm === 'number' && maxRain > 0) ? clamp01(tm / maxRain) : 0;
    const condNorm = (typeof props.condition_grade === 'number')
      ? clamp01((props.condition_grade - 1) / 4)
      : 0;
    const size = (typeof props.size_mm === 'number') ? props.size_mm : null;
    const sizeInvNorm = (size != null) ? clamp01(1 - Math.min(size / 1500, 1)) : 0.5;
    const classWeight = CLASS_WEIGHT[props.asset_class] != null ? CLASS_WEIGHT[props.asset_class] : 0.6;

    const score = round3(W_RAIN * rainNorm + W_COND * condNorm + W_SIZE * sizeInvNorm + W_CLASS * classWeight);
    const tier = pickTier(score);

    const lonlat = (f.geometry && f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates))
      ? f.geometry.coordinates : null;

    out.rows.push({
      asset_id:         props.asset_id,
      catchment_id:     cid || null,
      asset_class:      props.asset_class || null,
      size_mm:          size,
      condition_grade:  props.condition_grade,
      material:         props.material || null,
      install_year:     props.install_year || null,
      lonlat,
      total_mm:         (tm != null) ? round3(tm) : null,
      raw_total_mm:     (rawTm != null) ? round3(rawTm) : null,
      calibration_factor: cf,
      critical_max_mm:  (critical != null) ? round3(critical) : null,
      priority_score:   score,
      priority_tier:    tier,
      inputs: {
        rainfall_norm:  round3(rainNorm),
        condition_norm: round3(condNorm),
        size_inv_norm:  round3(sizeInvNorm),
        class_weight:   classWeight,
      },
      calibration_mode: calibrationMode || 'raw',
    });
  }
  out.rows.sort((a, b) => b.priority_score - a.priority_score);
  return out;
}

function pickTier(score) {
  for (const t of TIER_THRESHOLDS) if (score < t.max) return t.tier;
  return 'urgent';
}

export function summariseExposure(rows) {
  const tiers = { low: 0, medium: 0, high: 0, urgent: 0 };
  let n = 0, scoreSum = 0;
  for (const r of (rows || [])) {
    n += 1;
    scoreSum += r.priority_score || 0;
    if (tiers[r.priority_tier] != null) tiers[r.priority_tier] += 1;
  }
  return {
    asset_count: n,
    mean_priority_score: n ? round3(scoreSum / n) : null,
    tier_counts: tiers,
  };
}

/* ────────────────────────────────────────────────────────────────────
   Map overlay
   ──────────────────────────────────────────────────────────────────── */

const MARKER_RADIUS = 5;

/**
 * Draw or refresh asset circle-markers on the existing Leaflet map.
 * mapHandle is the value returned by mountCatchmentMap. Returns the
 * Leaflet LayerGroup so callers can keep a reference.
 */
export function applyAssetOverlay(mapHandle, exposureRows, filters) {
  if (!mapHandle || !mapHandle.map || !window.L) return null;
  const L = window.L;
  if (!mapHandle._assetLayer) {
    mapHandle._assetLayer = L.layerGroup().addTo(mapHandle.map);
  } else {
    mapHandle._assetLayer.clearLayers();
  }

  const filtered = applyAssetFilters(exposureRows || [], filters || defaultAssetFilters());
  for (const r of filtered) {
    if (!r.lonlat || r.lonlat.length < 2) continue;
    const [lon, lat] = r.lonlat;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const colour = TIER_COLOURS[r.priority_tier] || '#777';
    const m = L.circleMarker([lat, lon], {
      radius: MARKER_RADIUS,
      color: '#1a1f2b',
      weight: 1,
      fillColor: colour,
      fillOpacity: 0.85,
      opacity: 0.9,
    });
    m.bindTooltip(buildAssetTooltip(r), { className: 'stormgrid-tooltip', sticky: true });
    m.addTo(mapHandle._assetLayer);
  }
  return mapHandle._assetLayer;
}

function buildAssetTooltip(r) {
  const sizeStr = (typeof r.size_mm === 'number') ? `${r.size_mm} mm` : '—';
  const totalStr = (typeof r.total_mm === 'number') ? `${r.total_mm.toFixed(2)} mm` : '—';
  const critStr = (typeof r.critical_max_mm === 'number') ? `${r.critical_max_mm.toFixed(2)} mm` : '—';
  const tierUpper = String(r.priority_tier || '').toUpperCase();
  return `
    <strong>${escapeHtml(r.asset_id)}</strong><br>
    ${escapeHtml(r.asset_class || '')} · ${escapeHtml(sizeStr)} · cond ${r.condition_grade ?? '—'}<br>
    Catchment: ${escapeHtml(r.catchment_id || '—')}<br>
    Window total: ${escapeHtml(totalStr)} · Critical: ${escapeHtml(critStr)}<br>
    <strong>Priority ${tierUpper}</strong> · score ${r.priority_score != null ? r.priority_score.toFixed(3) : '—'}
  `;
}

/* ────────────────────────────────────────────────────────────────────
   Filter UI
   ──────────────────────────────────────────────────────────────────── */

export function renderAssetFilters(host, { filters, onChange, datasetCount, filteredCount } = {}) {
  if (!host) return;
  host.classList.add('stormgrid-assetfilterswrap');
  const f = filters || defaultAssetFilters();

  host.innerHTML = `
    <div class="stormgrid-assetfilters" role="group" aria-label="Asset filters">
      <div class="stormgrid-assetfilters__row">
        <span class="stormgrid-assetfilters__label">Class</span>
        ${ASSET_CLASSES.map((c) => `
          <label class="stormgrid-assetfilters__chip">
            <input type="checkbox" data-kind="class" data-value="${escapeAttr(c)}" ${f.classes.has(c) ? 'checked' : ''}>
            ${escapeHtml(prettyClass(c))}
          </label>
        `).join('')}
      </div>
      <div class="stormgrid-assetfilters__row">
        <span class="stormgrid-assetfilters__label">Condition</span>
        ${CONDITION_GRADES.map((g) => `
          <label class="stormgrid-assetfilters__chip stormgrid-assetfilters__chip--cond-${g}">
            <input type="checkbox" data-kind="condition" data-value="${g}" ${f.conditions.has(g) ? 'checked' : ''}>
            ${g}
          </label>
        `).join('')}
      </div>
      <div class="stormgrid-assetfilters__row">
        <span class="stormgrid-assetfilters__label">Priority</span>
        ${PRIORITY_TIERS.map((t) => `
          <label class="stormgrid-assetfilters__chip stormgrid-assetfilters__chip--tier-${t}">
            <input type="checkbox" data-kind="tier" data-value="${escapeAttr(t)}" ${f.priorityTiers.has(t) ? 'checked' : ''}>
            ${escapeHtml(t)}
          </label>
        `).join('')}
      </div>
      <div class="stormgrid-assetfilters__row">
        <span class="stormgrid-assetfilters__label">Size (mm)</span>
        <input type="number" data-kind="minSize" placeholder="min" value="${f.minSize ?? ''}" min="0" step="50" class="stormgrid-assetfilters__num">
        <input type="number" data-kind="maxSize" placeholder="max" value="${f.maxSize ?? ''}" min="0" step="50" class="stormgrid-assetfilters__num">
        ${f.catchmentScope ? `
          <span class="stormgrid-assetfilters__scope">
            Scoped to <strong>${escapeHtml(f.catchmentScope)}</strong>
            <button type="button" class="stormgrid-assetfilters__chipbtn" data-kind="clearScope">×</button>
          </span>` : ''}
        <span class="stormgrid-assetfilters__count">${filteredCount ?? '—'} / ${datasetCount ?? '—'} assets</span>
        <button type="button" class="stormgrid-assetfilters__chipbtn" data-kind="reset">Reset</button>
      </div>
    </div>
  `;

  host.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const kind = cb.dataset.kind;
      const value = cb.dataset.value;
      const next = cloneFilters(f);
      const set = kind === 'class' ? next.classes
                : kind === 'condition' ? next.conditions
                : kind === 'tier' ? next.priorityTiers
                : null;
      if (!set) return;
      const v = (kind === 'condition') ? Number(value) : value;
      if (cb.checked) set.add(v); else set.delete(v);
      if (typeof onChange === 'function') onChange(next);
    });
  });
  host.querySelectorAll('input[type="number"]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const next = cloneFilters(f);
      const v = inp.value === '' ? null : Number(inp.value);
      if (inp.dataset.kind === 'minSize') next.minSize = (v != null && Number.isFinite(v)) ? v : null;
      if (inp.dataset.kind === 'maxSize') next.maxSize = (v != null && Number.isFinite(v)) ? v : null;
      if (typeof onChange === 'function') onChange(next);
    });
  });
  host.querySelectorAll('button[data-kind]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (typeof onChange !== 'function') return;
      if (btn.dataset.kind === 'reset') onChange(defaultAssetFilters());
      if (btn.dataset.kind === 'clearScope') {
        const next = cloneFilters(f);
        next.catchmentScope = null;
        onChange(next);
      }
    });
  });
}

function cloneFilters(f) {
  return {
    classes:        new Set(f.classes),
    conditions:     new Set(f.conditions),
    minSize:        f.minSize,
    maxSize:        f.maxSize,
    priorityTiers:  new Set(f.priorityTiers),
    catchmentScope: f.catchmentScope || null,
  };
}

/* ────────────────────────────────────────────────────────────────────
   Infrastructure exposure panel
   ──────────────────────────────────────────────────────────────────── */

export function renderInfrastructureExposurePanel(host, {
  loadResult,
  filteredRows,
  datasetCount,
  summary,
  scopedCatchmentId,
  calibrationMode,
} = {}) {
  if (!host) return;
  host.classList.add('stormgrid-infrawrap');

  if (loadResult && loadResult.ok === false) {
    host.innerHTML = `
      <h3 class="stormgrid-infra__head">Infrastructure exposure</h3>
      <p class="stormgrid-infra__empty stormgrid-infra__empty--error">Could not load assets: ${escapeHtml(loadResult.error || 'unknown')}</p>
    `;
    return;
  }
  if (!loadResult || !loadResult.data) {
    host.innerHTML = `
      <h3 class="stormgrid-infra__head">Infrastructure exposure</h3>
      <p class="stormgrid-infra__empty">Loading assets…</p>
    `;
    return;
  }
  const meta = loadResult.data.metadata || {};
  const synthBanner = meta.is_synthetic ? `
    <div class="stormgrid-infra__synthbanner" role="status">
      <strong>Synthetic asset register</strong> — exposure scores are illustrative only.
      Run <code>scripts/build_assets.py</code> after wiring TechnologyOne / Intramaps exports to replace.
    </div>
  ` : '';

  const top = (filteredRows || []).slice(0, 12);
  const tiers = (summary && summary.tier_counts) || { low: 0, medium: 0, high: 0, urgent: 0 };

  const tableHtml = top.length === 0 ? `
    <p class="stormgrid-infra__empty">No assets match the current filters${scopedCatchmentId ? ` for catchment ${escapeHtml(scopedCatchmentId)}` : ''}.</p>
  ` : `
    <table class="stormgrid-infra__table">
      <thead><tr>
        <th>Asset</th><th>Class</th><th>Size</th><th>Cond</th>
        <th>Catchment</th><th class="num">Total</th><th class="num">Critical</th>
        <th class="num">Score</th><th>Tier</th>
      </tr></thead>
      <tbody>
        ${top.map((r) => `
          <tr class="stormgrid-infra__row stormgrid-infra__row--${escapeAttr(r.priority_tier)}">
            <td>${escapeHtml(r.asset_id)}</td>
            <td>${escapeHtml(prettyClass(r.asset_class))}<br><small>${escapeHtml(r.material || '')}</small></td>
            <td>${typeof r.size_mm === 'number' ? r.size_mm + ' mm' : '—'}</td>
            <td>${r.condition_grade ?? '—'}</td>
            <td>${escapeHtml(r.catchment_id || '—')}</td>
            <td class="num">${typeof r.total_mm === 'number' ? r.total_mm.toFixed(2) : '—'}</td>
            <td class="num">${typeof r.critical_max_mm === 'number' ? r.critical_max_mm.toFixed(2) : '—'}</td>
            <td class="num">${r.priority_score != null ? r.priority_score.toFixed(3) : '—'}</td>
            <td><span class="stormgrid-infra__tierpill stormgrid-infra__tierpill--${escapeAttr(r.priority_tier)}">${escapeHtml(r.priority_tier)}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${(filteredRows && filteredRows.length > top.length) ? `<p class="stormgrid-infra__more">…and ${filteredRows.length - top.length} more after the top 12. Export JSON to see all rows.</p>` : ''}
  `;

  host.innerHTML = `
    <header class="stormgrid-infra__head-row">
      <h3 class="stormgrid-infra__head">Infrastructure exposure ${scopedCatchmentId ? `<small>· catchment ${escapeHtml(scopedCatchmentId)}</small>` : ''}</h3>
      <span class="stormgrid-infra__meta">${(filteredRows || []).length} of ${datasetCount} assets · mode <strong>${escapeHtml(calibrationMode || 'raw')}</strong></span>
    </header>
    ${synthBanner}
    <ul class="stormgrid-infra__tiercounts" role="list">
      ${PRIORITY_TIERS.map((t) => `
        <li class="stormgrid-infra__tier stormgrid-infra__tier--${t}">
          <span class="stormgrid-infra__tierlabel">${escapeHtml(t)}</span>
          <span class="stormgrid-infra__tiercount">${tiers[t] || 0}</span>
        </li>
      `).join('')}
    </ul>
    ${tableHtml}
    <p class="stormgrid-infra__safety">${escapeHtml(ASSETS_METHODOLOGY_NOTE)}</p>
  `;
}

/* ────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────── */

function prettyClass(c) {
  return String(c || '').replace(/_/g, ' ');
}

function clamp01(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}
function round2(n) { return (typeof n === 'number' && Number.isFinite(n)) ? Math.round(n * 100) / 100 : null; }
function round3(n) { return (typeof n === 'number' && Number.isFinite(n)) ? Math.round(n * 1000) / 1000 : null; }
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, ''); }
