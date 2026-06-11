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

  // Draw boxes first (background/border), then images, then SVG shapes, then text, then links.
  for (const b of boxes) {
    if (b.kind === 'box') paintBox(doc, page, b, pageHeightPdf);
  }
  for (const b of boxes) {
    if (b.kind === 'image' && b.embedded) paintImage(page, b, pageHeightPdf);
  }
  for (const b of boxes) {
    if (b.kind === 'svg-rect')    paintSvgRect(page, b, pageHeightPdf, doc);
    if (b.kind === 'svg-line')    paintSvgLine(page, b, pageHeightPdf, doc);
    if (b.kind === 'svg-ellipse') paintSvgEllipse(page, b, pageHeightPdf, doc);
  }
  for (const b of boxes) {
    if (b.kind === 'text') paintText(page, fontMap, b, pageHeightPdf, doc);
    if (b.kind === 'svg-text') paintSvgText(page, fontMap, b, pageHeightPdf);
    if (b.kind === 'bullet') paintBullet(page, b, pageHeightPdf);
  }
  for (const b of boxes) {
    if (b.kind === 'link') paintLink(page, b, pageHeightPdf);
  }
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
  const yPdf = cssYToPdfY(b.baselineY, pageHeightPdf);
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
  const x = b.x * CSS_TO_PDF;
  const y = cssYToPdfY(b.y + b.h, pageHeightPdf);  // bottom-left in PDF user units
  const w = b.w * CSS_TO_PDF;
  const h = b.h * CSS_TO_PDF;

  // Per-corner border-radius (CSS px → PDF user units).
  // CSS shorthand maps to: top-left, top-right, bottom-right, bottom-left.
  // PDF coord has Y inverted, so what CSS calls "top-left" lands at the upper-left
  // of our PDF rectangle (which in PDF coords means y + h, x). Our pathRoundedRect
  // expects { tl, tr, br, bl } where tl = upper-left in PDF coords. Map directly.
  const radii = {
    tl: parsePx(b.style.borderTopLeftRadius)     * CSS_TO_PDF,
    tr: parsePx(b.style.borderTopRightRadius)    * CSS_TO_PDF,
    br: parsePx(b.style.borderBottomRightRadius) * CSS_TO_PDF,
    bl: parsePx(b.style.borderBottomLeftRadius)  * CSS_TO_PDF,
  };
  const hasRadius = radii.tl + radii.tr + radii.br + radii.bl > 0;

  // Background-image (linear-gradient) takes priority over background-color in CSS.
  // Iter 3 uses a solid-fill approximation (start color of the gradient).
  const grad = parseLinearGradient(b.style.backgroundImage);

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
    const c0 = grad.stops[0].color;
    const c1 = grad.stops[grad.stops.length - 1].color;
    const shading = doc.addAxialShading({
      x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1, c0, c1,
    });
    page.fillRectShading(shading, x, y, w, h, hasRadius ? radii : null);
  } else if (grad && grad.stops.length === 1) {
    paintFill(grad.stops[0].color);
  } else if (fill && fill.a > 0) {
    paintFill(fill);
  }

  // Borders — iter 7 handles uniform 4-side borders with corner radius.
  // iter 20 adds dashed/dotted styles via the `d` (dash pattern) operator.
  const bw = parsePx(b.style.borderTopWidth);
  if (bw > 0) {
    const bc = parseColor(b.style.borderTopColor);
    if (bc && bc.a > 0) {
      page.saveState();
      page.setStrokeRgb(bc.r, bc.g, bc.b);
      const lw = bw * CSS_TO_PDF;
      page.setLineWidth(lw);
      // Dash pattern matching CSS approximations (Chromium):
      //   solid  → no dash
      //   dashed → ~2× line width on, ~2× off
      //   dotted → ~1× on, ~1× off (rounded by line cap)
      const style = b.style.borderTopStyle;
      if (style === 'dashed') {
        page.setDashPattern([lw * 2, lw * 2], 0);
      } else if (style === 'dotted') {
        page.setDashPattern([lw, lw], 0);
      }
      const inset = lw / 2;
      const ix = x + inset, iy = y + inset;
      const iw = w - 2 * inset, ih = h - 2 * inset;
      if (hasRadius) {
        const ir = {
          tl: Math.max(0, radii.tl - inset),
          tr: Math.max(0, radii.tr - inset),
          br: Math.max(0, radii.br - inset),
          bl: Math.max(0, radii.bl - inset),
        };
        page.pathRoundedRect(ix, iy, iw, ih, ir);
        page.strokePath();
      } else {
        page.strokeRect(ix, iy, iw, ih);
      }
      page.restoreState();
    }
  }
}

function paintText(page, fontMap, b, pageHeightPdf, doc) {
  const txt = b.text;
  if (!txt) return;
  const color = parseColor(b.style.color);
  const fontSizeCss = parsePx(b.style.fontSize) || 10;
  const weight = parseInt(b.style.fontWeight, 10) || 400;
  // Detect alternate font families. CSS computed fontFamily is the full chain string,
  // e.g. "Arial, Helvetica, sans-serif". We match the FIRST family (browsers always
  // try in order, so the first available wins; with our embedded Inter, an Arial
  // request should still pick Arial-like rendering).
  const fontFam = (b.style.fontFamily || '').toLowerCase();
  const altKey = (() => {
    const m = /^['"]?(arial|helvetica|jetbrains mono|consolas|monospace)\b/i.exec(fontFam);
    return m ? m[1].toLowerCase() : null;
  })();
  const altMap = altKey && fontMap.alternates ? fontMap.alternates[altKey] : null;

  // Pick the closest available weight + the matching fallback chain.
  let fontHandle, fallbacks;
  if (altMap) {
    if      (weight >= 700) fontHandle = altMap.bold;
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
  // Baseline within the line box. We tested two approaches:
  //   - exact font metrics (half-leading + fontSize × ascentEm) → improved report.html
  //     (mixed font sizes) but regressed the more uniform source/source-flat fixtures.
  //   - empirical 0.80 of line-box height → best-on-average for our 4 fixtures.
  // Sticking with 0.80 because the regression on the primary fixtures outweighs the
  // gain elsewhere.
  const baselineCssY = b.y + b.h * 0.80;
  const xPdf = b.x * CSS_TO_PDF;
  const yPdf = cssYToPdfY(baselineCssY, pageHeightPdf);

  // Apply text-transform: uppercase if computed style says so.
  let renderText = txt;
  if (b.style.textTransform === 'uppercase') renderText = renderText.toUpperCase();
  else if (b.style.textTransform === 'lowercase') renderText = renderText.toLowerCase();

  page.saveState();
  // Apply CSS opacity (e.g. .header-topline has opacity:0.9 over the green gradient).
  // For text, alpha applies to fill (text painting is mode 0 = fill).
  const opacity = (b.style.opacity != null ? b.style.opacity : 1) * (color ? color.a : 1);
  if (opacity < 1) {
    page.setExtGState(doc.addExtGState({ ca: opacity, CA: opacity }));
  }
  if (color) page.setFillRgb(color.r, color.g, color.b);
  page.setTextPos(xPdf, yPdf);
  // Split renderText into runs of consecutive chars supported by the same font, falling
  // back along the fallbacks chain when the primary font lacks a glyph (e.g. Δ in our
  // Latin Inter is in the Greek subset).
  const runs = splitTextByFont(renderText, fontHandle, fallbacks);
  const letterSpacingCss = parsePx(b.style.letterSpacing);
  page.beginText();
  page.setTextPos(xPdf, yPdf);
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
      page.showText(run.text);
    }
  }
  page.endText();

  // text-decoration: underline → draw a line at the font's intrinsic underline position
  // (post.underlinePosition / unitsPerEm × fontSize) with the font's intrinsic thickness.
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
    const lineY = yPdf - fontSizeCss * CSS_TO_PDF * underlineOffsetEm;
    const lineW = Math.max(0.5, fontSizeCss * CSS_TO_PDF * underlineThicknessEm);
    if (color) page.setStrokeRgb(color.r, color.g, color.b);
    page.setLineWidth(lineW);
    const underlineEnd = xPdf + b.w * CSS_TO_PDF;
    page._push(`${num(xPdf)} ${num(lineY)} m ${num(underlineEnd)} ${num(lineY)} l S\n`);
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

function paintImage(page, b, pageHeightPdf) {
  const x = b.x * CSS_TO_PDF;
  const y = cssYToPdfY(b.y + b.h, pageHeightPdf);
  const w = b.w * CSS_TO_PDF;
  const h = b.h * CSS_TO_PDF;
  page.drawImage(b.embedded, x, y, w, h);
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

  const stops = [];
  for (let i = stopsStart; i < parts.length; i++) {
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
  if (stops.length < 2) return null;
  return { angleDeg, stops };
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
