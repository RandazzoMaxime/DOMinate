// Walks a list of render boxes from src/dom/walker.js and emits PDF operators on a Page.
//
// Iter 2 — covers solid rectangles, text runs, and link annotations.
// Border-radius, gradients, SVG, and font embedding are added in later iterations.

import { CSS_TO_PDF, cssYToPdfY } from '../core/pdf.js';
import { parseColor, parsePx } from '../dom/walker.js';

/**
 * @param {import('../core/pdf.js').PdfDocument} doc
 * @param {{ alias: string }} fontMap.regular
 * @param {*} page
 * @param {import('../dom/walker.js').RenderBox[]} boxes
 * @param {number} pageHeightPdfUnits
 */
export function paint(doc, fontMap, page, boxes /*, pageHeightCssPx (unused) */) {
  const pageHeightPdf = page.height;  // PDF user units

  // Draw boxes first (background/border), then text on top.
  for (const b of boxes) {
    if (b.kind === 'box') paintBox(page, b, pageHeightPdf);
  }
  for (const b of boxes) {
    if (b.kind === 'text') paintText(page, fontMap, b, pageHeightPdf);
  }
  for (const b of boxes) {
    if (b.kind === 'link') paintLink(page, b, pageHeightPdf);
  }
}

function paintBox(page, b, pageHeightPdf) {
  const fill = parseColor(b.style.backgroundColor);
  const x = b.x * CSS_TO_PDF;
  const y = cssYToPdfY(b.y + b.h, pageHeightPdf);  // bottom-left in PDF user units
  const w = b.w * CSS_TO_PDF;
  const h = b.h * CSS_TO_PDF;

  // Background-image (linear-gradient) takes priority over background-color in CSS.
  // Iter 3 uses a solid-fill approximation (start color of the gradient). Iter 4 will
  // upgrade to a real PDF axial shading dictionary so the gradient is faithful.
  const grad = parseLinearGradient(b.style.backgroundImage);
  if (grad && grad.stops.length) {
    page.saveState();
    const c = grad.stops[0].color;
    page.setFillRgb(c.r, c.g, c.b);
    page.fillRect(x, y, w, h);
    page.restoreState();
  } else if (fill && fill.a > 0) {
    page.saveState();
    page.setFillRgb(fill.r, fill.g, fill.b);
    page.fillRect(x, y, w, h);
    page.restoreState();
  }
  // Borders — iter 2 only handles uniform-width borders (the source uses 1px borders
  // with `border-soft` color on cards). Stroke a rectangle inset by half the line width.
  const bw = parsePx(b.style.borderTopWidth);
  if (bw > 0) {
    const bc = parseColor(b.style.borderTopColor);
    if (bc && bc.a > 0) {
      page.saveState();
      page.setStrokeRgb(bc.r, bc.g, bc.b);
      page.setLineWidth(bw * CSS_TO_PDF);
      const inset = (bw * CSS_TO_PDF) / 2;
      // Use re + S (stroke) — no helper yet, emit raw
      page._push(`${num(x + inset)} ${num(y + inset)} ${num(w - 2 * inset)} ${num(h - 2 * inset)} re S\n`);
      page.restoreState();
    }
  }
}

function paintText(page, fontMap, b, pageHeightPdf) {
  const txt = b.text;
  if (!txt) return;
  const color = parseColor(b.style.color);
  const fontSizeCss = parsePx(b.style.fontSize) || 10;
  const weight = parseInt(b.style.fontWeight, 10) || 400;
  // Pick a Helvetica variant per weight. Iter 7+ replaces this with embedded Inter.
  let fontHandle = fontMap.regular;
  if (weight >= 600) fontHandle = fontMap.bold;
  else if (b.style.fontStyle === 'italic') fontHandle = fontMap.oblique;

  // PDF text origin is BASELINE. The Range rect's `y` (top) plus its height gives
  // the line-box bottom; for a typical ascender-dominant Latin font, baseline ≈
  // line-top + line-height × 0.78. We approximate with: baselineCssY = y + h × 0.78.
  // This is rough and revisited when we have real font metrics.
  const baselineCssY = b.y + b.h * 0.78;
  const xPdf = b.x * CSS_TO_PDF;
  const yPdf = cssYToPdfY(baselineCssY, pageHeightPdf);

  // Apply text-transform: uppercase if computed style says so.
  let renderText = txt;
  if (b.style.textTransform === 'uppercase') renderText = renderText.toUpperCase();
  else if (b.style.textTransform === 'lowercase') renderText = renderText.toLowerCase();

  page.saveState();
  if (color) page.setFillRgb(color.r, color.g, color.b);
  page.beginText();
  page.setFont(fontHandle, fontSizeCss * CSS_TO_PDF);
  page.setTextPos(xPdf, yPdf);
  page.showText(renderText);
  page.endText();
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
