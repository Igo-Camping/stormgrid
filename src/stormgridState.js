/* Stormgrid v0 — state container.
   Isolated from Stormgauge. Holds smart-default review state plus
   the catchment selection + static-rainfall integration flags. */

export const STORMGRID_VERSION = 'v0-shell';

export const CARD_KEYS = Object.freeze([
  'area',
  'rainfallEvent',
  'rainfallSource',
  'gauges',
  'durations',
  'ifdAep',
  'outputs',
]);

export const CARD_LABELS = Object.freeze({
  area:           'Area',
  rainfallEvent:  'Rainfall event',
  rainfallSource: 'Rainfall source',
  gauges:         'Gauges',
  durations:      'Durations',
  ifdAep:         'IFD / AEP reference',
  outputs:        'Outputs',
});

export const STATUS = Object.freeze({
  DEFAULT: 'default',
  MANUAL:  'manually-changed',
});

export const CONFIDENCE = Object.freeze({
  HIGH:    'high',
  MEDIUM:  'medium',
  LOW:     'low',
  UNKNOWN: 'unknown',
});

export function createStormgridState() {
  return {
    version: STORMGRID_VERSION,
    integrationReady: false,
    selectedCatchmentId: null,
    selectedCatchmentFeature: null,
    rainfallData: null,
    rainfallError: null,
    selectedWindow: '24h',
    selectedDuration: '24h',
    mapColourMode: 'confidence',
    ifdDisplayMode: 'point',
    analysisRun: false,
    lastRunAt: null,
    cards: CARD_KEYS.reduce((acc, key) => {
      acc[key] = {
        key,
        label: CARD_LABELS[key],
        value: null,
        reason: '',
        confidence: CONFIDENCE.UNKNOWN,
        status: STATUS.DEFAULT,
      };
      return acc;
    }, {}),
    operationalContext: createOperationalContext(),
  };
}

/* Phase 12 — address-first operational workflow.
   `operationalContext` is a separate block from the seven design cards
   so the existing review model is untouched. Every auto-selected field
   carries `auto`, `confidence`, `reason`; an override flips `auto` to
   false and pushes an entry onto `overrides` for the export audit log.
*/
export function createOperationalContext() {
  return {
    address: null,        // { query, display_name, short_label, lat, lon, geocoder, importance, type, category, address }
    catchment: null,      // { id, auto, confidence, reason, distance_km, nearest_id }
    ifd:       null,      // { reference_station_id, reference_station_name, distance_km, lonlat, auto, confidence, reason }
    eventWindow: null,    // see detectEventWindow descriptor; plus { auto, override }
    nearbyGauges: [],     // [{ station_id, station_name, lonlat, distance_km }]
    overrides: [],        // [{ field, from, to, ts }]
  };
}

export function clearOperationalContext(state) {
  state.operationalContext = createOperationalContext();
  return state;
}

export function setOperationalAddress(state, addr) {
  state.operationalContext.address = addr || null;
  return state;
}

export function setOperationalCatchment(state, payload) {
  state.operationalContext.catchment = payload || null;
  return state;
}

export function setOperationalIfd(state, payload) {
  state.operationalContext.ifd = payload || null;
  return state;
}

export function setOperationalEventWindow(state, payload) {
  state.operationalContext.eventWindow = payload || null;
  return state;
}

export function setOperationalNearbyGauges(state, list) {
  state.operationalContext.nearbyGauges = Array.isArray(list) ? list : [];
  return state;
}

/** Mark a specific operational field as manually overridden, capturing
    a before/after snapshot for the export audit log. */
export function recordOperationalOverride(state, field, from, to) {
  if (!state.operationalContext) state.operationalContext = createOperationalContext();
  state.operationalContext.overrides.push({
    field,
    from,
    to,
    ts: new Date().toISOString(),
  });
  // Flag the affected sub-block as auto: false where applicable.
  if (field === 'catchment' && state.operationalContext.catchment) {
    state.operationalContext.catchment.auto = false;
    state.operationalContext.catchment.override = true;
  }
  if (field === 'ifd' && state.operationalContext.ifd) {
    state.operationalContext.ifd.auto = false;
    state.operationalContext.ifd.override = true;
  }
  if (field === 'eventWindow' && state.operationalContext.eventWindow) {
    state.operationalContext.eventWindow.auto = false;
    state.operationalContext.eventWindow.override = true;
  }
  return state;
}

export function recordAnalysisRun(state, when = new Date()) {
  state.analysisRun = true;
  state.lastRunAt = (when instanceof Date) ? when.toISOString() : String(when);
  return state;
}

export function clearAnalysisRun(state) {
  state.analysisRun = false;
  state.lastRunAt = null;
  return state;
}

export function setSelectedCatchment(state, id, feature) {
  const changed = state.selectedCatchmentId !== (id || null);
  state.selectedCatchmentId = id || null;
  state.selectedCatchmentFeature = feature || null;
  if (changed) {
    state.analysisRun = false;
    state.lastRunAt = null;
  }
  return state;
}

export function setRainfallData(state, data, error) {
  state.rainfallData = data || null;
  state.rainfallError = error || null;
  state.integrationReady = !!data;
  return state;
}

export function setSelectedWindow(state, windowKey) {
  state.selectedWindow = String(windowKey || '24h');
  return state;
}

export function setSelectedDuration(state, durationKey) {
  state.selectedDuration = durationKey ? String(durationKey) : null;
  return state;
}

export function setMapColourMode(state, mode) {
  const allowed = new Set(['confidence', 'criticalRainfall', 'spatialVariability']);
  state.mapColourMode = allowed.has(mode) ? mode : 'confidence';
  return state;
}

export function setIfdDisplayMode(state, mode) {
  state.ifdDisplayMode = (mode === 'arf') ? 'arf' : 'point';
  return state;
}

export function markManuallyChanged(state, cardKey, nextValue) {
  const card = state.cards[cardKey];
  if (!card) throw new Error(`Stormgrid: unknown card key "${cardKey}"`);
  card.value = nextValue;
  card.status = STATUS.MANUAL;
  return state;
}

export function resetCardToDefault(state, cardKey, defaultCard) {
  const card = state.cards[cardKey];
  if (!card) throw new Error(`Stormgrid: unknown card key "${cardKey}"`);
  Object.assign(card, defaultCard, { status: STATUS.DEFAULT });
  return state;
}
