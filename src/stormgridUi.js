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
  setMapColourMode, setIfdDisplayMode,
  recordAnalysisRun, clearAnalysisRun,
  setOperationalAddress, setOperationalCatchment, setOperationalIfd,
  setOperationalEventWindow, setOperationalNearbyGauges,
  recordOperationalOverride, clearOperationalContext,
} from './stormgridState.js';
import { renderAddressSearchBar } from './stormgridAddressSearch.js';
import { findCatchmentForPoint, nearbyReferenceStations } from './stormgridGeo.js';
import { detectEventWindow } from './stormgridEventWindowDetection.js';
import { renderOperationalContextPanel } from './stormgridOperationalContextPanel.js';
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
  renderMapModeSelector,
} from './stormgridAvailability.js';
import { renderRankingPanel } from './stormgridRanking.js';
import { buildEventFootprint } from './stormgridSnapshot.js';
import {
  renderEventSummaryPanel, exportCsv, exportJson, exportGeoJSON, exportPngSnapshot,
} from './stormgridExports.js';
import { loadCatchmentIfd, getCatchmentIfd } from './stormgridIfdLoader.js';
import { renderIfdComparisonPanel } from './stormgridIfdPanel.js';
import { loadArfCoefficients } from './stormgridArf.js';
import {
  loadEventArchiveIndex, loadCatchmentClimatology, loadEventArchiveEntry,
  renderEventArchivePanel, renderCatchmentHistoryPanel,
  comparablePastEvents, pickCatchmentClimatology,
} from './stormgridEventArchive.js';
import {
  loadGaugeObservations,
  computePairings, summarisePairings, computeCalibrationFactors,
  applyCalibration,
  renderCalibrationModeSelector, renderCalibrationPanel,
  CALIBRATION_METHODOLOGY_NOTE,
} from './stormgridCalibration.js';
import {
  loadAssets, computeAssetExposure, summariseExposure,
  defaultAssetFilters, applyAssetFilters,
  applyAssetOverlay, renderAssetFilters, renderInfrastructureExposurePanel,
  ASSETS_METHODOLOGY_NOTE,
} from './stormgridAssets.js';

const NS = 'stormgrid';
// Selector lists the three precomputed windows; "latest" is exposed as
// the implicit default (a copy of 24h) and not shown as a separate tile.
const SELECTOR_WINDOWS = getAvailableRainfallWindows()
  .filter((w) => w.key !== 'latest');
const ALL_DURATION_KEYS = ['3h', '6h', '12h', '24h', '48h', '72h'];
const MAP_COLOUR_MODES = [
  { key: 'confidence',         label: 'Data confidence' },
  { key: 'criticalRainfall',   label: 'Critical-duration rainfall' },
  { key: 'spatialVariability', label: 'Spatial variability' },
];

export function mountStormgridShell(host, options = {}) {
  if (!host || !(host instanceof HTMLElement)) {
    throw new Error('Stormgrid: mount host element is required.');
  }
  if (options && options.map) registerStormgridMap(options.map);

  const state = createStormgridState();
  let rainfallResult = null;
  let liveRainfallResult = null;       // preserved across archive restore so we can return-to-live
  let ifdResult = null;
  let arfResult = null;
  let mapHandle = null;
  // Phase 13 — event archive + climatology
  let archiveResult = null;            // { ok, data: indexJson, error }
  let climatologyResult = null;        // { ok, data: climatologyJson, error }
  const archivedEntries = {};          // event_id → loaded event.json (cached)
  let activeArchivedEventId = null;
  // Phase 14 — calibration
  let gaugeResult = null;              // { ok, data: gauge_observations.json, error }
  let calibrationMode = 'raw';         // 'raw' | 'calibrated'
  let lastRenderCalib = null;          // computed during render(); reused by onExportClick + ranking selection
  // Phase 15 — assets
  let assetsResult = null;             // { ok, data: FeatureCollection, error }
  let assetFilters = defaultAssetFilters();
  let lastRenderAssets = null;         // { rows, summary, filteredRows } cache for export reuse
  // Ranking-panel local state — kept here rather than in stormgridState
  // because it's a presentation concern, not a workflow primitive.
  let rankingFilters = { minMm: null, confidence: 'any' };
  let rankingSort    = { key: 'max', order: 'desc' };
  let lastExportNote = '';

  host.classList.add(`${NS}-root`);
  host.innerHTML = '';

  // ── Layout ────────────────────────────────────────────────────────────
  // Address-first search bar (Phase 12) — sits above the controls strip.
  const addressHost = document.createElement('div');
  addressHost.className = `${NS}-addresswrap-outer`;
  host.appendChild(addressHost);

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

  const mapModeHost = document.createElement('div');
  mapModeHost.className = `${NS}-mapmodewrap`;
  host.appendChild(mapModeHost);

  // Phase 14 — calibration mode selector (Raw / Calibrated)
  const calibModeHost = document.createElement('div');
  calibModeHost.className = `${NS}-calibmodewrap-outer`;
  host.appendChild(calibModeHost);

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

  const ifdHost = document.createElement('section');
  ifdHost.className = `${NS}-ifdwrap-outer`;
  host.appendChild(ifdHost);

  // Phase 12 — Operational context panel (below the IFD comparison panel,
  // above the existing event-summary / exports).
  const opCtxHost = document.createElement('section');
  opCtxHost.className = `${NS}-opctxwrap-outer`;
  host.appendChild(opCtxHost);

  // Phase 14 — Calibration summary panel
  const calibPanelHost = document.createElement('section');
  calibPanelHost.className = `${NS}-calibwrap-outer`;
  host.appendChild(calibPanelHost);

  // Phase 15 — Asset filters + Infrastructure exposure panel
  const assetFiltersHost = document.createElement('section');
  assetFiltersHost.className = `${NS}-assetfilterswrap-outer`;
  host.appendChild(assetFiltersHost);

  const assetPanelHost = document.createElement('section');
  assetPanelHost.className = `${NS}-infrawrap-outer`;
  host.appendChild(assetPanelHost);

  // Phase 13 — Event archive + Catchment history. Archive lives directly
  // below the operational context panel; catchment history sits beneath
  // it so the per-catchment counters stay near the per-catchment context.
  const archiveHost = document.createElement('section');
  archiveHost.className = `${NS}-archivewrap-outer`;
  host.appendChild(archiveHost);

  const historyHost = document.createElement('section');
  historyHost.className = `${NS}-historywrap-outer`;
  host.appendChild(historyHost);

  const eventHost = document.createElement('section');
  eventHost.className = `${NS}-eventwrap`;
  host.appendChild(eventHost);

  const frameLogHost = document.createElement('section');
  frameLogHost.className = `${NS}-framelogwrap`;
  host.appendChild(frameLogHost);

  const rankingHost = document.createElement('section');
  rankingHost.className = `${NS}-rankingwrap`;
  host.appendChild(rankingHost);

  runBtn.addEventListener('click', () => {
    const readiness = validateRunReadiness(state);
    if (!readiness.ready) return;
    recordAnalysisRun(state);
    render();
  });

  // ── Render ────────────────────────────────────────────────────────────
  function render() {
    const selected = describeSelected(state);

    // Phase 14 — compute calibration once per render. The raw rainfall
    // result is always preserved; calibrated mode swaps a calibrated
    // copy in for downstream renderers/exports while raw_total_mm
    // stays attached so the operation is reversible.
    const rawData = state.rainfallData;
    const gaugeOk = !!(gaugeResult && gaugeResult.ok && gaugeResult.data);
    const geojson = mapHandle && mapHandle.geojson;
    let pairings = null;
    let calibSummary = null;
    let calibFactors = null;
    let calibratedData = null;
    if (rawData && gaugeOk && geojson) {
      pairings = computePairings({
        gaugeData:    gaugeResult.data,
        rainfallData: rawData,
        geojson,
        windowKey:    state.selectedWindow,
      });
      calibSummary = summarisePairings(pairings);
      calibFactors = computeCalibrationFactors({ pairings, geojson });
      calibratedData = applyCalibration({ rainfallData: rawData, calibrationFactors: calibFactors });
    }
    const data = (calibrationMode === 'calibrated' && calibratedData) ? calibratedData : rawData;
    // Effective rainfallResult shown to renderers that read from the
    // result wrapper (timestamps, frame log etc.). When calibrated,
    // they see calibrated totals but the live timestamps still apply.
    const effectiveRainfallResult = (calibrationMode === 'calibrated' && calibratedData && rainfallResult && rainfallResult.ok)
      ? { ok: true, data: calibratedData, error: null }
      : rainfallResult;

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

    renderLastBuiltStrip(lastBuiltHost, { rainfallResult: effectiveRainfallResult });
    renderCalibrationModeSelector(calibModeHost, {
      mode: calibrationMode,
      gaugeOk,
      onChange: onCalibrationModeChange,
    });
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
    renderMapModeSelector(mapModeHost, {
      modes: MAP_COLOUR_MODES,
      selectedKey: state.mapColourMode,
      onChange: onMapColourModeChange,
    });
    renderCalibrationPanel(calibPanelHost, {
      mode: calibrationMode,
      gaugeData:   gaugeResult && gaugeResult.ok ? gaugeResult.data : null,
      gaugeError:  gaugeResult && !gaugeResult.ok ? gaugeResult.error : null,
      pairings,
      summary:     calibSummary,
      factors:     calibFactors,
      selectedCatchmentId: state.selectedCatchmentId,
    });

    renderAvailabilityPanel(availHost, {
      rainfallResult: effectiveRainfallResult,
      selected,
      catchmentRow,
      analysisRun: !!state.analysisRun,
      lastRunAt: state.lastRunAt,
      selectedDurationKey: state.selectedDuration,
      durationStats,
      spatialMetrics: durationStats && durationStats.spatial_metrics ? durationStats.spatial_metrics : null,
    });
    // IFD comparison panel (always rendered with warning, even pre-data).
    const durationStatsByKey = {};
    if (data && state.selectedCatchmentId) {
      const cRow = data.catchments[state.selectedCatchmentId];
      if (cRow && cRow.duration_stats) {
        Object.assign(durationStatsByKey, cRow.duration_stats);
      }
    }
    // Catchment area in km² from the GeoJSON feature properties (area_ha → km²).
    let catchmentAreaKm2 = null;
    if (state.selectedCatchmentFeature && state.selectedCatchmentFeature.properties) {
      const a = state.selectedCatchmentFeature.properties.area_ha;
      if (typeof a === 'number' && Number.isFinite(a)) catchmentAreaKm2 = a / 100;
    }
    renderIfdComparisonPanel(ifdHost, {
      ifdResult,
      arfResult,
      catchmentId: state.selectedCatchmentId,
      catchmentRow,
      durationStatsByKey,
      catchmentAreaKm2,
      ifdDisplayMode: state.ifdDisplayMode,
      onIfdModeChange,
    });

    // Address bar (always rendered; preserves text/focus across re-renders).
    renderAddressSearchBar(addressHost, {
      current: state.operationalContext && state.operationalContext.address,
      onResolve: onAddressResolve,
      onClear:   onAddressClear,
    });

    // Operational context panel.
    const op = state.operationalContext;
    const opReady = !!(op && op.address);
    const catchmentOptions = (mapHandle && mapHandle.geojson)
      ? (mapHandle.geojson.features || [])
          .map((f) => f.properties && f.properties.catchment_id)
          .filter(Boolean)
      : [];
    renderOperationalContextPanel(opCtxHost, {
      context: op,
      ready: opReady,
      catchmentOptions,
      durationOptions: ALL_DURATION_KEYS,
      onOverrideCatchment: onOpCatchmentOverride,
      onResetCatchment:    onOpCatchmentReset,
      onOverrideEventWindow: onOpEventWindowOverride,
      onResetEventWindow:    onOpEventWindowReset,
    });

    // Phase 13 — Event archive panel
    renderEventArchivePanel(archiveHost, {
      archiveIndex: archiveResult && archiveResult.ok ? archiveResult.data : null,
      archiveLoadError: archiveResult && !archiveResult.ok ? archiveResult.error : null,
      activeArchivedEventId,
      selectedAccumulationWindow: state.selectedWindow,
      onRestore: onArchiveRestore,
      onReturnToLive,
      onArchiveCurrent: onArchiveDownloadCurrent,
    });

    // Phase 15 — recompute asset exposure each render so the panel,
    // map overlay AND the event-summary footprint export react to
    // window / duration / calibration / filter changes. This block
    // must run BEFORE renderEventSummaryPanel so its closure can
    // reference filteredRows + exposureSummary.
    const exposure = (assetsResult && assetsResult.ok && data)
      ? computeAssetExposure({
          assets: assetsResult.data,
          rainfallData: data,
          durationKey: state.selectedDuration,
          calibrationMode,
        })
      : { rows: [], dataset_max_rainfall_mm: 0, dataset_max_critical_mm: 0 };
    const filteredRows = applyAssetFilters(exposure.rows, assetFilters);
    const exposureSummary = summariseExposure(filteredRows);
    lastRenderAssets = { exposure, filteredRows, summary: exposureSummary };

    renderAssetFilters(assetFiltersHost, {
      filters:        assetFilters,
      onChange:       onAssetFiltersChange,
      datasetCount:   exposure.rows.length,
      filteredCount:  filteredRows.length,
    });
    renderInfrastructureExposurePanel(assetPanelHost, {
      loadResult:        assetsResult,
      filteredRows,
      datasetCount:      exposure.rows.length,
      summary:           exposureSummary,
      scopedCatchmentId: assetFilters.catchmentScope,
      calibrationMode,
    });
    if (mapHandle) applyAssetOverlay(mapHandle, exposure.rows, assetFilters);

    // Phase 13 — Catchment history panel
    const climData = climatologyResult && climatologyResult.ok ? climatologyResult.data : null;
    const climErr  = climatologyResult && !climatologyResult.ok ? climatologyResult.error : null;
    const cmpEvents = (climData && state.selectedCatchmentId)
      ? comparablePastEvents({
          archiveIndex: archiveResult && archiveResult.ok ? archiveResult.data : null,
          eventEntriesById: archivedEntries,
          catchmentId: state.selectedCatchmentId,
          accumulationWindow: state.selectedWindow,
          limit: 5,
        })
      : [];
    renderCatchmentHistoryPanel(historyHost, {
      catchmentId: state.selectedCatchmentId,
      climatologyData: climData,
      climatologyError: climErr,
      selectedAccumulationWindow: state.selectedWindow,
      comparableEvents: cmpEvents,
    });

    renderEventSummaryPanel(eventHost, {
      footprint: buildEventFootprint({
        state,
        rainfallResult: effectiveRainfallResult,
        rankingFilters, rankingSort,
        selectedCatchmentId: state.selectedCatchmentId,
        selectedCatchmentFeature: state.selectedCatchmentFeature,
        ifdResult, arfResult,
        archiveIndex: archiveResult && archiveResult.ok ? archiveResult.data : null,
        climatologyData: climData,
        archivedEntriesById: archivedEntries,
        activeArchivedEventId,
        calibrationMode,
        calibrationPairings: pairings,
        calibrationSummary:  calibSummary,
        calibrationFactors:  calibFactors,
        gaugeData:           gaugeResult && gaugeResult.ok ? gaugeResult.data : null,
        assetExposureRows:    filteredRows,
        assetExposureSummary: exposureSummary,
        assetFilters,
        assetsDatasetMeta:    assetsResult && assetsResult.ok && assetsResult.data ? assetsResult.data.metadata : null,
      }),
      onExport: onExportClick,
      lastExportNote,
    });
    renderFrameLogPanel(frameLogHost, {
      data: effectiveRainfallResult && effectiveRainfallResult.ok ? effectiveRainfallResult.data : null,
    });
    renderRankingPanel(rankingHost, {
      data: effectiveRainfallResult && effectiveRainfallResult.ok ? effectiveRainfallResult.data : null,
      durationKey: state.selectedDuration,
      selectedCatchmentId: state.selectedCatchmentId,
      filters: rankingFilters,
      sort: rankingSort,
      onSelectCatchment: onRankingSelect,
      onFiltersChange: (f) => { rankingFilters = f; render(); },
      onSortChange:    (s) => { rankingSort = s; render(); },
    });

    if (mapHandle && data) {
      applyConfidenceStyling(mapHandle, data, {
        selectedDuration: state.selectedDuration,
        mode: state.mapColourMode,
      });
    }

    // Stash the live calibration context so onExportClick can re-use
    // it without recomputing pairings on click.
    lastRenderCalib = {
      pairings, summary: calibSummary, factors: calibFactors,
      gaugeData: gaugeResult && gaugeResult.ok ? gaugeResult.data : null,
      effectiveRainfallResult,
    };

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

  function onMapColourModeChange(newMode) {
    if (newMode === state.mapColourMode) return;
    setMapColourMode(state, newMode);
    render();
  }

  function onIfdModeChange(newMode) {
    if (newMode === state.ifdDisplayMode) return;
    setIfdDisplayMode(state, newMode);
    render();
  }

  function onExportClick(kind) {
    const calib = lastRenderCalib || {};
    const exportRainfallResult = calib.effectiveRainfallResult || rainfallResult;
    const assets = lastRenderAssets || {};
    const fp = buildEventFootprint({
      state, rainfallResult: exportRainfallResult, rankingFilters, rankingSort,
      selectedCatchmentId: state.selectedCatchmentId,
      selectedCatchmentFeature: state.selectedCatchmentFeature,
      ifdResult, arfResult,
      archiveIndex: archiveResult && archiveResult.ok ? archiveResult.data : null,
      climatologyData: climatologyResult && climatologyResult.ok ? climatologyResult.data : null,
      archivedEntriesById: archivedEntries,
      activeArchivedEventId,
      calibrationMode,
      calibrationPairings: calib.pairings,
      calibrationSummary:  calib.summary,
      calibrationFactors:  calib.factors,
      gaugeData:           calib.gaugeData,
      assetExposureRows:    assets.filteredRows,
      assetExposureSummary: assets.summary,
      assetFilters,
      assetsDatasetMeta:    assetsResult && assetsResult.ok && assetsResult.data ? assetsResult.data.metadata : null,
    });
    if (!fp || !fp.catchments || fp.catchments.length === 0) {
      lastExportNote = 'Nothing to export — no catchments in this view.';
      render();
      return;
    }
    lastExportNote = `Preparing ${kind.toUpperCase()}…`;
    render();
    const finish = (msg) => { lastExportNote = msg; render(); };
    try {
      if (kind === 'csv') {
        exportCsv(fp);
        finish(`CSV downloaded (${fp.catchment_count} rows).`);
      } else if (kind === 'json') {
        exportJson(fp);
        finish(`JSON downloaded.`);
      } else if (kind === 'geojson') {
        exportGeoJSON(fp)
          .then(() => finish(`GeoJSON downloaded (${fp.catchment_count} features).`))
          .catch((err) => finish(`GeoJSON failed: ${err.message}`));
      } else if (kind === 'png') {
        // Snapshot the whole Stormgrid app region (sg-page covers controls + map + panels).
        const target = host.closest('main') || host;
        exportPngSnapshot(target, fp)
          .then(() => finish(`PNG snapshot downloaded.`))
          .catch((err) => finish(`PNG failed: ${err.message}`));
      } else {
        finish(`Unknown export: ${kind}`);
      }
    } catch (err) {
      finish(`Export failed: ${err.message}`);
    }
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

  function onRankingSelect(id) {
    if (!id) return;
    let feature = null;
    if (mapHandle && mapHandle.layer) {
      mapHandle.layer.eachLayer((lyr) => {
        const f = lyr.feature;
        if (f && f.properties && f.properties.catchment_id === id) feature = f;
      });
    }
    setSelectedCatchment(state, id, feature);
    clearAnalysisRun(state);
    // Mirror a polygon click on the map so the polygon also visibly reflects selection.
    if (mapHandle && mapHandle.layer) {
      mapHandle.layer.eachLayer((lyr) => {
        const f = lyr.feature;
        if (f && f.properties && f.properties.catchment_id === id) {
          if (typeof lyr.fire === 'function') lyr.fire('click');
        }
      });
    } else {
      render();
    }
  }

  /* ── Address-first flow (Phase 12) ─────────────────────────────────── */

  function onAddressResolve(hit) {
    if (!hit) return;
    setOperationalAddress(state, {
      query:        hit.short_label || hit.display_name,
      display_name: hit.display_name,
      short_label:  hit.short_label,
      lat:          hit.lat,
      lon:          hit.lon,
      geocoder:     hit.geocoder,
      importance:   hit.importance,
      type:         hit.type,
      category:     hit.category,
      address:      hit.address,
      resolved_at:  new Date().toISOString(),
    });

    // 1) Catchment auto-select.
    const gj = mapHandle && mapHandle.geojson;
    const lookup = gj
      ? findCatchmentForPoint(hit.lon, hit.lat, gj)
      : { feature: null, id: null, confidence: 'unknown', reason: 'Catchment GeoJSON not yet loaded.', distance_km: null, nearestId: null };

    setOperationalCatchment(state, {
      id:           lookup.id,
      auto:         true,
      confidence:   lookup.confidence,
      reason:       lookup.reason,
      distance_km:  lookup.distance_km,
      nearest_id:   lookup.nearestId,
    });

    if (lookup.feature && lookup.id) {
      setSelectedCatchment(state, lookup.id, lookup.feature);
      clearAnalysisRun(state);
      // Phase 15 — auto-scope the assets panel to the resolved catchment
      // so operators see the relevant assets immediately. Cleared via the
      // filter row's "Reset" button.
      assetFilters = { ...assetFilters, catchmentScope: lookup.id };
      // Mirror the polygon click visually so confidence styling/selection updates.
      if (mapHandle && mapHandle.layer) {
        mapHandle.layer.eachLayer((lyr) => {
          const f = lyr.feature;
          if (f && f.properties && f.properties.catchment_id === lookup.id) {
            if (typeof lyr.fire === 'function') lyr.fire('click');
          }
        });
      }
    }

    // 2) Map zoom — fly to the address, then back to the catchment bounds
    //    if a catchment matched. Falls back to setView when flyTo is gated
    //    (e.g. headless tests with a tiny container).
    if (mapHandle && mapHandle.map) {
      const m = mapHandle.map;
      try {
        if (typeof m.flyTo === 'function') m.flyTo([hit.lat, hit.lon], 14, { duration: 0.6 });
        else m.setView([hit.lat, hit.lon], 14);
      } catch (_e) {
        try { m.setView([hit.lat, hit.lon], 14); } catch (_e2) {}
      }
    }

    // 3) IFD reference — pre-mapped per catchment in the IFD JSON; lifted
    //    straight from the loaded data so we never invent a station.
    let ifdPayload = null;
    if (ifdResult && ifdResult.ok && ifdResult.data && lookup.id) {
      const entry = ifdResult.data.catchments && ifdResult.data.catchments[lookup.id];
      if (entry && entry.reference_station_id) {
        ifdPayload = {
          reference_station_id:    entry.reference_station_id,
          reference_station_name:  entry.reference_station_name || entry.reference_station_id,
          reference_station_lonlat: Array.isArray(entry.reference_station_lonlat) ? entry.reference_station_lonlat.slice() : null,
          distance_km:             typeof entry.reference_station_distance_km === 'number' ? entry.reference_station_distance_km : null,
          auto:                    true,
          confidence:              lookup.confidence === 'low' ? 'low' : (lookup.confidence === 'medium' ? 'medium' : 'high'),
          reason:                  `Pre-mapped reference station for catchment ${lookup.id}.`,
        };
      }
    }
    setOperationalIfd(state, ifdPayload);

    // 4) Event-window detection — uses precomputed duration_stats only.
    const win = (rainfallResult && rainfallResult.ok)
      ? detectEventWindow({
          catchmentId: lookup.id,
          rainfallData: rainfallResult.data,
          preferredDurationKey: state.selectedDuration,
        })
      : null;
    if (win) {
      setOperationalEventWindow(state, { ...win, auto: true, override: false });
    } else {
      setOperationalEventWindow(state, lookup.id ? {
        start: null, end: null, total_mm: null,
        duration_key: state.selectedDuration || null,
        confidence: 'unknown',
        source: 'rolling_max_in_accumulation_window',
        reason: 'No duration stats for this catchment in the selected accumulation window.',
        auto: true, override: false,
      } : null);
    }

    // 5) Nearby gauges — distances from the address to every reference
    //    station in the IFD lookup table.
    if (ifdResult && ifdResult.ok && ifdResult.data) {
      setOperationalNearbyGauges(state, nearbyReferenceStations(hit.lon, hit.lat, ifdResult.data, { limit: 5 }));
    }

    render();
  }

  function onAddressClear() {
    clearOperationalContext(state);
    render();
  }

  function onOpCatchmentOverride() {
    const op = state.operationalContext;
    const current = op && op.catchment ? op.catchment.id : '';
    const next = window.prompt('Override catchment ID (e.g. catch_3):', current || '');
    if (next === null) return;
    const trimmed = String(next).trim();
    if (!trimmed) return;
    let feat = null;
    if (mapHandle && mapHandle.geojson) {
      feat = (mapHandle.geojson.features || []).find((f) => f.properties && f.properties.catchment_id === trimmed) || null;
    }
    if (!feat) {
      window.alert(`Catchment "${trimmed}" not found in the loaded GeoJSON.`);
      return;
    }
    const prevId = current;
    recordOperationalOverride(state, 'catchment', prevId, trimmed);
    setOperationalCatchment(state, {
      id:           trimmed,
      auto:         false,
      override:     true,
      confidence:   'manual',
      reason:       `Manually overridden by operator (was: ${prevId || '—'}).`,
      distance_km:  null,
      nearest_id:   trimmed,
    });
    setSelectedCatchment(state, trimmed, feat);
    clearAnalysisRun(state);
    if (mapHandle && mapHandle.layer) {
      mapHandle.layer.eachLayer((lyr) => {
        const f = lyr.feature;
        if (f && f.properties && f.properties.catchment_id === trimmed) {
          if (typeof lyr.fire === 'function') lyr.fire('click');
        }
      });
    }
    // Refresh IFD + event window for the newly selected catchment.
    if (ifdResult && ifdResult.ok && ifdResult.data) {
      const entry = ifdResult.data.catchments && ifdResult.data.catchments[trimmed];
      if (entry && entry.reference_station_id) {
        setOperationalIfd(state, {
          reference_station_id:    entry.reference_station_id,
          reference_station_name:  entry.reference_station_name || entry.reference_station_id,
          reference_station_lonlat: Array.isArray(entry.reference_station_lonlat) ? entry.reference_station_lonlat.slice() : null,
          distance_km:             typeof entry.reference_station_distance_km === 'number' ? entry.reference_station_distance_km : null,
          auto:                    false,
          override:                true,
          confidence:              'manual',
          reason:                  `Pre-mapped reference station for catchment ${trimmed} (selected after operator override).`,
        });
      }
    }
    if (rainfallResult && rainfallResult.ok) {
      const w = detectEventWindow({ catchmentId: trimmed, rainfallData: rainfallResult.data, preferredDurationKey: state.selectedDuration });
      setOperationalEventWindow(state, w ? { ...w, auto: false, override: true } : null);
    }
    render();
  }

  function onOpCatchmentReset() {
    const op = state.operationalContext;
    if (!op || !op.address) return;
    // Re-run the address resolve flow to restore auto-selections.
    const addr = op.address;
    onAddressResolve({
      short_label:  addr.short_label,
      display_name: addr.display_name,
      lat:          addr.lat,
      lon:          addr.lon,
      geocoder:     addr.geocoder,
      importance:   addr.importance,
      type:         addr.type,
      category:     addr.category,
      address:      addr.address,
    });
  }

  function onOpEventWindowOverride() {
    const op = state.operationalContext;
    if (!op || !op.catchment || !op.catchment.id) {
      window.alert('Select an address (or catchment) first.');
      return;
    }
    const cur = (op.eventWindow && op.eventWindow.duration_key) || state.selectedDuration || '24h';
    const promptList = ALL_DURATION_KEYS.join(', ');
    const next = window.prompt(`Override duration for event-window detection.\nAllowed: ${promptList}\nCurrent: ${cur}`, cur);
    if (next === null) return;
    const trimmed = String(next).trim();
    if (!ALL_DURATION_KEYS.includes(trimmed)) {
      window.alert(`Unknown duration "${trimmed}". Use one of: ${promptList}`);
      return;
    }
    if (rainfallResult && rainfallResult.ok) {
      const w = detectEventWindow({ catchmentId: op.catchment.id, rainfallData: rainfallResult.data, preferredDurationKey: trimmed });
      const prev = op.eventWindow ? op.eventWindow.duration_key : null;
      recordOperationalOverride(state, 'eventWindow', prev, trimmed);
      setOperationalEventWindow(state, w ? { ...w, auto: false, override: true, reason: `Operator selected ${trimmed} duration window (was: ${prev || 'auto'}).` } : null);
      setSelectedDuration(state, trimmed);
      render();
    }
  }

  function onOpEventWindowReset() {
    const op = state.operationalContext;
    if (!op || !op.catchment || !op.catchment.id) return;
    if (rainfallResult && rainfallResult.ok) {
      const w = detectEventWindow({
        catchmentId: op.catchment.id,
        rainfallData: rainfallResult.data,
        preferredDurationKey: null, // force auto re-pick
      });
      setOperationalEventWindow(state, w ? { ...w, auto: true, override: false } : null);
      render();
    }
  }

  /* ── Assets (Phase 15) ─────────────────────────────────────────────── */

  function onAssetFiltersChange(nextFilters) {
    assetFilters = nextFilters;
    render();
  }

  /* ── Calibration mode (Phase 14) ───────────────────────────────────── */

  function onCalibrationModeChange(newMode) {
    if (newMode !== 'raw' && newMode !== 'calibrated') return;
    if (newMode === calibrationMode) return;
    if (newMode === 'calibrated' && !(gaugeResult && gaugeResult.ok)) return;
    calibrationMode = newMode;
    render();
  }

  /* ── Event archive (Phase 13) ──────────────────────────────────────── */

  async function onArchiveRestore(eventId, archivePath) {
    if (!eventId) return;
    // Preserve the live result so we can restore it.
    if (!liveRainfallResult) liveRainfallResult = rainfallResult;
    const res = await loadEventArchiveEntry(eventId, archivePath);
    if (!res.ok || !res.data || !res.data.rainfall_data) {
      lastExportNote = `Archive restore failed: ${res.error || 'no rainfall_data'}`;
      render();
      return;
    }
    archivedEntries[eventId] = res.data;
    activeArchivedEventId = eventId;
    rainfallResult = { ok: true, data: res.data.rainfall_data };
    setRainfallData(state, res.data.rainfall_data, null);
    if (res.data.accumulation_window) setSelectedWindow(state, res.data.accumulation_window);
    clearAnalysisRun(state);
    if (mapHandle) applyConfidenceStyling(mapHandle, res.data.rainfall_data, {
      selectedDuration: state.selectedDuration,
      mode: state.mapColourMode,
    });
    render();
  }

  function onReturnToLive() {
    if (!liveRainfallResult) return;
    activeArchivedEventId = null;
    rainfallResult = liveRainfallResult;
    if (rainfallResult.ok) setRainfallData(state, rainfallResult.data, null);
    clearAnalysisRun(state);
    if (mapHandle && rainfallResult.ok) applyConfidenceStyling(mapHandle, rainfallResult.data, {
      selectedDuration: state.selectedDuration,
      mode: state.mapColourMode,
    });
    render();
  }

  /** Operator-driven local archive: download a JSON of the *current*
      rainfall snapshot so it can be dropped into data/_archive_inbox/
      and re-ingested by scripts/build_event_archive.py. We never write
      to the deployed bucket from the browser. */
  function onArchiveDownloadCurrent() {
    const r = rainfallResult;
    if (!r || !r.ok || !r.data) {
      lastExportNote = 'Nothing to archive — load rainfall data first.';
      render();
      return;
    }
    try {
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const win = (state.selectedWindow || 'window');
      const ts = (r.data.window && r.data.window.start ? r.data.window.start : new Date().toISOString())
        .replace(/[-:]/g, '').replace(/\.\d+/, '').replace('Z', 'Z');
      a.href = url;
      a.download = `catchment_rainfall_${win}_${ts}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 250);
      lastExportNote = `Snapshot downloaded — drop in data/_archive_inbox/ and re-run build_event_archive.py.`;
    } catch (err) {
      lastExportNote = `Archive download failed: ${err.message}`;
    }
    render();
  }

  function onWindowChange(newKey) {
    if (newKey === state.selectedWindow) return;
    // Window switch implicitly leaves archive-restore mode (since the
    // restored snapshot was tied to its original window).
    if (activeArchivedEventId) {
      activeArchivedEventId = null;
      liveRainfallResult = null; // force a fresh fetch for the new window
    }
    setSelectedWindow(state, newKey);
    rainfallResult = null;
    setRainfallData(state, null, null);
    render();
    loadRainfallData(newKey).then((res) => {
      if (state.selectedWindow !== newKey) return; // newer click superseded this
      rainfallResult = res;
      liveRainfallResult = res;
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
    liveRainfallResult = res;
    if (res.ok) setRainfallData(state, res.data, null);
    else        setRainfallData(state, null, res.error);
    if (mapHandle && res.ok) applyConfidenceStyling(mapHandle, res.data);
    render();
  });

  // Phase 13 — load archive index + climatology, then warm the per-event
  // cache so comparablePastEvents has data on first render.
  loadEventArchiveIndex().then(async (res) => {
    archiveResult = res;
    render();
    if (res && res.ok && res.data && Array.isArray(res.data.events)) {
      const tasks = res.data.events.slice(0, 12).map((meta) =>
        loadEventArchiveEntry(meta.event_id, meta.archive_path)
          .then((e) => { if (e && e.ok) archivedEntries[meta.event_id] = e.data; })
          .catch(() => {})
      );
      await Promise.all(tasks);
      render();
    }
  });

  loadCatchmentClimatology().then((res) => {
    climatologyResult = res;
    render();
  });

  // Phase 14 — gauge observations for calibration. Loaded once; pairings
  // and per-catchment factors are recomputed on every render based on the
  // active rainfall_data + window so they react to window switches and
  // archive restores automatically.
  loadGaugeObservations().then((res) => {
    gaugeResult = res;
    render();
  });

  // Phase 15 — assets register. Exposure scores are recomputed every render
  // so they reflect the active window / duration / calibration mode.
  loadAssets().then((res) => {
    assetsResult = res;
    render();
  });

  loadCatchmentIfd().then((res) => {
    ifdResult = res;
    render();
  });

  loadArfCoefficients().then((res) => {
    arfResult = res;
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
