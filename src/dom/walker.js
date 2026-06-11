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
    // Tailwind-CDN runtime needs an extra tick for its CSSOM mutation to settle.
    await new Promise(r => setTimeout(r, 100));

    const root = idoc.documentElement;
    const boxes = [];
    walk(root, idoc, boxes, { prefix: [], seq: { n: 0 }, clips: [] });
    // (debug logs removed after sanity)

    return { boxes, width, height };
  } finally {
    iframe.remove();
  }
}

import { walkSvg } from '../render/svg.js';
import { parseColor, parsePx } from './utils.js';
export { parseColor, parsePx };

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'NOSCRIPT']);

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

  const rect = el.getBoundingClientRect();
  // We treat the iframe's own scrolling root as the coordinate origin (rect is relative
  // to the iframe viewport). The walker doesn't currently handle scrolled content.

  // ── stacking-context bookkeeping ──────────────────────────────────────────
  const positioned = cs.position !== 'static';
  const zRaw = cs.zIndex;
  const isCtx = (positioned && zRaw !== 'auto')
    || parseFloat(cs.opacity || '1') < 1
    || (cs.transform && cs.transform !== 'none');
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
  const childCtx = { prefix: myPrefix, seq: ctx.seq, clips: childClips };

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
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle,
    fontVariant: cs.fontVariant,
    letterSpacing: cs.letterSpacing,
    textTransform: cs.textTransform,
    textAlign: cs.textAlign,
    textDecoration: cs.textDecorationLine,
    lineHeight: cs.lineHeight,
    overflow: cs.overflow,
    whiteSpace: cs.whiteSpace,
  };

  // Push the element's own background/border box (skip default transparent/empty).
  const hasBg = style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent';
  const hasBgImage = style.backgroundImage && style.backgroundImage !== 'none';
  const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(s => parseFloat(style['border' + s + 'Width']) > 0);

  if ((hasBg || hasBgImage || hasBorder) && rect.width > 0 && rect.height > 0) {
    boxes.push({
      kind: 'box',
      x: rect.left, y: rect.top, w: rect.width, h: rect.height,
      style, tag: el.tagName.toLowerCase(), el,
      sortKey: key(bgPhase), clips: clipsForSelf,
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
    }
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
        sortKey: key(5), clips: clipsForChildren,
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
      sortKey: key(5), clips: clipsForSelf,
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
      if (isIconFont) continue;
      const before = boxes.length;
      pushWordBoxes(child, idoc, boxes, style, el);
      for (let i = before; i < boxes.length; i++) {
        boxes[i].sortKey = key(5);
        boxes[i].clips = clipsForChildren;
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
    pushListMarker(el, cs, rect, boxes, style, firstText);
    for (let i = before; i < boxes.length; i++) {
      boxes[i].sortKey = key(5);
      boxes[i].clips = clipsForChildren;
    }
  }
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

  let word = null;  // { text, left, right, top, bottom }
  let lastBox = null;
  const flush = () => {
    if (word && word.text) {
      const bb = {
        kind: 'text',
        x: word.left, y: word.top, w: word.right - word.left, h: word.bottom - word.top,
        style, tag, el, text: word.text,
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
function pushListMarker(el, cs, rect, boxes, style, firstText) {
  const type = cs.listStyleType;
  const fontSize = parsePx(cs.fontSize) || 12;
  const contentLeft = rect.left + parsePx(cs.borderLeftWidth) + parsePx(cs.paddingLeft);
  const gap = 10;  // measured against Chromium 96dpi rendering (7px padding + bullet side bearing)

  // Vertical anchor: the first line's baseline (same 0.80 formula the painter uses),
  // falling back to the li's own top + line-height.
  const lineTop = firstText ? firstText.y : rect.top;
  const lineH = firstText ? firstText.h : (parsePx(cs.lineHeight) || fontSize * 1.4);
  const baseline = lineTop + lineH * 0.80;

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
    // Right-align the label so it ends `gap` px before the content box. Width is
    // estimated from the font size (the painter draws left-to-right from x; we shift
    // x by an approximate label advance: digits ≈ 0.6 em each, '.' ≈ 0.28 em).
    const w = fontSize * (0.6 * (label.length - 1) + 0.28);
    boxes.push({
      kind: 'text',
      x: contentLeft - gap - w, y: lineTop, w, h: lineH,
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
