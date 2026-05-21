// exporters.js — the export-format registry + honest stubs.
//
// docs/02 §10.6 export flow groups: Report (PDF/HTML), Tabular (CSV/XLSX),
// Geospatial (GeoJSON/raster), Engineering (12d/DRAINS), Image (PNG).
//
// This module is the SINGLE source of truth for "what formats exist and what is
// their honest status". The export panel (exportPanel.js) renders straight off
// EXPORT_FORMATS, so the UI can never claim a format works that doesn't.
//
// Status vocabulary (mirrors docs/02 §10.6 markers):
//   'working'   — implemented, carries provenance, ready to download.
//   'greenfield'— newly built this wave on the footprint (HTML report, PDF-via-print).
//   'stub'      — NOT available; throws a clear "needs <X>" error. Surfaced disabled.
//
// HONEST STUBS (brief rule 6): XLSX, 12d, DRAINS are NOT faked. Each stub throws a
// clear message naming exactly what is needed (a library, or an exact target-format
// spec that does not exist in-repo). XLSX optionally emits a real CSV interim with a
// note. Each is recorded as a Phase-D/E prerequisite (see docs/05 + DECISIONS.md).

import { exportCsv, buildCsv } from './csv.js';
import { exportJson } from './json.js';
import { exportGeoJson } from './geojson.js';
import { exportPngSnapshot, pngAvailable } from './png.js';
import { exportHtmlReport } from './htmlReport.js';
import { exportPdfReport } from './pdfReport.js';
import { triggerDownload } from './download.js';
import { suggestExportFilename } from './footprint.js';

// ── honest stubs ───────────────────────────────────────────────────────────────

/**
 * XLSX — NOT available without a spreadsheet-writing library. Optionally emits a
 * real CSV as an interim so the user is not left empty-handed, with a clear note.
 * @param {Object} fp footprint
 * @param {Object} [opts]
 * @param {boolean} [opts.csvInterim=false] if true, download a CSV instead and resolve.
 * @throws {Error} when no interim is requested.
 */
export function exportXlsx(fp, opts = {}) {
  if (opts.csvInterim) {
    // Real, provenance-bearing CSV as an interim. The .csv extension is honest —
    // we do NOT label a CSV as .xlsx.
    const blob = new Blob([buildCsv(fp)], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, suggestExportFilename(fp, 'csv'));
    return { interim: 'csv', note: 'XLSX not yet available — exported a CSV interim instead.' };
  }
  throw new Error(
    'XLSX export not yet available. It needs a client-side spreadsheet-writing '
    + 'library (e.g. SheetJS/xlsx or exceljs) added from a CDN, which requires a '
    + '`script-src` entry in the index.html Content-Security-Policy (a documented '
    + 'CSP change, not made). Interim: request the CSV export, which carries the '
    + 'full provenance. Recorded as a Phase-E prerequisite (docs/05).'
  );
}

/**
 * 12d — NOT available without an exact target-format spec. 12d Model interchange
 * is .12da (ASCII) or .4ml (XML); neither schema exists in-repo, and emitting a
 * malformed file would be worse than none.
 * @throws {Error} always.
 */
export function exportTwelveD() {
  throw new Error(
    '12d export not yet available. It needs an exact 12d Model interchange '
    + 'specification (.12da ASCII or .4ml XML schema) — what entities/attributes a '
    + '12d import expects for a rainfall/catchment dataset. No such spec exists in '
    + 'the repo, and a guessed format would silently corrupt a downstream model. '
    + 'Recorded as a Phase-E prerequisite (docs/05): supply the .12da/.4ml target '
    + 'schema + a sample file that imports cleanly into 12d.'
  );
}

/**
 * DRAINS — NOT available without the DRAINS import schema. DRAINS consumes rainfall
 * as .ts1/.ifd-style time series or a documented exchange; the exact field layout
 * is not in-repo.
 * @throws {Error} always.
 */
export function exportDrains() {
  throw new Error(
    'DRAINS export not yet available. It needs the exact DRAINS rainfall/time-series '
    + 'import schema (e.g. the .ts1 / rainfall-data exchange field layout). No such '
    + 'spec exists in the repo. Recorded as a Phase-E prerequisite (docs/05): supply '
    + 'the DRAINS import schema + a sample file that imports cleanly.'
  );
}

/**
 * Geospatial raster (GeoTIFF) — NOT available client-side without a GeoTIFF encoder
 * and the actual raster grid bytes. Overlay metadata exists; the image is not
 * exported. Listed greenfield in docs/02 §10.6.
 * @throws {Error} always.
 */
export function exportRasterGeo() {
  throw new Error(
    'Geospatial raster (GeoTIFF) export not yet available. It needs a client-side '
    + 'GeoTIFF encoder (e.g. geotiff.js) added from a CDN (a `script-src` CSP '
    + 'change, not made) AND the source raster grid values from the window result. '
    + 'The overlay PNG metadata is recorded in the footprint but the georeferenced '
    + 'raster is not yet emitted. Recorded as a Phase-E prerequisite (docs/05).'
  );
}

// ── the format registry (UI reads this) ────────────────────────────────────────

/**
 * @typedef {Object} ExportFormat
 * @property {string} id
 * @property {string} label
 * @property {'report'|'tabular'|'geospatial'|'engineering'|'image'} group
 * @property {'working'|'greenfield'|'stub'} status
 * @property {boolean} carriesProvenance
 * @property {string} [note]            shown under the format in the panel
 * @property {(fp:Object, ctx:Object) => any} run   the action (may throw for stubs)
 */

/** @type {ExportFormat[]} */
export const EXPORT_FORMATS = Object.freeze([
  // ── Report ──
  {
    id: 'pdf', label: 'PDF report (council / insurance)', group: 'report',
    status: 'greenfield', carriesProvenance: true,
    note: 'Print-to-PDF from the HTML report (browser “Save as PDF”). No new library, no CSP change.',
    run: (fp, ctx) => exportPdfReport(fp, ctx && ctx.reportOpts),
  },
  {
    id: 'html', label: 'HTML report', group: 'report',
    status: 'greenfield', carriesProvenance: true,
    note: 'Self-contained report: provenance, coverage, confidence, missing frames, methodology, AEP status.',
    run: (fp, ctx) => exportHtmlReport(fp, ctx && ctx.reportOpts),
  },
  // ── Tabular ──
  {
    id: 'csv', label: 'CSV', group: 'tabular',
    status: 'working', carriesProvenance: true,
    note: 'Provenance header + per-frame log (gaps included).',
    run: (fp) => exportCsv(fp),
  },
  {
    id: 'json', label: 'JSON', group: 'tabular',
    status: 'working', carriesProvenance: true,
    note: 'The full footprint — the most complete machine artefact.',
    run: (fp) => exportJson(fp),
  },
  {
    id: 'xlsx', label: 'XLSX', group: 'tabular',
    status: 'stub', carriesProvenance: false,
    note: 'Needs a spreadsheet library (CSP change). CSV interim available.',
    run: (fp, ctx) => exportXlsx(fp, { csvInterim: !!(ctx && ctx.csvInterim) }),
  },
  // ── Geospatial ──
  {
    id: 'geojson', label: 'GeoJSON (polygon)', group: 'geospatial',
    status: 'working', carriesProvenance: true,
    note: 'Catchment polygon + analytical properties + provenance metadata block.',
    run: (fp, ctx) => exportGeoJson(fp, ctx && ctx.geojsonOpts),
  },
  {
    id: 'raster', label: 'Geospatial raster (GeoTIFF)', group: 'geospatial',
    status: 'stub', carriesProvenance: false,
    note: 'Needs a GeoTIFF encoder (CSP change) + raster grid bytes.',
    run: () => exportRasterGeo(),
  },
  // ── Engineering ──
  {
    id: '12d', label: '12d export', group: 'engineering',
    status: 'stub', carriesProvenance: false,
    note: 'Needs an exact .12da/.4ml target-format spec (not in-repo).',
    run: () => exportTwelveD(),
  },
  {
    id: 'drains', label: 'DRAINS export', group: 'engineering',
    status: 'stub', carriesProvenance: false,
    note: 'Needs the DRAINS import schema (not in-repo).',
    run: () => exportDrains(),
  },
  // ── Image ──
  {
    id: 'png', label: 'PNG snapshot', group: 'image',
    status: 'working', carriesProvenance: false,
    note: 'Illustrative screen capture — no embedded provenance (filename only).',
    run: (fp, ctx) => exportPngSnapshot(ctx && ctx.snapshotEl, fp),
  },
]);

/** Group metadata + display order for the panel. */
export const EXPORT_GROUPS = Object.freeze([
  { id: 'report', label: 'Report' },
  { id: 'tabular', label: 'Tabular' },
  { id: 'geospatial', label: 'Geospatial' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'image', label: 'Image' },
]);

/** @param {string} id @returns {ExportFormat|undefined} */
export function getExportFormat(id) {
  return EXPORT_FORMATS.find((f) => f.id === id);
}

/**
 * Whether a format is runnable RIGHT NOW (not just defined). A 'stub' is never
 * runnable; PNG needs html2canvas present.
 * @param {string} id
 * @returns {boolean}
 */
export function isFormatRunnable(id) {
  const f = getExportFormat(id);
  if (!f) return false;
  if (f.status === 'stub') return false;
  if (f.id === 'png') return pngAvailable();
  return true;
}
