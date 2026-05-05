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
  };
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
