/* Stormgrid — point IFD comparison panel.
   Methodology-safe: the panel is wrapped in an explicit "POINT IFD ONLY,
   ARF NOT APPLIED" warning, includes a per-row Notes column flagging
   suspect cache entries, and never displays an AEP classification, a
   return period, or any "1 in X" wording. */

const DURATION_KEYS = ['3h', '6h', '12h', '24h', '48h', '72h'];
const AEP_COLUMNS   = ['20%', '5%', '2%', '1%'];

export function renderIfdComparisonPanel(host, {
  ifdResult,        // { ok, data, error }
  catchmentId,
  catchmentRow,     // for window/general info
  durationStatsByKey, // { '3h': {max_total_mm, ...}, ... } — full per-duration stats
}) {
  host.innerHTML = '';
  host.classList.add('stormgrid-ifdwrap');

  // Always-on warning banner — shown even before data loads.
  const warn = document.createElement('div');
  warn.className = 'stormgrid-ifd__warn';
  warn.innerHTML = `
    <strong>POINT IFD ONLY · ARF NOT APPLIED.</strong>
    Do not interpret this as a catchment AEP classification.
    Catchment-mean rainfall must be compared to ARF-adjusted areal design rainfall before assigning event AEP.
  `;
  host.appendChild(warn);

  if (!ifdResult) {
    host.appendChild(blockNote('Loading point IFD reference data…'));
    return;
  }
  if (!ifdResult.ok) {
    host.appendChild(blockNote(
      `Point IFD reference unavailable (${escapeHtml(ifdResult.error || 'unknown')}). ` +
      `Run the local generator: <code>python scripts/build_catchment_ifd.py --pluvio-root PATH</code>`,
      'error'
    ));
    return;
  }

  const ifdAll = ifdResult.data;
  if (!catchmentId) {
    host.appendChild(blockNote('Click a catchment on the map to see point IFD context for its centroid.'));
    return;
  }
  const cifd = ifdAll.catchments[catchmentId];
  if (!cifd) {
    host.appendChild(blockNote(`No point IFD reference for <strong>${escapeHtml(catchmentId)}</strong> in this dataset.`));
    return;
  }

  // ── Reference point header ──────────────────────────────────────────
  const head = document.createElement('header');
  head.className = 'stormgrid-ifd__head';
  const refLon = cifd.reference_station_lonlat ? cifd.reference_station_lonlat[0] : null;
  const refLat = cifd.reference_station_lonlat ? cifd.reference_station_lonlat[1] : null;
  head.innerHTML = `
    <h3>Point IFD context — <span class="stormgrid-ifd__cid">${escapeHtml(catchmentId)}</span></h3>
    <dl class="stormgrid-ifd__refmeta">
      <div><dt>Reference station</dt>
           <dd>${escapeHtml(cifd.reference_station_name || cifd.reference_station_id || '—')}
               <small>(${escapeHtml(cifd.reference_station_id || '')})</small></dd></div>
      <div><dt>Station coords</dt>
           <dd>${refLat != null && refLon != null
                 ? `${Number(refLat).toFixed(4)}, ${Number(refLon).toFixed(4)}`
                 : '—'}</dd></div>
      <div><dt>Distance from centroid</dt>
           <dd>${typeof cifd.reference_station_distance_km === 'number'
                 ? `${cifd.reference_station_distance_km.toFixed(2)} km`
                 : '—'}</dd></div>
    </dl>
  `;
  host.appendChild(head);

  // ── Comparison table ────────────────────────────────────────────────
  const table = document.createElement('table');
  table.className = 'stormgrid-ifd__table';
  const headerCells = [
    'Duration',
    'Observed catchment rainfall',
    ...AEP_COLUMNS.map((p) => `Point IFD ${p} AEP`),
    'Notes',
  ].map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const bodyRows = DURATION_KEYS.map((dk) => {
    const obs = (durationStatsByKey || {})[dk];
    const obsVal = obs && typeof obs.max_total_mm === 'number' ? obs.max_total_mm : null;
    const ifdRow = cifd.durations[dk];
    const fmt = (n) => (typeof n === 'number') ? `${n.toFixed(1)}` : '—';
    const obsCell = obsVal == null ? '—' : `<strong>${obsVal.toFixed(2)}</strong> mm`;
    const aepCells = AEP_COLUMNS.map((p) => {
      if (!ifdRow || !ifdRow.aep) return '—';
      const v = ifdRow.aep[p];
      return v == null ? '—' : `${fmt(v)}`;
    });
    const notes = [];
    if (!obs) notes.push('No observed data for this duration in the current window.');
    if (!ifdRow) notes.push('No IFD value at this duration in the cache.');
    if (ifdRow && ifdRow.quality_flag === 'suspect_non_monotonic') {
      notes.push('IFD row flagged suspect (non-monotonic vs longer durations) — exclude from comparison.');
    }
    const notesText = notes.length ? notes.join(' ') : '';
    const rowClass = (ifdRow && ifdRow.quality_flag) ? ' stormgrid-ifd__row--suspect' : '';
    return `<tr class="stormgrid-ifd__row${rowClass}">
      <td>${escapeHtml(dk)}</td>
      <td class="stormgrid-ifd__num">${obsCell}</td>
      ${aepCells.map((c) => `<td class="stormgrid-ifd__num">${c}</td>`).join('')}
      <td class="stormgrid-ifd__notes">${escapeHtml(notesText)}</td>
    </tr>`;
  }).join('');
  table.innerHTML = `<thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody>`;
  host.appendChild(table);

  // ── Chart: observed vs point-IFD AEPs ───────────────────────────────
  host.appendChild(renderIfdChart(cifd, durationStatsByKey || {}));

  // ── Footer methodology note ─────────────────────────────────────────
  const foot = document.createElement('p');
  foot.className = 'stormgrid-ifd__foot';
  foot.innerHTML = `
    Point IFD comparison only — ARF not applied.<br>
    Do not interpret this as a catchment AEP classification.<br>
    Catchment-mean rainfall should be compared to ARF-adjusted areal design rainfall before assigning event AEP.
  `;
  host.appendChild(foot);
}

function renderIfdChart(cifd, durationStatsByKey) {
  // Simple SVG line chart. X axis: durations (categorical, ordered).
  // Y axis: rainfall (mm). 4 IFD lines + observed points.
  const W = 640, H = 280, padL = 48, padR = 14, padT = 14, padB = 38;

  // Collect all numeric values to determine y-scale.
  const all = [];
  const series = {
    obs:  [],
    '20%': [], '5%': [], '2%': [], '1%': [],
  };
  DURATION_KEYS.forEach((dk, i) => {
    const obs = durationStatsByKey[dk];
    if (obs && typeof obs.max_total_mm === 'number') {
      series.obs.push({ x: i, y: obs.max_total_mm });
      all.push(obs.max_total_mm);
    }
    const r = cifd.durations[dk];
    if (r && r.aep && r.quality_flag !== 'suspect_non_monotonic') {
      AEP_COLUMNS.forEach((p) => {
        const v = r.aep[p];
        if (typeof v === 'number') {
          series[p].push({ x: i, y: v });
          all.push(v);
        }
      });
    }
  });
  const yMax = all.length ? Math.max(...all, 1) * 1.05 : 1;
  const xScale = (i) => padL + (i / (DURATION_KEYS.length - 1)) * (W - padL - padR);
  const yScale = (v) => H - padB - (v / yMax) * (H - padT - padB);

  const colours = { obs: '#00585b', '20%': '#9ec5fe', '5%': '#6aa3f0', '2%': '#3a73c8', '1%': '#1c4ea8' };
  const polylinePoints = (pts) => pts.map((p) => `${xScale(p.x)},${yScale(p.y)}`).join(' ');

  // Y ticks
  const yTicks = 5;
  const ticks = [];
  for (let i = 0; i <= yTicks; i++) {
    const v = (yMax * i) / yTicks;
    ticks.push(v);
  }

  const wrap = document.createElement('figure');
  wrap.className = 'stormgrid-ifd__chartwrap';
  wrap.innerHTML = `
    <figcaption>Observed catchment rainfall vs point IFD design depths (no ARF)</figcaption>
    <svg class="stormgrid-ifd__chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Observed vs point IFD chart">
      ${ticks.map((v) => `
        <line x1="${padL}" x2="${W - padR}" y1="${yScale(v)}" y2="${yScale(v)}"
              stroke="#e0e6ec" stroke-width="1"/>
        <text x="${padL - 6}" y="${yScale(v) + 3}" text-anchor="end"
              font-size="10" fill="#5b6473" font-family="sans-serif">${v.toFixed(0)}</text>
      `).join('')}
      ${DURATION_KEYS.map((dk, i) => `
        <text x="${xScale(i)}" y="${H - padB + 14}" text-anchor="middle"
              font-size="11" fill="#1a1f2b" font-family="sans-serif">${dk}</text>
      `).join('')}
      ${AEP_COLUMNS.map((p) => `
        <polyline fill="none" stroke="${colours[p]}" stroke-width="1.5"
                  points="${polylinePoints(series[p])}"/>
        ${series[p].map((pt) => `
          <circle cx="${xScale(pt.x)}" cy="${yScale(pt.y)}" r="2.5" fill="${colours[p]}"/>
        `).join('')}
      `).join('')}
      <polyline fill="none" stroke="${colours.obs}" stroke-width="2.5"
                stroke-dasharray="5 4" points="${polylinePoints(series.obs)}"/>
      ${series.obs.map((pt) => `
        <circle cx="${xScale(pt.x)}" cy="${yScale(pt.y)}" r="4"
                fill="${colours.obs}" stroke="#fff" stroke-width="1.5"/>
      `).join('')}
      <text x="${W - padR}" y="${padT + 12}" text-anchor="end"
            font-size="10" fill="#5b6473" font-family="sans-serif">mm</text>
    </svg>
    <div class="stormgrid-ifd__legend">
      <span class="stormgrid-ifd__legend-item">
        <i style="background:${colours.obs};border-style:dashed;border-color:${colours.obs}"></i>
        Observed catchment-mean (current window)
      </span>
      ${AEP_COLUMNS.map((p) => `
        <span class="stormgrid-ifd__legend-item">
          <i style="background:${colours[p]}"></i>Point IFD ${escapeHtml(p)} AEP
        </span>
      `).join('')}
    </div>
  `;
  return wrap;
}

function blockNote(html, variant) {
  const el = document.createElement('p');
  el.className = 'stormgrid-ifd__note' + (variant === 'error' ? ' stormgrid-ifd__note--error' : '');
  el.innerHTML = html;
  return el;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
