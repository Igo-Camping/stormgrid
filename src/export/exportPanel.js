// exportPanel.js — the Export panel (docs/02 §10.6; docs/03 §2 Export Layer).
//
// mountExportPanel(bodyEl, store) -> { destroy }
//
// Renders the export flow exactly as docs/02 §10.6 specifies:
//   - LEADS with the provenance line ("This export carries: location, timeframe,
//     all stats, coverage %, missing frames, source, calibration status, IFD basis,
//     ARF status. Gaps are reported, not filled.").
//   - Groups: Report (PDF/HTML) · Tabular (CSV/XLSX) · Geospatial (GeoJSON/raster) ·
//     Engineering (12d/DRAINS) · Image (PNG). Order + membership from exporters.js.
//   - Each format is marked honestly: ● works today / [greenfield] / [needs-X]
//     (status from the registry — the UI cannot over-claim).
//   - Export is DISABLED unless the workflow phase is SETTLED or DEGRADED (a result
//     exists). DEGRADED still exports — the gaps travel into the output.
//
// Built against src/core/store.js: store.{getState,subscribe}, select.{phase,
// windowResult,location,timeframe,duration,calibration,colourMode,layers}.
// It builds the footprint on demand (at click time) so the export always reflects
// the current state.
//
// House style: el() DOM helper matching workspace.js / locationSection.js /
// methodologyPanel.js. Touches only the element it is given; destroy() unsubscribes
// and clears its own DOM.

import { select } from '../core/store.js';
import { buildEventFootprint } from './footprint.js';
import { EXPORT_FORMATS, EXPORT_GROUPS, getExportFormat, isFormatRunnable } from './exporters.js';

const EXPORTABLE_PHASES = Object.freeze(['SETTLED', 'DEGRADED']);

const PROVENANCE_LINE =
  'This export carries: location, timeframe, all stats, coverage %, missing frames, '
  + 'source, calibration status, IFD basis, ARF status. Gaps are reported, not filled.';

// ── DOM helper (house style) ────────────────────────────────────────────────────
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

const STATUS_BADGE = Object.freeze({
  working: { text: '● works today', cls: 'sg-export__badge--ok' },
  greenfield: { text: '[greenfield]', cls: 'sg-export__badge--green' },
  stub: { text: '[needs setup]', cls: 'sg-export__badge--stub' },
});

/**
 * Mount the Export panel.
 *
 * @param {HTMLElement} bodyEl  the slot to mount into (the panel touches only this)
 * @param {{getState:Function, subscribe:Function}} store  the shared store
 * @param {Object} [opts]
 * @param {() => HTMLElement|null} [opts.getSnapshotEl]  returns the element to
 *        rasterise for PNG (e.g. the map+legend region). Defaults to null (PNG then
 *        reports its own missing-target error).
 * @param {(loc:Object) => Object|null} [opts.resolveLocationMeta]  optional resolver
 *        from a LocationRef to provenance meta (catchment feature props) for labels.
 * @returns {{destroy: Function}}
 */
export function mountExportPanel(bodyEl, store, opts = {}) {
  if (!bodyEl) throw new TypeError('mountExportPanel: bodyEl is required');
  if (!store || typeof store.subscribe !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('mountExportPanel: a store with getState/subscribe is required');
  }

  const getSnapshotEl = typeof opts.getSnapshotEl === 'function' ? opts.getSnapshotEl : () => null;
  const resolveLocationMeta = typeof opts.resolveLocationMeta === 'function'
    ? opts.resolveLocationMeta : () => null;

  const root = el('div', { class: 'sg-export' });
  bodyEl.appendChild(root);

  let statusNode = null; // aria-live status line

  /** Build the footprint from current store state. */
  function currentFootprint() {
    const s = store.getState();
    const location = select.location(s);
    return buildEventFootprint({
      windowResult: select.windowResult(s),
      location,
      timeframe: select.timeframe(s),
      duration: select.duration(s),
      calibration: select.calibration(s),
      colourMode: select.colourMode(s),
      layers: select.layers(s),
      phase: select.phase(s),
      locationMeta: location ? resolveLocationMeta(location) : null,
    });
  }

  function setStatus(msg, kind) {
    if (!statusNode) return;
    statusNode.textContent = msg || '';
    statusNode.className = 'sg-export__status' + (kind ? ` sg-export__status--${kind}` : '');
  }

  async function onRun(formatId) {
    const fmt = getExportFormat(formatId);
    if (!fmt) return;
    const phase = select.phase(store.getState());
    if (!EXPORTABLE_PHASES.includes(phase)) {
      setStatus('Export needs a loaded result (phase SETTLED or DEGRADED).', 'warn');
      return;
    }
    if (!isFormatRunnable(formatId)) {
      // Stub or unavailable — run it anyway so the format's own clear error surfaces.
      try {
        await fmt.run(currentFootprint(), buildCtx());
      } catch (e) {
        setStatus(e && e.message ? e.message : String(e), 'warn');
      }
      return;
    }
    try {
      setStatus(`Preparing ${fmt.label}…`, null);
      await fmt.run(currentFootprint(), buildCtx());
      setStatus(`${fmt.label} ready.`, 'ok');
    } catch (e) {
      setStatus(`${fmt.label}: ${e && e.message ? e.message : String(e)}`, 'warn');
    }
  }

  function buildCtx() {
    return {
      snapshotEl: getSnapshotEl(),
      reportOpts: { title: 'Stormgrid Event Report' },
      geojsonOpts: {},
      csvInterim: true, // XLSX falls back to a real CSV interim
    };
  }

  function render() {
    const s = store.getState();
    const phase = select.phase(s);
    const fp = (EXPORTABLE_PHASES.includes(phase)) ? currentFootprint() : null;
    const enabled = !!fp;

    root.innerHTML = '';
    root.appendChild(el('div', { class: 'sg-export__title', text: 'Export' }));

    // Provenance line — leads the panel (docs/02 §10.6).
    root.appendChild(el('p', { class: 'sg-export__provenance', text: PROVENANCE_LINE }));

    // Live honesty header about this specific result.
    if (fp) {
      root.appendChild(provenanceSummary(fp));
    } else {
      root.appendChild(el('p', {
        class: 'sg-export__disabled',
        text: 'Export is disabled until a result is loaded (workflow must be SETTLED or DEGRADED).',
      }));
    }

    // Groups.
    for (const group of EXPORT_GROUPS) {
      const formats = EXPORT_FORMATS.filter((f) => f.group === group.id);
      if (!formats.length) continue;
      const groupEl = el('div', { class: 'sg-export__group' }, [
        el('h4', { class: 'sg-export__grouptitle', text: group.label }),
      ]);
      for (const f of formats) {
        groupEl.appendChild(formatRow(f, enabled));
      }
      root.appendChild(groupEl);
    }

    // Status line (aria-live).
    statusNode = el('div', { class: 'sg-export__status', role: 'status', 'aria-live': 'polite' });
    root.appendChild(statusNode);
  }

  function formatRow(fmt, enabled) {
    const badge = STATUS_BADGE[fmt.status] || STATUS_BADGE.stub;
    const runnable = enabled && isFormatRunnable(fmt.id);
    // A stub is always shown but disabled (greenfield/needs-X). A working/greenfield
    // format is enabled only when a result exists.
    const btn = el('button', {
      type: 'button',
      class: 'sg-export__btn',
      dataset: { export: fmt.id },
    }, [fmt.label]);
    if (!runnable) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      if (fmt.status === 'stub') {
        btn.title = fmt.note || 'Not yet available.';
      } else if (!enabled) {
        btn.title = 'Load a result to enable this export.';
      }
    } else {
      btn.addEventListener('click', () => { onRun(fmt.id); });
    }

    const provTag = fmt.carriesProvenance
      ? el('span', { class: 'sg-export__prov sg-export__prov--yes', text: 'carries provenance' })
      : el('span', { class: 'sg-export__prov sg-export__prov--no', text: 'no embedded provenance' });

    return el('div', { class: `sg-export__row sg-export__row--${fmt.status}` }, [
      btn,
      el('span', { class: `sg-export__badge ${badge.cls}`, text: badge.text }),
      provTag,
      fmt.note ? el('span', { class: 'sg-export__note', text: fmt.note }) : null,
    ]);
  }

  function provenanceSummary(fp) {
    const cls = fp.defensible ? 'sg-export__honesty--ok' : 'sg-export__honesty--warn';
    const msg = fp.defensible
      ? 'Provenance complete for this result.'
      : (fp.isSynthetic
          ? 'This result is placeholder/synthetic — exports are illustrative, not engineering-defensible.'
          : 'This result is degraded (gaps present) — exports carry the gaps honestly.');
    const cov = fp.coverage;
    const covLine = cov && cov.pct != null
      ? ` Coverage ${cov.pct.toFixed(0)}%${cov.framesMissing ? `, ${cov.framesMissing} frame(s) missing` : ''}.`
      : '';
    return el('p', { class: `sg-export__honesty ${cls}`, text: msg + covLine });
  }

  // Re-render when phase or any provenance-bearing slice changes.
  const unsubs = [
    store.subscribe((st) => st.workflow.phase, render),
    store.subscribe((st) => st.data.windowResult, render),
    store.subscribe((st) => st.context.calibration, render),
    store.subscribe((st) => st.context.duration, render),
  ];
  render();

  return {
    destroy() {
      for (const u of unsubs) { try { u && u(); } catch (_) { /* idempotent */ } }
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}
