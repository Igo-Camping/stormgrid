// summaryStats.js — Analysis layer: Summary stats (pure) + Summary panel (DOM).
//
// REFACTOR of the ranking/availability stats into the Summary panel of docs/02
// §10.5. Two exports:
//
//   computeSummary(windowResult, durationKey) → a pure, display-ready summary of
//     ALREADY-AREAL values. catchmentMean, maxCell, meanCell, minCell, areaAbove
//     and the per-duration max are all ArealRainfall (or null gaps); we read them
//     out for display via mmOf (never coercing a gap to 0). criticalDuration is
//     the duration with the greatest areal accumulated depth.
//
//   mountSummaryStats(bodyEl, store) → {destroy} renders the Summary panel and
//     subscribes to select.windowResult + select.duration. The "~AEP (indicative)"
//     line shows the GATED REASON when the engineering gate (P-1) is closed and
//     NEVER a number — it only ever shows an indicative, labelled band when the
//     gate is open (which requires real ARF coefficients).
//
// RED LINE: this module reads areal values for display only. It performs NO ARF.
// AEP gating is delegated to aepEstimator.computeAep, which honours
// engineeringGradeAllowed(windowResult.source). The panel asks the estimator for
// the label and renders whatever (number-free, when gated) it returns.
//
// The pure half has no DOM/fetch. The mount half touches only the element it is
// given (it never reaches outside bodyEl) and returns a destroy() that
// unsubscribes and clears its own DOM.

import { mmOf, isAreal } from '../core/rainfallTypes.js';
import { engineeringGradeAllowed } from '../core/sourceAdapter.js';
import {
  computeAep,
  indicativeAepLabel,
  GATE_REASON_PLACEHOLDER_ARF,
} from './aepEstimator.js';

/**
 * @typedef {Object} SummaryView
 * @property {number|null} maxCell        areal max cell depth, mm (null = gap)
 * @property {number|null} meanCell       areal mean cell depth, mm
 * @property {number|null} minCell        areal min cell depth, mm
 * @property {number|null} catchmentMean  areal catchment mean, mm (already areal)
 * @property {{thresholdMm:number, fraction:number, label:string}[]} areaAbove
 * @property {number|null} spatialCv       spatial coefficient of variation
 * @property {string} spatialUniformity    human descriptor of spatialCv
 * @property {string|null} criticalDuration the duration key with the greatest areal accumulated depth
 * @property {number|null} criticalDepthMm   that duration's areal accumulated depth, mm
 * @property {string|null} durationKey       the duration the summary was computed for
 * @property {boolean} available             false when there is no windowResult
 */

/**
 * Pure, display-ready summary. Reads ONLY already-areal values; performs no ARF.
 * A missing figure stays null (gap honesty) and is never coerced to 0.
 *
 * @param {Object|null} windowResult  a RainfallWindowResult (or null)
 * @param {string} [durationKey]      the active duration; selects the spatialCv /
 *                                    critical-duration context. Defaults to the
 *                                    critical duration if not supplied.
 * @returns {SummaryView}
 */
export function computeSummary(windowResult, durationKey) {
  if (!windowResult) {
    return {
      maxCell: null, meanCell: null, minCell: null, catchmentMean: null,
      areaAbove: [], spatialCv: null, spatialUniformity: 'unknown',
      criticalDuration: null, criticalDepthMm: null, durationKey: durationKey || null,
      available: false,
    };
  }

  const stats = windowResult.stats || {};
  // Every figure below is an ArealRainfall (or null). mmOf returns the number or
  // null; it THROWS on a non-areal branded value, which would flag a red-line bug.
  const catchmentMean = mmOf(arealOrNull(windowResult.catchmentMean));
  const maxCell = mmOf(arealOrNull(stats.maxCell));
  const minCell = mmOf(arealOrNull(stats.minCell));
  const meanCell = mmOf(arealOrNull(stats.meanCell));

  // areaAbove: areal-fraction descriptors. Carried through verbatim (the precomputed
  // Lizard schema ships an empty array — we report empty honestly, never fabricate).
  const areaAbove = Array.isArray(stats.areaAbove)
    ? stats.areaAbove.map((a) => ({
        thresholdMm: typeof a.thresholdMm === 'number' ? a.thresholdMm : null,
        fraction: typeof a.fraction === 'number' ? a.fraction : null,
        label: `Area > ${typeof a.thresholdMm === 'number' ? a.thresholdMm : '—'} mm`,
      }))
    : [];

  const spatialCv = typeof stats.spatialCv === 'number' && Number.isFinite(stats.spatialCv)
    ? stats.spatialCv : null;

  const critical = criticalDurationOf(windowResult.durationStats);

  return {
    maxCell, meanCell, minCell, catchmentMean,
    areaAbove,
    spatialCv,
    spatialUniformity: describeCv(spatialCv),
    criticalDuration: critical.durationKey,
    criticalDepthMm: critical.depthMm,
    durationKey: durationKey || critical.durationKey || null,
    available: true,
  };
}

/**
 * The critical duration is the rolling-window duration whose AREAL accumulated
 * depth is greatest. Reads ArealRainfall maxAccumulated values via mmOf. Returns
 * { durationKey:null, depthMm:null } when none are comparable.
 * @param {Array} durationStats
 * @returns {{durationKey:string|null, depthMm:number|null}}
 */
export function criticalDurationOf(durationStats) {
  const list = Array.isArray(durationStats) ? durationStats : [];
  let best = { durationKey: null, depthMm: null };
  for (const ds of list) {
    const mm = mmOf(arealOrNull(ds && ds.maxAccumulated));
    if (mm == null) continue;
    if (best.depthMm == null || mm > best.depthMm) {
      best = { durationKey: ds.durationKey || null, depthMm: mm };
    }
  }
  return best;
}

/** Human descriptor for a spatial coefficient of variation. */
export function describeCv(cv) {
  if (cv == null || !Number.isFinite(cv)) return 'unknown';
  if (cv < 0.15) return 'very uniform';
  if (cv < 0.30) return 'fairly uniform';
  if (cv < 0.50) return 'variable';
  return 'highly variable';
}

// ── DOM mount ────────────────────────────────────────────────────────────────

/**
 * Mount the Summary panel into bodyEl and keep it in sync with the store.
 *
 * Subscribes to select.windowResult and select.duration; re-renders on either.
 * The "~AEP (indicative)" line is produced by aepEstimator: when the P-1 gate is
 * closed (placeholder ARF coefficients), it shows the gate REASON and never a
 * number. Because this panel does not have the IFD/ARF inputs wired yet (that is
 * the Event/IFD plumbing's job), it asks the estimator with empty inputs — which,
 * crucially, STILL returns gated:true under a placeholder source, so the number is
 * suppressed by the gate regardless of inputs.
 *
 * @param {HTMLElement} bodyEl
 * @param {{getState:Function, subscribe:Function}} store
 * @param {{computeAepInputs?:Function}} [opts]  optional provider of {ifd,arf} once
 *        the IFD/ARF wiring lands; defaults to empty inputs (gate still applies).
 * @returns {{destroy:Function}}
 */
export function mountSummaryStats(bodyEl, store, opts = {}) {
  if (!bodyEl) throw new TypeError('mountSummaryStats: bodyEl is required');
  if (!store || typeof store.subscribe !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('mountSummaryStats: a store with getState/subscribe is required');
  }

  const root = document.createElement('div');
  root.className = 'sg-summary';
  bodyEl.appendChild(root);

  const provideInputs = typeof opts.computeAepInputs === 'function'
    ? opts.computeAepInputs
    : () => ({ ifd: { pointDepthsByAep: {} }, arf: { factorsByAep: {} } });

  function render() {
    const state = store.getState();
    const windowResult = state && state.data && state.data.windowResult;
    const durationKey = state && state.context && state.context.duration;
    const summary = computeSummary(windowResult, durationKey);

    // AEP line — delegate gating to the estimator. Never build a number here.
    let aepLine;
    if (!windowResult) {
      aepLine = '—';
    } else {
      const { ifd, arf } = provideInputs(state) || {};
      const aepResult = computeAep(windowResult, ifd || { pointDepthsByAep: {} }, arf || { factorsByAep: {} });
      aepLine = indicativeAepLabel(aepResult);
    }

    root.innerHTML = renderSummaryHtml(summary, windowResult, aepLine);
  }

  // Re-render when the window result or the duration changes.
  const unsubWindow = store.subscribe((s) => s.data.windowResult, render);
  const unsubDuration = store.subscribe((s) => s.context.duration, render);
  render();

  return {
    destroy() {
      try { unsubWindow && unsubWindow(); } catch (_) { /* idempotent */ }
      try { unsubDuration && unsubDuration(); } catch (_) { /* idempotent */ }
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}

/**
 * Build the panel HTML. Pure string → safe to unit-test. Gaps render as '—'.
 * The AEP line renders whatever the estimator returned (number-free when gated).
 * @param {SummaryView} s
 * @param {Object|null} windowResult
 * @param {string} aepLine
 * @returns {string}
 */
export function renderSummaryHtml(s, windowResult, aepLine) {
  if (!s || !s.available) {
    return '<div class="sg-summary__empty">No window selected — summary unavailable.</div>';
  }
  const mm = (v) => (v == null ? '—' : `${v.toFixed(0)} mm`);
  const gated = !engineeringGradeAllowed(windowResult && windowResult.source);

  const areaRows = s.areaAbove.length
    ? s.areaAbove
        .map((a) => row(esc(a.label), a.fraction == null ? '—' : `${(a.fraction * 100).toFixed(0)}%`))
        .join('')
    : row('Area &gt; threshold', '<span class="sg-summary__muted">not carried by this source</span>');

  const cvCell = s.spatialCv == null
    ? '—'
    : `${s.spatialCv.toFixed(2)} <span class="sg-summary__muted">(${esc(s.spatialUniformity)})</span>`;

  const critCell = s.criticalDuration
    ? `${esc(s.criticalDuration)}${s.criticalDepthMm != null ? ` <span class="sg-summary__muted">(${s.criticalDepthMm.toFixed(0)} mm)</span>` : ''}`
    : '—';

  // AEP line: gated → reason (no number); open → indicative label. Either way the
  // info marker links to the methodology surface and the value is never a bare RP.
  const aepClass = gated ? 'sg-summary__aep sg-summary__aep--gated' : 'sg-summary__aep';
  const aepInfo = gated
    ? '<span class="sg-summary__muted">point-IFD, ARF-adj — gated (P-1)</span>'
    : '<span class="sg-summary__muted">point-IFD, ARF-adj, not a classification</span>';

  return [
    '<div class="sg-summary__title">Summary</div>',
    '<dl class="sg-summary__grid">',
    row('Catchment mean', mm(s.catchmentMean), 'areal'),
    row('Max cell', mm(s.maxCell)),
    row('Min cell', mm(s.minCell)),
    areaRows,
    row('Spatial CV', cvCell),
    row('Critical duration', critCell),
    `<dt>~AEP (indicative)</dt><dd class="${aepClass}"><span class="sg-summary__aep-value">${esc(aepLine)}</span> <span class="sg-summary__info" title="Opens methodology detail">ⓘ</span><br>${aepInfo}</dd>`,
    '</dl>',
  ].join('');
}

// ── helpers ──────────────────────────────────────────────────────────────────

function row(label, valueHtml, tag) {
  const tagHtml = tag ? ` <span class="sg-summary__tag">${esc(tag)}</span>` : '';
  return `<dt>${label}${tagHtml}</dt><dd>${valueHtml}</dd>`;
}

/** Guard: pass through an ArealRainfall or null; anything else is a red-line bug. */
function arealOrNull(v) {
  if (v == null) return null;
  if (isAreal(v)) return v;
  // mmOf would also throw, but be explicit about which field tripped.
  throw new TypeError('summaryStats: expected an ArealRainfall (already-areal) value or null.');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export { GATE_REASON_PLACEHOLDER_ARF };
