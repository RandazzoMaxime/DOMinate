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
import { embedTrueTypeFont } from './core/fonts/embed.js';

const A4_LANDSCAPE_CSS = { width: 1123, height: 794 };
const A4_PORTRAIT_CSS  = { width: 794,  height: 1123 };

// One-shot fetch of the bundled Inter TTF. Cached across calls.
let _interFontBytesPromise = null;
async function loadInter() {
  if (!_interFontBytesPromise) {
    _interFontBytesPromise = fetch('/assets/fonts/Inter-Variable.ttf')
      .then(r => r.ok ? r.arrayBuffer() : null)
      .catch(() => null);
  }
  return _interFontBytesPromise;
}

/**
 * @param {string|HTMLElement} input
 * @param {object} [opts]
 * @param {{width: number, height: number}} [opts.viewport]  CSS px — explicit override
 * @param {'A4'} [opts.pageSize]
 * @param {'portrait'|'landscape'} [opts.orientation]
 * @returns {Promise<Uint8Array>}
 */
export async function htmlToPdf(input, opts = {}) {
  // Resolve viewport in CSS pixels. Explicit viewport wins; otherwise pageSize+orientation
  // map to A4 dimensions. If nothing is provided, default to A4 landscape (the original
  // reference fixture).
  let viewport = opts.viewport;
  if (!viewport) {
    if (opts.pageSize === 'A4' && opts.orientation === 'landscape') viewport = A4_LANDSCAPE_CSS;
    else if (opts.pageSize === 'A4' && opts.orientation === 'portrait') viewport = A4_PORTRAIT_CSS;
    else viewport = A4_LANDSCAPE_CSS;
  }

  // PDF user units = CSS px × 0.75 (96 DPI → 72 DPI).
  const doc = new PdfDocument({
    pageWidthPdfUnits:  viewport.width  * 0.75,
    pageHeightPdfUnits: viewport.height * 0.75,
  });

  const html = typeof input === 'string' ? input : input.outerHTML;
  const { boxes } = await layout(html, viewport);

  // Try to embed Inter TTF. If the fetch fails (e.g. file missing in this build),
  // fall back to Helvetica standard fonts.
  const interBytes = await loadInter();
  /** @type {{regular, bold, oblique}} */
  let fontMap;
  if (interBytes) {
    const inter = await embedTrueTypeFont(doc, interBytes, 'Inter');
    fontMap = {
      regular: inter,
      bold:    inter,    // single variable font instance (we don't yet expose multi-weight)
      oblique: inter,
      embedded: true,
    };
  } else {
    fontMap = {
      regular: doc.addStandardFont('Helvetica'),
      bold:    doc.addStandardFont('Helvetica-Bold'),
      oblique: doc.addStandardFont('Helvetica-Oblique'),
      embedded: false,
    };
  }

  const page = doc.addPage();
  paint(doc, fontMap, page, boxes);

  return doc.toBytes();
}
