/* Stormgrid — availability + results panel.
   Renders: source/window/payload metadata, per-catchment results
   (with coverage + confidence + low-coverage warning), critical
   duration result panel, and an expandable frame log panel.

   Backwards-compatible: rows without coverage / duration fields show
   "unavailable" instead of crashing. */

import { rowConfidence, rowCoveragePct } from './stormgridDataLoader.js';

export function renderAvailabilityPanel(host, {
  rainfallResult,
  selected,
  catchmentRow,
  analysisRun,
  lastRunAt,
  selectedDurationKey,
  durationStats,
}) {
  host.innerHTML = '';
  host.classList.add('stormgrid-availwrap');

  const head = document.createElement('header');
  head.className = 'stormgrid-availhead';
  head.innerHTML = `<h3>Static rainfall</h3>`;
  host.appendChild(head);

  if (!rainfallResult) {
    host.appendChild(blockMessage('Loading static rainfall data…'));
    return;
  }
  if (!rainfallResult.ok) {
    host.appendChild(blockMessage(
      `Rainfall data not available (${escapeHtml(rainfallResult.error || 'unknown error')}). ` +
      `Run local generator: ` +
      `<code>python scripts/build_static_rainfall.py</code>`,
      'error'
    ));
    return;
  }

  const d = rainfallResult.data;
  const meta = document.createElement('dl');
  meta.className = 'stormgrid-availmeta';
  meta.innerHTML = `
    <div><dt>Schema</dt>    <dd>${escapeHtml(d.schema_version || 'v1 (legacy)')}</dd></div>
    <div><dt>Source</dt>    <dd>${escapeHtml(d.source)}</dd></div>
    <div><dt>Generated</dt> <dd>${formatTs(d.generated_at)}</dd></div>
    <div><dt>Window</dt>    <dd>${formatTs(d.window.start)} → ${formatTs(d.window.end)}</dd></div>
    <div><dt>Frames</dt>    <dd>${d.window.frame_count}</dd></div>
    <div><dt>Catchments</dt><dd>${Object.keys(d.catchments || {}).length}</dd></div>
    <div><dt>Payload</dt>   <dd>${formatBytes(rainfallResult.sizeBytes)}</dd></div>
  `;
  host.appendChild(meta);

  // Results section
  const sel = document.createElement('section');
  sel.className = 'stormgrid-selstats';
  if (!selected) {
    sel.innerHTML = `<p class="stormgrid-selstats__empty">Click a catchment on the map to select it.</p>`;
  } else if (!catchmentRow) {
    sel.innerHTML = `<p class="stormgrid-selstats__empty">No precomputed data for <strong>${escapeHtml(selected.id)}</strong> in this window.</p>`;
  } else if (!analysisRun) {
    const conf = rowConfidence(catchmentRow);
    const covPct = rowCoveragePct(catchmentRow);
    const covLabel = covPct === null ? 'unavailable' : `${covPct.toFixed(1)}%`;
    sel.innerHTML = `
      <h4>${escapeHtml(selected.id)}
        <span class="stormgrid-selstats__sub">data ready · click Run analysis</span>
      </h4>
      <p class="stormgrid-selstats__empty">${formatSampleCount(catchmentRow)} pixel-frame samples · coverage ${escapeHtml(covLabel)} · confidence <strong class="stormgrid-conf stormgrid-conf--${escapeAttr(conf)}">${escapeHtml(conf.toUpperCase())}</strong></p>
    `;
  } else {
    sel.appendChild(renderResults(selected, catchmentRow, lastRunAt));
    sel.appendChild(renderDurationResult(selectedDurationKey, durationStats));
    sel.appendChild(renderSpatialMetrics(selectedDurationKey, durationStats));
  }
  host.appendChild(sel);
}

const SPATIAL_CLASS_BLURB = {
  'Uniform':              'Rainfall was relatively evenly distributed across the catchment.',
  'Moderately variable':  'Rainfall varied noticeably across the catchment without a single dominant core.',
  'Concentrated':         'Rainfall was concentrated into localised areas within the catchment.',
  'Highly concentrated':  'Rainfall was strongly concentrated into a compact rainfall core.',
  'unknown':              'Spatial structure could not be characterised for this sub-window.',
};
const SPATIAL_CLASS_KEYS = {
  'Uniform': 'uniform',
  'Moderately variable': 'moderate',
  'Concentrated': 'concentrated',
  'Highly concentrated': 'highly-concentrated',
  'unknown': 'unknown',
};

function renderSpatialMetrics(durationKey, durationStats) {
  const wrap = document.createElement('section');
  wrap.className = 'stormgrid-spatial';
  if (!durationStats) {
    wrap.innerHTML = `<h5>Spatial rainfall structure</h5>
      <p class="stormgrid-spatial__empty">Pick a critical duration to see spatial metrics.</p>`;
    return wrap;
  }
  const sm = durationStats.spatial_metrics;
  if (!sm) {
    wrap.innerHTML = `<h5>Spatial rainfall structure <span class="stormgrid-spatial__sub">${escapeHtml(durationKey || '—')}</span></h5>
      <p class="stormgrid-spatial__empty">Spatial metrics not available in this dataset (legacy schema).</p>`;
    return wrap;
  }
  const cls   = sm.spatial_concentration_class || 'unknown';
  const blurb = SPATIAL_CLASS_BLURB[cls] || SPATIAL_CLASS_BLURB.unknown;
  const cn    = SPATIAL_CLASS_KEYS[cls] || 'unknown';
  const fmt = (n) => (n === null || n === undefined) ? '—' : Number(n).toFixed(3);
  wrap.innerHTML = `
    <h5>Spatial rainfall structure <span class="stormgrid-spatial__sub">${escapeHtml(durationKey || '—')}</span></h5>
    <dl class="stormgrid-spatial__grid">
      <div><dt>Concentration class</dt>
           <dd><span class="stormgrid-spatial__chip stormgrid-spatial__chip--${escapeAttr(cn)}">${escapeHtml(cls)}</span></dd></div>
      <div><dt>Coefficient of variation</dt><dd>${fmt(sm.coefficient_of_variation)}</dd></div>
      <div><dt>Uniformity index</dt>        <dd>${fmt(sm.uniformity_index)}</dd></div>
      <div><dt>Wet-core ratio</dt>          <dd>${fmt(sm.wet_core_ratio)}</dd></div>
      <div><dt>Pixels used</dt>             <dd>${typeof sm.pixel_count === 'number' ? sm.pixel_count.toLocaleString() : '—'}</dd></div>
    </dl>
    <p class="stormgrid-spatial__blurb">${escapeHtml(blurb)}</p>
    <p class="stormgrid-spatial__note">Stormgrid-derived indicators based on real pixel rainfall in the critical sub-window. Not engineering design quantities.</p>
  `;
  return wrap;
}

function renderDurationResult(durationKey, durationStats) {
  const wrap = document.createElement('section');
  wrap.className = 'stormgrid-durresult';
  if (!durationKey) {
    wrap.innerHTML = `<h5>Critical duration result</h5>
      <p class="stormgrid-durresult__empty">Pick a critical duration above.</p>`;
    return wrap;
  }
  if (!durationStats) {
    wrap.innerHTML = `<h5>Critical duration result <span class="stormgrid-durresult__sub">${escapeHtml(durationKey)}</span></h5>
      <p class="stormgrid-durresult__empty">Not available for this accumulation window or catchment.</p>`;
    return wrap;
  }
  const fmtMm = (n) => (n === null || n === undefined) ? '—' : `${Number(n).toFixed(2)} mm`;
  const fmtPct = (n) => (n === null || n === undefined) ? '—' : `${Number(n).toFixed(1)}%`;
  const conf = String(durationStats.confidence || 'unknown').toLowerCase();
  const lowCov = (typeof durationStats.coverage_pct === 'number' && durationStats.coverage_pct < 70);
  wrap.classList.toggle('stormgrid-durresult--lowcov', lowCov);
  wrap.innerHTML = `
    <h5>Critical duration result <span class="stormgrid-durresult__sub">${escapeHtml(durationKey)}</span></h5>
    <p class="stormgrid-durresult__lede">Wettest rolling ${escapeHtml(durationKey)} window inside the selected accumulation window.</p>
    <dl class="stormgrid-durresult__grid">
      <div><dt>Max accumulated</dt><dd class="stormgrid-durresult__big">${fmtMm(durationStats.max_total_mm)}</dd></div>
      <div><dt>Confidence</dt>     <dd><span class="stormgrid-conf stormgrid-conf--${escapeAttr(conf)}">${escapeHtml(conf.toUpperCase())}</span></dd></div>
      <div><dt>Window start</dt>   <dd>${escapeHtml(formatTs(durationStats.window_start))}</dd></div>
      <div><dt>Window end</dt>     <dd>${escapeHtml(formatTs(durationStats.window_end))}</dd></div>
      <div><dt>Mean / frame</dt>   <dd>${fmtMm(durationStats.mean_mm)}</dd></div>
      <div><dt>Min / Max pixel</dt><dd>${fmtMm(durationStats.min_mm)} · ${fmtMm(durationStats.max_mm)}</dd></div>
      <div><dt>Coverage</dt>       <dd>${fmtPct(durationStats.coverage_pct)}</dd></div>
      <div><dt>Frames used</dt>    <dd>${durationStats.frames_used} / ${durationStats.frames_used + durationStats.frames_missing}</dd></div>
      <div><dt>Missing frames</dt> <dd>${durationStats.frames_missing}</dd></div>
    </dl>
    ${lowCov
      ? `<p class="stormgrid-durresult__warn">⚠ Low coverage in this critical sub-window — interpret with caution.</p>`
      : ''}
  `;
  return wrap;
}

function renderResults(selected, row, lastRunAt) {
  const fmtMm = (n) => (n === null || n === undefined) ? '—' : `${Number(n).toFixed(2)} mm`;
  const ranAt = lastRunAt ? ` · ran ${formatTs(lastRunAt)}` : '';

  const conf = rowConfidence(row);
  const covPct = rowCoveragePct(row);
  const covLabel = covPct === null ? 'unavailable' : `${covPct.toFixed(1)}%`;
  const lowCoverage = (covPct !== null && covPct < 70);
  const hasFrames = typeof row.frames_used === 'number';

  const wrap = document.createElement('div');
  wrap.className = 'stormgrid-results';
  if (lowCoverage) wrap.classList.add('stormgrid-results--lowcov');

  const valueSection = `
    <h4>${escapeHtml(selected.id)}
      <span class="stormgrid-selstats__sub">results${ranAt}</span>
    </h4>
    <dl class="stormgrid-selstats__grid">
      <div><dt>Total rainfall</dt><dd>${fmtMm(row.total_mm)}</dd></div>
      <div><dt>Mean / frame</dt> <dd>${fmtMm(row.mean_mm)}</dd></div>
      <div><dt>Min</dt>           <dd>${fmtMm(row.min_mm)}</dd></div>
      <div><dt>Max</dt>           <dd>${fmtMm(row.max_mm)}</dd></div>
      <div><dt>Samples</dt>       <dd>${formatSampleCount(row)}</dd></div>
    </dl>
  `;

  const covSection = `
    <section class="stormgrid-coverage">
      <h5>Coverage</h5>
      <dl class="stormgrid-cov__grid">
        <div><dt>Pixel coverage</dt>
             <dd>${escapeHtml(covLabel)}</dd></div>
        <div><dt>Confidence</dt>
             <dd><span class="stormgrid-conf stormgrid-conf--${escapeAttr(conf)}">${escapeHtml(conf.toUpperCase())}</span></dd></div>
        ${hasFrames ? `
          <div><dt>Frames used</dt>
               <dd>${row.frames_used} / ${row.frame_count}</dd></div>
          <div><dt>Missing frames</dt>
               <dd>${row.frames_missing}</dd></div>
          ${typeof row.frames_partial === 'number'
            ? `<div><dt>Partial frames</dt><dd>${row.frames_partial}</dd></div>`
            : ''}
        ` : `<div><dt>Frames</dt><dd>unavailable (legacy schema)</dd></div>`}
      </dl>
      ${lowCoverage
        ? `<p class="stormgrid-coverage__warn">⚠ Low coverage — rainfall statistics may not represent the full catchment.</p>`
        : ''}
    </section>
  `;

  wrap.innerHTML = valueSection + covSection;
  return wrap;
}

export function renderFrameLogPanel(host, { data }) {
  host.innerHTML = '';
  host.classList.add('stormgrid-framelogwrap');

  if (!data || !Array.isArray(data.frame_log) || data.frame_log.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'stormgrid-framelog__empty';
    msg.textContent = 'No frame log available (legacy schema or no data loaded).';
    host.appendChild(msg);
    return;
  }

  const log = data.frame_log;
  const counts = log.reduce((acc, f) => {
    acc.total += 1;
    if (f.status === 'valid')   acc.valid += 1;
    if (f.status === 'partial') acc.partial += 1;
    if (f.status === 'missing') acc.missing += 1;
    return acc;
  }, { total: 0, valid: 0, partial: 0, missing: 0 });

  const details = document.createElement('details');
  details.className = 'stormgrid-framelog';
  details.innerHTML = `
    <summary>Frame log <span class="stormgrid-framelog__counts">
      ${counts.total} total · <span class="stormgrid-framelog__valid">${counts.valid} valid</span>
      · <span class="stormgrid-framelog__partial">${counts.partial} partial</span>
      · <span class="stormgrid-framelog__missing">${counts.missing} missing</span>
    </span></summary>
    <table class="stormgrid-framelog__table">
      <thead><tr>
        <th>Timestamp</th><th>Status</th><th>With data</th><th>Missing</th><th>Notes</th>
      </tr></thead>
      <tbody>
        ${log.map((f) => `
          <tr class="stormgrid-framelog__row stormgrid-framelog__row--${escapeAttr(f.status || 'unknown')}">
            <td>${escapeHtml(formatTs(f.timestamp))}</td>
            <td><span class="stormgrid-framelog__status stormgrid-framelog__status--${escapeAttr(f.status || 'unknown')}">${escapeHtml((f.status || '').toUpperCase())}</span></td>
            <td>${f.catchments_with_valid_data ?? '—'}</td>
            <td>${f.catchments_missing_data ?? '—'}</td>
            <td>${escapeHtml(f.notes || '')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  host.appendChild(details);
}

export function renderLastBuiltStrip(host, { rainfallResult }) {
  host.innerHTML = '';
  host.classList.add('stormgrid-lastbuilt');
  host.classList.remove('stormgrid-lastbuilt--missing');
  host.classList.remove('stormgrid-lastbuilt--stale');

  if (!rainfallResult || !rainfallResult.ok || !rainfallResult.data) {
    host.classList.add('stormgrid-lastbuilt--missing');
    host.innerHTML = `<strong>Last built:</strong> unavailable`;
    return;
  }
  const generatedAt = rainfallResult.data.generated_at;
  const ts = generatedAt ? new Date(generatedAt) : null;
  const stale = ts && (Date.now() - ts.getTime()) > 24 * 3600 * 1000;
  if (stale) host.classList.add('stormgrid-lastbuilt--stale');
  host.innerHTML = `
    <strong>Last built:</strong> ${escapeHtml(formatTs(generatedAt))}
    ${stale ? '<span class="stormgrid-lastbuilt__warn">⚠ Data may be stale.</span>' : ''}
  `;
}

/* Duration selector — segmented button group.
   `durations`: [{ key, label, durationHours, frameCount }]  (only available)
   `allKeys`: [string] — all 6 standard duration keys, for showing disabled
   `selectedKey`: currently selected duration key (may be null)
   `onChange(newKey)`: callback */
export function renderDurationSelector(host, { durations, allKeys, selectedKey, onChange }) {
  host.innerHTML = '';
  host.classList.add('stormgrid-durationsel');
  const label = document.createElement('span');
  label.className = 'stormgrid-durationsel__label';
  label.textContent = 'Critical duration';
  host.appendChild(label);

  const group = document.createElement('div');
  group.className = 'stormgrid-durationsel__group';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Rolling critical duration within the selected accumulation window');
  const availableKeys = new Set(durations.map((d) => d.key));
  const labelByKey    = new Map(durations.map((d) => [d.key, d.label]));

  allKeys.forEach((key) => {
    const isAvailable = availableKeys.has(key);
    // For disabled keys we still want the same "N h" format as the available ones.
    const fallbackLabel = (() => {
      const m = /^(\d+)([dh])$/.exec(key);
      if (!m) return key;
      const unit = m[2] === 'h' ? 'h' : 'd';
      return `${m[1]} ${unit}`;
    })();
    const label = labelByKey.get(key) || fallbackLabel;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stormgrid-durationsel__btn'
      + (isAvailable ? '' : ' stormgrid-durationsel__btn--disabled')
      + (key === selectedKey ? ' stormgrid-durationsel__btn--active' : '');
    btn.textContent = label;
    btn.dataset.durationKey = key;
    btn.disabled = !isAvailable;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', key === selectedKey ? 'true' : 'false');
    if (!isAvailable) btn.title = 'Not available for this accumulation window';
    btn.addEventListener('click', () => {
      if (!isAvailable) return;
      if (key !== selectedKey && typeof onChange === 'function') onChange(key);
    });
    group.appendChild(btn);
  });
  host.appendChild(group);

  const sub = document.createElement('span');
  sub.className = 'stormgrid-durationsel__sub';
  sub.textContent = 'Stormgrid finds the wettest rolling duration inside the selected accumulation window.';
  host.appendChild(sub);
}

/* Map colour-mode selector — segmented button group.
   `modes`: [{ key, label }]
   `selectedKey`: current mode
   `onChange(newKey)`: callback */
export function renderMapModeSelector(host, { modes, selectedKey, onChange }) {
  host.innerHTML = '';
  host.classList.add('stormgrid-mapmodesel');
  const label = document.createElement('span');
  label.className = 'stormgrid-mapmodesel__label';
  label.textContent = 'Map colour';
  host.appendChild(label);
  const group = document.createElement('div');
  group.className = 'stormgrid-mapmodesel__group';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Map polygon colour mode');
  modes.forEach((m) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stormgrid-mapmodesel__btn'
      + (m.key === selectedKey ? ' stormgrid-mapmodesel__btn--active' : '');
    btn.textContent = m.label;
    btn.dataset.mapMode = m.key;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', m.key === selectedKey ? 'true' : 'false');
    btn.addEventListener('click', () => {
      if (m.key !== selectedKey && typeof onChange === 'function') onChange(m.key);
    });
    group.appendChild(btn);
  });
  host.appendChild(group);
}

/* Window selector — segmented button group.
   `windows`: [{ key, label }]
   `selectedKey`: currently selected window key
   `onChange(newKey)`: callback */
export function renderWindowSelector(host, { windows, selectedKey, onChange }) {
  host.innerHTML = '';
  host.classList.add('stormgrid-windowsel');
  const label = document.createElement('span');
  label.className = 'stormgrid-windowsel__label';
  label.textContent = 'Accumulation window';
  host.appendChild(label);
  const group = document.createElement('div');
  group.className = 'stormgrid-windowsel__group';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Precomputed rainfall accumulation window');
  windows.forEach((w) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stormgrid-windowsel__btn'
      + (w.key === selectedKey ? ' stormgrid-windowsel__btn--active' : '');
    btn.textContent = w.label;
    btn.dataset.windowKey = w.key;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', w.key === selectedKey ? 'true' : 'false');
    btn.addEventListener('click', () => {
      if (w.key !== selectedKey && typeof onChange === 'function') onChange(w.key);
    });
    group.appendChild(btn);
  });
  host.appendChild(group);
  const sub = document.createElement('span');
  sub.className = 'stormgrid-windowsel__sub';
  sub.textContent = '(precomputed accumulation, not a rolling re-aggregation)';
  host.appendChild(sub);
}

function blockMessage(html, variant) {
  const el = document.createElement('p');
  el.className = 'stormgrid-availmsg' + (variant ? ` stormgrid-availmsg--${variant}` : '');
  el.innerHTML = html;
  return el;
}

function formatSampleCount(row) {
  const n = row && typeof row.sample_count === 'number' ? row.sample_count : null;
  if (n === null) return '—';
  return n.toLocaleString();
}

function formatTs(s) {
  if (!s) return '—';
  return String(s).replace('T', ' ').replace('Z', ' UTC');
}

function formatBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
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
