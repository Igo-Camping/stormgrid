/* Stormgrid — availability + results panel.
   Renders: source/window/payload metadata, per-catchment results
   (with coverage + confidence + low-coverage warning), and an
   expandable frame log panel.

   Backwards-compatible: rows without coverage fields show
   "Coverage: unavailable" instead of crashing. */

import { rowConfidence, rowCoveragePct } from './stormgridDataLoader.js';

export function renderAvailabilityPanel(host, {
  rainfallResult,
  selected,
  catchmentRow,
  analysisRun,
  lastRunAt,
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
  }
  host.appendChild(sel);
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
