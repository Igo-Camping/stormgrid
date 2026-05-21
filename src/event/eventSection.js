// eventSection.js — the spine's Event / Timeframe section (docs/02 §5.2; docs/03
// §2 EVENT LAYER "EventSection" + "ManualTimeframePicker" + "MajorEventsList").
// Mounts into the workspace's `event` slot body (src/shell/workspace.js).
//
// TWO MODES (docs/02 §5.2):
//   Major events  — when a location is selected, triggers the on-the-fly scan
//                   (eventScanner) and renders the STREAMING ranked list:
//                   date / duration / catchment-mean / indicative-AEP-or-suppressed /
//                   confidence. Selecting a row dispatches
//                   setTimeframe({kind:'event', eventId}).
//   Manual timeframe — window selector + duration selector; dispatches
//                   setTimeframe({kind:'window', windowKey, endIso}) + setDuration.
//
// STORE (src/core/store.js): store.{getState,dispatch,subscribe};
//   actions.{setTimeframe,setDuration,setEvents,beginAggregation};
//   select.{location,timeframe,duration,events}.
//   events slice shape: { status:'idle'|'scanning'|'done', items:[] } (+ progress
//   carried in the patch so the bar is honest).
//
// HONESTY (preserved from the salvage sources + docs/04):
//   - The "~AEP" column shows the scanner's labelled indicative band, or — while the
//     P-1 gate is closed (today) — the suppressed label "AEP indicative unavailable
//     — placeholder coefficients". NEVER a bare return period / formal classification.
//   - A non-classification disclaimer is shown under the list at all times.
//   - A gappy candidate is visibly flagged (missing frames + confidence dots).
//
// STREAM → STORE: the scanner pushes each candidate via onCandidate; this section
//   dispatches actions.setEvents({status, items, progress}) on each push so the
//   store is the single source of truth and the list re-renders from select.events.
//   A location change aborts any in-flight scan (AbortController) and restarts.
//
// No fetch here — the scanner owns data access. This file only does DOM + dispatch.

import { actions, select } from '../core/store.js';
import { EVENT_CAP, INDICATIVE_AEP_UNAVAILABLE_LABEL } from './eventScanner.js';
import { getAvailableRainfallWindows, DEFAULT_WINDOW_KEY } from '../stormgridDataLoader.js';

const MODES = Object.freeze(['events', 'manual']);
const DURATION_KEYS = Object.freeze(['3h', '6h', '12h', '24h', '48h', '72h']);

const NON_CLASSIFICATION_NOTE =
  'AEP band (when shown) is indicative only — point-IFD basis, ARF-adjusted for areal '
  + 'comparison. It is NOT a formal AEP classification, NOT a return-period assignment, '
  + 'and NOT a formal exceedance assertion.';

// ── DOM helper (matches the house style in locationSection.js / workspace.js) ──
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

function confidenceDots(tier) {
  switch (String(tier || '').toLowerCase()) {
    case 'high': return '●●●';
    case 'moderate': return '●●○';
    case 'low': return '●○○';
    default: return '○○○';
  }
}

function fmtDate(iso) {
  if (!iso) return '—';
  // AU-leaning compact: keep the date, drop seconds/zone noise.
  return String(iso).replace('T', ' ').replace(/:\d{2}(?:\.\d+)?Z?$/, '').replace('Z', '');
}

function fmtMm(mm) {
  return typeof mm === 'number' && Number.isFinite(mm) ? `${mm.toFixed(0)} mm` : '—';
}

/**
 * Mount the Event / Timeframe section.
 *
 * @param {HTMLElement} bodyEl  the slot body to render into (workspace `event` slot)
 * @param {{getState:Function, dispatch:Function, subscribe:Function}} store
 * @param {Object} deps
 * @param {{scan:Function, cap?:number}} deps.scanner  an eventScanner instance
 * @returns {{ destroy():void }}
 */
export function mountEventSection(bodyEl, store, deps = {}) {
  if (!bodyEl) throw new Error('mountEventSection: bodyEl is required');
  if (!store || typeof store.subscribe !== 'function' || typeof store.dispatch !== 'function') {
    throw new Error('mountEventSection: a store with getState/dispatch/subscribe is required');
  }
  const scanner = deps.scanner;
  if (!scanner || typeof scanner.scan !== 'function') {
    throw new Error('mountEventSection: deps.scanner with a scan() method is required');
  }
  const cap = scanner.cap || EVENT_CAP;

  let mode = 'events';
  let scanController = null;     // AbortController for the in-flight scan
  let lastScannedCatchment = null;
  const unsubs = [];
  let destroyed = false;

  bodyEl.classList.add('sgevt');
  bodyEl.innerHTML = '';

  // ── Mode toggle ──────────────────────────────────────────────────────────────
  const modeWrap = el('fieldset', { class: 'sgevt-block sgevt-modes' }, [
    el('legend', { class: 'sgevt-modes__legend', text: 'Mode' }),
  ]);
  const modeInputs = {};
  for (const m of MODES) {
    const id = `sgevt-mode-${m}`;
    const radio = el('input', { type: 'radio', name: 'sgevt-mode', id, value: m, class: 'sgevt-modes__radio' });
    if (m === mode) radio.checked = true;
    radio.addEventListener('change', () => { if (radio.checked) setMode(m); });
    modeInputs[m] = radio;
    const labelText = m === 'events' ? 'Major events' : 'Manual timeframe';
    modeWrap.appendChild(el('label', { class: 'sgevt-modes__opt', for: id }, [radio, ` ${labelText}`]));
  }
  bodyEl.appendChild(modeWrap);

  // ── Major-events region (scan progress + ranked list) ─────────────────────────
  const eventsWrap = el('div', { class: 'sgevt-block sgevt-events', 'aria-live': 'polite' });
  bodyEl.appendChild(eventsWrap);

  // ── Manual-timeframe region ───────────────────────────────────────────────────
  const manualWrap = el('div', { class: 'sgevt-block sgevt-manual' });
  bodyEl.appendChild(manualWrap);

  // ── Shared non-classification disclaimer (always visible) ─────────────────────
  bodyEl.appendChild(el('p', { class: 'sgevt-disclaimer', text: NON_CLASSIFICATION_NOTE }));

  // ── Mode handling ──────────────────────────────────────────────────────────--
  function setMode(next) {
    if (!MODES.includes(next)) return;
    mode = next;
    if (modeInputs[mode] && !modeInputs[mode].checked) modeInputs[mode].checked = true;
    applyModeVisibility();
    if (mode === 'events') maybeStartScan(); // (re)scan if a location is selected
  }

  function applyModeVisibility() {
    eventsWrap.hidden = mode !== 'events';
    manualWrap.hidden = mode !== 'manual';
  }

  // ── Major events: trigger + stream the scan ──────────────────────────────────-
  function maybeStartScan() {
    const loc = select.location(store.getState());
    const catchmentId = loc && loc.catchmentId ? loc.catchmentId : null;

    // No location, or no catchment resolved → honest empty state, no scan.
    if (!loc) {
      abortScan();
      lastScannedCatchment = null;
      store.dispatch(actions.setEvents({ status: 'idle', items: [], progress: null }));
      return;
    }
    if (!catchmentId) {
      abortScan();
      lastScannedCatchment = null;
      store.dispatch(actions.setEvents({
        status: 'done', items: [],
        progress: { scanned: 0, total: 0, done: true, note: 'Select a catchment to scan its major events (point/area scans are not available yet).' },
      }));
      return;
    }

    // Already scanned this catchment and have results — don't rescan on mode flip.
    if (catchmentId === lastScannedCatchment) {
      const ev = select.events(store.getState());
      if (ev && (ev.status === 'done' || ev.status === 'scanning')) return;
    }

    abortScan();
    lastScannedCatchment = catchmentId;
    const controller = makeAbortController();
    scanController = controller;

    // Seed the scanning state so the UI shows the progress bar immediately.
    store.dispatch(actions.setEvents({ status: 'scanning', items: [], progress: { scanned: 0, total: 0, done: false } }));

    scanner.scan(loc, {
      signal: controller ? controller.signal : undefined,
      onCandidate: (_candidate, ctx) => {
        if (destroyed || (controller && controller.signal && controller.signal.aborted)) return;
        // Push the current ranked list + progress into the store on each step.
        store.dispatch(actions.setEvents({
          status: ctx.progress && ctx.progress.done ? 'done' : 'scanning',
          items: ctx.ranked || [],
          progress: ctx.progress || null,
        }));
      },
    }).then((res) => {
      if (destroyed || (controller && controller.signal && controller.signal.aborted)) return;
      store.dispatch(actions.setEvents({ status: 'done', items: res.items || [], progress: res.progress || null }));
    }).catch((err) => {
      if (destroyed) return;
      store.dispatch(actions.setEvents({
        status: 'done', items: [],
        progress: { scanned: 0, total: 0, done: true, error: String((err && err.message) || err) },
      }));
    });
  }

  function abortScan() {
    if (scanController && typeof scanController.abort === 'function') {
      try { scanController.abort(); } catch (_) { /* noop */ }
    }
    scanController = null;
  }

  // ── Render: major-events list (from select.events) ────────────────────────────
  function renderEvents() {
    const ev = select.events(store.getState()) || { status: 'idle', items: [], progress: null };
    const loc = select.location(store.getState());
    const selectedTf = select.timeframe(store.getState());
    eventsWrap.innerHTML = '';

    eventsWrap.appendChild(el('h4', { class: 'sgevt-events__title', text: `Last ${cap} Major Events` }));

    if (!loc) {
      eventsWrap.appendChild(el('p', { class: 'sgevt-empty', text: 'Select a location to compute its major events on the fly.' }));
      return;
    }

    // Progress bar (honest "scanning N/M windows", or a note when none).
    const p = ev.progress || {};
    if (ev.status === 'scanning' || (p && !p.done && ev.status !== 'idle')) {
      const total = p.total || 0;
      const scanned = p.scanned || 0;
      const pct = total > 0 ? Math.round((scanned / total) * 100) : 0;
      eventsWrap.appendChild(progressBar(pct, `scanning archive · ${scanned}/${total} sources`));
    }

    // Notes / errors (gap honesty).
    if (p.note) eventsWrap.appendChild(el('p', { class: 'sgevt-note', text: p.note }));
    if (p.error) eventsWrap.appendChild(el('p', { class: 'sgevt-note sgevt-note--error', text: `Scan error: ${p.error}` }));
    if (p.aborted) eventsWrap.appendChild(el('p', { class: 'sgevt-note', text: 'Scan interrupted — partial list shown.' }));

    const items = Array.isArray(ev.items) ? ev.items : [];
    if (items.length === 0) {
      if (ev.status === 'done') {
        eventsWrap.appendChild(el('p', { class: 'sgevt-empty', text: 'No major events found for this location in the available archive/windows.' }));
      }
      return;
    }

    // Whether the AEP column is suppressed (gate closed) — read off the candidates.
    const gated = items.every((c) => c.aepBand == null);
    if (gated) {
      eventsWrap.appendChild(el('p', { class: 'sgevt-gatebanner', text: INDICATIVE_AEP_UNAVAILABLE_LABEL }));
    }

    const selectedId = selectedTf && selectedTf.kind === 'event' ? selectedTf.eventId : null;

    const list = el('ol', { class: 'sgevt-list', role: 'list' });
    items.forEach((c, i) => {
      list.appendChild(eventRow(c, i + 1, c.eventId === selectedId, gated, (id) => {
        // Selecting an event sets the timeframe (kind:'event'); aggregation begins.
        store.dispatch(actions.setTimeframe({ kind: 'event', eventId: id }));
      }));
    });
    eventsWrap.appendChild(list);
  }

  function progressBar(pct, label) {
    const wrap = el('div', { class: 'sgevt-progress' });
    const track = el('div', { class: 'sgevt-progress__track' }, [
      el('div', { class: 'sgevt-progress__fill', style: `width:${Math.max(0, Math.min(100, pct))}%` }),
    ]);
    wrap.appendChild(track);
    wrap.appendChild(el('span', { class: 'sgevt-progress__label', text: label }));
    return wrap;
  }

  function eventRow(c, rank, isSelected, gated, onSelect) {
    const aepText = gated
      ? 'suppressed'
      : (c.aepLabel || '—');
    const missing = c.coverage && c.coverage.framesMissing > 0;

    const btn = el('button', {
      type: 'button',
      class: 'sgevt-row' + (isSelected ? ' sgevt-row--selected' : ''),
      dataset: { eventId: c.eventId },
    });
    btn.appendChild(el('span', { class: 'sgevt-row__rank', text: String(rank) }));

    const main = el('span', { class: 'sgevt-row__main' });
    main.appendChild(el('span', { class: 'sgevt-row__date', text: fmtDate(c.startIso) }));
    main.appendChild(el('span', { class: 'sgevt-row__meta', text:
      `${c.duration || '—'} · ${fmtMm(c.catchmentMeanMm)} catchment mean` }));

    const aep = el('span', { class: 'sgevt-row__aep' + (gated ? ' sgevt-row__aep--gated' : '') });
    aep.appendChild(el('span', { text: gated ? '~AEP suppressed' : aepText }));
    main.appendChild(aep);

    if (missing) {
      main.appendChild(el('span', { class: 'sgevt-row__flag', text:
        `⚠ ${c.coverage.framesMissing} missing frame(s) — catchment-mean is a floor` }));
    }
    btn.appendChild(main);

    btn.appendChild(el('span', {
      class: 'sgevt-row__conf',
      title: (c.confidence && (c.confidence.reasons || []).join('; ')) || '',
      text: confidenceDots(c.confidence && c.confidence.tier),
    }));

    btn.addEventListener('click', () => onSelect(c.eventId));
    return btn;
  }

  // ── Render: manual timeframe (window + duration) ──────────────────────────────
  function renderManual() {
    manualWrap.innerHTML = '';
    manualWrap.appendChild(el('h4', { class: 'sgevt-manual__title', text: 'Manual timeframe' }));

    const state = store.getState();
    const tf = select.timeframe(state);
    const currentWindowKey = tf && tf.kind === 'window' ? tf.windowKey : DEFAULT_WINDOW_KEY;
    const currentDuration = select.duration(state);

    // Window selector.
    const windows = safeWindows();
    const winSel = el('select', { class: 'sgevt-select', 'aria-label': 'Accumulation window' });
    for (const w of windows) {
      const opt = el('option', { value: w.key, text: w.label });
      if (w.key === currentWindowKey) opt.setAttribute('selected', 'selected');
      winSel.appendChild(opt);
    }
    winSel.value = currentWindowKey;
    winSel.addEventListener('change', () => {
      // Window timeframe: endIso is the window's defined end; the precomputed window
      // already encodes its own end, so we pass null (the adapter resolves by key).
      store.dispatch(actions.setTimeframe({ kind: 'window', windowKey: winSel.value, endIso: null }));
    });
    manualWrap.appendChild(el('label', { class: 'sgevt-field' }, [
      el('span', { class: 'sgevt-field__label', text: 'Window' }), winSel,
    ]));

    // Duration selector (segmented buttons).
    const durRow = el('div', { class: 'sgevt-durs', role: 'group', 'aria-label': 'Critical duration' });
    for (const d of DURATION_KEYS) {
      const b = el('button', {
        type: 'button',
        class: 'sgevt-dur' + (d === currentDuration ? ' sgevt-dur--active' : ''),
        text: d,
      });
      b.addEventListener('click', () => store.dispatch(actions.setDuration(d)));
      durRow.appendChild(b);
    }
    manualWrap.appendChild(el('label', { class: 'sgevt-field' }, [
      el('span', { class: 'sgevt-field__label', text: 'Duration' }), durRow,
    ]));
  }

  function safeWindows() {
    try {
      const ws = getAvailableRainfallWindows();
      return Array.isArray(ws) && ws.length ? ws : [{ key: DEFAULT_WINDOW_KEY, label: DEFAULT_WINDOW_KEY }];
    } catch (_) {
      return [{ key: DEFAULT_WINDOW_KEY, label: DEFAULT_WINDOW_KEY }];
    }
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────--
  // Rescan on location change (docs/02 §5.2: events list recomputed per location).
  unsubs.push(store.subscribe(select.location, () => {
    if (mode === 'events') maybeStartScan();
    renderEvents();
    renderManual(); // window/duration reflect the new context too
  }));
  // Re-render the stream as it lands.
  unsubs.push(store.subscribe(select.events, () => renderEvents()));
  // Reflect the current timeframe selection (highlight selected event / window).
  unsubs.push(store.subscribe(select.timeframe, () => { renderEvents(); renderManual(); }));
  // Reflect duration changes in the manual segmented control.
  unsubs.push(store.subscribe(select.duration, () => renderManual()));

  // ── Initial render ─────────────────────────────────────────────────────────--
  applyModeVisibility();
  renderEvents();
  renderManual();
  if (mode === 'events') maybeStartScan();

  return {
    destroy() {
      destroyed = true;
      abortScan();
      for (const u of unsubs) { try { u(); } catch (_) { /* noop */ } }
      bodyEl.innerHTML = '';
      bodyEl.classList.remove('sgevt');
    },
  };
}

/** AbortController is available in modern browsers + node 16+. Fall back to a
 *  no-op shim if it is somehow absent so the scan still runs (just non-abortable). */
function makeAbortController() {
  if (typeof AbortController === 'function') return new AbortController();
  return { signal: { aborted: false }, abort() { this.signal.aborted = true; } };
}
