// Public API for the HTML→PDF client-side library.
//
// Iteration 1 — establish the PDF writer foundation and emit a one-page A4 landscape
// document with: (a) a solid green header rectangle at the top of the page and
// (b) the three strings "FICHE DE CONTRÔLE", "Topo.ninja", "P001" in white using
// PDF base-14 Helvetica (no font embedding required yet).
//
// This intentionally hard-codes the header content. Iteration 2 introduces the
// DOM walker; iteration 3 introduces real layout. The point of iter 1 is to drop
// the diff baseline below the stub's 14% and to validate the writer end-to-end.

import { PdfDocument, CSS_TO_PDF, cssYToPdfY } from './core/pdf.js';

/**
 * Convert HTML to a PDF byte stream entirely client-side.
 *
 * @param {string|HTMLElement} input
 * @param {object} [opts]
 * @param {'A4'|'Letter'} [opts.pageSize='A4']
 * @param {'portrait'|'landscape'} [opts.orientation='portrait']
 * @param {number} [opts.margin=0]
 * @returns {Promise<Uint8Array>}
 */
export async function htmlToPdf(input, opts = {}) {
  const doc = new PdfDocument({
    pageSize: opts.pageSize ?? 'A4',
    orientation: opts.orientation ?? 'portrait',
    margin: opts.margin ?? 0,
  });

  // Iter 1 ignores `input`. Iter 2 will parse it via DOMParser.
  void input;

  const page = doc.addPage();
  const helvBold = doc.addStandardFont('Helvetica-Bold');
  const helv = doc.addStandardFont('Helvetica');

  // ── Header bar: green rectangle near the top of the page ────────────────────
  // CSS layout reasoning: .page has padding 2mm 4mm. .page-inner fills inside.
  // .header is the first child of .page-inner; its rendered height is ~50 css px
  // when laid out with the padding+gradient+two-line content.
  //   page padding-top    = 2 mm        =  7.56 css px
  //   page padding-left   = 4 mm        = 15.12 css px
  //   page padding-right  = 4 mm        = 15.12 css px
  //   header height (obs) ≈ 50 css px
  // CSS_TO_PDF = 0.75 (96 DPI → 72 DPI)
  const PAGE_W = doc.pageWidth;   // 841.89 user units (A4 landscape)
  const PAGE_H = doc.pageHeight;  // 595.276

  const padTopCss   = 2 * 96 / 25.4;   // 7.5590
  const padSideCss  = 4 * 96 / 25.4;   // 15.1181
  const headerHeightCss = 50;          // observed from the reference screenshot

  const headerLlxPdf  = padSideCss * CSS_TO_PDF;
  const headerUrxPdf  = (1123 - padSideCss) * CSS_TO_PDF;
  const headerUryPdf  = cssYToPdfY(padTopCss, PAGE_H);
  const headerLlyPdf  = cssYToPdfY(padTopCss + headerHeightCss, PAGE_H);
  const headerWidthPdf  = headerUrxPdf - headerLlxPdf;
  const headerHeightPdf = headerUryPdf - headerLlyPdf;

  // Topo.ninja brand green — start color of the gradient. Iter 9 will switch to a
  // proper PDF axial shading dict to render the actual gradient.
  page.saveState();
  page.setFillRgb(40 / 255, 158 / 255, 34 / 255);
  page.fillRect(headerLlxPdf, headerLlyPdf, headerWidthPdf, headerHeightPdf);
  page.restoreState();

  // ── Header text (white, three strings) ──────────────────────────────────────
  // CSS positioning reference (computed from .header padding 2mm 5mm + .header-left/-main):
  //   "FICHE DE CONTRÔLE" — 8px, uppercase, baseline approx 13 css px below page top
  //   "Topo.ninja"        — 11px bold, baseline approx 30 css px
  //   "P001"              — 13px semibold, baseline same line as Topo.ninja
  //
  // Helvetica baseline: PDF text origin is the BASELINE of the first glyph.
  // Helvetica capital-height ≈ 0.717em, ascender ≈ 0.718em, so baseline is roughly
  // (font-size × 0.78) below the visual top of the line for caps.
  page.beginText();

  // Topline "FICHE DE CONTRÔLE" — 8px, white at ~75% (opacity:0.9)
  page.setFont(helv, 8);
  page.setFillRgb(0.92, 0.96, 0.92);
  // CSS x = 4mm (page padding) + 5mm (header padding-left) ≈ 34 css px
  // CSS baseline y ≈ 2mm + 2mm + ~6.2 ≈ 21.3 css px
  page.setTextPos(34 * CSS_TO_PDF, cssYToPdfY(21.3, PAGE_H));
  page.showText('FICHE DE CONTRÔLE');  // escapeLiteralString handles Ô → \324

  // "Topo.ninja" — 11px bold, white
  page.setFont(helvBold, 11);
  page.setFillRgb(1, 1, 1);
  page.setTextPos(34 * CSS_TO_PDF, cssYToPdfY(35.5, PAGE_H));
  page.showText('Topo.ninja');

  // "P001" — 13px semibold (use Helvetica-Bold as approximation), white, gap 4mm = 15.12
  // css px after the end of "Topo.ninja". For Helvetica-Bold @ 11px, "Topo.ninja"
  // is ~62 css px wide; advance to about x=34+62+15 ≈ 111 css px.
  page.setFont(helvBold, 13);
  page.setTextPos(111 * CSS_TO_PDF, cssYToPdfY(35.5, PAGE_H));
  page.showText('P001');

  page.endText();

  return doc.toBytes();
}
