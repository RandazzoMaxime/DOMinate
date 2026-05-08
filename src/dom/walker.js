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

  // Text-bearing leaves: walk this element's direct text-node children and use Range
  // to get the actual rendered rectangles for each text run.
  for (const child of el.childNodes) {
    // Use literal nodeType values (3 = TEXT, 1 = ELEMENT) for the same realm-agnostic reason.
    if (child.nodeType === 3) {
      const t = child.nodeValue;
      if (!t || !t.trim()) continue;
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

/**
 * Parse a CSS color string into { r, g, b, a } with each component in 0..1.
 *
 * Recognizes the formats Chromium emits via getComputedStyle on modern documents:
 *   rgb(R, G, B)
 *   rgba(R, G, B, A)
 *   color(srgb R G B [/ A])           ← CSS Color Module Level 4 (used for color-mix output)
 *   color(display-p3 R G B [/ A])     ← treated as srgb for now (visually close enough in iter 3)
 *   #RGB / #RRGGBB / #RRGGBBAA        ← in case anyone hands us the source CSS directly
 *   transparent
 *
 * Returns null on anything else.
 */
export function parseColor(s) {
  if (!s) return null;
  const v = s.trim();

  // rgb()/rgba() — comma- or space-separated, possibly with `/` for alpha.
  let m = /^rgba?\(\s*([-\d.]+%?)[,\s]+([-\d.]+%?)[,\s]+([-\d.]+%?)\s*(?:[,\s\/]+([-\d.]+%?))?\s*\)$/i.exec(v);
  if (m) {
    return {
      r: parsePct(m[1]) / 255, g: parsePct(m[2]) / 255, b: parsePct(m[3]) / 255,
      a: m[4] !== undefined ? parseAlpha(m[4]) : 1,
    };
  }

  // color(srgb R G B [/ A])  or  color(display-p3 R G B [/ A])
  m = /^color\(\s*(srgb|display-p3)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*(?:\/\s*([-\d.]+%?))?\s*\)$/i.exec(v);
  if (m) {
    return {
      r: clamp01(+m[2]), g: clamp01(+m[3]), b: clamp01(+m[4]),
      a: m[5] !== undefined ? parseAlpha(m[5]) : 1,
    };
  }

  // #RGB / #RRGGBB / #RRGGBBAA
  m = /^#([0-9a-fA-F]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length === 4) h = h.split('').map(c => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }

  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}

function parsePct(s) {
  if (s.endsWith('%')) return parseFloat(s) * 2.55;  // → 0..255 range
  return parseFloat(s);
}
function parseAlpha(s) {
  if (s.endsWith('%')) return clamp01(parseFloat(s) / 100);
  return clamp01(parseFloat(s));
}
function clamp01(n) { return n < 0 ? 0 : (n > 1 ? 1 : n); }

/** Parse "12.5px" → 12.5. Returns 0 if not a px length. */
export function parsePx(s) {
  if (!s) return 0;
  const m = /^([-\d.]+)px$/.exec(s);
  return m ? parseFloat(m[1]) : 0;
}
