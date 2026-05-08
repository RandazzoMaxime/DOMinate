// Render the progress report HTML through the lib itself and write PROGRESS_REPORT.pdf.
// This is the canonical end-of-session deliverable: the lib generating its own report
// is the strongest "fonctionnel pour tout html" demonstration.

import { renderWithLib } from './render-with-lib.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pdfBytes = await renderWithLib(
  resolve(ROOT, 'reference', 'report.html'),
  { width: 1123, height: 794 },
);
await writeFile(resolve(ROOT, 'PROGRESS_REPORT.pdf'), pdfBytes);
console.log('Wrote PROGRESS_REPORT.pdf —', (pdfBytes.byteLength / 1024).toFixed(1), 'KB');
