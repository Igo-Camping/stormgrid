/* Stormgrid — UI shell.
   Top: Last built strip + accumulation-window selector.
   Top section: catchment map (left), availability + selected results (right).
   Below: card grid + run bar + frame log panel.

   Window changes are auto-refreshing: existing catchment selection and Run
   state persist if the new dataset still has the catchment; if it doesn't,
   the availability panel shows "No precomputed data for <id> in this
   window" and Run is gated. */

import {
  createStormgridState, markManuallyChanged, STATUS,
  setSelectedCatchment, setRainfallData, setSelectedWindow, setSelectedDuration,
  recordAnalysisRun, clearAnalysisRun,
} from './stormgridState.js';
import { buildDefaults }            from './stormgridDefaults.js';
import { buildReviewModel }         from './stormgridReviewModel.js';
import { validateRunReadiness }     from './stormgridValidation.js';
import { registerStormgridMap, getMapContext } from './stormgridMapBridge.js';
import { mountCatchmentMap, applyConfidenceStyling } from './stormgridCatchmentMap.js';
import {
  loadRainfallData, getCatchmentRow,
  getAvailableRainfallWindows, DEFAULT_WINDOW_KEY,
  getAvailableDurations, getCatchmentDurationStats, pickDefaultDurationKey,
} from './stormgridDataLoader.js';
import {
  renderAvailabilityPanel, renderFrameLogPanel,
  renderLastBuiltStrip, renderWindowSelector, renderDurationSelector,
} from './stormgridAvailability.js';

const NS = 'stormgrid';
// Selector lists the three precomputed windows; "latest" is exposed as
// the implicit default (a copy of 24h) and not shown as a separate tile.
const SELECTOR_WINDOWS = getAvailableRainfallWindows()
  .filter((w) => w.key !== 'latest');
const ALL_DURATION_KEYS = ['3h', '6h', '12h', '24h', '48h', '72h'];

export function mountStormgridShell(host, options = {}) {
  if (!host || !(host instanceof HTMLElement)) {
    throw new Error('Stormgrid: mount host element is required.');
  }
  if (options && options.map) registerStormgridMap(options.map);

  const state = createStormgridState();
  let rainfallResult = null;
  let mapHandle = null;

  host.classList.add(`${NS}-root`);
  host.innerHTML = '';

  // ── Layout ────────────────────────────────────────────────────────────
  const controlsStrip = document.createElement('div');
  controlsStrip.className = `${NS}-controls`;
  const lastBuiltHost = document.createElement('div');
  const windowSelHost = document.createElement('div');
  controlsStrip.appendChild(lastBuiltHost);
  controlsStrip.appendChild(windowSelHost);
  host.appendChild(controlsStrip);

  const durSelHost = document.createElement('div');
  durSelHost.className = `${NS}-durationselwrap`;
  host.appendChild(durSelHost);

  const header = document.createElement('header');
  header.className = `${NS}-header`;
  header.innerHTML = `
    <h2 class="${NS}-title">Stormgrid <span class="${NS}-version">v0 shell</span></h2>
    <p class="${NS}-sub">Click a catchment, then click Run analysis. Stats come from the precomputed Lizard rainfall JSON (uncalibrated, non-engineering). Polygons are coloured by data-coverage confidence.</p>
  `;
  host.appendChild(header);

  const top = document.createElement('section');
  top.className = `${NS}-top`;
  const mapHost   = document.createElement('div'); mapHost.className   = `${NS}-mapcol`;
  const availHost = document.createElement('aside'); availHost.className = `${NS}-availcol`;
  top.appendChild(mapHost);
  top.appendChild(availHost);
  host.appendChild(top);

  const grid = document.createElement('section');
  grid.className = `${NS}-grid`;
  grid.setAttribute('role', 'list');
  host.appendChild(grid);

  const runBar = document.createElement('div');
  runBar.className = `${NS}-runbar`;
  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = `${NS}-run`;
  runBtn.textContent = 'Run analysis';
  runBtn.disabled = true;
  const runReason = document.createElement('span');
  runReason.className = `${NS}-runreason`;
  runBar.appendChild(runBtn);
  runBar.appendChild(runReason);
  host.appendChild(runBar);

  const frameLogHost = document.createElement('section');
  frameLogHost.className = `${NS}-framelogwrap`;
  host.appendChild(frameLogHost);

  runBtn.addEventListener('click', () => {
    const readiness = validateRunReadiness(state);
    if (!readiness.ready) return;
    recordAnalysisRun(state);
    render();
  });

  // ── Render ────────────────────────────────────────────────────────────
  function render() {
    const selected = describeSelected(state);
    const data = state.rainfallData;
    const catchmentRow = data && state.selectedCatchmentId
      ? getCatchmentRow(data, state.selectedCatchmentId)
      : null;

    const availableDurations = getAvailableDurations(data);
    // Snap selectedDuration to something available; if current pick isn't
    // there (e.g. window changed and 48h vanished), fall back to default.
    if (availableDurations.length > 0
        && !availableDurations.find((d) => d.key === state.selectedDuration)) {
      setSelectedDuration(state, pickDefaultDurationKey(availableDurations));
    }
    const durationStats = state.selectedCatchmentId && state.selectedDuration
      ? getCatchmentDurationStats(data, state.selectedCatchmentId, state.selectedDuration)
      : null;

    const defaults = buildDefaults({
      map: getMapContext(),
      selected,
      rainfallData: data,
    });
    const cards = buildReviewModel(state, defaults);
    grid.innerHTML = '';
    cards.forEach((card) => grid.appendChild(renderCard(card, onEdit)));

    renderLastBuiltStrip(lastBuiltHost, { rainfallResult });
    renderWindowSelector(windowSelHost, {
      windows: SELECTOR_WINDOWS,
      selectedKey: state.selectedWindow,
      onChange: onWindowChange,
    });
    renderDurationSelector(durSelHost, {
      durations: availableDurations,
      allKeys: ALL_DURATION_KEYS,
      selectedKey: state.selectedDuration,
      onChange: onDurationChange,
    });
    renderAvailabilityPanel(availHost, {
      rainfallResult,
      selected,
      catchmentRow,
      analysisRun: !!state.analysisRun,
      lastRunAt: state.lastRunAt,
      selectedDurationKey: state.selectedDuration,
      durationStats,
    });
    renderFrameLogPanel(frameLogHost, {
      data: rainfallResult && rainfallResult.ok ? rainfallResult.data : null,
    });

    if (mapHandle && data) {
      applyConfidenceStyling(mapHandle, data, {
        selectedDuration: state.selectedDuration,
      });
    }

    const readiness = validateRunReadiness(state);
    runBtn.disabled = !readiness.ready;
    runReason.textContent = readiness.ready
      ? (state.analysisRun
          ? `Ran ${formatTs(state.lastRunAt)} — click to recompute.`
          : 'Ready — click to compute results.')
      : `Disabled — ${readiness.reasons.join(' ')}`;
  }

  function onDurationChange(newKey) {
    if (newKey === state.selectedDuration) return;
    setSelectedDuration(state, newKey);
    render();
  }

  function onEdit(cardKey) {
    const current = state.cards[cardKey];
    const next = window.prompt(`Edit ${current.label}`, current.value ?? '');
    if (next === null) return;
    markManuallyChanged(state, cardKey, next.trim() === '' ? null : next);
    render();
  }

  function onCatchmentSelect(id, feature) {
    setSelectedCatchment(state, id, feature);
    clearAnalysisRun(state);
    render();
  }

  function onWindowChange(newKey) {
    if (newKey === state.selectedWindow) return;
    setSelectedWindow(state, newKey);
    rainfallResult = null;
    setRainfallData(state, null, null);
    render();
    loadRainfallData(newKey).then((res) => {
      if (state.selectedWindow !== newKey) return; // newer click superseded this
      rainfallResult = res;
      if (res.ok) setRainfallData(state, res.data, null);
      else        setRainfallData(state, null, res.error);
      if (mapHandle && res.ok) applyConfidenceStyling(mapHandle, res.data);
      render();
    });
  }

  render();

  // ── Async wiring ──────────────────────────────────────────────────────
  mountCatchmentMap(mapHost, { onSelect: onCatchmentSelect })
    .then((handle) => {
      mapHandle = handle;
      if (handle.map && options.map) registerStormgridMap(handle.map);
      if (rainfallResult && rainfallResult.ok) {
        applyConfidenceStyling(mapHandle, rainfallResult.data);
      }
    })
    .catch((err) => { console.error('Stormgrid map mount failed:', err); });

  loadRainfallData(state.selectedWindow || DEFAULT_WINDOW_KEY).then((res) => {
    rainfallResult = res;
    if (res.ok) setRainfallData(state, res.data, null);
    else        setRainfallData(state, null, res.error);
    if (mapHandle && res.ok) applyConfidenceStyling(mapHandle, res.data);
    render();
  });

  return {
    state,
    rerender: render,
    setWindow: onWindowChange,
    destroy() { host.innerHTML = ''; host.classList.remove(`${NS}-root`); },
  };
}

function describeSelected(state) {
  if (!state.selectedCatchmentId) return null;
  const id = state.selectedCatchmentId;
  const feat = state.selectedCatchmentFeature;
  const props = feat && feat.properties ? feat.properties : {};
  return {
    id,
    area_ha: props.area_ha,
    centroid: [props.centroid_lon, props.centroid_lat],
    bbox: [props.bbox_min_lon, props.bbox_min_lat, props.bbox_max_lon, props.bbox_max_lat],
  };
}

function formatTs(s) {
  if (!s) return '—';
  return String(s).replace('T', ' ').replace('Z', ' UTC');
}

function renderCard(card, onEdit) {
  const el = document.createElement('article');
  el.className = `${NS}-card ${NS}-card--${card.status}`;
  el.setAttribute('role', 'listitem');
  el.dataset.cardKey = card.key;

  const valueText = card.value === null || card.value === undefined || card.value === ''
    ? '—'
    : String(card.value);

  const statusLabel = card.status === STATUS.MANUAL ? 'Manually changed' : 'Default';

  el.innerHTML = `
    <header class="${NS}-card__head">
      <h3 class="${NS}-card__label">${escapeHtml(card.label)}</h3>
      <span class="${NS}-card__status" data-status="${card.status}">${statusLabel}</span>
    </header>
    <div class="${NS}-card__value">${escapeHtml(valueText)}</div>
    <p class="${NS}-card__reason">${escapeHtml(card.reason)}</p>
    <footer class="${NS}-card__foot">
      <span class="${NS}-card__confidence ${NS}-card__confidence--${escapeAttr(card.confidence)}"
            data-confidence="${escapeAttr(card.confidence)}"
            title="Confidence: ${escapeAttr(String(card.confidence))}">
        ${escapeHtml(formatConfidence(card.confidence))}
      </span>
      <button type="button" class="${NS}-card__edit">Edit</button>
    </footer>
  `;
  el.querySelector(`.${NS}-card__edit`).addEventListener('click', () => onEdit(card.key));
  return el;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '');
}

function formatConfidence(c) {
  const v = String(c || '').toLowerCase();
  if (v === 'low' || v === 'medium' || v === 'high') return v.toUpperCase();
  if (v === 'manual') return 'MANUAL';
  if (v === 'unknown' || v === '') return 'UNKNOWN';
  return v.toUpperCase();
}
