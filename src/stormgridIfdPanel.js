/* Stormgrid — point IFD comparison panel + ARR2019 ARF mode.

   Two display modes:
     'point' — observed catchment-mean rainfall vs point IFD design
                depths at the catchment-centroid reference station.
     'arf'   — observed catchment-mean rainfall vs ARF-adjusted areal
                design rainfall using the ARR2019 long-duration ARF
                form (Book 2 Ch 4).

   Methodology-safe by construction: every cell carries the warning
   that no event AEP / return period / "1 in X" classification is
   being made. ARF mode adds a second warning if coefficients are
   unverified, and another if the (area, duration) falls outside the
   ARR2019 long-duration validity range. */

import { computeArfTable, getRegion, getValidity, isVerified } from './stormgridArf.js';
import { computeDurationComparison, summariseComparisons, COMPARISON_BANDS } from './stormgridDesignComparison.js';
import { buildEventInterpretation } from './stormgridEventInterpretation.js';

const DURATION_KEYS = ['3h', '6h', '12h', '24h', '48h', '72h'];
const AEP_COLUMNS   = ['20%', '5%', '2%', '1%'];

const DURATION_HOURS = { '3h': 3, '6h': 6, '12h': 12, '24h': 24, '48h': 48, '72h': 72 };

export function renderIfdComparisonPanel(host, {
  ifdResult,
  arfResult,
  catchmentId,
  catchmentRow,
  durationStatsByKey,
  catchmentAreaKm2,
  ifdDisplayMode = 'arf',
  onIfdModeChange,
}) {
  host.innerHTML = '';
  host.classList.add('stormgrid-ifdwrap');

  // Always-on warning banner.
  const warn = document.createElement('div');
  warn.className = 'stormgrid-ifd__warn';
  warn.innerHTML = `
    <strong>POINT IFD ONLY · ARF NOT APPLIED</strong> when "Point IFD" is selected.
    Stormgrid never classifies an event AEP, never assigns a return period, never asserts exceedance.
    Catchment-mean rainfall must be compared to ARF-adjusted areal design rainfall before any AEP claim.
  `;
  host.appendChild(warn);

  // Mode toggle.
  const toggleWrap = document.createElement('div');
  toggleWrap.className = 'stormgrid-ifd__modesel';
  toggleWrap.innerHTML = `
    <span class="stormgrid-ifd__modesel-label">Display</span>
    <div class="stormgrid-ifd__modesel-group" role="radiogroup" aria-label="IFD display mode">
      <button type="button" class="stormgrid-ifd__modesel-btn ${ifdDisplayMode === 'point' ? 'stormgrid-ifd__modesel-btn--active' : ''}" data-ifd-mode="point" role="radio" aria-checked="${ifdDisplayMode === 'point'}">Point IFD</button>
      <button type="button" class="stormgrid-ifd__modesel-btn ${ifdDisplayMode === 'arf'   ? 'stormgrid-ifd__modesel-btn--active' : ''}" data-ifd-mode="arf"   role="radio" aria-checked="${ifdDisplayMode === 'arf'  }">ARF-adjusted areal design rainfall</button>
    </div>
  `;
  toggleWrap.querySelectorAll('[data-ifd-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (typeof onIfdModeChange === 'function') onIfdModeChange(btn.dataset.ifdMode);
    });
  });
  host.appendChild(toggleWrap);

  if (!ifdResult) {
    host.appendChild(blockNote('Loading point IFD reference data…'));
    return;
  }
  if (!ifdResult.ok) {
    host.appendChild(blockNote(
      `Point IFD reference unavailable (${escapeHtml(ifdResult.error || 'unknown')}). ` +
      `Run the local generator: <code>python scripts/build_catchment_ifd.py --pluvio-root PATH</code>`,
      'error'
    ));
    return;
  }
  if (!catchmentId) {
    host.appendChild(blockNote('Click a catchment on the map to see point IFD context for its centroid.'));
    return;
  }
  const ifdAll = ifdResult.data;
  const cifd = ifdAll.catchments[catchmentId];
  if (!cifd) {
    host.appendChild(blockNote(`No point IFD reference for <strong>${escapeHtml(catchmentId)}</strong> in this dataset.`));
    return;
  }

  // ── Reference header ─────────────────────────────────────────────────
  const head = document.createElement('header');
  head.className = 'stormgrid-ifd__head';
  const refLon = cifd.reference_station_lonlat ? cifd.reference_station_lonlat[0] : null;
  const refLat = cifd.reference_station_lonlat ? cifd.reference_station_lonlat[1] : null;
  const areaCell = (typeof catchmentAreaKm2 === 'number') ? `${catchmentAreaKm2.toFixed(2)} km²` : '—';
  head.innerHTML = `
    <h3>${ifdDisplayMode === 'arf' ? 'ARF-adjusted areal design rainfall' : 'Point IFD context'}${(ifdDisplayMode === 'point' && Number.isFinite(catchmentAreaKm2) && catchmentAreaKm2 > 1 ? ' <span class="stormgrid-ifd__non-areal-tag" title="Single-point IFD applied to a multi-km² catchment — consider ARF-adjusted mode">non-areal</span>' : '')}
        — <span class="stormgrid-ifd__cid">${escapeHtml(catchmentId)}</span></h3>
    <dl class="stormgrid-ifd__refmeta">
      <div><dt>Reference station</dt>
           <dd>${escapeHtml(cifd.reference_station_name || cifd.reference_station_id || '—')}
               <small>(${escapeHtml(cifd.reference_station_id || '')})</small></dd></div>
      <div><dt>Station coords</dt>
           <dd>${refLat != null && refLon != null
                 ? `${Number(refLat).toFixed(4)}, ${Number(refLon).toFixed(4)}`
                 : '—'}</dd></div>
      <div><dt>Distance from centroid</dt>
           <dd>${typeof cifd.reference_station_distance_km === 'number'
                 ? `${cifd.reference_station_distance_km.toFixed(2)} km` : '—'}</dd></div>
      <div><dt>Catchment area</dt><dd>${areaCell}</dd></div>
    </dl>
  `;
  host.appendChild(head);

  // ── ARF mode banner + per-AEP ARF computation ───────────────────────
  let arfBundle = null;
  if (ifdDisplayMode === 'arf') {
    arfBundle = renderArfBanner(host, { arfResult, catchmentAreaKm2, cifd });
  }

  // ── Comparison table ────────────────────────────────────────────────
  // Cache per-duration comparison so the summary panel can re-use it.
  const comparisonByDuration = {};

  const table = document.createElement('table');
  table.className = 'stormgrid-ifd__table';
  const headerCells = [
    'Duration',
    'Observed catchment rainfall',
    ...(ifdDisplayMode === 'arf' ? ['ARF (mean over AEPs)'] : []),
    ...AEP_COLUMNS.map((p) =>
      ifdDisplayMode === 'arf'
        ? `Areal design ${p} AEP`
        : `Point IFD ${p} AEP`
    ),
    ...(ifdDisplayMode === 'arf' ? ['Comparison band'] : []),
    'Notes',
  ].map((h) => `<th>${escapeHtml(h)}</th>`).join('');

  const bodyRows = DURATION_KEYS.map((dk) => {
    const obs    = (durationStatsByKey || {})[dk];
    const obsVal = obs && typeof obs.max_total_mm === 'number' ? obs.max_total_mm : null;
    const ifdRow = cifd.durations[dk];
    const fmt    = (n) => (typeof n === 'number') ? `${n.toFixed(1)}` : '—';
    const obsCell = obsVal == null ? '—' : `<strong>${obsVal.toFixed(2)}</strong> mm`;

    let arfMeanCell = '';
    let arfPerAep   = null;        // { '1%': arfNum, ... }
    let arfFlags    = new Set();
    if (ifdDisplayMode === 'arf' && arfBundle && arfBundle.coefficientsAvailable && Number.isFinite(catchmentAreaKm2)) {
      const t = computeArfTable({
        areaKm2: catchmentAreaKm2,
        durationHours: DURATION_HOURS[dk],
        aepKeys: AEP_COLUMNS,
        coefficients: arfBundle.coeff,
        validity: arfBundle.validity,
      });
      arfPerAep = {};
      const arfVals = [];
      for (const aep of AEP_COLUMNS) {
        const e = t.arf_by_aep[aep];
        if (e && e.valid === true && Number.isFinite(e.arf)) {
          arfPerAep[aep] = e.arf;
          arfVals.push(e.arf);
        } else {
          arfPerAep[aep] = null;
        }
        if (e && e.flags) e.flags.forEach((f) => arfFlags.add(f));
      }
      const arfMean = arfVals.length ? arfVals.reduce((s, v) => s + v, 0) / arfVals.length : null;
      arfMeanCell = `<td class="stormgrid-ifd__num">${arfMean != null ? arfMean.toFixed(3) : '—'}</td>`;
    } else if (ifdDisplayMode === 'arf') {
      arfMeanCell = `<td class="stormgrid-ifd__num">—</td>`;
    }

    // For ARF mode, build the per-AEP design depths and run the comparison.
    let arfDepthsByAep = null;
    if (ifdDisplayMode === 'arf' && ifdRow && ifdRow.aep && ifdRow.quality_flag !== 'suspect_non_monotonic') {
      arfDepthsByAep = {};
      AEP_COLUMNS.forEach((p) => {
        const v = ifdRow.aep[p];
        const arf = arfPerAep ? arfPerAep[p] : null;
        if (typeof v === 'number' && typeof arf === 'number') {
          arfDepthsByAep[p] = v * arf;
        }
      });
    }
    const comparison = (ifdDisplayMode === 'arf' && arfDepthsByAep && obsVal != null)
      ? computeDurationComparison({ observedMm: obsVal, arfDepthsByAep })
      : null;
    if (comparison) comparisonByDuration[dk] = comparison;

    const aepCells = AEP_COLUMNS.map((p) => {
      if (!ifdRow || !ifdRow.aep) return '—';
      const v = ifdRow.aep[p];
      if (v == null) return '—';
      if (ifdDisplayMode === 'arf') {
        const arf = arfPerAep ? arfPerAep[p] : null;
        // Guard: render em dash if ARF is null or non-finite (including NaN).
        if (arf == null || !Number.isFinite(arf)) return '—';
        const adj = v * arf;
        const r = comparison && comparison.per_aep && comparison.per_aep[p] && comparison.per_aep[p].ratio;
        const ratioFrag = (typeof r === 'number')
          ? ` <small>(${r < 0.01 ? r.toExponential(1) : r.toFixed(2)}×)</small>`
          : '';
        return `${adj.toFixed(1)}${ratioFrag}`;
      }
      return `${fmt(v)}`;
    });

    let comparisonCell = '';
    if (ifdDisplayMode === 'arf') {
      if (comparison && comparison.strongest_band) {
        const band = comparison.strongest_band;
        const label = (COMPARISON_BANDS.find((b) => b.key === band) || {}).label || band;
        const aep = comparison.headline && comparison.headline.reference_aep
          ? ` <small>(rarest: ${escapeHtml(comparison.headline.reference_aep)} AEP)</small>`
          : '';
        comparisonCell = `<td><span class="stormgrid-cmpband stormgrid-cmpband--${escapeAttr(band)}">${escapeHtml(label)}</span>${aep}</td>`;
      } else {
        comparisonCell = `<td class="stormgrid-ifd__notes">—</td>`;
      }
    }

    const notes = [];
    if (!obs) notes.push('No observed data for this duration in the current window.');
    if (!ifdRow) notes.push('No IFD value at this duration in the cache.');
    if (ifdRow && ifdRow.quality_flag === 'suspect_non_monotonic') {
      notes.push('IFD row flagged suspect (non-monotonic vs longer durations) — exclude from comparison.');
    }
    if (ifdDisplayMode === 'arf' && arfFlags.size) {
      const flagPretty = Array.from(arfFlags).map(prettyFlag).filter(Boolean).join('; ');
      if (flagPretty) notes.push(flagPretty);
    }
    const notesText = notes.length ? notes.join(' ') : '';
    const rowClass = (ifdRow && ifdRow.quality_flag) ? ' stormgrid-ifd__row--suspect' : '';
    const arfMeanColCount = ifdDisplayMode === 'arf' ? 1 : 0;
    return `<tr class="stormgrid-ifd__row${rowClass}">
      <td>${escapeHtml(dk)}</td>
      <td class="stormgrid-ifd__num">${obsCell}</td>
      ${arfMeanCell}
      ${aepCells.map((c) => `<td class="stormgrid-ifd__num">${c}</td>`).join('')}
      ${comparisonCell}
      <td class="stormgrid-ifd__notes">${escapeHtml(notesText)}</td>
    </tr>`;
  }).join('');
  table.innerHTML = `<thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody>`;
  host.appendChild(table);

  // ── Chart ────────────────────────────────────────────────────────────
  host.appendChild(renderIfdChart(cifd, durationStatsByKey || {}, {
    ifdDisplayMode, arfBundle, catchmentAreaKm2,
  }));

  // ── ARF-adjusted comparison summary (ARF mode only) ─────────────────
  if (ifdDisplayMode === 'arf' && Object.keys(comparisonByDuration).length > 0) {
    host.appendChild(renderComparisonSummary(comparisonByDuration));

    // ── Event interpretation framework (ARF mode only) ───────────────
    // Inputs needed: arf_verified, min coverage in active set, count of
    // suspect IFD rows in the active set.
    const verified = !!(arfBundle && arfBundle.verified);
    let coverageMin = Infinity;
    let suspectIfdCount = 0;
    DURATION_KEYS.forEach((dk) => {
      const obs = (durationStatsByKey || {})[dk];
      const ifdRow = cifd.durations[dk];
      if (comparisonByDuration[dk] && obs && typeof obs.coverage_pct === 'number') {
        coverageMin = Math.min(coverageMin, obs.coverage_pct / 100);
      }
      if (ifdRow && ifdRow.quality_flag === 'suspect_non_monotonic') suspectIfdCount += 1;
    });
    if (!Number.isFinite(coverageMin)) coverageMin = null;
    const interpretation = buildEventInterpretation({
      catchmentId,
      comparisonByDuration,
      coefficientsVerified: verified,
      observedCoverageMin: coverageMin,
      suspectIfdCount,
    });
    host.appendChild(renderInterpretationPanel(interpretation));
  }

  // ── Footer methodology card ─────────────────────────────────────────
  const foot = document.createElement('p');
  foot.className = 'stormgrid-ifd__foot';
  foot.innerHTML = ifdDisplayMode === 'arf'
    ? `
      ARF-adjusted areal design rainfall computed from the published point IFD
      via the ARR2019 long-duration ARF form (Book 2 Ch. 4).
      Stormgrid does <strong>not</strong> classify an event AEP, does <strong>not</strong>
      compute return periods, and does <strong>not</strong> assert exceedance.
      Verify ARF coefficients against your ARR2019 tables before any engineering use.
    `
    : `
      Point IFD comparison only — ARF not applied.<br>
      Do not interpret this as a catchment AEP classification.<br>
      Catchment-mean rainfall should be compared to ARF-adjusted areal design rainfall before assigning event AEP.
    `;
  host.appendChild(foot);
}

function renderInterpretationPanel(interp) {
  const wrap = document.createElement('section');
  wrap.className = 'stormgrid-interp';
  if (!interp) {
    wrap.innerHTML = '<p class="stormgrid-interp__empty">No interpretation available.</p>';
    return wrap;
  }
  const c = interp.consistency || {};
  const conf = interp.confidence || {};
  const factorChip = (status) => `<span class="stormgrid-interp__factorchip stormgrid-interp__factorchip--${escapeAttr(status || 'unknown')}">${escapeHtml(String(status || 'unknown').toUpperCase())}</span>`;
  const factorRows = (conf.factors || []).map((f) => `
    <li>
      <span class="stormgrid-interp__factorname">${escapeHtml(prettyFactorName(f.factor))}</span>
      ${factorChip(f.status)}
      <span class="stormgrid-interp__factordetail">${escapeHtml(f.detail || '')}</span>
    </li>
  `).join('');

  const perDurRows = Object.entries(c.per_duration_nearest || {}).map(([dk, ne]) => `
    <li>
      <span class="stormgrid-interp__dur">${escapeHtml(dk)}</span>
      <span class="stormgrid-interp__nearest">most closely resembles <strong>${escapeHtml(ne.aep)} AEP</strong></span>
      <span class="stormgrid-interp__nearestdetail">ratio ${(ne.ratio).toFixed(2)}× · log-distance ${(ne.log_distance).toFixed(3)}</span>
    </li>
  `).join('');

  wrap.innerHTML = `
    <h4>Event interpretation framework
      <span class="stormgrid-interp__conf stormgrid-interp__conf--${escapeAttr(conf.level || 'low')}">${escapeHtml(String(conf.level || 'low').toUpperCase())} confidence</span>
    </h4>
    <p class="stormgrid-interp__headline">${escapeHtml(interp.headline)}</p>

    <details class="stormgrid-interp__details" open>
      <summary>Per-duration nearest design envelope</summary>
      <ul class="stormgrid-interp__list">${perDurRows || '<li class="stormgrid-interp__empty">No durations with comparable data.</li>'}</ul>
      <p class="stormgrid-interp__sub">
        Consistency score: <strong>${(c.consistency_score || 0).toFixed(2)}</strong>
        (${c.agreement_count}/${c.total_durations} durations agree on dominant envelope${c.dominant_aep ? ` <strong>${escapeHtml(c.dominant_aep)} AEP</strong>` : ''}).
      </p>
    </details>

    <details class="stormgrid-interp__details">
      <summary>Confidence factors</summary>
      <ul class="stormgrid-interp__factors">${factorRows}</ul>
    </details>

    <p class="stormgrid-interp__note">
      <strong>Interpretation only — not classification.</strong>
      Stormgrid never classifies an event AEP, never assigns a return period, and never asserts formal exceedance.
      "Most closely resembles" describes a similarity in design depth, not an event probability.
      Verify ARF coefficients against ARR2019 Book 2 Ch. 4 before any engineering use.
    </p>
  `;
  return wrap;
}

function prettyFactorName(k) {
  switch (k) {
    case 'arf_coefficients_verified': return 'ARF coefficients verified';
    case 'observed_coverage_min':     return 'Observed pixel coverage (min)';
    case 'durations_with_data':       return 'Durations with comparable data';
    case 'multi_duration_consistency':return 'Multi-duration consistency';
    case 'suspect_ifd_rows':          return 'Suspect IFD rows in active set';
    default: return k;
  }
}

function renderComparisonSummary(comparisonByDuration) {
  const wrap = document.createElement('section');
  wrap.className = 'stormgrid-cmpsummary';
  const summary = summariseComparisons(comparisonByDuration);
  const rarest = summary.rarest_reference_reached;
  const overall = summary.strongest_band_overall;
  const overallLabel = overall
    ? (COMPARISON_BANDS.find((b) => b.key === overall) || {}).label || overall
    : null;

  const headline = rarest
    ? `Observed catchment-mean rainfall reached the ${escapeHtml(rarest)} ARF-adjusted areal design depth at one or more durations.`
    : (overallLabel
        ? `Strongest band reached: <strong>${escapeHtml(overallLabel)}</strong> — observed catchment-mean did not match any ARF-adjusted design reference depth.`
        : `No comparable ARF-adjusted design depths in the current view.`);

  const rows = Object.entries(comparisonByDuration).map(([dk, c]) => {
    const headlineLabel = c.headline
      ? (c.headline.reached_or_above
          ? `Reached ${escapeHtml(c.headline.reference_aep)} AEP areal depth (ratio ≥ 1.0)`
          : `Closest: ${escapeHtml(c.headline.reference_aep)} AEP at ratio ${c.headline.ratio != null ? c.headline.ratio.toFixed(2) : '—'}×`)
      : '—';
    const band = c.strongest_band || 'unknown';
    const bandLabel = (COMPARISON_BANDS.find((b) => b.key === band) || {}).label || 'Unknown';
    return `<li>
      <span class="stormgrid-cmpsummary__dur">${escapeHtml(dk)}</span>
      <span class="stormgrid-cmpband stormgrid-cmpband--${escapeAttr(band)}">${escapeHtml(bandLabel)}</span>
      <span class="stormgrid-cmpsummary__detail">${headlineLabel}</span>
    </li>`;
  }).join('');

  wrap.innerHTML = `
    <h4>ARF-adjusted comparison summary</h4>
    <p class="stormgrid-cmpsummary__headline">${headline}</p>
    <ul class="stormgrid-cmpsummary__list">${rows}</ul>
    <p class="stormgrid-cmpsummary__note">
      <strong>Comparison only.</strong>
      Stormgrid does <em>not</em> classify event AEP, does <em>not</em> compute return periods,
      does <em>not</em> assert exceedance. ARF-adjusted comparisons are conditional on the
      coefficient set in <code>data/arf_coefficients.json</code> — verify against ARR2019
      Book 2 Ch. 4 before any engineering use.
    </p>
  `;
  return wrap;
}

function renderArfBanner(host, { arfResult, catchmentAreaKm2, cifd }) {
  const banner = document.createElement('div');
  banner.className = 'stormgrid-ifd__arfwarn';

  if (!arfResult || !arfResult.ok) {
    banner.classList.add('stormgrid-ifd__arfwarn--err');
    banner.innerHTML = `
      <strong>ARF coefficients not loaded</strong> —
      cannot compute ARF-adjusted values.
      ${arfResult && arfResult.error ? ' (' + escapeHtml(arfResult.error) + ')' : ''}
      Returning point IFD values for reference only.
    `;
    host.appendChild(banner);
    return { coefficientsAvailable: false };
  }
  const arfData = arfResult.data;
  const region  = getRegion(arfData);
  const validity = getValidity(arfData);
  const verified = isVerified(arfData);
  const lines = [];
  if (!verified) {
    lines.push(`<strong>ARF COEFFICIENTS UNVERIFIED.</strong> Default placeholders are loaded; replace
      <code>data/arf_coefficients.json</code> with your ARR2019 Book 2 Ch. 4 region values, populate
      <code>tests/fixtures/arf_golden_cases.json</code>, and run <code>npm run test:arf</code> per
      <code>docs/arf_methodology.md</code> before any engineering use.`);
  }
  // Verification-status detail line (always shown — stamps the latest test run).
  const vs = arfData.verification_status;
  if (vs) {
    const last = vs.last_run_at ? String(vs.last_run_at).replace('T', ' ').slice(0, 19) + ' UTC' : 'never';
    const shape = vs.shape_tests_passed === true ? 'PASS' : (vs.shape_tests_passed === false ? 'FAIL' : '—');
    const golden = `${vs.golden_cases_passed ?? 0}/${vs.golden_cases_total ?? 0}`;
    const maxErr = (typeof vs.max_abs_error === 'number') ? vs.max_abs_error.toFixed(6) : '—';
    lines.push(
      `<small>Verification: shape tests <strong>${shape}</strong> · golden cases <strong>${escapeHtml(golden)}</strong> · max abs err <strong>${escapeHtml(maxErr)}</strong> · last run ${escapeHtml(last)}</small>`
    );
  }
  if (!Number.isFinite(catchmentAreaKm2)) {
    lines.push('Catchment area unavailable for this catchment — ARF cannot be computed.');
  }
  if (Number.isFinite(catchmentAreaKm2) && validity) {
    if (catchmentAreaKm2 < validity.area_min_km2 || catchmentAreaKm2 > validity.area_max_km2) {
      lines.push(`Catchment area ${catchmentAreaKm2.toFixed(2)} km² is outside the long-duration ARF validity range
        (${validity.area_min_km2}–${validity.area_max_km2} km²) — results in this row will be flagged "extrapolated".`);
    }
  }
  banner.innerHTML = `
    <strong>ARF mode</strong> · region: ${escapeHtml(region ? region.label : arfData.default_region)}
    · long-duration form (validity ${validity ? validity.duration_min_hours : '?'}–${validity ? validity.duration_max_hours : '?'} h)
    ${lines.length ? '<ul>' + lines.map((l) => `<li>${l}</li>`).join('') + '</ul>' : ''}
  `;
  if (!verified) banner.classList.add('stormgrid-ifd__arfwarn--unverified');
  host.appendChild(banner);
  return {
    coefficientsAvailable: !!(region && region.coefficients),
    coeff:    region && region.coefficients,
    validity,
    verified,
    arfData,
    region,
  };
}

function renderIfdChart(cifd, durationStatsByKey, opts = {}) {
  const W = 640, H = 280, padL = 48, padR = 14, padT = 14, padB = 38;
  const all = [];
  const series = { obs: [], '20%': [], '5%': [], '2%': [], '1%': [] };
  const { ifdDisplayMode, arfBundle, catchmentAreaKm2 } = opts;
  DURATION_KEYS.forEach((dk, i) => {
    const obs = durationStatsByKey[dk];
    if (obs && typeof obs.max_total_mm === 'number') {
      series.obs.push({ x: i, y: obs.max_total_mm });
      all.push(obs.max_total_mm);
    }
    const r = cifd.durations[dk];
    if (!r || !r.aep || r.quality_flag === 'suspect_non_monotonic') return;
    let arfPerAep = null;
    if (ifdDisplayMode === 'arf' && arfBundle && arfBundle.coefficientsAvailable && Number.isFinite(catchmentAreaKm2)) {
      const t = computeArfTable({
        areaKm2: catchmentAreaKm2,
        durationHours: DURATION_HOURS[dk],
        aepKeys: AEP_COLUMNS,
        coefficients: arfBundle.coeff,
        validity: arfBundle.validity,
      });
      arfPerAep = {};
      for (const a of AEP_COLUMNS) {
        const e = t.arf_by_aep[a];
        arfPerAep[a] = e && e.valid === true && Number.isFinite(e.arf) ? e.arf : null;
      }
    }
    AEP_COLUMNS.forEach((p) => {
      const v0 = r.aep[p];
      if (typeof v0 !== 'number') return;
      let v = v0;
      if (ifdDisplayMode === 'arf') {
        const arf = arfPerAep ? arfPerAep[p] : null;
        if (arf == null) return;
        v = v0 * arf;
      }
      series[p].push({ x: i, y: v });
      all.push(v);
    });
  });
  const yMax = all.length ? Math.max(...all, 1) * 1.05 : 1;
  const xScale = (i) => padL + (i / (DURATION_KEYS.length - 1)) * (W - padL - padR);
  const yScale = (v) => H - padB - (v / yMax) * (H - padT - padB);
  const colours = { obs: '#00585b', '20%': '#9ec5fe', '5%': '#6aa3f0', '2%': '#3a73c8', '1%': '#1c4ea8' };
  const polylinePoints = (pts) => pts.map((p) => `${xScale(p.x)},${yScale(p.y)}`).join(' ');
  const ticks = []; for (let i = 0; i <= 5; i++) ticks.push((yMax * i) / 5);
  const captionExtra = ifdDisplayMode === 'arf'
    ? ' — ARF-adjusted areal design rainfall (ARR2019 long-duration form)'
    : ' — point IFD design depths (no ARF)';
  const wrap = document.createElement('figure');
  wrap.className = 'stormgrid-ifd__chartwrap';
  wrap.innerHTML = `
    <figcaption>Observed catchment rainfall vs design depths${captionExtra}</figcaption>
    <svg class="stormgrid-ifd__chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="IFD chart">
      ${ticks.map((v) => `
        <line x1="${padL}" x2="${W - padR}" y1="${yScale(v)}" y2="${yScale(v)}" stroke="#e0e6ec" stroke-width="1"/>
        <text x="${padL - 6}" y="${yScale(v) + 3}" text-anchor="end" font-size="10" fill="#5b6473" font-family="sans-serif">${v.toFixed(0)}</text>
      `).join('')}
      ${DURATION_KEYS.map((dk, i) => `
        <text x="${xScale(i)}" y="${H - padB + 14}" text-anchor="middle" font-size="11" fill="#1a1f2b" font-family="sans-serif">${dk}</text>
      `).join('')}
      ${AEP_COLUMNS.map((p) => `
        <polyline fill="none" stroke="${colours[p]}" stroke-width="1.5" points="${polylinePoints(series[p])}"/>
        ${series[p].map((pt) => `<circle cx="${xScale(pt.x)}" cy="${yScale(pt.y)}" r="2.5" fill="${colours[p]}"/>`).join('')}
      `).join('')}
      <polyline fill="none" stroke="${colours.obs}" stroke-width="2.5" stroke-dasharray="5 4" points="${polylinePoints(series.obs)}"/>
      ${series.obs.map((pt) => `<circle cx="${xScale(pt.x)}" cy="${yScale(pt.y)}" r="4" fill="${colours.obs}" stroke="#fff" stroke-width="1.5"/>`).join('')}
      <text x="${W - padR}" y="${padT + 12}" text-anchor="end" font-size="10" fill="#5b6473" font-family="sans-serif">mm</text>
    </svg>
    <div class="stormgrid-ifd__legend">
      <span class="stormgrid-ifd__legend-item"><i style="background:${colours.obs};border-style:dashed;border-color:${colours.obs}"></i>Observed catchment-mean (current window)</span>
      ${AEP_COLUMNS.map((p) => `<span class="stormgrid-ifd__legend-item"><i style="background:${colours[p]}"></i>${ifdDisplayMode === 'arf' ? 'Areal' : 'Point IFD'} ${escapeHtml(p)} AEP</span>`).join('')}
    </div>
  `;
  return wrap;
}

function blockNote(html, variant) {
  const el = document.createElement('p');
  el.className = 'stormgrid-ifd__note' + (variant === 'error' ? ' stormgrid-ifd__note--error' : '');
  el.innerHTML = html;
  return el;
}

function prettyFlag(f) {
  switch (f) {
    case 'duration_below_validity': return 'Duration below long-duration ARF validity (short-duration form not implemented).';
    case 'duration_above_validity': return 'Duration above long-duration ARF validity range — extrapolated.';
    case 'area_below_validity':     return 'Catchment area below long-duration ARF validity (< documented range).';
    case 'area_above_validity':     return 'Catchment area above long-duration ARF validity (> documented range).';
    case 'no_coefficients_loaded':  return 'ARF coefficients not loaded.';
    case 'non_finite_result':       return 'ARF computation produced a non-finite value.';
    case 'non_positive_arf_clipped':return 'ARF computed at or below 0 — clipped to 0.01.';
    case 'area_invalid':            return 'Catchment area invalid.';
    case 'duration_invalid':        return 'Duration invalid.';
    case 'aep_inva