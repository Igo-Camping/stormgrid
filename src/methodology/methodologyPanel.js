// methodologyPanel.js — the routed full-detail Methodology surface (docs/02 §6
// Depth 2, §10.4; docs/03 §2 MethodologyPanel + FrameLog).
//
// This is the surface the chip's "Methodology ▸" / "view log" affordances route to
// (#methodology). It is a SIDE / OVER panel, NOT a full-screen modal: it is built
// as a self-contained element the shell can place beside or over the results
// column, and it carries NO backdrop and NO map-blanking — the map MUST stay
// visible when this opens (docs/02 §6 rule). The shell owns placement; this module
// owns content and a close affordance only.
//
// FAITHFUL RENDERER (docs/03 §2 "reads everything from the SourceAdapter return
// contract — adds nothing of its own"; docs/04 §4): it RENDERS THE CONTRACT and
// adds no numbers of its own. It computes/infers no rainfall or AEP value. Gaps
// (missing frames, degraded confidence) are shown prominently, never hidden, and a
// placeholder-grade result is NEVER presented as engineering-defensible.
//
// Contract fields read (docs/04 §3.1, §3.3):
//   source       {id,label,kind,buildVersion,lastBuilt,unit,isPlaceholder}  → provenance
//   coverage     {pct,framesUsed,framesExpected,framesMissing}
//   frameLog     [{iso,status:'valid'|'partial'|'missing',meanMm}]          → per-frame log
//   confidence   {tier,reasons}                                            → tier + reasons
//   calibration  {applied,method,version} | null                          → method/version
//   warnings     string[]                                                  → limitations list
//   durationStats[] (read for IFD/ARF basis context only; no recomputation)
//
// Frame-log presentation reuses the valid/partial/missing rendering ideas from the
// existing stormgridAvailability.js (renderFrameLogPanel) — promoted here.
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

function fmtTs(iso) {
  if (!iso) return '—';
  return String(iso).replace('T', ' ').replace(/Z$/, ' UTC');
}
function fmtPct(n) {
  return (typeof n === 'number' && Number.isFinite(n)) ? `${n.toFixed(1)}%` : '—';
}
function fmtMmOrGap(meanMm) {
  // A missing frame's meanMm is null by contract — show "—", never a fabricated 0.
  return (typeof meanMm === 'number' && Number.isFinite(meanMm)) ? `${meanMm.toFixed(2)} mm` : '—';
}

const TIER_LABEL = Object.freeze({ high: 'High', moderate: 'Moderate', low: 'Low' });

const WARNING_TEXT = Object.freeze({
  'placeholder-arf': 'ARF coefficients: placeholder — not engineering-defensible',
  'synthetic-gauges': 'Calibration uses synthetic gauge data — illustrative only',
  'synthetic-preview-overlay': 'Map raster is a synthetic preview overlay — not measured grid data',
  'sanity-envelope-violation': 'Frame values failed the unit sanity envelope — possible unit error',
});

/** A titled section wrapper. */
function section(title, children, cls) {
  return el('section', { class: 'sg-method__section' + (cls ? ` ${cls}` : '') }, [
    el('h4', { class: 'sg-method__h', text: title }),
    ...[].concat(children),
  ]);
}

/** A definition-list row. */
function row(label, value) {
  return el('div', { class: 'sg-method__row' }, [
    el('dt', { class: 'sg-method__dt', text: label }),
    el('dd', { class: 'sg-method__dd' }, value == null ? '—' : value),
  ]);
}

// ── Sections (each a faithful render of one contract area) ───────────────────

/** Coverage block — pct, used/expected, missing. Contract values verbatim. */
function coverageSection(cov) {
  const c = cov || {};
  const dl = el('dl', { class: 'sg-method__grid' }, [
    row('Coverage', fmtPct(c.pct)),
    row('Frames used', `${c.framesUsed ?? '—'} / ${c.framesExpected ?? '—'}`),
    row('Frames missing', String(c.framesMissing ?? '—')),
  ]);
  const lowCov = typeof c.pct === 'number' && c.pct < 70;
  const note = lowCov
    ? el('p', { class: 'sg-method__warn', text: '⚠ Low coverage — rainfall statistics may not represent the full catchment.' })
    : null;
  return section('Coverage', [dl, note]);
}

/**
 * Per-frame log — valid / partial / missing, reusing stormgridAvailability ideas.
 * meanMm is shown when present; a missing frame shows "—" (never a fabricated 0).
 */
function frameLogSection(frameLog) {
  const log = Array.isArray(frameLog) ? frameLog : [];
  if (log.length === 0) {
    return section('Per-frame log', el('p', { class: 'sg-method__empty', text: 'No frame log carried by this result.' }));
  }
  const counts = log.reduce((acc, f) => {
    acc.total += 1;
    if (f.status === 'valid') acc.valid += 1;
    else if (f.status === 'partial') acc.partial += 1;
    else if (f.status === 'missing') acc.missing += 1;
    return acc;
  }, { total: 0, valid: 0, partial: 0, missing: 0 });

  const summary = el('div', { class: 'sg-method__framecounts' }, [
    `${counts.total} total · `,
    el('span', { class: 'sg-method__count sg-method__count--valid', text: `${counts.valid} valid` }),
    ' · ',
    el('span', { class: 'sg-method__count sg-method__count--partial', text: `${counts.partial} partial` }),
    ' · ',
    el('span', { class: 'sg-method__count sg-method__count--missing', text: `${counts.missing} missing` }),
  ]);

  const rows = log.map((f) => el('tr', {
    class: `sg-method__framerow sg-method__framerow--${f.status || 'unknown'}`,
  }, [
    el('td', { text: fmtTs(f.iso) }),
    el('td', {}, el('span', {
      class: `sg-method__status sg-method__status--${f.status || 'unknown'}`,
      text: String(f.status || 'unknown').toUpperCase(),
    })),
    el('td', { class: 'sg-method__mm', text: fmtMmOrGap(f.meanMm) }),
  ]));

  const table = el('table', { class: 'sg-method__frametable' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Timestamp' }),
      el('th', { text: 'Status' }),
      el('th', { text: 'Mean (mm)' }),
    ])),
    el('tbody', {}, rows),
  ]);

  // <details> keeps the long table collapsible but present (reachable via "view log").
  const details = el('details', { class: 'sg-method__framelog', open: 'open' }, [
    el('summary', { class: 'sg-method__framesummary' }, summary),
    table,
  ]);
  return section('Per-frame log', details);
}

/** Confidence — tier + the contract's reasons list (the "why"). */
function confidenceSection(conf) {
  const c = conf || {};
  const tier = (c.tier && TIER_LABEL[c.tier]) ? c.tier : 'low';
  const head = el('p', { class: 'sg-method__conf' }, [
    'Tier: ',
    el('strong', { class: `sg-method__tier sg-method__tier--${tier}`, text: TIER_LABEL[tier] }),
  ]);
  const reasons = Array.isArray(c.reasons) ? c.reasons : [];
  const list = reasons.length
    ? el('ul', { class: 'sg-method__reasons' }, reasons.map((r) => el('li', { text: r })))
    : el('p', { class: 'sg-method__empty', text: 'No reasons recorded.' });
  return section('Confidence', [head, list]);
}

/**
 * IFD station + ARF status. The contract does not carry IFD station detail in the
 * window result; we state the basis honestly and surface ARF status from the
 * placeholder flag / warnings. This is the P-1 defensibility line: when placeholder,
 * it MUST read "not engineering-defensible".
 */
function ifdArfSection(result) {
  const source = result.source || {};
  const isPlaceholder = source.isPlaceholder === true
    || (Array.isArray(result.warnings) && result.warnings.includes('placeholder-arf'));

  const arfStatus = isPlaceholder
    ? el('span', { class: 'sg-method__badge sg-method__badge--severe', text: 'placeholder — not engineering-defensible' })
    : el('span', { class: 'sg-method__badge sg-method__badge--ok', text: 'verified coefficients' });

  const dl = el('dl', { class: 'sg-method__grid' }, [
    row('IFD basis', 'Point IFD (BoM / ARR). Station detail is not carried in this result.'),
    row('ARF application', 'Applied to the point IFD design depth only — never to the observed areal mean.'),
    row('ARF coefficients', arfStatus),
  ]);
  const note = isPlaceholder
    ? el('p', { class: 'sg-method__warn', text: '⚠ ARF coefficients are placeholders (P-1). Any AEP/engineering-grade output is gated off until real ARR2019 coefficients are supplied.' })
    : null;
  return section('IFD station & ARF status', [dl, note]);
}

/** Calibration — method/version, or "Not applied". P-4 synthetic-gauge honesty. */
function calibrationSection(result) {
  const calib = result.calibration; // {applied, method, version} | null
  const synthetic = Array.isArray(result.warnings) && result.warnings.includes('synthetic-gauges');

  let body;
  if (!calib || calib.applied !== true) {
    body = el('dl', { class: 'sg-method__grid' }, [
      row('Status', 'Not applied (raw output)'),
    ]);
  } else {
    body = el('dl', { class: 'sg-method__grid' }, [
      row('Status', 'Applied'),
      row('Method', calib.method || '—'),
      row('Version', calib.version || '—'),
    ]);
  }
  const note = synthetic
    ? el('p', { class: 'sg-method__warn', text: '⚠ Calibration uses synthetic gauge data (P-4) — calibrated output is illustrative until real gauge observations are wired.' })
    : null;
  return section('Calibration', [body, note]);
}

/** Source provenance + build version (provenance travels — docs/04 §1 rule 3). */
function provenanceSection(source) {
  const s = source || {};
  const dl = el('dl', { class: 'sg-method__grid' }, [
    row('Source', s.label || s.id || 'unknown'),
    row('Source id', s.id || '—'),
    row('Kind', s.kind || '—'),
    row('Build version', s.buildVersion || '—'),
    row('Last built', fmtTs(s.lastBuilt)),
    row('Declared frame unit', s.unit || '—'),
  ]);
  return section('Source provenance', dl);
}

/** Limitations / warnings list — shown prominently; placeholder leads as severe. */
function limitationsSection(result) {
  const ids = new Set(Array.isArray(result.warnings) ? result.warnings : []);
  if (result.source && result.source.isPlaceholder) ids.add('placeholder-arf'); // belt-and-braces (P-1)
  if (ids.size === 0) {
    return section('Limitations', el('p', { class: 'sg-method__empty', text: 'No limitations recorded for this result.' }));
  }
  const items = [...ids].map((id) => el('li', {
    class: 'sg-method__limitation' + (id === 'placeholder-arf' ? ' sg-method__limitation--severe' : ''),
    'data-warning': id,
    text: WARNING_TEXT[id] || id,
  }));
  return section('Limitations', el('ul', { class: 'sg-method__limitations' }, items));
}

/** Honest empty state when no result is loaded (EMPTY / LOCATED / AGGREGATING). */
function renderNoResult(rootBody, phase) {
  rootBody.dataset.panelState = 'noresult';
  const msg = phase === 'AGGREGATING'
    ? 'Aggregating — the methodology detail will populate once coverage and confidence settle.'
    : 'No result yet. Select a location and a timeframe; the full methodology for that result will appear here.';
  rootBody.appendChild(el('p', { class: 'sg-method__noresult', text: msg }));
}

/**
 * Mount the routed Methodology detail panel.
 *
 * The panel is a self-contained element with NO backdrop and NO map-blanking — it
 * is built to be placed beside/over the results column by the shell (docs/02 §6:
 * the map stays visible). It exposes a close affordance that routes back to the
 * workspace (injected closer, else clears location.hash). It is NOT a modal.
 *
 * @param {HTMLElement} bodyEl   the slot/host the shell gives the panel
 * @param {Object} store         createStore() instance — read-only
 * @param {Object} [options]
 * @param {Function} [options.closeMethodology]  injected closer for the routed
 *        surface (e.g. router.closeSurface). When omitted, clears location.hash.
 * @returns {{ destroy: () => void }}
 */
export function mountMethodologyPanel(bodyEl, store, options = {}) {
  if (!bodyEl) throw new Error('mountMethodologyPanel: bodyEl is required');
  if (!store || typeof store.subscribe !== 'function') throw new Error('mountMethodologyPanel: store is required');

  const closeMethodology = typeof options.closeMethodology === 'function'
    ? options.closeMethodology
    : () => { if (typeof window !== 'undefined' && window.location) window.location.hash = ''; };

  // role="complementary" (NOT dialog): this is a side/over panel, not a modal.
  const root = el('aside', {
    class: 'sg-method',
    role: 'complementary',
    'aria-label': 'Methodology detail',
    'data-surface': 'methodology',
  });

  const header = el('header', { class: 'sg-method__head' }, [
    el('h3', { class: 'sg-method__title', text: 'Methodology' }),
    el('button', {
      type: 'button',
      class: 'sg-method__close',
      'data-action': 'close-methodology',
      'aria-label': 'Back to workspace',
      text: 'Close ✕',
    }),
  ]);
  const lede = el('p', { class: 'sg-method__lede', text: 'Full provenance and limitations for the current result. This surface renders the data contract faithfully and adds no figures of its own; the map stays visible alongside it.' });
  const content = el('div', { class: 'sg-method__content' });

  root.appendChild(header);
  root.appendChild(lede);
  root.appendChild(content);
  bodyEl.appendChild(root);

  header.querySelector('[data-action="close-methodology"]')
    .addEventListener('click', (e) => { e.preventDefault(); closeMethodology(); });

  function render(windowResult, phase) {
    content.innerHTML = '';
    root.dataset.phase = phase || 'EMPTY';
    if (!windowResult) {
      renderNoResult(content, phase);
      return;
    }
    content.dataset.panelState = 'result';
    // Order: confidence + coverage + frame log first (the gap-honesty story), then
    // IFD/ARF basis, calibration, provenance, and the limitations list last.
    content.appendChild(confidenceSection(windowResult.confidence));
    content.appendChild(coverageSection(windowResult.coverage));
    content.appendChild(frameLogSection(windowResult.frameLog));
    content.appendChild(ifdArfSection(windowResult));
    content.appendChild(calibrationSection(windowResult));
    content.appendChild(provenanceSection(windowResult.source));
    content.appendChild(limitationsSection(windowResult));
  }

  const selector = (s) => ({ windowResult: s.data.windowResult, phase: s.workflow.phase });
  const unsubscribe = store.subscribe(selector, (slice) => render(slice.windowResult, slice.phase));

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
