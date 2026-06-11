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
    walk(root, idoc, boxes, 0, 0);
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

function walk(el, idoc, boxes, parentX, parentY) {
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
    });
  }

  // SVG: emit shapes as a flat list of svg-* boxes; do NOT recurse via the HTML walker
  // (SVG children have a different attribute model).
  if (el.tagName.toLowerCase() === 'svg') {
    walkSvg(el, boxes, idoc);
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

  // Text-bearing leaves: walk this element's direct text-node children and use Range
  // to get the actual rendered rectangles for each text run.
  for (const child of el.childNodes) {
    // Use literal nodeType values (3 = TEXT, 1 = ELEMENT) for the same realm-agnostic reason.
    if (child.nodeType === 3) {
      // Normalize whitespace the way HTML rendering does: collapse all whitespace
      // runs (including \n) to a single space, then trim. Without this, leading/
      // trailing newlines in source HTML become .notdef glyphs in the PDF (the
      // newline char isn't in any font's Unicode cmap).
      const raw = child.nodeValue;
      if (!raw || !raw.trim()) continue;
      const t = raw.replace(/\s+/g, ' ').trim();
      if (isIconFont) continue;
      const range = idoc.createRange();
      range.selectNode(child);
      const rects = range.getClientRects();
      // For multi-line text we get one rect per line; for single-line, one rect.
      // We split the string proportionally by rect width so each rect carries the right portion.
      const rectsArr = Array.from(rects);
      if (rectsArr.length === 1) {
        const r = rectsArr[0];
        boxes.push({
          kind: 'text',
          x: r.left, y: r.top, w: r.width, h: r.height,
          style, tag: el.tagName.toLowerCase(), el,
          text: t,
        });
      } else if (rectsArr.length > 1) {
        // Multi-line: chunk the string by its width slices.
        const totalW = rectsArr.reduce((s, r) => s + r.width, 0) || 1;
        let cursor = 0;
        for (const r of rectsArr) {
          const take = Math.max(1, Math.round(t.length * (r.width / totalW)));
          const slice = t.slice(cursor, cursor + take);
          cursor += take;
          if (slice.trim()) {
            boxes.push({
              kind: 'text',
              x: r.left, y: r.top, w: r.width, h: r.height,
              style, tag: el.tagName.toLowerCase(), el,
              text: slice,
            });
          }
        }
        // Tail (rounding leftover)
        if (cursor < t.length) {
          const last = rectsArr[rectsArr.length - 1];
          const tail = t.slice(cursor);
          if (tail.trim()) {
            boxes.push({
              kind: 'text',
              x: last.left, y: last.top, w: last.width, h: last.height,
              style, tag: el.tagName.toLowerCase(), el,
              text: tail,
            });
          }
        }
      }
    } else if (child.nodeType === 1) {
      walk(child, idoc, boxes, parentX, parentY);
    }
  }
}

// parseColor / parsePx are re-exported from ./utils.js at the top of this file.
