/* Stormgrid v0 — UI shell.
   Mounts: header, catchment map, availability/results panel, card grid,
   run bar. Loads the static rainfall JSON in parallel with the catchment
   map. No imports from Stormgauge map/radar/station modules. */

import {
  createStormgridState, markManuallyChanged, STATUS,
  setSelectedCatchment, setRainfallData,
  recordAnalysisRun, clearAnalysisRun,
} from './stormgridState.js';
import { buildDefaults }            from './stormgridDefaults.js';
import { buildReviewModel }         from './stormgridReviewModel.js';
import { validateRunReadiness }     from './stormgridValidation.js';
import { registerStormgridMap, getMapContext } from './stormgridMapBridge.js';
import { mountCatchmentMap }        from './stormgridCatchmentMap.js';
import { loadStormgridData, getCatchmentRow } from './stormgridDataLoader.js';
import { renderAvailabilityPanel }  from './stormgridAvailability.js';

const NS = 'stormgrid';

export function mountStormgridShell(host, options = {}) {
  if (!host || !(host instanceof HTMLElement)) {
    throw new Error('Stormgrid: mount host element is required.');
  }
  if (options && options.map) {
    registerStormgridMap(options.map);
  }

  const state = createStormgridState();
  let rainfallResult = null;

  host.classList.add(`${NS}-root`);
  host.innerHTML = '';

  // ── Layout ────────────────────────────────────────────────────────────
  const header = document.createElement('header');
  header.className = `${NS}-header`;
  header.innerHTML = `
    <h2 class="${NS}-title">Stormgrid <span class="${NS}-version">v0 shell</span></h2>
    <p class="${NS}-sub">Click a catchment, then click Run analysis. Stats come from the precomputed Lizard rainfall JSON (uncalibrated, non-engineering).</p>
  `;
  host.appendChild(header);

  const top = document.createElement('section');
  top.className = `${NS}-top`;
  const mapHost = document.createElement('div');
  mapHost.className = `${NS}-mapcol`;
  const availHost = document.createElement('aside');
  availHost.className = `${NS}-availcol`;
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

  runBtn.addEventListener('click', () => {
    const readiness = validateRunReadiness(state);
    if (!readiness.ready) return;
    recordAnalysisRun(state);
    render();
  });

  // ── Render ────────────────────────────────────────────────────────────
  function render() {
    const selected = describeSelected(state);
    const catchmentRow = state.rainfallData && state.selectedCatchmentId
      ? getCatchmentRow(state.rainfallData, state.selectedCatchmentId)
      : null;

    const defaults = buildDefaults({
      map: getMapContext(),
      selected,
      rainfallData: state.rainfallData,
    });
    const cards = buildReviewModel(state, defaults);
    grid.innerHTML = '';
    cards.forEach((card) => grid.appendChild(renderCard(card, onEdit)));

    renderAvailabilityPanel(availHost, {
      rainfallResult,
      selected,
      catchmentRow,
      analysisRun: !!state.analysisRun,
      lastRunAt: state.lastRunAt,
    });

    const readiness = validateRunReadiness(state);
    runBtn.disabled = !readiness.ready;
    runReason.textContent = readiness.ready
      ? (state.analysisRun
          ? `Ran ${formatTs(state.lastRunAt)} — click to recompute.`
          : 'Ready — click to compute results.')
      : `Disabled — ${readiness.reasons.join(' ')}`;
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

  render();

  // ── Async wiring ──────────────────────────────────────────────────────
  mountCatchmentMap(mapHost, { onSelect: onCatchmentSelect })
    .then(({ map }) => { if (map && options.map) registerStormgridMap(map); })
    .catch((err) => { console.error('Stormgrid map mount failed:', err); });

  loadStormgridData().then((res) => {
    rainfallResult = res;
    if (res.ok) setRainfallData(state, res.data, null);
    else        setRainfallData(state, null, res.error);
    render();
  });

  return {
    state,
    rerender: render,
    destroy() { host.innerHTML = ''; host.classList.remove(`${NS}-root`); },
  };
}

function describeSelected(state) {
  if (!state.selectedCatchmentId) return null;
  const id = state.selectedCatchmentId;
  // Pull metadata from the GeoJSON feature (set by map click) — JSON
  // payload is flat-summary-only and does not carry geometry props.
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
