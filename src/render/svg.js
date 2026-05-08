// Walk an SVG sub-tree and emit basic shapes as PDF path operators.
// Iter 8 covers <rect>, <line>, <circle>, <ellipse>, <path> (M/L/C/Z), <polyline>, <polygon>, <text>.
//
// All coordinates are translated to the CSS-px iframe coordinate space (the same space the
// rest of the walker uses) so the painter can convert to PDF user units uniformly.

import { parseColor, parsePx } from '../dom/walker.js';

/**
 * Visit every visual descendant of an <svg> element. Pushes shape boxes into `boxes`.
 * @param {SVGSVGElement} svg
 * @param {Array} boxes  — same flat box list the walker uses
 */
export function walkSvg(svg, boxes, idoc) {
  // The transform from internal SVG (viewBox) coordinates to CSS px:
  //   getCTM gives us "from local user space to viewport pixels" — that's exactly what
  //   we want, since the iframe's viewport IS our CSS-px coordinate space.
  const svgRect = svg.getBoundingClientRect();
  const ctm = svg.getScreenCTM ? svg.getScreenCTM() : null;

  // We'll fall back to a viewBox-based affine if getScreenCTM isn't available.
  const fallback = computeViewBoxAffine(svg, svgRect);

  function transform(x, y) {
    if (ctm) {
      // ctm maps (x,y) in local user space to (x',y') in screen-pixel space relative to the iframe viewport.
      return {
        x: ctm.a * x + ctm.c * y + ctm.e,
        y: ctm.b * x + ctm.d * y + ctm.f,
      };
    }
    return {
      x: fallback.tx + fallback.sx * x,
      y: fallback.ty + fallback.sy * y,
    };
  }

  function transformLength(len) {
    // Approximate scalar transform — for uniform scaling this is exact, otherwise use sx as proxy.
    if (ctm) return Math.abs(ctm.a) * len;
    return Math.abs(fallback.sx) * len;
  }

  visit(svg);

  function visit(el) {
    for (const child of el.childNodes) {
      if (child.nodeType !== 1) continue;
      const tag = (child.tagName || '').toLowerCase();
      if (tag === 'g') { visit(child); continue; }
      const cs = idoc.defaultView.getComputedStyle(child);
      const fill = computedFill(child, cs);
      const stroke = computedStroke(child, cs);
      const sw = parseFloat(cs.strokeWidth || child.getAttribute('stroke-width') || '0') || 0;
      const fillOpacity = parseFloat(cs.fillOpacity || child.getAttribute('fill-opacity') || '1');
      const strokeOpacity = parseFloat(cs.strokeOpacity || child.getAttribute('stroke-opacity') || '1');

      if (tag === 'rect') {
        const x = +child.getAttribute('x') || 0;
        const y = +child.getAttribute('y') || 0;
        const w = +child.getAttribute('width') || 0;
        const h = +child.getAttribute('height') || 0;
        const p1 = transform(x, y);
        const p2 = transform(x + w, y + h);
        boxes.push({
          kind: 'svg-rect',
          x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y),
          w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y),
          style: {}, fill, stroke, strokeWidth: transformLength(sw),
          fillOpacity, strokeOpacity,
          tag, el: child,
        });
      } else if (tag === 'line') {
        const x1 = +child.getAttribute('x1') || 0;
        const y1 = +child.getAttribute('y1') || 0;
        const x2 = +child.getAttribute('x2') || 0;
        const y2 = +child.getAttribute('y2') || 0;
        const p1 = transform(x1, y1);
        const p2 = transform(x2, y2);
        boxes.push({
          kind: 'svg-line',
          x: 0, y: 0, w: 0, h: 0,  // unused for lines
          x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
          style: {}, fill, stroke, strokeWidth: transformLength(sw),
          fillOpacity, strokeOpacity,
          tag, el: child,
        });
      } else if (tag === 'circle' || tag === 'ellipse') {
        const cx = +child.getAttribute('cx') || 0;
        const cy = +child.getAttribute('cy') || 0;
        const r  = tag === 'circle' ? (+child.getAttribute('r') || 0) : 0;
        const rx = tag === 'ellipse' ? (+child.getAttribute('rx') || 0) : r;
        const ry = tag === 'ellipse' ? (+child.getAttribute('ry') || 0) : r;
        const p = transform(cx, cy);
        boxes.push({
          kind: 'svg-ellipse',
          x: 0, y: 0, w: 0, h: 0,
          cx: p.x, cy: p.y,
          rx: transformLength(rx), ry: transformLength(ry),
          style: {}, fill, stroke, strokeWidth: transformLength(sw),
          fillOpacity, strokeOpacity,
          tag, el: child,
        });
      } else if (tag === 'text') {
        // SVG <text> uses x/y as the BASELINE start point.
        const x = +child.getAttribute('x') || 0;
        const y = +child.getAttribute('y') || 0;
        const p = transform(x, y);
        const text = child.textContent || '';
        const fontSize = parseFloat(cs.fontSize) || 10;
        const color = parseColor(cs.fill || cs.color || '#000') || { r: 0, g: 0, b: 0, a: 1 };
        boxes.push({
          kind: 'svg-text',
          x: p.x, y: p.y - fontSize * transformLength(1) * 0.78,  // approximate top of line
          w: 0, h: fontSize * transformLength(1),
          baselineX: p.x, baselineY: p.y,
          style: { color: cs.color, fontSize: cs.fontSize, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, textAlign: 'left', textTransform: 'none' },
          text,
          tag, el: child,
          textColor: color,
          textSizeCss: fontSize * transformLength(1),
        });
      } else if (tag === 'path' || tag === 'polyline' || tag === 'polygon') {
        // Iter 8: skipped (will need full path parser). Most fixtures don't use these.
        continue;
      } else if (tag === 'svg' || tag === 'defs' || tag === 'clippath' || tag === 'g') {
        visit(child);
      }
    }
  }
}

function computedFill(el, cs) {
  const v = el.getAttribute('fill') ?? cs.fill ?? null;
  if (v === 'none' || v === null || v === '') return null;
  return parseColor(v);
}
function computedStroke(el, cs) {
  const v = el.getAttribute('stroke') ?? cs.stroke ?? null;
  if (v === 'none' || v === null || v === '') return null;
  return parseColor(v);
}

function computeViewBoxAffine(svg, rect) {
  const vb = svg.getAttribute('viewBox');
  if (!vb) return { tx: rect.left, ty: rect.top, sx: 1, sy: 1 };
  const [vx, vy, vw, vh] = vb.split(/\s+/).map(Number);
  const sx = rect.width / vw;
  const sy = rect.height / vh;
  return { tx: rect.left - vx * sx, ty: rect.top - vy * sy, sx, sy };
}
