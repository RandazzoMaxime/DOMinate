// Walks a list of render boxes from src/dom/walker.js and emits PDF operators on a Page.
//
// Iter 2 — covers solid rectangles, text runs, and link annotations.
// Border-radius, gradients, SVG, and font embedding are added in later iterations.

import { CSS_TO_PDF, cssYToPdfY } from '../core/pdf.js';
import { parseColor, parsePx } from '../dom/utils.js';
import { encodeTextAsHex } from '../core/fonts/embed.js';

/**
 * @param {import('../core/pdf.js').PdfDocument} doc
 * @param {{ alias: string }} fontMap.regular
 * @param {*} page
 * @param {import('../dom/walker.js').RenderBox[]} boxes
 * @param {number} pageHeightPdfUnits
 */
export function paint(doc, fontMap, page, boxes /*, pageHeightCssPx (unused) */) {
  const pageHeightPdf = page.height;  // PDF user units

  // Single ordered pass: every box carries a lexicographic sortKey assigned by the
  // walker (CSS 2.1 Appendix E phases within stacking contexts). Stable sort, then
  // paint each box with its overflow clip chain applied.
  const order = boxes
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.kind !== 'link')
    .sort((A, B) => cmpSortKeys(A.b.sortKey, B.b.sortKey) || (A.i - B.i));

  for (const { b } of order) {
    const clipped = b.clips && b.clips.length;
    const transformed = b.tfms && b.tfms.length;
    if (clipped || transformed) {
      page.saveState();
      // CSS transforms replay outermost-first via cm; the box coordinates were
      // measured with the transform disabled, so the matrix recreates Chromium's
      // rendering around transform-origin.
      if (transformed) for (const t of b.tfms) emitCssTransform(page, t, pageHeightPdf);
    }
    if (clipped) {
      for (const c of b.clips) {
        const csx = Math.round(c.x), csy = Math.round(c.y);
        const csw = Math.round(c.x + c.w) - csx, csh = Math.round(c.y + c.h) - csy;
        const cx = csx * CSS_TO_PDF;
        const cy = cssYToPdfY(csy + csh, pageHeightPdf);
        const cw = csw * CSS_TO_PDF;
        const ch = csh * CSS_TO_PDF;
        const r = c.radii || {};
        if ((r.tl || 0) + (r.tr || 0) + (r.br || 0) + (r.bl || 0) > 0) {
          page.pathRoundedRect(cx, cy, cw, ch, {
            tl: (r.tl || 0) * CSS_TO_PDF, tr: (r.tr || 0) * CSS_TO_PDF,
            br: (r.br || 0) * CSS_TO_PDF, bl: (r.bl || 0) * CSS_TO_PDF,
          });
        } else {
          page._push(`${num(cx)} ${num(cy)} ${num(cw)} ${num(ch)} re\n`);
        }
        page.clipPath();
      }
    }
    switch (b.kind) {
      case 'box':         paintBox(doc, page, b, pageHeightPdf); break;
      case 'image':       if (b.embedded) paintImage(page, b, pageHeightPdf); break;
      case 'svg-rect':    paintSvgRect(page, b, pageHeightPdf, doc); break;
      case 'svg-line':    paintSvgLine(page, b, pageHeightPdf, doc); break;
      case 'svg-ellipse': paintSvgEllipse(page, b, pageHeightPdf, doc); break;
      case 'svg-path':    paintSvgPath(page, b, pageHeightPdf, doc); break;
      case 'text':        paintText(page, fontMap, b, pageHeightPdf, doc); break;
      case 'svg-text':    paintSvgText(page, fontMap, b, pageHeightPdf); break;
      case 'bullet':      paintBullet(page, b, pageHeightPdf); break;
    }
    if (clipped || transformed) page.restoreState();
  }

  for (const b of boxes) {
    if (b.kind === 'link') paintLink(page, b, pageHeightPdf);
  }
}

/**
 * Replay a CSS transform as a PDF cm. CSS matrix(a,b,c,d,e,f) maps a y-down point
 * p to O + A·(p−O) + t around the absolute origin O. Conjugating by the CSS→PDF
 * mapping P(x,y) = (x·k, H − y·k) gives the PDF 2×2 [a, −b, −c, d]; the
 * translation falls out of the fixed-point identity device(P(O)) = P(O + t).
 */
function emitCssTransform(page, t, pageHeightPdf) {
  const [a, bb, c, d, e, f] = t.m;
  const Ca = a, Cb = -bb, Cc = -c, Cd = d;
  const Px = (x) => x * CSS_TO_PDF;
  const Py = (y) => cssYToPdfY(y, pageHeightPdf);
  const ox = Px(t.ox), oy = Py(t.oy);              // P(O)
  const tx = Px(t.ox + e), ty = Py(t.oy + f);      // P(O + t)
  const ex = tx - (Ca * ox + Cc * oy);
  const ey = ty - (Cb * ox + Cd * oy);
  page._push(`${num(Ca)} ${num(Cb)} ${num(Cc)} ${num(Cd)} ${num(ex)} ${num(ey)} cm\n`);
}

/**
 * Parse the 4 computed border-*-radius values into per-corner elliptical radii
 * in PDF units. Computed values are "Rpx", "R%", or two-component "RX RY" where
 * percentages resolve against the box width (x) / height (y) per css-backgrounds.
 * Returns { tl:{x,y}, tr:{x,y}, br:{x,y}, bl:{x,y} } or null when all zero.
 */
function normRadii(style, wCss, hCss) {
  const one = (v) => {
    if (!v) return { x: 0, y: 0 };
    const parts = v.trim().split(/\s+/);
    const len = (tok, ref) => {
      if (!tok) return 0;
      if (tok.endsWith('%')) return parseFloat(tok) / 100 * ref;
      return parseFloat(tok) || 0;
    };
    return {
      x: len(parts[0], wCss) * CSS_TO_PDF,
      y: len(parts[1] !== undefined ? parts[1] : parts[0], hCss) * CSS_TO_PDF,
    };
  };
  const r = {
    tl: one(style.borderTopLeftRadius),
    tr: one(style.borderTopRightRadius),
    br: one(style.borderBottomRightRadius),
    bl: one(style.borderBottomLeftRadius),
  };
  if (r.tl.x + r.tl.y + r.tr.x + r.tr.y + r.br.x + r.br.y + r.bl.x + r.bl.y <= 0) return null;
  return r;
}

/** Grow (+d) or shrink (−d) every radius component, clamped at 0. */
function adjustRadii(r, d) {
  const adj = (c) => ({ x: Math.max(0, (c.x !== undefined ? c.x : c || 0) + d), y: Math.max(0, (c.y !== undefined ? c.y : c || 0) + d) });
  return { tl: adj(r.tl), tr: adj(r.tr), br: adj(r.br), bl: adj(r.bl) };
}

/** Lexicographic compare of sortKey arrays; missing entries sort first. */
function cmpSortKeys(a, b) {
  a = a || []; b = b || [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] !== undefined ? a[i] : -1;
    const y = b[i] !== undefined ? b[i] : -1;
    if (x !== y) return x - y;
  }
  return 0;
}

function paintSvgRect(page, b, pageHeightPdf, doc) {
  const x = b.x * CSS_TO_PDF;
  const y = cssYToPdfY(b.y + b.h, pageHeightPdf);
  const w = b.w * CSS_TO_PDF;
  const h = b.h * CSS_TO_PDF;
  if (b.fill && b.fill.a > 0) {
    page.saveState();
    applySvgAlpha(page, doc, b, /*fill*/true, /*stroke*/false);
    page.setFillRgb(b.fill.r, b.fill.g, b.fill.b);
    page.fillRect(x, y, w, h);
    page.restoreState();
  }
  if (b.stroke && b.stroke.a > 0 && b.strokeWidth > 0) {
    page.saveState();
    applySvgAlpha(page, doc, b, /*fill*/false, /*stroke*/true);
    page.setStrokeRgb(b.stroke.r, b.stroke.g, b.stroke.b);
    page.setLineWidth(b.strokeWidth * CSS_TO_PDF);
    page.strokeRect(x, y, w, h);
    page.restoreState();
  }
}

function paintSvgLine(page, b, pageHeightPdf, doc) {
  if (!b.stroke || b.stroke.a === 0) return;
  const x1 = b.x1 * CSS_TO_PDF;
  const y1 = cssYToPdfY(b.y1, pageHeightPdf);
  const x2 = b.x2 * CSS_TO_PDF;
  const y2 = cssYToPdfY(b.y2, pageHeightPdf);
  page.saveState();
  applySvgAlpha(page, doc, b, /*fill*/false, /*stroke*/true);
  page.setStrokeRgb(b.stroke.r, b.stroke.g, b.stroke.b);
  page.setLineWidth(Math.max(0.1, b.strokeWidth * CSS_TO_PDF));
  page._push(`${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S\n`);
  page.restoreState();
}

// Paint an 'svg-path' box: segments are pre-transformed to CSS px by the SVG
// walker (anchors + control points through getScreenCTM), so this only converts
// CSS px → PDF user units, sets stroke/fill state (dash, caps, joins, alpha)
// and emits m/l/c/h followed by the paint operator (f, f*, S, B, B*).
function paintSvgPath(page, b, pageHeightPdf, doc) {
  if (!b.segments || !b.segments.length) return;
  const fillAlpha = (b.fillOpacity != null ? b.fillOpacity : 1) * (b.fill ? b.fill.a : 1);
  const strokeAlpha = (b.strokeOpacity != null ? b.strokeOpacity : 1) * (b.stroke ? b.stroke.a : 1);
  const hasFill = !!b.fill && fillAlpha > 0;
  const hasStroke = !!b.stroke && strokeAlpha > 0 && b.strokeWidth > 0;
  if (!hasFill && !hasStroke) return;
  const X = (v) => num(v * CSS_TO_PDF);
  const Y = (v) => num(cssYToPdfY(v, pageHeightPdf));
  page.saveState();
  if ((hasFill && fillAlpha < 1) || (hasStroke && strokeAlpha < 1)) {
    page.setExtGState(doc.addExtGState({ ca: fillAlpha, CA: strokeAlpha }));
  }
  if (hasFill) page.setFillRgb(b.fill.r, b.fill.g, b.fill.b);
  if (hasStroke) {
    page.setStrokeRgb(b.stroke.r, b.stroke.g, b.stroke.b);
    page.setLineWidth(Math.max(0.1, b.strokeWidth * CSS_TO_PDF));
    if (b.linecap)  page._push(`${b.linecap} J\n`);
    if (b.linejoin) page._push(`${b.linejoin} j\n`);
    if (b.dash && b.dash.length) page.setDashPattern(b.dash.map((v) => v * CSS_TO_PDF), 0);
  }
  const ops = [];
  for (const s of b.segments) {
    if (s.op === 'M')      ops.push(`${X(s.x)} ${Y(s.y)} m`);
    else if (s.op === 'L') ops.push(`${X(s.x)} ${Y(s.y)} l`);
    else if (s.op === 'C') ops.push(`${X(s.x1)} ${Y(s.y1)} ${X(s.x2)} ${Y(s.y2)} ${X(s.x)} ${Y(s.y)} c`);
    else if (s.op === 'Z') ops.push('h');
  }
  const star = b.fillRule === 'evenodd' ? '*' : '';
  let paintOp;
  if (hasFill && hasStroke) paintOp = 'B' + star;
  else if (hasFill)         paintOp = 'f' + star;
  else                      paintOp = 'S';
  page._push(ops.join('\n') + '\n' + paintOp + '\n');
  page.restoreState();
}

function applySvgAlpha(page, doc, b, useFill, useStroke) {
  const ca = useFill ? (b.fillOpacity != null ? b.fillOpacity : 1) * (b.fill ? b.fill.a : 1) : 1;
  const CA = useStroke ? (b.strokeOpacity != null ? b.strokeOpacity : 1) * (b.stroke ? b.stroke.a : 1) : 1;
  if (ca < 1 || CA < 1) {
    const gs = doc.addExtGState({ ca, CA });
    page.setExtGState(gs);
  }
}

function paintSvgEllipse(page, b, pageHeightPdf, doc) {
  const cx = b.cx * CSS_TO_PDF;
  const cy = cssYToPdfY(b.cy, pageHeightPdf);
  const rx = b.rx * CSS_TO_PDF;
  const ry = b.ry * CSS_TO_PDF;
  const k = 0.5522847498;
  // Cubic Bezier approximation of a circle/ellipse, 4 quarter arcs.
  page.saveState();
  // Apply fill-opacity / stroke-opacity through an ExtGState (PDF transparency).
  const fillAlpha = (b.fillOpacity != null ? b.fillOpacity : 1) * (b.fill ? b.fill.a : 1);
  const strokeAlpha = (b.strokeOpacity != null ? b.strokeOpacity : 1) * (b.stroke ? b.stroke.a : 1);
  if (fillAlpha < 1 || strokeAlpha < 1) {
    const gs = doc.addExtGState({ ca: fillAlpha, CA: strokeAlpha });
    page.setExtGState(gs);
  }
  if (b.fill && b.fillOpacity > 0 && b.fill.a > 0) {
    page.setFillRgb(b.fill.r, b.fill.g, b.fill.b);
  }
  if (b.stroke && b.strokeWidth > 0) {
    page.setStrokeRgb(b.stroke.r, b.stroke.g, b.stroke.b);
    page.setLineWidth(Math.max(0.1, b.strokeWidth * CSS_TO_PDF));
  }
  // Path
  const ops = [];
  ops.push(`${num(cx + rx)} ${num(cy)} m`);
  ops.push(`${num(cx + rx)} ${num(cy + ry * k)} ${num(cx + rx * k)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`);
  ops.push(`${num(cx - rx * k)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + ry * k)} ${num(cx - rx)} ${num(cy)} c`);
  ops.push(`${num(cx - rx)} ${num(cy - ry * k)} ${num(cx - rx * k)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`);
  ops.push(`${num(cx + rx * k)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - ry * k)} ${num(cx + rx)} ${num(cy)} c`);
  page._push(ops.join('\n') + '\n');
  // Paint operator: B = fill + stroke; b = fill + stroke + close
  if (b.fill && b.fill.a > 0 && b.stroke && b.stroke.a > 0) page._push('B\n');
  else if (b.fill && b.fill.a > 0) page._push('f\n');
  else if (b.stroke && b.stroke.a > 0) page._push('S\n');
  else page._push('n\n');
  page.restoreState();
}

function paintSvgText(page, fontMap, b, pageHeightPdf) {
  if (!b.text || !b.text.trim()) return;
  const xPdf = b.baselineX * CSS_TO_PDF;
  const yPdf = cssYToPdfY(Math.round(b.baselineY), pageHeightPdf);
  page.saveState();
  if (b.textColor) page.setFillRgb(b.textColor.r, b.textColor.g, b.textColor.b);
  page.beginText();
  page.setFont(fontMap.regular, b.textSizeCss * CSS_TO_PDF);
  page.setTextPos(xPdf, yPdf);
  if (fontMap.regular.kind === 'embeddedTrueType') {
    page._push(`${encodeTextAsHex(fontMap.regular, b.text)} Tj\n`);
  } else {
    page.showText(b.text);
  }
  page.endText();
  page.restoreState();
}

function paintBox(doc, page, b, pageHeightPdf) {
  const fill = parseColor(b.style.backgroundColor);
  // Snap box edges to the CSS pixel grid — Chromium paints backgrounds/borders
  // snapped to device pixels, and our raster target is exactly 96 dpi, so integer
  // CSS px == integer device px. This kills 1px seams between adjacent fills and
  // matches Chromium's hard box edges.
  const sx = Math.round(b.x), sy = Math.round(b.y);
  const sw = Math.round(b.x + b.w) - sx, sh = Math.round(b.y + b.h) - sy;
  const x = sx * CSS_TO_PDF;
  const y = cssYToPdfY(sy + sh, pageHeightPdf);  // bottom-left in PDF user units
  const w = sw * CSS_TO_PDF;
  const h = sh * CSS_TO_PDF;

  // Per-corner elliptical border-radius (px / % / "rx ry" forms) in PDF units.
  // PDF coord has Y inverted, so what CSS calls "top-left" lands at the upper-left
  // of our PDF rectangle. pathRoundedRect takes { tl, tr, br, bl } with {x,y} radii.
  const Z = { x: 0, y: 0 };
  const radiiN = normRadii(b.style, b.w, b.h);
  const radii = radiiN || { tl: Z, tr: Z, br: Z, bl: Z };
  const hasRadius = !!radiiN;

  // box-shadow paints UNDER the background fill (outer shadows only — the card's
  // opaque background covers the part of the shadow inside the border box).
  paintBoxShadow(doc, page, b, radii, x, y, w, h);

  // Background-image (linear-gradient / radial-gradient) takes priority over
  // background-color in CSS.
  const grad = parseLinearGradient(b.style.backgroundImage);
  const rgrad = grad ? null : parseRadialGradient(b.style.backgroundImage);

  function paintFill(color) {
    page.saveState();
    const opacity = (b.style.opacity != null ? b.style.opacity : 1) * (color.a != null ? color.a : 1);
    if (opacity < 1) {
      page.setExtGState(doc.addExtGState({ ca: opacity, CA: opacity }));
    }
    page.setFillRgb(color.r, color.g, color.b);
    if (hasRadius) {
      page.pathRoundedRect(x, y, w, h, radii);
      page.fillPath();
    } else {
      page.fillRect(x, y, w, h);
    }
    page.restoreState();
  }

  if (grad && grad.stops.length >= 2) {
    // Compute the gradient line endpoints in PDF coords from the CSS angle and the box.
    const line = gradientLine(grad.angleDeg, x, y, w, h);
    let shading;
    if (grad.stops.length === 2 && grad.stops[0].position === 0 && grad.stops[1].position === 1) {
      // Plain 2-stop gradient — keep the simple single-function shading.
      shading = doc.addAxialShading({
        x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1,
        c0: grad.stops[0].color, c1: grad.stops[grad.stops.length - 1].color,
      });
    } else {
      // Multi-stop (or offset stops) — FunctionType 3 stitching function.
      shading = doc.addAxialShadingStops({
        x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1, stops: grad.stops,
      });
    }
    page.fillRectShading(shading, x, y, w, h, hasRadius ? radii : null);
  } else if (rgrad && rgrad.stops.length >= 2) {
    // Radial gradient. PDF radial shadings (ShadingType 3) are circular only, so:
    // clip to the (rounded) box, translate to the gradient center, scale Y by ry/rx
    // via cm, then paint a circular shading of radius rx at the origin.
    const geo = resolveRadialGeometry(rgrad, b.w, b.h);  // CSS px, relative to box
    const cxPdf = (b.x + geo.cx) * CSS_TO_PDF;
    const cyPdf = cssYToPdfY(b.y + geo.cy, pageHeightPdf);
    const rxPdf = Math.max(geo.rx, 0.01) * CSS_TO_PDF;
    const ryPdf = Math.max(geo.ry, 0.01) * CSS_TO_PDF;
    const shading = doc.addRadialShadingStops({
      cx: 0, cy: 0, r0: 0, r1: rxPdf, stops: rgrad.stops,
    });
    page.fillRectShadingMatrix(shading, x, y, w, h, hasRadius ? radii : null,
      [1, 0, 0, ryPdf / rxPdf, cxPdf, cyPdf]);
  } else if (grad && grad.stops.length === 1) {
    paintFill(grad.stops[0].color);
  } else if (fill && fill.a > 0) {
    paintFill(fill);
  }

  // background-image: url(...) — prefetched + embedded by index.js.
  if (b.bgEmbedded) {
    paintBackgroundImage(page, b, sx, sy, sw, sh, radii, hasRadius, pageHeightPdf);
  }

  // box-shadow: inset — paints above the background/bg-image, below content.
  paintInsetShadows(doc, page, b, radii, hasRadius, x, y, w, h);

  // Borders — uniform 4-side borders keep the inset-stroke behavior (collapse-aware:
  // border-collapse cells center the shared stroke on the unsnapped grid line);
  // per-side widths/styles/colors (and `double`) get the 4-trapezoid decomposition.
  paintBorders(doc, page, b, radii, hasRadius, x, y, w, h, pageHeightPdf);

  // outline — stroked OUTSIDE the border box at outline-offset, radius following.
  paintOutline(doc, page, b, radii, hasRadius, x, y, w, h);
}

/** CSS outline: a stroke centered ow/2 beyond border-box + offset, radii grown. */
function paintOutline(doc, page, b, radii, hasRadius, x, y, w, h) {
  const ow = parsePx(b.style.outlineWidth) * CSS_TO_PDF;
  const styleo = b.style.outlineStyle;
  if (ow <= 0 || !styleo || styleo === 'none') return;
  const color = parseColor(b.style.outlineColor);
  if (!color || color.a <= 0) return;
  const off = parsePx(b.style.outlineOffset) * CSS_TO_PDF;
  const e = off + ow / 2;
  page.saveState();
  const alpha = color.a * (b.style.opacity != null ? b.style.opacity : 1);
  if (alpha < 1) page.setExtGState(doc.addExtGState({ ca: alpha, CA: alpha }));
  page.setStrokeRgb(color.r, color.g, color.b);
  page.setLineWidth(ow);
  if (styleo === 'dashed') page.setDashPattern([ow * 3, ow * 2], 0);
  else if (styleo === 'dotted') page.setDashPattern([ow, ow], 0);
  if (hasRadius) {
    page.pathRoundedRect(x - e, y - e, w + 2 * e, h + 2 * e, adjustRadii(radii, e));
    page.strokePath();
  } else {
    page.strokeRect(x - e, y - e, w + 2 * e, h + 2 * e);
  }
  page.restoreState();
}

/**
 * Inset box-shadows: clip to the (rounded) box, then accumulate even-odd ring fills
 * between the box and an inner rounded rect that walks inward from −blur to +blur
 * around (offset + spread), alphas erfc-matched like the outer-shadow path.
 */
function paintInsetShadows(doc, page, b, radii, hasRadius, x, y, w, h) {
  const all = parseBoxShadowList(b.style.boxShadow).filter(s => s.inset);
  if (!all.length) return;
  const elOpacity = b.style.opacity != null ? b.style.opacity : 1;
  for (let i = all.length - 1; i >= 0; i--) {
    const sh = all[i];
    const baseAlpha = sh.color.a * elOpacity;
    if (baseAlpha <= 0) continue;
    const dx = sh.dx * CSS_TO_PDF, dy = sh.dy * CSS_TO_PDF;
    const blur = sh.blur * CSS_TO_PDF, spread = sh.spread * CSS_TO_PDF;
    page.saveState();
    if (hasRadius) page.pathRoundedRect(x, y, w, h, radii);
    else page._push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re\n`);
    page.clipPath();
    page.setFillRgb(sh.color.r, sh.color.g, sh.color.b);
    const N = blur > 0 ? 10 : 1;
    const sigma = Math.max(blur / 2, 0.0001);
    let acc = 0;
    for (let k = 0; k < N; k++) {
      // Ring k's inner edge sits at inset `t` from the (offset+spread) shadow rect:
      // walk from the deepest inset (+blur) outward so rings nest.
      const t = N === 1 ? 0 : blur * (1 - 2 * k / (N - 1));   // +blur … −blur
      const inset = spread + t;
      const ix = x + dx + inset, iy = y - dy + inset;
      const iw = w - 2 * inset, ih = h - 2 * inset;
      // Desired coverage at depth d from the edge is gaussCoverage(d − spread, σ);
      // this ring's band sits at d = spread + t, so the argument is simply t.
      const target = N === 1 ? baseAlpha : baseAlpha * gaussCoverage(t, sigma);
      if (target <= acc) continue;
      const layerAlpha = (target - acc) / (1 - acc);
      acc = target;
      page.saveState();
      if (layerAlpha < 1) page.setExtGState(doc.addExtGState({ ca: layerAlpha, CA: layerAlpha }));
      // Even-odd region: big outer rect minus the inner rounded rect.
      page._push(`${num(x - 50)} ${num(y - 50)} ${num(w + 100)} ${num(h + 100)} re\n`);
      if (iw > 0 && ih > 0) {
        const ir = adjustRadii(radii, -inset);
        if (ir.tl.x + ir.tl.y + ir.tr.x + ir.tr.y + ir.br.x + ir.br.y + ir.bl.x + ir.bl.y > 0) {
          page.pathRoundedRect(ix, iy, iw, ih, ir);
        } else {
          page._push(`${num(ix)} ${num(iy)} ${num(iw)} ${num(ih)} re\n`);
        }
      }
      page._push('f*\n');
      page.restoreState();
    }
    page.restoreState();
  }
}

/**
 * Paint the borders of a box. Two paths:
 *  - Uniform width+style+color on all 4 sides (the common case in the legacy
 *    fixtures): stroke the half-width-inset (rounded) rect — EXACTLY the historical
 *    behavior, including the [2w,2w] dashed and [w,w] dotted approximations.
 *  - Anything else: classic 4-trapezoid border-ring decomposition with mitered
 *    diagonals at the corners. solid → fill trapezoid; double → two 1/3-width bands
 *    clipped to the trapezoid; dashed/dotted → centered stroke clipped to the
 *    trapezoid. Per-side dashes follow Chromium: dash = 3w, ideal gap = 2w, gap
 *    refitted so a whole number of dashes spans the side exactly
 *    (n = floor((L+g)/(d+g)), g' = (L − n·d)/(n−1)).
 *  Radius interaction is ignored for the per-side case (per-side + radius doesn't
 *  occur in our fixtures).
 */
function paintBorders(doc, page, b, radii, hasRadius, x, y, w, h, pageHeightPdf) {
  const s = b.style;
  const top    = { w: parsePx(s.borderTopWidth),    style: s.borderTopStyle,    color: parseColor(s.borderTopColor),    css: s.borderTopColor };
  const right  = { w: parsePx(s.borderRightWidth),  style: s.borderRightStyle,  color: parseColor(s.borderRightColor),  css: s.borderRightColor };
  const bottom = { w: parsePx(s.borderBottomWidth), style: s.borderBottomStyle, color: parseColor(s.borderBottomColor), css: s.borderBottomColor };
  const left   = { w: parsePx(s.borderLeftWidth),   style: s.borderLeftStyle,   color: parseColor(s.borderLeftColor),   css: s.borderLeftColor };
  if (top.w <= 0 && right.w <= 0 && bottom.w <= 0 && left.w <= 0) return;

  const uniform =
    top.w === right.w && top.w === bottom.w && top.w === left.w &&
    top.style === right.style && top.style === bottom.style && top.style === left.style &&
    top.css === right.css && top.css === bottom.css && top.css === left.css;
  const TWO_TONE = ['double', 'groove', 'ridge', 'inset', 'outset'];

  if (uniform && !TWO_TONE.includes(top.style)) {
    // Legacy uniform behavior — keep byte-for-byte identical output for the
    // source/source-flat/wizard/report fixtures. border-collapse cells center the
    // shared stroke on the unsnapped grid line (inset 0) so adjacent cells coincide.
    const bw = top.w;
    const bc = top.color;
    if (bc && bc.a > 0) {
      page.saveState();
      page.setStrokeRgb(bc.r, bc.g, bc.b);
      const lw = bw * CSS_TO_PDF;
      page.setLineWidth(lw);
      const style = b.style.borderTopStyle;
      const collapsed = b.style.borderCollapse === 'collapse';
      const inset = collapsed ? 0 : lw / 2;
      const bx0 = collapsed ? b.x * CSS_TO_PDF : x;
      const by0 = collapsed ? cssYToPdfY(b.y + b.h, pageHeightPdf) : y;
      const bw0 = collapsed ? b.w * CSS_TO_PDF : w;
      const bh0 = collapsed ? b.h * CSS_TO_PDF : h;
      const ix = bx0 + inset, iy = by0 + inset;
      const iw = bw0 - 2 * inset, ih = bh0 - 2 * inset;
      const ir = adjustRadii(radii, -inset);
      if (style === 'dashed' || style === 'dotted') {
        // Chromium strokes a uniform dashed/dotted border as ONE closed centerline
        // path starting at the top-left corner's arc end, clockwise, with the gap
        // refitted so a whole number of on/off cycles closes the loop.
        strokeDashedBorderPath(page, ix, iy, iw, ih, ir, lw, style);
      } else if (hasRadius) {
        page.pathRoundedRect(ix, iy, iw, ih, ir);
        page.strokePath();
      } else {
        page.strokeRect(ix, iy, iw, ih);
      }
      page.restoreState();
    }
    return;
  }

  // Per-side painting (PDF coords, y up). Side widths in PDF units:
  const elOpacity = s.opacity != null ? s.opacity : 1;
  const wt = top.w * CSS_TO_PDF, wr = right.w * CSS_TO_PDF;
  const wb = bottom.w * CSS_TO_PDF, wl = left.w * CSS_TO_PDF;
  const yT = y + h;
  const sides = [
    { e: top,    lw: wt, len: w, tl: true,
      poly: [[x, yT], [x + w, yT], [x + w - wr, yT - wt], [x + wl, yT - wt]],
      line: [x, yT - wt / 2, x + w, yT - wt / 2],
      bands: [[x, yT - wt / 3, w, wt / 3], [x, yT - wt, w, wt / 3]],
      halves: [[x, yT - wt / 2, w, wt / 2], [x, yT - wt, w, wt / 2]] },
    { e: right,  lw: wr, len: h, tl: false,
      poly: [[x + w, y], [x + w, yT], [x + w - wr, yT - wt], [x + w - wr, y + wb]],
      line: [x + w - wr / 2, y, x + w - wr / 2, yT],
      bands: [[x + w - wr / 3, y, wr / 3, h], [x + w - wr, y, wr / 3, h]],
      halves: [[x + w - wr / 2, y, wr / 2, h], [x + w - wr, y, wr / 2, h]] },
    { e: bottom, lw: wb, len: w, tl: false,
      poly: [[x, y], [x + w, y], [x + w - wr, y + wb], [x + wl, y + wb]],
      line: [x, y + wb / 2, x + w, y + wb / 2],
      bands: [[x, y, w, wb / 3], [x, y + wb * 2 / 3, w, wb / 3]],
      halves: [[x, y, w, wb / 2], [x, y + wb / 2, w, wb / 2]] },
    { e: left,   lw: wl, len: h, tl: true,
      poly: [[x, y], [x, yT], [x + wl, yT - wt], [x + wl, y + wb]],
      line: [x + wl / 2, y, x + wl / 2, yT],
      bands: [[x, y, wl / 3, h], [x + wl - wl / 3, y, wl / 3, h]],
      halves: [[x, y, wl / 2, h], [x + wl / 2, y, wl / 2, h]] },
  ];
  for (const side of sides) {
    const e = side.e;
    if (e.w <= 0 || !e.color || e.color.a <= 0) continue;
    if (e.style === 'none' || e.style === 'hidden') continue;
    page.saveState();
    const alpha = e.color.a * elOpacity;
    if (alpha < 1) page.setExtGState(doc.addExtGState({ ca: alpha, CA: alpha }));
    if (e.style === 'dashed' || e.style === 'dotted') {
      pathPolygon(page, side.poly);
      page.clipPath();
      page.setStrokeRgb(e.color.r, e.color.g, e.color.b);
      page.setLineWidth(side.lw);
      if (e.style === 'dashed') {
        const d = side.lw * 3;
        let g = side.lw * 2;
        const n = Math.floor((side.len + g) / (d + g));
        if (n > 1) g = (side.len - n * d) / (n - 1);
        page.setDashPattern([d, g], 0);
      } else {
        page.setDashPattern([side.lw, side.lw], 0);
      }
      page._push(`${num(side.line[0])} ${num(side.line[1])} m ${num(side.line[2])} ${num(side.line[3])} l S\n`);
    } else if (e.style === 'double') {
      pathPolygon(page, side.poly);
      page.clipPath();
      page.setFillRgb(e.color.r, e.color.g, e.color.b);
      for (const [bx, by, bw2, bh2] of side.bands) page.fillRect(bx, by, bw2, bh2);
    } else if (e.style === 'groove' || e.style === 'ridge' || e.style === 'inset' || e.style === 'outset') {
      // Two-tone 3D borders: Chromium darkens the border-color to ~0.46 on the
      // "shadowed" sides (sampled from the reference raster: #4f9d69 -> #244930).
      // inset/outset shade whole sides; groove/ridge split each band into an outer
      // and inner half with opposite shading.
      const dark = { r: e.color.r * 0.46, g: e.color.g * 0.46, b: e.color.b * 0.46 };
      const lite = e.color;
      let cOuter, cInner;
      if (e.style === 'inset')       cOuter = cInner = side.tl ? dark : lite;
      else if (e.style === 'outset') cOuter = cInner = side.tl ? lite : dark;
      else if (e.style === 'groove') { cOuter = side.tl ? dark : lite; cInner = side.tl ? lite : dark; }
      else                           { cOuter = side.tl ? lite : dark; cInner = side.tl ? dark : lite; }
      pathPolygon(page, side.poly);
      page.clipPath();
      const [outerHalf, innerHalf] = side.halves;
      page.setFillRgb(cOuter.r, cOuter.g, cOuter.b);
      page.fillRect(outerHalf[0], outerHalf[1], outerHalf[2], outerHalf[3]);
      page.setFillRgb(cInner.r, cInner.g, cInner.b);
      page.fillRect(innerHalf[0], innerHalf[1], innerHalf[2], innerHalf[3]);
    } else {
      // solid
      page.setFillRgb(e.color.r, e.color.g, e.color.b);
      pathPolygon(page, side.poly);
      page.fillPath();
    }
    page.restoreState();
  }
}

/**
 * Stroke a uniform dashed/dotted border centerline the way Chromium does:
 * each side is stroked INDEPENDENTLY as half-arc + straight + half-arc (sides
 * split the corner arcs at their midpoints), top/bottom walked left→right and
 * left/right top→bottom, with the dash phase chosen so the pattern position is
 * exactly 0 where the straight segment begins (verified against the reference
 * raster: dot/dash runs re-anchor at every corner-arc end). dotted = w on / w
 * off, no refit; dashed = 3w on / 2w gap refit to the straight length
 * (n = floor((L+g)/(d+g)), g' = (L − n·d)/(n−1)).
 * (x, y, w, h) is the centerline rect (already inset by lw/2), r its radii.
 */
function strokeDashedBorderPath(page, x, y, w, h, r, lw, style) {
  const maxR = Math.min(w, h) / 2;
  // Elliptical radii degrade to circular (min component) for the dash walk.
  const rv = (c) => (c && c.x !== undefined) ? Math.min(c.x, c.y) : (c || 0);
  const tl = Math.min(rv(r.tl), maxR), tr = Math.min(rv(r.tr), maxR);
  const br = Math.min(rv(r.br), maxR), bl = Math.min(rv(r.bl), maxR);
  // Chromium aligns strokes to device pixels: snap each side's outer band edge and
  // the dash-pattern origin to the CSS pixel grid (PDF coords are css·0.75, and the
  // page dimensions are whole css px, so the grid is the multiples of CSS_TO_PDF).
  const snap = (v) => Math.round(v / CSS_TO_PDF) * CSS_TO_PDF;
  const half = lw / 2;
  const oL = snap(x - half), oR = snap(x + w + half);
  const oB = snap(y - half), oT = snap(y + h + half);
  const X0 = oL + half, X1 = oR - half, Y0 = oB + half, YT = oT - half;
  const D = Math.PI / 180;
  const cTL = [X0 + tl, YT - tl], cTR = [X1 - tr, YT - tr];
  const cBR = [X1 - br, Y0 + br], cBL = [X0 + bl, Y0 + bl];
  // Per side: leading half-arc, straight run, trailing half-arc. At square corners
  // (radius 0) the straight extends to the OUTER corner like Chromium's per-side
  // painting. `ss` is the coordinate (along the walk axis) where the dash pattern
  // must hit position 0; `dir` is +1 when the walk increases that coordinate.
  const sides = [
    { cIn: cTL, rIn: tl, aIn: [135, 90],  cOut: cTR, rOut: tr, aOut: [90, 45],
      s0: [tl > 0 ? X0 + tl : oL, YT], s1: [tr > 0 ? X1 - tr : oR, YT], ss: tl > 0 ? X0 + tl : oL, dir: +1 },
    { cIn: cTR, rIn: tr, aIn: [45, 0],    cOut: cBR, rOut: br, aOut: [0, -45],
      s0: [X1, tr > 0 ? YT - tr : oT], s1: [X1, br > 0 ? Y0 + br : oB], ss: tr > 0 ? YT - tr : oT, dir: -1 },
    { cIn: cBL, rIn: bl, aIn: [225, 270], cOut: cBR, rOut: br, aOut: [270, 315],
      s0: [bl > 0 ? X0 + bl : oL, Y0], s1: [br > 0 ? X1 - br : oR, Y0], ss: bl > 0 ? X0 + bl : oL, dir: +1 },
    { cIn: cTL, rIn: tl, aIn: [135, 180], cOut: cBL, rOut: bl, aOut: [180, 225],
      s0: [X0, tl > 0 ? YT - tl : oT], s1: [X0, bl > 0 ? Y0 + bl : oB], ss: tl > 0 ? YT - tl : oT, dir: -1 },
  ];
  for (const sd of sides) {
    const len = Math.abs(sd.dir > 0 ? sd.s1[0] - sd.s0[0] : sd.s1[1] - sd.s0[1]);
    if (len <= 0) continue;
    const dOn = style === 'dashed' ? lw * 3 : lw;
    let g = style === 'dashed' ? lw * 2 : lw;
    if (style === 'dashed') {
      const n = Math.floor((len + g) / (dOn + g));
      if (n > 1) g = (len - n * dOn) / (n - 1);
    }
    const cycle = dOn + g;
    // Distance from the stroke start to the (pixel-snapped) pattern-zero point.
    const d0 = (sd.rIn > 0 ? Math.PI / 2 * sd.rIn / 2 : 0) + (snap(sd.ss) - sd.ss) * sd.dir;
    const phase = ((-d0) % cycle + cycle) % cycle;
    page.setDashPattern([dOn, g], phase);
    const ops = [];
    if (sd.rIn > 0) {
      const a = arcBezier(sd.cIn[0], sd.cIn[1], sd.rIn, sd.aIn[0] * D, sd.aIn[1] * D);
      ops.push(`${num(a.x0)} ${num(a.y0)} m`, a.c);
    } else {
      ops.push(`${num(sd.s0[0])} ${num(sd.s0[1])} m`);
    }
    ops.push(`${num(sd.s1[0])} ${num(sd.s1[1])} l`);
    if (sd.rOut > 0) {
      const a = arcBezier(sd.cOut[0], sd.cOut[1], sd.rOut, sd.aOut[0] * D, sd.aOut[1] * D);
      ops.push(a.c);
    }
    page._push(ops.join('\n') + '\n');
    page.strokePath();
  }
}

/** One cubic-bezier arc on a circle, from angle a0 to a1 (radians, |a1−a0| ≤ 90°). */
function arcBezier(cx, cy, r, a0, a1) {
  const kk = (4 / 3) * Math.tan((a1 - a0) / 4);
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  return {
    x0, y0,
    c: `${num(cx + r * (Math.cos(a0) - kk * Math.sin(a0)))} ${num(cy + r * (Math.sin(a0) + kk * Math.cos(a0)))} ` +
       `${num(cx + r * (Math.cos(a1) + kk * Math.sin(a1)))} ${num(cy + r * (Math.sin(a1) - kk * Math.cos(a1)))} ` +
       `${num(x1)} ${num(y1)} c`,
  };
}

/** Emit a closed polygon sub-path (no paint operator). pts = [[x,y], …] in PDF units. */
function pathPolygon(page, pts) {
  const ops = pts.map((p, i) => `${num(p[0])} ${num(p[1])} ${i === 0 ? 'm' : 'l'}`);
  page._push(ops.join(' ') + ' h\n');
}

/**
 * Paint outer box-shadows under a box. Chromium serializes the computed value as
 * "<color> <dx> <dy> <blur> <spread>[ inset]" with the color FIRST, comma-separated
 * for multiple shadows; the FIRST shadow is topmost so we paint the list in reverse.
 * Inset shadows are skipped.
 *
 *  - blur = 0: one rounded-rect fill offset by (dx,dy), expanded by spread.
 *  - blur > 0: gaussian penumbra (sigma = blur/2 per the CSS spec, verified against
 *    the Chromium reference raster) approximated by N nested rounded-rect fills from
 *    expansion +blur down to −blur. Fill alphas are chosen so the ACCUMULATED
 *    coverage (fills stack: 1 − Π(1−aᵢ)) matches 0.5·erfc(t / (σ√2)) at each band.
 */
function paintBoxShadow(doc, page, b, radii, x, y, w, h) {
  const shadows = parseBoxShadows(b.style.boxShadow);
  if (!shadows.length) return;
  const elOpacity = b.style.opacity != null ? b.style.opacity : 1;
  for (let i = shadows.length - 1; i >= 0; i--) {
    const sh = shadows[i];
    const baseAlpha = sh.color.a * elOpacity;
    if (baseAlpha <= 0) continue;
    const dx = sh.dx * CSS_TO_PDF;
    const dy = sh.dy * CSS_TO_PDF;
    const blur = sh.blur * CSS_TO_PDF;
    const spread = sh.spread * CSS_TO_PDF;
    const bx = x + dx, by = y - dy;  // CSS dy>0 moves down; PDF y axis points up
    if (blur <= 0) {
      fillShadowLayer(doc, page, bx, by, w, h, radii, spread, sh.color, baseAlpha);
    } else {
      const sigma = blur / 2;
      const N = 12;
      let acc = 0;
      for (let k = 0; k < N; k++) {
        const eOuter = blur * (1 - 2 * k / (N - 1));               // +blur … −blur
        const eInner = k < N - 1 ? blur * (1 - 2 * (k + 1) / (N - 1)) : -blur;
        const tMid = k < N - 1 ? (eOuter + eInner) / 2 : eInner;   // band midpoint
        const target = baseAlpha * gaussCoverage(tMid, sigma);
        if (target <= acc) continue;
        const layerAlpha = (target - acc) / (1 - acc);
        fillShadowLayer(doc, page, bx, by, w, h, radii, spread + eOuter, sh.color, layerAlpha);
        acc = target;
      }
    }
  }
}

/** One shadow layer: the box rect expanded by `expand` on all sides, radii grown to match. */
function fillShadowLayer(doc, page, x, y, w, h, radii, expand, color, alpha) {
  const xx = x - expand, yy = y - expand;
  const ww = w + 2 * expand, hh = h + 2 * expand;
  if (ww <= 0 || hh <= 0 || alpha <= 0) return;
  page.saveState();
  if (alpha < 1) page.setExtGState(doc.addExtGState({ ca: alpha, CA: alpha }));
  page.setFillRgb(color.r, color.g, color.b);
  const r = adjustRadii(radii, expand);
  if (r.tl.x + r.tl.y + r.tr.x + r.tr.y + r.br.x + r.br.y + r.bl.x + r.bl.y > 0) {
    page.pathRoundedRect(xx, yy, ww, hh, r);
    page.fillPath();
  } else {
    page.fillRect(xx, yy, ww, hh);
  }
  page.restoreState();
}

/** Parse the Chromium-computed shadow list (box-shadow or text-shadow).
 *  Returns [{color, dx, dy, blur, spread, inset}]. */
function parseBoxShadowList(s) {
  if (!s || s === 'none') return [];
  const out = [];
  for (const part of splitTopLevel(s)) {
    const t = part.trim();
    if (!t) continue;
    const inset = /\binset\b/.test(t);
    const cm = /(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8})/.exec(t);
    const color = cm ? parseColor(cm[1]) : { r: 0, g: 0, b: 0, a: 1 };
    if (!color || color.a <= 0) continue;
    const rest = (cm ? t.slice(0, cm.index) + ' ' + t.slice(cm.index + cm[1].length) : t).replace(/\binset\b/g, ' ');
    const lens = rest.trim().split(/\s+/).filter(tok => /^-?[\d.]+(px)?$/.test(tok)).map(parseFloat);
    if (lens.length < 2) continue;
    out.push({ color, dx: lens[0], dy: lens[1], blur: lens[2] || 0, spread: lens[3] || 0, inset });
  }
  return out;
}

/** Outer shadows only (legacy callers). */
function parseBoxShadows(s) {
  return parseBoxShadowList(s).filter(sh => !sh.inset);
}

/** Coverage of a gaussian-blurred step edge at signed distance t outside the edge. */
function gaussCoverage(t, sigma) {
  return 0.5 * (1 - erf(t / (sigma * Math.SQRT2)));
}

/** Abramowitz–Stegun 7.1.26 approximation, |error| < 1.5e-7. */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const u = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * u - 1.453152027) * u + 1.421413741) * u - 0.284496736) * u + 0.254829592) * u * Math.exp(-ax * ax);
  return sign * y;
}

function paintText(page, fontMap, b, pageHeightPdf, doc) {
  const txt = b.text;
  if (!txt) return;
  if (b.iconFont) { paintIconRun(page, fontMap, b, pageHeightPdf, doc); return; }
  const color = parseColor(b.style.color);
  const fontSizeCss = parsePx(b.style.fontSize) || 10;
  // resolvedWeight = the weight Chromium actually rendered with (css-fonts-4
  // matching against the weights registered in the page), set by the walker.
  const weight = b.style.resolvedWeight || parseInt(b.style.fontWeight, 10) || 400;
  // Detect alternate font families. CSS computed fontFamily is the full chain string,
  // e.g. "Arial, Helvetica, sans-serif". We match the FIRST family (browsers always
  // try in order, so the first available wins; with our embedded Inter, an Arial
  // request should still pick Arial-like rendering).
  const fontFam = (b.style.fontFamily || '').toLowerCase();
  const altKey = (() => {
    const m = /^['"]?(arial|helvetica|jetbrains mono|consolas|monospace|manrope)\b/i.exec(fontFam);
    return m ? m[1].toLowerCase() : null;
  })();
  const altMap = altKey && fontMap.alternates ? fontMap.alternates[altKey] : null;

  // Pick the closest available weight + the matching fallback chain.
  let fontHandle, fallbacks;
  if (altMap) {
    if      (weight >= 800 && altMap.black) fontHandle = altMap.black;
    else if (weight >= 700) fontHandle = altMap.bold;
    else if (weight >= 600) fontHandle = altMap.semibold;
    else if (weight >= 500) fontHandle = altMap.medium;
    else                    fontHandle = altMap.regular;
    // Helvetica/Arial base 14 lacks Greek (Δ), so we still chain to the embedded
    // Inter primary + Greek subsets as fallbacks. This gives Latin via Helvetica
    // (close to Arial metrics) AND working Δ via Inter Greek.
    if (fontMap.embedded) {
      // Pick Inter primary at the matching weight as the next fallback
      const interPrimary =
        weight >= 700 ? fontMap.bold :
        weight >= 600 ? fontMap.semibold :
        weight >= 500 ? fontMap.medium : fontMap.regular;
      const interGreek = weight >= 700 ? fontMap.fallbacks.bold :
                          weight >= 600 ? fontMap.fallbacks.semibold :
                          weight >= 500 ? fontMap.fallbacks.medium : fontMap.fallbacks.regular;
      fallbacks = [interPrimary, ...interGreek];
    } else {
      fallbacks = [];
    }
  } else if (fontMap.embedded) {
    if      (weight >= 700) { fontHandle = fontMap.bold;     fallbacks = fontMap.fallbacks.bold; }
    else if (weight >= 600) { fontHandle = fontMap.semibold; fallbacks = fontMap.fallbacks.semibold; }
    else if (weight >= 500) { fontHandle = fontMap.medium;   fallbacks = fontMap.fallbacks.medium; }
    else                    { fontHandle = fontMap.regular;  fallbacks = fontMap.fallbacks.regular; }
  } else {
    if (weight >= 600) fontHandle = fontMap.bold;
    else if (b.style.fontStyle === 'italic') fontHandle = fontMap.oblique;
    else fontHandle = fontMap.regular;
    fallbacks = [];
  }

  // PDF text origin is BASELINE. The Range rect's `y` (top) plus its height gives
  // the line-box bottom; for a typical ascender-dominant Latin font, baseline ≈
  // line-top + line-height × 0.78. We approximate with: baselineCssY = y + h × 0.78.
  // This is rough and revisited when we have real font metrics.
  // Baseline within the line box. Empirically tuned 0.80 — gives the lowest measured
  // pixel-diff across our fixtures.
  // Baseline within the line box. When the walker measured the used font's real
  // bounding-box metrics (canvas measureText inside the SAME engine that produced
  // the rects), the baseline is exact: center the metric box in the rect, then go
  // down by the ascent. Fallback: the empirical 0.80 of rect height (≈ Inter's
  // ascent/(ascent+descent)).
  const baselineCssY = Math.round(b.metrics
    ? b.y + (b.h - b.metrics.boxH) / 2 + b.metrics.ascent
    : b.y + b.h * 0.80);
  // Chromium at 96 dpi rounds glyph BASELINES to whole device pixels but keeps
  // sub-pixel horizontal positioning — mirror exactly that.
  const xPdf = b.x * CSS_TO_PDF;
  const yPdf = cssYToPdfY(baselineCssY, pageHeightPdf);

  // Apply text-transform: uppercase if computed style says so.
  let renderText = txt;
  if (b.style.textTransform === 'uppercase') renderText = renderText.toUpperCase();
  else if (b.style.textTransform === 'lowercase') renderText = renderText.toLowerCase();

  page.saveState();
  // Split renderText into runs of consecutive chars supported by the same font, falling
  // back along the fallbacks chain when the primary font lacks a glyph (e.g. Δ in our
  // Latin Inter is in the Greek subset).
  const runs = splitTextByFont(renderText, fontHandle, fallbacks);
  const letterSpacingCss = parsePx(b.style.letterSpacing);
  // Synthetic oblique: Chromium fakes italic for fonts without an italic face by
  // skewing 14° (Skia kFakeItalicSkew = 0.25). Our embedded faces are all upright,
  // so every italic/oblique run gets the same synthetic shear via the text matrix.
  const italic = b.style.fontStyle === 'italic' || b.style.fontStyle === 'oblique';
  const elOpacity = b.style.opacity != null ? b.style.opacity : 1;

  const drawTextRuns = (atX, atY, fillColor, alpha) => {
    page.saveState();
    if (alpha < 1) page.setExtGState(doc.addExtGState({ ca: alpha, CA: alpha }));
    if (fillColor) page.setFillRgb(fillColor.r, fillColor.g, fillColor.b);
    page.beginText();
    if (italic && fontHandle.kind === 'embeddedTrueType') {
      page._push(`1 0 0.213 1 ${num(atX)} ${num(atY)} Tm\n`);
    } else {
      page.setTextPos(atX, atY);
    }
    for (const run of runs) {
      page.setFont(run.font, fontSizeCss * CSS_TO_PDF);
      if (run.font.kind === 'embeddedTrueType') {
        if (letterSpacingCss && fontSizeCss > 0 && run.text.length > 1) {
          const offset = -(letterSpacingCss * CSS_TO_PDF) / (fontSizeCss * CSS_TO_PDF) * 1000;
          const tjParts = ['['];
          for (let i = 0; i < run.text.length; i++) {
            tjParts.push(encodeTextAsHex(run.font, run.text[i]));
            if (i < run.text.length - 1) tjParts.push(num(offset));
          }
          tjParts.push('] TJ\n');
          page._push(tjParts.join(' '));
        } else {
          page._push(`${encodeTextAsHex(run.font, run.text)} Tj\n`);
        }
      } else {
        // Standard (base-14) fonts: letter-spacing via the Tc parameter.
        if (letterSpacingCss) page.setCharSpacing(letterSpacingCss * CSS_TO_PDF);
        page.showText(run.text);
        if (letterSpacingCss) page.setCharSpacing(0);
      }
    }
    page.endText();
    page.restoreState();
  };

  // text-shadow: paint each shadow (reverse list order) behind the main glyphs.
  // Blur is approximated by 3 concentric passes (center + blur/2 ring) with alphas
  // that sum to a soft-ish profile; blur 0 is exact.
  const tShadows = parseBoxShadows(b.style.textShadow);
  for (let i = tShadows.length - 1; i >= 0; i--) {
    const sh = tShadows[i];
    const sa = sh.color.a * elOpacity;
    const sx0 = xPdf + sh.dx * CSS_TO_PDF;
    const sy0 = yPdf - sh.dy * CSS_TO_PDF;
    if (sh.blur <= 1) {
      drawTextRuns(sx0, sy0, sh.color, sa);
    } else {
      // 9-pass disc approximation of the gaussian: a strong center plus axis and
      // diagonal taps — tight enough that the ghosts fuse at 96 dpi.
      const r1 = sh.blur * CSS_TO_PDF * 0.38;
      const r2 = r1 * 0.7071;
      const passes = [
        [0, 0, 0.50],
        [r1, 0, 0.14], [-r1, 0, 0.14], [0, r1, 0.14], [0, -r1, 0.14],
        [r2, r2, 0.08], [-r2, r2, 0.08], [r2, -r2, 0.08], [-r2, -r2, 0.08],
      ];
      for (const [ox, oy, a] of passes) {
        drawTextRuns(sx0 + ox, sy0 + oy, sh.color, sa * a);
      }
    }
  }

  drawTextRuns(xPdf, yPdf, color, elOpacity * (color ? color.a : 1));

  // Decoration runs extend across the inter-word gap when the walker bridged them.
  const decoEndPdf = (b.decoR != null ? b.decoR : b.x + b.w) * CSS_TO_PDF;
  const decoColor = parseColor(b.style.textDecorationColor) || color;
  const decoAlpha = elOpacity * (decoColor ? decoColor.a : 1);
  if (decoAlpha < 1 && (b.style.textDecoration || '') !== 'none' && (b.style.textDecoration || '') !== '') {
    page.setExtGState(doc.addExtGState({ ca: decoAlpha, CA: decoAlpha }));
  }

  /** Stroke one decoration line honoring text-decoration-style (solid/double/
   *  dotted/dashed/wavy) from x0 to x1 at lineY (PDF units, lw thick). */
  const strokeDecoration = (lineY, lw) => {
    if (decoColor) page.setStrokeRgb(decoColor.r, decoColor.g, decoColor.b);
    page.setLineWidth(lw);
    const styleD = b.style.textDecorationStyle || 'solid';
    if (styleD === 'dotted') page.setDashPattern([lw, lw], 0);
    else if (styleD === 'dashed') page.setDashPattern([lw * 4, lw * 2], 0);
    if (styleD === 'wavy') {
      // Sine-ish wave via repeating quarter beziers: amplitude ≈ lw, period ≈ 6 lw.
      const amp = Math.max(lw, 0.6), period = amp * 6;
      const ops = [`${num(xPdf)} ${num(lineY)} m`];
      let sign = 1;
      for (let x0 = xPdf; x0 < decoEndPdf; x0 += period, sign = -sign) {
        const x1 = Math.min(x0 + period, decoEndPdf);
        const mid = (x0 + x1) / 2;
        ops.push(`${num(mid)} ${num(lineY + sign * amp * 2)} ${num(mid)} ${num(lineY + sign * amp * 2)} ${num(x1)} ${num(lineY)} c`);
      }
      page._push(ops.join('\n') + '\nS\n');
    } else if (styleD === 'double') {
      // First line at the normal position, second one BELOW with a one-thickness gap.
      page._push(`${num(xPdf)} ${num(lineY)} m ${num(decoEndPdf)} ${num(lineY)} l S\n`);
      page._push(`${num(xPdf)} ${num(lineY - 2 * lw)} m ${num(decoEndPdf)} ${num(lineY - 2 * lw)} l S\n`);
    } else {
      page._push(`${num(xPdf)} ${num(lineY)} m ${num(decoEndPdf)} ${num(lineY)} l S\n`);
    }
    if (styleD === 'dotted' || styleD === 'dashed') page.setDashPattern([], 0);
  };

  // text-decoration: line-through → stroke midway up the x-height (~0.38 em above
  // baseline measured against Chromium's rendering).
  if ((b.style.textDecoration || '').includes('line-through')) {
    strokeDecoration(yPdf + fontSizeCss * CSS_TO_PDF * 0.38,
      Math.max(0.5, fontSizeCss * CSS_TO_PDF * 0.049));
  }

  // text-decoration: underline → draw a line at the font's intrinsic underline position
  // (post.underlinePosition / unitsPerEm × fontSize) with the font's intrinsic
  // thickness, shifted further by text-underline-offset when set.
  if ((b.style.textDecoration || '').includes('underline')) {
    let underlineOffsetEm = 0.10;  // fallback: 10% em below baseline
    let underlineThicknessEm = 0.05;
    if (fontHandle.kind === 'embeddedTrueType' && fontHandle.font.unitsPerEm) {
      const upe = fontHandle.font.unitsPerEm;
      // post.underlinePosition is the TOP of the underline rect, measured in font units
      // BELOW the baseline (negative number). Most fonts have ~-100/1000.
      underlineOffsetEm = -(fontHandle.font.underlinePosition || -100) / upe;
      underlineThicknessEm = (fontHandle.font.underlineThickness || 50) / upe;
    }
    const extraOffset = parsePx(b.style.textUnderlineOffset) * CSS_TO_PDF;
    strokeDecoration(yPdf - fontSizeCss * CSS_TO_PDF * underlineOffsetEm - extraOffset,
      Math.max(0.5, fontSizeCss * CSS_TO_PDF * underlineThicknessEm));
  }

  page.restoreState();
}

/** List marker bullets: disc = filled circle, circle = stroked circle, square = filled square. */
function paintBullet(page, b, pageHeightPdf) {
  const color = parseColor(b.color) || { r: 0, g: 0, b: 0, a: 1 };
  const x = b.x * CSS_TO_PDF;
  const y = cssYToPdfY(b.y + b.h, pageHeightPdf);
  const w = b.w * CSS_TO_PDF;
  const h = b.h * CSS_TO_PDF;
  page.saveState();
  if (b.shape === 'square') {
    page.setFillRgb(color.r, color.g, color.b);
    page.fillRect(x, y, w, h);
  } else {
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
    const k = 0.5522847498;
    const ops = [];
    ops.push(`${num(cx + rx)} ${num(cy)} m`);
    ops.push(`${num(cx + rx)} ${num(cy + ry * k)} ${num(cx + rx * k)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`);
    ops.push(`${num(cx - rx * k)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + ry * k)} ${num(cx - rx)} ${num(cy)} c`);
    ops.push(`${num(cx - rx)} ${num(cy - ry * k)} ${num(cx - rx * k)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`);
    ops.push(`${num(cx + rx * k)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - ry * k)} ${num(cx + rx)} ${num(cy)} c`);
    page._push(ops.join('\n') + '\n');
    if (b.shape === 'circle') {
      page.setStrokeRgb(color.r, color.g, color.b);
      page.setLineWidth(Math.max(0.6, b.w * CSS_TO_PDF * 0.12));
      page._push('S\n');
    } else {
      page.setFillRgb(color.r, color.g, color.b);
      page._push('f\n');
    }
  }
  page.restoreState();
}

/**
 * Icon-font run (Material Symbols): the box text is a glyph NAME ("settings");
 * map its chars to GIDs via cmap, collapse through the GSUB ligature table, then
 * emit the resulting glyph IDs directly (Identity-H: hex codes ARE GIDs).
 */
function paintIconRun(page, fontMap, b, pageHeightPdf, doc) {
  const icons = fontMap.icons;
  if (!icons || !icons.ligatures) return;  // icon font unavailable — leave blank
  const color = parseColor(b.style.color);
  const fontSizeCss = parsePx(b.style.fontSize) || 24;
  const map = icons.font.unicodeToGid;
  const gids = [];
  for (const ch of b.text) gids.push(map.get(ch.codePointAt(0)) ?? 0);
  const resolved = resolveLigatures(gids, icons.ligatures);
  const baselineCssY = Math.round(b.metrics
    ? b.y + (b.h - b.metrics.boxH) / 2 + b.metrics.ascent
    : b.y + b.h * 0.80);
  page.saveState();
  const alpha = (b.style.opacity != null ? b.style.opacity : 1) * (color ? color.a : 1);
  if (alpha < 1) page.setExtGState(doc.addExtGState({ ca: alpha, CA: alpha }));
  if (color) page.setFillRgb(color.r, color.g, color.b);
  page.beginText();
  // The static TTF renders at the variable font's default wght; Chromium's
  // rendering of the page tends heavier. Fatten outlines with a fill+stroke.
  if (color) {
    page.setStrokeRgb(color.r, color.g, color.b);
    page.setLineWidth(fontSizeCss * CSS_TO_PDF * 0.07);
    page._push('2 Tr\n');
  }
  page.setFont(icons, fontSizeCss * CSS_TO_PDF);
  page.setTextPos(b.x * CSS_TO_PDF, cssYToPdfY(baselineCssY, pageHeightPdf));
  let hex = '<';
  for (const g of resolved) {
    hex += ((g >>> 8) & 0xff).toString(16).padStart(2, '0') + (g & 0xff).toString(16).padStart(2, '0');
  }
  page._push(`${hex}> Tj\n`);
  page.endText();
  page.restoreState();
}

/** Greedy longest-match ligature collapse over a GID sequence. */
function resolveLigatures(gids, ligMap) {
  const out = [];
  for (let i = 0; i < gids.length; ) {
    const entries = ligMap.get(gids[i]);
    let matched = null;
    if (entries) {
      for (const e of entries) {
        if (i + 1 + e.comps.length > gids.length) continue;
        let ok = true;
        for (let c = 0; c < e.comps.length; c++) {
          if (gids[i + 1 + c] !== e.comps[c]) { ok = false; break; }
        }
        if (ok) { matched = e; break; }
      }
    }
    if (matched) { out.push(matched.lig); i += 1 + matched.comps.length; }
    else { out.push(gids[i]); i++; }
  }
  return out;
}

function paintImage(page, b, pageHeightPdf) {
  // Snap the destination box to the CSS pixel grid (same rationale as paintBox).
  const sx = Math.round(b.x), sy = Math.round(b.y);
  const sw = Math.round(b.x + b.w) - sx, sh = Math.round(b.y + b.h) - sy;
  if (sw <= 0 || sh <= 0) return;

  const radii = normRadii(b.style, sw, sh);  // PDF units, elliptical, % resolved
  const hasRadius = !!radii;

  // object-fit geometry in CSS px.
  const iw = b.embedded.width || sw, ih = b.embedded.height || sh;
  const fit = b.style.objectFit || 'fill';
  let dx = sx, dy = sy, dw = sw, dh = sh;
  let needsClip = hasRadius;
  if (fit === 'cover' || fit === 'contain' || fit === 'none' || fit === 'scale-down') {
    let scale;
    if (fit === 'cover') scale = Math.max(sw / iw, sh / ih);
    else if (fit === 'contain') scale = Math.min(sw / iw, sh / ih);
    else if (fit === 'none') scale = 1;
    else scale = Math.min(1, Math.min(sw / iw, sh / ih));  // scale-down
    dw = iw * scale; dh = ih * scale;
    dx = sx + (sw - dw) / 2; dy = sy + (sh - dh) / 2;
    if (dw > sw + 0.01 || dh > sh + 0.01) needsClip = true;
  }

  page.saveState();
  if (needsClip) {
    const cx = sx * CSS_TO_PDF, cy = cssYToPdfY(sy + sh, pageHeightPdf);
    const cw = sw * CSS_TO_PDF, ch = sh * CSS_TO_PDF;
    if (hasRadius) {
      page.pathRoundedRect(cx, cy, cw, ch, radii);
    } else {
      page._push(`${num(cx)} ${num(cy)} ${num(cw)} ${num(ch)} re\n`);
    }
    page.clipPath();
  }
  page.drawImage(b.embedded, dx * CSS_TO_PDF, cssYToPdfY(dy + dh, pageHeightPdf), dw * CSS_TO_PDF, dh * CSS_TO_PDF);
  page.restoreState();
}

/**
 * CSS background-image: url(...) painting — single layer, supports background-size
 * cover/contain/auto/"Wpx Hpx", percentage or px background-position, and tiling
 * for repeat (capped). Clipped to the (rounded) border box.
 */
function paintBackgroundImage(page, b, sx, sy, sw, sh, radii, hasRadius, pageHeightPdf) {
  const img = b.bgEmbedded;
  // The background POSITIONING AREA defaults to the padding box (background-origin),
  // while painting still clips to the border box (background-clip). Shift the origin
  // inside the borders or repeated tiles land 1 border-width off Chromium's phase.
  const bL = parsePx(b.style.borderLeftWidth), bR = parsePx(b.style.borderRightWidth);
  const bT = parsePx(b.style.borderTopWidth), bB = parsePx(b.style.borderBottomWidth);
  const px0 = sx + bL, py0 = sy + bT;
  const pw = sw - bL - bR, ph = sh - bT - bB;
  const iw = img.width || pw, ih = img.height || ph;

  // background-size (relative to the positioning area)
  let dw = iw, dh = ih;
  const size = (b.style.backgroundSize || 'auto').trim();
  if (size === 'cover') {
    const s = Math.max(pw / iw, ph / ih); dw = iw * s; dh = ih * s;
  } else if (size === 'contain') {
    const s = Math.min(pw / iw, ph / ih); dw = iw * s; dh = ih * s;
  } else if (size !== 'auto') {
    const parts = size.split(/\s+/);
    const parseSize = (tok, ref, auto) => {
      if (!tok || tok === 'auto') return auto;
      if (tok.endsWith('%')) return parseFloat(tok) / 100 * ref;
      return parseFloat(tok);
    };
    dw = parseSize(parts[0], pw, iw);
    dh = parseSize(parts[1], ph, dw * (ih / iw));
  }

  // background-position (computed style is "X% Y%" or px values)
  const pos = (b.style.backgroundPosition || '0% 0%').split(/\s+/);
  const posOf = (tok, span, dspan) => {
    if (!tok) return 0;
    if (tok.endsWith('%')) return (parseFloat(tok) / 100) * (span - dspan);
    return parseFloat(tok);
  };
  const ox = px0 + posOf(pos[0], pw, dw);
  const oy = py0 + posOf(pos[1], ph, dh);

  const repeat = b.style.backgroundRepeat || 'repeat';
  const tiles = [];
  if (repeat === 'no-repeat') {
    tiles.push([ox, oy]);
  } else {
    const repX = repeat === 'repeat' || repeat === 'repeat-x';
    const repY = repeat === 'repeat' || repeat === 'repeat-y';
    const x0 = repX ? ox - Math.ceil((ox - sx) / dw) * dw : ox;
    const y0 = repY ? oy - Math.ceil((oy - sy) / dh) * dh : oy;
    for (let ty = y0; ty < sy + sh && tiles.length < 400; ty += dh) {
      for (let tx = x0; tx < sx + sw && tiles.length < 400; tx += dw) {
        tiles.push([tx, ty]);
        if (!repX) break;
      }
      if (!repY) break;
    }
  }

  page.saveState();
  const cx = sx * CSS_TO_PDF, cy = cssYToPdfY(sy + sh, pageHeightPdf);
  const cw = sw * CSS_TO_PDF, ch = sh * CSS_TO_PDF;
  if (hasRadius) page.pathRoundedRect(cx, cy, cw, ch, radii);
  else page._push(`${num(cx)} ${num(cy)} ${num(cw)} ${num(ch)} re\n`);
  page.clipPath();
  for (const [tx, ty] of tiles) {
    page.drawImage(img, tx * CSS_TO_PDF, cssYToPdfY(ty + dh, pageHeightPdf), dw * CSS_TO_PDF, dh * CSS_TO_PDF);
  }
  page.restoreState();
}

function paintLink(page, b, pageHeightPdf) {
  const llx = b.x * CSS_TO_PDF;
  const ury = cssYToPdfY(b.y, pageHeightPdf);
  const urx = (b.x + b.w) * CSS_TO_PDF;
  const lly = cssYToPdfY(b.y + b.h, pageHeightPdf);
  page.addLinkAnnot({ rect: [llx, lly, urx, ury], uri: b.href });
}

function num(n) {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Split a string into runs, each rendered with the font from this list that supports
 * the most consecutive characters. The primary font is tried first, then each fallback
 * in order. If no font has a glyph for a character, it's still emitted with the primary
 * font (the .notdef glyph will render — visually wrong but keeps positioning consistent).
 */
function splitTextByFont(text, primary, fallbacks) {
  // For each char: if primary supports it, use primary. Else walk fallbacks to find
  // an embedded font with a glyph for it. As a last resort, keep primary.
  // For "standard" Type 1 fonts (Helvetica), we accept all WinAnsi-codepoints (≤ 0xFF),
  // anything else falls back to embedded fonts.
  function primarySupports(cp) {
    if (primary.kind === 'embeddedTrueType') return primary.font.unicodeToGid.has(cp);
    if (primary.kind === 'standard') return cp <= 0xFF;  // WinAnsi range
    return false;
  }
  const runs = [];
  let curFont = null;
  let curText = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    let chosen = primarySupports(cp) ? primary : null;
    if (!chosen) {
      for (const f of fallbacks || []) {
        if (!f) continue;
        if (f.kind === 'embeddedTrueType' && f.font.unicodeToGid.has(cp)) { chosen = f; break; }
        if (f.kind === 'standard' && cp <= 0xFF) { chosen = f; break; }
      }
    }
    if (!chosen) chosen = primary;
    if (curFont !== chosen) {
      if (curFont) runs.push({ font: curFont, text: curText });
      curFont = chosen;
      curText = ch;
    } else {
      curText += ch;
    }
  }
  if (curFont) runs.push({ font: curFont, text: curText });
  return runs;
}

/**
 * For a CSS linear-gradient with the given angle (CSS spec: 0deg = "to top", clockwise)
 * applied to a rectangle (x, y, w, h) in PDF coords (origin bottom-left), return the
 * start and end points of the gradient line.
 *
 * The CSS spec says the gradient line passes through the center of the gradient box,
 * its endpoints positioned so that the boundary perpendicular through the start point
 * touches the corner from which color "starts", and the boundary through the end point
 * touches the opposite corner.
 *
 * Approximation here: pick the two extreme corners along the gradient direction.
 */
function gradientLine(angleDeg, x, y, w, h) {
  // CSS spec: 0deg points up, increasing angles rotate clockwise.
  // In PDF coords (Y increases UP), "up" is +Y. So 0deg direction = (0, +1) in PDF coords.
  // 90deg = "to right" = (+1, 0). 180deg = "to bottom" = (0, -1). 270deg = "to left" = (-1, 0).
  // For 135deg = 90 + 45, halfway between right and bottom = (sin(45), -cos(45)) approximately.
  // Direction vector: (sin(rad), cos(rad)) with rad = angleDeg * π / 180 yields (0,1) at 0,
  // (1,0) at 90, (0,-1) at 180. ✓
  const rad = angleDeg * Math.PI / 180;
  const dx = Math.sin(rad);
  const dy = Math.cos(rad);

  const cx = x + w / 2;
  const cy = y + h / 2;
  // Project each corner onto the direction and take min/max.
  const corners = [
    { px: x,     py: y },
    { px: x + w, py: y },
    { px: x + w, py: y + h },
    { px: x,     py: y + h },
  ];
  let minProj = Infinity, maxProj = -Infinity;
  for (const c of corners) {
    const t = (c.px - cx) * dx + (c.py - cy) * dy;
    if (t < minProj) minProj = t;
    if (t > maxProj) maxProj = t;
  }
  // Start at center + minProj * direction, end at center + maxProj * direction.
  return {
    x0: cx + minProj * dx, y0: cy + minProj * dy,
    x1: cx + maxProj * dx, y1: cy + maxProj * dy,
  };
}

/**
 * Minimal linear-gradient() parser. Recognizes:
 *   linear-gradient(135deg, rgb(40, 158, 34), rgb(...))
 *   linear-gradient(135deg, rgb(...) 0%, rgb(...) 100%)
 *   linear-gradient(to right, ...)
 *
 * Returns { angleDeg, stops: [{color: {r,g,b,a}, position: 0..1|null}, ...] } or null.
 * The browser normalizes computed `background-image` to use `rgb(...)` colors and either
 * a degree angle or a `to <side>` keyword.
 */
function parseLinearGradient(s) {
  if (!s || s === 'none') return null;
  const m = /^linear-gradient\((.*)\)$/s.exec(s.trim());
  if (!m) return null;
  // Split at top level commas (not inside parens)
  const parts = splitTopLevel(m[1]);
  if (parts.length < 2) return null;

  let first = parts[0].trim();
  let angleDeg = 180;  // default per CSS spec is "to bottom" = 180deg
  let stopsStart = 0;

  if (/^[-\d.]+deg$/.test(first)) {
    angleDeg = parseFloat(first);
    stopsStart = 1;
  } else if (/^to\s+/i.test(first)) {
    angleDeg = sideKeywordToDeg(first.replace(/^to\s+/i, '').trim());
    stopsStart = 1;
  }

  const stops = parseStopList(parts, stopsStart);
  if (stops.length < 2) return null;
  completeStopPositions(stops);
  return { angleDeg, stops };
}

/**
 * Parse the color-stop tail of a gradient function (parts already split at top-level
 * commas; stops begin at index `start`). Returns [{color, position: 0..1|null}, ...].
 */
function parseStopList(parts, start) {
  const stops = [];
  for (let i = start; i < parts.length; i++) {
    const p = parts[i].trim();
    // Color part = up to the first standalone position token (a length/percentage that
    // is NOT inside parentheses). Strip an optional trailing position; the leftover is
    // the color expression. Recognized colors: rgb/rgba/color(srgb|display-p3)/#hex.
    const cm = /^([^\s].*?)(?:\s+([-\d.]+%?))?$/.exec(p);
    if (!cm) continue;
    let colorPart = cm[1];
    let posPart = cm[2];
    // If the position glob was actually swallowed inside a paren-balanced color token
    // like `color(srgb 0.1 0.2 0.3 / 0.5)`, the regex above won't peel it off — but it
    // also won't *incorrectly* peel it because the token is inside parens. So the only
    // case we need to handle is when the position is a separate trailing token.
    const color = parseColor(colorPart);
    if (!color) continue;
    let pos = null;
    if (posPart) {
      pos = posPart.endsWith('%') ? parseFloat(posPart) / 100 : parseFloat(posPart);
    }
    stops.push({ color, position: pos });
  }
  return stops;
}

/**
 * Complete missing stop positions per CSS (css-images-3 §3.4.3), in place:
 *   1. first defaults to 0, last to 1;
 *   2. specified positions are clamped monotonically non-decreasing;
 *   3. runs of unpositioned stops are distributed evenly between known neighbors.
 * Positions are finally clamped to [0, 1] (PDF shadings cover the [0,1] domain only;
 * out-of-range CSS stops are rare and approximated by the clamp).
 */
function completeStopPositions(stops) {
  if (!stops.length) return;
  if (stops[0].position == null) stops[0].position = 0;
  if (stops[stops.length - 1].position == null) stops[stops.length - 1].position = 1;
  // Monotonic clamp of the specified positions.
  let maxSoFar = stops[0].position;
  for (const st of stops) {
    if (st.position == null) continue;
    if (st.position < maxSoFar) st.position = maxSoFar;
    maxSoFar = st.position;
  }
  // Distribute nulls evenly between the surrounding positioned stops.
  let i = 0;
  while (i < stops.length) {
    if (stops[i].position != null) { i++; continue; }
    let j = i;
    while (stops[j].position == null) j++;           // last stop is never null
    const prev = stops[i - 1].position;              // first stop is never null
    const next = stops[j].position;
    const n = j - i + 1;                             // gaps between prev and next
    for (let k = i; k < j; k++) {
      stops[k].position = prev + (next - prev) * (k - i + 1) / n;
    }
    i = j + 1;
  }
  for (const st of stops) st.position = Math.min(1, Math.max(0, st.position));
}

/**
 * Minimal radial-gradient() parser for the browser-COMPUTED serialization. Chromium
 * normalizes shapes/positions, e.g.:
 *   radial-gradient(rgb(...) 0%, rgb(...) 100%)                — ellipse farthest-corner at center
 *   radial-gradient(circle, rgb(...) 0%, rgb(...) 100%)
 *   radial-gradient(at 0% 0%, rgb(...) 0%, ...)                — "ellipse at top left" form
 *   radial-gradient(123px 45px at 10px 20px, rgb(...), ...)    — explicit radii
 *
 * Returns { shape, sizeKeyword, explicitSize, posX, posY, stops } or null.
 * posX/posY are { v, unit: '%'|'px' }; explicitSize is [{v,unit}, {v,unit}] or null.
 * Resolve against a box with resolveRadialGeometry().
 */
function parseRadialGradient(s) {
  if (!s || s === 'none') return null;
  const m = /^radial-gradient\((.*)\)$/s.exec(s.trim());
  if (!m) return null;
  const parts = splitTopLevel(m[1]);
  if (parts.length < 2) return null;

  let shape = null;            // 'circle' | 'ellipse' | null (inferred)
  let sizeKeyword = null;      // closest-side | closest-corner | farthest-side | farthest-corner
  const explicit = [];         // explicit radii tokens
  let posX = null, posY = null;
  let stopsStart = 0;

  const first = parts[0].trim();
  // The first part is a prelude only if it does not start with a color.
  const isColorStart = /^(rgba?\(|hsla?\(|color\(|#)/i.test(first) || parseColor(first.split(/\s+/)[0]);
  if (!isColorStart) {
    stopsStart = 1;
    const [beforeAt, afterAt] = first.split(/\bat\b/i).map(t => (t || '').trim());
    for (const tok of beforeAt.split(/\s+/).filter(Boolean)) {
      const t = tok.toLowerCase();
      if (t === 'circle' || t === 'ellipse') shape = t;
      else if (/^(closest|farthest)-(side|corner)$/.test(t)) sizeKeyword = t;
      else if (/^[-\d.]+(px|%)$/.test(t)) {
        explicit.push({ v: parseFloat(t), unit: t.endsWith('%') ? '%' : 'px' });
      }
    }
    if (afterAt) {
      const posToks = afterAt.split(/\s+/).filter(Boolean);
      const kw = { left: { v: 0, unit: '%' }, right: { v: 100, unit: '%' },
                   top: { v: 0, unit: '%' }, bottom: { v: 100, unit: '%' },
                   center: { v: 50, unit: '%' } };
      const resolved = posToks.map(t => {
        const lt = t.toLowerCase();
        if (kw[lt]) return kw[lt];
        if (/^[-\d.]+%$/.test(t)) return { v: parseFloat(t), unit: '%' };
        if (/^[-\d.]+(px)?$/.test(t)) return { v: parseFloat(t), unit: 'px' };
        return null;
      }).filter(Boolean);
      posX = resolved[0] || null;
      posY = resolved[1] || null;  // single component → vertical defaults to center
    }
  }
  if (!posX) posX = { v: 50, unit: '%' };
  if (!posY) posY = { v: 50, unit: '%' };
  if (!shape) shape = explicit.length === 1 ? 'circle' : 'ellipse';
  if (!sizeKeyword && !explicit.length) sizeKeyword = 'farthest-corner';

  const stops = parseStopList(parts, stopsStart);
  if (stops.length < 2) return null;
  completeStopPositions(stops);
  return { shape, sizeKeyword, explicitSize: explicit.length ? explicit : null, posX, posY, stops };
}

/**
 * Resolve a parsed radial gradient against its box (CSS px). Implements the ending-shape
 * sizing rules of css-images-3 §3.2.3: extent keywords for circles use distances to the
 * closest/farthest side/corner; ellipses with *-corner extents take the aspect ratio of
 * the corresponding *-side ellipse and pass through that corner.
 * Returns { cx, cy, rx, ry } relative to the box's top-left, in CSS px.
 */
function resolveRadialGeometry(g, w, h) {
  const cx = g.posX.unit === '%' ? g.posX.v / 100 * w : g.posX.v;
  const cy = g.posY.unit === '%' ? g.posY.v / 100 * h : g.posY.v;
  let rx, ry;

  if (g.explicitSize) {
    if (g.explicitSize.length === 1) {
      rx = ry = g.explicitSize[0].unit === '%' ? g.explicitSize[0].v / 100 * w : g.explicitSize[0].v;
    } else {
      rx = g.explicitSize[0].unit === '%' ? g.explicitSize[0].v / 100 * w : g.explicitSize[0].v;
      ry = g.explicitSize[1].unit === '%' ? g.explicitSize[1].v / 100 * h : g.explicitSize[1].v;
    }
    return { cx, cy, rx: Math.max(rx, 0.01), ry: Math.max(ry, 0.01) };
  }

  const dxNear = Math.min(Math.abs(cx), Math.abs(w - cx));
  const dxFar  = Math.max(Math.abs(cx), Math.abs(w - cx));
  const dyNear = Math.min(Math.abs(cy), Math.abs(h - cy));
  const dyFar  = Math.max(Math.abs(cy), Math.abs(h - cy));

  if (g.shape === 'circle') {
    let r;
    switch (g.sizeKeyword) {
      case 'closest-side':    r = Math.min(dxNear, dyNear); break;
      case 'farthest-side':   r = Math.max(dxFar, dyFar); break;
      case 'closest-corner':  r = Math.hypot(dxNear, dyNear); break;
      default:                r = Math.hypot(dxFar, dyFar); break;  // farthest-corner
    }
    rx = ry = r;
  } else {
    switch (g.sizeKeyword) {
      case 'closest-side':    rx = dxNear; ry = dyNear; break;
      case 'farthest-side':   rx = dxFar;  ry = dyFar;  break;
      case 'closest-corner': {
        const a = Math.max(dxNear, 0.01) / Math.max(dyNear, 0.01);
        ry = Math.hypot(dxNear / a, dyNear);
        rx = a * ry;
        break;
      }
      default: {  // farthest-corner
        const a = Math.max(dxFar, 0.01) / Math.max(dyFar, 0.01);
        ry = Math.hypot(dxFar / a, dyFar);
        rx = a * ry;
        break;
      }
    }
  }
  return { cx, cy, rx: Math.max(rx, 0.01), ry: Math.max(ry, 0.01) };
}

function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') { depth++; buf += ch; }
    else if (ch === ')') { depth--; buf += ch; }
    else if (ch === ',' && depth === 0) { out.push(buf); buf = ''; }
    else buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

function sideKeywordToDeg(side) {
  const k = side.toLowerCase().replace(/\s+/g, ' ').trim();
  return ({
    'top': 0, 'right': 90, 'bottom': 180, 'left': 270,
    'top right': 45, 'right top': 45,
    'bottom right': 135, 'right bottom': 135,
    'bottom left': 225, 'left bottom': 225,
    'top left': 315, 'left top': 315,
  })[k] ?? 180;
}
