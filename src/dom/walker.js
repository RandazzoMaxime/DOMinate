// DOM walker: lay out a complete HTML document in a hidden, fixed-size iframe and
// extract every element's geometry + computed style + text runs.
//
// We use the host browser's layout engine — the same engine that drew the reference
// screenshot — so positions match Chromium's `page.pdf()` exactly when the host is
// Chromium. See the "Architectural decision" section in CLAUDE.md.
//
// Output is a flat list of "render boxes" suitable for the PDF emitter.

/** @typedef {Object} RenderBox
 *  @property {string} kind  'box' | 'text' | 'image' | 'svg' | 'link'
 *  @property {number} x  CSS px from the iframe's top-left
 *  @property {number} y
 *  @property {number} w
 *  @property {number} h
 *  @property {Object} style  selected computed-style values (camelCase keys)
 *  @property {string} [text]      for kind 'text'
 *  @property {string} [tag]       lowercased tagName for diagnostics
 *  @property {string} [href]      for kind 'link'
 *  @property {Element} [el]       reference to the source element (debug)
 */

/**
 * Lay out `html` inside a hidden iframe, return a flat list of render boxes.
 * Resolves only after document.fonts.ready and one rAF — to be sure layout is stable.
 *
 * @param {string} html
 * @param {{ width: number, height: number }} viewport CSS px
 * @returns {Promise<{ boxes: RenderBox[], width: number, height: number }>}
 */
export async function layout(html, { width, height }) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  // Position off-screen but keep it laid out at the real size — CSS sizing rules
  // depend on the *iframe's* viewport, so we set width/height precisely.
  iframe.style.cssText = `
    position: fixed;
    left: -10000px;
    top: 0;
    width: ${width}px;
    height: ${height}px;
    border: 0;
    visibility: hidden;
  `;
  document.body.appendChild(iframe);

  try {
    const idoc = iframe.contentDocument;
    idoc.open();
    idoc.write(html);
    idoc.close();

    // Wait for the iframe's load event (resolves after all <script> and <link> tags have
    // settled — including Tailwind CDN, Google Fonts, etc.). Capped at 4 s so a slow
    // network doesn't hang us forever.
    if (iframe.contentWindow.document.readyState !== 'complete') {
      await Promise.race([
        new Promise(r => iframe.addEventListener('load', r, { once: true })),
        new Promise(r => setTimeout(r, 4000)),
      ]);
    }

    if (idoc.fonts && idoc.fonts.ready) {
      await Promise.race([
        idoc.fonts.ready,
        new Promise(r => setTimeout(r, 3000)),
      ]);
    }
    // Two rAFs to ensure post-font-load reflow has settled.
    await new Promise(r => requestAnimationFrame(() => r()));
    await new Promise(r => requestAnimationFrame(() => r()));
    // Async CSSOM mutators (Tailwind-CDN JIT, lazily-triggered @font-face loads)
    // keep reflowing the document AFTER the load event — and a style injection can
    // TRIGGER new font fetches, which reflow again on arrival. Loop until, in the
    // same tick: fonts.ready has resolved, no font is loading, the resource-entry
    // count is unchanged AND the layout fingerprint is unchanged for 2 consecutive
    // ticks. Capped at 6s.
    {
      const win = idoc.defaultView;
      // The resource-timing buffer caps at 250 entries by default; saturated buffers
      // would freeze resCount and let the settle loop pass during a late fetch.
      try { win.performance.setResourceTimingBufferSize(100000); } catch { /* optional */ }
      let prevFp = '', prevRes = -1, stableTicks = 0;
      for (let tick = 0; tick < 60 && stableTicks < 2; tick++) {
        if (idoc.fonts && idoc.fonts.ready) {
          await Promise.race([idoc.fonts.ready, new Promise(r => setTimeout(r, 1500))]);
        }
        const loading = idoc.fonts ? [...idoc.fonts].some(f => f.status === 'loading') : false;
        const resCount = win.performance ? win.performance.getEntriesByType('resource').length : 0;
        const fp = layoutFingerprint(idoc);
        if (!loading && fp === prevFp && resCount === prevRes) stableTicks++;
        else stableTicks = 0;
        prevFp = fp; prevRes = resCount;
        if (stableTicks < 2) await new Promise(r => setTimeout(r, 100));
      }
    }

    const root = idoc.documentElement;
    const boxes = [];
    walk(root, idoc, boxes, { prefix: [], seq: { n: 0 }, clips: [], tfms: [] });
    // (debug logs removed after sanity)

    // Content taller than the viewport flows beyond the iframe; report the real
    // document height so the caller can paginate.
    const contentHeight = Math.max(height, idoc.documentElement ? idoc.documentElement.scrollHeight : height);

    const forcedBreaks = collectForcedBreaks(idoc).filter(y => y > 0.5 && y < contentHeight - 0.5);

    return { boxes, width, height, contentHeight, forcedBreaks };
  } finally {
    iframe.remove();
  }
}

import { walkSvg } from '../render/svg.js';
import { parseColor, parsePx } from './utils.js';
export { parseColor, parsePx };

/**
 * Manual page-break markers: an author can force a new PDF page to start at a
 * given point in the flow, without knowing anything about pixel heights.
 * Recognized as either of:
 *   - class="page-break" (aliases: "pagebreak", "break-page") on any element
 *   - a data-page-break attribute
 *   - the standard print CSS, set inline: style="break-before: page" /
 *     style="page-break-before: always"
 * The new page starts at the marked element's own top edge — i.e. put the
 * marker (an empty <div class="page-break"></div> works) right before the
 * content that should begin the next page.
 * Returns Y coordinates (CSS px, iframe-relative), deduped.
 */
function collectForcedBreaks(idoc) {
  const ys = new Set();
  for (const el of idoc.querySelectorAll('.page-break, .pagebreak, .break-page, [data-page-break]')) {
    ys.add(el.getBoundingClientRect().top);
  }
  for (const el of idoc.querySelectorAll('[style*="break-before" i], [style*="page-break-before" i]')) {
    const s = el.style;
    if (s.breakBefore === 'page' || s.breakBefore === 'always' || s.pageBreakBefore === 'always') {
      ys.add(el.getBoundingClientRect().top);
    }
  }
  return [...ys].sort((a, b) => a - b);
}

/** Cheap whole-document layout fingerprint: scrollHeight + ~50 sampled element rects. */
function layoutFingerprint(idoc) {
  let s = idoc.body ? idoc.body.scrollHeight + ':' : '';
  const els = idoc.querySelectorAll('*');
  const step = Math.max(1, Math.floor(els.length / 50));
  for (let i = 0; i < els.length; i += step) {
    const r = els[i].getBoundingClientRect();
    s += (r.top | 0) + ',' + (r.left | 0) + ',' + (r.width | 0) + ';';
  }
  return s;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'NOSCRIPT']);
// Replaced and void elements cannot host ::before/::after content boxes.
const NO_PSEUDO_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'IMG', 'BR', 'HR',
  'IFRAME', 'VIDEO', 'AUDIO', 'CANVAS', 'EMBED', 'OBJECT', 'SVG']);

/**
 * CSS 2.1 Appendix E paint-order approximation. Every render box receives a
 * lexicographic sortKey; the painter stable-sorts before painting.
 * Within a stacking context: phase 1 = the context root's own background,
 * phase 2 = negative-z child contexts, phase 3 = in-flow block backgrounds/borders,
 * phase 5 = inline content (text, images, svg, bullets), phase 6 = positioned
 * z:auto/0 descendants + contexts, phase 7 = positive-z child contexts.
 *
 * ctx = { prefix: number[], seq: { n }, clips: [{x,y,w,h,radii}] }
 */
function walk(el, idoc, boxes, ctx) {
  // Use nodeType (constant across realms) instead of `instanceof Element`, since
  // elements coming from the iframe's contentDocument are instances of *its* Element
  // class, not the host window's. `instanceof` would silently bail out and we'd
  // collect zero boxes.
  if (!el || el.nodeType !== 1) return;
  if (SKIP_TAGS.has(el.tagName)) return;

  const cs = idoc.defaultView.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return;

  // ── CSS transform: measure the subtree UNTRANSFORMED, paint with a PDF cm ──
  // Transforms never affect layout, so disabling one only changes this element's
  // own rendering: every descendant rect we measure afterwards is in the local
  // (untransformed) space, which is exactly what the painter needs to replay the
  // matrix around transform-origin. Restored after the subtree walk.
  let tfmEntry = null;
  let savedInlineTransform = null;
  const transformStr = cs.transform;
  if (transformStr && transformStr !== 'none' && el.style) {
    const m = parseCssMatrix(transformStr);
    if (m) {
      const originStr = cs.transformOrigin || '0px 0px';
      savedInlineTransform = el.style.getPropertyValue('transform');
      el.style.setProperty('transform', 'none', 'important');
      const urect = el.getBoundingClientRect();  // untransformed now
      const op = originStr.split(/\s+/).map(parseFloat);
      tfmEntry = { m, ox: urect.left + (op[0] || 0), oy: urect.top + (op[1] || 0) };
    }
  }

  const rect = el.getBoundingClientRect();
  // We treat the iframe's own scrolling root as the coordinate origin (rect is relative
  // to the iframe viewport). The walker doesn't currently handle scrolled content.

  // ── stacking-context bookkeeping ──────────────────────────────────────────
  const positioned = cs.position !== 'static';
  const zRaw = cs.zIndex;
  const isCtx = (positioned && zRaw !== 'auto')
    || parseFloat(cs.opacity || '1') < 1
    || (transformStr && transformStr !== 'none');
  let myPrefix = ctx.prefix;
  if (isCtx) {
    const z = zRaw === 'auto' ? 0 : (parseInt(zRaw, 10) || 0);
    myPrefix = [...ctx.prefix, z < 0 ? 2 : z > 0 ? 7 : 6, z, ctx.seq.n++];
  } else if (positioned) {
    myPrefix = [...ctx.prefix, 6, 0, ctx.seq.n++];
  }
  // Own background paints first inside the element's own slot; for static elements
  // (myPrefix === ctx.prefix) it lands in the shared block-background phase 3.
  const bgPhase = (isCtx || positioned) ? 1 : 3;
  const clipsForSelf = ctx.clips.length ? ctx.clips : undefined;
  const key = (phase) => [...myPrefix, phase, ctx.seq.n++];

  // ── overflow clip for descendants (Chromium clips to the padding box) ────
  let childClips = ctx.clips;
  const ov = cs.overflow || '';
  if (ov !== 'visible' && ov !== '' && rect.width > 0 && rect.height > 0) {
    const bl = parsePx(cs.borderLeftWidth), br = parsePx(cs.borderRightWidth);
    const bt = parsePx(cs.borderTopWidth), bb = parsePx(cs.borderBottomWidth);
    childClips = [...ctx.clips, {
      x: rect.left + bl, y: rect.top + bt,
      w: rect.width - bl - br, h: rect.height - bt - bb,
      radii: {
        tl: Math.max(0, parsePx(cs.borderTopLeftRadius) - Math.max(bl, bt)),
        tr: Math.max(0, parsePx(cs.borderTopRightRadius) - Math.max(br, bt)),
        br: Math.max(0, parsePx(cs.borderBottomRightRadius) - Math.max(br, bb)),
        bl: Math.max(0, parsePx(cs.borderBottomLeftRadius) - Math.max(bl, bb)),
      },
    }];
  }
  const clipsForChildren = childClips.length ? childClips : undefined;
  const myTfms = tfmEntry ? [...(ctx.tfms || []), tfmEntry] : (ctx.tfms || []);
  const tfms = myTfms.length ? myTfms : undefined;
  const childCtx = { prefix: myPrefix, seq: ctx.seq, clips: childClips, tfms: myTfms };
  const restoreTransform = () => {
    if (!tfmEntry) return;
    if (savedInlineTransform) el.style.setProperty('transform', savedInlineTransform);
    else el.style.removeProperty('transform');
  };

  const style = {
    backgroundColor: cs.backgroundColor,
    backgroundImage: cs.backgroundImage,
    color: cs.color,
    opacity: parseFloat(cs.opacity || '1'),
    borderTopLeftRadius: cs.borderTopLeftRadius,
    borderTopRightRadius: cs.borderTopRightRadius,
    borderBottomRightRadius: cs.borderBottomRightRadius,
    borderBottomLeftRadius: cs.borderBottomLeftRadius,
    borderTopWidth: cs.borderTopWidth,
    borderRightWidth: cs.borderRightWidth,
    borderBottomWidth: cs.borderBottomWidth,
    borderLeftWidth: cs.borderLeftWidth,
    borderTopColor: cs.borderTopColor,
    borderRightColor: cs.borderRightColor,
    borderBottomColor: cs.borderBottomColor,
    borderLeftColor: cs.borderLeftColor,
    borderTopStyle: cs.borderTopStyle,
    borderRightStyle: cs.borderRightStyle,
    borderBottomStyle: cs.borderBottomStyle,
    borderLeftStyle: cs.borderLeftStyle,
    boxShadow: cs.boxShadow,
    textShadow: cs.textShadow,
    outlineWidth: cs.outlineWidth,
    outlineStyle: cs.outlineStyle,
    outlineColor: cs.outlineColor,
    outlineOffset: cs.outlineOffset,
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    resolvedWeight: resolveUsedWeight(idoc, cs.fontFamily, parseInt(cs.fontWeight, 10) || 400),
    fontStyle: cs.fontStyle,
    fontVariant: cs.fontVariant,
    letterSpacing: cs.letterSpacing,
    textTransform: cs.textTransform,
    textAlign: cs.textAlign,
    textDecoration: cs.textDecorationLine,
    textDecorationStyle: cs.textDecorationStyle,
    textDecorationColor: cs.textDecorationColor,
    textUnderlineOffset: cs.textUnderlineOffset,
    lineHeight: cs.lineHeight,
    overflow: cs.overflow,
    whiteSpace: cs.whiteSpace,
    borderCollapse: cs.borderCollapse,
    objectFit: cs.objectFit,
    backgroundSize: cs.backgroundSize,
    backgroundPosition: cs.backgroundPosition,
    backgroundRepeat: cs.backgroundRepeat,
  };

  // Push the element's own background/border box (skip default transparent/empty).
  const hasBg = style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent';
  const hasBgImage = style.backgroundImage && style.backgroundImage !== 'none';
  const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(s => parseFloat(style['border' + s + 'Width']) > 0);
  const hasOutline = parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none';
  const hasShadow = style.boxShadow && style.boxShadow !== 'none';

  if ((hasBg || hasBgImage || hasBorder || hasOutline || hasShadow) && rect.width > 0 && rect.height > 0) {
    boxes.push({
      kind: 'box',
      x: rect.left, y: rect.top, w: rect.width, h: rect.height,
      style, tag: el.tagName.toLowerCase(), el,
      sortKey: key(bgPhase), clips: clipsForSelf, tfms,
    });
  }

  // SVG: emit shapes as a flat list of svg-* boxes; do NOT recurse via the HTML walker
  // (SVG children have a different attribute model).
  if (el.tagName.toLowerCase() === 'svg') {
    const before = boxes.length;
    walkSvg(el, boxes, idoc);
    for (let i = before; i < boxes.length; i++) {
      boxes[i].sortKey = key(5);
      boxes[i].clips = clipsForChildren;
      boxes[i].tfms = tfms;
    }
    restoreTransform();
    return;  // skip generic recursion for SVG children
  }

  // <input>/<select>/<textarea>: surface the placeholder or current value text so the
  // walker emits a synthesized text run inside the form control's box. Without this,
  // form fields look blank in the PDF (which is wrong — the reference screenshot shows
  // placeholder text or the selected option).
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    let displayText = '';
    let displayColor = cs.color;
    if (el.value) {
      displayText = el.value;
    } else if (el.tagName === 'SELECT' && el.options.length > 0) {
      displayText = el.options[el.selectedIndex >= 0 ? el.selectedIndex : 0].textContent;
    } else if (el.placeholder) {
      displayText = el.placeholder;
      // Tailwind's `placeholder:text-on-surface-variant/30` pushes opacity → use placeholder's
      // visible computed color (an approximation; the iframe may have CSS that styles
      // ::placeholder pseudo with an alpha.)
      displayColor = cs.color;
    } else if (el.tagName === 'INPUT' && el.type === 'date') {
      displayText = 'mm/dd/yyyy';
    }
    if (displayText) {
      // Use input's own padding to position the text. Since CSS centers vertically with
      // line-height equal to control height, baseline ~ center + font-size/3.
      const padTop = parsePx(cs.paddingTop);
      const padLeft = parsePx(cs.paddingLeft);
      const fontSize = parsePx(cs.fontSize) || 14;
      const lineH = parsePx(cs.lineHeight) || rect.height;
      boxes.push({
        kind: 'text',
        x: rect.left + padLeft,
        y: rect.top + padTop,
        w: rect.width - padLeft * 2,
        h: lineH,
        style: { ...style, color: displayColor, opacity: el.value ? style.opacity : Math.min(style.opacity, 0.5) },
        tag: el.tagName.toLowerCase(),
        el,
        text: displayText,
        sortKey: key(5), clips: clipsForChildren, tfms,
      });
    }
  }

  // <img> elements: record the rect + URL. The painter fetches and embeds.
  if (el.tagName === 'IMG' && rect.width > 0 && rect.height > 0) {
    boxes.push({
      kind: 'image',
      x: rect.left, y: rect.top, w: rect.width, h: rect.height,
      style, tag: 'img', el,
      src: el.currentSrc || el.src || '',
      sortKey: key(5), clips: clipsForSelf, tfms,
    });
  }

  // Hyperlinks → record the element rect as a link box (the actual link annotation
  // is emitted later by the painter); the link target uses `el.href`.
  if (el.tagName === 'A' && el.hasAttribute('href')) {
    boxes.push({
      kind: 'link',
      x: rect.left, y: rect.top, w: rect.width, h: rect.height,
      style, tag: 'a', el,
      href: el.getAttribute('href'),
    });
  }

  // Skip text inside icon fonts — they map ASCII names ("settings", "polyline") to
  // glyphs via OpenType ligatures. Without the icon font embedded, drawing those names
  // in our fallback Inter would pollute the output. Better to leave an empty space.
  const fontFam = (style.fontFamily || '').toLowerCase();
  const isIconFont = /material\s*symbols|material\s*icons|fontawesome|fa-solid|fa-regular|bi-icons|font\s*awesome/i.test(fontFam);

  // List markers (::marker). Chromium gives no geometry for marker boxes, so we
  // synthesize them: Blink places outside markers with a 7px gap between the marker's
  // inline-end and the li's content box. Disc/circle/square are drawn as shapes
  // (diameter ≈ ascent/3 like Blink); decimal markers are "N." text right-aligned.
  const isListItem = cs.display === 'list-item' && cs.listStyleType !== 'none'
    && cs.listStylePosition !== 'inside';
  const liMarkerFixupIndex = isListItem ? boxes.length : -1;
  const textStartIndex = boxes.length;

  // Text-bearing leaves: walk this element's direct text-node children. For each text
  // node we measure EVERY character's client rect (Range), group consecutive characters
  // into words, words into lines. Each word becomes one render box at its exact
  // rendered position — this makes justify, white-space:pre, multi-line wrapping and
  // letter-spacing land precisely where Chromium put them.
  for (const child of el.childNodes) {
    // Use literal nodeType values (3 = TEXT, 1 = ELEMENT) for the same realm-agnostic reason.
    if (child.nodeType === 3) {
      const raw = child.nodeValue;
      if (!raw || !raw.trim()) continue;
      const before = boxes.length;
      pushWordBoxes(child, idoc, boxes, style, el);
      for (let i = before; i < boxes.length; i++) {
        boxes[i].sortKey = key(5);
        boxes[i].clips = clipsForChildren;
        boxes[i].tfms = tfms;
        // Icon-font runs (Material Symbols etc.) carry glyph NAMES that resolve
        // through GSUB ligatures; the painter draws them only when the icon font
        // could be embedded, otherwise they stay blank like before.
        if (isIconFont) boxes[i].iconFont = true;
      }
    } else if (child.nodeType === 1) {
      walk(child, idoc, boxes, childCtx);
    }
  }

  // After children are walked we know where the li's first text line sits; synthesize
  // the marker aligned to that first line.
  if (isListItem) {
    const firstText = boxes.slice(liMarkerFixupIndex).find(b => b.kind === 'text');
    const before = boxes.length;
    pushListMarker(el, cs, rect, boxes, style, firstText, idoc);
    for (let i = before; i < boxes.length; i++) {
      boxes[i].sortKey = key(5);
      boxes[i].clips = clipsForChildren;
      boxes[i].tfms = tfms;
    }
  }

  // ::before / ::after with plain string content — synthesized as text boxes
  // anchored to the element's first/last real word (Chromium exposes the pseudo's
  // computed style but no geometry). Conservative subset: inline, same-line,
  // literal string content only.
  for (const which of ['::before', '::after']) {
    // Replaced/void elements never generate pseudo boxes (Chromium still REPORTS
    // a computed style for them, so the content check alone is not enough).
    if (NO_PSEUDO_TAGS.has(el.tagName)) break;
    let pcs;
    try { pcs = idoc.defaultView.getComputedStyle(el, which); } catch { continue; }
    if (!pcs || pcs.display === 'none') continue;
    const content = pcs.content;
    if (!content || content === 'none' || content === 'normal') continue;
    let text = null;
    const cm2 = /^"((?:[^"\\]|\\.)*)"$/.exec(content);
    if (cm2) {
      text = cm2[1].replace(/\\([\s\S])/g, '$1');
    } else {
      const am = /^attr\(([\w-]+)\)$/.exec(content);
      if (am) text = el.getAttribute(am[1]) || '';
      else if (content === 'open-quote' || content === 'close-quote') {
        // First pair of the computed `quotes` list (nesting depth ignored).
        const qm = /^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/.exec(pcs.quotes || '');
        text = qm ? (content === 'open-quote' ? qm[1] : qm[2]) : (content === 'open-quote' ? '“' : '”');
      }
    }
    if (text == null || !text.trim()) continue;  // counters, url(), mixed — unsupported
    const pseudoStyle = {
      ...style,
      color: pcs.color,
      fontFamily: pcs.fontFamily, fontSize: pcs.fontSize, fontWeight: pcs.fontWeight,
      fontStyle: pcs.fontStyle, letterSpacing: pcs.letterSpacing,
      textTransform: pcs.textTransform, textDecoration: pcs.textDecorationLine,
      textShadow: pcs.textShadow || 'none',
      resolvedWeight: resolveUsedWeight(idoc, pcs.fontFamily, parseInt(pcs.fontWeight, 10) || 400),
    };
    const pm = fontMetricsFor(idoc, pseudoStyle);
    let tw = (parsePx(pcs.fontSize) || 12) * 0.6 * text.length;
    try {
      let mctx = idoc.__pdfMeasureCtx;
      if (!mctx) mctx = idoc.__pdfMeasureCtx = idoc.createElement('canvas').getContext('2d');
      mctx.font = `${pcs.fontStyle === 'italic' ? 'italic ' : ''}${pcs.fontWeight} ${pcs.fontSize} ${pcs.fontFamily}`;
      const m3 = mctx.measureText(text);
      if (m3.width > 0) tw = m3.width;
    } catch { /* keep estimate */ }
    const sub = boxes.slice(textStartIndex);
    const texts = sub.filter(bb => bb.kind === 'text');
    const anchor = which === '::before' ? texts[0] : texts[texts.length - 1];
    const boxH = pm ? pm.boxH : (parsePx(pcs.fontSize) || 12) * 1.2;
    let px, py;
    if (anchor) {
      const aBase = anchor.metrics
        ? anchor.y + (anchor.h - anchor.metrics.boxH) / 2 + anchor.metrics.ascent
        : anchor.y + anchor.h * 0.8;
      py = pm ? aBase - pm.ascent + (pm.boxH - boxH) / 2 : anchor.y;
      px = which === '::before'
        ? anchor.x - parsePx(pcs.marginRight) - parsePx(pcs.paddingRight) - tw - parsePx(pcs.paddingLeft)
        : anchor.x + anchor.w + parsePx(pcs.marginLeft) + parsePx(pcs.paddingLeft);
    } else {
      // No real content: anchor inside the element's content box.
      const cLeft = rect.left + parsePx(cs.borderLeftWidth) + parsePx(cs.paddingLeft);
      px = which === '::before' ? cLeft : rect.left + rect.width - parsePx(cs.borderRightWidth) - parsePx(cs.paddingRight) - tw;
      py = rect.top + parsePx(cs.borderTopWidth) + parsePx(cs.paddingTop);
    }
    boxes.push({
      kind: 'text', x: px, y: py, w: tw, h: boxH,
      style: pseudoStyle, tag: el.tagName.toLowerCase() + which, el,
      text, metrics: pm,
      sortKey: key(5), clips: clipsForChildren, tfms,
    });
  }

  // text-overflow: ellipsis — Chromium hides the partially-clipped tail entirely
  // and draws "…" after the last visible character. We trim/drop the word boxes
  // emitted for this element and synthesize the ellipsis box.
  if (cs.textOverflow === 'ellipsis' && ov !== 'visible' && ov !== ''
      && cs.whiteSpace === 'nowrap' && el.scrollWidth > el.clientWidth + 1) {
    const contentRight = rect.left + el.clientLeft + el.clientWidth;
    let ellW = (parsePx(cs.fontSize) || 12) * 0.7;
    try {
      let mctx = idoc.__pdfMeasureCtx;
      if (!mctx) mctx = idoc.__pdfMeasureCtx = idoc.createElement('canvas').getContext('2d');
      mctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const tw = mctx.measureText('…').width;
      if (tw > 0) ellW = tw;
    } catch { /* keep estimate */ }
    const limit = contentRight - ellW;
    let lastKept = null;
    let dropped = false;
    for (let i = textStartIndex; i < boxes.length; i++) {
      const tb = boxes[i];
      if (tb.kind !== 'text') continue;
      if (tb.x + tb.w <= limit) { if (!lastKept || tb.x > lastKept.x) lastKept = tb; continue; }
      if (tb.x >= limit) { boxes.splice(i, 1); i--; dropped = true; continue; }
      // Straddling word: trim at approximate character granularity.
      const avg = tb.w / tb.text.length;
      const keep = Math.max(0, Math.floor((limit - tb.x) / avg));
      dropped = true;
      if (keep === 0) { boxes.splice(i, 1); i--; continue; }
      tb.text = tb.text.slice(0, keep);
      tb.w = keep * avg;
      lastKept = tb;
    }
    if (dropped) {
      const anchor = lastKept || { x: rect.left + el.clientLeft, y: rect.top, h: rect.height, metrics: undefined };
      boxes.push({
        kind: 'text',
        x: lastKept ? lastKept.x + lastKept.w : anchor.x,
        y: anchor.y, w: ellW, h: anchor.h,
        style, tag: 'ellipsis', el, text: '…',
        metrics: anchor.metrics,
        sortKey: key(5), clips: clipsForChildren, tfms,
      });
    }
  }

  restoreTransform();
}

/** Parse "matrix(a,b,c,d,e,f)" / "matrix3d(...)" into [a,b,c,d,e,f] (2D part). */
function parseCssMatrix(s) {
  let m = /^matrix\(([^)]+)\)$/.exec(s);
  if (m) {
    const v = m[1].split(',').map(parseFloat);
    return v.length === 6 && v.every(isFinite) ? v : null;
  }
  m = /^matrix3d\(([^)]+)\)$/.exec(s);
  if (m) {
    const v = m[1].split(',').map(parseFloat);
    if (v.length !== 16 || !v.every(isFinite)) return null;
    return [v[0], v[1], v[4], v[5], v[12], v[13]];
  }
  return null;
}

/**
 * Resolve the font-weight Chromium ACTUALLY used: CSS font matching picks the
 * nearest available weight of the first matching @font-face family, which can be
 * lighter than the computed font-weight (e.g. computed 600 with only 400/500
 * loaded resolves to 500). We mirror the css-fonts-4 algorithm against the
 * weights registered in the iframe's document.fonts.
 */
function resolveUsedWeight(idoc, fontFamily, weight) {
  let fam = idoc.__pdfFamilyWeights;
  if (!fam) {
    fam = idoc.__pdfFamilyWeights = new Map();
    try {
      for (const f of idoc.fonts) {
        const name = f.family.replace(/^["']|["']$/g, '').toLowerCase();
        // f.weight may be a variable-font RANGE ("400 700") — keep [min, max].
        const m = /^\s*([\d.]+)(?:\s+([\d.]+))?\s*$/.exec(f.weight || '');
        const lo = m ? parseFloat(m[1]) : 400;
        const hi = m && m[2] ? parseFloat(m[2]) : lo;
        if (!fam.has(name)) fam.set(name, []);
        fam.get(name).push([lo, hi]);
      }
    } catch { /* no FontFaceSet access */ }
  }
  const families = (fontFamily || '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '').toLowerCase());
  for (const f of families) {
    const ranges = fam.get(f);
    if (!ranges || !ranges.length) continue;
    // Inside any face's range → the desired weight is available exactly.
    if (ranges.some(([lo, hi]) => weight >= lo && weight <= hi)) return weight;
    const ws = [...new Set(ranges.flat())].sort((a, b) => a - b);
    const avail = new Set(ws);
    if (avail.has(weight)) return weight;
    const below = ws.filter(w => w < weight);
    const above = ws.filter(w => w > weight);
    if (weight >= 400 && weight <= 500) {
      const up500 = above.filter(w => w <= 500);
      if (up500.length) return up500[0];
      if (below.length) return below[below.length - 1];
      return above[0];
    }
    if (weight < 400) {
      if (below.length) return below[below.length - 1];
      return above[0];
    }
    // weight > 500: ascending first, then descending.
    if (above.length) return above[0];
    return below[below.length - 1];
  }
  return weight;  // no registered face — system font, keep computed weight
}

/**
 * Measure the used font's bounding-box metrics with the iframe's own canvas — the
 * same engine that laid out the text, so rect.top + these metrics give Chromium's
 * exact baseline. Cached per (style, weight, size, family).
 */
function fontMetricsFor(idoc, style) {
  const key = `${style.fontStyle}|${style.fontWeight}|${style.fontSize}|${style.fontFamily}`;
  let cache = idoc.__pdfFontMetrics;
  if (!cache) cache = idoc.__pdfFontMetrics = new Map();
  let m = cache.get(key);
  if (m !== undefined) return m;
  try {
    let ctx = idoc.__pdfMeasureCtx;
    if (!ctx) ctx = idoc.__pdfMeasureCtx = idoc.createElement('canvas').getContext('2d');
    const fs = style.fontStyle && style.fontStyle !== 'normal' ? style.fontStyle + ' ' : '';
    ctx.font = `${fs}${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const tm = ctx.measureText('Hg');
    if (tm.fontBoundingBoxAscent > 0) {
      m = { ascent: tm.fontBoundingBoxAscent, boxH: tm.fontBoundingBoxAscent + tm.fontBoundingBoxDescent };
    } else m = null;
  } catch { m = null; }
  cache.set(key, m);
  return m;
}

/**
 * Per-character Range measurement of one text node → word-level render boxes.
 * Whitespace characters (collapsed or not) are never emitted as glyphs; their advance
 * is implicit in the following word's x position.
 */
function pushWordBoxes(node, idoc, boxes, style, el) {
  const raw = node.nodeValue;
  const tag = el.tagName.toLowerCase();
  const range = idoc.createRange();

  // Guard: gigantic text nodes fall back to whole-node measurement (perf).
  if (raw.length > 20000) {
    range.selectNode(node);
    const r = range.getBoundingClientRect();
    boxes.push({ kind: 'text', x: r.left, y: r.top, w: r.width, h: r.height, style, tag, el, text: raw.replace(/\s+/g, ' ').trim() });
    return;
  }

  const metrics = fontMetricsFor(idoc, style);
  let word = null;  // { text, left, right, top, bottom }
  let lastBox = null;
  const flush = () => {
    if (word && word.text) {
      const bb = {
        kind: 'text',
        x: word.left, y: word.top, w: word.right - word.left, h: word.bottom - word.top,
        style, tag, el, text: word.text, metrics,
      };
      // Bridge text-decoration across the inter-word gap: Chromium underlines/strikes
      // the spaces too, but we emit one box per word. decoR extends the previous
      // word's decoration up to this word's start when both sit on the same line.
      if (lastBox && Math.abs(lastBox.y - bb.y) < 2 && bb.x > lastBox.x) lastBox.decoR = bb.x;
      lastBox = bb;
      boxes.push(bb);
    }
    word = null;
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) { flush(); continue; }   // any whitespace separates words
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const rects = range.getClientRects();
    if (!rects.length) { flush(); continue; }
    const r = rects[0];
    if (r.width === 0 && r.height === 0) { flush(); continue; }
    // New line if the char's top differs from the current word's top.
    if (word && Math.abs(r.top - word.top) > 2) flush();
    if (!word) {
      word = { text: ch, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    } else {
      word.text += ch;
      word.right = Math.max(word.right, r.right);
      word.left = Math.min(word.left, r.left);
      word.bottom = Math.max(word.bottom, r.bottom);
    }
  }
  flush();
}

/**
 * Synthesize a list marker box for an li with list-style-position: outside.
 * @param {Element} el  the li
 * @param {CSSStyleDeclaration} cs
 * @param {DOMRect} rect  li border-box rect
 * @param {Array} boxes
 * @param {Object} style  captured style of the li
 * @param {Object|undefined} firstText  first text box inside the li (for baseline alignment)
 */
function pushListMarker(el, cs, rect, boxes, style, firstText, idoc) {
  const type = cs.listStyleType;
  const fontSize = parsePx(cs.fontSize) || 12;
  const contentLeft = rect.left + parsePx(cs.borderLeftWidth) + parsePx(cs.paddingLeft);
  const gap = 10;  // measured against Chromium 96dpi rendering (7px padding + bullet side bearing)

  // Vertical anchor: the first line's baseline (same 0.80 formula the painter uses),
  // falling back to the li's own top + line-height.
  const lineTop = firstText ? firstText.y : rect.top;
  const lineH = firstText ? firstText.h : (parsePx(cs.lineHeight) || fontSize * 1.4);
  // Match the painter's integer-pixel baseline snapping so markers ride the same
  // line as the text they precede.
  const baseline = Math.round(firstText && firstText.metrics
    ? firstText.y + (firstText.h - firstText.metrics.boxH) / 2 + firstText.metrics.ascent
    : lineTop + lineH * 0.80);

  if (type === 'disc' || type === 'circle' || type === 'square') {
    // Blink sizes bullets at ascent/3 (≈ 0.32 em for Inter), vertically centered a bit
    // above the baseline (~ x-height middle).
    const d = fontSize * 0.32;
    const cx = contentLeft - gap - d / 2;
    const cy = baseline - fontSize * 0.39;
    boxes.push({
      kind: 'bullet', shape: type,
      x: cx - d / 2, y: cy - d / 2, w: d, h: d,
      color: cs.color, style, tag: 'li::marker', el,
    });
  } else {
    // Counter-based markers: decimal, lower-alpha, lower-roman (common subset).
    let index = 1;
    const parent = el.parentElement;
    if (parent) {
      const start = parseInt(parent.getAttribute && parent.getAttribute('start'), 10);
      index = isNaN(start) ? 1 : start;
      for (const sib of parent.children) {
        if (sib === el) break;
        if (sib.tagName === 'LI') index++;
      }
    }
    let label;
    if (type === 'lower-alpha' || type === 'lower-latin') label = String.fromCharCode(96 + ((index - 1) % 26) + 1) + '.';
    else if (type === 'upper-alpha' || type === 'upper-latin') label = String.fromCharCode(64 + ((index - 1) % 26) + 1) + '.';
    else if (type === 'lower-roman') label = toRoman(index).toLowerCase() + '.';
    else if (type === 'upper-roman') label = toRoman(index) + '.';
    else label = index + '.';
    // Right-align the label so it ends 7px before the content box (Blink's
    // kCMarkerPaddingPx — text markers sit closer than the disc's optical gap).
    // Measure the label's real advance with the iframe's canvas; fall back to a
    // digit-width estimate if measurement is unavailable.
    let w = fontSize * (0.6 * (label.length - 1) + 0.28);
    try {
      let ctx = idoc.__pdfMeasureCtx;
      if (!ctx) ctx = idoc.__pdfMeasureCtx = idoc.createElement('canvas').getContext('2d');
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const tw = ctx.measureText(label).width;
      if (tw > 0) w = tw;
    } catch { /* keep estimate */ }
    boxes.push({
      kind: 'text',
      x: contentLeft - 7 - w, y: lineTop, w, h: lineH,
      style, tag: 'li::marker', el, text: label,
    });
  }
}

function toRoman(n) {
  const table = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
  let out = '';
  for (const [v, s] of table) { while (n >= v) { out += s; n -= v; } }
  return out;
}

// parseColor / parsePx are re-exported from ./utils.js at the top of this file.
