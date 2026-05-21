// json.js — JSON exporter (SALVAGED + ported, WORKING).
//
// docs/01 §3.6: JSON "works today — full buildEventFootprint; carries provenance:
// yes (everything)". This is the trivial, faithful serialisation of the footprint:
// the footprint object IS the export. Because footprint.js copies source / coverage
// / confidence / calibration / warnings out of the validated RainfallWindowResult
// unchanged, and reports gaps as null, the JSON is the most complete and most
// defensible machine artefact — every number traces to its origin.
//
// Pure assembly + a Blob download. No new science.

import { triggerDownload } from './download.js';
import { suggestExportFilename } from './footprint.js';

/** The JSON text for a footprint (pure; testable). */
export function buildJson(fp) {
  return JSON.stringify(fp, null, 2);
}

/** Build the JSON and trigger a browser download. */
export function exportJson(fp) {
  const blob = new Blob([buildJson(fp)], { type: 'application/json' });
  triggerDownload(blob, suggestExportFilename(fp, 'json'));
}
