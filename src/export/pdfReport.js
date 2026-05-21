// pdfReport.js — PDF report via browser print (GREENFIELD, no new library).
//
// docs/02 §10.6: "PDF report (council / insurance)" [greenfield].
//
// DECISION (recorded for DECISIONS.md, E-series): the PDF approach is a PRINT
// STYLESHEET + window.print() on the self-contained HTML report (htmlReport.js),
// letting the user "Save as PDF" from the browser's print dialog. This needs:
//   - NO new CDN library (no jsPDF, no pdfmake)
//   - NO CSP change
// It is fully client-side and inside the existing CSP. The trade-off is that the
// exact PDF rendering (margins, page breaks, headers/footers) is the browser's,
// not ours — acceptable for a council/insurance report whose CONTENT (provenance,
// coverage, limitations) is what matters, not pixel-perfect typesetting.
//
// Implementation: open the HTML report in a print-ready view (a same-origin Blob
// URL opened in a new tab, or a hidden same-origin iframe) and invoke print().
// The report document already carries an inline print-friendly stylesheet; this
// module adds an @media print block and triggers the dialog.
//
// ALTERNATIVE NOT TAKEN: a JS PDF library (jsPDF/pdfmake) would give us byte-exact
// PDFs but requires adding a CDN script and a `script-src` CSP entry. That is a
// documented CSP change, NOT made here. If chosen later, see pdfViaLibraryStub().

import { buildHtmlReport } from './htmlReport.js';

const PRINT_CSS = `
@media print {
  @page { margin: 18mm; }
  body { padding: 0; max-width: none; }
  .banner { break-inside: avoid; }
  h2 { break-after: avoid; }
  table, dl.grid { break-inside: avoid; }
  footer { position: fixed; bottom: 0; }
}`;

/**
 * Build the print-ready HTML report (HTML report + an @media print block).
 * Pure; testable without a browser.
 * @param {Object} fp footprint
 * @param {Object} [opts] passed through to buildHtmlReport (title, mapSnapshotDataUrl)
 * @returns {string} a full HTML document with print styles
 */
export function buildPrintableReport(fp, opts = {}) {
  const html = buildHtmlReport(fp, { ...opts, forPrint: true });
  // Inject the print stylesheet just before </head> (the report already has one
  // <style> block; we append a print-specific one).
  return html.replace('</head>', `<style>${PRINT_CSS}</style>\n</head>`);
}

/**
 * Open the report in a print-ready view and invoke the browser's print dialog
 * (the user chooses "Save as PDF"). Same-origin Blob URL — inside CSP, no library.
 *
 * @param {Object} fp footprint
 * @param {Object} [opts]
 * @param {string} [opts.title]
 * @param {string} [opts.mapSnapshotDataUrl]
 * @param {'tab'|'iframe'} [opts.mode='iframe'] how to host the print view
 * @returns {Promise<void>}
 */
export async function exportPdfReport(fp, opts = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('PDF report: a browser environment is required (uses window.print).');
  }
  const html = buildPrintableReport(fp, opts);
  const mode = opts.mode || 'iframe';

  if (mode === 'tab') {
    // Open in a new same-origin tab via Blob URL; user prints/saves as PDF.
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'noopener');
    if (!win) {
      URL.revokeObjectURL(url);
      throw new Error('PDF report: popup blocked. Allow popups, or use the HTML report and print it manually.');
    }
    // The opened document calls print() itself once loaded would require inline
    // script in the report (CSP forbids cross-doc reach without a handle when using
    // noopener). Revoke shortly after; the user prints from the tab's UI.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }

  // Default: hidden same-origin iframe we control, so we can call print() directly.
  await printViaIframe(html);
}

/** Render the HTML into a hidden iframe and invoke its print dialog. */
function printViaIframe(html) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);

    const cleanup = () => {
      setTimeout(() => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 1000);
    };

    iframe.onload = () => {
      try {
        const win = iframe.contentWindow;
        win.focus();
        win.print();
        resolve();
      } catch (e) {
        reject(new Error(`PDF report: print failed (${e && e.message ? e.message : e}).`));
      } finally {
        cleanup();
      }
    };

    // Write via srcdoc (same-origin, no Blob URL needed, stays inside CSP).
    iframe.srcdoc = html;
  });
}

/**
 * Documentation stub for the NOT-TAKEN alternative: a JS PDF library.
 * This is intentionally inert. It records the required CSP/CDN change so a future
 * decision is explicit, and throws if called so it can never silently no-op.
 * @throws {Error} always — describes the prerequisite.
 */
export function pdfViaLibraryStub() {
  throw new Error(
    'PDF-via-library is not enabled. It would require adding a JS PDF library '
    + '(e.g. jsPDF) from a CDN and a matching `script-src` entry in the index.html '
    + 'Content-Security-Policy. That CSP change is NOT made; the supported PDF path '
    + 'is print-to-PDF via exportPdfReport(). See DECISIONS.md (E-series).'
  );
}
