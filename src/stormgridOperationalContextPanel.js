/* Stormgrid — Operational Context panel (Phase 12).
   Renders the address-first audit trail: resolved address, auto-selected
   catchment, auto-selected IFD reference station, detected event window,
   nearby gauges. Every row carries:
     - what was selected (value)
     - why (reason)
     - confidence
     - auto vs manually overridden
   And exposes per-row override / reset controls.

   No new science. Reads only state.operationalContext + the helpers
   passed in. */

import { formatEventWindow } from './stormgridEventWindowDetection.js';

export function renderOperationalContextPanel(host, {
  context,
  ready,
  catchmentOptions,
  durationOptions,
  onOverrideCatchment,
  onResetCatchment,
  onOverrideEventWindow,
  onResetEventWindow,
} = {}) {
  if (!host) return;
  host.classList.add('stormgrid-opctxwrap');

  if (!ready || !context || !context.address) {
    host.innerHTML = `
      <h3 class="stormgrid-opctx__head">Operational context</h3>
      <p class="stormgrid-opctx__empty">
        Search an address above to auto-select a catchment, IFD reference,
        and event window. The original click-a-polygon flow still works —
        this panel populates after either path.
      </p>
    `;
    return;
  }

  const addr = context.address;
  const cat  = context.catchment;
  const ifd  = context.ifd;
  const evt  = context.eventWindow;
  const gauges = Array.isArray(context.nearbyGauges) ? context.nearbyGauges : [];

  host.innerHTML = `
    <header class="stormgrid-opctx__head-row">
      <h3 class="stormgrid-opctx__head">Operational context</h3>
      <span class="stormgrid-opctx__meta">${context.overrides.length} manual override${context.overrides.length === 1 ? '' : 's'}</span>
    </header>

    <dl class="stormgrid-opctx__grid">
      ${rowAddress(addr)}
      ${rowCatchment(cat, catchmentOptions)}
      ${rowIfd(ifd)}
      ${rowEvent(evt, durationOptions)}
      ${rowNearby(gauges)}
    </dl>

    <p class="stormgrid-opctx__safety">
      Operational context is hydrological background, not a formal AEP
      classification. ARF, IFD methodology safeguards and per-duration
      coverage warnings still govern any quantitative read.
    </p>
  `;

  // Wire override / reset controls.
  const catBtn = host.querySelector('[data-act="cat-override"]');
  if (catBtn) catBtn.addEventListener('click', () => {
    if (typeof onOverrideCatchment === 'function') onOverrideCatchment();
  });
  const catReset = host.querySelector('[data-act="cat-reset"]');
  if (catReset) catReset.addEventListener('click', () => {
    if (typeof onResetCatchment === 'function') onResetCatchment();
  });
  const evtBtn = host.querySelector('[data-act="evt-override"]');
  if (evtBtn) evtBtn.addEventListener('click', () => {
    if (typeof onOverrideEventWindow === 'function') onOverrideEventWindow();
  });
  const evtReset = host.querySelector('[data-act="evt-reset"]');
  if (evtReset) evtReset.addEventListener('click', () => {
    if (typeof onResetEventWindow === 'function') onResetEventWindow();
  });
}

/* ────────────────────────────────────────────────────────────────────
   Per-row renderers
   ──────────────────────────────────────────────────────────────────── */

function rowAddress(addr) {
  const value = addr.short_label || addr.display_name || '—';
  const sub = `${addr.lat.toFixed(5)}, ${addr.lon.toFixed(5)} · resolved via ${addr.geocoder || 'geocoder'}`;
  return rowShell({
    label: 'Address',
    value,
    sub,
    confidence: 'resolved',
    auto: true,
    reason: 'Free-text query resolved by the address geocoder.',
    actions: '',
  });
}

function rowCatchment(cat, catchmentOptions) {
  if (!cat) {
    return rowShell({
      label: 'Catchment',
      value: '—',
      sub: '',
      confidence: 'unknown',
      auto: false,
      reason: 'Address fell outside the catchment dataset.',
      actions: '',
    });
  }
  const value = cat.id || '—';
  const sub = cat.distance_km != null
    ? (cat.confidence === 'high'
        ? 'point-in-polygon match'
        : `nearest centroid · ${cat.distance_km.toFixed(2)} km`)
    : '';
  const actions = `
    <button type="button" class="stormgrid-opctx__btn" data-act="cat-override">Override…</button>
    ${cat.auto === false ? `<button type="button" class="stormgrid-opctx__btn stormgrid-opctx__btn--ghost" data-act="cat-reset">Reset auto</button>` : ''}
  `;
  return rowShell({
    label: 'Catchment',
    value,
    sub,
    confidence: cat.confidence || 'unknown',
    auto: cat.auto !== false,
    reason: cat.reason || '',
    actions,
    catchmentOptions,
  });
}

function rowIfd(ifd) {
  if (!ifd || !ifd.reference_station_id) {
    return rowShell({
      label: 'IFD reference',
      value: '—',
      sub: '',
      confidence: 'unknown',
      auto: false,
      reason: 'No IFD reference available for the selected catchment.',
      actions: '',
    });
  }
  const value = `${ifd.reference_station_name || ifd.reference_station_id} (${ifd.reference_station_id})`;
  const sub = (typeof ifd.distance_km === 'number')
    ? `${ifd.distance_km.toFixed(2)} km from catchment centroid`
    : '';
  return rowShell({
    label: 'IFD reference',
    value,
    sub,
    confidence: ifd.confidence || 'medium',
    auto: ifd.auto !== false,
    reason: ifd.reason || 'Pre-mapped reference station for the auto-selected catchment.',
    actions: '',
  });
}

function rowEvent(evt, durationOptions) {
  if (!evt) {
    return rowShell({
      label: 'Event window',
      value: '—',
      sub: '',
      confidence: 'unknown',
      auto: false,
      reason: 'No event window detected — duration stats unavailable.',
      actions: '',
    });
  }
  const value = formatEventWindow(evt);
  const sub = (evt.coverage_pct != null)
    ? `coverage ${evt.coverage_pct.toFixed(0)}% · ${evt.frames_used || '—'} frames used`
    : '';
  const actions = `
    <button type="button" class="stormgrid-opctx__btn" data-act="evt-override">Override duration…</button>
    ${evt.auto === false ? `<button type="button" class="stormgrid-opctx__btn stormgrid-opctx__btn--ghost" data-act="evt-reset">Reset auto</button>` : ''}
  `;
  return rowShell({
    label: 'Event window',
    value,
    sub,
    confidence: evt.confidence || 'unknown',
    auto: evt.auto !== false,
    reason: evt.reason || '',
    actions,
    durationOptions,
  });
}

function rowNearby(gauges) {
  if (!gauges || gauges.length === 0) {
    return rowShell({
      label: 'Nearby gauges',
      value: '—',
      sub: '',
      confidence: 'unknown',
      auto: true,
      reason: 'No reference station list loaded.',
      actions: '',
    });
  }
  const top = gauges.slice(0, 5);
  const value = top.map((g) =>
    `${escapeHtml(g.station_name)} <small class="stormgrid-opctx__pill">${escapeHtml(g.station_id)} · ${g.distance_km.toFixed(2)} km</small>`
  ).join(' · ');
  return rowShell({
    label: 'Nearby gauges',
    value,
    sub: `${top.length} closest of ${gauges.length} reference stations in the IFD lookup table`,
    confidence: 'derived',
    auto: true,
    reason: 'Distances computed from the address to each reference station in the catchment IFD lookup.',
    actions: '',
    valueIsHtml: true,
  });
}

/* ────────────────────────────────────────────────────────────────────
   Shell
   ──────────────────────────────────────────────────────────────────── */

function rowShell({ label, value, sub, confidence, auto, reason, actions, valueIsHtml }) {
  const conf = String(confidence || 'unknown').toLowerCase();
  const autoBadge = auto
    ? `<span class="stormgrid-opctx__auto" data-auto="true">AUTO</span>`
    : `<span class="stormgrid-opctx__auto" data-auto="false">MANUAL</span>`;
  return `
    <div class="stormgrid-opctx__row">
      <dt class="stormgrid-opctx__dt">
        <span>${escapeHtml(label)}</span>
        ${autoBadge}
      </dt>
      <dd class="stormgrid-opctx__dd">
        <div class="stormgrid-opctx__value">${valueIsHtml ? value : escapeHtml(value)}</div>
        ${sub ? `<div class="stormgrid-opctx__sub">${escapeHtml(sub)}</div>` : ''}
        <div class="stormgrid-opctx__reason">
          <span class="stormgrid-opctx__conf stormgrid-opctx__conf--${escapeAttr(conf)}">${escapeHtml(conf.toUpperCase())}</span>
          <span>${escapeHtml(reason || '')}</span>
        </div>
        ${actions ? `<div class="stormgrid-opctx__actions">${actions}</div>` : ''}
      </dd>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, ''); }
