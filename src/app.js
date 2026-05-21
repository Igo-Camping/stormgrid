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

  // Mount the shell, injecting the map host into the centre stage. Other regions
  // remain honest placeholders until their Phase C components exist.
  let mapHandle = null;
  const workspace = mountWorkspace(container, store, {
    map: (bodyEl) => { mapHandle = mountMap(bodyEl, store); },
  });

  // URL <-> context routing; hydrates the context from the URL on start.
  const router = createRouter(store);
  router.start();

  return {
    store,
    source,
    workspace,
    router,
    destroy() {
      if (router && typeof router.stop === 'function') router.stop();
      if (mapHandle && typeof mapHandle.destroy === 'function') mapHandle.destroy();
      workspace.destroy();
    },
  };
}
