// download.js — the one client-side Blob-download helper for the export layer.
//
// CSP-locked static site, no build step (docs/03, DECISIONS B-006). All real
// exports are produced as a Blob in the browser and saved via an <a download>.
// There is no server round-trip and no new origin contacted, so this stays
// inside the existing CSP (default-src 'self').
//
// Single responsibility: turn a Blob + filename into a user download. Every
// exporter that emits a file routes through here so the teardown is consistent.

/**
 * Trigger a browser download of a Blob.
 * @param {Blob} blob
 * @param {string} filename
 */
export function triggerDownload(blob, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw new Error('triggerDownload: a browser environment with URL.createObjectURL is required.');
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  // Defer revocation so the click has committed in all browsers.
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
    URL.revokeObjectURL(url);
  }, 250);
}

/** HTML-escape a string for safe interpolation into report markup. */
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
