// Public API for the HTML→PDF client-side library.
//
// Iter 2 — DOM walker (browser-as-layout-engine via hidden iframe) + painter.
// Emits real text, real boxes, real link annotations as vector PDF.
//
// Architectural note: see CLAUDE.md "browser-as-layout-engine". We use the host
// browser's CSS engine to compute element positions, then emit PDF ops. This
// preserves the "from scratch, no third-party PDF library" rule while making
// Playwright-quality output achievable in finite engineering time.

import { PdfDocument } from './core/pdf.js';
import { layout } from './dom/walker.js';
import { paint } from './render/painter.js';

const A4_LANDSCAPE_CSS = { width: 1123, height: 794 };

/**
 * @param {string|HTMLElement} input
 * @param {object} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function htmlToPdf(input, opts = {}) {
  const doc = new PdfDocument({
    pageSize: opts.pageSize ?? 'A4',
    orientation: opts.orientation ?? 'portrait',
  });

  const html = typeof input === 'string' ? input : input.outerHTML;

  // 1. Lay out the HTML in a hidden iframe at exact A4 landscape CSS px size.
  const viewport = (opts.orientation === 'landscape')
    ? A4_LANDSCAPE_CSS
    : { width: 794, height: 1123 };
  const { boxes } = await layout(html, viewport);

  // 2. Allocate the standard fonts the painter falls back on (until iter 7's font embed).
  const fontMap = {
    regular: doc.addStandardFont('Helvetica'),
    bold:    doc.addStandardFont('Helvetica-Bold'),
    oblique: doc.addStandardFont('Helvetica-Oblique'),
  };

  // 3. Add a single page and paint.
  const page = doc.addPage();
  paint(doc, fontMap, page, boxes);

  return doc.toBytes();
}
