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
  const svgRect = svg.getBoundingClientRect();
  const fallback = computeViewBoxAffine(svg, svgRect);

  visit(svg);

  function ctmFor(el) {
    return el.getScreenCTM ? el.getScreenCTM() : null;
  }

  function transformPt(el, x, y) {
    // Each SVG element's getScreenCTM() returns the cumulative transform from its
    // local user space to the screen (= iframe viewport in CSS px). This implicitly
    // includes parent <g transform=...> chains.
    const ctm = ctmFor(el);
    if (ctm) {
      return {
        x: ctm.a * x + ctm.c * y + ctm.e,
        y: ctm.b * x + ctm.d * y + ctm.f,
      };
    }
    return { x: fallback.tx + fallback.sx * x, y: fallback.ty + fallback.sy * y };
  }

  function scaleLen(el, len) {
    const ctm = ctmFor(el);
    if (ctm) return Math.abs(ctm.a) * len;
    return Math.abs(fallback.sx) * len;
  }

  // Average scale factor of the CTM — valid under rotation/skew (unlike scaleLen,
  // which only looks at ctm.a). Used to scale stroke widths and dash patterns for
  // path-pipeline shapes.
  function avgScaleFor(el) {
    const ctm = ctmFor(el);
    if (ctm) return (Math.hypot(ctm.a, ctm.b) + Math.hypot(ctm.c, ctm.d)) / 2;
    return Math.abs(fallback.sx);
  }

  // Transform local-space path segments through the element's screen CTM (every
  // anchor AND control point — exact under rotation/skew) and push an 'svg-path'
  // box carrying full paint attributes (dash, caps, joins, fill-rule, opacities).
  function pushPath(el, cs, localSegs) {
    if (!localSegs || !localSegs.length) return;
    const segments = [];
    for (const s of localSegs) {
      if (s.op === 'Z') { segments.push({ op: 'Z' }); continue; }
      if (s.op === 'C') {
        const c1 = transformPt(el, s.x1, s.y1);
        const c2 = transformPt(el, s.x2, s.y2);
        const p  = transformPt(el, s.x, s.y);
        segments.push({ op: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y });
      } else {
        const p = transformPt(el, s.x, s.y);
        segments.push({ op: s.op, x: p.x, y: p.y });
      }
    }
    const scale = avgScaleFor(el);
    const sw = parseFloat(cs.strokeWidth || el.getAttribute('stroke-width') || '0') || 0;
    boxes.push({
      kind: 'svg-path',
      x: 0, y: 0, w: 0, h: 0,  // unused for paths
      segments,
      style: {},
      fill: computedFill(el, cs),
      fillOpacity: parseFloat(cs.fillOpacity || el.getAttribute('fill-opacity') || '1'),
      fillRule: cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
      stroke: computedStroke(el, cs),
      strokeOpacity: parseFloat(cs.strokeOpacity || el.getAttribute('stroke-opacity') || '1'),
      strokeWidth: sw * scale,
      dash: parseDashArray(cs.strokeDasharray).map((v) => v * scale),
      linecap: LINECAP_TO_PDF[cs.strokeLinecap] || 0,
      linejoin: LINEJOIN_TO_PDF[cs.strokeLinejoin] || 0,
      tag: (el.tagName || '').toLowerCase(), el,
    });
  }

  function visit(el) {
    for (const child of el.childNodes) {
      if (child.nodeType !== 1) continue;
      const tag = (child.tagName || '').toLowerCase();
      if (tag === 'g' || tag === 'defs' || tag === 'clippath') { visit(child); continue; }
      const cs = idoc.defaultView.getComputedStyle(child);
      const transform = (x, y) => transformPt(child, x, y);
      const transformLength = (len) => scaleLen(child, len);
      const fill = computedFill(child, cs);
      const stroke = computedStroke(child, cs);
      const sw = parseFloat(cs.strokeWidth || child.getAttribute('stroke-width') || '0') || 0;
      const fillOpacity = parseFloat(cs.fillOpacity || child.getAttribute('fill-opacity') || '1');
      const strokeOpacity = parseFloat(cs.strokeOpacity || child.getAttribute('stroke-opacity') || '1');

      const ctm = ctmFor(child);
      const rotated = !!ctm && (ctm.b !== 0 || ctm.c !== 0);

      if (tag === 'rect') {
        const x = +child.getAttribute('x') || 0;
        const y = +child.getAttribute('y') || 0;
        const w = +child.getAttribute('width') || 0;
        const h = +child.getAttribute('height') || 0;
        if (rotated) {
          // Axis-aligned bounding boxes are wrong under rotation/skew — route
          // through the exact path pipeline instead.
          pushPath(child, cs, [
            { op: 'M', x, y },
            { op: 'L', x: x + w, y },
            { op: 'L', x: x + w, y: y + h },
            { op: 'L', x, y: y + h },
            { op: 'Z' },
          ]);
          continue;
        }
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
        if (rotated || parseDashArray(cs.strokeDasharray).length) {
          // svg-line has no dash/cap support; the path pipeline does.
          pushPath(child, cs, [{ op: 'M', x: x1, y: y1 }, { op: 'L', x: x2, y: y2 }]);
          continue;
        }
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
      } else if (tag === 'path') {
        pushPath(child, cs, parsePathD(child.getAttribute('d') || ''));
      } else if (tag === 'polyline' || tag === 'polygon') {
        pushPath(child, cs, polyPointsToSegments(child.getAttribute('points') || '', tag === 'polygon'));
      } else if (tag === 'svg' || tag === 'defs' || tag === 'clippath' || tag === 'g') {
        visit(child);
      }
    }
  }
}

function computedFill(el, cs) {
  // Prefer the COMPUTED value: it serializes named colors (red, rebeccapurple,
  // currentColor) to rgb(...), which parseColor understands. The raw attribute
  // is only a fallback when no computed style is available.
  const v = cs.fill || el.getAttribute('fill') || null;
  if (v === 'none' || v === null || v === '') return null;
  return parseColor(v) ?? parseColor(el.getAttribute('fill') || '');
}
function computedStroke(el, cs) {
  const v = cs.stroke || el.getAttribute('stroke') || null;
  if (v === 'none' || v === null || v === '') return null;
  return parseColor(v) ?? parseColor(el.getAttribute('stroke') || '');
}

// CSS stroke-linecap → PDF line cap style (J operator).
const LINECAP_TO_PDF = { butt: 0, round: 1, square: 2 };
// CSS stroke-linejoin → PDF line join style (j operator).
const LINEJOIN_TO_PDF = { miter: 0, round: 1, bevel: 2 };

// Computed stroke-dasharray ("6px, 4px" / "none") → [6, 4] in SVG user units.
function parseDashArray(s) {
  if (!s || s === 'none') return [];
  const vals = (s.match(/[\d.]+(?:e[-+]?\d+)?/gi) || []).map(Number).filter((v) => isFinite(v) && v >= 0);
  if (!vals.length || vals.every((v) => v === 0)) return [];
  return vals;
}

// <polyline>/<polygon> points attribute → path segments (polygon closes with Z).
function polyPointsToSegments(points, close) {
  const nums = (points.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || []).map(Number);
  const segs = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    segs.push({ op: i === 0 ? 'M' : 'L', x: nums[i], y: nums[i + 1] });
  }
  if (close && segs.length) segs.push({ op: 'Z' });
  return segs;
}

/**
 * Parse an SVG path `d` attribute into normalized segments:
 *   {op:'M',x,y} | {op:'L',x,y} | {op:'C',x1,y1,x2,y2,x,y} | {op:'Z'}
 * Supports M/m L/l H/h V/v C/c S/s Q/q T/t A/a Z/z with repeated implicit
 * parameter sets (an implicit set after M/m acts as L/l per the SVG spec).
 * Quadratics are promoted to cubics; elliptical arcs are converted to cubic
 * Béziers via the endpoint→center parameterization (split at ≤90° per segment).
 */
function parsePathD(d) {
  const tokens = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(d))) tokens.push(m[1] !== undefined ? m[1] : parseFloat(m[2]));

  const segs = [];
  let i = 0;
  let cmd = null;
  let cx = 0, cy = 0;          // current point
  let spx = 0, spy = 0;        // current subpath start (for Z)
  let pcx = null, pcy = null;  // previous cubic control point (for S reflection)
  let pqx = null, pqy = null;  // previous quadratic control point (for T reflection)
  const take = () => {
    const v = tokens[i++];
    return typeof v === 'number' && isFinite(v) ? v : 0;
  };

  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') cmd = tokens[i++];
    if (cmd === null) break;  // numbers before any command: malformed, stop
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    let keepCubicCtrl = false, keepQuadCtrl = false;

    if (C === 'Z') {
      segs.push({ op: 'Z' });
      cx = spx; cy = spy;
      // Z consumes no parameters: a stray NUMBER after Z is malformed path data.
      // Browsers abort parsing at the error — do the same (the old code looped
      // forever pushing Z without ever advancing the token index).
      if (i < tokens.length && typeof tokens[i] !== 'string') break;
    } else if (C === 'M') {
      let x = take(), y = take();
      if (rel) { x += cx; y += cy; }
      segs.push({ op: 'M', x, y });
      cx = x; cy = y; spx = x; spy = y;
      cmd = rel ? 'l' : 'L';  // implicit follow-up pairs are linetos
    } else if (C === 'L') {
      let x = take(), y = take();
      if (rel) { x += cx; y += cy; }
      segs.push({ op: 'L', x, y });
      cx = x; cy = y;
    } else if (C === 'H') {
      let x = take();
      if (rel) x += cx;
      segs.push({ op: 'L', x, y: cy });
      cx = x;
    } else if (C === 'V') {
      let y = take();
      if (rel) y += cy;
      segs.push({ op: 'L', x: cx, y });
      cy = y;
    } else if (C === 'C' || C === 'S') {
      let x1, y1, x2, y2, x, y;
      if (C === 'C') {
        x1 = take(); y1 = take(); x2 = take(); y2 = take(); x = take(); y = take();
        if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
      } else {
        x2 = take(); y2 = take(); x = take(); y = take();
        if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
        // Reflect the previous cubic control point about the current point
        // (falls back to the current point if the previous command wasn't C/S).
        x1 = pcx !== null ? 2 * cx - pcx : cx;
        y1 = pcy !== null ? 2 * cy - pcy : cy;
      }
      segs.push({ op: 'C', x1, y1, x2, y2, x, y });
      pcx = x2; pcy = y2; keepCubicCtrl = true;
      cx = x; cy = y;
    } else if (C === 'Q' || C === 'T') {
      let qx, qy, x, y;
      if (C === 'Q') {
        qx = take(); qy = take(); x = take(); y = take();
        if (rel) { qx += cx; qy += cy; x += cx; y += cy; }
      } else {
        x = take(); y = take();
        if (rel) { x += cx; y += cy; }
        qx = pqx !== null ? 2 * cx - pqx : cx;
        qy = pqy !== null ? 2 * cy - pqy : cy;
      }
      // Promote quadratic → cubic: CP1 = P0 + 2/3(Q−P0), CP2 = P2 + 2/3(Q−P2).
      segs.push({
        op: 'C',
        x1: cx + (2 / 3) * (qx - cx), y1: cy + (2 / 3) * (qy - cy),
        x2: x + (2 / 3) * (qx - x),   y2: y + (2 / 3) * (qy - y),
        x, y,
      });
      pqx = qx; pqy = qy; keepQuadCtrl = true;
      cx = x; cy = y;
    } else if (C === 'A') {
      const rx = take(), ry = take(), rot = take(), laf = take(), sf = take();
      let x = take(), y = take();
      if (rel) { x += cx; y += cy; }
      segs.push(...arcToCubics(cx, cy, rx, ry, rot, laf !== 0, sf !== 0, x, y));
      cx = x; cy = y;
    }

    if (!keepCubicCtrl) { pcx = null; pcy = null; }
    if (!keepQuadCtrl)  { pqx = null; pqy = null; }
  }
  return segs;
}

/**
 * Convert one elliptical-arc segment (SVG A command, endpoint parameterization)
 * to cubic Bézier segments, per the W3C SVG implementation notes (section B.2.4):
 * endpoint → center conversion, then split the sweep into ≤90° slices, each
 * approximated by a single cubic with tangent length 4/3·tan(Δθ/4).
 */
function arcToCubics(x0, y0, rx, ry, rotDeg, largeArc, sweep, x, y) {
  if (x0 === x && y0 === y) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [{ op: 'L', x, y }];

  const phi = (rotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);

  // (F.6.5.1) midpoint in the rotated frame
  const dx2 = (x0 - x) / 2, dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // (F.6.6) scale radii up if they cannot reach the endpoints
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }

  // (F.6.5.2) center in the rotated frame
  const rxs = rx * rx, rys = ry * ry;
  let radicand = rxs * rys - rxs * y1p * y1p - rys * x1p * x1p;
  if (radicand < 0) radicand = 0;
  let coef = Math.sqrt(radicand / (rxs * y1p * y1p + rys * x1p * x1p));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;

  // (F.6.5.3) center in the original frame
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  // (F.6.5.5/6) start angle + sweep
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = vectorAngle(1, 0, ux, uy);
  let dTheta = vectorAngle(ux, uy, vx, vy);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const nSegs = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / nSegs;
  const t = (4 / 3) * Math.tan(delta / 4);

  const out = [];
  let th = theta1;
  let px = x0, py = y0;
  for (let s = 0; s < nSegs; s++) {
    const th2 = th + delta;
    const cosTh = Math.cos(th), sinTh = Math.sin(th);
    const cosTh2 = Math.cos(th2), sinTh2 = Math.sin(th2);
    // Endpoint of this slice
    const ex = cx + rx * cosTh2 * cosPhi - ry * sinTh2 * sinPhi;
    const ey = cy + rx * cosTh2 * sinPhi + ry * sinTh2 * cosPhi;
    // Ellipse derivative at slice start/end (rotated frame → original frame)
    const d1x = -rx * sinTh * cosPhi - ry * cosTh * sinPhi;
    const d1y = -rx * sinTh * sinPhi + ry * cosTh * cosPhi;
    const d2x = -rx * sinTh2 * cosPhi - ry * cosTh2 * sinPhi;
    const d2y = -rx * sinTh2 * sinPhi + ry * cosTh2 * cosPhi;
    out.push({
      op: 'C',
      x1: px + t * d1x, y1: py + t * d1y,
      x2: ex - t * d2x, y2: ey - t * d2y,
      x: ex, y: ey,
    });
    th = th2; px = ex; py = ey;
  }
  // Snap the final endpoint to the exact requested endpoint.
  if (out.length) { const last = out[out.length - 1]; last.x = x; last.y = y; }
  return out;
}

// Signed angle between vectors (ux,uy) → (vx,vy), per SVG notes F.6.5.4.
function vectorAngle(ux, uy, vx, vy) {
  const dot = ux * vx + uy * vy;
  const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  let ang = Math.acos(Math.max(-1, Math.min(1, dot / len)));
  if (ux * vy - uy * vx < 0) ang = -ang;
  return ang;
}

function computeViewBoxAffine(svg, rect) {
  const vb = svg.getAttribute('viewBox');
  if (!vb) return { tx: rect.left, ty: rect.top, sx: 1, sy: 1 };
  const [vx, vy, vw, vh] = vb.split(/\s+/).map(Number);
  const sx = rect.width / vw;
  const sy = rect.height / vh;
  return { tx: rect.left - vx * sx, ty: rect.top - vy * sy, sx, sy };
}
