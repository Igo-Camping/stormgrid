// addressSearch.js — AU-scoped Nominatim geocoder + debounced, keyboard-navigable
// result list (docs/02 §5.1; docs/03 §2 LOCATION LAYER "AddressSearch"; rewrite
// of src/stormgridAddressSearch.js — the original is NOT imported or modified).
//
// Two public surfaces, deliberately decoupled:
//   geocode(query, opts)         pure-ish async: free-text -> { ok, results, error }.
//                                No DOM. Reusable by tests or other callers.
//   mountAddressSearch(host, {…}) renders the search input + live result listbox,
//                                debounces keystrokes, supports full keyboard
//                                navigation, and calls back on pick/clear.
//
// Nominatim usage policy: a clear Referer/User-Agent (the browser sends Referer
// automatically) and <=1 request/second. Keystrokes are debounced (350 ms) so
// typing never bursts. Country is hard-scoped to AU; a viewbox biases toward the
// Northern Beaches without hard-clipping nearby addresses.

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';

// Northern Beaches LGA viewbox (lon_min, lat_max, lon_max, lat_min) per
// Nominatim's "viewbox" parameter ordering. bounded=0 keeps the prefer-in-bounds
// bias without hard-clipping addresses just outside the box.
const VIEWBOX = '151.05,-33.55,151.40,-33.85';
const DEBOUNCE_MS = 350;
const MIN_QUERY_LEN = 3;

/**
 * Geocode a free-text address, AU-scoped.
 * @param {string} query
 * @param {Object} [opts]
 * @param {number} [opts.limit=6]
 * @param {boolean} [opts.boundedStrict=false]  hard-clip to the viewbox
 * @param {Function} [opts.fetchImpl=fetch]     injectable for tests
 * @returns {Promise<{ ok:boolean, results:Array<GeoHit>, error:string|null }>}
 */
export async function geocode(query, opts = {}) {
  const q = String(query == null ? '' : query).trim();
  if (q.length === 0) return { ok: true, results: [], error: null };

  const fetchImpl = typeof opts.fetchImpl === 'function'
    ? opts.fetchImpl
    : (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { ok: false, results: [], error: 'No fetch implementation available.' };

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
    const r = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'force-cache',
    });
    if (!r.ok) return { ok: false, results: [], error: `Geocoder HTTP ${r.status}` };
    const raw = await r.json();
    const results = (Array.isArray(raw) ? raw : [])
      .map(normaliseHit)
      .filter((h) => h != null);
    return { ok: true, results, error: null };
  } catch (err) {
    return { ok: false, results: [], error: String((err && err.message) || err) };
  }
}

/**
 * @typedef {Object} GeoHit
 * @property {string} display_name  full Nominatim label
 * @property {string} short_label   compact "num road, suburb, STATE"
 * @property {number} lat
 * @property {number} lon
 * @property {string} geocoder      always 'nominatim'
 */
function normaliseHit(h) {
  const lat = Number(h.lat);
  const lon = Number(h.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    display_name: h.display_name || '',
    short_label: buildShortLabel(h),
    lat,
    lon,
    osm_type: h.osm_type || null,
    osm_id: h.osm_id || null,
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

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Mount the address search bar into `host`.
 *
 * @param {HTMLElement} host
 * @param {Object} cfg
 * @param {(hit:GeoHit) => void} cfg.onResolve  called when the user picks a hit
 * @param {() => void} [cfg.onClear]            called when the field is cleared
 * @param {Function} [cfg.geocodeImpl=geocode]  injectable geocoder for tests
 * @param {number}   [cfg.debounceMs=350]
 * @returns {{ destroy():void, setValue(v:string):void, focus():void }}
 *
 * Keyboard: ArrowDown/ArrowUp move the active option, Enter selects the active
 * option (or runs a search if none is active yet), Escape closes the listbox.
 * Pure-ish: it owns only its own DOM subtree and timers; it does not touch the
 * store. Selection is reported via onResolve; the section wires that to geo +
 * the store.
 */
export function mountAddressSearch(host, cfg = {}) {
  if (!host) throw new Error('mountAddressSearch: host element is required');
  const onResolve = typeof cfg.onResolve === 'function' ? cfg.onResolve : () => {};
  const onClear = typeof cfg.onClear === 'function' ? cfg.onClear : () => {};
  const geocodeImpl = typeof cfg.geocodeImpl === 'function' ? cfg.geocodeImpl : geocode;
  const debounceMs = typeof cfg.debounceMs === 'number' ? cfg.debounceMs : DEBOUNCE_MS;

  host.classList.add('sgloc-addresswrap');
  host.innerHTML = `
    <div class="sgloc-address" role="search">
      <div class="sgloc-address__inner">
        <input
          type="search"
          class="sgloc-address__input"
          autocomplete="off"
          spellcheck="false"
          placeholder="Search address or place…"
          aria-label="Address or place name"
          aria-describedby="sgloc-address-status"
          role="combobox"
          aria-expanded="false"
          aria-autocomplete="list"
          aria-controls="sgloc-address-hits"
        />
        <button type="button" class="sgloc-address__clear" aria-label="Clear address">&times;</button>
      </div>
      <ul id="sgloc-address-hits" class="sgloc-address__hits" role="listbox" aria-label="Address suggestions"></ul>
      <p id="sgloc-address-status" class="sgloc-address__status" aria-live="polite"></p>
    </div>
  `;

  const input = host.querySelector('.sgloc-address__input');
  const hits = host.querySelector('.sgloc-address__hits');
  const clear = host.querySelector('.sgloc-address__clear');
  const statusEl = host.querySelector('.sgloc-address__status');

  let debounce = null;
  let lastQuery = '';
  let items = [];        // current GeoHit[]
  let activeIndex = -1;  // keyboard-highlighted option

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('sgloc-address__status--busy', kind === 'busy');
    statusEl.classList.toggle('sgloc-address__status--error', kind === 'error');
  }

  function closeHits() {
    items = [];
    activeIndex = -1;
    hits.innerHTML = '';
    hits.classList.remove('sgloc-address__hits--open');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function renderHits(list) {
    items = Array.isArray(list) ? list : [];
    activeIndex = -1;
    if (items.length === 0) { closeHits(); return; }
    hits.innerHTML = items.map((it, i) => `
      <li id="sgloc-hit-${i}" class="sgloc-address__hit" role="option" data-i="${i}" aria-selected="false">
        <span class="sgloc-address__hit-main">${escapeHtml(it.short_label || it.display_name)}</span>
        <span class="sgloc-address__hit-sub">${escapeHtml(it.display_name)}</span>
      </li>
    `).join('');
    hits.classList.add('sgloc-address__hits--open');
    input.setAttribute('aria-expanded', 'true');
    Array.from(hits.querySelectorAll('.sgloc-address__hit')).forEach((li) => {
      // mousedown (not click) so selection fires before the input's blur closes the list
      li.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        choose(Number(li.dataset.i));
      });
    });
  }

  function setActive(i) {
    const opts = Array.from(hits.querySelectorAll('.sgloc-address__hit'));
    if (opts.length === 0) return;
    activeIndex = ((i % opts.length) + opts.length) % opts.length;
    opts.forEach((li, idx) => {
      const on = idx === activeIndex;
      li.classList.toggle('sgloc-address__hit--active', on);
      li.setAttribute('aria-selected', String(on));
      if (on) {
        input.setAttribute('aria-activedescendant', li.id);
        li.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function choose(i) {
    const pick = items[i];
    if (!pick) return;
    input.value = pick.short_label || pick.display_name;
    closeHits();
    onResolve(pick);
  }

  async function runSearch(q) {
    if (q === lastQuery) return;
    lastQuery = q;
    if (q.length < MIN_QUERY_LEN) { closeHits(); setStatus('', null); return; }
    setStatus('Searching…', 'busy');
    const res = await geocodeImpl(q);
    if (q !== lastQuery) return; // a newer keystroke superseded this request
    if (!res.ok) {
      setStatus(`Address search failed: ${res.error}`, 'error');
      closeHits();
      return;
    }
    if (!res.results || res.results.length === 0) {
      setStatus('No matches in or near the Northern Beaches.', null);
      closeHits();
      return;
    }
    const n = res.results.length;
    setStatus(`${n} match${n === 1 ? '' : 'es'} — pick one to resolve a catchment.`, null);
    renderHits(res.results);
  }

  function onInput() {
    if (debounce) clearTimeout(debounce);
    const q = input.value.trim();
    debounce = setTimeout(() => runSearch(q), debounceMs);
  }

  function onKeyDown(ev) {
    const open = hits.classList.contains('sgloc-address__hits--open');
    switch (ev.key) {
      case 'ArrowDown':
        if (open && items.length) { ev.preventDefault(); setActive(activeIndex + 1); }
        break;
      case 'ArrowUp':
        if (open && items.length) { ev.preventDefault(); setActive(activeIndex - 1); }
        break;
      case 'Enter':
        ev.preventDefault();
        if (open && activeIndex >= 0) choose(activeIndex);
        else if (open && items.length) choose(0);
        else runSearch(input.value.trim());
        break;
      case 'Escape':
        if (open) { ev.preventDefault(); closeHits(); }
        break;
      default:
        break;
    }
  }

  function onFocusOut(ev) {
    // Close the picker only if focus left the entire address bar.
    if (!host.contains(ev.relatedTarget)) {
      setTimeout(() => closeHits(), 80);
    }
  }

  function onClearClick() {
    input.value = '';
    lastQuery = '';
    closeHits();
    setStatus('', null);
    onClear();
    input.focus();
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  host.addEventListener('focusout', onFocusOut);
  clear.addEventListener('click', onClearClick);

  return {
    destroy() {
      if (debounce) clearTimeout(debounce);
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeyDown);
      host.removeEventListener('focusout', onFocusOut);
      clear.removeEventListener('click', onClearClick);
      host.innerHTML = '';
      host.classList.remove('sgloc-addresswrap');
    },
    setValue(v) { input.value = v == null ? '' : String(v); },
    focus() { input.focus(); },
  };
}
