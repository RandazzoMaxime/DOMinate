// Color and length parsing helpers shared between walker.js and the SVG renderer.

/**
 * Parse a CSS color string into { r, g, b, a } with each component in 0..1.
 *
 * Accepts:
 *   rgb(R, G, B) / rgba(R, G, B, A)
 *   color(srgb R G B [/ A])           — CSS Color Module Level 4
 *   color(display-p3 R G B [/ A])     — treated as srgb (good-enough)
 *   #RGB / #RRGGBB / #RRGGBBAA
 *   transparent
 *   none / currentColor               — return null (caller decides)
 */
export function parseColor(s) {
  if (!s) return null;
  const v = s.trim();

  if (v === 'none' || v === 'currentColor' || v === 'currentcolor') return null;

  let m = /^rgba?\(\s*([-\d.]+%?)[,\s]+([-\d.]+%?)[,\s]+([-\d.]+%?)\s*(?:[,\s\/]+([-\d.]+%?))?\s*\)$/i.exec(v);
  if (m) {
    return {
      r: parsePct(m[1]) / 255, g: parsePct(m[2]) / 255, b: parsePct(m[3]) / 255,
      a: m[4] !== undefined ? parseAlpha(m[4]) : 1,
    };
  }

  m = /^color\(\s*(srgb|display-p3)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*(?:\/\s*([-\d.]+%?))?\s*\)$/i.exec(v);
  if (m) {
    return {
      r: clamp01(+m[2]), g: clamp01(+m[3]), b: clamp01(+m[4]),
      a: m[5] !== undefined ? parseAlpha(m[5]) : 1,
    };
  }

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
  if (v === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (v === 'white') return { r: 1, g: 1, b: 1, a: 1 };
  return null;
}

function parsePct(s) {
  if (s.endsWith('%')) return parseFloat(s) * 2.55;  // 0..255 range
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
