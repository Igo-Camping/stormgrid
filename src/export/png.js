// png.js — PNG snapshot exporter (SALVAGED + FIXED).
//
// docs/01 §3.6 audited the legacy PNG exporter as "partial — html2canvas of DOM;
// documented SVG fallback does NOT exist (throws)". The legacy docstring claimed:
//   "Uses html2canvas if available; otherwise falls back to a same-origin SVG-only
//    render of the map polygons (no basemap tiles)."
// That fallback was never implemented — the function simply threw. THIS REWRITE
// REMOVES THE LIE: there is no SVG fallback, and the absence of html2canvas is
// reported as a clear, actionable error rather than a half-promised feature.
//
// html2canvas is already loaded by index.html via the CSP-allowed CDN
// (cdnjs.cloudflare.com, script-src). No CSP change is needed for PNG.
//
// HONESTY (brief): the PNG carries NO embedded provenance — only the filename
// encodes the location/duration/timestamp (via suggestExportFilename). A PNG is
// therefore ILLUSTRATIVE — a picture of the screen — and is NOT a defensible
// deliverable. The JSON/CSV/GeoJSON/HTML report are the provenance-bearing
// artefacts; the panel labels the PNG accordingly.

import { triggerDownload } from './download.js';
import { suggestExportFilename } from './footprint.js';

/**
 * True if html2canvas is available on the global (loaded by index.html).
 * @returns {boolean}
 */
export function pngAvailable() {
  return typeof window !== 'undefined' && typeof window.html2canvas === 'function';
}

/**
 * Capture a PNG snapshot of a DOM element via html2canvas and download it.
 *
 * The PNG embeds NO provenance — the filename (location, duration, timestamp) is
 * the only metadata. It is an illustrative screen capture, not a defensible export.
 *
 * @param {HTMLElement} targetEl the element to rasterise (e.g. the map + legend region)
 * @param {Object} fp the footprint (used only for the filename)
 * @returns {Promise<void>}
 * @throws {Error} a clear message if targetEl is missing or html2canvas is absent.
 */
export async function exportPngSnapshot(targetEl, fp) {
  if (!targetEl) throw new Error('PNG snapshot: target element is missing.');
  if (!pngAvailable()) {
    // No phantom fallback. State plainly what is missing and why.
    throw new Error(
      'PNG snapshot unavailable: html2canvas is not loaded. It is provided by '
      + 'index.html via the CSP-allowed CDN; if it failed to load there is no '
      + 'same-origin fallback (the legacy SVG fallback never existed and has been '
      + 'removed). Reload the page or check the html2canvas <script> tag.'
    );
  }

  const html2canvas = window.html2canvas;
  const canvas = await html2canvas(targetEl, {
    backgroundColor: '#ffffff',
    useCORS: true,
    logging: false,
    scale: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
  });

  await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('PNG snapshot: canvas.toBlob returned null.'));
        return;
      }
      triggerDownload(blob, suggestExportFilename(fp, 'png'));
      resolve();
    }, 'image/png');
  });
}
