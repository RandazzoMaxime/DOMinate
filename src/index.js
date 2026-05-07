// Public API for the HTML→PDF client-side library.
// THIS IS A STUB. The /long-run autonomous loop replaces this with a real implementation
// iteratively, by adding modules under src/dom, src/css, src/layout, src/render, src/core.
//
// Iteration 1 must produce a valid (if blank/minimal) one-page A4 landscape PDF that opens
// in Acrobat. Subsequent iterations add features driven by visual diff against
// reference/source.png.
//
// Until then, this stub returns a 5-byte invalid blob so the loop reports diff=100% but
// the pipeline runs end-to-end.

/**
 * Convert HTML to a PDF byte stream entirely client-side.
 *
 * @param {string|HTMLElement} input - HTML string or root element
 * @param {object} [opts]
 * @param {'A4'|'Letter'} [opts.pageSize='A4']
 * @param {'portrait'|'landscape'} [opts.orientation='portrait']
 * @param {number} [opts.margin=0] - in mm
 * @param {object} [opts.fonts] - optional pre-fetched fonts: { 'Inter': ArrayBuffer, ... }
 * @returns {Promise<Uint8Array>}
 */
export async function htmlToPdf(input, opts = {}) {
  // STUB — returns minimal "%PDF-1.7\n%%EOF" so the pipeline doesn't crash.
  // The first real iteration will replace this.
  const stub = new TextEncoder().encode(
    '%PDF-1.7\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents 4 0 R /Resources << >> >>\nendobj\n' +
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n' +
    'xref\n0 5\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000110 00000 n \n0000000210 00000 n \n' +
    'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n270\n%%EOF\n'
  );
  return stub;
}

// Sub-module placeholder structure — populated by /long-run iterations:
//   src/core/    — pdf.js, encoding.js, primitives.js, fonts/, images/
//   src/css/     — parser.js, selector.js, cascade.js, computed.js
//   src/layout/  — box.js, flow.js, inline.js, flex.js, grid.js, table.js, pagination.js
//   src/render/  — painter.js, text.js, borders.js, backgrounds.js, links.js
//   src/dom/     — parser.js, builder.js
