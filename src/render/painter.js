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

  if (fill && fill.a > 0) {
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
