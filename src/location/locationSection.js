// locationSection.js — the spine's Location section (docs/02 §5.1, §10.2;
// docs/03 §2 LOCATION LAYER "LocationSection"). Mounts into the workspace's
// `location` slot body (see src/shell/workspace.js mountPoint bodies).
//
// RESPONSIBILITIES
//   - Address search (rewrite in ./addressSearch.js): on pick -> geocode result
//     -> geo.findCatchmentForPoint -> dispatch(setLocation) + dispatch(addRecentLocation).
//   - Mode toggle: catchment | point | area  (docs/02 §5.1).
//       catchment: selection is owned by the MAP (it dispatches setLocation on a
//                  polygon click — mapHost.js). This section REFLECTS the current
//                  selection and surfaces its provenance + confidence; it does not
//                  duplicate the map's click handling.
//       point:     a lat/lon entry path (map clicks are the map's scope). Entered
//                  coords are resolved via geo (containment or labelled guess).
//       area:      a DOCUMENTED STUB — needs a Leaflet draw control wired by the
//                  map layer later. It does NOT fabricate an area result.
//   - Selected location: shown with provenance surfaced inline
//     ("raster-derived · non-authoritative" from is_authoritative:false) and the
//     resolution confidence/reason where one applies (never presents a guess as
//     certain — docs/02 §5.1).
//   - Recent list from select.recentLocations.
//   - Persist recents: subscribe to select.recentLocations and call
//     saveRecentLocations on change (defensive; persistence may be unavailable).
//
// STORE: built against src/core/store.js — store.{getState,dispatch,subscribe},
// actions.{setLocation,clearLocation,addRecentLocation}, select.{location,recentLocations}.
// PERSISTENCE: src/core/persistence.js — saveRecentLocations / persistenceAvailable.
// A LocationRef is { catchmentId } | { lat, lon } | { areaRef }.

import { actions, select } from '../core/store.js';
import { saveRecentLocations, persistenceAvailable } from '../core/persistence.js';
import { mountAddressSearch } from './addressSearch.js';
import { findCatchmentForPoint, featureById, CONFIDENCE } from './geo.js';

const DEFAULT_CATCHMENTS_URL = './data/catchments/catchments_dissolved.geojson';
const MODES = Object.freeze(['catchment', 'point', 'area']);

// ── DOM helper (matches the house style in src/shell/workspace.js el()) ────────
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

function fmtArea(feature) {
  const p = feature && feature.properties;
  if (!p) return null;
  if (typeof p.area_ha === 'number') {
    return `${Math.round(p.area_ha).toLocaleString()} ha`;
  }
  if (typeof p.area_m2 === 'number') {
    return `${(p.area_m2 / 1e6).toFixed(2)} km²`;
  }
  return null;
}

// Human label for a LocationRef (used in Selected + Recent rows).
function locationLabel(loc) {
  if (!loc) return '—';
  if (loc.catchmentId) return loc.label || loc.catchmentId;
  if (loc.lat != null && loc.lon != null) {
    return loc.label || `Point ${Number(loc.lat).toFixed(4)}, ${Number(loc.lon).toFixed(4)}`;
  }
  if (loc.areaRef) return loc.label || `Drawn area (${loc.areaRef})`;
  return 'Location';
}

function confidenceDots(confidence) {
  switch (confidence) {
    case CONFIDENCE.HIGH: return '●●●';
    case CONFIDENCE.MEDIUM: return '●●○';
    case CONFIDENCE.LOW: return '●○○';
    default: return '○○○';
  }
}

/**
 * Mount the Location section.
 *
 * @param {HTMLElement} bodyEl  the slot body to render into (workspace `location` slot)
 * @param {{getState:Function, dispatch:Function, subscribe:Function}} store
 * @param {Object} [opts]
 * @param {string}  [opts.catchmentsUrl]   override the catchments GeoJSON URL
 * @param {Function} [opts.fetchImpl=fetch] injectable for tests
 * @param {Function} [opts.geocodeImpl]     injectable geocoder (forwarded to addressSearch)
 * @returns {{ destroy():void }}
 */
export function mountLocationSection(bodyEl, store, opts = {}) {
  if (!bodyEl) throw new Error('mountLocationSection: bodyEl is required');
  if (!store || typeof store.subscribe !== 'function') throw new Error('mountLocationSection: a store is required');

  const catchmentsUrl = opts.catchmentsUrl || DEFAULT_CATCHMENTS_URL;
  const fetchImpl = typeof opts.fetchImpl === 'function'
    ? opts.fetchImpl
    : (typeof fetch === 'function' ? fetch : null);

  let catchments = null;       // FeatureCollection once loaded
  let catchmentsError = null;  // string if the load failed
  let mode = 'catchment';
  const unsubs = [];
  let destroyed = false;

  bodyEl.classList.add('sgloc');
  bodyEl.innerHTML = '';

  // ── Address search ───────────────────────────────────────────────────────────
  const addressHost = el('div', { class: 'sgloc-block sgloc-block--address' });
  bodyEl.appendChild(addressHost);
  const addressSearch = mountAddressSearch(addressHost, {
    geocodeImpl: opts.geocodeImpl,
    onResolve: (hit) => resolveAddress(hit),
    onClear: () => {},
  });

  // ── Mode toggle ────────────────────────────────────────────────────────────--
  const modeWrap = el('fieldset', { class: 'sgloc-block sgloc-modes' }, [
    el('legend', { class: 'sgloc-modes__legend', text: 'Or select on map' }),
  ]);
  const modeInputs = {};
  for (const m of MODES) {
    const id = `sgloc-mode-${m}`;
    const radio = el('input', { type: 'radio', name: 'sgloc-mode', id, value: m, class: 'sgloc-modes__radio' });
    if (m === mode) radio.checked = true;
    radio.addEventListener('change', () => { if (radio.checked) setMode(m); });
    modeInputs[m] = radio;
    const labelText = m === 'catchment' ? 'Catchment'
      : m === 'point' ? 'Point'
      : 'Area (draw)';
    modeWrap.appendChild(el('label', { class: 'sgloc-modes__opt', for: id }, [radio, ` ${labelText}`]));
  }
  bodyEl.appendChild(modeWrap);

  // Per-mode help / input region (swapped on mode change).
  const modePanel = el('div', { class: 'sgloc-block sgloc-modepanel' });
  bodyEl.appendChild(modePanel);

  // ── Selected location ──────────────────────────────────────────────────────--
  const selectedWrap = el('div', { class: 'sgloc-block sgloc-selected', 'aria-live': 'polite' });
  bodyEl.appendChild(selectedWrap);

  // ── Recent list ────────────────────────────────────────────────────────────--
  const recentWrap = el('div', { class: 'sgloc-block sgloc-recent' });
  bodyEl.appendChild(recentWrap);

  // ── Persistence note (only when unavailable) ─────────────────────────────────
  const persistNote = el('p', { class: 'sgloc-persistnote' });
  if (!persistenceAvailable()) {
    persistNote.textContent = 'Recent locations are not saved (browser storage unavailable).';
  }
  bodyEl.appendChild(persistNote);

  // ── Resolution context for the CURRENT selection (confidence/reason). Only set
  //    when THIS section resolved the selection (address/point). For a map-click
  //    catchment selection we have no resolution record, so we surface provenance
  //    only and say selection came from the map. ──────────────────────────────--
  let lastResolution = null; // { catchmentId, confidence, reason } | null

  // ── Catchments load (for provenance lookup + point/address resolution) ────────
  loadCatchments();

  async function loadCatchments() {
    if (!fetchImpl) {
      catchmentsError = 'No fetch implementation available to load catchments.';
      renderSelected();
      return;
    }
    try {
      const r = await fetchImpl(catchmentsUrl, { cache: 'force-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const gj = await r.json();
      if (destroyed) return;
      catchments = gj && Array.isArray(gj.features) ? gj : null;
      if (!catchments) catchmentsError = 'Catchments file had no features.';
    } catch (err) {
      if (destroyed) return;
      catchmentsError = `Could not load catchments: ${String((err && err.message) || err)}`;
    }
    renderSelected(); // provenance may now be resolvable
  }

  // ── Address pick -> geocode result -> geo -> store ────────────────────────────
  // The addressSearch hit already carries lat/lon (Nominatim). We resolve the
  // containing catchment via geo; we NEVER fabricate a containment.
  function resolveAddress(hit) {
    if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) return;
    if (!catchments) {
      // Honest: cannot resolve a catchment without polygons. Select the point
      // itself (point LocationRef) so the workflow still advances, labelled.
      const loc = { lat: hit.lat, lon: hit.lon, label: hit.short_label || hit.display_name };
      lastResolution = { catchmentId: null, confidence: CONFIDENCE.UNKNOWN, reason: catchmentsError || 'Catchments not loaded; selected the address point.' };
      commitLocation(loc);
      return;
    }
    const res = findCatchmentForPoint(hit.lon, hit.lat, catchments);
    applyGeoResolution(res, { lat: hit.lat, lon: hit.lon, label: hit.short_label || hit.display_name });
  }

  // Point-mode lat/lon entry -> geo -> store.
  function resolvePoint(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (!catchments) {
      lastResolution = { catchmentId: null, confidence: CONFIDENCE.UNKNOWN, reason: catchmentsError || 'Catchments not loaded; selected the entered point.' };
      commitLocation({ lat, lon, label: `Point ${lat.toFixed(4)}, ${lon.toFixed(4)}` });
      return;
    }
    const res = findCatchmentForPoint(lon, lat, catchments);
    applyGeoResolution(res, { lat, lon, label: `Point ${lat.toFixed(4)}, ${lon.toFixed(4)}` });
  }

  // Decide the LocationRef from a geo resolution, preserving never-guess discipline.
  function applyGeoResolution(res, pointFallback) {
    lastResolution = { catchmentId: res.catchmentId, confidence: res.confidence, reason: res.reason };
    if ((res.confidence === CONFIDENCE.HIGH || res.confidence === CONFIDENCE.MEDIUM) && res.catchmentId) {
      // HIGH = containment; MEDIUM = labelled nearest-centroid guess (surfaced as such).
      const f = res.feature || featureById(res.catchmentId, catchments);
      const label = (f && f.properties && f.properties.catchment_id) || res.catchmentId;
      commitLocation({ catchmentId: res.catchmentId, label });
    } else {
      // LOW/UNKNOWN: no catchment containment. Select the POINT itself (honest),
      // and surface the reason. We never coerce a far/unknown match into a catchment.
      commitLocation({ ...pointFallback });
    }
  }

  function commitLocation(loc) {
    store.dispatch(actions.setLocation(loc));
    store.dispatch(actions.addRecentLocation(loc));
  }

  // ── Mode handling ──────────────────────────────────────────────────────────--
  function setMode(next) {
    if (!MODES.includes(next)) return;
    mode = next;
    if (modeInputs[mode] && !modeInputs[mode].checked) modeInputs[mode].checked = true;
    renderModePanel();
  }

  function renderModePanel() {
    modePanel.innerHTML = '';
    if (mode === 'catchment') {
      modePanel.appendChild(el('p', { class: 'sgloc-hint', text: 'Click a catchment on the map to select it. Provenance and confidence appear below.' }));
      return;
    }
    if (mode === 'point') {
      const latIn = el('input', { type: 'number', step: 'any', class: 'sgloc-coord', placeholder: 'Lat (e.g. -33.74)', 'aria-label': 'Latitude' });
      const lonIn = el('input', { type: 'number', step: 'any', class: 'sgloc-coord', placeholder: 'Lon (e.g. 151.27)', 'aria-label': 'Longitude' });
      const go = el('button', { type: 'button', class: 'sgloc-btn', text: 'Resolve point' });
      go.addEventListener('click', () => resolvePoint(Number(latIn.value), Number(lonIn.value)));
      modePanel.appendChild(el('p', { class: 'sgloc-hint', text: 'Enter a lat/lon, or click the map (map handles clicks). The point is resolved to a catchment by containment, with confidence.' }));
      modePanel.appendChild(el('div', { class: 'sgloc-coords' }, [latIn, lonIn, go]));
      return;
    }
    // area
    modePanel.appendChild(el('p', { class: 'sgloc-hint sgloc-hint--stub', text: 'Area (draw) is not yet available. It needs a Leaflet draw control wired by the map layer; this section will accept a drawn-area LocationRef ({ areaRef }) once that is in place. No area result is fabricated.' }));
  }

  // ── Render: selected location with provenance + confidence ────────────────────
  function renderSelected() {
    const loc = select.location(store.getState());
    selectedWrap.innerHTML = '';
    if (!loc) {
      selectedWrap.appendChild(el('p', { class: 'sgloc-empty', text: 'No location selected. Search an address, click a catchment, or enter a point.' }));
      return;
    }

    const header = el('div', { class: 'sgloc-selected__head' }, [
      el('span', { class: 'sgloc-selected__label', text: locationLabel(loc) }),
      (() => {
        const change = el('button', { type: 'button', class: 'sgloc-link', text: 'change' });
        change.addEventListener('click', () => clearSelection());
        return change;
      })(),
    ]);
    selectedWrap.appendChild(header);

    // Catchment selection: show area + provenance (is_authoritative:false).
    if (loc.catchmentId) {
      const feature = featureById(loc.catchmentId, catchments);
      const meta = el('div', { class: 'sgloc-selected__meta' });
      const areaStr = fmtArea(feature);
      meta.appendChild(el('span', { class: 'sgloc-selected__sub', text: areaStr ? `${areaStr} · raster-derived` : 'raster-derived' }));
      selectedWrap.appendChild(meta);

      // Provenance is ALWAYS shown wherever a catchment is shown.
      const authoritative = feature && feature.properties && feature.properties.is_authoritative === true;
      if (!authoritative) {
        selectedWrap.appendChild(el('p', { class: 'sgloc-warn', text: '⚠ non-authoritative boundary (raster-derived). Not for design/regulatory use without validation.' }));
      }
      if (!feature && catchmentsError) {
        selectedWrap.appendChild(el('p', { class: 'sgloc-warn', text: catchmentsError }));
      }

      // Resolution confidence: only when THIS section resolved this catchment.
      if (lastResolution && lastResolution.catchmentId === loc.catchmentId && lastResolution.confidence) {
        const conf = lastResolution.confidence;
        const tone = conf === CONFIDENCE.HIGH ? '' : 'sgloc-conf--guess';
        selectedWrap.appendChild(el('p', { class: `sgloc-conf ${tone}` }, [
          el('span', { class: 'sgloc-conf__dots', text: confidenceDots(conf) }),
          el('span', { class: 'sgloc-conf__text', text: ` ${conf} — ${lastResolution.reason}` }),
        ]));
      } else {
        // Selection came from the map (or hydrated from URL): no resolution record.
        selectedWrap.appendChild(el('p', { class: 'sgloc-conf__src', text: 'Selected on map (containment by polygon click).' }));
      }
      return;
    }

    // Point selection.
    if (loc.lat != null && loc.lon != null) {
      selectedWrap.appendChild(el('span', { class: 'sgloc-selected__sub', text: `lat ${Number(loc.lat).toFixed(5)}, lon ${Number(loc.lon).toFixed(5)}` }));
      if (lastResolution && lastResolution.reason) {
        const conf = lastResolution.confidence || CONFIDENCE.UNKNOWN;
        selectedWrap.appendChild(el('p', { class: 'sgloc-conf sgloc-conf--guess' }, [
          el('span', { class: 'sgloc-conf__dots', text: confidenceDots(conf) }),
          el('span', { class: 'sgloc-conf__text', text: ` ${conf} — ${lastResolution.reason}` }),
        ]));
      }
      return;
    }

    // Area selection (future).
    if (loc.areaRef) {
      selectedWrap.appendChild(el('span', { class: 'sgloc-selected__sub', text: `drawn area (${loc.areaRef})` }));
    }
  }

  function clearSelection() {
    lastResolution = null;
    addressSearch.setValue('');
    store.dispatch(actions.clearLocation());
  }

  // ── Render: recent list ────────────────────────────────────────────────────--
  function renderRecent() {
    const recents = select.recentLocations(store.getState()) || [];
    recentWrap.innerHTML = '';
    recentWrap.appendChild(el('h4', { class: 'sgloc-recent__title', text: 'Recent' }));
    if (recents.length === 0) {
      recentWrap.appendChild(el('p', { class: 'sgloc-empty', text: 'No recent locations yet.' }));
      return;
    }
    const list = el('ul', { class: 'sgloc-recent__list' });
    recents.forEach((loc) => {
      const btn = el('button', { type: 'button', class: 'sgloc-recent__item', text: locationLabel(loc) });
      // catchment recents carry the non-authoritative provenance inline as a tag
      if (loc.catchmentId) btn.appendChild(el('span', { class: 'sgloc-recent__tag', text: ' · non-authoritative' }));
      btn.addEventListener('click', () => {
        // Re-selecting a recent re-dispatches setLocation (which re-adds it to top).
        lastResolution = loc.catchmentId
          ? null // map-equivalent containment selection; no fresh resolution record
          : { catchmentId: null, confidence: CONFIDENCE.UNKNOWN, reason: 'Re-selected from recent locations.' };
        store.dispatch(actions.setLocation(loc));
        store.dispatch(actions.addRecentLocation(loc));
      });
      list.appendChild(el('li', { class: 'sgloc-recent__row' }, [btn]));
    });
    recentWrap.appendChild(list);
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────--
  unsubs.push(store.subscribe(select.location, () => renderSelected()));
  unsubs.push(store.subscribe(select.recentLocations, (recents) => {
    renderRecent();
    // Persist defensively — saveRecentLocations is a no-op if storage is unavailable.
    try { saveRecentLocations(recents || []); } catch (_) { /* never break the workspace */ }
  }));

  // ── Initial render from current state ─────────────────────────────────────────
  renderModePanel();
  renderSelected();
  renderRecent();

  return {
    destroy() {
      destroyed = true;
      for (const u of unsubs) { try { u(); } catch (_) { /* noop */ } }
      try { addressSearch.destroy(); } catch (_) { /* noop */ }
      bodyEl.innerHTML = '';
      bodyEl.classList.remove('sgloc');
    },
  };
}
