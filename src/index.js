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
import { parseGsubLigatures } from './core/fonts/sfnt.js';
import { embedJpeg } from './core/images/jpeg.js';
import { embedPng } from './core/images/png.js';

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
      const [jbMono, jbMono500, jbMono700] = await Promise.all([
        fetchOne('/assets/fonts/JetBrainsMono-Regular.ttf'),
        fetchOne('/assets/fonts/JetBrainsMono-500.ttf'),
        fetchOne('/assets/fonts/JetBrainsMono-700.ttf'),
      ]);
    return {
      latin: { 400: w400, 500: w500, 600: w600, 700: w700 },
      greek: { 400: w400g, 500: w500g, 600: w600g, 700: w700g },
      jbMono, jbMono500, jbMono700,
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
  const { boxes, contentHeight } = await layout(html, viewport);

  // Scan the render boxes to find which faces the document ACTUALLY needs, so we
  // only embed those (a full embed of all 11 bundled faces costs ~450 KB per PDF).
  // Inter-400 is always embedded: it anchors svg-text and every fallback chain.
  const bucketOf = (w) => (w >= 700 ? 700 : w >= 600 ? 600 : w >= 500 ? 500 : 400);
  const needWeights = new Set([400]);
  const needGreek = new Set();
  const needMono = new Set();
  let needManrope = false;
  for (const b of boxes) {
    if (b.kind !== 'text' || !b.text) continue;
    const w = bucketOf(b.style.resolvedWeight || parseInt(b.style.fontWeight, 10) || 400);
    needWeights.add(w);
    const fam = (b.style.fontFamily || '').toLowerCase();
    if (/^['"]?(jetbrains mono|consolas|monospace)\b/.test(fam)) { needMono.add(w); needMono.add(400); }
    if (/^['"]?manrope\b/.test(fam)) needManrope = true;
    // Anything beyond Latin-1 + punctuation may live in the Greek subset fallback.
    if (/[Ͱ-⿿]/.test(b.text)) needGreek.add(w);
  }

  // Embed Inter weights (Latin + Greek subsets) when bundled. Falls back to Helvetica.
  const inters = await loadInter();
  /** @type {*} */
  let fontMap;
  if (inters && inters.latin && inters.latin[400]) {
    const embed = (b, name) => b ? embedTrueTypeFont(doc, b, name) : null;
    const [r400, r500, r600, r700] = await Promise.all([
      embed(inters.latin[400], 'Inter-Regular'),
      embed(needWeights.has(500) ? inters.latin[500] : null, 'Inter-Medium'),
      embed(needWeights.has(600) ? inters.latin[600] : null, 'Inter-SemiBold'),
      embed(needWeights.has(700) ? inters.latin[700] : null, 'Inter-Bold'),
    ]);
    const [g400, g500, g600, g700] = await Promise.all([
      embed(needGreek.has(400) ? inters.greek[400] : null, 'Inter-Regular-Greek'),
      embed(needGreek.has(500) ? inters.greek[500] : null, 'Inter-Medium-Greek'),
      embed(needGreek.has(600) ? inters.greek[600] : null, 'Inter-SemiBold-Greek'),
      embed(needGreek.has(700) ? inters.greek[700] : null, 'Inter-Bold-Greek'),
    ]);
    // Helvetica/Arial alternates use the PDF base-14 Helvetica to match the typical
    // reference rendering (which falls back to Arial when no @font-face Inter is set).
    const helv = doc.addStandardFont('Helvetica');
    const helvBold = doc.addStandardFont('Helvetica-Bold');
    // Monospace alternate (for font-family: 'JetBrains Mono', monospace, etc).
    const jbMonoFont = needMono.size && inters.jbMono ? await embedTrueTypeFont(doc, inters.jbMono, 'JetBrainsMono-Regular') : null;
    const jbMono500 = needMono.has(500) && inters.jbMono500 ? await embedTrueTypeFont(doc, inters.jbMono500, 'JetBrainsMono-Medium') : null;
    const jbMono700 = (needMono.has(700) || needMono.has(600)) && inters.jbMono700 ? await embedTrueTypeFont(doc, inters.jbMono700, 'JetBrainsMono-Bold') : null;
    const courier = doc.addStandardFont('Courier');
    const courierBold = doc.addStandardFont('Courier-Bold');
    // Manrope (display family used by the wizard fixture) — weights 700/800.
    let man700 = null, man800 = null;
    if (needManrope) {
      const [b700, b800] = await Promise.all([
        fetch('/assets/fonts/Manrope-700.ttf').then(r => r.ok ? r.arrayBuffer() : null).catch(() => null),
        fetch('/assets/fonts/Manrope-800.ttf').then(r => r.ok ? r.arrayBuffer() : null).catch(() => null),
      ]);
      man700 = b700 ? await embedTrueTypeFont(doc, b700, 'Manrope-Bold') : null;
      man800 = b800 ? await embedTrueTypeFont(doc, b800, 'Manrope-ExtraBold') : null;
    }
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
      // Alternate font families. Painter uses these when computed fontFamily starts
      // with the matching name.
      alternates: {
        helvetica:        { regular: helv,           bold: helvBold,    semibold: helvBold,    medium: helv },
        arial:            { regular: helv,           bold: helvBold,    semibold: helvBold,    medium: helv },
        'jetbrains mono': jbMonoFont
          ? { regular: jbMonoFont, medium: jbMono500 || jbMonoFont, semibold: jbMono700 || jbMono500 || jbMonoFont, bold: jbMono700 || jbMonoFont }
          : { regular: courier,    bold: courierBold, semibold: courierBold, medium: courier },
        consolas:         { regular: jbMonoFont || courier, bold: jbMono700 || jbMonoFont || courierBold, semibold: jbMono700 || jbMonoFont || courierBold, medium: jbMono500 || jbMonoFont || courier },
        monospace:        { regular: jbMonoFont || courier, bold: jbMono700 || jbMonoFont || courierBold, semibold: jbMono700 || jbMonoFont || courierBold, medium: jbMono500 || jbMonoFont || courier },
        ...(man700 ? { manrope: { regular: man700, medium: man700, semibold: man700, bold: man700, black: man800 || man700 } } : {}),
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
  // directly onto the box so the (sync) painter can just `drawImage`. Also resolves
  // CSS background-image: url(...) on plain boxes.
  const imageCache = new Map();  // url → embedded handle (or null after a failure)
  const fetchAndEmbed = async (url) => {
    if (imageCache.has(url)) return imageCache.get(url);
    let handle = null;
    try {
      const r = await fetch(url, { mode: 'cors' });
      if (r.ok) {
        const u8 = new Uint8Array(await r.arrayBuffer());
        if (u8[0] === 0xFF && u8[1] === 0xD8) handle = embedJpeg(doc, u8);
        else if (u8[0] === 0x89 && u8[1] === 0x50) handle = await embedPng(doc, u8);
      }
    } catch { /* offline, CORS, or unsupported encoding — skip */ }
    imageCache.set(url, handle);
    return handle;
  };
  for (const b of boxes) {
    if (b.kind === 'image' && b.src) {
      b.embedded = await fetchAndEmbed(b.src);
    } else if (b.kind === 'box' && b.style.backgroundImage && b.style.backgroundImage.startsWith('url(')) {
      const m = /^url\(["']?([^"')]+)["']?\)$/.exec(b.style.backgroundImage.trim());
      if (m) b.bgEmbedded = await fetchAndEmbed(m[1]);
    }
  }

  // Icon fonts (Material Symbols): glyph names resolve through GSUB ligatures.
  // Embedded lazily — only when the page actually contains icon-font runs.
  if (boxes.some(b => b.iconFont)) {
    try {
      const r = await fetch('/assets/fonts/MaterialSymbolsOutlined.ttf');
      if (r.ok) {
        const iconBytes = new Uint8Array(await r.arrayBuffer());
        fontMap.icons = await embedTrueTypeFont(doc, iconBytes, 'MaterialSymbolsOutlined');
        fontMap.icons.ligatures = parseGsubLigatures(iconBytes);
      }
    } catch { /* offline — icon runs stay blank */ }
  }

  // Pagination: content taller than one viewport is sliced into pages. Cut points
  // avoid splitting text lines: when a text/bullet box straddles the candidate cut,
  // the cut moves UP to that line's top so the whole line lands on the next page
  // (leaving whitespace at the bottom, like real pagination). A safety floor of
  // half a page keeps a giant unbreakable element from stalling progress.
  const pageH = viewport.height;
  const cuts = [0];
  while (cuts[cuts.length - 1] + pageH < contentHeight - 1 && cuts.length < 200) {
    const last = cuts[cuts.length - 1];
    let cut = last + pageH;
    let lowest = cut;
    // Pushing one line up can make another line straddle the new cut — iterate
    // to a fixed point (bounded by the box count).
    let changed = true;
    while (changed) {
      changed = false;
      for (const b of boxes) {
        if (b.kind !== 'text' && b.kind !== 'bullet') continue;
        if (b.y < lowest && b.y + b.h > lowest && b.h < pageH / 2) { lowest = b.y; changed = true; }
      }
    }
    if (lowest > last + pageH / 2) cut = lowest;
    cuts.push(cut);
  }
  for (let k = 0; k < cuts.length; k++) {
    const page = doc.addPage();
    const top = cuts[k];
    const span = (k + 1 < cuts.length ? cuts[k + 1] : contentHeight) - top;
    // Clip the page to its band so content pushed to the next page never bleeds
    // into this one's bottom whitespace (PDF units, y-up).
    if (span < pageH - 0.5) {
      page._push(`0 ${(pageH - span) * 0.75} ${viewport.width * 0.75} ${span * 0.75} re W n\n`);
    }
    const pageBoxes = boxes
      .filter(b => boxIntersectsBand(b, top, span))
      .map(b => (top === 0 ? b : shiftBoxForPage(b, top)));
    paint(doc, fontMap, page, pageBoxes);
  }

  return doc.toBytes();
}

/** Does the box (or its decoration) touch the band [top, top+H)? */
function boxIntersectsBand(b, top, H) {
  // Shapes whose geometry lives outside x/y/w/h (svg endpoints, ellipse centers)
  // always pass — the MediaBox clips strays.
  if (b.kind === 'svg-line' || b.kind === 'svg-path' || b.kind === 'svg-ellipse') return true;
  const y0 = b.y - top;
  const h = b.h || 0;
  return y0 + h > -300 && y0 < H + 300;  // margin for far-reaching shadows/outlines
}

/** Shallow-clone a render box shifted up by `dy` CSS px (page k slicing). */
function shiftBoxForPage(b, dy) {
  const nb = { ...b, y: b.y - dy };
  if (b.y1 !== undefined) { nb.y1 = b.y1 - dy; nb.y2 = b.y2 - dy; }
  if (b.cy !== undefined) nb.cy = b.cy - dy;
  if (b.baselineY !== undefined) nb.baselineY = b.baselineY - dy;
  if (b.segments) nb.segments = b.segments.map(s => {
    const ns = { ...s };
    if (ns.y !== undefined) ns.y -= dy;
    if (ns.y1 !== undefined) ns.y1 -= dy;
    if (ns.y2 !== undefined) ns.y2 -= dy;
    return ns;
  });
  if (b.clips) nb.clips = b.clips.map(c => ({ ...c, y: c.y - dy }));
  if (b.tfms) nb.tfms = b.tfms.map(t => ({ ...t, oy: t.oy - dy }));
  return nb;
}
