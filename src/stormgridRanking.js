/* Stormgrid — catchment ranking panel.
   Pure presentation over the duration_stats already in the JSON.
   No new rainfall science, no AEP/IFD/ARF — just sorts & filters.
   Wording is methodology-safe: "max accumulated rainfall",
   "critical duration", "accumulation window", "coverage", "confidence". */

const SORT_KEY_DEFAULT  = 'max';
const SORT_ORDER_DEFAULT = 'desc';

/* Build a flat ranking array for the given duration.
   `filters`: { minMm: number|null, confidence: 'any'|'high'|'high-or-medium'|'low' }
   `sort`:    { key: 'max'|'cov'|'conf'|'id', order: 'asc'|'desc' } */
export function buildCatchmentRanking(data, durationKey, { filters = {}, sort = {} } = {}) {
  const rows = [];
  if (!data || !data.catchments || !durationKey) return rows;
  const min = (filters.minMm != null && Number.isFinite(filters.minMm)) ? filters.minMm : null;
  const cf  = filters.confidence || 'any';

  for (const [id, row] of Object.entries(data.catchments)) {
    const ds = row && row.duration_stats && row.duration_stats[durationKey];
    if (!ds) continue;
    if (typeof ds.max_total_mm !== 'number') continue;
    if (min != null && ds.max_total_mm < min) continue;
    const conf = String(ds.confidence || 'unknown').toLowerCase();
    if (cf === 'high' && conf !== 'high') continue;
    if (cf === 'high-or-medium' && !(conf === 'high' || conf === 'medium')) continue;
    if (cf === 'low' && conf !== 'low') continue;
    const sm = ds.spatial_metrics || null;
    rows.push({
      id,
      max_total_mm:  ds.max_total_mm,
      coverage_pct:  typeof ds.coverage_pct === 'number' ? ds.coverage_pct : null,
      confidence:    conf,
      window_start:  ds.window_start,
      window_end:    ds.window_end,
      frames_used:   ds.frames_used,
      frames_missing: ds.frames_missing,
      cv:            sm && typeof sm.coefficient_of_variation === 'number' ? sm.coefficient_of_variation : null,
      wet_core:      sm && typeof sm.wet_core_ratio === 'number' ? sm.wet_core_ratio : null,
      spatial_class: sm && sm.spatial_concentration_class ? sm.spatial_concentration_class : null,
    });
  }

  const key = sort.key  || SORT_KEY_DEFAULT;
  const ord = sort.order || SORT_ORDER_DEFAULT;
  const dir = ord === 'asc' ? 1 : -1;
  const confRank = { high: 3, medium: 2, low: 1, unknown: 0 };
  const classRank = { 'Uniform': 1, 'Moderately variable': 2, 'Concentrated': 3, 'Highly concentrated': 4, 'unknown': 0 };
  rows.sort((a, b) => {
    let av, bv;
    if      (key === 'max')      { av = a.max_total_mm;  bv = b.max_total_mm; }
    else if (key === 'cov')      { av = a.coverage_pct ?? -1; bv = b.coverage_pct ?? -1; }
    else if (key === 'conf')     { av = confRank[a.confidence] ?? 0; bv = confRank[b.confidence] ?? 0; }
    else if (key === 'cv')       { av = a.cv ?? -1; bv = b.cv ?? -1; }
    else if (key === 'wet_core') { av = a.wet_core ?? -1; bv = b.wet_core ?? -1; }
    else if (key === 'class')    { av = classRank[a.spatial_class] ?? 0; bv = classRank[b.spatial_class] ?? 0; }
    else if (key === 'id')       { return dir * String(a.id).localeCompare(String(b.id), undefined, { numeric: true }); }
    else                         { av = a.max_total_mm; bv = b.max_total_mm; }
    return dir * (av - bv);
  });
  return rows;
}

export function renderRankingPanel(host, {
  data,
  durationKey,
  selectedCatchmentId,
  filters,
  sort,
  onSelectCatchment,
  onFiltersChange,
  onSortChange,
}) {
  host.innerHTML = '';
  host.classList.add('stormgrid-rankingwrap');

  const details = document.createElement('details');
  details.className = 'stormgrid-ranking';
  details.open = true; // open by default

  const summary = document.createElement('summary');
  const durLabel = durationKey || '—';
  summary.innerHTML = `
    Catchment ranking
    <span class="stormgrid-ranking__sub">— ${escapeHtml(durLabel)} critical duration</span>
  `;
  details.appendChild(summary);

  if (!data || !durationKey) {
    const p = document.createElement('p');
    p.className = 'stormgrid-ranking__empty';
    p.textContent = 'Pick an accumulation window and a critical duration to see the ranking.';
    details.appendChild(p);
    host.appendChild(details);
    return;
  }

  // ── Filter bar ────────────────────────────────────────────────────────
  const bar = document.createElement('div');
  bar.className = 'stormgrid-ranking__filters';
  bar.innerHTML = `
    <label class="stormgrid-ranking__filter">
      <span>Confidence</span>
      <select data-filter="confidence">
        <option value="any">Any</option>
        <option value="high">High only</option>
        <option value="high-or-medium">Medium &amp; above</option>
        <option value="low">Low only</option>
      </select>
    </label>
    <label class="stormgrid-ranking__filter">
      <span>Min max-accumulated (mm)</span>
      <input type="number" min="0" step="0.1" data-filter="minMm"
             value="${filters && filters.minMm != null ? filters.minMm : ''}">
    </label>
  `;
  const confSel = bar.querySelector('select[data-filter="confidence"]');
  confSel.value = (filters && filters.confidence) || 'any';
  confSel.addEventListener('change', () => {
    if (typeof onFiltersChange === 'function')
      onFiltersChange({ ...(filters || {}), confidence: confSel.value });
  });
  const minInput = bar.querySelector('input[data-filter="minMm"]');
  minInput.addEventListener('change', () => {
    const v = minInput.value === '' ? null : Number(minInput.value);
    const minMm = (Number.isFinite(v) && v >= 0) ? v : null;
    if (typeof onFiltersChange === 'function')
      onFiltersChange({ ...(filters || {}), minMm });
  });
  details.appendChild(bar);

  // ── Build & render table ──────────────────────────────────────────────
  const rows = buildCatchmentRanking(data, durationKey, { filters: filters || {}, sort: sort || {} });
  if (rows.length === 0) {
    const p = document.createElement('p');
    p.className = 'stormgrid-ranking__empty';
    p.textContent = 'No catchments match the current filters.';
    details.appendChild(p);
    host.appendChild(details);
    return;
  }

  const sortKey = (sort && sort.key)   || SORT_KEY_DEFAULT;
  const sortOrd = (sort && sort.order) || SORT_ORDER_DEFAULT;
  const arrow = (k) => sortKey === k ? (sortOrd === 'desc' ? ' ▼' : ' ▲') : '';
  const onClickHeader = (k) => (e) => {
    e.preventDefault();
    if (typeof onSortChange !== 'function') return;
    if (sortKey === k) onSortChange({ key: k, order: sortOrd === 'desc' ? 'asc' : 'desc' });
    else onSortChange({ key: k, order: k === 'id' ? 'asc' : 'desc' });
  };

  const table = document.createElement('table');
  table.className = 'stormgrid-ranking__table';
  table.innerHTML = `
    <thead><tr>
      <th>#</th>
      <th class="stormgrid-ranking__sortable" data-sort="id">Catchment${arrow('id')}</th>
      <th class="stormgrid-ranking__sortable stormgrid-ranking__num" data-sort="max">Max accumulated${arrow('max')}</th>
      <th class="stormgrid-ranking__sortable stormgrid-ranking__num" data-sort="cov">Coverage${arrow('cov')}</th>
      <th class="stormgrid-ranking__sortable" data-sort="conf">Confidence${arrow('conf')}</th>
      <th class="stormgrid-ranking__sortable stormgrid-ranking__num" data-sort="cv">CV${arrow('cv')}</th>
      <th class="stormgrid-ranking__sortable stormgrid-ranking__num" data-sort="wet_core">Wet-core${arrow('wet_core')}</th>
      <th class="stormgrid-ranking__sortable" data-sort="class">Class${arrow('class')}</th>
      <th>Critical window (UTC)</th>
    </tr></thead>
    <tbody></tbody>
  `;
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', onClickHeader(th.dataset.sort));
  });

  const classKey = (cls) => {
    const m = { 'Uniform': 'uniform', 'Moderately variable': 'moderate',
                'Concentrated': 'concentrated', 'Highly concentrated': 'highly-concentrated' };
    return m[cls] || 'unknown';
  };

  const tbody = table.querySelector('tbody');
  rows.forEach((r, i) => {
    const isTop5    = i < 5;
    const isSelected = r.id === selectedCatchmentId;
    const tr = document.createElement('tr');
    tr.className = 'stormgrid-ranking__row'
      + (isTop5    ? ' stormgrid-ranking__row--top5'     : '')
      + (isSelected ? ' stormgrid-ranking__row--selected' : '');
    tr.dataset.catchmentId = r.id;
    const cov = r.coverage_pct != null ? `${r.coverage_pct.toFixed(1)}%` : '—';
    const cvStr = r.cv != null ? r.cv.toFixed(2) : '—';
    const wcStr = r.wet_core != null ? r.wet_core.toFixed(2) : '—';
    const cls = r.spatial_class || '—';
    tr.innerHTML = `
      <td class="stormgrid-ranking__rank">${i + 1}</td>
      <td>${escapeHtml(r.id)}</td>
      <td class="stormgrid-ranking__num"><strong>${r.max_total_mm.toFixed(2)}</strong> mm</td>
      <td class="stormgrid-ranking__num">${escapeHtml(cov)}</td>
      <td><span class="stormgrid-conf stormgrid-conf--${escapeAttr(r.confidence)}">${escapeHtml(r.confidence.toUpperCase())}</span></td>
      <td class="stormgrid-ranking__num">${escapeHtml(cvStr)}</td>
      <td class="stormgrid-ranking__num">${escapeHtml(wcStr)}</td>
      <td><span class="stormgrid-spatial__chip stormgrid-spatial__chip--${escapeAttr(classKey(cls))}">${escapeHtml(cls)}</span></td>
      <td class="stormgrid-ranking__win">${escapeHtml(formatTs(r.window_start))} → ${escapeHtml(formatTs(r.window_end))}</td>
    `;
    tr.addEventListener('click', () => {
      if (typeof onSelectCatchment === 'function') onSelectCatchment(r.id);
    });
    tbody.appendChild(tr);
  });

  details.appendChild(table);

  const note = document.createElement('p');
  note.className = 'stormgrid-ranking__note';
  note.textContent =
    'Ordered by maximum accumulated catchment-mean rainfall over the selected critical duration. '
    + 'Top 5 rows are highlighted. Click a row to select that catchment on the map.';
  details.appendChild(note);

  host.appendChild(details);

  // Auto-scroll selected row into view if it's outside the visible area.
  if (selectedCatchmentId) {
    const sel = tbody.querySelector('tr.stormgrid-ranking__row--selected');
    if (sel && typeof sel.scrollIntoView === 'function') {
      // smooth scroll, but bias to nearest so we don't jump unnecessarily
      sel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

function formatTs(s) {
  if (!s) return '—';
  return String(s).replace('T', ' ').replace('Z', '');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '');
}
