/* Stormgrid — event archive + catchment climatology (Phase 13).

   Loads:
     - data/event_archive/index.json                (manifest)
     - data/event_archive/<event-id>/event.json     (full lossless snapshot)
     - data/event_archive/catchment_climatology.json

   Renders:
     - Event archive panel (chronological list, with restore)
     - Catchment history panel (per-window band counters + highest + most-recent)

   Methodology safeguard: bands are descriptive volume tiers, NOT AEP,
   NOT return-period, NOT formal exceedance. Every panel surfaces the
   methodology note from the loaded JSON so a downstream consumer
   cannot mistake the counts for probability claims.
*/

const ARCHIVE_INDEX_URL  = './data/event_archive/index.json';
const CLIMATOLOGY_URL    = './data/event_archive/catchment_climatology.json';

let indexCache = null;
let climatologyCache = null;
const eventCache = new Map();

/* ────────────────────────────────────────────────────────────────────
   Loaders
   ──────────────────────────────────────────────────────────────────── */

export async function loadEventArchiveIndex(url = ARCHIVE_INDEX_URL) {
  if (indexCache) return indexCache;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      indexCache = { ok: false, error: `HTTP ${r.status}`, data: null };
      return indexCache;
    }
    const data = await r.json();
    indexCache = { ok: true, data, error: null };
    return indexCache;
  } catch (err) {
    indexCache = { ok: false, error: String((err && err.message) || err), data: null };
    return indexCache;
  }
}

export async function loadCatchmentClimatology(url = CLIMATOLOGY_URL) {
  if (climatologyCache) return climatologyCache;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      climatologyCache = { ok: false, error: `HTTP ${r.status}`, data: null };
      return climatologyCache;
    }
    const data = await r.json();
    climatologyCache = { ok: true, data, error: null };
    return climatologyCache;
  } catch (err) {
    climatologyCache = { ok: false, error: String((err && err.message) || err), data: null };
    return climatologyCache;
  }
}

export async function loadEventArchiveEntry(eventId, archivePath) {
  if (!eventId) return { ok: false, error: 'no event_id', data: null };
  if (eventCache.has(eventId)) return eventCache.get(eventId);
  // Prefer the explicit archive_path; fall back to a derived path.
  const url = archivePath
    ? `./${archivePath.replace(/^\.?\//, '')}`
    : `./data/event_archive/${eventId}/event.json`;
  try {
    const r = await fetch(url, { cache: 'force-cache' });
    if (!r.ok) {
      const out = { ok: false, error: `HTTP ${r.status}`, data: null };
      eventCache.set(eventId, out);
      return out;
    }
    const data = await r.json();
    const out = { ok: true, data, error: null };
    eventCache.set(eventId, out);
    return out;
  } catch (err) {
    const out = { ok: false, error: String((err && err.message) || err), data: null };
    eventCache.set(eventId, out);
    return out;
  }
}

export function clearEventArchiveCache() {
  indexCache = null;
  climatologyCache = null;
  eventCache.clear();
}

/* ────────────────────────────────────────────────────────────────────
   Climatology helpers
   ──────────────────────────────────────────────────────────────────── */

/** Returns a per-window summary for a single catchment. */
export function pickCatchmentClimatology(climatologyData, catchmentId) {
  if (!climatologyData || !climatologyData.catchments || !catchmentId) return null;
  return climatologyData.catchments[catchmentId] || null;
}

export function bandsForClimatology(climatologyData) {
  if (!climatologyData || !Array.isArray(climatologyData.bands)) {
    return ['light', 'moderate', 'heavy', 'very_heavy', 'extreme'];
  }
  return climatologyData.bands.map((b) => b.name);
}

/** Comparable past events for a catchment: top-K events by total_mm where
 *  this catchment appears, in the given accumulation window. */
export function comparablePastEvents({ archiveIndex, eventEntriesById, catchmentId, accumulationWindow, limit = 5 }) {
  if (!archiveIndex || !Array.isArray(archiveIndex.events) || !catchmentId) return [];
  const out = [];
  for (const meta of archiveIndex.events) {
    if (accumulationWindow && meta.accumulation_window !== accumulationWindow) continue;
    const entry = eventEntriesById && eventEntriesById[meta.event_id];
    const c = entry && entry.rainfall_data && entry.rainfall_data.catchments
      ? entry.rainfall_data.catchments[catchmentId]
      : null;
    if (!c || typeof c.total_mm !== 'number') continue;
    out.push({
      event_id:    meta.event_id,
      label:       meta.label,
      archived_at: meta.archived_at,
      accumulation_window: meta.accumulation_window,
      total_mm:    Math.round(c.total_mm * 100) / 100,
    });
  }
  out.sort((a, b) => b.total_mm - a.total_mm);
  return out.slice(0, limit);
}

/* ────────────────────────────────────────────────────────────────────
   Event Archive panel
   ──────────────────────────────────────────────────────────────────── */

export function renderEventArchivePanel(host, {
  archiveIndex,
  archiveLoadError,
  activeArchivedEventId,
  selectedAccumulationWindow,
  onRestore,
  onReturnToLive,
  onArchiveCurrent,
} = {}) {
  if (!host) return;
  host.classList.add('stormgrid-archivewrap');

  if (archiveLoadError) {
    host.innerHTML = `
      <h3 class="stormgrid-archive__head">Event archive</h3>
      <p class="stormgrid-archive__empty stormgrid-archive__empty--error">
        Could not load archive: ${escapeHtml(archiveLoadError)}
      </p>
    `;
    return;
  }
  if (!archiveIndex || !Array.isArray(archiveIndex.events) || archiveIndex.events.length === 0) {
    host.innerHTML = `
      <h3 class="stormgrid-archive__head">Event archive</h3>
      <p class="stormgrid-archive__empty">
        No archived events yet. Run <code>scripts/build_event_archive.py
        --include-current</code> after each interesting rainfall snapshot
        to populate this list.
      </p>
    `;
    return;
  }

  const events = archiveIndex.events.slice();
  // Filter to the active accumulation window when one is selected — keeps
  // band counters comparable to the current view. Show all when no filter.
  const filtered = selectedAccumulationWindow
    ? events.filter((e) => e.accumulation_window === selectedAccumulationWindow)
    : events;

  const filterNote = selectedAccumulationWindow
    ? `Filtered to <strong>${escapeHtml(selectedAccumulationWindow)}</strong> window — ${filtered.length} of ${events.length} events.`
    : `Showing ${events.length} archived event${events.length === 1 ? '' : 's'}.`;

  host.innerHTML = `
    <header class="stormgrid-archive__head-row">
      <h3 class="stormgrid-archive__head">Event archive</h3>
      <span class="stormgrid-archive__meta">${events.length} event${events.length === 1 ? '' : 's'}</span>
    </header>
    <p class="stormgrid-archive__sub">${filterNote}</p>
    ${activeArchivedEventId ? `
      <div class="stormgrid-archive__banner" role="status">
        <span><strong>Restored from archive:</strong> ${escapeHtml(activeArchivedEventId)}</span>
        <button type="button" class="stormgrid-archive__btn stormgrid-archive__btn--accent" data-act="return-live">Return to live</button>
      </div>
    ` : ''}
    <ul class="stormgrid-archive__list" role="list">
      ${filtered.map((e) => archiveRowHtml(e, activeArchivedEventId)).join('')}
    </ul>
    <div class="stormgrid-archive__actions">
      <button type="button" class="stormgrid-archive__btn" data-act="download-current">Download current event JSON</button>
      <span class="stormgrid-archive__hint">Save to <code>data/_archive_inbox/</code> and re-run the builder to add to the archive.</span>
    </div>
    <p class="stormgrid-archive__safety">${escapeHtml(archiveIndex.methodology_note || 'Bands describe rainfall volume only — not AEP, not return-period, not formal exceedance.')}</p>
  `;

  host.querySelectorAll('button[data-event-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.eventId;
      const path = btn.dataset.archivePath;
      if (typeof onRestore === 'function') onRestore(id, path);
    });
  });
  const ret = host.querySelector('button[data-act="return-live"]');
  if (ret) ret.addEventListener('click', () => {
    if (typeof onReturnToLive === 'function') onReturnToLive();
  });
  const dl = host.querySelector('button[data-act="download-current"]');
  if (dl) dl.addEventListener('click', () => {
    if (typeof onArchiveCurrent === 'function') onArchiveCurrent();
  });
}

function archiveRowHtml(e, activeId) {
  const isActive = activeId === e.event_id;
  const ts = String(e.archived_at || '').replace('T', ' ').replace('Z', ' UTC');
  const top = (typeof e.top_total_mm === 'number') ? `${e.top_total_mm.toFixed(2)} mm` : '—';
  return `
    <li class="stormgrid-archive__item ${isActive ? 'stormgrid-archive__item--active' : ''}">
      <div class="stormgrid-archive__row-main">
        <div class="stormgrid-archive__label">${escapeHtml(e.label || e.event_id)}</div>
        <div class="stormgrid-archive__sub-row">
          <span class="stormgrid-archive__pill">${escapeHtml(e.accumulation_window || '—')}</span>
          <span class="stormgrid-archive__pill stormgrid-archive__pill--band-${escapeAttr(e.top_band || 'light')}">${escapeHtml(e.top_band || '—')}</span>
          <span>top: <strong>${escapeHtml(e.top_catchment || '—')}</strong> · ${top}</span>
          <span>· ${e.catchment_count || 0} catchments</span>
        </div>
        <div class="stormgrid-archive__archived-at">archived ${escapeHtml(ts)}</div>
      </div>
      <div class="stormgrid-archive__row-actions">
        <button type="button"
                class="stormgrid-archive__btn ${isActive ? 'stormgrid-archive__btn--active' : ''}"
                data-event-id="${escapeAttr(e.event_id)}"
                data-archive-path="${escapeAttr(e.archive_path || '')}"
                ${isActive ? 'disabled' : ''}>
          ${isActive ? 'Restored' : 'Restore'}
        </button>
      </div>
    </li>
  `;
}

/* ────────────────────────────────────────────────────────────────────
   Catchment History panel
   ──────────────────────────────────────────────────────────────────── */

export function renderCatchmentHistoryPanel(host, {
  catchmentId,
  climatologyData,
  climatologyError,
  selectedAccumulationWindow,
  comparableEvents,
} = {}) {
  if (!host) return;
  host.classList.add('stormgrid-historywrap');

  if (climatologyError) {
    host.innerHTML = `
      <h3 class="stormgrid-history__head">Catchment history</h3>
      <p class="stormgrid-history__empty stormgrid-history__empty--error">Could not load climatology: ${escapeHtml(climatologyError)}</p>
    `;
    return;
  }
  if (!climatologyData) {
    host.innerHTML = `
      <h3 class="stormgrid-history__head">Catchment history</h3>
      <p class="stormgrid-history__empty">Loading…</p>
    `;
    return;
  }
  if (!catchmentId) {
    host.innerHTML = `
      <h3 class="stormgrid-history__head">Catchment history</h3>
      <p class="stormgrid-history__empty">Select a catchment (click the map or search an address) to see its history across the archive.</p>
    `;
    return;
  }

  const cnode = pickCatchmentClimatology(climatologyData, catchmentId);
  if (!cnode) {
    host.innerHTML = `
      <h3 class="stormgrid-history__head">Catchment history — ${escapeHtml(catchmentId)}</h3>
      <p class="stormgrid-history__empty">No archived events touch this catchment yet.</p>
    `;
    return;
  }

  const bands = bandsForClimatology(climatologyData);
  const window = selectedAccumulationWindow || null;
  const allWindows = Object.keys(cnode.by_window || {}).sort();

  // If the user has a window selected and this catchment has data for it,
  // show that window's table; otherwise list all windows side-by-side.
  const windowsToShow = (window && cnode.by_window && cnode.by_window[window])
    ? [window]
    : allWindows;

  const table = windowsToShow.map((w) => {
    const wNode = cnode.by_window[w];
    return `
      <div class="stormgrid-history__win">
        <h4 class="stormgrid-history__winhead">${escapeHtml(w)} window — ${wNode.events_seen} archived event${wNode.events_seen === 1 ? '' : 's'}</h4>
        <ul class="stormgrid-history__bands">
          ${bands.map((b) => {
            const n = (wNode.band_counts && wNode.band_counts[b]) || 0;
            return `
              <li class="stormgrid-history__band stormgrid-history__band--${escapeAttr(b)}">
                <span class="stormgrid-history__band-label">${escapeHtml(b.replace('_', ' '))}</span>
                <span class="stormgrid-history__band-count">${n}</span>
              </li>
            `;
          }).join('')}
        </ul>
        <div class="stormgrid-history__keystats">
          <div><dt>Highest archive total</dt><dd>${typeof wNode.highest_total_mm === 'number' ? `${wNode.highest_total_mm.toFixed(2)} mm` : '—'}</dd></div>
          <div><dt>Highest event</dt><dd>${escapeHtml(wNode.highest_event_id || '—')}</dd></div>
          <div><dt>Most recent</dt><dd>${escapeHtml(wNode.most_recent_event_id || '—')}</dd></div>
        </div>
      </div>
    `;
  }).join('');

  const cmpHtml = (Array.isArray(comparableEvents) && comparableEvents.length > 0) ? `
    <div class="stormgrid-history__compare">
      <h4 class="stormgrid-history__winhead">Comparable past events (top ${comparableEvents.length})</h4>
      <ol class="stormgrid-history__cmp-list">
        ${comparableEvents.map((e) => `
          <li>
            <span class="stormgrid-history__cmp-mm">${e.total_mm.toFixed(2)} mm</span>
            <span class="stormgrid-history__cmp-label">${escapeHtml(e.label || e.event_id)}</span>
            <span class="stormgrid-history__pill">${escapeHtml(e.accumulation_window || '')}</span>
          </li>
        `).join('')}
      </ol>
    </div>
  ` : '';

  host.innerHTML = `
    <header class="stormgrid-history__head-row">
      <h3 class="stormgrid-history__head">Catchment history — ${escapeHtml(catchmentId)}</h3>
      <span class="stormgrid-history__meta">${cnode.total_events_seen} appearance${cnode.total_events_seen === 1 ? '' : 's'} across ${climatologyData.archive_size} archived event${climatologyData.archive_size === 1 ? '' : 's'}</span>
    </header>
    ${table}
    ${cmpHtml}
    <p class="stormgrid-history__safety">${escapeHtml(climatologyData.methodology_note || 'Bands describe rainfall volume only — not AEP, not return-period, not formal exceedance.')}</p>
  `;
}

/* ────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, ''); }
