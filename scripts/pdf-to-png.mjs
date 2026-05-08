// Rasterize a PDF page to PNG using pdfjs-dist + @napi-rs/canvas.
// This is for VERIFICATION only — never used by the lib itself.

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Canvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
// pdfjs-dist legacy build is most node-friendly
const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

export async function rasterize(pdfPath, pngPath, { dpi = 96 } = {}) {
  const data = new Uint8Array(await readFile(pdfPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    standardFontDataUrl: dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/',
  });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);

  const scale = dpi / 72; // pdfjs default is 72 DPI
  const viewport = page.getViewport({ scale });
  const canvas = new Canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');

  await page.render({ canvasContext: ctx, viewport, canvasFactory: nodeCanvasFactory(Canvas) }).promise;
  const buf = canvas.toBuffer('image/png');
  await writeFile(pngPath, buf);

  return { width: canvas.width, height: canvas.height };
}

function nodeCanvasFactory(CanvasCtor) {
  return {
    create(w, h) {
      const c = new CanvasCtor(w, h);
      return { canvas: c, context: c.getContext('2d') };
    },
    reset(state, w, h) { state.canvas.width = w; state.canvas.height = h; },
    destroy(state) { state.canvas = null; state.context = null; },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const r = await rasterize(
    resolve(ROOT, 'dist', 'output.pdf'),
    resolve(ROOT, 'dist', 'output.png'),
  );
  console.log('Rasterized', r);
}
