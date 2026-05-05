/* Stormgrid v0 — smart defaults.
   When a catchment is selected and the static rainfall JSON is loaded,
   the Area / Rainfall event / Rainfall source cards adapt to the real
   data. Without those, sensible static fallbacks are used. */

import { CARD_LABELS, CONFIDENCE, STATUS } from './stormgridState.js';

export function buildDefaults({
  now = new Date(),
  map = null,
  selected = null,
  rainfallData = null,
} = {}) {
  const bounds = map && map.bounds ? map.bounds : null;

  let area;
  if (selected && selected.id) {
    const ha = selected.area_ha != null ? Number(selected.area_ha).toFixed(0) : '—';
    const c = selected.centroid;
    const centroidStr = (Array.isArray(c) && c.length >= 2 && c[0] != null)
      ? ` · centroid ${Number(c[1]).toFixed(4)}, ${Number(c[0]).toFixed(4)}`
      : '';
    area = {
      key: 'area',
      label: CARD_LABELS.area,
      value: `Catchment ${selected.id} · ${ha} ha${centroidStr}`,
      reason: 'Selected from the catchment map. Polygon comes from the local Lizard-derived dataset (non-authoritative).',
      confidence: CONFIDENCE.HIGH,
      status: STATUS.DEFAULT,
    };
  } else if (bounds) {
    area = {
      key: 'area',
      label: CARD_LABELS.area,
      value: formatViewport(bounds),
      reason: 'No catchment selected — defaulting to current map view extent.',
      confidence: CONFIDENCE.MEDIUM,
      status: STATUS.DEFAULT,
    };
  } else {
    area = {
      key: 'area',
      label: CARD_LABELS.area,
      value: 'Click a catchment on the map',
      reason: 'No catchment selected. Click a polygon to populate this card.',
      confidence: CONFIDENCE.LOW,
      status: STATUS.DEFAULT,
    };
  }

  let rainfallEvent;
  if (rainfallData && rainfallData.window) {
    rainfallEvent = {
      key: 'rainfallEvent',
      label: CARD_LABELS.rainfallEvent,
      value: `${formatTs(rainfallData.window.start)} → ${formatTs(rainfallData.window.end)}`,
      reason: `Window of ${rainfallData.window.frame_count} archived frames.`,
      confidence: CONFIDENCE.HIGH,
      status: STATUS.DEFAULT,
    };
  } else {
    rainfallEvent = {
      key: 'rainfallEvent',
      label: CARD_LABELS.rainfallEvent,
      value: 'Last 24 hours (rolling)',
      reason: 'Static rainfall JSON not yet loaded. Default rolling window applied.',
      confidence: CONFIDENCE.MEDIUM,
      status: STATUS.DEFAULT,
    };
  }

  let rainfallSource;
  if (rainfallData && rainfallData.source) {
    rainfallSource = {
      key: 'rainfallSource',
      label: CARD_LABELS.rainfallSource,
      value: 'Lizard radar (precomputed)',
      reason: `Source: ${String(rainfallData.source)}. Uncalibrated rainfall product, mm per frame.`,
      confidence: CONFIDENCE.HIGH,
      status: STATUS.DEFAULT,
    };
  } else {
    rainfallSource = {
      key: 'rainfallSource',
      label: CARD_LABELS.rainfallSource,
      value: 'Rainfall radar (preferred), fallback to gauges',
      reason: 'Radar provides spatial coverage; gauges used for validation.',
      confidence: CONFIDENCE.HIGH,
      status: STATUS.DEFAULT,
    };
  }

  return {
    area,
    rainfallEvent,
    rainfallSource,
    gauges: {
      key: 'gauges',
      label: CARD_LABELS.gauges,
      value: 'Nearest 3–5 gauges (auto-selected)',
      reason: 'Provides local validation against spatial rainfall.',
      confidence: CONFIDENCE.MEDIUM,
      status: STATUS.DEFAULT,
    },
    durations: {
      key: 'durations',
      label: CARD_LABELS.durations,
      value: 'Standard durations: 5 min → 24 hr',
      reason: 'Matches Stormgauge standard duration set.',
      confidence: CONFIDENCE.HIGH,
      status: STATUS.DEFAULT,
    },
    ifdAep: {
      key: 'ifdAep',
      label: CARD_LABELS.ifdAep,
      value: 'Nearest IFD point (to be resolved)',
      reason: 'IFD reference required for later comparison.',
      confidence: CONFIDENCE.LOW,
      status: STATUS.DEFAULT,
    },
    outputs: {
      key: 'outputs',
      label: CARD_LABELS.outputs,
      value: 'Full export pack (HTML, XLSX, CSV, GeoJSON)',
      reason: 'Default reporting bundle for engineering use.',
      confidence: CONFIDENCE.HIGH,
      status: STATUS.DEFAULT,
    },
    _generatedAt: now.toISOString(),
  };
}

function formatTs(s) {
  if (!s) return '—';
  return s.replace('T', ' ').replace('Z', ' UTC');
}

function formatViewport({ north, south, east, west }) {
  const latLo = Math.min(south, north);
  const latHi = Math.max(south, north);
  const lonLo = Math.min(west, east);
  const lonHi = Math.max(west, east);
  const f = (n) => n.toFixed(4);
  return `Viewport (lat ${f(latLo)}–${f(latHi)}, lon ${f(lonLo)}–${f(lonHi)})`;
}
