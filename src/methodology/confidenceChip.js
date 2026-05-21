// confidenceChip.js — the ALWAYS-VISIBLE confidence chip (docs/02 §6 Depth 1).
//
// This is the product's identity surface: confidence is never a panel you open,
// it is permanently on screen. The chip answers "can I rely on this, and why" at
// a glance, and offers a single "Methodology ▸" affordance that opens the routed
// detail surface (docs/02 §6 Depth 2) — NEVER a modal (docs/02 §2, §6 rule).
//
// FAITHFUL RENDERER (docs/03 §2, docs/04 §4): this component reads everything from
// the SourceAdapter return contract (the RainfallWindowResult in the store) and
// ADDS NOTHING OF ITS OWN. It computes no rainfall/AEP value, infers no number; it
// only displays what the contract carries. Gaps and degraded confidence are shown
// prominently, never hidden.
//
// Contract fields read (docs/04 §3.1, §3.3):
//   source     {label, kind, lastBuilt, buildVersion, isPlaceholder}  → source-agnostic
//   coverage   {pct, framesUsed, framesExpected, framesMissing}
//   confidence {tier, reasons}
//   calibration {applied, method, version} | null
//   warnings   string[]  ('placeholder-arf' | 'synthetic-gauges' |
//                          'synthetic-preview-overlay' | 'sanity-envelope-violation' | …)
//
// Source-agnostic by design (docs/02 §6): the "Data source / Freshness" slot reads
// source.label/lastBuilt/kind, so a future BoM-radar source renders in the same
// slot with no code change here.
//
// Store coupling: subscribes to ONE slice — { windowResult, phase } — and re-renders
// the chip on change. In EMPTY / LOCATED (no result yet) it shows an HONEST
// "no result yet" state, not a fake settled chip (docs/02 §3, §6).
//
// No framework, no build step; plain DOM. Returns { destroy }.

// ── DOM helpers (no framework) ───────────────────────────────────────────────
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** One labelled row in the chip's definition list. `valueNode` may be a string or element. */
function metaRow(label, valueNode, rowClass) {
  return el('div', { class: 'sg-chip__row' + (rowClass ? ` ${rowClass}` : '') }, [
    el('dt', { class: 'sg-chip__dt', text: label }),
    el('dd', { class: 'sg-chip__dd' }, valueNode),
  ]);
}

const TIER_DOTS = Object.freeze({ high: '●●●', moderate: '●●○', low: '●○○' });
const TIER_LABEL = Object.freeze({ high: 'High', moderate: 'Moderate', low: 'Low' });

function fmtPct(n) {
  return (typeof n === 'number' && Number.isFinite(n)) ? `${n.toFixed(0)}%` : '—';
}

/** Freshness from source.lastBuilt (ISO) — display only; no recomputation. */
function fmtFreshness(source) {
  const iso = source && source.lastBuilt;
  if (!iso) return source && source.kind === 'live' ? 'live (no build date)' : 'unavailable';
  // Render the ISO date portion honestly; do not invent a "stale/fresh" judgement here.
  const datePart = String(iso).replace('T', ' ').replace(/Z$/, ' UTC');
  return `built ${datePart}`;
}

// ── Warning surfacing (P-1 / P-4 / preview honesty) ──────────────────────────
// These strings are the literal contract warning ids; the chip translates each to
// an honest human line. The placeholder-ARF case is the engineering-defensibility
// red line (P-1): it MUST read "not engineering-defensible".
const WARNING_TEXT = Object.freeze({
  'placeholder-arf': 'ARF coefficients: placeholder — not engineering-defensible',
  'synthetic-gauges': 'Calibration uses synthetic gauge data — illustrative only',
  'synthetic-preview-overlay': 'Map raster is a synthetic preview overlay — not measured grid data',
  'sanity-envelope-violation': 'Frame values failed the unit sanity envelope — possible unit error',
});

/**
 * Build the honest warning lines for the chip. The placeholder case is forced on
 * whenever source.isPlaceholder is true OR 'placeholder-arf' is present — the two
 * are belt-and-braces so a placeholder source can never render as defensible.
 * @param {Object} result
 * @returns {{ id:string, text:string, severe:boolean }[]}
 */
function warningLines(result) {
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const ids = new Set(warnings);
  // P-1 belt-and-braces: a placeholder source always surfaces the placeholder line.
  if (result.source && result.source.isPlaceholder) ids.add('placeholder-arf');
  const out = [];
  for (const id of ids) {
    out.push({
      id,
      text: WARNING_TEXT[id] || id,
      severe: id === 'placeholder-arf', // the defensibility red line
    });
  }
  return out;
}

// ── Chip body builders ───────────────────────────────────────────────────────

/** EMPTY / LOCATED: honest "no result yet" — never a fake settled chip (docs/02 §3, §6). */
function renderNoResult(bodyEl, phase) {
  bodyEl.dataset.chipState = 'noresult';
  const reason = phase === 'AGGREGATING'
    ? 'Aggregating — coverage and confidence are still forming.'
    : 'No result yet — select a location and a timeframe.';
  bodyEl.appendChild(el('p', { class: 'sg-chip__noresult', text: reason }));
}

/**
 * SETTLED / DEGRADED: render the contract faithfully. Every figure shown comes
 * straight from the contract; nothing is computed here.
 * @param {HTMLElement} bodyEl
 * @param {Object} result   RainfallWindowResult
 * @param {Function} openMethodology
 */
function renderResult(bodyEl, result, openMethodology) {
  const source = result.source || {};
  const cov = result.coverage || {};
  const conf = result.confidence || {};
  const calib = result.calibration; // may be null
  const tier = (conf.tier && TIER_LABEL[conf.tier]) ? conf.tier : 'low';

  bodyEl.dataset.chipState = 'result';
  bodyEl.dataset.tier = tier;

  // Confidence tier line.
  const tierWrap = el('span', { class: 'sg-chip__tier' }, [
    el('strong', { class: `sg-chip__tierlabel sg-chip__tierlabel--${tier}`, text: TIER_LABEL[tier] }),
    el('span', { class: 'sg-chip__dots', 'aria-hidden': 'true', text: TIER_DOTS[tier] }),
  ]);

  // Coverage line: pct + framesUsed/framesExpected (contract, no recompute).
  const covText = `${fmtPct(cov.pct)} (${cov.framesUsed ?? '—'}/${cov.framesExpected ?? '—'} frames)`;

  // Calibration line: applied? method/version, or "Not applied".
  const calibText = !calib
    ? 'Not applied (raw)'
    : (calib.applied
        ? `Applied${calib.method ? ` · ${calib.method}` : ''}${calib.version ? ` v${calib.version}` : ''}`
        : 'Not applied (raw)');

  // Missing-frames line with the "view log" affordance (opens the routed panel).
  const missing = typeof cov.framesMissing === 'number' ? cov.framesMissing : 0;
  const total = cov.framesExpected ?? '—';
  const missingValue = el('span', { class: 'sg-chip__missing' }, [
    el('span', {
      class: 'sg-chip__missingcount' + (missing > 0 ? ' sg-chip__missingcount--gap' : ''),
      text: `${missing} of ${total}`,
    }),
    el('button', {
      type: 'button',
      class: 'sg-chip__viewlog',
      'data-action': 'view-log',
      text: 'view log',
      title: 'Open the per-frame log on the Methodology surface',
    }),
  ]);

  const dl = el('dl', { class: 'sg-chip__meta' }, [
    metaRow('Confidence', tierWrap, 'sg-chip__row--tier'),
    metaRow('Coverage', covText),
    metaRow('Data source', source.label || source.id || 'unknown source'),
    metaRow('Freshness', fmtFreshness(source)),
    metaRow('Calibration', calibText),
    metaRow('Missing frames', missingValue, missing > 0 ? 'sg-chip__row--gap' : null),
    // IFD/ARF basis line: a fixed honest statement of the guardrail (docs/02 §6).
    // It states the basis ONLY — the placeholder warning below carries defensibility.
    metaRow('IFD / ARF basis', 'Point IFD basis; ARF applied to IFD only', 'sg-chip__row--basis'),
  ]);

  bodyEl.appendChild(dl);

  // ── Warnings block (P-1 / P-4 / preview) — shown prominently, never hidden. ──
  const warns = warningLines(result);
  if (warns.length) {
    const list = el('ul', { class: 'sg-chip__warnings' },
      warns.map((w) => el('li', {
        class: 'sg-chip__warning' + (w.severe ? ' sg-chip__warning--severe' : ''),
        'data-warning': w.id,
        text: w.text,
      }))
    );
    bodyEl.appendChild(list);
  }

  // ── Methodology opener — routed, NOT a modal (docs/02 §6). ──
  const openBtn = el('button', {
    type: 'button',
    class: 'sg-chip__methodology',
    'data-action': 'open-methodology',
    text: 'Methodology ▸',
  });
  bodyEl.appendChild(openBtn);

  // Wire the two affordances. Both route to the methodology surface; neither opens
  // a modal. "view log" is the same destination (the panel hosts the frame log).
  const open = (e) => { e.preventDefault(); openMethodology(); };
  openBtn.addEventListener('click', open);
  const viewLog = bodyEl.querySelector('[data-action="view-log"]');
  if (viewLog) viewLog.addEventListener('click', open);
}

/**
 * Mount the always-visible confidence chip.
 *
 * @param {HTMLElement} bodyEl   the slot body to render into (e.g. the results
 *                               panel confidence slot, or the spine mirror slot)
 * @param {Object} store         createStore() instance — used read-only:
 *                               store.getState(), store.subscribe(selector, cb)
 * @param {Object} [options]
 * @param {Function} [options.openMethodology]  injected opener for the routed
 *        Methodology surface. When omitted, the chip falls back to setting
 *        location.hash = '#methodology' (the router's deep-link surface, docs/02
 *        §2). Either way it is a ROUTED open, never a modal.
 * @returns {{ destroy: () => void }}
 */
export function mountConfidenceChip(bodyEl, store, options = {}) {
  if (!bodyEl) throw new Error('mountConfidenceChip: bodyEl is required');
  if (!store || typeof store.subscribe !== 'function') throw new Error('mountConfidenceChip: store is required');

  // The routed open. Prefer an injected opener (e.g. router.openSurface bound to
  // 'methodology'); otherwise set the hash so the router picks it up. NEVER a modal.
  const openMethodology = typeof options.openMethodology === 'function'
    ? options.openMethodology
    : () => { if (typeof window !== 'undefined' && window.location) window.location.hash = '#methodology'; };

  const root = el('section', { class: 'sg-chip', 'aria-label': 'Confidence and methodology summary' });
  bodyEl.appendChild(root);

  function render(windowResult, phase) {
    root.innerHTML = '';
    root.dataset.phase = phase || 'EMPTY';
    if (!windowResult) {
      renderNoResult(root, phase);
    } else {
      renderResult(root, windowResult, openMethodology);
    }
  }

  // Subscribe to the { windowResult, phase } slice. The store fires cb on change.
  const selector = (s) => ({ windowResult: s.data.windowResult, phase: s.workflow.phase });
  const unsubscribe = store.subscribe(selector, (slice) => render(slice.windowResult, slice.phase));

  // Initial paint from current state.
  {
    const s0 = store.getState();
    render(s0.data.windowResult, s0.workflow.phase);
  }

  function destroy() {
    unsubscribe();
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  return { destroy };
}
