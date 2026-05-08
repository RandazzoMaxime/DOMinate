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
import { embedJpeg } from './core/images/jpeg.js';

const A4_LANDSCAPE_CSS = { width: 1123, height: 794 };
const A4_PORTRAIT_CSS  = { width: 794,  height: 1123 };

// One-shot fetch of bundled Inter weights (Latin + Greek subsets). Cached.
let _interFontPromise = null;
async function loadInter() {
  if (!_interFontPromise) {
    _interFontPromise = (async () => {
      const fetchOne = (url) => fetch(url).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
      const [w400, w500, w600, w700, w400g, w500g, w600g, w700g] = await Promise.all([
        fetchOne('/assets/fonts/Inter-400.ttf'),
        fetchOne('/assets/fonts/Inter-500.ttf'),
        fetchOne('/assets/fonts/Inter-600.ttf'),
        fetchOne('/assets/fonts/Inter-700.ttf'),
        fetchOne('/assets/fonts/Inter-400-greek.ttf'),
        fetchOne('/assets/fonts/Inter-500-greek.ttf'),
        fetchOne('/assets/fonts/Inter-600-greek.ttf'),
        fetchOne('/assets/fonts/Inter-700-greek.ttf'),
      ]);
      return {
        latin: { 400: w400, 500: w500, 600: w600, 700: w700 },
        greek: { 400: w400g, 500: w500g, 600: w600g, 700: w700g },
      };
    })();
  }
  return _interFontPromise;
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

  // Embed Inter weights (Latin + Greek subsets) when bundled. Falls back to Helvetica.
  const inters = await loadInter();
  /** @type {*} */
  let fontMap;
  if (inters && inters.latin && inters.latin[400]) {
    const embed = (b, name) => b ? embedTrueTypeFont(doc, b, name) : null;
    const [r400, r500, r600, r700] = await Promise.all([
      embed(inters.latin[400], 'Inter-Regular'),
      embed(inters.latin[500], 'Inter-Medium'),
      embed(inters.latin[600], 'Inter-SemiBold'),
      embed(inters.latin[700], 'Inter-Bold'),
    ]);
    const [g400, g500, g600, g700] = await Promise.all([
      embed(inters.greek[400], 'Inter-Regular-Greek'),
      embed(inters.greek[500], 'Inter-Medium-Greek'),
      embed(inters.greek[600], 'Inter-SemiBold-Greek'),
      embed(inters.greek[700], 'Inter-Bold-Greek'),
    ]);
    fontMap = {
      regular:    r400, medium: r500 || r400, semibold: r600 || r400, bold: r700 || r600 || r400,
      oblique:    r400,
      // Per-weight fallbacks for chars missing from Latin (Δ etc.)
      fallbacks: {
        regular:  [g400].filter(Boolean),
        medium:   [g500 || g400].filter(Boolean),
        semibold: [g600 || g400].filter(Boolean),
        bold:     [g700 || g600 || g400].filter(Boolean),
      },
      embedded: true,
    };
  } else {
    fontMap = {
      regular: doc.addStandardFont('Helvetica'),
      bold:    doc.addStandardFont('Helvetica-Bold'),
      oblique: doc.addStandardFont('Helvetica-Oblique'),
      fallbacks: { regular: [], bold: [], medium: [], semibold: [] },
      embedded: false,
    };
  }

  // Pre-fetch image boxes and embed each one. We attach the embedded XObject handle
  // directly onto the box so the (sync) painter can just `drawImage`.
  for (const b of boxes) {
    if (b.kind !== 'image' || !b.src) continue;
    try {
      const r = await fetch(b.src, { mode: 'cors' });
      if (!r.ok) continue;
      const u8 = new Uint8Array(await r.arrayBuffer());
      // Detect JPEG via SOI marker; skip other formats for now (PNG decode needs more work).
      if (u8[0] === 0xFF && u8[1] === 0xD8) {
        b.embedded = embedJpeg(doc, u8);
      }
    } catch { /* offline or CORS — skip */ }
  }

  const page = doc.addPage();
  paint(doc, fontMap, page, boxes);

  return doc.toBytes();
}
