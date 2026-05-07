/* Stormgrid — address search (Phase 12).
   Thin wrapper around OpenStreetMap Nominatim with a search-bar UI.
   Bounded to a Northern Beaches viewbox so the geocoder prefers local
   addresses; results outside the bounds are still returned but ranked
   below in-bounds matches.

   No API key required. Nominatim's usage policy asks for a clear
   referer/User-Agent and ≤1 request/second. The browser sends Referer
   automatically (the deploy domain identifies the app); we throttle
   user keystrokes with a 350 ms debounce so typing doesn't burst.
*/

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';

// Northern Beaches LGA viewbox (lon_min, lat_max, lon_max, lat_min) per
// Nominatim's "viewbox" parameter ordering. Bounded=1 keeps the prefer-
// in-bounds bias strong without hard-clipping addresses just outside.
const VIEWBOX = '151.05,-33.55,151.40,-33.85';

/** Geocode a free-text address. Returns { ok, results, error }. */
export async function geocodeAddress(query, opts = {}) {
  const q = String(query || '').trim();
  if (q.length === 0) return { ok: true, results: [], error: null };

  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    addressdetails: '1',
    limit: String(opts.limit || 6),
    countrycodes: 'au',
    viewbox: VIEWBOX,
    bounded: opts.boundedStrict ? '1' : '0',
  });
  const url = `${NOMINATIM_BASE}?${params.toString()}`;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'force-cache',
    });
    if (!r.ok) return { ok: false, results: [], error: `Geocoder HTTP ${r.status}` };
    const raw = await r.json();
    const results = (Array.isArray(raw) ? raw : [])
      .map(normaliseHit)
      .filter((r) => r != null);
    return { ok: true, results, error: null };
  } catch (err) {
    return { ok: false, results: [], error: String((err && err.message) || err) };
  }
}

function normaliseHit(h) {
  const lat = Number(h.lat);
  const lon = Number(h.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    display_name: h.display_name || '',
    short_label:  buildShortLabel(h),
    lat,
    lon,
    osm_type: h.osm_type || null,
    osm_id:   h.osm_id   || null,
    place_id: h.place_id || null,
    importance: typeof h.importance === 'number' ? h.importance : null,
    type: h.type || null,
    category: h.category || null,
    address: h.address || null,
    geocoder: 'nominatim',
  };
}

function buildShortLabel(h) {
  const a = h.address || {};
  const num = a.house_number ? `${a.house_number} ` : '';
  const road = a.road || a.pedestrian || a.cycleway || '';
  const suburb = a.suburb || a.neighbourhood || a.village || a.town || '';
  const state = a.state_code || (a.state ? a.state.replace(/[^A-Z]/g, '') : '');
  const head = `${num}${road}`.trim();
  const parts = [head, suburb, state].filter(Boolean);
  if (parts.length === 0) return h.display_name || '';
  return parts.join(', ');
}

/* ────────────────────────────────────────────────────────────────────
   Search-bar UI
   ──────────────────────────────────────────────────────────────────── */

export function renderAddressSearchBar(host, {
  onResolve,
  onClear,
  current = null,
  status = '',
  busy = false,
  errorMessage = '',
} = {}) {
  if (!host) return;
  // Preserve in-progress text/focus across re-renders.
  const prev = host.querySelector('.stormgrid-address__input');
  const preservedValue = prev ? prev.value : (current ? current.short_label || current.display_name || '' : '');
  const preservedFocus = prev && document.activeElement === prev;
  const preservedSel = prev ? [prev.selectionStart, prev.selectionEnd] : null;

  host.classList.add('stormgrid-addresswrap');
  host.innerHTML = `
    <div class="stormgrid-address" role="search">
      <label class="stormgrid-address__label" for="stormgrid-address-input">Address</label>
      <div class="stormgrid-address__inner">
        <input
          id="stormgrid-address-input"
          type="search"
          class="stormgrid-address__input"
          autocomplete="off"
          spellcheck="false"
          placeholder="e.g. 100 Pittwater Rd Manly"
          aria-label="Address or place name"
          aria-describedby="stormgrid-address-status"
        />
        <button type="button" class="stormgrid-address__clear" aria-label="Clear address">×</button>
      </div>
      <div class="stormgrid-address__hits" role="listbox" aria-label="Address suggestions"></div>
      <p id="stormgrid-address-status" class="stormgrid-address__status${busy ? ' stormgrid-address__status--busy' : ''}${errorMessage ? ' stormgrid-address__status--error' : ''}" aria-live="polite">${
        escapeHtml(errorMessage || status || '')
      }</p>
    </div>
  `;

  const input  = host.querySelector('.stormgrid-address__input');
  const hits   = host.querySelector('.stormgrid-address__hits');
  const clear  = host.querySelector('.stormgrid-address__clear');
  const statusEl = host.querySelector('.stormgrid-address__status');

  input.value = preservedValue;
  if (preservedFocus) {
    input.focus();
    if (preservedSel) input.setSelectionRange(preservedSel[0], preservedSel[1]);
  }

  let debounce = null;
  let lastQuery = '';

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('stormgrid-address__status--busy',  kind === 'busy');
    statusEl.classList.toggle('stormgrid-address__status--error', kind === 'error');
  }

  function renderHits(items) {
    if (!items || items.length === 0) {
      hits.innerHTML = '';
      hits.classList.remove('stormgrid-address__hits--open');
      return;
    }
    hits.innerHTML = items.map((it, i) => `
      <button type="button" class="stormgrid-address__hit" role="option" data-i="${i}">
        <span class="stormgrid-address__hit-main">${escapeHtml(it.short_label || it.display_name)}</span>
        <span class="stormgrid-address__hit-sub">${escapeHtml(it.display_name)}</span>
      </button>
    `).join('');
    hits.classList.add('stormgrid-address__hits--open');
    Array.from(hits.querySelectorAll('.stormgrid-address__hit')).forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        const pick = items[i];
        if (!pick) return;
        input.value = pick.short_label || pick.display_name;
        hits.classList.remove('stormgrid-address__hits--open');
        if (typeof onResolve === 'function') onResolve(pick);
      });
    });
  }

  async function runSearch(q) {
    if (q === lastQuery) return;
    lastQuery = q;
    if (q.length < 3) { renderHits([]); setStatus('', null); return; }
    setStatus('Searching…', 'busy');
    const res = await geocodeAddress(q);
    if (q !== lastQuery) return; // a newer keystroke superseded this
    if (!res.ok) {
      setStatus(`Address search failed: ${res.error}`, 'error');
      renderHits([]);
      return;
    }
    if (res.results.length === 0) {
      setStatus('No matches in or near the Northern Beaches.', null);
      renderHits([]);
      return;
    }
    setStatus(`${res.results.length} match${res.results.length === 1 ? '' : 'es'} — pick one to auto-select catchment.`, null);
    renderHits(res.results);
  }

  input.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    const q = input.value.trim();
    debounce = setTimeout(() => runSearch(q), 350);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const first = hits.querySelector('.stormgrid-address__hit');
      if (first) first.click();
      else runSearch(input.value.trim());
    } else if (ev.key === 'Escape') {
      hits.classList.remove('stormgrid-address__hits--open');
    }
  });
  // Close the picker if focus leaves the entire address bar.
  host.addEventListener('focusout', (ev) => {
    if (!host.contains(ev.relatedTarget)) {
      setTimeout(() => hits.classList.remove('stormgrid-address__hits--open'), 100);
    }
  });

  clear.addEventListener('click', () => {
    input.value = '';
    lastQuery = '';
    renderHits([]);
    setStatus('', null);
    if (typeof onClear === 'function') onClear();
    input.focus();
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
