// app.js — B.3 integration entry. Wires the foundations together:
// store + persistence + URL routing + navigation shell + map host + the
// active SourceAdapter. This is the coherence merge of the four B.2 slices.
//
// What works at end of Phase B: the three-column workspace mounts, the map
// shows clickable catchment boundaries (a click dispatches setLocation, driving
// the workflow-state machine), the URL reflects the context and is shareable,
// and the LizardArchiveAdapter is registered and selected. The Location/Event/
// Analysis/Export/Methodology *components* that fill the spine and results
// regions are Phase C — until then those regions show honest placeholders.

import { createStore, initialState } from './core/store.js';
import { loadRecentLocations } from './core/persistence.js';
import { createSourceAdapter, registeredSourceAdapters } from './core/sourceAdapter.js';
import './adapters/lizardArchiveAdapter.js'; // self-registers 'lizard-archive' on import
import { mountWorkspace } from './shell/workspace.js';
import { createRouter } from './shell/router.js';
import { mountMap } from './map/mapHost.js';
import { createAggregationController } from './aggregation/aggregationController.js';
import { mountLocationSection } from './location/locationSection.js';
import { createEventScanner } from './event/eventScanner.js';
import { mountEventSection } from './event/eventSection.js';
import { mountSummaryStats } from './analysis/summaryStats.js';
import { computeAep } from './analysis/aepEstimator.js';
import { mountConfidenceChip } from './methodology/confidenceChip.js';
import { mountMethodologyPanel } from './methodology/methodologyPanel.js';
import { mountExportPanel } from './export/exportPanel.js';

const DEFAULT_SOURCE_ID = 'lizard-archive';

/**
 * Mount the Stormgrid workspace into a container element.
 * @param {HTMLElement} container
 * @returns {{store, source, workspace, router, destroy}}
 */
export function mountStormgridApp(container) {
  if (!container) throw new Error('mountStormgridApp: container is required');

  // Persisted tier (saved/recent locations). URL context hydration is the router's job.
  const preset = initialState();
  preset.session.recentLocations = loadRecentLocations();
  const store = createStore(preset);

  // Select the active data source explicitly — never an implicit fallback (docs/03 §8).
  if (!registeredSourceAdapters().includes(DEFAULT_SOURCE_ID)) {
    throw new Error(`source adapter '${DEFAULT_SOURCE_ID}' not registered (have: ${registeredSourceAdapters()})`);
  }
  const source = createSourceAdapter(DEFAULT_SOURCE_ID);

  // Mount the shell, injecting each Phase C layer component into its region.
  // The map host owns the centre stage; the spine gets Location; the results
  // panel gets Summary stats + the always-visible Confidence chip. Regions with
  // no component yet (event, layers) keep their honest placeholders.
  let mapHandle = null;
  const layerHandles = [];

  // On-the-fly event scanner. computeAep is passed so candidates carry an
  // indicative AEP band when the gate is open; under the placeholder source it
  // returns gated and the scanner ranks by catchment-mean severity instead.
  const eventScanner = createEventScanner({ source, computeAep });

  const workspace = mountWorkspace(container, store, {
    map: (bodyEl) => { mapHandle = mountMap(bodyEl, store); },
    location: (bodyEl) => { layerHandles.push(mountLocationSection(bodyEl, store)); },
    event: (bodyEl) => { layerHandles.push(mountEventSection(bodyEl, store, { scanner: eventScanner })); },
    summary: (bodyEl) => { layerHandles.push(mountSummaryStats(bodyEl, store)); },
    confidence: (bodyEl) => { layerHandles.push(mountConfidenceChip(bodyEl, store)); },
    resultsExport: (bodyEl) => { layerHandles.push(mountExportPanel(bodyEl, store)); },
  });

  // The aggregation controller is the data-flow spine: on a timeframe change it
  // calls source.getWindow and dispatches the validated result (or an error).
  const aggregation = createAggregationController(store, source);
  aggregation.start();

  // Methodology is a routed surface (never a modal): mounted into an overlay on
  // the workspace when the URL routes to #methodology, destroyed on close. The
  // map stays visible behind it (docs/02 §6).
  const methodologyOverlay = document.createElement('div');
  methodologyOverlay.className = 'sg-method-overlay';
  methodologyOverlay.hidden = true;
  workspace.root.appendChild(methodologyOverlay);
  let methodologyHandle = null;

  const router = createRouter(store, {
    onSurfaceChange: (surface) => {
      if (surface === 'methodology') {
        methodologyOverlay.hidden = false;
        if (!methodologyHandle) {
          methodologyHandle = mountMethodologyPanel(methodologyOverlay, store, {
            closeMethodology: () => router.closeSurface(),
          });
        }
      } else {
        if (methodologyHandle) { methodologyHandle.destroy(); methodologyHandle = null; }
        methodologyOverlay.hidden = true;
        // 'labs' surface is not implemented yet (deferred); the overlay stays hidden.
      }
    },
  });
  router.start();

  return {
    store,
    source,
    workspace,
    router,
    aggregation,
    destroy() {
      if (router && typeof router.stop === 'function') router.stop();
      if (aggregation && typeof aggregation.stop === 'function') aggregation.stop();
      if (methodologyHandle && typeof methodologyHandle.destroy === 'function') methodologyHandle.destroy();
      for (const h of layerHandles) { if (h && typeof h.destroy === 'function') h.destroy(); }
      if (mapHandle && typeof mapHandle.destroy === 'function') mapHandle.destroy();
      workspace.destroy();
    },
  };
}
