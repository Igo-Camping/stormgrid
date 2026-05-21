// workspace.js — the navigation shell's three-column layout (docs/02 §1, §10.1).
//
// mountWorkspace() builds the top bar + ContextSpine | MapStage | ResultsPanel
// triptych and returns handles to every labelled mount point, so the map host,
// location/event pickers, and results components (all built later, B.3) can
// mount into them. The shell OWNS LAYOUT ONLY. It does not fetch data, does not
// own the Leaflet instance, and does not implement the pickers — it renders
// honest placeholders where no real content is injected.
//
// State coupling is deliberately thin: the workspace subscribes to ONE slice —
// select.phase — and applies the pure describeWorkflow() treatment (docs/02 §3)
// to the shell chrome. Everything else flows through the injected regions.
//
// Mobile-aware (docs/02 §9): the spine and results regions are built as
// overlay-capable from the start (the `sg-region--overlay` class toggle), so a
// later mobile pass converts them to sheets without a rewrite. On desktop they
// dock; the dock/sheet decision is a class switch, not a re-architecture.

import { describeWorkflow } from './workflowView.js';

// ── Small DOM helpers (no framework) ──────────────────────────────────────────
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

/** A labelled, empty mount point. Other layers mount real content into `.body`. */
function mountPoint(label, slotName, placeholder) {
  const body = el('div', { class: 'sg-slot__body', 'data-slot': slotName });
  if (placeholder) body.appendChild(el('p', { class: 'sg-placeholder', text: placeholder }));
  const wrap = el('section', { class: 'sg-slot', 'data-slot-wrap': slotName }, [
    el('h3', { class: 'sg-slot__label', text: label }),
    body,
  ]);
  return { wrap, body, slotName, placeholder };
}

/**
 * Apply an injected region/slot callback, or leave the honest placeholder.
 * A region callback receives the slot's body element and may mount into it.
 * @returns {boolean} true if injected content replaced the placeholder
 */
function applyRegion(slot, regions, key) {
  const inject = regions && typeof regions[key] === 'function' ? regions[key] : null;
  if (!inject) return false;
  slot.body.innerHTML = ''; // clear the placeholder; injected content owns the body
  inject(slot.body);
  return true;
}

/**
 * Build the workspace and mount it into `container`.
 *
 * @param {HTMLElement} container  the host element (e.g. #app)
 * @param {Object} store           createStore() instance — used read-only here:
 *                                  store.getState(), store.subscribe(selector, cb)
 * @param {Object} [regions]       optional mount callbacks, each (bodyEl) => void:
 *   - breadcrumb       top-bar Location > Event > Map breadcrumb
 *   - sourceChip       top-bar data-source / freshness chip
 *   - topExport        top-bar Export entry
 *   - location         spine Location section
 *   - event            spine Event / Timeframe section
 *   - layers           spine Layers section
 *   - spineConfidence  spine confidence chip (mirror of the results chip)
 *   - map              centre Map stage
 *   - summary          results summary stats
 *   - confidence       results always-visible confidence chip
 *   - resultsExport    results Export entry
 * @returns {{ root, regions, slots, setPhaseView, destroy }}
 *   - root         the workspace root element
 *   - regions      handles to the three region containers { spine, map, results, topBar }
 *   - slots        handles to every mount point keyed by name (each { wrap, body, ... })
 *   - setPhaseView(view) imperatively apply a WorkflowView (used by the subscription)
 *   - destroy()    unsubscribe and remove the workspace from the DOM
 */
export function mountWorkspace(container, store, regions = {}) {
  if (!container) throw new Error('mountWorkspace: container is required');

  // ── Top bar ────────────────────────────────────────────────────────────────
  const breadcrumb = mountPoint('Breadcrumb', 'breadcrumb', 'Location ▸ Event ▸ Map');
  const sourceChip = mountPoint('Data source', 'sourceChip', 'Data source — pending');
  const topExport = mountPoint('Export', 'topExport', 'Export — pending');
  breadcrumb.wrap.classList.add('sg-topbar__breadcrumb');
  sourceChip.wrap.classList.add('sg-topbar__chip');
  topExport.wrap.classList.add('sg-topbar__export');

  const topBar = el('header', { class: 'sg-topbar', role: 'banner' }, [
    el('span', { class: 'sg-topbar__brand', text: 'Stormgrid' }),
    breadcrumb.wrap,
    el('div', { class: 'sg-topbar__spacer' }),
    sourceChip.wrap,
    topExport.wrap,
  ]);

  // ── Context spine (left) — overlay-capable for the pickers + mobile (§5, §9) ─
  const locationSlot = mountPoint('Location', 'location', 'Location picker — pending');
  const eventSlot = mountPoint('Event / Timeframe', 'event', 'Event / Timeframe picker — pending');
  const layersSlot = mountPoint('Layers', 'layers', 'Layer controls — pending');
  const spineConfidence = mountPoint('Confidence', 'spineConfidence', 'Confidence chip — pending');
  spineConfidence.wrap.classList.add('sg-slot--chip');

  const spine = el('aside', { class: 'sg-region sg-region--spine', 'data-region': 'spine', 'aria-label': 'Context spine' }, [
    locationSlot.wrap, eventSlot.wrap, layersSlot.wrap, spineConfidence.wrap,
  ]);

  // ── Map stage (centre) — dominant surface ────────────────────────────────────
  const mapSlot = mountPoint('Map', 'map', 'Map stage — pending');
  mapSlot.wrap.classList.add('sg-slot--stage');
  const stageBanner = el('div', { class: 'sg-stage__banner', 'data-slot': 'stageBanner', hidden: 'hidden' });
  const mapStage = el('main', { class: 'sg-region sg-region--map', 'data-region': 'map', 'aria-label': 'Map stage' }, [
    stageBanner, mapSlot.wrap,
  ]);

  // ── Results (right) — overlay-capable; confidence always visible (§6) ─────────
  const summarySlot = mountPoint('Summary', 'summary', 'Summary stats — pending');
  const confidenceSlot = mountPoint('Confidence', 'confidence', 'Confidence chip — pending');
  confidenceSlot.wrap.classList.add('sg-slot--chip', 'sg-slot--confidence');
  const resultsExport = mountPoint('Export', 'resultsExport', 'Export — pending');

  const results = el('aside', { class: 'sg-region sg-region--results', 'data-region': 'results', 'aria-label': 'Results panel' }, [
    summarySlot.wrap, confidenceSlot.wrap, resultsExport.wrap,
  ]);

  // ── Assemble ─────────────────────────────────────────────────────────────────
  const body = el('div', { class: 'sg-body' }, [spine, mapStage, results]);
  const root = el('div', { class: 'sg-workspace', 'data-state': 'state-empty' }, [topBar, body]);

  // Collect every slot under one keyed map for the orchestrator.
  const slots = {
    breadcrumb, sourceChip, topExport,
    location: locationSlot, event: eventSlot, layers: layersSlot, spineConfidence,
    map: mapSlot,
    summary: summarySlot, confidence: confidenceSlot, resultsExport,
  };

  // Inject any provided region content; honest placeholders remain otherwise.
  for (const key of Object.keys(slots)) applyRegion(slots[key], regions, key);

  container.appendChild(root);

  // ── Phase-driven chrome ───────────────────────────────────────────────────────
  /**
   * Apply a WorkflowView (from workflowView.describeWorkflow) to the shell chrome.
   * Only the shell's own structural treatment is touched — never injected content.
   */
  function setPhaseView(wfView) {
    root.dataset.state = wfView.statusClass;
    root.classList.toggle('sg-workspace--settled', wfView.settledLooking === true);
    mapStage.dataset.mapTreatment = wfView.mapTreatment;

    // Honest banner: shown for AGGREGATING / DEGRADED / ERROR, hidden otherwise.
    if (wfView.banner) {
      stageBanner.textContent = wfView.banner;
      stageBanner.dataset.tone = wfView.statusClass;
      stageBanner.hidden = false;
    } else {
      stageBanner.textContent = '';
      stageBanner.hidden = true;
    }

    // Region activity flags expose state for CSS / later wiring without owning content.
    spine.dataset.active = String(!!wfView.regions.spine);
    mapStage.dataset.active = String(!!wfView.regions.map);
    results.dataset.active = String(!!wfView.regions.results);
    spine.dataset.focus = wfView.spine.focus;

    // The export entries reflect enablement honestly (disabled until SETTLED/DEGRADED).
    for (const exp of [slots.topExport.wrap, slots.resultsExport.wrap]) {
      exp.dataset.enabled = String(!!wfView.exportEnabled);
    }
  }

  // Subscribe to phase only; re-derive the treatment on change (docs/02 §3).
  // The store's subscribe fires cb(selectedSlice, fullState) when the slice changes.
  const unsubscribe = store.subscribe(
    (s) => s.workflow.phase,
    (phase, state) => setPhaseView(describeWorkflow(phase, state.data.windowResult, state.workflow.error)),
  );

  // Apply the initial treatment from current state.
  {
    const s0 = store.getState();
    setPhaseView(describeWorkflow(s0.workflow.phase, s0.data.windowResult, s0.workflow.error));
  }

  function destroy() {
    unsubscribe();
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  return {
    root,
    regions: { topBar, spine, map: mapStage, results },
    slots,
    setPhaseView,
    destroy,
  };
}

/**
 * Toggle a region between docked (desktop) and overlay (sheet/picker) presentation.
 * The mobile pass (docs/02 §9) and the picker expansions (docs/02 §5) both use
 * this — it is a class switch, not a re-mount. `which` is 'spine' | 'results'.
 */
export function setRegionOverlay(workspaceHandle, which, overlay) {
  const region = workspaceHandle && workspaceHandle.regions && workspaceHandle.regions[which];
  if (!region) return false;
  region.classList.toggle('sg-region--overlay', overlay === true);
  return true;
}
