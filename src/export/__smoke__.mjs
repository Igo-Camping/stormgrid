// __smoke__.mjs — Export-layer smoke test (pure paths only; no DOM/browser).
// Run: node src/export/__smoke__.mjs   (from project root)
// Not part of the shipped layer's runtime; a local verification harness matching
// the house pattern (src/adapters/__smoke__.mjs etc).

import { sourceDescriptor, coverage, frameLogEntry, confidence, validateWindowResult } from '../core/sourceAdapter.js';
import { arealRainfall } from '../core/rainfallTypes.js';
import { buildEventFootprint, summariseFootprint, suggestExportFilename } from './footprint.js';
import { buildCsv } from './csv.js';
import { buildJson } from './json.js';
import { buildGeoJson } from './geojson.js';
import { buildHtmlReport } from './htmlReport.js';
import { buildPrintableReport, pdfViaLibraryStub } from './pdfReport.js';
import { exportXlsx, exportTwelveD, exportDrains, exportRasterGeo, EXPORT_FORMATS, isFormatRunnable } from './exporters.js';

const assert = (c, m) => { if (!c) { console.error('ASSERT FAIL:', m); process.exitCode = 1; } };

const wr = {
  source: sourceDescriptor({ id: 'lizard-archive', label: 'Lizard Archive', kind: 'precomputed', buildVersion: 'v2', lastBuilt: '2026-05-04T00:24:06Z', unit: 'mm_per_3h', isPlaceholder: true }),
  catchmentMean: arealRainfall(83.4),
  stats: { maxCell: arealRainfall(120.1), minCell: arealRainfall(40.0), meanCell: arealRainfall(80.0), areaAbove: [], spatialCv: 0.31 },
  coverage: coverage({ pct: 87.5, framesUsed: 7, framesExpected: 8, framesMissing: 1 }),
  frameLog: [
    frameLogEntry({ iso: '2026-05-01T00:00:00Z', status: 'valid', meanMm: 10 }),
    frameLogEntry({ iso: '2026-05-01T03:00:00Z', status: 'valid', meanMm: 12 }),
    frameLogEntry({ iso: '2026-05-01T06:00:00Z', status: 'missing', meanMm: null }),
    frameLogEntry({ iso: '2026-05-01T09:00:00Z', status: 'valid', meanMm: 8 }),
    frameLogEntry({ iso: '2026-05-01T12:00:00Z', status: 'valid', meanMm: 9 }),
    frameLogEntry({ iso: '2026-05-01T15:00:00Z', status: 'valid', meanMm: 11 }),
    frameLogEntry({ iso: '2026-05-01T18:00:00Z', status: 'valid', meanMm: 7 }),
    frameLogEntry({ iso: '2026-05-01T21:00:00Z', status: 'valid', meanMm: 6 }),
  ],
  confidence: confidence('moderate', ['1 frame missing', 'placeholder ARF']),
  durationStats: [
    { durationKey: '24h', maxAccumulated: arealRainfall(83.4), windowStart: '2026-05-01T00:00:00Z', windowEnd: '2026-05-02T00:00:00Z' },
    { durationKey: '12h', maxAccumulated: arealRainfall(60.0) },
  ],
  calibration: { applied: false, method: null, version: null, rawPreserved: true },
  warnings: ['placeholder-arf'],
};
validateWindowResult(wr);

const fp = buildEventFootprint({
  windowResult: wr,
  location: { catchmentId: 'C12' },
  timeframe: { kind: 'window', windowKey: '2026-05-01', endIso: '2026-05-02T00:00:00Z' },
  duration: '24h', calibration: 'raw', colourMode: 'rainfall', phase: 'DEGRADED',
  locationMeta: { is_authoritative: false, area_m2: 7816000, area_ha: 781.6, centroid_lon: 151.2, centroid_lat: -33.8, source: 'lizard_raster_export', label: 'Test Creek' },
  generatedAt: '2026-05-21T03:00:00Z',
});

assert(fp.provenance.isPlaceholder === true, 'placeholder flag travels');
assert(fp.defensible === false, 'placeholder => not defensible');
assert(fp.isSynthetic === true, 'placeholder => synthetic');
assert(fp.coverage.framesMissing === 1, 'framesMissing travels');
assert(fp.missingFrames.length === 1 && fp.missingFrames[0] === '2026-05-01T06:00:00Z', 'missing frame iso captured');
assert(fp.frameLog.find((f) => f.status === 'missing').meanMm === null, 'missing frame meanMm null (never 0)');
assert(fp.stats.catchmentMeanMm === 83.4, 'areal stat read out');
assert(fp.aep.gated === true && fp.aep.engineeringGradeAllowed === false, 'AEP gated under placeholder');
assert(fp.context.location.isAuthoritative === false, 'non-authoritative boundary (P-3) labelled');
assert(fp.calibration.rawPreserved === true, 'calibration reversible flag');

const sum = summariseFootprint(fp);
assert(sum.coveragePct === 87.5 && sum.framesMissing === 1, 'summary coverage');

const csv = buildCsv(fp);
assert(csv.includes('# source_is_placeholder,true'), 'csv placeholder header');
assert(csv.includes('# frames_missing,1'), 'csv frames_missing');
assert(csv.includes('2026-05-01T06:00:00Z,missing,\n'), 'csv missing frame mean blank');
assert(csv.includes('frame_iso,status,mean_mm'), 'csv header row');

const j = JSON.parse(buildJson(fp));
assert(j.provenance.isPlaceholder === true && j.schemaVersion === 'stormgrid.event_footprint.v2', 'json shape');

const fakeGj = { type: 'FeatureCollection', metadata: { is_authoritative: false, source: 'lizard_raster_export', version: 'v2' }, features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[151, -33], [151.1, -33], [151.1, -33.1], [151, -33]]] }, properties: { catchment_id: 'C12', area_ha: 781.6, is_authoritative: false } }] };
const fakeFetch = async () => ({ ok: true, status: 200, json: async () => fakeGj });
const gj = await buildGeoJson(fp, { fetchImpl: fakeFetch });
assert(gj.features.length === 1 && gj.features[0].geometry.type === 'Polygon', 'geojson polygon attached');
assert(gj.features[0].properties.stormgrid.provenance.isPlaceholder === true, 'geojson props carry provenance');
assert(gj.metadata.catchment_dataset.is_authoritative === false, 'geojson carries dataset is_authoritative');

const html = buildHtmlReport(fp, { title: 'Smoke Report' });
assert(html.includes('<!doctype html>') && html.includes('Smoke Report'), 'html doc');
assert(html.includes('not an engineering-defensible deliverable'), 'html not-defensible banner');
assert(html.includes('AEP output suppressed') || html.includes('placeholder'), 'html AEP gate note');
assert(html.includes('non-authoritative'), 'html P-3 boundary note');
assert(html.includes('missing'), 'html missing-frames table');

const pr = buildPrintableReport(fp, {});
assert(pr.includes('@media print'), 'printable adds print css');

const fn = suggestExportFilename(fp, 'csv');
assert(fn === 'stormgrid_C12_24h_20260521T030000Z.csv', 'filename: ' + fn);

const cases = [
  [() => exportTwelveD(), '12d'],
  [() => exportDrains(), 'DRAINS'],
  [() => exportRasterGeo(), 'raster'],
  [() => pdfViaLibraryStub(), 'pdf-lib'],
  [() => exportXlsx(fp), 'xlsx'],
];
for (const [run, label] of cases) {
  let threw = false; let msg = '';
  try { run(); } catch (e) { threw = true; msg = e.message; }
  assert(threw, label + ' stub must throw');
  assert(/not yet available|not enabled/.test(msg), label + ' stub message: ' + msg.slice(0, 40));
}

const working = EXPORT_FORMATS.filter((f) => f.status === 'working').map((f) => f.id);
const green = EXPORT_FORMATS.filter((f) => f.status === 'greenfield').map((f) => f.id);
const stub = EXPORT_FORMATS.filter((f) => f.status === 'stub').map((f) => f.id);
console.log('working:', working.join(','));
console.log('greenfield:', green.join(','));
console.log('stub:', stub.join(','));
assert(isFormatRunnable('12d') === false, '12d not runnable');
assert(isFormatRunnable('csv') === true, 'csv runnable');

// Empty / no-result footprint must not throw and must be honestly empty.
const empty = buildEventFootprint({ windowResult: null, phase: 'EMPTY' });
assert(empty.hasResult === false && empty.defensible === false, 'empty footprint honest');
assert(buildCsv(empty).includes('frame_iso,status,mean_mm'), 'empty csv still has header');
assert(buildHtmlReport(empty).includes('no data'), 'empty html says no data');

console.log(process.exitCode ? 'SMOKE: FAILURES ABOVE' : 'SMOKE: ALL PASS');
