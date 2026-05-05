/* Stormgrid v0 — availability + results panel.
   Renders the static rainfall payload metadata and the selected
   catchment's results (after the user clicks Run). */

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
      `<code>python scripts/build_stormgrid_static_rainfall.py</code>`,
      'error'
    ));
    return;
  }

  const d = rainfallResult.data;
  const meta = document.createElement('dl');
  meta.className = 'stormgrid-availmeta';
  meta.innerHTML = `
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
    sel.innerHTML = `
      <h4>${escapeHtml(selected.id)}
        <span class="stormgrid-selstats__sub">data ready · click Run analysis</span>
      </h4>
      <p class="stormgrid-selstats__empty">${catchmentRow.sample_count.toLocaleString()} pixel-frame samples available.</p>
    `;
  } else {
    const fmtMm = (n) => (n === null || n === undefined) ? '—' : `${Number(n).toFixed(2)} mm`;
    const ranAt = lastRunAt ? ` · ran ${formatTs(lastRunAt)}` : '';
    sel.innerHTML = `
      <h4>${escapeHtml(selected.id)}
        <span class="stormgrid-selstats__sub">results${ranAt}</span>
      </h4>
      <dl class="stormgrid-selstats__grid">
        <div><dt>Total rainfall</dt><dd>${fmtMm(catchmentRow.total_mm)}</dd></div>
        <div><dt>Mean / frame</dt> <dd>${fmtMm(catchmentRow.mean_mm)}</dd></div>
        <div><dt>Min</dt>           <dd>${fmtMm(catchmentRow.min_mm)}</dd></div>
        <div><dt>Max</dt>           <dd>${fmtMm(catchmentRow.max_mm)}</dd></div>
        <div><dt>Samples</dt>       <dd>${catchmentRow.sample_count.toLocaleString()}</dd></div>
      </dl>
    `;
  }
  host.appendChild(sel);
}

function blockMessage(html, variant) {
  const el = document.createElement('p');
  el.className = 'stormgrid-availmsg' + (variant ? ` stormgrid-availmsg--${variant}` : '');
  el.innerHTML = html;
  return el;
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
