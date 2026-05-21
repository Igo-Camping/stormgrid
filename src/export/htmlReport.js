// htmlReport.js — self-contained HTML report exporter (GREENFIELD, doable today).
//
// docs/02 §10.6: "PDF report (council / insurance)" + "HTML report" are the
// Report group, marked [greenfield]. This builds a COMPLETE, SELF-CONTAINED HTML
// document from the footprint — no external CSS, no external JS, no new CDN library.
// It is the council/insurance deliverable: it leads with provenance, states
// coverage/confidence/missing-frames, and shows the methodology + limitations and
// the AEP gate status (the "placeholder — not defensible" note when gated).
//
// Self-contained means: a single string of valid HTML with an inline <style>. It
// opens and prints anywhere with no network access. pdfReport.js reuses this exact
// document and adds a print-ready view + window.print() (browser "Save as PDF").
//
// HONESTY: every figure is read from the footprint (provenance already travelled).
// Gaps render as "—" (never 0). When the AEP engineering gate is closed, the report
// shows the placeholder/not-defensible banner prominently and emits NO AEP number.
// An optional map snapshot (a PNG data URL) can be embedded; it is labelled
// "illustrative — carries no embedded provenance".
//
// Pure string assembly + a Blob download. No new science.

import { triggerDownload, escapeHtml } from './download.js';
import { suggestExportFilename, summariseFootprint } from './footprint.js';

const REPORT_CSS = `
  :root { --ink:#1a1f26; --muted:#5b6675; --line:#d7dde5; --warn-bg:#fff4e5; --warn-ink:#8a4b00; --bad-bg:#fdecea; --bad-ink:#9b1c1c; --ok-bg:#eaf6ec; --ok-ink:#1c6b2b; }
  * { box-sizing:border-box; }
  body { font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:var(--ink); margin:0; padding:32px; max-width:900px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:28px 0 10px; border-bottom:1px solid var(--line); padding-bottom:4px; }
  .sub { color:var(--muted); margin:0 0 18px; }
  .banner { padding:12px 14px; border-radius:6px; margin:14px 0; font-weight:600; }
  .banner--bad { background:var(--bad-bg); color:var(--bad-ink); }
  .banner--warn { background:var(--warn-bg); color:var(--warn-ink); }
  .banner--ok { background:var(--ok-bg); color:var(--ok-ink); }
  dl.grid { display:grid; grid-template-columns:max-content 1fr; gap:6px 18px; margin:0; }
  dl.grid dt { color:var(--muted); }
  dl.grid dd { margin:0; }
  table { border-collapse:collapse; width:100%; margin:8px 0; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; }
  th { color:var(--muted); font-weight:600; }
  td.missing { color:var(--bad-ink); }
  ul { margin:6px 0; padding-left:20px; }
  .muted { color:var(--muted); }
  .snap { max-width:100%; border:1px solid var(--line); border-radius:6px; margin:8px 0; }
  footer { margin-top:32px; padding-top:12px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
`;

/**
 * Build the complete HTML report document for a footprint.
 * @param {Object} fp footprint from buildEventFootprint
 * @param {Object} [opts]
 * @param {string} [opts.title] report title
 * @param {string} [opts.mapSnapshotDataUrl] optional PNG data URL to embed (illustrative)
 * @param {boolean} [opts.forPrint] add a small print hint (used by pdfReport)
 * @returns {string} a full HTML document string
 */
export function buildHtmlReport(fp, opts = {}) {
  const title = opts.title || 'Stormgrid Event Report';
  const s = summariseFootprint(fp);
  const p = fp.provenance || {};
  const loc = (fp.context && fp.context.location) || {};
  const tf = (fp.context && fp.context.timeframe) || {};

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="sub">Generated ${escapeHtml(fmtTs(fp.generatedAt))} · schema ${escapeHtml(fp.schemaVersion)}</p>

${defensibilityBanner(fp)}

<h2>Location &amp; provenance</h2>
<dl class="grid">
  <dt>Location</dt><dd>${escapeHtml(locLabel(loc))}</dd>
  <dt>Boundary basis</dt><dd>${loc.kind === 'catchment'
    ? (loc.isAuthoritative ? 'Authoritative catchment boundary' : 'Raster-derived catchment — <strong>non-authoritative</strong> (P-3)')
    : escapeHtml(loc.kind || '—')}</dd>
  <dt>Timeframe</dt><dd>${escapeHtml(tfLabel(tf))}</dd>
  <dt>Duration</dt><dd>${escapeHtml((fp.context && fp.context.duration) || '—')}</dd>
  <dt>Data source</dt><dd>${escapeHtml(p.sourceLabel || p.sourceId || '—')} ${p.kind ? `<span class="muted">(${escapeHtml(p.kind)})</span>` : ''}</dd>
  <dt>Build / freshness</dt><dd>${escapeHtml(p.buildVersion || '—')} ${p.lastBuilt ? `<span class="muted">· built ${escapeHtml(fmtTs(p.lastBuilt))}</span>` : ''}</dd>
  <dt>Frame unit</dt><dd>${escapeHtml(p.unit || '—')}</dd>
  <dt>Calibration</dt><dd>${escapeHtml(calLabel(fp.calibration))}</dd>
</dl>

${opts.mapSnapshotDataUrl ? `
<h2>Map snapshot</h2>
<img class="snap" alt="Map snapshot (illustrative)" src="${escapeHtml(opts.mapSnapshotDataUrl)}"/>
<p class="muted">Illustrative screen capture — carries no embedded provenance. The numeric values in this report are the defensible record.</p>
` : ''}

<h2>Summary statistics</h2>
<dl class="grid">
  <dt>Catchment mean (areal)</dt><dd>${mm(s.catchmentMeanMm)}</dd>
  <dt>Max cell</dt><dd>${mm(s.maxCellMm)}</dd>
  <dt>Min cell</dt><dd>${mm(s.minCellMm)}</dd>
  <dt>Spatial CV</dt><dd>${s.spatialCv == null ? '—' : escapeHtml(s.spatialCv.toFixed(2))}</dd>
  <dt>Critical duration</dt><dd>${criticalDurationLabel(fp)}</dd>
</dl>

<h2>Confidence &amp; coverage</h2>
<dl class="grid">
  <dt>Confidence tier</dt><dd>${escapeHtml(tierLabel(s.confidenceTier))}</dd>
  <dt>Coverage</dt><dd>${s.coveragePct == null ? '—' : `${escapeHtml(s.coveragePct.toFixed(1))}%`} ${(s.framesUsed != null && s.framesExpected != null) ? `<span class="muted">(${s.framesUsed} of ${s.framesExpected} frames)</span>` : ''}</dd>
  <dt>Missing frames</dt><dd>${s.framesMissing == null ? '—' : (s.framesMissing === 0 ? '0 — complete' : `<strong>${s.framesMissing}</strong> (reported, never filled)`)}</dd>
</dl>
${confidenceReasons(s)}
${missingFramesTable(fp)}

<h2>AEP status</h2>
${aepSection(fp)}

<h2>Methodology &amp; limitations</h2>
${methodologySection(fp)}

<footer>
  Stormgrid event report · ${escapeHtml(fp.schemaVersion)} · provenance carried from the validated source result.
  ${fp.defensible ? '' : ' This report is <strong>not an engineering-defensible deliverable</strong> — see the AEP status and limitations above.'}
  ${opts.forPrint ? ' Use your browser\'s Print → Save as PDF to produce a PDF copy.' : ''}
</footer>
</body>
</html>`;
}

/** Build the HTML report and trigger a browser download. */
export function exportHtmlReport(fp, opts = {}) {
  const html = buildHtmlReport(fp, opts);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  triggerDownload(blob, suggestExportFilename(fp, 'html'));
  return html;
}

// ── section builders (pure) ────────────────────────────────────────────────────

function defensibilityBanner(fp) {
  if (!fp.hasResult) {
    return '<div class="banner banner--bad">No window result loaded — this report has no data.</div>';
  }
  if (fp.defensible) {
    return '<div class="banner banner--ok">Provenance complete. Source, coverage, confidence and calibration are recorded below.</div>';
  }
  const reasons = [];
  if (fp.isSynthetic) reasons.push('source is placeholder/synthetic');
  if (fp.aep && fp.aep.gated) reasons.push('AEP output gated (placeholder ARF, P-1)');
  return `<div class="banner banner--warn">Illustrative output — <strong>not an engineering-defensible deliverable</strong>${reasons.length ? ` (${escapeHtml(reasons.join('; '))})` : ''}. The provenance below is accurate; the numeric defensibility is not yet established.</div>`;
}

function aepSection(fp) {
  const aep = fp.aep || {};
  if (aep.engineeringGradeAllowed) {
    return `<p>An indicative AEP comparison band may be computed for this source. Stormgrid still never classifies an event AEP, assigns a return period, or asserts formal exceedance — any band shown is indicative only.</p>
      <p class="muted">${escapeHtml(aep.note || '')}</p>`;
  }
  return `<div class="banner banner--bad">${escapeHtml(aep.gateReason || 'AEP output suppressed.')}</div>
    <p class="muted">${escapeHtml(aep.note || '')}</p>`;
}

function methodologySection(fp) {
  const items = [];
  items.push('Rainfall figures are <em>already-areal</em> catchment values read directly from the source result. ARF is never applied to them (areal-vs-point red line).');
  items.push('Gaps are reported, never filled: a missing frame contributes no value and is listed explicitly above.');
  if (fp.context && fp.context.location && fp.context.location.kind === 'catchment' && !fp.context.location.isAuthoritative) {
    items.push('The catchment boundary is raster-derived and <strong>non-authoritative</strong> (P-3); any engineering use must substitute an authoritative boundary.');
  }
  if (fp.calibration && fp.calibration.applied) {
    items.push(`Calibration applied: ${escapeHtml(fp.calibration.method || 'bias correction')}${fp.calibration.version ? ` (v${escapeHtml(fp.calibration.version)})` : ''}. Raw values are preserved (reversible).`);
  }
  const warnItems = (fp.warningDetail || []).map((w) => escapeHtml(w.label));
  const allItems = items.concat(warnItems);
  return `<ul>${allItems.map((i) => `<li>${i}</li>`).join('')}</ul>`;
}

function confidenceReasons(s) {
  if (!s.confidenceReasons || !s.confidenceReasons.length) return '';
  return `<p class="muted">Confidence reasons: ${escapeHtml(s.confidenceReasons.join('; '))}</p>`;
}

function missingFramesTable(fp) {
  const missing = (fp.frameLog || []).filter((f) => f.status === 'missing');
  if (!missing.length) return '';
  const rows = missing.map((f) => `<tr><td class="missing">${escapeHtml(fmtTs(f.iso))}</td><td class="missing">missing</td><td class="missing">—</td></tr>`).join('');
  return `<table><thead><tr><th>Frame</th><th>Status</th><th>Mean</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function criticalDurationLabel(fp) {
  const list = fp.durationStats || [];
  let best = null;
  for (const d of list) {
    if (d.maxAccumulatedMm == null) continue;
    if (!best || d.maxAccumulatedMm > best.maxAccumulatedMm) best = d;
  }
  if (!best) return '—';
  return `${escapeHtml(best.durationKey || '—')} <span class="muted">(${best.maxAccumulatedMm.toFixed(0)} mm)</span>`;
}

// ── label helpers ────────────────────────────────────────────────────────────

function locLabel(loc) {
  if (!loc || !loc.kind) return '—';
  if (loc.kind === 'catchment') return loc.label ? `${loc.label} (${loc.catchmentId})` : `Catchment ${loc.catchmentId}`;
  if (loc.kind === 'point') return `Point ${loc.lat}, ${loc.lon}`;
  if (loc.kind === 'area') return `Area ${loc.areaRef || ''}`.trim();
  return loc.kind;
}

function tfLabel(tf) {
  if (!tf || !tf.kind) return '—';
  if (tf.kind === 'window') return `Window ${tf.windowKey || ''}${tf.endIso ? ` ending ${fmtTs(tf.endIso)}` : ''}`.trim();
  if (tf.kind === 'event') return `Event ${tf.eventId || ''}`.trim();
  return tf.kind;
}

function calLabel(cal) {
  if (!cal) return '—';
  if (!cal.applied) return `${cal.displayMode || 'raw'} (no calibration applied)`;
  return `${cal.displayMode}${cal.method ? ` · ${cal.method}` : ''}${cal.version ? ` v${cal.version}` : ''}`;
}

function tierLabel(t) {
  if (!t) return '—';
  return { high: 'High', moderate: 'Moderate', low: 'Low' }[t] || t;
}

function mm(v) {
  return (v == null) ? '—' : `${Number(v).toFixed(1)} mm`;
}

function fmtTs(iso) {
  if (!iso) return '—';
  return String(iso).replace('T', ' ').replace(/Z$/, ' UTC');
}
